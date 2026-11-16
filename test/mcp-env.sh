#!/usr/bin/env bash
# Source me. Builds a throwaway vault from okf's public sample bundle, derives
# its key, and starts an isolated wrangler dev serving the hub + engine for it.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$ROOT/test/.work/mcp"
OKF="${OKF_BIN:-okf}"
PORT="${MCP_TEST_PORT:-8790}"
HUB="http://127.0.0.1:$PORT"
KEY_PATTERN='[A-Z0-9]+(-[A-Z0-9]+){3,}'
rm -rf "$WORK" && mkdir -p "$WORK"

SAMPLE="$(go env GOMODCACHE)/github.com/okf-memory/okf-agent-memory@v0.6.0/knowledge"
[ -d "$SAMPLE" ] || (cd "$WORK" && GOBIN="$WORK" go install github.com/okf-memory/okf-agent-memory/cmd/okf@v0.6.0)
SRC="$WORK/source"
cp -R "$SAMPLE" "$SRC" && chmod -R u+w "$SRC"

export OKF_HUB_PASSWORD="mcp-test-throwaway-password"
export OKF_HUB_SECRET_KEY="$("$OKF" hub init-vault -hub "$HUB" "$SRC" | grep -i 'secret key' | grep -oE "$KEY_PATTERN" | head -1)"
VAULT="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["vault_id"])' "$SRC/.okf-vault.json")"
HUB_TOKEN="hub-$(openssl rand -hex 16)"
MCP_TOKEN="mcp-$(openssl rand -hex 16)"
export OKF_HUB_TOKEN="$HUB_TOKEN"
( umask 077
  printf 'HUB_TOKEN=%s\nMCP_TOKEN=%s\nVAULT_KEY_HEX=%s\n' \
    "$HUB_TOKEN" "$MCP_TOKEN" "$("$ROOT/.work/bin/derivekey")" > "$WORK/.dev.vars"
  # Optional test-only settings (e.g. TEST_FAULTS=...); never used in production.
  [ -z "${EXTRA_DEV_VARS:-}" ] || printf '%s\n' "$EXTRA_DEV_VARS" >> "$WORK/.dev.vars" )

VAR_ARGS=(--var "MCP_VAULT_ID:$VAULT" --var "PUBLIC_URL:$HUB")
for v in ${EXTRA_VARS:-}; do VAR_ARGS+=(--var "$v"); done
(cd "$ROOT" && npx wrangler dev --port "$PORT" --persist-to "$WORK/state" --env-file "$WORK/.dev.vars" \
  "${VAR_ARGS[@]}" --show-interactive-dev-session=false > "$WORK/wrangler.log" 2>&1 &)
stop_dev() { pkill -f -- "--persist-to $WORK/state" 2>/dev/null || true; sleep 1; pkill -f -- "$WORK/state" 2>/dev/null || true; }
trap stop_dev EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null "$HUB/healthz" && break; sleep 1; done
"$OKF" hub push -hub "$HUB" -message "test seed" "$SRC" > /dev/null
export HUB MCP_TOKEN VAULT SRC OKF WORK
