import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgHeadStore } from "../src/pg-heads.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is not set; run `npm run test:integration` with compose.test.yml up");

const schema = `t_${randomBytes(8).toString("hex")}`;
const vault = () => `v_${randomBytes(16).toString("hex")}`;
const commitId = () => randomBytes(32).toString("hex");

let admin: pg.Pool;
let pool: pg.Pool;
let store: PgHeadStore;

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  store = new PgHeadStore(pool);
  await store.migrate();
});

afterAll(async () => {
  await pool?.end();
  await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin?.end();
});

describe("PgHeadStore", () => {
  it("an unknown vault has an empty head", async () => {
    expect(await store.getHead(vault())).toEqual({ head_commit: "", updated_at: "" });
  });

  it('the first commit from "" is accepted', async () => {
    const v = vault();
    const a = commitId();
    const r = await store.commit(v, "", a);
    expect(r).toMatchObject({ ok: true, head: a, previous: "", seq: 1 });
    const head = await store.getHead(v);
    expect(head.head_commit).toBe(a);
    expect(head.updated_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it("a stale expected head is refused", async () => {
    const v = vault();
    const [a, b] = [commitId(), commitId()];
    await store.commit(v, "", a);
    expect(await store.commit(v, "", b)).toEqual({ ok: false, current_head: a });
    expect((await store.getHead(v)).head_commit).toBe(a);
  });

  it("exactly one of two racing commits wins", async () => {
    const v = vault();
    const [a, b, c] = [commitId(), commitId(), commitId()];
    await store.commit(v, "", a);
    const results = await Promise.all([store.commit(v, a, b), store.commit(v, a, c)]);
    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    const winner = (wins[0] as { head: string }).head;
    expect(losses[0]).toEqual({ ok: false, current_head: winner });
    expect((await store.getHead(v)).head_commit).toBe(winner);
    expect(await store.history(v)).toHaveLength(2);
  });

  it("two racing first commits cannot both win", async () => {
    const v = vault();
    const results = await Promise.all([store.commit(v, "", commitId()), store.commit(v, "", commitId())]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("vaults are independent", async () => {
    const [v1, v2] = [vault(), vault()];
    const [a, b, c] = [commitId(), commitId(), commitId()];
    expect(await store.commit(v1, "", a)).toMatchObject({ ok: true, seq: 1 });
    expect(await store.commit(v2, "", b)).toMatchObject({ ok: true, seq: 1 });
    expect(await store.commit(v1, a, c)).toMatchObject({ ok: true, seq: 2 });
    expect(await store.commit(v2, b, c)).toMatchObject({ ok: true, seq: 2 });
  });

  it("history lists accepted commits newest first", async () => {
    const v = vault();
    const [a, b] = [commitId(), commitId()];
    await store.commit(v, "", a);
    await store.commit(v, a, b);
    const rows = await store.history(v);
    expect(rows.map((r) => [r.commit_id, r.previous_id])).toEqual([
      [b, a],
      [a, ""],
    ]);
    expect(await store.history(v, 1)).toHaveLength(1);
  });

  it("migrate twice is harmless", async () => {
    await store.migrate();
    await store.migrate();
    await store.ping();
  });
});
