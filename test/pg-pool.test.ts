import fs from "node:fs";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { poolConfig, postgresConnectionString } from "../src/pg-pool.js";

// The shape llmoxie deploys: TLS with full verification against the system's CA store.
const LLMOXIE_URL =
  "postgresql://okf_hub:s3cr%40t@okfhub-pg.postgres.database.azure.com:5432/okf_hub?sslmode=verify-full&sslrootcert=system";

/** The connection settings `pg` derives for a client, without connecting. */
const clientParams = (config: pg.ClientConfig) =>
  (new pg.Client(config) as unknown as { connectionParameters: Record<string, unknown> }).connectionParameters;

afterEach(() => vi.restoreAllMocks());

describe("postgresConnectionString", () => {
  it("drops sslrootcert=system and keeps everything else", () => {
    const url = new URL(postgresConnectionString(LLMOXIE_URL));
    expect(url.searchParams.get("sslrootcert")).toBeNull();
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
    expect(url.username).toBe("okf_hub");
    expect(url.password).toBe("s3cr%40t");
    expect(url.host).toBe("okfhub-pg.postgres.database.azure.com:5432");
    expect(url.pathname).toBe("/okf_hub");
  });

  it("leaves other URLs untouched", () => {
    for (const url of [
      "postgres://postgres:test@postgres:5432/postgres",
      "postgres://u:p@h/db?sslmode=verify-full&sslrootcert=/etc/ssl/ca.pem",
      "not a url",
    ]) {
      expect(postgresConnectionString(url)).toBe(url);
    }
  });
});

describe("poolConfig", () => {
  it("the raw llmoxie URL would read a file named 'system' (the bug this guards against)", () => {
    const readFileSync = vi.spyOn(fs, "readFileSync");
    expect(() => clientParams({ connectionString: LLMOXIE_URL })).toThrow(/ENOENT.*system/);
    expect(readFileSync).toHaveBeenCalledWith("system");
  });

  it("turns the llmoxie URL into TLS with full verification and no file read", () => {
    const readFileSync = vi.spyOn(fs, "readFileSync");
    const params = clientParams(poolConfig(LLMOXIE_URL));
    expect(readFileSync).not.toHaveBeenCalled();
    // An empty TLS options object: Node verifies the chain against its bundled CAs and checks the host name.
    expect(params.ssl).toEqual({});
    expect(params).toMatchObject({ host: "okfhub-pg.postgres.database.azure.com", port: 5432, user: "okf_hub", password: "s3cr@t", database: "okf_hub" });
  });

  it("sets connection, keepalive and query timeouts", () => {
    const config = poolConfig("postgres://postgres:test@postgres:5432/postgres");
    expect(config).toMatchObject({ connectionTimeoutMillis: 5000, keepAlive: true, statement_timeout: 15000, query_timeout: 20000 });
    expect(clientParams(config)).toMatchObject({ statement_timeout: 15000, query_timeout: 20000 });
  });
});
