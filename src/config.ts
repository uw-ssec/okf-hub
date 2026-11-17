/** The container's settings, read once from the environment. Refuses to load when a required one is missing or malformed. */
import { oidcConfig, type OidcConfig } from "./oidc.js";

export type HubConfig = {
  oidc: OidcConfig;
  masterKeyHex: string;
  databaseUrl: string;
  blobConnectionString: string;
  blobContainer: string;
  port: number;
};

const REQUIRED = [
  "OIDC_ISSUER",
  "OIDC_JWKS_URL",
  "OIDC_AUDIENCE",
  "OIDC_GRANTS",
  "VAULT_MASTER_KEY_HEX",
  "DATABASE_URL",
  "AZURE_STORAGE_CONNECTION_STRING",
] as const;

export function loadConfig(env: Record<string, string | undefined>): HubConfig {
  const get = (name: string) => (env[name] ?? "").trim();
  const missing = REQUIRED.filter((name) => !get(name));
  if (missing.length) throw new Error(`missing required settings: ${missing.join(", ")}`);
  const masterKeyHex = get("VAULT_MASTER_KEY_HEX");
  if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) throw new Error("VAULT_MASTER_KEY_HEX must be 64 hex characters");
  const oidc = oidcConfig(env);
  if (!oidc) throw new Error("OIDC_ISSUER is required");
  const port = get("PORT") ? Number(get("PORT")) : 7878;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a port number");
  return {
    oidc,
    masterKeyHex,
    databaseUrl: get("DATABASE_URL"),
    blobConnectionString: get("AZURE_STORAGE_CONNECTION_STRING"),
    blobContainer: get("BLOB_CONTAINER") || "okf-hub",
    port,
  };
}
