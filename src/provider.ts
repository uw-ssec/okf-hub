import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { secretMatches } from "./auth";
import { handleAuthorize, handleCallback } from "./authorize";
import { handleGrants } from "./grants";
import { routeHub } from "./hub";
import { handleMcp } from "./mcp";
import { LEGACY_PROPS, SCOPES } from "./policy";

const DAY = 86400;

/** Everything that isn't /mcp or an OAuth endpoint the library serves itself. */
export async function routeDefault(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/healthz") return new Response("ok");
  if (pathname === "/authorize") return handleAuthorize(request, env);
  if (pathname === "/callback") return handleCallback(request, env);
  if (pathname === "/grants" || pathname === "/grants/revoke" || pathname === "/callback/grants") return handleGrants(request, env);
  return routeHub(request, env);
}

/**
 * The Worker as one OAuth 2.1 authorization server + its one protected resource (/mcp).
 * `publicUrl` is the origin clients see; tokens are bound to `${publicUrl}/mcp`.
 */
export function buildProvider(publicUrl: string): OAuthProvider<Env> {
  const base = publicUrl.replace(/\/+$/, "");
  const resource = `${base}/mcp`;
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: { fetch: (request, env, ctx) => handleMcp(request, env as Env, ctx) },
    defaultHandler: { fetch: (request, env) => routeDefault(request, env as Env) },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: [SCOPES.read, SCOPES.write, SCOPES.offline],
    requiredScopes: [SCOPES.read],
    resourceMetadata: { resource, authorization_servers: [base] },
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 3600,
    refreshTokenTTL: 90 * DAY,
    refreshTokenIdleTTL: 90 * DAY,
    // Transitional: the phase 1 static token keeps working as a full, unrestricted grant
    // until every client has moved to OAuth (spec: Migration from MCP_TOKEN).
    resolveExternalToken: async ({ token, env }) =>
      (await secretMatches(token, (env as Env).MCP_TOKEN)) ? { props: LEGACY_PROPS, audience: resource } : null,
  });
}
