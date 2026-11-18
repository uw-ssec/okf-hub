/**
 * OKF Memory Hub on Cloudflare: a drop-in, persistent, authenticated
 * replacement for `okf hub serve`, speaking the same REST API
 * (okf-agent-memory pkg/sync/server.go):
 *
 *   GET  /api/v1/vaults/{vault}/head                 -> { vault_id, head_commit, updated_at }
 *   POST /api/v1/vaults/{vault}/commit               -> 200 { status, head } | 409 { error, current_head }
 *   POST /api/v1/vaults/{vault}/blobs/check-missing  -> { missing: [...] }
 *   PUT  /api/v1/vaults/{vault}/blobs/{sha256}       -> 201 { hash, size }
 *   GET  /api/v1/vaults/{vault}/blobs/{sha256}       -> ciphertext bytes
 *
 * The hub stays blind: it only ever stores client-side encrypted envelopes.
 * Head pointers and blobs live behind the pluggable HeadStore / BlobStore.
 */
import type { Stores } from "./stores.js";

const VAULT_ID = /^v_[0-9a-f]{32}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_BLOB_BYTES = 25 * 1024 * 1024;
const MAX_CHECK_HASHES = 10_000;
const BLOB_CHECK_CONCURRENCY = 25;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (status: number, message: string) => json({ error: message }, status);

const blobKey = (vault: string, hash: string) => `vaults/${vault}/blobs/${hash}`;
// Zero-padded so lexical order == commit order (the latest ref sorts last).
const refKey = (vault: string, seq: number, commit: string) =>
  `vaults/${vault}/refs/${String(seq).padStart(12, "0")}-${commit}.json`;

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

async function handleCommit(request: Request, stores: Stores, vault: string): Promise<Response> {
  const body = await readJson<{ new_commit_hash?: unknown; expected_previous_head?: unknown }>(request);
  const next = body?.new_commit_hash;
  const expected = body?.expected_previous_head ?? "";
  if (typeof next !== "string" || !SHA256_HEX.test(next) || typeof expected !== "string") {
    return error(400, "invalid commit request");
  }
  if (expected !== "" && !SHA256_HEX.test(expected)) return error(400, "invalid expected_previous_head");

  // Never let the head point at a commit the hub does not hold.
  if (!(await stores.blobs.has(blobKey(vault, next)))) return error(400, "commit blob not uploaded");

  const result = await stores.heads.commit(vault, expected, next);
  if (!result.ok) return json({ error: "head_mismatch", current_head: result.current_head }, 409);

  // Mirror the accepted commit into R2 as an append-only ref so the bucket
  // alone is a complete backup: restore = copy objects back + set head to the
  // highest-numbered ref. Refs are never overwritten (one object per commit).
  await stores.blobs.put(
    refKey(vault, result.seq, result.head),
    new TextEncoder().encode(
      JSON.stringify({ seq: result.seq, commit: result.head, previous: result.previous, accepted_at: result.accepted_at })
    ),
    "application/json"
  );
  return json({ status: "accepted", head: result.head });
}

async function handleCheckMissing(request: Request, stores: Stores, vault: string): Promise<Response> {
  const body = await readJson<{ hashes?: unknown }>(request);
  const hashes = body?.hashes;
  if (!Array.isArray(hashes) || hashes.length > MAX_CHECK_HASHES || !hashes.every((h) => typeof h === "string" && SHA256_HEX.test(h))) {
    return error(400, "invalid hashes");
  }
  const missing: string[] = [];
  for (let i = 0; i < hashes.length; i += BLOB_CHECK_CONCURRENCY) {
    const batch = hashes.slice(i, i + BLOB_CHECK_CONCURRENCY) as string[];
    const found = await Promise.all(batch.map((h) => stores.blobs.has(blobKey(vault, h))));
    batch.forEach((h, j) => found[j] || missing.push(h));
  }
  return json({ missing });
}

async function handleBlob(request: Request, stores: Stores, vault: string, hash: string): Promise<Response> {
  if (request.method === "GET") {
    const object = await stores.blobs.get(blobKey(vault, hash));
    if (!object) return error(404, "not found");
    return new Response(object as BodyInit, { headers: { "Content-Type": "application/octet-stream" } });
  }
  if (request.method === "PUT") {
    const declared = Number(request.headers.get("Content-Length") ?? "0");
    if (declared > MAX_BLOB_BYTES) return error(413, "blob too large");
    const data = new Uint8Array(await request.arrayBuffer());
    if (data.byteLength > MAX_BLOB_BYTES) return error(413, "blob too large");
    // Content addressing: the path must be the SHA-256 of the envelope bytes.
    if ((await sha256Hex(data)) !== hash) return error(400, "blob hash mismatch");
    await stores.blobs.put(blobKey(vault, hash), data, "application/octet-stream");
    return json({ hash, size: data.byteLength }, 201);
  }
  return error(405, "method not allowed");
}

/** The hub REST API, served in-process: it is never reachable from the network. */
export async function routeHub(request: Request, stores: Stores): Promise<Response> {
  const url = new URL(request.url);

  // /api/v1/vaults/{vault}/{endpoint}[/{arg}]
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 5 || parts[0] !== "api" || parts[1] !== "v1" || parts[2] !== "vaults") {
    return error(404, "not found");
  }
  const [, , , vault, endpoint, arg, extra] = parts;
  if (!VAULT_ID.test(vault) || extra !== undefined) return error(400, "invalid path");

  if (endpoint === "head" && arg === undefined) {
    if (request.method !== "GET") return error(405, "method not allowed");
    const head = await stores.heads.getHead(vault);
    return json({ vault_id: vault, ...head });
  }
  if (endpoint === "commit" && arg === undefined) {
    if (request.method !== "POST") return error(405, "method not allowed");
    return handleCommit(request, stores, vault);
  }
  if (endpoint === "blobs" && arg === "check-missing") {
    if (request.method !== "POST") return error(405, "method not allowed");
    return handleCheckMissing(request, stores, vault);
  }
  if (endpoint === "blobs" && arg !== undefined && SHA256_HEX.test(arg)) {
    return handleBlob(request, stores, vault, arg);
  }
  return error(404, "not found");
}
