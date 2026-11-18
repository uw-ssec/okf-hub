# okf-hub

An [OKF Memory Hub](https://github.com/okf-memory/okf-agent-memory) that serves shared knowledge bundles to AI clients as a remote MCP server, run as one Node service in a container.

- **Storage:** vault heads in Postgres, with an atomic compare-and-swap (stale writes are refused) and an append-only commit history. Encrypted blobs in Azure Blob Storage, content-addressed by SHA-256.
- **Engine:** okf itself, built to Wasm from the [uw-ssec fork](https://github.com/uw-ssec/okf-agent-memory) commit in `engine/FORK_COMMIT`, runs in process.
- **Auth:** access tokens from an OIDC provider such as Keycloak, and nothing else.

The Cloudflare Workers version, which also speaks the hub REST API to the `okf` CLI, lives on `main`.

## Using it

It serves exactly three paths; every other path, the hub REST API (`/api/v1/...`) included, is `404`:

- `POST /mcp`: the six okf tools for a bundle, as a stateless MCP server (Streamable HTTP; the 2025 protocol revisions and 2026-07-28).
- `GET /v1/snapshot?bundle=<name>`: every file of a bundle, for a token that may read it.
- `GET /healthz`: `200 ok` while Postgres and Blob Storage answer and the okf engine is running, `503` otherwise; `200 starting` before the hub has first prepared its stores.

Callers present an access token from an OIDC provider such as Keycloak as the bearer; nothing else is accepted (no static tokens, no GitHub OAuth). The tokens' grants decide which bundles they reach, as described in [Bundles for an OIDC provider's callers](#bundles-for-an-oidc-providers-callers). Vault heads live in Postgres and blobs in Azure Blob Storage, under the same `vaults/<id>/blobs/...` and `vaults/<id>/refs/...` keys as on `main`.

The service refuses to start without its required settings:

| Setting | Required | What it is |
|---|---|---|
| `OIDC_ISSUER` | yes | The token's `iss`, exactly. |
| `OIDC_JWKS_URL` | yes | Where the provider publishes its signing keys. |
| `OIDC_AUDIENCE` | yes | The `aud` a token must carry. |
| `OIDC_GRANTS` | yes | The JSON grant rules. |
| `VAULT_MASTER_KEY_HEX` | yes (secret) | 64 hex characters; every bundle's vault key derives from it. |
| `DATABASE_URL` | yes (secret) | Postgres connection string. The hub creates its tables on start. For TLS use `sslmode=verify-full`, which checks the server's certificate and host name against Node's bundled CA store; `sslrootcert=system` (libpq's spelling of that) is accepted and dropped, and no CA file is read. Queries time out after 15 s and connecting after 5 s. |
| `AZURE_STORAGE_CONNECTION_STRING` | yes (secret) | Blob Storage connection string. |
| `OIDC_ACTOR_CLAIM` | no | The claim naming the caller's organization. Default `okf_org`. |
| `BLOB_CONTAINER` | no | The blob container, created on start if missing. Default `okf-hub`. |
| `PORT` | no | The HTTP port. Default `7878`. |

The hub listens as soon as its settings load and does not wait for Postgres or Blob Storage: it creates its tables and blob container in the background, retrying every 1 s to 30 s and logging each failed attempt as `{"okfHub":"init_retry",...}` and success as `{"okfHub":"ready",...}`, so a first deploy can create its database role after the hub has started. Until then `/healthz` answers `200 starting`, and `/mcp` and `/v1/snapshot` answer `503 {"error":"starting"}` to a valid token (`401` to any other caller).

```bash
npm ci
npm run build:engine   # the okf engine as Wasm, from engine/FORK_COMMIT (needs Go)
npm run build          # dist/, with the engine beside it
npm start              # node dist/main.js; SIGTERM stops it gracefully
```

## Development

```bash
npm install
npm run build:engine        # builds the Go engine to Wasm from the pinned fork commit
npm run typecheck
npm test
npm run test:integration    # against compose.test.yml's Postgres and Azurite
```

`npm run test:integration` needs the Postgres and Azurite services in `compose.test.yml` (`docker-compose -f compose.test.yml up -d`). Never point tests at a real deployment.

End to end (the built image, Postgres, Azurite and a fake OIDC issuer): `docker compose up -d --build && bash test/container-oidc.sh`, then `docker compose down -v`. The script ends with `failed: 0` when it passes; set `COMPOSE=docker-compose` where there is no compose plugin.

## Remote MCP

`/mcp` exposes the same six tools as the local `okf mcp`: `okf_search`, `okf_show`, `okf_validate`, `okf_create`, `okf_update`, `okf_relate`.

**How it works:** one okf engine per process runs over an in-memory filesystem holding one decrypted vault at a time. Each call:

1. pulls the vault from the hub's stores;
2. runs okf's own MCP handler;
3. syncs writes back through the compare-and-swap and okf's 3-way merge.

Calls run one at a time. A call for a different vault reloads the engine with that vault. If the engine's Go runtime exits, `/healthz` turns `503` so the platform restarts the container.

## Bundles for an OIDC provider's callers

The hub serves **many vaults by name** to callers that sign in with an OIDC provider such as Keycloak or Entra. A service fetches an access token with client credentials and presents it at `/mcp`. Organizations then share one hub, and each one reaches only its own bundle.

A token must be signed with a key from `OIDC_JWKS_URL` (RS256 or ES256), carry `OIDC_ISSUER` as its `iss` and `OIDC_AUDIENCE` (the hub's address as the provider knows it) in its `aud`, and be unexpired. `OIDC_GRANTS` is a JSON list of rules. Each has `bundle`, `access` (`read` or `write`) and optionally `role` (a realm role the token must hold). `{actor}` in `bundle` is the token's actor claim (`OIDC_ACTOR_CLAIM`), and `prefix/*` covers every bundle under the prefix.

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

Each bundle is its own vault. Both the vault ID and its key come from the bundle name, so a new name is simply an empty vault until its first write. The hub derives every key, so these vaults are **not blind to the hub**; data at rest stays ciphertext. One okf engine serves every vault in the process, one call at a time, and it reloads when the next call is for a different vault.

## Configuration

All settings come from the environment; see the table under [Using it](#using-it). Keep `VAULT_MASTER_KEY_HEX`, `DATABASE_URL` and `AZURE_STORAGE_CONNECTION_STRING` in a secret store, never in the repository. Losing `VAULT_MASTER_KEY_HEX` makes every bundle unreadable.

## Backup and restore

A hub's state is its Postgres database (the `vault_head` and `vault_history` tables) and its blob container. Back up both with the platform's own tools, such as Postgres point-in-time restore and Blob Storage soft delete or versioning, and keep `VAULT_MASTER_KEY_HEX` with them.

Every accepted commit also writes an append-only ref, `vaults/<id>/refs/<seq>-<commit>.json`, beside the blobs. So the blob container alone holds every vault's history: to restore a vault from it, copy its objects back, then restore both tables. Set its `vault_head` row to the commit of its highest-numbered ref, and give `vault_history` one row per ref, in `seq` order, from the ref's `commit`, `previous` and `accepted_at`: the next commit's `seq` is the vault's `count(*)` in `vault_history`, so a `vault_head` restored alone would number new refs from 1 again.
