// Bindings and secrets `wrangler types` can't see (secrets live only in Cloudflare).
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

declare global {
  interface Env {
    /** Injected by OAuthProvider into the default handler's env. */
    OAUTH_PROVIDER: OAuthHelpers;
    HUB_TOKEN: string;
    MCP_TOKEN: string;
    VAULT_KEY_HEX: string;
    /** OIDC bundles only (src/bundles.ts): the key every bundle vault's key is derived from (64 hex). */
    VAULT_MASTER_KEY_HEX?: string;
    /** OIDC sign-in (src/oidc.ts); off unless OIDC_ISSUER is set. */
    OIDC_ISSUER?: string;
    OIDC_JWKS_URL?: string;
    OIDC_AUDIENCE?: string;
    OIDC_ACTOR_CLAIM?: string;
    OIDC_GRANTS?: string;
    GITHUB_CLIENT_SECRET: string;
    COOKIE_SECRET: string;
    /** Tests only: a loopback fake GitHub. Ignored for any other host. */
    GITHUB_BASE_URL?: string;
  }
}
export {};
