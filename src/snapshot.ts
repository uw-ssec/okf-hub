/**
 * GET /v1/snapshot?bundle=<name>: every file of one bundle, for an OIDC caller with read access to it.
 * The console shows an organization's knowledge from this. Off unless OIDC sign-in is configured.
 *
 *   200 { bundle, head, files: { "<path>": { content, version } } }   (an unwritten bundle has no files)
 */
import { accessFor, isBundleName, vaultIdFor } from "./bundles";
import { oidcConfig, resolveCaller } from "./oidc";
import type { Snapshot } from "./vault-engine";

const error = (status: number, code: string, description: string) =>
  Response.json({ error: code, error_description: description }, { status, headers: { "Cache-Control": "no-store" } });

export async function handleSnapshot(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return error(405, "method_not_allowed", "Use GET.");
  const config = oidcConfig(env as unknown as Record<string, unknown>);
  if (!config) return error(404, "not_found", "Not found.");
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer[\t ]+(\S+)$/i.exec(header);
  const caller = match ? await resolveCaller(match[1], config) : null;
  if (!caller) return error(401, "invalid_token", "A valid access token for this hub is required.");
  const bundle = new URL(request.url).searchParams.get("bundle") ?? "";
  if (!isBundleName(bundle)) return error(400, "invalid_request", "Name a bundle with ?bundle=.");
  if (!accessFor(caller.grants, bundle)) return error(403, "forbidden", `This token may not read the bundle "${bundle}".`);
  const vaultId = await vaultIdFor(bundle);
  const engine = env.VAULT_ENGINE.getByName(vaultId) as unknown as { snapshot(vaultId: string): Promise<Snapshot> };
  const snapshot = await engine.snapshot(vaultId);
  return Response.json({ bundle, ...snapshot }, { headers: { "Cache-Control": "no-store" } });
}
