/**
 * GET /v1/snapshot?bundle=<name>: every file of one bundle, for an OIDC caller with read access to it.
 * The console shows an organization's knowledge from this.
 *
 *   200 { bundle, head, files: { "<path>": { content, version } } }   (an unwritten bundle has no files)
 */
import { accessFor, isBundleName, vaultIdFor } from "./bundles.js";
import { resolveCaller, type JwksCache, type OidcConfig } from "./oidc.js";
import type { EngineHost } from "./engine-host.js";

const error = (status: number, code: string, description: string) =>
  Response.json({ error: code, error_description: description }, { status, headers: { "Cache-Control": "no-store" } });

/** The caller a request's bearer token resolves to, or null when there is none or it is not valid here. */
export async function bearerCaller(request: Request, config: OidcConfig, jwks?: JwksCache) {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer[\t ]+(\S+)$/i.exec(header);
  return match ? resolveCaller(match[1], config, jwks) : null;
}

export const unauthorized = () => error(401, "invalid_token", "A valid access token for this hub is required.");

export async function handleSnapshot(request: Request, config: OidcConfig, host: EngineHost, jwks?: JwksCache): Promise<Response> {
  if (request.method !== "GET") return error(405, "method_not_allowed", "Use GET.");
  const caller = await bearerCaller(request, config, jwks);
  if (!caller) return unauthorized();
  const bundle = new URL(request.url).searchParams.get("bundle") ?? "";
  if (!isBundleName(bundle)) return error(400, "invalid_request", "Name a bundle with ?bundle=.");
  if (!accessFor(caller.grants, bundle)) return error(403, "forbidden", `This token may not read the bundle "${bundle}".`);
  const vaultId = await vaultIdFor(bundle);
  const snapshot = await host.snapshot(vaultId);
  return Response.json({ bundle, ...snapshot }, { headers: { "Cache-Control": "no-store" } });
}
