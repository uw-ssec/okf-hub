#!/usr/bin/env bash
# OAuth integration tests: discovery, the legacy token, and (Task 5+) the real
# authorization flow against a fake GitHub, with policy enforcement.
set -euo pipefail
ROOTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0 fail=0
ok() { echo "  PASS $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL $1"; fail=$((fail + 1)); }
mcp() { node "$ROOTDIR/test/mcp-call.mjs" "$HUB/mcp" "$1" "$2" "${3:-}"; }
json() { python3 -I -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
tools_of() { mcp "$1" tools/list | json '" ".join(sorted(t["name"] for t in d["body"]["result"]["tools"]))' 2>/dev/null || echo none; }
SIX="okf_create okf_relate okf_search okf_show okf_update okf_validate"
FAKE_PORT="${FAKE_GITHUB_PORT:-8791}"
FAKE="http://127.0.0.1:$FAKE_PORT"
node "$ROOTDIR/test/fake-github.mjs" "$FAKE_PORT" 4242 & FAKE_PID=$!
export EXTRA_VARS="GITHUB_CLIENT_ID:fake-client ALLOWED_GITHUB_USER_ID:4242 GITHUB_BASE_URL:$FAKE"
export EXTRA_DEV_VARS="GITHUB_CLIENT_SECRET=fake-secret
COOKIE_SECRET=$(openssl rand -hex 32)"
source "$ROOTDIR/test/mcp-env.sh"
trap 'stop_dev; kill "$FAKE_PID" 2>/dev/null || true' EXIT
oc() { node "$ROOTDIR/test/oauth-client.mjs" "$@"; }
as_user() { curl -s "$FAKE/_set_user?id=$1" > /dev/null; }
register() { oc register "$HUB" "$1" | json 'd["client_id"]'; }
call() { mcp "$1" tools/call "{\"name\":\"$2\",\"arguments\":$3}"; }

echo "== discovery"
curl -s -D "$WORK/h401" -o /dev/null -X POST "$HUB/mcp"
grep -qi '^www-authenticate:.*resource_metadata' "$WORK/h401" && ok "401 points at resource metadata" || bad "401 points at resource metadata"
[ "$(curl -s "$HUB/.well-known/oauth-protected-resource/mcp" | json 'd["resource"]')" = "$HUB/mcp" ] && ok "protected resource metadata" || bad "protected resource metadata"
AS="$(curl -s "$HUB/.well-known/oauth-authorization-server")"
[ "$(echo "$AS" | json 'd.get("client_id_metadata_document_supported")')" = True ] && ok "CIMD advertised" || bad "CIMD advertised"
[ "$(echo "$AS" | json 'd.get("registration_endpoint","")')" = "$HUB/register" ] && ok "DCR endpoint advertised" || bad "DCR endpoint advertised"
[ "$(echo "$AS" | json 'd.get("authorization_response_iss_parameter_supported")')" = True ] && ok "iss in responses" || bad "iss in responses"
[ "$(curl -s "$HUB/healthz")" = ok ] && ok "healthz" || bad "healthz"

echo "== legacy token"
[ "$(tools_of "$MCP_TOKEN")" = "$SIX" ] && ok "MCP_TOKEN still works (six tools)" || bad "MCP_TOKEN still works"
[ "$(mcp wrong-token tools/list | json 'd["status"]')" = 401 ] && ok "wrong token -> 401" || bad "wrong token -> 401"
mcp "$MCP_TOKEN" initialize '{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}' | grep -q 'Search before creating' && ok "server instructions carry the bundle rules" || bad "server instructions carry the bundle rules"

echo "== full grant"
FULL_ID="$(register test-full)"
FULL="$(oc authorize "$HUB" "$FULL_ID" full "" approve)"
FULL_TOKEN="$(echo "$FULL" | json 'd.get("access_token","")')"
[ -n "$FULL_TOKEN" ] && ok "authorize -> GitHub -> token" || bad "authorize -> GitHub -> token ($FULL)"
[ "$(echo "$FULL" | json 'd.get("iss")')" = "$HUB" ] && ok "iss on the authorization response" || bad "iss on the authorization response"
[ "$(tools_of "$FULL_TOKEN")" = "$SIX" ] && ok "full grant lists six tools" || bad "full grant lists six tools"
call "$FULL_TOKEN" okf_search '{"query":"architecture","limit":3}' | grep -q 'architecture/' && ok "full grant can search" || bad "full grant can search"
NEW_TOKEN="$(oc refresh "$HUB" "$FULL_ID" "$(echo "$FULL" | json 'd["refresh_token"]')" | json 'd.get("access_token","")')"
[ "$(tools_of "$NEW_TOKEN")" = "$SIX" ] && ok "refresh token issues a working access token" || bad "refresh token issues a working access token"

echo "== read grant"
READ_TOKEN="$(oc authorize "$HUB" "$(register test-read)" read "" approve | json 'd.get("access_token","")')"
[ "$(tools_of "$READ_TOKEN")" = "okf_search okf_show okf_validate" ] && ok "read grant lists three tools" || bad "read grant lists three tools"
call "$READ_TOKEN" okf_create '{"concept_id":"notes/x","type":"note","title":"x","description":"x"}' | grep -qi 'not found\|read only' && ok "read grant can't write" || bad "read grant can't write"

echo "== hidden folder"
EX_TOKEN="$(oc authorize "$HUB" "$(register test-exclude)" full "architecture/" approve | json 'd.get("access_token","")')"
call "$EX_TOKEN" okf_show '{"concept_id":"./architecture//layers"}' | grep -q 'Refused by access policy' && ok "show into hidden folder refused" || bad "show into hidden folder refused"
call "$EX_TOKEN" okf_relate '{"source_id":"roadmap/milestones","target_id":"architecture/layers"}' | grep -q 'Refused by access policy' && ok "relate into hidden folder refused" || bad "relate into hidden folder refused"
SHOW="$(call "$EX_TOKEN" okf_show '{"concept_id":"roadmap/milestones"}')"
echo "$SHOW" | grep -q 'roadmap/milestones' && ! echo "$SHOW" | grep -q 'architecture/' && ok "show strips links into hidden folder" || bad "show strips links into hidden folder"
SEARCH="$(call "$EX_TOKEN" okf_search '{"query":"architecture","limit":3}')"
[ "$(echo "$SEARCH" | json 'len(d["body"]["result"]["structuredContent"]["results"])')" = 3 ] && ! echo "$SEARCH" | grep -q '"concept_id\\":\\"architecture/' && ok "search hides folder, keeps count" || bad "search hides folder, keeps count"
VALIDATE="$(call "$EX_TOKEN" okf_validate '{"strict":true}')"
echo "$VALIDATE" | grep -q 'concept_count' && ! echo "$VALIDATE" | grep -q 'architecture/' && ok "validate hides folder" || bad "validate hides folder"

echo "== refusals"
DENY="$(oc authorize "$HUB" "$(register test-deny)" read "" deny)"
[ "$(echo "$DENY" | json 'd["status"]+" "+str(d.get("error"))')" = "denied access_denied" ] && ok "Deny -> access_denied" || bad "Deny -> access_denied ($DENY)"
as_user 999
WRONG="$(oc authorize "$HUB" "$(register test-wrong)" full "" approve)"
[ "$(echo "$WRONG" | json 'd["status"]+" "+str(d.get("code"))')" = "page 403" ] && ok "wrong GitHub account refused" || bad "wrong GitHub account refused ($WRONG)"
as_user deny
GH="$(oc authorize "$HUB" "$(register test-ghdeny)" full "" approve)"
[ "$(echo "$GH" | json 'd["status"]+" "+str(d.get("error"))')" = "denied access_denied" ] && ok "GitHub decline -> access_denied" || bad "GitHub decline -> access_denied ($GH)"
as_user 4242
[ "$(oc replay "$HUB" "$(register test-replay)" | json 'd["first"]+" "+str(d["replay"])')" = "ok 400" ] && ok "replayed callback -> 400" || bad "replayed callback -> 400"
oc authorize "$HUB" "$(register test-badexclude)" full "../x" approve | grep -q '"code": *400\|"code":400' && ok "bad hidden folder -> 400" || bad "bad hidden folder -> 400"
PAGE="$(oc consent-page "$HUB" "$(register '<img src=x onerror=alert(1)>')")"
echo "$PAGE" | grep -q '&#60;img' && ! echo "$PAGE" | grep -q '<img src=x' && ok "client name escaped" || bad "client name escaped"
echo "== grants page"
as_user 999
[ "$(oc grants-status "$HUB" | json 'd["status"]')" = 403 ] && ok "grants page refuses other GitHub accounts" || bad "grants page refuses other GitHub accounts"
as_user 4242
[ "$(oc grants-status "$HUB" | json 'd["status"]')" = 200 ] && ok "grants page after GitHub sign-in" || bad "grants page after GitHub sign-in"
[ "$(oc revoke "$HUB" test-full | json 'd["revoked"]')" -ge 1 ] && ok "revoke from grants page" || bad "revoke from grants page"
[ "$(mcp "$NEW_TOKEN" tools/list | json 'd["status"]')" = 401 ] && ok "revoked grant's token -> 401" || bad "revoked grant's token -> 401"
[ "$(tools_of "$READ_TOKEN")" = "okf_search okf_show okf_validate" ] && ok "other grants unaffected" || bad "other grants unaffected"
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -d 'grant_id=x&csrf=x' "$HUB/grants/revoke")" = 302 ] && ok "revoke without session -> sign-in redirect" || bad "revoke without session -> sign-in redirect"
echo "passed: $pass  failed: $fail"; [ "$fail" -eq 0 ]
