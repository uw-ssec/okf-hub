import type { BlobStore, CommitResult, HeadState, HeadStore, Stores } from "../src/stores.js";

/** In-memory HeadStore with the same compare-and-swap semantics as PgHeadStore. */
export class FakeHeadStore implements HeadStore {
  private heads = new Map<string, { head: string; seq: number; updated_at: string }>();

  async getHead(vaultId: string): Promise<HeadState> {
    const h = this.heads.get(vaultId);
    return { head_commit: h?.head ?? "", updated_at: h?.updated_at ?? "" };
  }

  async commit(vaultId: string, expected: string, next: string): Promise<CommitResult> {
    const cur = this.heads.get(vaultId);
    const current = cur?.head ?? "";
    if (current !== expected) return { ok: false, current_head: current };
    const seq = (cur?.seq ?? 0) + 1;
    const accepted_at = new Date().toISOString();
    this.heads.set(vaultId, { head: next, seq, updated_at: accepted_at });
    return { ok: true, head: next, previous: current, seq, accepted_at };
  }
}

export class FakeBlobStore implements BlobStore {
  readonly objects = new Map<string, { data: Uint8Array; contentType: string }>();

  async has(key: string) {
    return this.objects.has(key);
  }
  async get(key: string) {
    return this.objects.get(key)?.data ?? null;
  }
  async put(key: string, data: Uint8Array, contentType: string) {
    this.objects.set(key, { data, contentType });
  }
}

export function fakeStores(): Stores & { blobs: FakeBlobStore; heads: FakeHeadStore } {
  return { heads: new FakeHeadStore(), blobs: new FakeBlobStore() };
}
