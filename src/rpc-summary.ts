/** "method[:tool]" for each JSON-RPC message in a request body, for logs. Never includes arguments. */
export function rpcSummary(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    const messages = (Array.isArray(parsed) ? parsed : [parsed]) as { method?: string; params?: { name?: unknown } }[];
    return messages
      .map((m) => (m.method === "tools/call" && typeof m.params?.name === "string" ? `tools/call:${m.params.name}` : (m.method ?? "response")))
      .join(",");
  } catch {
    return "unparsed";
  }
}
