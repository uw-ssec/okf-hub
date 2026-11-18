import { beforeAll, describe, expect, it } from "vitest";
import { JwksCache, oidcConfig, resolveCaller, verifyToken, type OidcConfig, type RejectReason } from "../src/oidc";

const GRANTS = JSON.stringify([
  { bundle: "orgs/oidc-{actor}", access: "write" },
  { role: "knowledge-reader", bundle: "orgs/*", access: "read" },
]);
const ENV = {
  OIDC_ISSUER: "http://auth.localhost:8000/realms/litellm",
  OIDC_JWKS_URL: "http://keycloak:8080/certs",
  OIDC_AUDIENCE: "http://okf.localhost:7878",
  OIDC_GRANTS: GRANTS,
};
const config = oidcConfig(ENV) as OidcConfig;
const NOW = 1_800_000_000;

let signer: CryptoKeyPair;
let other: CryptoKeyPair;
let jwks: JwksCache;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

async function sign(claims: Record<string, unknown>, opts: { key?: CryptoKey; header?: Record<string, unknown> } = {}): Promise<string> {
  const head = enc({ alg: "RS256", typ: "JWT", kid: "k1", ...opts.header });
  const body = enc(claims);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? signer.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const good = (extra: Record<string, unknown> = {}) => ({
  iss: ENV.OIDC_ISSUER, aud: [ENV.OIDC_AUDIENCE, "account"], exp: NOW + 300, azp: "okf-org-acme", okf_org: "acme", ...extra,
});

beforeAll(async () => {
  const params = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  signer = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  other = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", signer.publicKey);
  jwks = new JwksCache(async () => ({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] }));
});

describe("oidcConfig", () => {
  it("is off without an issuer and refuses a half-configured deployment", () => {
    expect(oidcConfig({})).toBeNull();
    expect(() => oidcConfig({ ...ENV, OIDC_AUDIENCE: "" })).toThrow(/OIDC_AUDIENCE/);
    expect(() => oidcConfig({ ...ENV, OIDC_GRANTS: "[]" })).toThrow();
    expect(config.actorClaim).toBe("okf_org");
  });
});

describe("verifyToken", () => {
  it("accepts a token signed by the provider, for this hub, unexpired", async () => {
    const claims = await verifyToken(await sign(good()), config, jwks, NOW);
    expect(claims?.okf_org).toBe("acme");
  });

  it("refuses the wrong issuer, audience, expiry, signer, or algorithm, and says why", async () => {
    const cases: [string, RejectReason][] = [
      [await sign(good({ iss: "http://evil/realms/litellm" })), "iss"],
      [await sign(good({ aud: "account" })), "aud"],
      [await sign(good({ aud: undefined })), "aud"],
      [await sign(good({ exp: NOW - 120 })), "exp"],
      [await sign(good({ exp: undefined })), "exp"],
      [await sign(good({ nbf: NOW + 120 })), "nbf"],
      [await sign(good(), { key: other.privateKey }), "sig"],
      [await sign(good(), { header: { alg: "none" } }), "alg"],
      [await sign(good(), { header: { alg: "HS256" } }), "alg"],
      [await sign(good(), { header: { kid: "unknown" } }), "kid"],
      ["not-a-token", "malformed"],
      ["a.b.c", "malformed"],
      ["", "malformed"],
    ];
    for (const [token, reason] of cases) {
      const reasons: RejectReason[] = [];
      expect(await verifyToken(token, config, jwks, NOW, (r) => reasons.push(r))).toBeNull();
      expect(reasons, `token ${token.slice(0, 20)}...`).toEqual([reason]);
    }
    expect(await verifyToken(await sign(good()), config, jwks, NOW, (r) => { throw new Error(`rejected a good token: ${r}`); })).not.toBeNull();
  });

  it("refuses every token while the provider's keys cannot be fetched, and says why", async () => {
    const down = new JwksCache(async () => { throw new Error("connect ECONNREFUSED"); });
    const reasons: RejectReason[] = [];
    expect(await verifyToken(await sign(good()), config, down, NOW, (r) => reasons.push(r))).toBeNull();
    expect(reasons).toEqual(["jwks_unavailable"]);
  });

  it("refuses a token whose payload was changed after signing", async () => {
    const [h, , s] = (await sign(good())).split(".");
    expect(await verifyToken(`${h}.${enc(good({ okf_org: "other" }))}.${s}`, config, jwks, NOW)).toBeNull();
  });
});

describe("resolveCaller", () => {
  it("names the client and grants its org's bundle", async () => {
    const caller = await resolveCaller(await sign(good({ exp: Date.now() / 1000 + 300 })), config, jwks);
    expect(caller).toEqual({ clientName: "okf-org-acme", grants: [{ bundle: "orgs/oidc-acme", access: "write" }] });
  });

  it("refuses a valid token that grants nothing (a person's token with no org claim)", async () => {
    const token = await sign(good({ exp: Date.now() / 1000 + 300, okf_org: undefined, azp: "console" }));
    const reasons: RejectReason[] = [];
    expect(await resolveCaller(token, config, jwks, (r) => reasons.push(r))).toBeNull();
    expect(reasons).toEqual(["no_grants"]);
  });

  it("gives the reader role read access to every org", async () => {
    const token = await sign(good({ exp: Date.now() / 1000 + 300, okf_org: "console_reader", realm_access: { roles: ["knowledge-reader"] } }));
    const caller = await resolveCaller(token, config, jwks);
    expect(caller?.grants).toContainEqual({ bundle: "orgs/*", access: "read" });
  });
});

describe("JwksCache", () => {
  it("refetches for an unknown key id, at most every 30 seconds", async () => {
    let now = 0;
    let calls = 0;
    const cache = new JwksCache(async () => {
      calls++;
      return { keys: calls > 1 ? [{ kty: "RSA", kid: "new" }] : [{ kty: "RSA", kid: "old" }] };
    }, () => now);
    expect(await cache.key("u", "old", "RS256")).not.toBeNull();
    expect(await cache.key("u", "new", "RS256")).toBeNull(); // too soon to refetch
    now = 31_000;
    expect(await cache.key("u", "new", "RS256")).not.toBeNull();
    expect(calls).toBe(2);
  });

  it("keeps serving cached keys when a refetch fails", async () => {
    let now = 0;
    let fail = false;
    const cache = new JwksCache(async () => {
      if (fail) throw new Error("down");
      return { keys: [{ kty: "RSA", kid: "k" }] };
    }, () => now);
    await cache.key("u", "k", "RS256");
    fail = true;
    now = 10 * 60_000;
    expect(await cache.key("u", "k", "RS256")).not.toBeNull();
  });
});
