import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const ENV: Record<string, string> = {
  OIDC_ISSUER: "https://idp.example/realms/okf",
  OIDC_JWKS_URL: "https://idp.example/realms/okf/certs",
  OIDC_AUDIENCE: "okf-hub",
  OIDC_GRANTS: JSON.stringify([{ bundle: "shared", access: "read" }]),
  VAULT_MASTER_KEY_HEX: "ab".repeat(32),
  DATABASE_URL: "postgres://hub:pw@db:5432/hub",
  AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
};

describe("loadConfig", () => {
  it("loads a complete environment", () => {
    const config = loadConfig(ENV);
    expect(config.port).toBe(7878);
    expect(config.blobContainer).toBe("okf-hub");
    expect(config.oidc.actorClaim).toBe("okf_org");
    expect(config.databaseUrl).toBe(ENV.DATABASE_URL);
    expect(config.masterKeyHex).toBe(ENV.VAULT_MASTER_KEY_HEX);
  });

  it("reads the optional settings", () => {
    const config = loadConfig({ ...ENV, PORT: "9000", BLOB_CONTAINER: "x", OIDC_ACTOR_CLAIM: "org" });
    expect([config.port, config.blobContainer, config.oidc.actorClaim]).toEqual([9000, "x", "org"]);
  });

  it.each(Object.keys(ENV))("names the missing %s", (name) => {
    const env = { ...ENV };
    delete env[name];
    expect(() => loadConfig(env)).toThrow(name);
  });

  it.each(["abc", "z".repeat(64)])("rejects a master key that is not 64 hex: %s", (key) => {
    expect(() => loadConfig({ ...ENV, VAULT_MASTER_KEY_HEX: key })).toThrow("VAULT_MASTER_KEY_HEX");
  });
});
