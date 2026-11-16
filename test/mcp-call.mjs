// Minimal MCP client for tests: legacy-compatible stateless JSON-RPC over HTTP.
// Usage: node test/mcp-call.mjs <url> <token|-> <method> [paramsJSON]
const [, , url, token, method, paramsJson] = process.argv;
const headers = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "MCP-Protocol-Version": "2025-06-18",
  ...(token !== "-" ? { Authorization: `Bearer ${token}` } : {}),
};
async function rpc(id, m, params) {
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method: m, params }) });
  const text = await res.text();
  // Servers may answer as plain JSON or as Server-Sent Events ("data: {...}"),
  // both valid for MCP over HTTP; take the last SSE data payload when present.
  const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
  const payload = dataLines.length ? dataLines[dataLines.length - 1].slice(5).trim() : text;
  let body = null;
  try {
    body = payload ? JSON.parse(payload) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}
const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "okf-hub-test", version: "1" } });
if (init.status !== 200) {
  console.log(JSON.stringify(init));
  process.exit(0);
}
console.log(JSON.stringify(await rpc(2, method, paramsJson ? JSON.parse(paramsJson) : {})));
