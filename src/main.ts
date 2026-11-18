/**
 * The container's entry point: load the settings (refusing to start without them), prepare the
 * stores, and serve src/app.ts on PORT until SIGTERM.
 */
import { createServer } from "node:http";
import pg from "pg";
import { checkHealth, createHandler } from "./app.js";
import { AzureBlobStore } from "./azure-blobs.js";
import { loadConfig, type HubConfig } from "./config.js";
import { EngineHost } from "./engine-host.js";
import { nodeListener } from "./node-adapter.js";
import { PgHeadStore } from "./pg-heads.js";
import { poolConfig } from "./pg-pool.js";

const SHUTDOWN_GRACE_MS = 10_000;

let config: HubConfig;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`okf-hub: refusing to start: ${(err as Error).message}`);
  process.exit(1);
}

const pool = new pg.Pool(poolConfig(config.databaseUrl));
// An idle client losing its connection must not crash the process; the next query reconnects.
pool.on("error", (err) => console.error(JSON.stringify({ postgres: "idle_client_error", error: String(err) })));
const heads = new PgHeadStore(pool);
const blobs = new AzureBlobStore(config.blobConnectionString, config.blobContainer);
await heads.migrate();
await blobs.ensureContainer();

const host = new EngineHost({ heads, blobs }, config.masterKeyHex);
const handle = createHandler({ config, host, health: () => checkHealth({ heads, blobs }) });

const server = createServer(nodeListener(handle));
// Outlive the proxy's idle upstream connections (Envoy, Azure's front ends), so it never reuses one the hub has closed.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.listen(config.port, () => console.log(JSON.stringify({ okfHub: "listening", port: config.port })));

process.once("SIGTERM", () => {
  console.log(JSON.stringify({ okfHub: "shutting_down" }));
  // Stop taking connections, let in-flight requests finish, then release Postgres.
  server.close(() => void pool.end().finally(() => process.exit(0)));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
});
