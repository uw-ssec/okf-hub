import { routeHub } from "./hub.js";
import { engineExclusive, engineExited, loadedVaultId, readBundleFiles, resetVolume, setLoadedVault, startEngine } from "./engine/runtime.js";
import { vaultKeyFor } from "./bundles.js";
import type { Stores } from "./stores.js";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: unknown;
};

/** A bundle's files as the console and other readers see them: text by path, with a content hash as version. */
export type Snapshot = { head: string; files: Record<string, { content: string; version: string }> };

const MUTATING = new Set(["okf_create", "okf_update", "okf_relate"]);
const BLOB_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const ENGINE_EXITED = "okf engine exited; restarting";

/**
 * Runs okf's MCP handler and sync engine in this process, one call at a time, for any vault.
 * The Go engine holds one decrypted vault at a time (src/engine/runtime.ts): a call for another
 * vault waits its turn on `engineExclusive`, then reloads that vault from scratch. The hub REST
 * API is served in-process from `stores`; every vault's key derives from the master key.
 */
export class EngineHost {
  private nextId = 1;
  /**
   * Blobs the engine has requested, kept across re-inits. Content-addressed
   * blobs are immutable, so cached bytes never go stale; only blobs actually
   * read are kept, so the cache tracks the live vault, not its history.
   */
  private blobCache = new Map<string, Uint8Array>();
  private blobCacheBytes = 0;

  constructor(
    private readonly stores: Stores,
    private readonly masterKeyHex: string,
    private readonly onEngineExit: () => void = () => process.exit(1),
  ) {}

  private hub(path: string, init?: RequestInit): Promise<Response> {
    return routeHub(new Request(`https://hub.internal${path}`, init), this.stores);
  }

  private cacheBlob(key: string, bytes: Uint8Array): void {
    if (this.blobCache.has(key) || this.blobCacheBytes + bytes.byteLength > BLOB_CACHE_MAX_BYTES) return;
    this.blobCache.set(key, bytes);
    this.blobCacheBytes += bytes.byteLength;
  }

  private async ensureInitialized(vaultId: string): Promise<void> {
    globalThis.okfHubFetch = async (method, path, body) => {
      // Keyed by the full path: the same ciphertext hash in two vaults is two different blobs.
      const blobRead = method === "GET" && /\/blobs\/[0-9a-f]{64}$/.test(path);
      const cached = blobRead ? this.blobCache.get(path) : undefined;
      if (cached) return { status: 200, body: cached };
      const response = await this.hub(path, { method, body });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (blobRead && response.status === 200) this.cacheBlob(path, bytes);
      return { status: response.status, body: bytes };
    };
    await startEngine();
    if (loadedVaultId() === vaultId) return;
    resetVolume();
    await globalThis.okfEngineInit(vaultId, await vaultKeyFor(this.masterKeyHex, vaultId)); // rejects on failure
    setLoadedVault(vaultId);
  }

  /** The vault's head commit as the hub sees it now ("" if unknown). */
  private async currentHead(vaultId: string): Promise<string> {
    const response = await this.hub(`/api/v1/vaults/${vaultId}/head`);
    if (!response.ok) return "";
    return ((await response.json()) as { head_commit?: string }).head_commit ?? "";
  }

  /** Pull the vault and return every file of its bundle. */
  async snapshot(vaultId: string): Promise<Snapshot> {
    if (engineExited()) {
      this.onEngineExit();
      throw new Error(ENGINE_EXITED);
    }
    return engineExclusive(async () => {
      if (engineExited()) {
        this.onEngineExit();
        throw new Error(ENGINE_EXITED);
      }
      await this.ensureInitialized(vaultId);
      const head = await globalThis.okfEnginePull();
      const files: Snapshot["files"] = {};
      for (const [path, content] of Object.entries(readBundleFiles())) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
        files[path] = { content, version: [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("") };
      }
      return { head, files };
    });
  }

  async callTool(name: string, args: Record<string, unknown>, actor: string, vaultId: string): Promise<ToolResult> {
    // Checked before queueing too: a call stuck in a dead engine would otherwise hold the queue forever.
    if (engineExited()) return this.engineGone();
    return engineExclusive(async () => {
      if (engineExited()) return this.engineGone();
      await this.ensureInitialized(vaultId);
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
          setLoadedVault(""); // drop local state either way; the next call re-pulls the hub's truth
          // The error may come after the hub accepted the commit (e.g. a failure
          // writing the ref mirror). If the head moved, report the likely save
          // truthfully instead of telling the agent nothing was written.
          if ((await this.currentHead(vaultId)) !== headBefore) {
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

  /** The Go runtime is gone for this process: hand off to `onEngineExit` (restart) and fail this call. */
  private engineGone(): ToolResult {
    this.onEngineExit();
    return { isError: true, content: [{ type: "text", text: ENGINE_EXITED }] };
  }
}
