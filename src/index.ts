/** okf-hub Worker: OAuth 2.1 (src/provider.ts) in front of the remote MCP endpoint (src/mcp.ts), the hub API (src/hub.ts), and /healthz. */
export { VaultHead } from "./vault-head";
export { VaultEngine } from "./vault-engine";
import type { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { buildProvider } from "./provider";

let provider: OAuthProvider<Env> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    provider ??= buildProvider(env.PUBLIC_URL); // env is per-request; PUBLIC_URL is fixed per deployment
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
