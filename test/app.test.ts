import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkHealth, createHandler } from "../src/app.js";
import { vaultIdFor } from "../src/bundles.js";
import type { HubConfig } from "../src/config.js";
import type { EngineHost } from "../src/engine-host.js";
import { __setEngineExitedForTest } from "../src/engine/runtime.js";
import { SERVER_INSTRUCTIONS } from "../src/mcp.js";
import { JwksCache, oidcConfig, type OidcConfig } from "../src/oidc.js";

const ENV = {
  OIDC_ISSUER: "http://auth.localhost:8000/realms/litellm",
  OIDC_JWKS_URL: "http://keycloak:8080/certs",
  OIDC_AUDIENCE: "http://okf.localhost:7878",
  OIDC_GRANTS: JSON.stringify([
    { bundle: "orgs/oidc-{actor}", access: "write" },
    { role: "knowledge-reader", bundle: "orgs/*", access: "read" },
  ]),
};
const config: HubConfig = {
  oidc: oidcConfig(ENV) as OidcConfig,
  masterKeyHex: "0f".repeat(32),
  databaseUrl: "postgres://unused",
  blobConnectionString: "unused",
  blobContainer: "okf-hub",
  port: 7878,
};

let signer: CryptoKeyPair;
let jwks: JwksCache;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function token(extra: Record<string, unknown> = {}): Promise<string> {
  const claims = { iss: ENV.OIDC_ISSUER, aud: [ENV.OIDC_AUDIENCE, "account"], exp: Math.floor(Date.now() / 1000) + 300, azp: "okf-org-acme", okf_org: "acme", ...extra };
  const head = enc({ alg: "RS256", typ: "JWT", kid: "k1" });
  const body = enc(claims);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}
const readerToken = () => token({ azp: "console-knowledge", okf_org: "console_reader", realm_access: { roles: ["knowledge-reader"] } });

beforeAll(async () => {
  const params = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  signer = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", signer.publicKey);
  jwks = new JwksCache(async () => ({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] }));
});

afterEach(() => __setEngineExitedForTest(null));

type Call = { name: string; args: Record<string, unknown>; actor: string; vaultId: string };

function app(health: () => Promise<void> = async () => {}) {
  const calls: Call[] = [];
  const snapshots: string[] = [];
  const host = {
    callTool: async (name: string, args: Record<string, unknown>, actor: string, vaultId: string) => {
      calls.push({ name, args, actor, vaultId });
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
    snapshot: async (vaultId: string) => {
      snapshots.push(vaultId);
      return { head: "c1", files: { "facts/x.md": { content: "x", version: "abc" } } };
    },
  } as unknown as EngineHost;
  return { handle: createHandler({ config, host, health, jwks }), calls, snapshots };
}

const MCP_ACCEPT = "application/json, text/event-stream";

function mcpRequest(method: string, params: unknown, opts: { bearer?: string; accept?: string; query?: string } = {}): Request {
  return new Request(`http://hub.test/mcp${opts.query ?? ""}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: opts.accept ?? MCP_ACCEPT,
      "MCP-Protocol-Version": "2025-06-18",
      ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

/** The JSON-RPC body of an MCP response, whether sent as JSON or as one SSE event. */
async function rpcBody(response: Response): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  const text = await response.text();
  const data = text.split("\n").filter((l) => l.startsWith("data:"));
  return JSON.parse(data.length ? data[data.length - 1].slice(5) : text);
}

describe("/healthz", () => {
  it("healthz is ok while the stores answer", async () => {
    const response = await app().handle(new Request("http://hub.test/healthz"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("healthz is 503 while health() throws", async () => {
    const response = await app(async () => { throw new Error("postgres down"); }).handle(new Request("http://hub.test/healthz"));
    expect(response.status).toBe(503);
  });

  it("checkHealth fails when a store does not answer", async () => {
    const ok = { ping: async () => {} };
    const down = { ping: async () => { throw new Error("down"); } };
    await expect(checkHealth({ heads: ok, blobs: ok })).resolves.toBeUndefined();
    await expect(checkHealth({ heads: down, blobs: ok })).rejects.toThrow();
    await expect(checkHealth({ heads: ok, blobs: down })).rejects.toThrow();
  });

  it("healthz is 503 once the engine has exited, so the process is restarted", async () => {
    const ok = { ping: async () => {} };
    const { handle } = app(() => checkHealth({ heads: ok, blobs: ok }));
    expect((await handle(new Request("http://hub.test/healthz"))).status).toBe(200);
    __setEngineExitedForTest(() => true);
    expect((await handle(new Request("http://hub.test/healthz"))).status).toBe(503);
  });
});

describe("routing", () => {
  it("the hub API is not reachable", async () => {
    const response = await app().handle(new Request(`http://hub.test/api/v1/vaults/v_${"0".repeat(32)}/head`));
    expect(response.status).toBe(404);
  });

  it("an unknown path is 404", async () => {
    for (const path of ["/", "/authorize", "/grants", "/token", "/.well-known/oauth-protected-resource", "/mcp/extra"]) {
      expect((await app().handle(new Request(`http://hub.test${path}`))).status).toBe(404);
    }
  });
});

describe("/mcp", () => {
  it("mcp without a bearer is 401", async () => {
    const response = await app().handle(mcpRequest("tools/list", {}));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_token", error_description: "A valid access token for this hub is required." });
  });

  it("mcp with a token for another audience is 401", async () => {
    const response = await app().handle(mcpRequest("tools/list", {}, { bearer: await token({ aud: "http://elsewhere" }) }));
    expect(response.status).toBe(401);
  });

  it("mcp without the event-stream Accept header is 406", async () => {
    const response = await app().handle(mcpRequest("tools/list", {}, { bearer: await token(), accept: "application/json" }));
    expect(response.status).toBe(406);
  });

  it("an org token initializes with the bundle's instructions", async () => {
    const init = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } };
    const response = await app().handle(mcpRequest("initialize", init, { bearer: await token() }));
    expect(response.status).toBe(200);
    expect((await rpcBody(response)).result?.instructions).toBe(SERVER_INSTRUCTIONS);
  });

  it("an org token lists every okf tool and calls its own bundle", async () => {
    const { handle, calls } = app();
    const bearer = await token();
    const list = await rpcBody(await handle(mcpRequest("tools/list", {}, { bearer })));
    const names = (list.result?.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(["okf_create", "okf_relate", "okf_search", "okf_show", "okf_update", "okf_validate"]);

    const call = await rpcBody(await handle(mcpRequest("tools/call", { name: "okf_search", arguments: { query: "door" } }, { bearer })));
    expect((call.result?.content as { text: string }[])[0].text).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "okf_search", actor: "okf-org-acme", vaultId: await vaultIdFor("orgs/oidc-acme") });
  });

  it("a 2026-07-28 client lists the tools and calls its own bundle", async () => {
    const { handle, calls } = app();
    const bearer = await token();
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    };
    const modern = (method: string, params: Record<string, unknown>, headers: Record<string, string>) =>
      new Request("http://hub.test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT, "MCP-Protocol-Version": "2026-07-28", Authorization: `Bearer ${bearer}`, ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
      });

    const listed = await handle(modern("tools/list", {}, { "Mcp-Method": "tools/list" }));
    expect(listed.status).toBe(200);
    expect(((await rpcBody(listed)).result?.tools as unknown[]).length).toBe(6);

    const called = await handle(modern("tools/call", { name: "okf_search", arguments: { query: "door" } }, { "Mcp-Method": "tools/call", "Mcp-Name": "okf_search" }));
    expect(called.status).toBe(200);
    expect(((await rpcBody(called)).result?.content as { text: string }[])[0].text).toBe("ok");
    expect(calls).toEqual([{ name: "okf_search", args: { query: "door" }, actor: "okf-org-acme", vaultId: await vaultIdFor("orgs/oidc-acme") }]);
  });

  it("an org naming another org's bundle gets Access denied", async () => {
    const { handle, calls } = app();
    const bearer = await token();
    const refused = await handle(mcpRequest("tools/list", {}, { bearer, query: "?bundle=orgs/oidc-other" }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "forbidden", error_description: 'This token may not use the bundle "orgs/oidc-other".' });

    const call = await rpcBody(await handle(mcpRequest("tools/call", { name: "okf_show", arguments: { concept_id: "x", bundle: "orgs/oidc-other" } }, { bearer })));
    expect(call.result?.isError).toBe(true);
    expect((call.result?.content as { text: string }[])[0].text).toMatch(/^Access denied/);
    expect(calls).toEqual([]);
  });
});

describe("/v1/snapshot", () => {
  it("snapshot needs read access", async () => {
    const { handle, snapshots } = app();
    const read = await handle(new Request("http://hub.test/v1/snapshot?bundle=orgs/oidc-acme", { headers: { Authorization: `Bearer ${await readerToken()}` } }));
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ bundle: "orgs/oidc-acme", head: "c1", files: { "facts/x.md": { content: "x", version: "abc" } } });
    expect(snapshots).toEqual([await vaultIdFor("orgs/oidc-acme")]);

    const other = await handle(new Request("http://hub.test/v1/snapshot?bundle=orgs/oidc-other", { headers: { Authorization: `Bearer ${await token()}` } }));
    expect(other.status).toBe(403);
    expect(snapshots).toHaveLength(1);
  });

  it("snapshot without a bearer is 401", async () => {
    const response = await app().handle(new Request("http://hub.test/v1/snapshot?bundle=orgs/oidc-acme"));
    expect(response.status).toBe(401);
  });
});
