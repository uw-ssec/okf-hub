import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineHost, type ToolResult } from "../src/engine-host.js";
import { __setEngineExitedForTest } from "../src/engine/runtime.js";
import { vaultIdFor } from "../src/bundles.js";
import type { Stores } from "../src/stores.js";
import { fakeStores } from "./fake-stores.js";

const MASTER_KEY = "0f".repeat(32);
// The engine is per process and every test makes its own stores, so each test uses its own vaults.
let nextVault = 0;
const freshVault = () => vaultIdFor(`orgs/oidc-host-${++nextVault}`);
const ACTOR = "okf-org-acme";
// Wasm startup and each sync are slow on a cold engine.
const SLOW = 60_000;

const text = (result: ToolResult) => result.content.map((c) => c.text).join("\n");

const create = (id: string, title: string) => ({ concept_id: id, type: "Fact", title, description: `About ${title}.`, body: `The body of ${title}.` });

/** Fake stores that log the vault of every hub store operation, in order. */
function loggedStores(): { stores: Stores; log: string[]; commits: string[] } {
  const inner = fakeStores();
  const log: string[] = [];
  const commits: string[] = [];
  const vaultOf = (key: string) => key.split("/")[1];
  const stores: Stores = {
    heads: {
      getHead: (vault) => (log.push(vault), inner.heads.getHead(vault)),
      commit: (vault, expected, next) => (log.push(vault), commits.push(vault), inner.heads.commit(vault, expected, next)),
    },
    blobs: {
      has: (key) => (log.push(vaultOf(key)), inner.blobs.has(key)),
      get: (key) => (log.push(vaultOf(key)), inner.blobs.get(key)),
      put: (key, data, type) => (log.push(vaultOf(key)), inner.blobs.put(key, data, type)),
    },
  };
  return { stores, log, commits };
}

/** True when the log is one run per vault: once a vault's run ends, that vault never appears again. */
function oneRunPerVault(log: string[]): boolean {
  const finished = new Set<string>();
  for (let i = 0; i < log.length; i++) {
    if (finished.has(log[i])) return false;
    if (i > 0 && log[i] !== log[i - 1]) finished.add(log[i - 1]);
  }
  return true;
}

describe("EngineHost", () => {
  afterEach(() => __setEngineExitedForTest(null));

  it("create then show", async () => {
    const vaultA = await freshVault();
    const host = new EngineHost(fakeStores(), MASTER_KEY, () => {});
    const created = await host.callTool("okf_create", create("facts/alpha", "Alpha"), ACTOR, vaultA);
    expect(created.isError, text(created)).toBeFalsy();
    const shown = await host.callTool("okf_show", { concept_id: "facts/alpha" }, ACTOR, vaultA);
    expect(shown.isError, text(shown)).toBeFalsy();
    expect(text(shown)).toContain("The body of Alpha.");
  }, SLOW);

  it("vaults never see each other", async () => {
    const [vaultA, vaultB] = [await freshVault(), await freshVault()];
    const host = new EngineHost(fakeStores(), MASTER_KEY, () => {});
    expect((await host.callTool("okf_create", create("facts/kumquat", "Kumquat"), ACTOR, vaultA)).isError).toBeFalsy();
    const inB = await host.callTool("okf_search", { query: "kumquat" }, ACTOR, vaultB);
    expect(text(inB)).not.toContain("facts/kumquat");
    const inA = await host.callTool("okf_search", { query: "kumquat" }, ACTOR, vaultA);
    expect(text(inA)).toContain("facts/kumquat");
  }, SLOW);

  it("calls for two vaults run one at a time", async () => {
    const [vaultA, vaultB] = [await freshVault(), await freshVault()];
    const { stores, log, commits } = loggedStores();
    const host = new EngineHost(stores, MASTER_KEY, () => {});
    // Started together: B's call arrives while A's runs, so it must wait and then load B.
    const [createdA, createdB] = await Promise.all([
      host.callTool("okf_create", create("facts/apricot", "Apricot"), ACTOR, vaultA),
      host.callTool("okf_create", create("facts/blueberry", "Blueberry"), ACTOR, vaultB),
    ]);
    expect(createdA.isError, text(createdA)).toBeFalsy();
    expect(createdB.isError, text(createdB)).toBeFalsy();
    expect(text(createdA)).toContain("facts/apricot");
    expect(text(createdB)).toContain("facts/blueberry");
    expect(commits).toEqual([vaultA, vaultB]);
    expect(oneRunPerVault(log), log.join("\n")).toBe(true);

    const [aShowsB, bShowsB, bShowsA, aShowsA] = await Promise.all([
      host.callTool("okf_show", { concept_id: "facts/blueberry" }, ACTOR, vaultA),
      host.callTool("okf_show", { concept_id: "facts/blueberry" }, ACTOR, vaultB),
      host.callTool("okf_show", { concept_id: "facts/apricot" }, ACTOR, vaultB),
      host.callTool("okf_show", { concept_id: "facts/apricot" }, ACTOR, vaultA),
    ]);
    expect(text(aShowsB)).not.toContain("The body of Blueberry.");
    expect(text(bShowsB)).toContain("The body of Blueberry.");
    expect(text(bShowsA)).not.toContain("The body of Apricot.");
    expect(text(aShowsA)).toContain("The body of Apricot.");
  }, SLOW);

  it("snapshot returns the bundle's files", async () => {
    const vaultA = await freshVault();
    const host = new EngineHost(fakeStores(), MASTER_KEY, () => {});
    expect((await host.callTool("okf_create", create("facts/cherry", "Cherry"), ACTOR, vaultA)).isError).toBeFalsy();
    const snap = await host.snapshot(vaultA);
    expect(snap.head).toMatch(/^[0-9a-f]{64}$/);
    const file = snap.files["facts/cherry.md"];
    expect(file, Object.keys(snap.files).join(", ")).toBeDefined();
    expect(file.content).toContain("The body of Cherry.");
    expect(file.version).toMatch(/^[0-9a-f]{16}$/);
  }, SLOW);

  it("the engine exiting calls onEngineExit", async () => {
    const vaultA = await freshVault();
    const onExit = vi.fn();
    const host = new EngineHost(fakeStores(), MASTER_KEY, onExit);
    __setEngineExitedForTest(() => true);
    const result = await host.callTool("okf_search", { query: "x" }, ACTOR, vaultA);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    await expect(host.snapshot(vaultA)).rejects.toThrow(/engine exited/);
    expect(onExit).toHaveBeenCalledTimes(2);
  }, SLOW);
});
