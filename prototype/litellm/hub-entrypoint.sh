#!/usr/bin/env bash
# Start the hub under wrangler dev and seed it with a throwaway vault built
# from okf's public sample bundle. Everything here is disposable: the vault,
# its password and its key are regenerated whenever the state volume is empty.
set -euo pipefail
: "${HUB_TOKEN:?}" "${MCP_TOKEN:?}"
STATE=/state
HUB="http://127.0.0.1:8787"
SRC="$STATE/bundle"
KEY_PATTERN='[A-Z0-9]+(-[A-Z0-9]+){3,}'
export OKF_HUB_TOKEN="$HUB_TOKEN"

if [ ! -f "$STATE/vault.env" ]; then
  echo "hub: creating a throwaway vault from the sample bundle"
  rm -rf "$SRC" "$STATE/wrangler" && cp -R /opt/sample-bundle "$SRC"
  password="prototype-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  secret_key="$(OKF_HUB_PASSWORD="$password" okf hub init-vault -hub "$HUB" "$SRC" \
    | grep -i 'secret key' | grep -oE "$KEY_PATTERN" | head -1)"
  vault_id="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).vault_id)' "$SRC/.okf-vault.json")"
  ( umask 077
    printf 'OKF_HUB_PASSWORD=%s\nOKF_HUB_SECRET_KEY=%s\nVAULT_ID=%s\n' "$password" "$secret_key" "$vault_id" > "$STATE/vault.env" )
fi
set -a; . "$STATE/vault.env"; set +a

( umask 077
  printf 'HUB_TOKEN=%s\nMCP_TOKEN=%s\nVAULT_KEY_HEX=%s\n' "$HUB_TOKEN" "$MCP_TOKEN" "$(derivekey)" > /tmp/dev.vars )

npx wrangler dev --ip 0.0.0.0 --port 8787 --persist-to "$STATE/wrangler" --env-file /tmp/dev.vars \
  --var "MCP_VAULT_ID:$VAULT_ID" --var "PUBLIC_URL:${PUBLIC_URL:-http://localhost:8787}" \
  --show-interactive-dev-session=false &
wrangler_pid=$!
trap 'kill "$wrangler_pid" 2>/dev/null || true' TERM INT

for _ in $(seq 1 90); do curl -fs -o /dev/null "$HUB/healthz" && break; sleep 1; done
curl -fs -o /dev/null "$HUB/healthz" || { echo "hub: wrangler dev did not come up" >&2; exit 1; }

if [ ! -f "$STATE/seeded" ]; then
  okf hub push -hub "$HUB" -message "prototype seed" "$SRC" > /dev/null
  touch "$STATE/seeded"
  echo "hub: seeded vault $VAULT_ID"
fi
echo "hub: ready"
wait "$wrangler_pid"
