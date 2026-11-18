/**
 * The container's HTTP surface: exactly /mcp, /v1/snapshot and /healthz. Callers present an access
 * token from the OIDC provider (src/oidc.ts). The hub REST API (src/hub.ts) is in-process only and
 * is never routed from here, so every other path, /api/v1/... included, is 404.
 *
 * Until the stores are first prepared (src/readiness.ts), /healthz answers `200 starting` and /mcp and
 * /v1/snapshot answer 503 `starting` to a valid token (401 to anyone else), without touching the engine.
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
  /** Whether the stores have been prepared (src/readiness.ts). Absent means they have. */
  readiness?: { readonly ready: boolean };
};

const READY = { ready: true };

/** 401 to a caller without a valid token; 503 to one with, so it retries rather than giving up. */
async function starting(request: Request, config: HubConfig, jwks?: JwksCache): Promise<Response> {
  if (!(await bearerCaller(request, config.oidc, jwks))) return unauthorized();
  return Response.json(
    { error: "starting", error_description: "The hub is starting; try again shortly." },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } },
  );
}

type Pingable = { ping(): Promise<void> };

/** Healthy while the Go engine is alive and both stores answer. A dead engine fails it so the process is restarted. */
export async function checkHealth(stores: { heads: Pingable; blobs: Pingable }): Promise<void> {
  if (engineExited()) throw new Error("okf engine exited");
  await Promise.all([stores.heads.ping(), stores.blobs.ping()]);
}

export function createHandler({ config, host, health, jwks, readiness = READY }: HandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") {
      // Up but not ready yet: keep the replica, so the deploy that creates the database role can finish.
      if (!readiness.ready) return new Response("starting");
      try {
        await health();
        return new Response("ok");
      } catch (err) {
        console.error(JSON.stringify({ healthz: "unhealthy", error: String(err) }));
        return new Response("unavailable", { status: 503 });
      }
    }
    if ((pathname === "/v1/snapshot" || pathname === "/mcp") && !readiness.ready) return starting(request, config, jwks);
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
