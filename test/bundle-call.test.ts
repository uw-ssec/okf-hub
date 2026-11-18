import { describe, expect, it } from "vitest";
import { bundleCall, nameBundle } from "../src/mcp";
import { vaultIdFor } from "../src/bundles";
import type { Policy } from "../src/policy";
import type { EngineHost } from "../src/engine-host.js";

type Call = { name: string; args: Record<string, unknown>; actor: string; vaultId: string };

function fakeHost() {
  const calls: Call[] = [];
  const host = {
    callTool: async (name: string, args: Record<string, unknown>, actor: string, vaultId: string) => {
      calls.push({ name, args, actor, vaultId });
      return { content: [{ type: "text" as const, text: "ok" }] };
    },
  } as unknown as EngineHost;
  return { host, calls };
}

const org: Policy = { clientName: "okf-org-acme", access: "full", exclude: [], bundles: [{ bundle: "orgs/oidc-acme", access: "write" }] };
const reader: Policy = { clientName: "console-knowledge", access: "full", exclude: [], bundles: [{ bundle: "orgs/*", access: "read" }] };

describe("bundleCall", () => {
  it("runs an org's call on its own bundle's vault, without the bundle argument", async () => {
    const { host, calls } = fakeHost();
    const result = await bundleCall(host, "okf_create", { concept_id: "facts/x", bundle: "orgs/oidc-acme" }, org, null);
    expect(result.isError).toBeUndefined();
    const vault = await vaultIdFor("orgs/oidc-acme");
    expect(calls).toEqual([{ name: "okf_create", args: { concept_id: "facts/x" }, actor: "okf-org-acme", vaultId: vault }]);
  });

  it("uses the token's only bundle when the call and request name none", async () => {
    const { host, calls } = fakeHost();
    await bundleCall(host, "okf_search", { query: "door" }, org, null);
    expect(calls[0].vaultId).toBe(await vaultIdFor("orgs/oidc-acme"));
  });

  it("denies another org's bundle, unknown names, and malformed names", async () => {
    const { host, calls } = fakeHost();
    for (const bundle of ["orgs/oidc-other", "default", "../orgs/oidc-acme", 42]) {
      const result = await bundleCall(host, "okf_show", { concept_id: "x", bundle }, org, null);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/^Access denied/);
    }
    expect(calls).toEqual([]);
  });

  it("lets a reader read any org's bundle and write none", async () => {
    const { host, calls } = fakeHost();
    expect((await bundleCall(host, "okf_show", { concept_id: "x" }, reader, "orgs/oidc-acme")).isError).toBeUndefined();
    const write = await bundleCall(host, "okf_create", { concept_id: "x" }, reader, "orgs/oidc-acme");
    expect(write.isError).toBe(true);
    expect(write.content[0].text).toMatch(/^Access denied: okf_create changes/);
    expect(calls).toHaveLength(1);
  });

  it("asks for a bundle when the token has no default one", async () => {
    const { host } = fakeHost();
    const result = await bundleCall(host, "okf_search", { query: "x" }, reader, null);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no default bundle/);
  });
});

describe("nameBundle", () => {
  it("replaces the engine's directory with the bundle name in text and structured results", () => {
    const out = nameBundle({
      content: [{ type: "text", text: "Successfully created concept facts/x.md in /vault/knowledge" }],
      structuredContent: { bundle: "/vault/knowledge", path: "facts/x.md" },
    }, "orgs/oidc-acme");
    expect(out.content[0].text).toBe("Successfully created concept facts/x.md in orgs/oidc-acme");
    expect(out.structuredContent).toEqual({ bundle: "orgs/oidc-acme", path: "facts/x.md" });
  });
});
