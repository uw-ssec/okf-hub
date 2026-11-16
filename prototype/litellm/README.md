# Prototype: LiteLLM in front of okf-hub

A local Docker Compose stack that puts SSEC's LiteLLM fork in front of okf-hub, so anything that talks to LiteLLM can use the `okf_*` memory tools.

```
client ──► LiteLLM (MCP gateway, :4000) ──► okf-hub /mcp (:8787) ──► okf engine (Go → Wasm)
                    │                              │
                 Postgres                 throwaway encrypted vault
```

| Service | Built from | Notes |
|---|---|---|
| `okf-hub` | this repo, plus [`uw-ssec/okf-agent-memory`](https://github.com/uw-ssec/okf-agent-memory) at `engine/FORK_COMMIT` | Runs under `wrangler dev` (local workerd). No Cloudflare account needed. |
| `litellm` | [`uw-ssec/llmoxie-litellm`](https://github.com/uw-ssec/llmoxie-litellm) at `sso-enabled` | Pulls the image the fork's CI published for commit `3867628`. Set `LITELLM_IMAGE` to use another. |
| `db` | `postgres:16` | LiteLLM's database. |

## Run it

```bash
cd prototype/litellm
docker compose up -d             # builds the hub image, pulls the LiteLLM image
bash smoke.sh                    # optional argument: a search query
docker compose down -v           # stop and delete the vault and database
```

`smoke.sh` checks that the hub is healthy, that LiteLLM lists the six `okf_*` tools, and that an `okf_search` called through LiteLLM returns hits.

## What happens on start

1. The hub image builds the okf engine to Wasm, plus the `okf` CLI and `derivekey`, from the pinned fork commit.
2. On first start, `hub-entrypoint.sh` creates a vault from okf's public sample bundle with a random password, derives its key, starts the hub, and pushes the bundle. State lives in the `hub_state` volume.
3. LiteLLM loads `litellm-config.yaml`, which registers the hub's `/mcp` endpoint as the MCP server `okf` with a static bearer token.

## Limits of this prototype

- **Static token, not OAuth.** LiteLLM authenticates to the hub with `MCP_TOKEN`, which is a full, unrestricted grant. Per-app policies (read-only, hidden folders) need the hub's OAuth flow.
- **Shared network namespace.** The hub binds MCP tokens to its public URL, which must be HTTPS or loopback. LiteLLM therefore shares the hub's network namespace and calls `http://localhost:8787`. A real deployment points LiteLLM at the hub's HTTPS URL.
- **Throwaway data.** The vault holds the sample bundle only. Never point this stack at a real bundle.
- **Default credentials.** The tokens in `docker-compose.yml` are fixed prototype values and the ports bind to `127.0.0.1` only. Override them in `.env` before exposing anything.
- **Published LiteLLM image.** The image is amd64 only, so it runs under emulation on Apple Silicon. `docker compose build litellm` builds from source instead, but that compiles the fork's Rust core and was killed for memory with 8 GB allocated to Docker.
- **No models.** `litellm-config.yaml` configures no LLM, so this tests the MCP gateway path only.
