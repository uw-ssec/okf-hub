import { describe, expect, it } from "vitest";
import { presentTool } from "../src/tool-presentation";

describe("presentTool", () => {
  it("tells clients the search tool is shared memory and to use it first", () => {
    const { description } = presentTool("okf_search", "Search the OKF knowledge bundle.");
    expect(description).toMatch(/persistent memory/i);
    expect(description).toMatch(/before answering/i);
    expect(description).toContain("Search the OKF knowledge bundle.");
  });
  it("marks read tools read-only and write tools as non-destructive writes", () => {
    expect(presentTool("okf_show", "x").annotations).toEqual({ title: expect.any(String), readOnlyHint: true, openWorldHint: false });
    expect(presentTool("okf_update", "x").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  });
});
