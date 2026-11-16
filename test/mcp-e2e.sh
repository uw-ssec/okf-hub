#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/mcp-env.sh"
ROOTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0 fail=0
ok() { echo "  PASS $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL $1"; fail=$((fail + 1)); }
mcp() { node "$ROOTDIR/test/mcp-call.mjs" "$HUB/mcp" "$1" "$2" "${3:-}"; }
call() { mcp "$MCP_TOKEN" tools/call "{\"name\":\"$1\",\"arguments\":$2}"; }
# Same request against local `okf mcp` on the source bundle, for parity.
local_call() { printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" | "$OKF" mcp "$SRC" 2>/dev/null | head -1; }
# Canonical tool output: parse the JSON text okf returns and sort lists of strings
# (okf builds inbound/outbound lists from Go map iteration, so their order varies).
text_of() { python3 -I -c '
import json, sys
def canon(v):
    if isinstance(v, dict): return {k: canon(x) for k, x in v.items()}
    if isinstance(v, list):
        v = [canon(x) for x in v]
        return sorted(v) if all(isinstance(x, str) for x in v) else v
    return v
d = json.loads(sys.stdin.read()); r = d.get("body", d) if isinstance(d.get("body", d), dict) else {}
content = r.get("result", {}).get("content")
if not content: print("null"); sys.exit()
out = []
for c in content:
    try: out.append(canon(json.loads(c.get("text", ""))))
    except ValueError: out.append(c.get("text"))
print(json.dumps(out, sort_keys=True))'; }
status_of() { python3 -I -c 'import json,sys; print(json.load(sys.stdin)["status"])'; }

echo "== auth"
[ "$(mcp - tools/list | status_of)" = 401 ] && ok "missing token -> 401" || bad "missing token -> 401"
[ "$(mcp wrong tools/list | status_of)" = 401 ] && ok "wrong token -> 401" || bad "wrong token -> 401"

echo "== tools"
TOOLS="$(mcp "$MCP_TOKEN" tools/list | python3 -I -c 'import json,sys; t=json.load(sys.stdin)["body"]["result"]["tools"]; print(" ".join(sorted(x["name"] for x in t)), "|", any("bundle" in x["inputSchema"].get("properties",{}) for x in t))' 2>/dev/null || echo "no tools")"
[ "$TOOLS" = "okf_create okf_relate okf_search okf_show okf_update okf_validate | False" ] && ok "six tools, no bundle arg" || bad "six tools, no bundle arg ($TOOLS)"

echo "== parity with local okf mcp"
parity() {
  local remote local_
  remote="$(call "$1" "$2" | text_of)"; local_="$(local_call "$1" "$2" | text_of)"
  [ "$remote" != "null" ] && [ "$remote" = "$local_" ] && ok "$1 matches local" || bad "$1 matches local"
}
parity okf_search '{"query":"vault sync","limit":3}'
parity okf_show '{"concept_id":"architecture/zero-knowledge-vault-sync"}'
# A rejection must be an MCP-level error inside a 200 response, not an HTTP failure.
mcp_error() { python3 -I -c 'import json,sys; d=json.load(sys.stdin); b=d.get("body") if isinstance(d.get("body"),dict) else {}; print("yes" if d["status"]==200 and ("error" in b or b.get("result",{}).get("isError") is True) else "no")'; }
[ "$(call okf_nope '{}' | mcp_error)" = yes ] && ok "unknown tool -> MCP error" || bad "unknown tool -> MCP error"
[ "$(call okf_search '{"limit":"ten"}' | mcp_error)" = yes ] && ok "bad argument type -> MCP error" || bad "bad argument type -> MCP error"

echo "== writes reach the hub with okf bookkeeping"
succeeded() { grep -q '"content"' <<<"$1" && ! grep -q '"isError":true' <<<"$1"; }
R="$(call okf_create '{"concept_id":"architecture/remote-alpha","type":"Decision","title":"Remote Alpha","description":"Created over MCP."}')"; succeeded "$R" && ok "create" || bad "create"
R="$(call okf_update '{"concept_id":"architecture/remote-alpha","description":"Updated over MCP."}')"; succeeded "$R" && ok "update" || bad "update"
R="$(call okf_relate '{"source_id":"architecture/remote-alpha","target_id":"architecture/zero-knowledge-vault-sync","description":"Built on it."}')"; succeeded "$R" && ok "relate" || bad "relate"
call okf_validate '{"strict":true}' | grep -q '\\"errors\\":\[\]' && ok "validate over MCP (no errors)" || bad "validate over MCP (no errors)"
PULLED="$WORK/pulled"; mkdir -p "$PULLED" && cp "$SRC/.okf-vault.json" "$PULLED/"
"$OKF" hub pull -hub "$HUB" "$PULLED" > /dev/null
grep -q 'Updated over MCP.' "$PULLED/architecture/remote-alpha.md" && ok "update landed" || bad "update landed"
grep -q 'zero-knowledge-vault-sync.md' "$PULLED/architecture/remote-alpha.md" && ok "relation landed" || bad "relation landed"
grep -q 'remote-alpha.md' "$PULLED/architecture/index.md" && ok "index updated" || bad "index updated"
VALID="$("$OKF" validate "$PULLED" --strict 2>&1 || true)"
echo "$VALID" | grep -q ' 0 error' && ok "pulled bundle validates (0 errors)" || bad "pulled bundle validates (0 errors)"

echo "passed: $pass  failed: $fail"; [ "$fail" -eq 0 ]
