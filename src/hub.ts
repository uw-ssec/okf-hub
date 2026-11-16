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
 * Head pointers live in one Durable Object per vault; blobs live in R2.
 */
import { bearerMatches } from "./auth";

const VAULT_ID = /^v_[0-9a-f]{32}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_BLOB_BYTES = 25 * 1024 * 1024;
const MAX_CHECK_HASHES = 10_000;
const R2_CONCURRENCY = 25;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (status: number, message: string) => json({ error: message }, status);

const blobKey = (vault: string, hash: string) => `vaults/${vault}/blobs/${hash}`;
// Zero-padded so lexical order == commit order (the latest ref sorts last).
const refKey = (vault: string, seq: number, commit: string) =>
  `vaults/${vault}/refs/${String(seq).padStart(12, "0")}-${commit}.json`;

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

async function handleCommit(request: Request, env: Env, vault: string): Promise<Response> {
  const body = await readJson<{ new_commit_hash?: unknown; expected_previous_head?: unknown }>(request);
  const next = body?.new_commit_hash;
  const expected = body?.expected_previous_head ?? "";
  if (typeof next !== "string" || !SHA256_HEX.test(next) || typeof expected !== "string") {
    return error(400, "invalid commit request");
  }
  if (expected !== "" && !SHA256_HEX.test(expected)) return error(400, "invalid expected_previous_head");

  // Never let the head point at a commit the hub does not hold.
  if (!(await env.BLOBS.head(blobKey(vault, next)))) return error(400, "commit blob not uploaded");

  const result = await env.VAULT_HEAD.getByName(vault).commit(expected, next);
  if (!result.ok) return json({ error: "head_mismatch", current_head: result.current_head }, 409);

  // Mirror the accepted commit into R2 as an append-only ref so the bucket
  // alone is a complete backup: restore = copy objects back + set head to the
  // highest-numbered ref. Refs are never overwritten (one object per commit).
  await env.BLOBS.put(
    refKey(vault, result.seq, result.head),
    JSON.stringify({ seq: result.seq, commit: result.head, previous: result.previous, accepted_at: result.accepted_at }),
    { httpMetadata: { contentType: "application/json" } }
  );
  return json({ status: "accepted", head: result.head });
}

async function handleCheckMissing(request: Request, env: Env, vault: string): Promise<Response> {
  const body = await readJson<{ hashes?: unknown }>(request);
  const hashes = body?.hashes;
  if (!Array.isArray(hashes) || hashes.length > MAX_CHECK_HASHES || !hashes.every((h) => typeof h === "string" && SHA256_HEX.test(h))) {
    return error(400, "invalid hashes");
  }
  const missing: string[] = [];
  for (let i = 0; i < hashes.length; i += R2_CONCURRENCY) {
    const batch = hashes.slice(i, i + R2_CONCURRENCY) as string[];
    const found = await Promise.all(batch.map((h) => env.BLOBS.head(blobKey(vault, h))));
    batch.forEach((h, j) => found[j] || missing.push(h));
  }
  return json({ missing });
}

async function handleBlob(request: Request, env: Env, vault: string, hash: string): Promise<Response> {
  if (request.method === "GET") {
    const object = await env.BLOBS.get(blobKey(vault, hash));
    if (!object) return error(404, "not found");
    return new Response(object.body, { headers: { "Content-Type": "application/octet-stream" } });
  }
  if (request.method === "PUT") {
    const declared = Number(request.headers.get("Content-Length") ?? "0");
    if (declared > MAX_BLOB_BYTES) return error(413, "blob too large");
    const data = await request.arrayBuffer();
    if (data.byteLength > MAX_BLOB_BYTES) return error(413, "blob too large");
    // Content addressing: the path must be the SHA-256 of the envelope bytes.
    if ((await sha256Hex(data)) !== hash) return error(400, "blob hash mismatch");
    await env.BLOBS.put(blobKey(vault, hash), data, {
      sha256: hash, // R2 re-verifies integrity on write
      httpMetadata: { contentType: "application/octet-stream" },
    });
    return json({ hash, size: data.byteLength }, 201);
  }
  return error(405, "method not allowed");
}

/** The hub REST API. Every request must carry the HUB_TOKEN bearer. */
export async function routeHub(request: Request, env: Env): Promise<Response> {
  if (!(await bearerMatches(request, env.HUB_TOKEN))) return error(401, "unauthorized");
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
    const head = await env.VAULT_HEAD.getByName(vault).getHead();
    return json({ vault_id: vault, ...head });
  }
  if (endpoint === "commit" && arg === undefined) {
    if (request.method !== "POST") return error(405, "method not allowed");
    return handleCommit(request, env, vault);
  }
  if (endpoint === "blobs" && arg === "check-missing") {
    if (request.method !== "POST") return error(405, "method not allowed");
    return handleCheckMissing(request, env, vault);
  }
  if (endpoint === "blobs" && arg !== undefined && SHA256_HEX.test(arg)) {
    return handleBlob(request, env, vault, arg);
  }
  return error(404, "not found");
}
