import { describe, expect, it } from "vitest";
import { z } from "zod";
import tools from "../src/okf-tools.json";
import { toolInputShape } from "../src/mcp-schema";

const byName = Object.fromEntries((tools as { name: string; inputSchema: object }[]).map((t) => [t.name, t]));

describe("toolInputShape", () => {
  it("drops the local-only bundle argument from every tool", () => {
    for (const tool of Object.values(byName)) expect(toolInputShape(tool.inputSchema)).not.toHaveProperty("bundle");
  });
  it("keeps required arguments required", () => {
    const create = z.object(toolInputShape(byName.okf_create.inputSchema));
    expect(create.safeParse({ concept_id: "a/b", type: "Fact", title: "T" }).success).toBe(false);
    expect(create.safeParse({ concept_id: "a/b", type: "Fact", title: "T", description: "D" }).success).toBe(true);
  });
  it("enforces enums and types", () => {
    const update = z.object(toolInputShape(byName.okf_update.inputSchema));
    expect(update.safeParse({ concept_id: "a/b", status: "bogus" }).success).toBe(false);
    expect(update.safeParse({ concept_id: "a/b", tags: ["x", "y"] }).success).toBe(true);
    const search = z.object(toolInputShape(byName.okf_search.inputSchema));
    expect(search.safeParse({ limit: "ten" }).success).toBe(false);
  });
});
