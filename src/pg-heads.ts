import type pg from "pg";
import type { CommitResult, HeadState, HeadStore } from "./stores.js";

export type HistoryRow = { commit_id: string; previous_id: string; accepted_at: string };

/**
 * Vault heads in Postgres. `commit` locks the vault's head row, so the
 * read-compare-write cannot interleave with another commit on the same vault:
 * this is the hub's compare-and-set guarantee.
 */
export class PgHeadStore implements HeadStore {
  constructor(private readonly pool: pg.Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS vault_head (
        vault_id   text PRIMARY KEY,
        commit_id  text NOT NULL,
        updated_at text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vault_history (
        seq         bigserial,
        vault_id    text NOT NULL,
        commit_id   text NOT NULL,
        previous_id text NOT NULL,
        accepted_at text NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vault_history_vault_seq ON vault_history (vault_id, seq);
    `);
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async getHead(vaultId: string): Promise<HeadState> {
    const { rows } = await this.pool.query<{ commit_id: string; updated_at: string }>(
      "SELECT commit_id, updated_at FROM vault_head WHERE vault_id = $1",
      [vaultId]
    );
    const row = rows[0];
    return row ? { head_commit: row.commit_id, updated_at: row.updated_at } : { head_commit: "", updated_at: "" };
  }

  async commit(vaultId: string, expected: string, next: string): Promise<CommitResult> {
    const client = await this.pool.connect();
    // pg-pool drops its error listener while a client is checked out, and a lost connection (a
    // failover, a killed backend) always emits 'error': without a listener here it crashes the process.
    const onError = (err: Error) => console.error(JSON.stringify({ postgres: "client_error", error: String(err) }));
    client.on("error", onError);
    let failed: Error | undefined;
    try {
      await client.query("BEGIN");
      const lock = () =>
        client.query<{ commit_id: string }>("SELECT commit_id FROM vault_head WHERE vault_id = $1 FOR UPDATE", [
          vaultId,
        ]);
      let { rows } = await lock();
      if (rows.length === 0) {
        // Placeholder row so concurrent first commits serialise on it: the
        // loser waits here, then sees the winner's head on the re-check.
        await client.query(
          "INSERT INTO vault_head (vault_id, commit_id, updated_at) VALUES ($1, '', '') ON CONFLICT DO NOTHING",
          [vaultId]
        );
        ({ rows } = await lock());
      }
      const current = rows[0].commit_id;
      if (current !== expected) {
        await client.query("ROLLBACK");
        return { ok: false, current_head: current };
      }

      // Second-precision RFC 3339, matching the Go server's time.RFC3339 format.
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      await client.query("UPDATE vault_head SET commit_id = $2, updated_at = $3 WHERE vault_id = $1", [
        vaultId,
        next,
        now,
      ]);
      await client.query(
        "INSERT INTO vault_history (vault_id, commit_id, previous_id, accepted_at) VALUES ($1, $2, $3, $4)",
        [vaultId, next, current, now]
      );
      const count = await client.query<{ n: string }>("SELECT count(*) AS n FROM vault_history WHERE vault_id = $1", [
        vaultId,
      ]);
      await client.query("COMMIT");
      return { ok: true, head: next, previous: current, seq: Number(count.rows[0].n), accepted_at: now };
    } catch (err) {
      failed = err instanceof Error ? err : new Error(String(err));
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.off("error", onError);
      // A failed transaction may have left the connection broken or mid-transaction: discard it.
      client.release(failed);
    }
  }

  /** Accepted commits, newest first. Used for audits and backups. */
  async history(vaultId: string, limit = 100): Promise<HistoryRow[]> {
    const { rows } = await this.pool.query<HistoryRow>(
      "SELECT commit_id, previous_id, accepted_at FROM vault_history WHERE vault_id = $1 ORDER BY seq DESC LIMIT $2",
      [vaultId, limit]
    );
    return rows;
  }
}
