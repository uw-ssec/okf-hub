import { describe, expect, it } from "vitest";
import {
  LEGACY_PROPS,
  PolicyError,
  checkInput,
  engineArgs,
  isExcluded,
  linkTarget,
  normalizeConceptId,
  parseExcludes,
  policyFromProps,
  sanitizeActor,
  scopesFor,
  stripExcludedLinks,
  toolAllowed,
  type Policy,
} from "../src/policy";

const hidePeople: Policy = { clientName: "Agent", access: "full", exclude: ["people/"] };

describe("normalizeConceptId", () => {
  it("canonicalizes harmless spellings", () => {
    expect(normalizeConceptId("./people/jane")).toBe("people/jane");
    expect(normalizeConceptId("people//jane")).toBe("people/jane");
    expect(normalizeConceptId("people/jane.md")).toBe("people/jane");
    expect(normalizeConceptId("people\\jane")).toBe("people/jane");
    expect(normalizeConceptId("  people/jane ")).toBe("people/jane");
  });
  it("refuses traversal and absolute paths", () => {
    expect(() => normalizeConceptId("notes/../people/jane")).toThrow(PolicyError);
    expect(() => normalizeConceptId("/people/jane")).toThrow(PolicyError);
  });
});

describe("exclusions", () => {
  it("parses a comma or whitespace separated list into sorted unique prefixes", () => {
    expect(parseExcludes("people, /clients/ ,people\nfinance.md")).toEqual(["clients/", "finance/", "people/"]);
    expect(parseExcludes("  ")).toEqual([]);
    expect(() => parseExcludes("../secrets")).toThrow(PolicyError);
  });
  it("matches the folder itself and everything under it, ignoring case", () => {
    expect(isExcluded("people/jane", ["people/"])).toBe(true);
    expect(isExcluded("people", ["people/"])).toBe(true);
    expect(isExcluded("People/Jane", ["people/"])).toBe(true);
    expect(isExcluded("peoplex/a", ["people/"])).toBe(false);
  });
});

describe("toolAllowed", () => {
  it("limits read grants to the three read tools", () => {
    expect(toolAllowed("okf_search", "read")).toBe(true);
    expect(toolAllowed("okf_validate", "read")).toBe(true);
    expect(toolAllowed("okf_create", "read")).toBe(false);
    expect(toolAllowed("okf_relate", "full")).toBe(true);
  });
});

describe("checkInput", () => {
  it("refuses writes for a read grant, naming the policy", () => {
    const refusal = checkInput("okf_create", { concept_id: "notes/a" }, { ...hidePeople, access: "read" });
    expect(refusal).toMatch(/access policy/);
    expect(refusal).toMatch(/read only/);
  });
  it("refuses any excluded id however it is spelled", () => {
    for (const id of ["people/jane", "./people//jane", "People/Jane", "people/jane.md"]) {
      expect(checkInput("okf_show", { concept_id: id }, hidePeople)).toMatch(/access policy/);
    }
  });
  it("refuses traversal outright", () => {
    expect(checkInput("okf_show", { concept_id: "notes/../people/jane" }, hidePeople)).toMatch(/not allowed/);
  });
  it("checks both ends of a relation", () => {
    expect(checkInput("okf_relate", { source_id: "notes/a", target_id: "people/jane" }, hidePeople)).toMatch(/access policy/);
    expect(checkInput("okf_relate", { source_id: "notes/a", target_id: "notes/b" }, hidePeople)).toBeNull();
  });
});

describe("engineArgs", () => {
  it("passes normalized ids and over-fetches search only when folders are hidden", () => {
    expect(engineArgs("okf_show", { concept_id: "./notes//a.md" }, hidePeople)).toEqual({ concept_id: "notes/a" });
    expect(engineArgs("okf_search", { query: "x", limit: 3 }, hidePeople)).toEqual({ query: "x", limit: 100 });
    expect(engineArgs("okf_search", { query: "x", limit: 3 }, { ...hidePeople, exclude: [] })).toEqual({ query: "x", limit: 3 });
  });
});

describe("links", () => {
  it("resolves relative, root-absolute and fragment links to concept ids", () => {
    expect(linkTarget("roadmap/milestones", "../architecture/layers.md")).toBe("architecture/layers");
    expect(linkTarget("index", "architecture/layers.md#intro")).toBe("architecture/layers");
    expect(linkTarget("notes/a", "/people/jane.md")).toBe("people/jane");
    expect(linkTarget("notes/a", "https://example.com/people/jane")).toBeNull();
    expect(linkTarget("a", "../../x.md")).toBeNull();
  });
  it("drops lines that link into a hidden folder, inline or reference-style", () => {
    const body = ["keep", "- [Jane](../people/jane.md) is a friend", "[jane]: /people/jane.md", "- [Plan](plan.md)"].join("\n");
    expect(stripExcludedLinks("notes/a", body, ["people/"])).toBe(["keep", "- [Plan](plan.md)"].join("\n"));
    expect(stripExcludedLinks("notes/a", body, [])).toBe(body);
  });
});

describe("policyFromProps", () => {
  it("reads a grant's props and narrows anything missing to read-only", () => {
    expect(policyFromProps(LEGACY_PROPS)).toEqual({ clientName: "legacy-token", access: "full", exclude: [] });
    expect(policyFromProps(undefined)).toEqual({ clientName: "unknown-client", access: "read", exclude: [] });
    expect(policyFromProps({ clientName: "Agent", access: "full", exclude: ["people"] }).exclude).toEqual(["people/"]);
    expect(() => policyFromProps({ clientName: "x", access: "full", exclude: ["../x"] })).toThrow(PolicyError);
  });
});

describe("sanitizeActor", () => {
  it("makes a client name safe for a one-line commit message", () => {
    expect(sanitizeActor("Claude\nDesktop\t ")).toBe("Claude Desktop");
    expect(sanitizeActor("")).toBe("unknown-client");
    expect(sanitizeActor("x".repeat(100))).toHaveLength(64);
  });
});

describe("scopesFor", () => {
  it("maps access to OAuth scopes", () => {
    expect(scopesFor("read")).toEqual(["okf:read", "offline_access"]);
    expect(scopesFor("full")).toEqual(["okf:read", "okf:write", "offline_access"]);
  });
});

describe("review fixes", () => {
  it("refuses ids with control or format characters that okf would trim away (U+0085, U+FEFF)", () => {
    for (const key of ["concept_id", "source_id", "target_id"]) {
      expect(checkInput("okf_update", { [key]: "\u0085people/jane" }, hidePeople)).toMatch(/access policy/);
    }
    expect(checkInput("okf_show", { concept_id: "﻿people/jane" }, hidePeople)).toMatch(/access policy/);
    expect(() => normalizeConceptId("notes/a\u0000")).toThrow(PolicyError);
  });
  it("resolves backslash hrefs the way okf does", () => {
    expect(linkTarget("notes/a", "..\\people\\jane.md")).toBe("people/jane");
  });
  it("strips single-quoted and parenthesized titles, reference usages, and HTML anchors", () => {
    const body = [
      "keep",
      "[Jane](../people/jane.md 'Jane Doe')",
      "[Jane](../people/jane.md (Jane Doe))",
      "- [Jane Doe][jd] and [JD]",
      "[jd]: ../people/jane.md",
      '<a href="../people/jane.md">Jane</a>',
      "[Bob](..\\people\\bob.md)",
      "- [Plan][plan]",
      "[plan]: plan.md",
    ].join("\n");
    expect(stripExcludedLinks("notes/a", body, ["people/"])).toBe(["keep", "- [Plan][plan]", "[plan]: plan.md"].join("\n"));
  });
});
