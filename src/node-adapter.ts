/**
 * node:http in, a fetch-style Request/Response handler in the middle, node:http out.
 *
 * A client that goes away aborts the Request's signal and cancels the response body, so a long-lived
 * stream (an MCP `subscriptions/listen`) is torn down instead of being written to a dead socket forever.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export type FetchHandler = (request: Request) => Promise<Response>;

/** Requests are JSON-RPC calls and snapshot reads; nothing legitimate comes near this. */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

class TooLarge extends Error {}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new TooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Resolves when the socket can take more, or when the response has closed. */
function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

async function serve(handle: FetchHandler, req: IncomingMessage, res: ServerResponse, maxBodyBytes: number): Promise<void> {
  const disconnected = new AbortController();
  // "close" also fires after a normal end; only a response that never finished means the client left.
  res.on("close", () => {
    if (!res.writableFinished) disconnected.abort();
  });
  try {
    const method = req.method ?? "GET";
    const headers = new Headers();
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req, maxBodyBytes);
    const request = new Request(`http://localhost${req.url ?? "/"}`, { method, headers, body, signal: disconnected.signal });
    const response = await handle(request);
    if (disconnected.signal.aborted) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const reader = response.body.getReader();
      const stop = () => void reader.cancel().catch(() => {});
      disconnected.signal.addEventListener("abort", stop, { once: true });
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || disconnected.signal.aborted) break;
          if (!res.write(value)) await drained(res);
        }
      } finally {
        disconnected.signal.removeEventListener("abort", stop);
      }
      if (disconnected.signal.aborted) return;
    }
    res.end();
  } catch (err) {
    if (disconnected.signal.aborted) return;
    if (res.headersSent) return void res.destroy();
    const tooLarge = err instanceof TooLarge;
    if (!tooLarge) console.error(JSON.stringify({ http: "unhandled_error", error: String(err) }));
    res.writeHead(tooLarge ? 413 : 500, { "Content-Type": "text/plain" }).end(tooLarge ? "Payload too large" : "Internal error");
  }
}

/** A `node:http` request listener that serves `handle`. */
export function nodeListener(handle: FetchHandler, maxBodyBytes = MAX_BODY_BYTES): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => void serve(handle, req, res, maxBodyBytes);
}
