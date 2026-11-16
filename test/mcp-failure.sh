#!/usr/bin/env bash
# Failure paths through VaultEngine.callTool, using test-only fault injection.
set -euo pipefail
ROOTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0 fail=0
ok() { echo "  PASS $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL $1"; fail=$((fail + 1)); }
call() { node "$ROOTDIR/test/mcp-call.mjs" "$HUB/mcp" "$MCP_TOKEN" tools/call "{\"name\":\"$1\",\"arguments\":$2}"; }
result_field() { python3 -I -c 'import json,sys; d=json.load(sys.stdin); r=(d.get("body") or {}).get("result") or {}; print(json.dumps({"isError": r.get("isError", False), "text": " ".join(c.get("text","") for c in r.get("content") or [])}))'; }

echo "== commit fails before reaching the hub (fault: commit-fail-once)"
EXTRA_DEV_VARS="TEST_FAULTS=commit-fail-once" MCP_TEST_PORT=8791 source "$ROOTDIR/test/mcp-env.sh"
R="$(call okf_create '{"concept_id":"architecture/lost-one","type":"Fact","title":"Lost One","description":"Should not be saved."}' | result_field)"
echo "$R" | grep -q '"isError": true' && echo "$R" | grep -q 'Not saved' && ok "agent is told it was not saved" || bad "agent is told it was not saved ($R)"
call okf_search '{"query":"lost one"}' | grep -q 'architecture/lost-one' && bad "discarded change is not served" || ok "discarded change is not served"
R="$(call okf_create '{"concept_id":"architecture/lost-one","type":"Fact","title":"Lost One","description":"Saved on retry."}' | result_field)"
echo "$R" | grep -q '"isError": false' && ok "retry succeeds" || bad "retry succeeds ($R)"
PULLED="$WORK/pulled"; mkdir -p "$PULLED" && cp "$SRC/.okf-vault.json" "$PULLED/" && "$OKF" hub pull -hub "$HUB" "$PULLED" > /dev/null
grep -q 'Saved on retry.' "$PULLED/architecture/lost-one.md" && ok "retried change reached the hub" || bad "retried change reached the hub"
stop_dev; trap - EXIT

echo "== commit lands, then the confirmation fails (fault: commit-lands-then-fail-once)"
EXTRA_DEV_VARS="TEST_FAULTS=commit-lands-then-fail-once" MCP_TEST_PORT=8792 source "$ROOTDIR/test/mcp-env.sh"
R="$(call okf_create '{"concept_id":"architecture/landed","type":"Fact","title":"Landed","description":"Saved despite the error."}' | result_field)"
echo "$R" | grep -q 'Nothing was written' && bad "agent is not told 'nothing was written'" || ok "agent is not told 'nothing was written'"
echo "$R" | grep -q '"isError": false' && ok "reported as saved" || bad "reported as saved ($R)"
PULLED="$WORK/pulled"; mkdir -p "$PULLED" && cp "$SRC/.okf-vault.json" "$PULLED/" && "$OKF" hub pull -hub "$HUB" "$PULLED" > /dev/null
[ -f "$PULLED/architecture/landed.md" ] && ok "change is on the hub" || bad "change is on the hub"

echo "passed: $pass  failed: $fail"; [ "$fail" -eq 0 ]
