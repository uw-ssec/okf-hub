import { afterEach, describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { nodeListener, type FetchHandler } from "../src/node-adapter.js";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function listen(handle: FetchHandler): Promise<number> {
  server = createServer(nodeListener(handle, 1024));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server!.address() as AddressInfo).port;
}

/** Polls until `check` holds, failing after `ms`. */
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("nodeListener", () => {
  it("passes the request through and writes the response back", async () => {
    let seen: Request | undefined;
    const port = await listen(async (request) => {
      seen = request;
      return new Response(`got ${await request.text()}`, { status: 201, headers: { "X-Test": "yes" } });
    });
    const response = await fetch(`http://127.0.0.1:${port}/mcp?bundle=a`, { method: "POST", body: "hello", headers: { Authorization: "Bearer t" } });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("yes");
    expect(await response.text()).toBe("got hello");
    expect(new URL(seen!.url).pathname + new URL(seen!.url).search).toBe("/mcp?bundle=a");
    expect(seen!.headers.get("authorization")).toBe("Bearer t");
    expect(seen!.signal.aborted).toBe(false);
  });

  it("refuses a body over the limit with 413", async () => {
    const port = await listen(async () => new Response("unreachable"));
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "x".repeat(2048) });
    expect(response.status).toBe(413);
  });

  it("a client that disconnects mid-stream aborts the request and cancels the response body", async () => {
    let signal: AbortSignal | undefined;
    let cancelled = false;
    const port = await listen(async (request) => {
      signal = request.signal;
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((r) => setTimeout(r, 5));
          controller.enqueue(new TextEncoder().encode(`event: ping\ndata: ${n++}\n\n`));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    });

    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
        res.once("data", () => {
          req.destroy(); // the client goes away after the first event
          resolve();
        });
      });
      req.on("error", () => {});
      req.once("error", reject);
      req.end("{}");
    });

    await until(() => signal?.aborted === true && cancelled);
    expect(signal!.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });
});
