import { describe, expect, it } from "vitest";
import { filterResult, requestedLimit } from "../src/policy-output";
import type { Policy } from "../src/policy";
import type { ToolResult } from "../src/vault-engine";

const hidePeople: Policy = { clientName: "Agent", access: "full", exclude: ["people/"] };
const result = (data: unknown, structured: unknown = data): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: structured,
});
const textOf = (r: ToolResult) => JSON.parse(r.content[0].text);

describe("search", () => {
  const hits = [
    { concept_id: "people/jane", score: 9 },
    { concept_id: "notes/b", score: 8, outbound: ["people/jane", "notes/c"], inbound: ["people/joe"] },
    { concept_id: "notes/c", score: 7 },
    { concept_id: "notes/d", score: 6 },
  ];
  it("drops hidden hits and links, then honors the caller's limit", () => {
    const out = filterResult("okf_search", { query: "x", limit: 2 }, result(hits, { results: hits }), hidePeople);
    const expected = [
      { concept_id: "notes/b", score: 8, outbound: ["notes/c"], inbound: [] },
      { concept_id: "notes/c", score: 7 },
    ];
    expect(out.structuredContent).toEqual({ results: expected });
    expect(textOf(out)).toEqual(expected);
  });
  it("defaults to okf's limit of 10", () => {
    expect(requestedLimit({})).toBe(10);
    expect(requestedLimit({ limit: 500 })).toBe(100);
    expect(requestedLimit({ limit: 0 })).toBe(10);
  });
});

describe("show", () => {
  it("strips lines linking into hidden folders from body and raw content", () => {
    const concept = {
      id: "notes/b",
      body: "keep\n- [Jane](../people/jane.md)\nkeep2",
      raw_content: "---\ntype: note\n---\nkeep\n- [Jane](../people/jane.md)\nkeep2",
    };
    const out = filterResult("okf_show", { concept_id: "notes/b" }, result(concept), hidePeople);
    expect((out.structuredContent as typeof concept).body).toBe("keep\nkeep2");
    expect(textOf(out).raw_content).not.toContain("people/");
  });
  it("refuses a hidden concept even if one slipped past the input check", () => {
    const out = filterResult("okf_show", { concept_id: "x" }, result({ id: "people/jane", body: "" }), hidePeople);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/access policy/);
  });
});

describe("validate", () => {
  it("drops findings about hidden folders", () => {
    const report = {
      errors: ["people/jane.md: missing title", "notes/a.md: bad link"],
      warnings: ["People/joe.md: stale"],
      gate_findings: [],
      broken_links: [
        { source_concept: "people/jane", target_href: "x.md", reason: "missing" },
        { source_concept: "notes/a", target_href: "../people/zed.md", reason: "missing" },
        { source_concept: "notes/a", target_href: "gone.md", reason: "missing" },
      ],
      orphans: ["people/joe", "notes/z"],
      concept_count: 9,
    };
    const out = filterResult("okf_validate", {}, result(report), hidePeople);
    expect(out.structuredContent).toEqual({
      ...report,
      errors: ["notes/a.md: bad link"],
      warnings: [],
      broken_links: [{ source_concept: "notes/a", target_href: "gone.md", reason: "missing" }],
      orphans: ["notes/z"],
    });
  });
});

describe("pass-through", () => {
  it("leaves errors and unrestricted grants untouched", () => {
    const err: ToolResult = { isError: true, content: [{ type: "text", text: "people/jane not found" }] };
    expect(filterResult("okf_show", {}, err, hidePeople)).toBe(err);
    const ok = result({ id: "people/jane", body: "" });
    expect(filterResult("okf_show", {}, ok, { ...hidePeople, exclude: [] })).toBe(ok);
  });
});
