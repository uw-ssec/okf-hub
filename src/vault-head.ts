import { DurableObject } from "cloudflare:workers";

import type { CommitResult, HeadState } from "./stores";

/**
 * One instance per vault (addressed by vault ID). Holds the vault's head
 * pointer and an append-only history of accepted commits.
 *
 * Durable Objects run one request at a time per instance, and the SQL API is
 * synchronous, so the read-compare-write in `commit` cannot interleave with
 * another commit: this is the hub's compare-and-set guarantee.
 */
export class VaultHead extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS head (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          commit_id  TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS history (
          seq         INTEGER PRIMARY KEY AUTOINCREMENT,
          commit_id   TEXT NOT NULL,
          previous_id TEXT NOT NULL,
          accepted_at TEXT NOT NULL
        );
      `);
    });
  }

  getHead(): HeadState {
    const row = this.ctx.storage.sql
      .exec<{ commit_id: string; updated_at: string }>("SELECT commit_id, updated_at FROM head WHERE id = 1")
      .toArray()[0];
    return row ? { head_commit: row.commit_id, updated_at: row.updated_at } : { head_commit: "", updated_at: "" };
  }

  /** Advance the head only if it still equals `expected` ("" means no commits yet). */
  commit(expected: string, next: string): CommitResult {
    const current = this.getHead().head_commit;
    if (current !== expected) return { ok: false, current_head: current };

    // Second-precision RFC 3339, matching the Go server's time.RFC3339 format.
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    this.ctx.storage.sql.exec(
      "INSERT INTO head (id, commit_id, updated_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET commit_id = excluded.commit_id, updated_at = excluded.updated_at",
      next,
      now
    );
    const { seq } = this.ctx.storage.sql
      .exec<{ seq: number }>(
        "INSERT INTO history (commit_id, previous_id, accepted_at) VALUES (?, ?, ?) RETURNING seq",
        next,
        current,
        now
      )
      .one();
    return { ok: true, head: next, previous: current, seq, accepted_at: now };
  }

  /** Accepted commits, newest first. Used for audits and backups. */
  history(limit = 100): { commit_id: string; previous_id: string; accepted_at: string }[] {
    return this.ctx.storage.sql
      .exec<{ commit_id: string; previous_id: string; accepted_at: string }>(
        "SELECT commit_id, previous_id, accepted_at FROM history ORDER BY seq DESC LIMIT ?",
        limit
      )
      .toArray();
  }
}
