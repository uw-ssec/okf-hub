export type HeadState = { head_commit: string; updated_at: string };

export type CommitResult =
  | { ok: true; head: string; previous: string; seq: number; accepted_at: string }
  | { ok: false; current_head: string };

export interface HeadStore {
  getHead(vaultId: string): Promise<HeadState>;
  /** Advance the head only if it still equals `expected` ("" means no commits yet). */
  commit(vaultId: string, expected: string, next: string): Promise<CommitResult>;
}

export interface BlobStore {
  has(key: string): Promise<boolean>;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
}

export type Stores = { heads: HeadStore; blobs: BlobStore };
