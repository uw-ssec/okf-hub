import { describe, expect, it } from "vitest";
import { accessFor, defaultBundle, grantsFor, isBundleName, parseGrantRules, parseGrants, vaultIdFor, vaultKeyFor } from "../src/bundles";

const RULES = parseGrantRules(JSON.stringify([
  { bundle: "orgs/oidc-{actor}", access: "write" },
  { role: "knowledge-reader", bundle: "orgs/*", access: "read" },
]));

describe("bundle names", () => {
  it("accepts lowercase slash-separated segments only", () => {
    for (const ok of ["orgs/oidc-acme", "default", "a/b.c/d_e-f"]) expect(isBundleName(ok)).toBe(true);
    for (const bad of ["", "/orgs", "orgs/", "orgs//x", "orgs/../x", "Orgs/x", "orgs/*", "a b", "x".repeat(129), 7, null]) {
      expect(isBundleName(bad)).toBe(false);
    }
  });
});

describe("grant rules", () => {
  it("refuses malformed configuration", () => {
    expect(() => parseGrantRules("[]")).toThrow();
    expect(() => parseGrantRules('[{"bundle":"x","access":"admin"}]')).toThrow();
    expect(() => parseGrantRules('[{"bundle":"../x","access":"read"}]')).toThrow();
    expect(() => parseGrantRules('[{"bundle":"x","access":"read","role":""}]')).toThrow();
    expect(() => parseGrantRules("not json")).toThrow();
  });

  it("gives an org's token write access to its own bundle and nothing else", () => {
    const grants = grantsFor(RULES, "acme", []);
    expect(grants).toEqual([{ bundle: "orgs/oidc-acme", access: "write" }]);
    expect(accessFor(grants, "orgs/oidc-acme")).toBe("write");
    expect(accessFor(grants, "orgs/oidc-other")).toBeNull();
    expect(accessFor(grants, "default")).toBeNull();
    expect(defaultBundle(grants)).toBe("orgs/oidc-acme");
  });

  it("gives the reader role read access to every org bundle, and no default", () => {
    const grants = grantsFor(RULES, "console_reader", ["knowledge-reader"]);
    expect(accessFor(grants, "orgs/oidc-acme")).toBe("read");
    expect(accessFor(grants, "orgs/oidc-console_reader")).toBe("write");
    expect(accessFor(grants, "orgs")).toBeNull();
    expect(accessFor(grants, "other/x")).toBeNull();
  });

  it("skips {actor} rules when the claim is missing or not a plain segment", () => {
    for (const actor of [undefined, "", "a/b", "../x", "x y", 42, "a".repeat(64)]) {
      expect(grantsFor(RULES, actor, [])).toEqual([]);
    }
  });

  it("has no default bundle when a token has none or several", () => {
    expect(defaultBundle([])).toBeNull();
    expect(defaultBundle([{ bundle: "a", access: "read" }, { bundle: "b", access: "read" }])).toBeNull();
    expect(defaultBundle([{ bundle: "orgs/*", access: "read" }])).toBeNull();
  });

  it("validates grants carried in token props", () => {
    expect(parseGrants([{ bundle: "orgs/*", access: "read" }])).toEqual([{ bundle: "orgs/*", access: "read" }]);
    expect(() => parseGrants("x")).toThrow();
    expect(() => parseGrants([{ bundle: "x", access: "full" }])).toThrow();
  });
});

describe("vault identity", () => {
  it("maps each bundle to a stable vault id in the hub's format", async () => {
    const a = await vaultIdFor("orgs/oidc-acme");
    expect(a).toMatch(/^v_[0-9a-f]{32}$/);
    expect(await vaultIdFor("orgs/oidc-acme")).toBe(a);
    expect(await vaultIdFor("orgs/oidc-other")).not.toBe(a);
    await expect(vaultIdFor("../x")).rejects.toThrow();
  });

  it("derives a distinct 256-bit key per vault from the master key", async () => {
    const master = "11".repeat(32);
    const k1 = await vaultKeyFor(master, "v_" + "0".repeat(32));
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(await vaultKeyFor(master, "v_" + "0".repeat(32))).toBe(k1);
    expect(await vaultKeyFor(master, "v_" + "1".repeat(32))).not.toBe(k1);
    expect(await vaultKeyFor("22".repeat(32), "v_" + "0".repeat(32))).not.toBe(k1);
    await expect(vaultKeyFor("short", "v_x")).rejects.toThrow();
  });
});
