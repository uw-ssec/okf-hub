// Bindings and secrets `wrangler types` can't see (secrets live only in Cloudflare).
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
  interface Env {
    /** Injected by OAuthProvider into the default handler's env. */
    OAUTH_PROVIDER: OAuthHelpers;
    HUB_TOKEN: string;
    MCP_TOKEN: string;
    VAULT_KEY_HEX: string;
    GITHUB_CLIENT_SECRET: string;
    COOKIE_SECRET: string;
    /** Tests only: a loopback fake GitHub. Ignored for any other host. */
    GITHUB_BASE_URL?: string;
  }
}
export {};
