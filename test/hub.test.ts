import { describe, expect, it } from "vitest";
import { routeHub } from "../src/hub.js";
import { fakeStores } from "./fake-stores.js";

const V = "v_" + "a".repeat(32);
const base = `http://hub/api/v1/vaults/${V}`;

async function sha(data: Uint8Array) {
  const d = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const put = (s: ReturnType<typeof fakeStores>, hash: string, data: Uint8Array) =>
  routeHub(new Request(`${base}/blobs/${hash}`, { method: "PUT", body: data }), s);
const commit = (s: ReturnType<typeof fakeStores>, next: string, expected = "") =>
  routeHub(
    new Request(`${base}/commit`, {
      method: "POST",
      body: JSON.stringify({ new_commit_hash: next, expected_previous_head: expected }),
    }),
    s
  );

describe("routeHub", () => {
  it("rejects a blob whose hash does not match, storing nothing", async () => {
    const s = fakeStores();
    const res = await put(s, "b".repeat(64), new Uint8Array([1, 2, 3]));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "blob hash mismatch" });
    expect(s.blobs.objects.size).toBe(0);
  });

  it("round-trips a blob", async () => {
    const s = fakeStores();
    const data = new Uint8Array([9, 8, 7]);
    const h = await sha(data);
    const res = await put(s, h, data);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ hash: h, size: 3 });
    const got = await routeHub(new Request(`${base}/blobs/${h}`), s);
    expect(got.headers.get("Content-Type")).toBe("application/octet-stream");
    expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([9, 8, 7]);
  });

  it("rejects a commit before its blob is uploaded", async () => {
    const s = fakeStores();
    const res = await commit(s, "c".repeat(64));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "commit blob not uploaded" });
    expect((await s.heads.getHead(V)).head_commit).toBe("");
  });

  it("writes a ref for an accepted commit", async () => {
    const s = fakeStores();
    const data = new Uint8Array([4, 5, 6]);
    const H = await sha(data);
    await put(s, H, data);
    const res = await commit(s, H);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "accepted", head: H });
    const ref = s.blobs.objects.get(`vaults/${V}/refs/000000000001-${H}.json`);
    expect(ref?.contentType).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(ref!.data))).toMatchObject({ seq: 1, commit: H, previous: "" });
    const head = await routeHub(new Request(`${base}/head`), s);
    expect(await head.json()).toMatchObject({ vault_id: V, head_commit: H });
  });

  it("answers a stale commit with 409", async () => {
    const s = fakeStores();
    const d1 = new Uint8Array([1]);
    const d2 = new Uint8Array([2]);
    const h1 = await sha(d1);
    const h2 = await sha(d2);
    await put(s, h1, d1);
    await put(s, h2, d2);
    await commit(s, h1);
    const res = await commit(s, h2, "");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "head_mismatch", current_head: h1 });
  });

  it("check-missing lists only absent hashes", async () => {
    const s = fakeStores();
    const d = new Uint8Array([7]);
    const have = await sha(d);
    await put(s, have, d);
    const lack = "d".repeat(64);
    const res = await routeHub(
      new Request(`${base}/blobs/check-missing`, { method: "POST", body: JSON.stringify({ hashes: [have, lack] }) }),
      s
    );
    expect(await res.json()).toEqual({ missing: [lack] });
  });

  it("rejects an invalid vault id", async () => {
    const res = await routeHub(new Request("http://hub/api/v1/vaults/nope/head"), fakeStores());
    expect(res.status).toBe(400);
  });
});
