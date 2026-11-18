/**
 * The container's HTTP surface: exactly /mcp, /v1/snapshot and /healthz. Callers present an access
 * token from the OIDC provider (src/oidc.ts). The hub REST API (src/hub.ts) is in-process only and
 * is never routed from here, so every other path, /api/v1/... included, is 404.
 */
import type { HubConfig } from "./config.js";
import type { EngineHost } from "./engine-host.js";
import { engineExited } from "./engine/runtime.js";
import { handleMcp } from "./mcp.js";
import type { JwksCache } from "./oidc.js";
import type { GrantProps } from "./policy.js";
import { bearerCaller, handleSnapshot, unauthorized } from "./snapshot.js";

export type HandlerDeps = {
  config: HubConfig;
  host: EngineHost;
  /** Resolves while the hub can serve; throws otherwise. */
  health: () => Promise<void>;
  /** Signing-key cache; tests pass their own. */
  jwks?: JwksCache;
};

type Pingable = { ping(): Promise<void> };

/** Healthy while the Go engine is alive and both stores answer. A dead engine fails it so the process is restarted. */
export async function checkHealth(stores: { heads: Pingable; blobs: Pingable }): Promise<void> {
  if (engineExited()) throw new Error("okf engine exited");
  await Promise.all([stores.heads.ping(), stores.blobs.ping()]);
}

export function createHandler({ config, host, health, jwks }: HandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") {
      try {
        await health();
        return new Response("ok");
      } catch (err) {
        console.error(JSON.stringify({ healthz: "unhealthy", error: String(err) }));
        return new Response("unavailable", { status: 503 });
      }
    }
    if (pathname === "/v1/snapshot") return handleSnapshot(request, config.oidc, host, jwks);
    if (pathname === "/mcp") {
      const caller = await bearerCaller(request, config.oidc, jwks);
      if (!caller) return unauthorized();
      const props: GrantProps = { clientName: caller.clientName, access: "full", exclude: [], bundles: caller.grants };
      return handleMcp(request, host, props);
    }
    return new Response("Not found", { status: 404 });
  };
}
