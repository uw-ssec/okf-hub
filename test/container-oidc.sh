#!/usr/bin/env bash
# End to end against the compose stack (compose.yml): OIDC sign-in and named bundles. Each organization's
# token reaches its own bundle only, a reader role reads every bundle and writes none, bundles stay apart while
# one engine serves them all, the container restarts clean, and a hub whose database role does not exist yet
# serves `starting` until it does, then turns ready.
set -euo pipefail
ROOTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="${COMPOSE:-docker compose}"
pass=0 fail=0
ok() { echo "  PASS $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL $1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
json() { python3 -I -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
HUB="http://127.0.0.1:${HUB_PORT:-57878}"
FAKE="http://127.0.0.1:${FAKE_OIDC_PORT:-58792}"
# These must match OIDC_ISSUER and OIDC_AUDIENCE in compose.yml.
ISSUER="http://issuer.test/realms/test"

# /healthz answers `200 starting` before the stores are prepared, so wait for `ok`.
wait_ready() { for _ in $(seq "${2:-60}"); do [ "$(curl -s "$1/healthz")" = ok ] && return 0; sleep 1; done; return 1; }
wait_ready "$HUB" || { echo "hub did not become healthy"; exit 1; }

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

echo "== restart"
$COMPOSE -f "$ROOTDIR/compose.yml" restart hub >/dev/null 2>&1
wait_ready "$HUB" || true
check "the container restarts clean" 'call "$ACME" okf_show "{\"concept_id\":\"facts/lab-door\"}" | text | grep -q "$MARK"'

echo "== a hub whose database role does not exist yet (a first deploy)"
# A second hub on its own role, database and blob container; the role and database are created only after it starts.
LATE_NAME=okf-hub-e2e-late
LATE="http://127.0.0.1:${LATE_HUB_PORT:-57879}"
LATE_PW="late-$MARK"
psql_admin() { $COMPOSE -f "$ROOTDIR/compose.yml" exec -T postgres psql -q -U postgres -v ON_ERROR_STOP=1 "$@" >/dev/null; }
docker rm -f "$LATE_NAME" >/dev/null 2>&1 || true
trap 'docker rm -f "$LATE_NAME" >/dev/null 2>&1 || true' EXIT
psql_admin -c "SET client_min_messages = warning" -c "DROP DATABASE IF EXISTS okf_hub_late" -c "DROP ROLE IF EXISTS okf_hub_late"
$COMPOSE -f "$ROOTDIR/compose.yml" run -d --no-deps --name "$LATE_NAME" -p "${LATE_HUB_PORT:-57879}:7878" \
  -e "DATABASE_URL=postgres://okf_hub_late:$LATE_PW@postgres:5432/okf_hub_late" -e BLOB_CONTAINER=okf-hub-late hub >/dev/null
for _ in $(seq 60); do [ "$(curl -s "$LATE/healthz")" = starting ] && break; sleep 1; done
late_call() { node "$ROOTDIR/test/mcp-call.mjs" "$LATE/mcp" "$1" tools/call "$2"; }
check "healthz is 200 starting while the role is missing" '[ "$(curl -s -w " %{http_code}" "$LATE/healthz")" = "starting 200" ]'
check "an org token gets 503 starting" 'late_call "$ACME" "{\"name\":\"okf_search\",\"arguments\":$SEARCH}" | json "d[\"status\"], d[\"body\"][\"error\"]" | grep -qx "503 starting"'
check "no token still gets 401" '[ "$(node "$ROOTDIR/test/mcp-call.mjs" "$LATE/mcp" - tools/list | status)" = 401 ]'
check "the failed attempts are logged, without the password" 'docker logs "$LATE_NAME" 2>&1 | grep -q "\"okfHub\":\"init_retry\"" && ! docker logs "$LATE_NAME" 2>&1 | grep -q "$LATE_PW"'
psql_admin -c "CREATE ROLE okf_hub_late LOGIN PASSWORD '$LATE_PW'" -c "CREATE DATABASE okf_hub_late OWNER okf_hub_late"
check "it turns ready once the role exists" 'wait_ready "$LATE" 60'
check "ready is logged" 'docker logs "$LATE_NAME" 2>&1 | grep -q "\"okfHub\":\"ready\""'
check "an org call then works" 'late_call "$ACME" "{\"name\":\"okf_create\",\"arguments\":{\"concept_id\":\"facts/late\",\"type\":\"Fact\",\"title\":\"Late\",\"description\":\"Late\",\"body\":\"Late $MARK\"}}" | text | grep -q "in orgs/oidc-acme$" && late_call "$ACME" "{\"name\":\"okf_show\",\"arguments\":{\"concept_id\":\"facts/late\"}}" | text | grep -q "Late $MARK"'
docker rm -f "$LATE_NAME" >/dev/null 2>&1 || true

echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
