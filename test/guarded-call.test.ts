import { describe, expect, it } from "vitest";
import { guardedCall, type Engine } from "../src/guarded-call";
import type { Policy } from "../src/policy";
import type { ToolResult } from "../src/engine-host.js";

function fakeEngine(reply: (name: string, args: Record<string, unknown>) => unknown) {
  const calls: { name: string; args: Record<string, unknown>; actor: string }[] = [];
  const engine: Engine = {
    async callTool(name, args, actor) {
      calls.push({ name, args, actor });
      const data = reply(name, args);
      return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data } as ToolResult;
    },
  };
  return { engine, calls };
}
const agent: Policy = { clientName: "Agent", access: "full", exclude: ["people/"] };

describe("guardedCall", () => {
  it("refuses before the engine runs", async () => {
    const { engine, calls } = fakeEngine(() => ({}));
    const out = await guardedCall(engine, "okf_show", { concept_id: "people/jane" }, agent);
    expect(out.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it("refuses writes for a read grant", async () => {
    const { engine, calls } = fakeEngine(() => ({}));
    const out = await guardedCall(engine, "okf_update", { concept_id: "notes/a" }, { ...agent, access: "read" });
    expect(out.content[0].text).toMatch(/read only/);
    expect(calls).toHaveLength(0);
  });
  it("commits as the client and over-fetches search, returning the requested count", async () => {
    const hits = [{ concept_id: "people/a" }, { concept_id: "notes/b" }, { concept_id: "notes/c" }, { concept_id: "notes/d" }];
    const { engine, calls } = fakeEngine(() => ({ results: hits }));
    const out = await guardedCall(engine, "okf_search", { query: "x", limit: 2 }, agent);
    expect(calls[0]).toEqual({ name: "okf_search", args: { query: "x", limit: 100 }, actor: "Agent" });
    expect((out.structuredContent as { results: unknown[] }).results).toEqual([{ concept_id: "notes/b" }, { concept_id: "notes/c" }]);
  });
});
