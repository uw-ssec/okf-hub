#!/usr/bin/env bash
# Smoke test: reach the okf tools through LiteLLM's MCP gateway.
#   1. the hub answers on its own
#   2. LiteLLM lists the six okf_* tools from the hub
#   3. an okf_search called through LiteLLM returns hits from the sample bundle
set -euo pipefail
LITELLM="${LITELLM_URL:-http://127.0.0.1:4000}"
HUB="${HUB_URL:-http://127.0.0.1:8787}"
KEY="${LITELLM_MASTER_KEY:-sk-prototype-master-key}"
QUERY="${1:-architecture}"
pass=0 fail=0
ok() { echo "  PASS $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL $1"; fail=$((fail + 1)); }

echo "== hub"
curl -fs -o /dev/null "$HUB/healthz" && ok "hub is healthy" || bad "hub is healthy"

echo "== tools through LiteLLM"
tools="$(curl -fsS -m 120 "$LITELLM/mcp-rest/tools/list" -H "Authorization: Bearer $KEY")"
summary="$(printf '%s' "$tools" | python3 -I -c '
import json, sys
tools = json.load(sys.stdin).get("tools", [])
okf = sorted(t["name"] for t in tools if "okf_" in t["name"])
server = next((t.get("mcp_info", {}).get("server_id") or t.get("server_id") or "" for t in tools if "okf_search" in t["name"]), "")
print(len(okf)); print(server); print(next((n for n in okf if n.endswith("okf_search")), "")); print(", ".join(okf))')"
count="$(sed -n 1p <<<"$summary")"; server_id="$(sed -n 2p <<<"$summary")"; search_tool="$(sed -n 3p <<<"$summary")"
echo "  tools: $(sed -n 4p <<<"$summary")"
[ "$count" = 6 ] && ok "LiteLLM lists six okf tools" || bad "LiteLLM lists six okf tools (got $count)"

echo "== okf_search through LiteLLM (query: $QUERY)"
body="$(python3 -I -c 'import json,sys; print(json.dumps({"server_id": sys.argv[1], "name": sys.argv[2], "arguments": {"query": sys.argv[3], "limit": 3}}))' "$server_id" "$search_tool" "$QUERY")"
result="$(curl -sS -m 120 -X POST "$LITELLM/mcp-rest/tools/call" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "$body")"
hits="$(printf '%s' "$result" | python3 -I -c '
import json, sys
d = json.load(sys.stdin)
if d.get("isError") or "content" not in d: print("ERR " + json.dumps(d)[:300]); sys.exit()
text = "".join(c.get("text", "") for c in d["content"])
try:
    r = json.loads(text); items = r.get("results", r) if isinstance(r, dict) else r
    print("\n".join(str(i.get("id") or i.get("concept_id") or i)[:100] for i in items[:3]))
except ValueError: print(text[:300])')"
echo "$hits" | sed 's/^/  /'
[ -n "$hits" ] && [ "${hits#ERR}" = "$hits" ] && ok "okf_search returned results" || bad "okf_search returned results"

echo "passed=$pass failed=$fail"
[ "$fail" = 0 ]
