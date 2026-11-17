#!/usr/bin/env bash
# OIDC sign-in and named bundles: each organization's token reaches its own bundle only, a reader role
# reads every bundle and writes none, and bundles stay apart while one engine serves them all.
set -euo pipefail
ROOTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0 fail=0
ok() { echo "  PASS $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL $1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
json() { python3 -I -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
FAKE_PORT="${FAKE_OIDC_PORT:-8792}"
FAKE="http://127.0.0.1:$FAKE_PORT"
ISSUER="http://issuer.test/realms/test"
node "$ROOTDIR/test/fake-oidc.mjs" "$FAKE_PORT" & FAKE_PID=$!
GRANTS='[{"bundle":"orgs/oidc-{actor}","access":"write"},{"role":"knowledge-reader","bundle":"orgs/*","access":"read"}]'
export EXTRA_VARS="OIDC_ISSUER:$ISSUER OIDC_JWKS_URL:$FAKE/certs OIDC_AUDIENCE:http://okf.test OIDC_GRANTS:$GRANTS"
export EXTRA_DEV_VARS="VAULT_MASTER_KEY_HEX=$(openssl rand -hex 32)"
source "$ROOTDIR/test/mcp-env.sh"
trap 'stop_dev; kill "$FAKE_PID" 2>/dev/null || true' EXIT

token() { curl -s -X POST "$FAKE/token" -d "{\"claims\":$1${2:+,\"key\":\"$2\"}}"; }
org_token() { token "{\"iss\":\"$ISSUER\",\"aud\":\"http://okf.test\",\"azp\":\"okf-org-$1\",\"okf_org\":\"$1\"}"; }
mcp() { node "$ROOTDIR/test/mcp-call.mjs" "$HUB/mcp$3" "$1" tools/call "$2"; }
call() { mcp "$1" "{\"name\":\"$2\",\"arguments\":$3}" "${4:-}"; }
text() { json 'd["body"]["result"]["content"][0]["text"]' 2>/dev/null || echo "<no result>"; }
is_error() { json 'd["body"]["result"].get("isError", False)' 2>/dev/null || echo "<no result>"; }
status() { json 'd["status"]'; }
create() { call "$1" okf_create "{\"concept_id\":\"$2\",\"type\":\"Fact\",\"title\":\"$3\",\"description\":\"$3\",\"body\":\"$4\"}" "${5:-}"; }

ACME="$(org_token acme)"
BETA="$(org_token beta)"
READER="$(token "{\"iss\":\"$ISSUER\",\"aud\":\"http://okf.test\",\"azp\":\"console-knowledge\",\"okf_org\":\"console_reader\",\"realm_access\":{\"roles\":[\"knowledge-reader\"]}}")"
MARK="M$RANDOM$RANDOM"

echo "== who gets in"
WRONG_AUD="$(token "{\"iss\":\"$ISSUER\",\"aud\":\"http://other\",\"okf_org\":\"acme\"}")"
WRONG_ISS="$(token "{\"iss\":\"http://evil\",\"aud\":\"http://okf.test\",\"okf_org\":\"acme\"}")"
WRONG_KEY="$(token "{\"iss\":\"$ISSUER\",\"aud\":\"http://okf.test\",\"okf_org\":\"acme\"}" other)"
PERSON="$(token "{\"iss\":\"$ISSUER\",\"aud\":\"http://okf.test\",\"azp\":\"console\"}")"
for t in "$ACME" "$BETA" "$READER" "$WRONG_AUD" "$WRONG_ISS" "$WRONG_KEY" "$PERSON"; do
  [ "$(echo "$t" | tr -cd . | wc -c | tr -d ' ')" = 2 ] || { echo "fake issuer did not mint a token"; exit 1; }
done
SEARCH='{"query":"x"}'
check "no token -> 401" '[ "$(node "$ROOTDIR/test/mcp-call.mjs" "$HUB/mcp" - tools/list | status)" = 401 ]'
check "wrong audience -> 401" '[ "$(call "$WRONG_AUD" okf_search "$SEARCH" | status)" = 401 ]'
check "wrong issuer -> 401" '[ "$(call "$WRONG_ISS" okf_search "$SEARCH" | status)" = 401 ]'
check "unknown signing key -> 401" '[ "$(call "$WRONG_KEY" okf_search "$SEARCH" | status)" = 401 ]'
check "a person's token with no org claim -> 401" '[ "$(call "$PERSON" okf_search "$SEARCH" | status)" = 401 ]'
check "an org token works (control)" '[ "$(call "$ACME" okf_search "$SEARCH" | status)" = 200 ]'
check "MCP_TOKEN still serves the configured vault" '[ "$(call "$MCP_TOKEN" okf_search "{\"query\":\"architecture\"}" | is_error)" = False ]'

echo "== each org writes and reads its own bundle"
check "acme creates a concept, reported in its bundle" 'create "$ACME" facts/lab-door "Lab door" "Code $MARK" | text | grep -q "in orgs/oidc-acme$"'
check "acme reads it back" 'call "$ACME" okf_show "{\"concept_id\":\"facts/lab-door\"}" | text | grep -q "$MARK"'
check "acme finds it by search" 'call "$ACME" okf_search "{\"query\":\"lab door\"}" | text | grep -q "facts/lab-door"'
check "beta does not see it" '! call "$BETA" okf_search "{\"query\":\"lab door\"}" | text | grep -q "lab-door"'
check "beta naming acme bundle is denied" 'call "$BETA" okf_show "{\"concept_id\":\"facts/lab-door\",\"bundle\":\"orgs/oidc-acme\"}" | text | grep -q "^Access denied"'
check "beta naming bundle default is denied" 'call "$BETA" okf_search "{\"query\":\"x\",\"bundle\":\"default\"}" | text | grep -q "^Access denied"'
check "beta at ?bundle=orgs/oidc-acme -> 403" '[ "$(call "$BETA" okf_search "{\"query\":\"x\"}" "?bundle=orgs/oidc-acme" | status)" = 403 ]'
check "beta writes its own concept" '[ "$(create "$BETA" facts/lab-door "Beta door" "Beta only" | is_error)" = False ]'
check "acme still sees only its own (engine switched vaults cleanly)" 'call "$ACME" okf_show "{\"concept_id\":\"facts/lab-door\"}" | text | grep -q "$MARK"'
check "beta sees only its own" '! call "$BETA" okf_show "{\"concept_id\":\"facts/lab-door\"}" | text | grep -q "$MARK"'
check "the configured vault has neither" '! call "$MCP_TOKEN" okf_search "{\"query\":\"lab door\"}" | text | grep -q "lab-door"'

echo "== the reader"
check "reader reads acme via ?bundle=" 'call "$READER" okf_show "{\"concept_id\":\"facts/lab-door\"}" "?bundle=orgs/oidc-acme" | text | grep -q "$MARK"'
check "reader cannot write" 'create "$READER" facts/planted x x "?bundle=orgs/oidc-acme" | text | grep -q "^Access denied: okf_create"'
check "reader without ?bundle= sees no org's data" '! call "$READER" okf_search "{\"query\":\"lab door\"}" | text | grep -q "lab-door"'
SNAP="$(curl -s -H "Authorization: Bearer $READER" "$HUB/v1/snapshot?bundle=orgs/oidc-acme")"
check "snapshot holds acme's concept" 'echo "$SNAP" | json "d[\"files\"][\"facts/lab-door.md\"][\"content\"]" | grep -q "$MARK"'
check "snapshot carries index and log, not sync state" 'echo "$SNAP" | json "sorted(d[\"files\"])" | grep -q "log.md" && ! echo "$SNAP" | grep -q "\.okf/"'
check "snapshot of an unwritten bundle is empty" '[ "$(curl -s -H "Authorization: Bearer $READER" "$HUB/v1/snapshot?bundle=orgs/oidc-nobody" | json "len(d[\"files\"])")" = 0 ]'
check "beta cannot snapshot acme -> 403" '[ "$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $BETA" "$HUB/v1/snapshot?bundle=orgs/oidc-acme")" = 403 ]'
check "snapshot without a token -> 401" '[ "$(curl -s -o /dev/null -w "%{http_code}" "$HUB/v1/snapshot?bundle=orgs/oidc-acme")" = 401 ]'

echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
