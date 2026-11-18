/**
 * The container's entry point: load the settings (refusing to start without them), prepare the
 * stores, and serve src/app.ts on PORT until SIGTERM.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import pg from "pg";
import { checkHealth, createHandler } from "./app.js";
import { AzureBlobStore } from "./azure-blobs.js";
import { loadConfig, type HubConfig } from "./config.js";
import { EngineHost } from "./engine-host.js";
import { PgHeadStore } from "./pg-heads.js";

/** Requests are JSON-RPC calls and snapshot reads; nothing legitimate comes near this. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const SHUTDOWN_GRACE_MS = 10_000;

let config: HubConfig;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`okf-hub: refusing to start: ${(err as Error).message}`);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: config.databaseUrl });
// An idle client losing its connection must not crash the process; the next query reconnects.
pool.on("error", (err) => console.error(JSON.stringify({ postgres: "idle_client_error", error: String(err) })));
const heads = new PgHeadStore(pool);
const blobs = new AzureBlobStore(config.blobConnectionString, config.blobContainer);
await heads.migrate();
await blobs.ensureContainer();

const host = new EngineHost({ heads, blobs }, config.masterKeyHex);
const handle = createHandler({ config, host, health: () => checkHealth({ heads, blobs }) });

class TooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new TooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** node:http in, fetch-style Request/Response through the handler, node:http out. */
async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const method = req.method ?? "GET";
    const headers = new Headers();
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);
    const response = await handle(new Request(`http://localhost${req.url ?? "/"}`, { method, headers, body }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch (err) {
    if (res.headersSent) return void res.destroy();
    const tooLarge = err instanceof TooLarge;
    if (!tooLarge) console.error(JSON.stringify({ http: "unhandled_error", error: String(err) }));
    res.writeHead(tooLarge ? 413 : 500, { "Content-Type": "text/plain" }).end(tooLarge ? "Payload too large" : "Internal error");
  }
}

const server = createServer((req, res) => void serve(req, res));
server.listen(config.port, () => console.log(JSON.stringify({ okfHub: "listening", port: config.port })));

process.once("SIGTERM", () => {
  console.log(JSON.stringify({ okfHub: "shutting_down" }));
  // Stop taking connections, let in-flight requests finish, then release Postgres.
  server.close(() => void pool.end().finally(() => process.exit(0)));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
});
