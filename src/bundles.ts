/**
 * Named bundles: many vaults behind one /mcp, chosen per request and allowed per token.
 *
 * A deployment that signs callers in with an OIDC provider (src/oidc.ts) serves one vault per bundle
 * name ("orgs/oidc-acme"). The vault id and key both come from the name, so the hub needs no table of
 * bundles and a new name is an empty vault until its first write. The hub holds every bundle's key
 * (derived from VAULT_MASTER_KEY_HEX), so these vaults are not blind to it; data at rest stays ciphertext.
 *
 * Pure functions only, so every rule is unit-tested.
 */
export type BundleAccess = "read" | "write";
/** What one token may do with one bundle, or with every bundle under a prefix ("orgs/*"). */
export type BundleGrant = { bundle: string; access: BundleAccess };
/** One configured rule: `{actor}` in `bundle` is the token's actor claim; `role` limits it to tokens with that realm role. */
export type GrantRule = { bundle: string; access: BundleAccess; role?: string };

const SEGMENT = "[a-z0-9][a-z0-9._-]*";
const BUNDLE_NAME = new RegExp(`^${SEGMENT}(/${SEGMENT})*$`);
const BUNDLE_PATTERN = new RegExp(`^${SEGMENT}(/${SEGMENT})*(/\\*)?$`);
/** Actor claims become part of a bundle name, so they are held to one plain segment. */
const ACTOR = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const MAX_NAME = 128;

export function isBundleName(name: unknown): name is string {
  return typeof name === "string" && name.length <= MAX_NAME && BUNDLE_NAME.test(name) && !name.split("/").includes("..");
}

/** Parse and check the configured rules (OIDC_GRANTS). Throws on anything malformed: a bad rule must not start the hub. */
export function parseGrantRules(json: string): GrantRule[] {
  const raw = JSON.parse(json) as unknown;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("OIDC_GRANTS must be a non-empty JSON array");
  return raw.map((entry, i) => {
    const r = entry as Partial<GrantRule>;
    if (r.access !== "read" && r.access !== "write") throw new Error(`OIDC_GRANTS[${i}].access must be "read" or "write"`);
    if (typeof r.bundle !== "string" || !BUNDLE_PATTERN.test(r.bundle.replace("{actor}", "actor"))) {
      throw new Error(`OIDC_GRANTS[${i}].bundle is not a bundle name or "prefix/*" pattern`);
    }
    if (r.role !== undefined && (typeof r.role !== "string" || !r.role)) throw new Error(`OIDC_GRANTS[${i}].role must be a non-empty string`);
    return { bundle: r.bundle, access: r.access, ...(r.role ? { role: r.role } : {}) };
  });
}

/**
 * The bundles a token's claims grant. A rule naming `{actor}` applies only when the actor claim is a
 * plain segment; a rule with a `role` only when the token carries that realm role.
 */
export function grantsFor(rules: readonly GrantRule[], actor: unknown, roles: readonly string[]): BundleGrant[] {
  const actorOk = typeof actor === "string" && ACTOR.test(actor.toLowerCase());
  const grants: BundleGrant[] = [];
  for (const rule of rules) {
    if (rule.role && !roles.includes(rule.role)) continue;
    if (rule.bundle.includes("{actor}")) {
      if (!actorOk) continue;
      grants.push({ bundle: rule.bundle.replace("{actor}", (actor as string).toLowerCase()), access: rule.access });
    } else {
      grants.push({ bundle: rule.bundle, access: rule.access });
    }
  }
  return grants;
}

function covers(pattern: string, bundle: string): boolean {
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1); // keeps the trailing "/"
    return bundle.startsWith(prefix) && bundle.length > prefix.length;
  }
  return pattern === bundle;
}

/** The strongest access the grants give to this bundle, or null for none. */
export function accessFor(grants: readonly BundleGrant[], bundle: string): BundleAccess | null {
  if (!isBundleName(bundle)) return null;
  let best: BundleAccess | null = null;
  for (const grant of grants) {
    if (!covers(grant.bundle, bundle)) continue;
    if (grant.access === "write") return "write";
    best = "read";
  }
  return best;
}

/** The bundle a request means when it names none: the token's only exact (non-wildcard) grant, if it has exactly one. */
export function defaultBundle(grants: readonly BundleGrant[]): string | null {
  const exact = [...new Set(grants.filter((g) => !g.bundle.endsWith("/*")).map((g) => g.bundle))];
  return exact.length === 1 ? exact[0] : null;
}

/** Validate the grants a token's props carry. */
export function parseGrants(value: unknown): BundleGrant[] {
  if (!Array.isArray(value)) throw new Error("bundle grants must be an array");
  return value.map((entry) => {
    const g = entry as Partial<BundleGrant>;
    if ((g.access !== "read" && g.access !== "write") || typeof g.bundle !== "string" || !BUNDLE_PATTERN.test(g.bundle)) {
      throw new Error("malformed bundle grant");
    }
    return { bundle: g.bundle, access: g.access };
  });
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The hub vault holding a bundle: "v_" + 32 hex characters, the format the hub API accepts. */
export async function vaultIdFor(bundle: string): Promise<string> {
  if (!isBundleName(bundle)) throw new Error(`not a bundle name: ${bundle}`);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`okf-hub/bundle\n${bundle}`));
  return `v_${hex(digest).slice(0, 32)}`;
}

/** A bundle vault's AES key (hex): HMAC-SHA256 of its vault id under the deployment's master key. */
export async function vaultKeyFor(masterKeyHex: string, vaultId: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) throw new Error("VAULT_MASTER_KEY_HEX must be 64 hex characters");
  const raw = new Uint8Array(masterKeyHex.match(/../g)!.map((pair) => parseInt(pair, 16)));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`okf-hub/vault-key\n${vaultId}`)));
}
