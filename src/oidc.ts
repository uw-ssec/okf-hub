/**
 * Callers signed in by an OIDC provider (Keycloak, Entra, ...) instead of this Worker's own OAuth:
 * a service fetches an access token with client credentials and presents it as the bearer.
 *
 * On when OIDC_ISSUER is set. The token must be signed by a key from OIDC_JWKS_URL, come from
 * OIDC_ISSUER, be addressed to OIDC_AUDIENCE and be unexpired. Its grants come from OIDC_GRANTS
 * (src/bundles.ts), read against its actor claim (OIDC_ACTOR_CLAIM) and realm roles.
 */
import { grantsFor, parseGrantRules, type BundleGrant, type GrantRule } from "./bundles.js";
import { sanitizeActor } from "./policy.js";
import type { webcrypto } from "node:crypto";

export type OidcConfig = { issuer: string; jwksUrl: string; audience: string; actorClaim: string; rules: GrantRule[] };
export type OidcCaller = { clientName: string; grants: BundleGrant[] };
type Claims = Record<string, unknown>;
type Jwk = webcrypto.JsonWebKey & { kid?: string; alg?: string; use?: string };

const ALGORITHMS: Record<string, { name: string; hash?: string; namedCurve?: string }> = {
  RS256: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  ES256: { name: "ECDSA", namedCurve: "P-256" },
};
const CLOCK_SKEW_S = 30;
const JWKS_TTL_MS = 5 * 60_000;
const JWKS_REFRESH_MIN_MS = 30_000;

/** The deployment's OIDC settings, or null when OIDC sign-in is off. Throws on a half-configured deployment. */
export function oidcConfig(env: Partial<Record<string, unknown>>): OidcConfig | null {
  const issuer = String(env.OIDC_ISSUER ?? "").trim();
  if (!issuer) return null;
  const get = (name: string) => {
    const value = String(env[name] ?? "").trim();
    if (!value) throw new Error(`${name} is required when OIDC_ISSUER is set`);
    return value;
  };
  return {
    issuer,
    jwksUrl: get("OIDC_JWKS_URL"),
    audience: get("OIDC_AUDIENCE"),
    actorClaim: String(env.OIDC_ACTOR_CLAIM ?? "").trim() || "okf_org",
    rules: parseGrantRules(get("OIDC_GRANTS")),
  };
}

function b64urlBytes(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function b64urlJson(text: string): Claims | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(b64urlBytes(text))) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Claims) : null;
  } catch {
    return null;
  }
}

export type JwksFetcher = (url: string) => Promise<{ keys: Jwk[] }>;

const defaultFetcher: JwksFetcher = async (url) => {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`JWKS fetch failed with HTTP ${response.status}`);
  return (await response.json()) as { keys: Jwk[] };
};

/** Signing keys per JWKS URL, refetched after a TTL or when a token names an unknown key (at most every 30 s). */
export class JwksCache {
  private entries = new Map<string, { keys: Jwk[]; fetchedAt: number }>();
  constructor(private fetcher: JwksFetcher = defaultFetcher, private now: () => number = Date.now) {}

  async key(url: string, kid: string | undefined, alg: string): Promise<Jwk | null> {
    const pick = (keys: Jwk[]) =>
      keys.find((k) => (kid === undefined || k.kid === kid) && (!k.alg || k.alg === alg) && (!k.use || k.use === "sig")) ?? null;
    let entry = this.entries.get(url);
    const stale = !entry || this.now() - entry.fetchedAt > JWKS_TTL_MS;
    const missing = entry && !pick(entry.keys) && this.now() - entry.fetchedAt > JWKS_REFRESH_MIN_MS;
    if (stale || missing) {
      try {
        const { keys } = await this.fetcher(url);
        entry = { keys: Array.isArray(keys) ? keys : [], fetchedAt: this.now() };
        this.entries.set(url, entry);
      } catch (err) {
        if (!entry) throw err; // nothing cached to fall back on
      }
    }
    return entry ? pick(entry.keys) : null;
  }
}

const sharedJwks = new JwksCache();

function audienceIncludes(aud: unknown, audience: string): boolean {
  const norm = (value: string) => value.replace(/\/+$/, "");
  const list = Array.isArray(aud) ? aud : [aud];
  return list.some((entry) => typeof entry === "string" && norm(entry) === norm(audience));
}

/** The verified claims of a token, or null if it is not a valid token for this hub. Never throws for a bad token. */
export async function verifyToken(token: string, config: OidcConfig, jwks: JwksCache = sharedJwks, nowS = Date.now() / 1000): Promise<Claims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = b64urlJson(parts[0]);
  const claims = b64urlJson(parts[1]);
  if (!header || !claims || typeof header.alg !== "string") return null;
  const params = ALGORITHMS[header.alg];
  if (!params) return null; // also refuses "none" and HMAC algorithms
  let jwk: Jwk | null;
  try {
    jwk = await jwks.key(config.jwksUrl, typeof header.kid === "string" ? header.kid : undefined, header.alg);
  } catch (err) {
    // The provider is unreachable and no keys are cached: no token can be checked, so none is accepted.
    console.error(JSON.stringify({ oidc: "jwks_unavailable", error: String(err) }));
    return null;
  }
  if (!jwk) return null;
  let valid = false;
  try {
    const { kid: _kid, alg: _alg, use: _use, key_ops: _ops, x5c: _x5c, ...material } = jwk as Jwk & { x5c?: unknown };
    const key = await crypto.subtle.importKey("jwk", material, params, false, ["verify"]);
    const signature = b64urlBytes(parts[2]);
    const verifyParams = params.name === "ECDSA" ? { name: "ECDSA", hash: "SHA-256" } : params;
    valid = await crypto.subtle.verify(verifyParams, key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return null;
  }
  if (!valid) return null;
  if (claims.iss !== config.issuer) return null;
  if (!audienceIncludes(claims.aud, config.audience)) return null;
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_S < nowS) return null;
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > nowS) return null;
  return claims;
}

/** Realm roles as Keycloak puts them in an access token. */
export function realmRoles(claims: Claims): string[] {
  const roles = (claims.realm_access as { roles?: unknown } | undefined)?.roles;
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === "string") : [];
}

/** Who a token is and what it may touch, or null if it is not a valid token or grants nothing. */
export async function resolveCaller(token: string, config: OidcConfig, jwks?: JwksCache): Promise<OidcCaller | null> {
  const claims = await verifyToken(token, config, jwks);
  if (!claims) return null;
  const grants = grantsFor(config.rules, claims[config.actorClaim], realmRoles(claims));
  if (!grants.length) return null;
  return { clientName: sanitizeActor(claims.azp ?? claims.client_id ?? claims.sub), grants };
}
