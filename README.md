# okf-hub

A persistent, authenticated [OKF Memory Hub](https://github.com/okf-memory/okf-agent-memory) on Cloudflare Workers. It speaks the same REST API as `okf hub serve`, so the `okf` CLI works against it unchanged, and it serves the vault to AI clients as a remote MCP server.

- **Blind storage:** the hub stores client-side encrypted envelopes (AES-256-GCM) in R2, content-addressed by SHA-256 and verified on upload.
- **Head pointers:** one Durable Object per vault, with an atomic compare-and-swap (stale writes get `409`) and an append-only commit history.
- **Auth:** a bearer token (`HUB_TOKEN` secret) on every hub API request except `/healthz`.

Unlike the embedded `okf hub serve`, this hub persists data across restarts, enforces auth, validates vault IDs and blob hashes, and refuses commits that point at blobs never uploaded.

## Client requirements

Use an `okf` build from `main` of the [uw-ssec fork](https://github.com/uw-ssec/okf-agent-memory). It has what the hub relies on:

- Sync state that persists between runs. Without it, only the first push to a vault succeeds and `sync` reverts local edits.
- Per-listing `index.md` merging. Without it, creating different concepts in the same folder on two devices collides.
- The vault password and Secret Key read from `OKF_HUB_PASSWORD` / `OKF_HUB_SECRET_KEY` instead of visible flags.

The hub's own engine is built from the fork commit in `engine/FORK_COMMIT`.

## Using it

```bash
# Once per bundle (prints the Emergency Kit: store it somewhere safe)
okf hub init-vault -hub <hub-url> knowledge

# Day to day (flags go BEFORE the bundle path; Go's flag parser stops at it).
# OKF_HUB_TOKEN, OKF_HUB_PASSWORD and OKF_HUB_SECRET_KEY come from the environment.
okf hub sync -hub <hub-url> knowledge
```

Add `.okf/` to the bundle repo's `.gitignore`; it holds per-device sync state.

## Development

```bash
npm install
npm run build:engine        # builds the Go engine to Wasm from the pinned fork commit
npm run typecheck
npm test
npm run dev                 # local wrangler dev on :8787 (uses .dev.vars)
```

Integration tests run the real `okf` CLI against a throwaway vault built from okf's public sample bundle. Never point them at a real bundle.

- `bash test/e2e.sh` (hub REST API)
- `bash test/mcp-e2e.sh` (MCP tools, including parity with local `okf mcp`)
- `bash test/mcp-oauth.sh` (OAuth against a local fake GitHub)
- `bash test/mcp-concurrency.sh` and `bash test/mcp-failure.sh`
- `bash test/mcp-oidc.sh` (OIDC bundles against a local fake provider)

## Remote MCP

`/mcp` serves the vault named by `MCP_VAULT_ID` as a stateless MCP server. It exposes the same six tools as the local `okf mcp`: `okf_search`, `okf_show`, `okf_validate`, `okf_create`, `okf_update`, `okf_relate`.

**How it works:** okf itself (pinned in `engine/FORK_COMMIT`, built to Wasm by `scripts/build-engine.sh`) runs inside the `VaultEngine` Durable Object over an in-memory filesystem holding the decrypted vault. Each call:

1. pulls from the hub;
2. runs okf's own MCP handler;
3. syncs writes back through the hub's compare-and-swap and 3-way merge.

Calls are serialized per vault, and local devices keep syncing alongside.

**Auth: OAuth 2.1.** The Worker is its own authorization server (`@cloudflare/workers-oauth-provider`), with discovery, `/authorize`, `/token` and `/register` (DCR). Approval requires a GitHub sign-in as the account in `ALLOWED_GITHUB_USER_ID`. Each grant carries its own policy:

- **Read only** (the default) or **read and write**.
- **Hidden folders**, which the app can't read or change. This is a disclosure guardrail, not a sealed partition.

`/grants` lists connected apps and revokes them. A static `MCP_TOKEN` bearer is also accepted as a full, unrestricted grant; it is intended for local development and service-to-service use.

**Trade-off:** the Worker holds the derived vault key (`VAULT_KEY_HEX`) and decrypts in memory while serving. Data at rest stays ciphertext.

## Bundles for an OIDC provider's callers

A deployment can also serve **many vaults by name** to callers that sign in with an OIDC provider such as Keycloak or Entra. A service fetches an access token with client credentials and presents it at `/mcp`. Organizations then share one hub, and each one reaches only its own bundle.

Set `OIDC_ISSUER` to turn this on. The other settings are then required:

| Setting | What it is |
|---|---|
| `OIDC_ISSUER` | The token's `iss`, exactly. |
| `OIDC_JWKS_URL` | Where the provider publishes its signing keys (RS256 or ES256). |
| `OIDC_AUDIENCE` | The `aud` a token must carry: the hub's address as the provider knows it. |
| `OIDC_ACTOR_CLAIM` | The claim that names the caller's organization. Defaults to `okf_org`. |
| `OIDC_GRANTS` | A JSON list of rules. Each has `bundle`, `access` (`read` or `write`) and optionally `role` (a realm role the token must hold). `{actor}` in `bundle` is the actor claim, and `prefix/*` covers every bundle under the prefix. |
| `VAULT_MASTER_KEY_HEX` (secret) | 64 hex characters. Every bundle vault's key is derived from it. |

For example, each organization writes its own bundle, and a reader role reads all of them:

```json
[
  { "bundle": "orgs/oidc-{actor}", "access": "write" },
  { "role": "knowledge-reader", "bundle": "orgs/*", "access": "read" }
]
```

A request picks its bundle in one of three ways, checked in this order:

1. The tools' `bundle` argument.
2. `/mcp?bundle=<name>`.
3. The token's only exact grant.

Anything the token's grants do not cover is refused with `Access denied`. `GET /v1/snapshot?bundle=<name>` returns every file of a bundle to a token that may read it.

Each bundle is its own vault. Both the vault ID and its key come from the bundle name, so a new name is simply an empty vault until its first write. The hub derives every key, so these vaults are **not blind to the hub**; data at rest stays ciphertext. One okf engine serves every vault in an isolate, one call at a time, and it reloads when the next call is for a different vault.

`MCP_TOKEN` and the GitHub OAuth flow keep serving `MCP_VAULT_ID` as before.

## Configuration

Set the placeholders in `wrangler.jsonc` before deploying: `MCP_VAULT_ID`, `PUBLIC_URL`, `ALLOWED_GITHUB_USER_ID`, `GITHUB_CLIENT_ID`, and the `OAUTH_KV` namespace ID.

Secrets (`wrangler secret put`, never committed): `HUB_TOKEN`, `MCP_TOKEN`, `VAULT_KEY_HEX`, `GITHUB_CLIENT_SECRET`, `COOKIE_SECRET`.

## Backup and restore

Every accepted commit also writes an append-only ref to R2 (`vaults/<id>/refs/<seq>-<commit>.json`), so the bucket alone is a complete backup. Copy it anywhere with a read-only R2 token.

```bash
OKF_HUB_TOKEN=... bash scripts/restore.sh /path/to/backup <vault-id> <hub-url>
okf hub pull -hub <hub-url> knowledge
```
