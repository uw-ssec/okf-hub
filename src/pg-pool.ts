/** The Postgres pool's settings: DATABASE_URL plus timeouts, so a failover cannot hang a request for minutes. */
import type pg from "pg";

/** A query, lock wait included, that runs longer than this is cancelled by the server. */
export const STATEMENT_TIMEOUT_MS = 15_000;

/**
 * DATABASE_URL as `pg` can use it. libpq's `sslrootcert=system` means "verify against the system's
 * CA store", but pg-connection-string reads `sslrootcert` as a file path and fails on "system".
 * Dropping it leaves `sslmode=verify-full` to `pg`, which then verifies the server's certificate and
 * host name against Node's bundled CA store (Azure Database for PostgreSQL's roots are in it).
 */
export function postgresConnectionString(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return databaseUrl; // not a URL; let pg report it
  }
  if (url.searchParams.get("sslrootcert") !== "system") return databaseUrl;
  url.searchParams.delete("sslrootcert");
  return url.toString();
}

export function poolConfig(databaseUrl: string): pg.PoolConfig {
  return {
    connectionString: postgresConnectionString(databaseUrl),
    connectionTimeoutMillis: 5_000,
    keepAlive: true,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    // Client side, for a server that stops answering altogether.
    query_timeout: STATEMENT_TIMEOUT_MS + 5_000,
  };
}
