import { DurableObject } from "cloudflare:workers";
import { routeHub } from "./hub";
import { engineExited, resetVolume, startEngine } from "./engine/runtime";
import { serialQueue } from "./serial";
import { KEEP_WARM_INTERVAL_MS, nextKeepWarmAt } from "./keep-warm";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: unknown;
};

const MUTATING = new Set(["okf_create", "okf_update", "okf_relate"]);
const BLOB_CACHE_MAX_BYTES = 48 * 1024 * 1024; // stay well inside the 128 MB isolate limit

/**
 * One per vault. Holds the decrypted vault in memory and runs okf's MCP
 * handler and sync engine against it, one tool call at a time.
 */
export class VaultEngine extends DurableObject<Env> {
  /** One tool call at a time: calls share the in-memory vault and Go engine state. */
  private exclusive = serialQueue();
  private initializedFor = "";
  private nextId = 1;
  /**
   * Blobs the engine has requested, kept across re-inits. Content-addressed
   * blobs are immutable, so cached bytes never go stale; only blobs actually
   * read are kept, so the cache tracks the live vault, not its history.
   */
  private blobCache = new Map<string, Uint8Array>();
  private blobCacheBytes = 0;

  private usedFaults = new Set<string>();

  /** Test-only: true once per injected fault named in TEST_FAULTS. */
  private takeFault(name: string): boolean {
    const configured = (this.env as { TEST_FAULTS?: string }).TEST_FAULTS?.split(",") ?? [];
    if (!configured.includes(name) || this.usedFaults.has(name)) return false;
    this.usedFaults.add(name);
    return true;
  }

  private cacheBlob(hash: string, bytes: Uint8Array): void {
    if (this.blobCache.has(hash) || this.blobCacheBytes + bytes.byteLength > BLOB_CACHE_MAX_BYTES) return;
    this.blobCache.set(hash, bytes);
    this.blobCacheBytes += bytes.byteLength;
  }

  private async ensureInitialized(): Promise<void> {
    globalThis.okfHubFetch = async (method, path, body) => {
      // Test-only fault injection (TEST_FAULTS is set only in test .dev.vars).
      if (method === "POST" && path.endsWith("/commit")) {
        if (this.takeFault("commit-fail-once")) return { status: 500, body: new TextEncoder().encode('{"error":"injected"}') };
        if (this.takeFault("commit-lands-then-fail-once")) {
          await routeHub(new Request(`https://hub.internal${path}`, { method, body, headers: { Authorization: `Bearer ${this.env.HUB_TOKEN}` } }), this.env);
          return { status: 500, body: new TextEncoder().encode('{"error":"injected after commit"}') };
        }
      }
      const blobRead = method === "GET" ? /\/blobs\/([0-9a-f]{64})$/.exec(path) : null;
      const cached = blobRead && this.blobCache.get(blobRead[1]);
      if (cached) return { status: 200, body: cached };
      const response = await routeHub(
        new Request(`https://hub.internal${path}`, {
          method,
          body,
          headers: { Authorization: `Bearer ${this.env.HUB_TOKEN}` },
        }),
        this.env,
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (blobRead && response.status === 200) this.cacheBlob(blobRead[1], bytes);
      return { status: response.status, body: bytes };
    };
    await startEngine();
    if (this.initializedFor === this.env.MCP_VAULT_ID) return;
    resetVolume();
    await globalThis.okfEngineInit(this.env.MCP_VAULT_ID, this.env.VAULT_KEY_HEX); // rejects on failure
    this.initializedFor = this.env.MCP_VAULT_ID;
  }

  /** The vault's head commit as the hub sees it now ("" if unknown). */
  private async currentHead(): Promise<string> {
    const response = await routeHub(
      new Request(`https://hub.internal/api/v1/vaults/${this.env.MCP_VAULT_ID}/head`, { headers: { Authorization: `Bearer ${this.env.HUB_TOKEN}` } }),
      this.env,
    );
    if (!response.ok) return "";
    return ((await response.json()) as { head_commit?: string }).head_commit ?? "";
  }

  /** Record a real tool call and make sure the keep-warm alarm chain is running. */
  private async markRealCall(): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.put("lastRealCallAt", now);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + KEEP_WARM_INTERVAL_MS);
  }

  /** Keep-warm tick: reschedule while a session is active; reload the vault if it was lost. */
  async alarm(): Promise<void> {
    const next = nextKeepWarmAt(Date.now(), await this.ctx.storage.get<number>("lastRealCallAt"));
    if (next === null) return; // session over: let the object hibernate
    await this.ctx.storage.setAlarm(next);
    if (this.initializedFor !== this.env.MCP_VAULT_ID && !engineExited()) {
      await this.exclusive(async () => {
        await this.ensureInitialized();
        await globalThis.okfEnginePull();
      }).catch((err) => console.error("keep-warm reload failed", err));
    }
  }

  async callTool(name: string, args: Record<string, unknown>, actor: string): Promise<ToolResult> {
    await this.markRealCall();
    return this.exclusive(async () => {
      if (engineExited()) {
        // The Go runtime is gone for this isolate: reset the object so the
        // next request starts a fresh one instead of every call hanging.
        this.ctx.abort("okf engine exited; restarting");
      }
      await this.ensureInitialized();
      const headBefore = await globalThis.okfEnginePull();
      const line = JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call", params: { name, arguments: args } });
      const response = JSON.parse(await globalThis.okfEngineHandle(line)) as { result?: ToolResult; error?: { message: string } };
      if (response.error || !response.result) {
        return { isError: true, content: [{ type: "text", text: response.error?.message ?? "empty response from engine" }] };
      }
      if (MUTATING.has(name) && !response.result.isError) {
        try {
          await globalThis.okfEngineSync(`${actor}: ${name}`);
        } catch (err) {
          this.initializedFor = ""; // drop local state either way; the next call re-pulls the hub's truth
          // The error may come after the hub accepted the commit (e.g. a failure
          // writing the ref mirror). If the head moved, report the likely save
          // truthfully instead of telling the agent nothing was written.
          if ((await this.currentHead()) !== headBefore) {
            return {
              ...response.result,
              content: [
                ...response.result.content,
                { type: "text", text: `Note: the hub accepted a new commit but its confirmation failed (${String(err)}). The change is most likely saved; check with okf_show before retrying.` },
              ],
            };
          }
          return {
            isError: true,
            content: [{ type: "text", text: `Not saved: the change could not be committed to the hub (${String(err)}). Nothing was written; retry.` }],
          };
        }
      }
      return response.result;
    });
  }
}
