#!/usr/bin/env bash
# End-to-end test: drive the real okf CLI against the hub.
#
#   HUB_URL=http://127.0.0.1:8787 OKF_HUB_TOKEN=... bash test/e2e.sh
#
# Uses a throwaway vault built from okf's own public sample bundle. Never point
# this at a real bundle: it creates vaults and writes conflicting edits.
set -euo pipefail

HUB_URL="${HUB_URL:-http://127.0.0.1:8787}"
: "${OKF_HUB_TOKEN:?set OKF_HUB_TOKEN to the hub bearer token}"
OKF_VERSION="${OKF_VERSION:-v0.6.0}"
PASSWORD="e2e-throwaway-password"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$ROOT/.work"
rm -rf "$WORK/a" "$WORK/b" && mkdir -p "$WORK/bin"

pass=0 fail=0
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
expect() { [ "$2" = "$3" ] && ok "$1" || bad "$1 (expected $3, got $2)"; }

# HTTP helper: prints only the status code.
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
AUTH=(-H "Authorization: Bearer $OKF_HUB_TOKEN")

echo "== Building okf $OKF_VERSION"
GOBIN="$WORK/bin" go install "github.com/okf-memory/okf-agent-memory/cmd/okf@$OKF_VERSION"
OKF="${OKF_BIN:-$WORK/bin/okf}" # OKF_BIN overrides, e.g. a locally built fork
SAMPLE="$(go env GOMODCACHE)/github.com/okf-memory/okf-agent-memory@$OKF_VERSION/knowledge"

hub() { "$OKF" hub "$1" -hub "$HUB_URL" -password "$PASSWORD" -secret-key "$SECRET" "${@:2}"; }

echo "== Protocol"
expect "healthz needs no auth" "$(code "$HUB_URL/healthz")" 200
FAKE_VAULT="v_$(openssl rand -hex 16)"
expect "missing token is rejected" "$(code "$HUB_URL/api/v1/vaults/$FAKE_VAULT/head")" 401
expect "wrong token is rejected" "$(code -H 'Authorization: Bearer nope' "$HUB_URL/api/v1/vaults/$FAKE_VAULT/head")" 401
expect "malformed vault ID is rejected" "$(code "${AUTH[@]}" "$HUB_URL/api/v1/vaults/../../etc/head")" 404
expect "non-hex vault ID is rejected" "$(code "${AUTH[@]}" "$HUB_URL/api/v1/vaults/v_ZZZ/head")" 400
expect "empty vault has empty head" \
  "$(curl -s "${AUTH[@]}" "$HUB_URL/api/v1/vaults/$FAKE_VAULT/head" | python3 -I -c 'import json,sys; print(repr(json.load(sys.stdin)["head_commit"]))')" "''"
WRONG_HASH="$(printf 'x' | shasum -a 256 | cut -d' ' -f1)"
expect "blob whose bytes don't match its hash is rejected" \
  "$(code "${AUTH[@]}" -X PUT --data-binary 'not-x' "$HUB_URL/api/v1/vaults/$FAKE_VAULT/blobs/$WRONG_HASH")" 400
expect "commit pointing at an unuploaded blob is rejected" \
  "$(code "${AUTH[@]}" -X POST -d "{\"new_commit_hash\":\"$WRONG_HASH\",\"expected_previous_head\":null}" "$HUB_URL/api/v1/vaults/$FAKE_VAULT/commit")" 400

echo "== Machine A: init + push"
mkdir -p "$WORK/a" && cp -R "$SAMPLE" "$WORK/a/knowledge" && chmod -R u+w "$WORK/a"
KIT="$("$OKF" hub init-vault -hub "$HUB_URL" "$WORK/a/knowledge")"
KEY_PATTERN='[A-Z0-9]+(-[A-Z0-9]+){3,}'
SECRET="$(printf '%s\n' "$KIT" | grep -i 'secret key' | grep -oE "$KEY_PATTERN" | head -1)"
VAULT="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["vault_id"])' "$WORK/a/knowledge/.okf-vault.json")"
[ -n "$SECRET" ] && ok "init-vault produced a secret key" || bad "init-vault produced a secret key"
hub push -message "e2e initial" "$WORK/a/knowledge" >/dev/null && ok "push from A" || bad "push from A"
HEAD1="$(curl -s "${AUTH[@]}" "$HUB_URL/api/v1/vaults/$VAULT/head" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["head_commit"])')"
[ -n "$HEAD1" ] && ok "hub head advanced" || bad "hub head advanced"

echo "== Machine B: fresh pull"
mkdir -p "$WORK/b/knowledge" && cp "$WORK/a/knowledge/.okf-vault.json" "$WORK/b/knowledge/"
hub pull "$WORK/b/knowledge" >/dev/null && ok "pull into B" || bad "pull into B"
diff -rq -x .okf-vault.json -x .okf-sync-state.json "$WORK/a/knowledge" "$WORK/b/knowledge" >/dev/null \
  && ok "B is byte-identical to A" || bad "B is byte-identical to A"

echo "== Disjoint edits merge"
FILE1="$(cd "$WORK/a/knowledge" && find . -name '*.md' ! -name index.md ! -name log.md | sort | sed -n 1p)"
FILE2="$(cd "$WORK/a/knowledge" && find . -name '*.md' ! -name index.md ! -name log.md | sort | sed -n 2p)"
echo "edit-from-A" >> "$WORK/a/knowledge/$FILE1"
echo "edit-from-B" >> "$WORK/b/knowledge/$FILE2"
hub sync -message "A edits" "$WORK/a/knowledge" >/dev/null && ok "A syncs" || bad "A syncs"
hub sync -message "B edits" "$WORK/b/knowledge" >/dev/null && ok "B syncs" || bad "B syncs"
hub sync "$WORK/a/knowledge" >/dev/null || true
grep -q edit-from-B "$WORK/a/knowledge/$FILE2" && grep -q edit-from-A "$WORK/b/knowledge/$FILE1" \
  && ok "both machines have both edits" || bad "both machines have both edits"

echo "== Same-file conflict is preserved, not lost"
echo "conflict-from-A" >> "$WORK/a/knowledge/$FILE1"
echo "conflict-from-B" >> "$WORK/b/knowledge/$FILE1"
hub sync -message "A conflict" "$WORK/a/knowledge" >/dev/null || true
hub sync -message "B conflict" "$WORK/b/knowledge" >/dev/null || true
B_HAS_BOTH="no"
grep -rqs conflict-from-A "$WORK/b/knowledge" && grep -rqs conflict-from-B "$WORK/b/knowledge" && B_HAS_BOTH="yes"
expect "B keeps both versions of the conflicting edit" "$B_HAS_BOTH" yes
find "$WORK/b/knowledge" -name '*.conflict-local.md' | grep -q . \
  && ok "conflict copy written as *.conflict-local.md" || bad "conflict copy written as *.conflict-local.md"

echo "== Stale write gets 409"
CURRENT="$(curl -s "${AUTH[@]}" "$HUB_URL/api/v1/vaults/$VAULT/head" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["head_commit"])')"
expect "commit with an outdated expected head" \
  "$(code "${AUTH[@]}" -X POST -d "{\"new_commit_hash\":\"$CURRENT\",\"expected_previous_head\":\"$HEAD1\"}" "$HUB_URL/api/v1/vaults/$VAULT/commit")" 409

echo
echo "vault: $VAULT"
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
