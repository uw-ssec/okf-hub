#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/mcp-env.sh"
ROOTDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0 fail=0
ok() { echo "  PASS $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL $1"; fail=$((fail + 1)); }
call() { node "$ROOTDIR/test/mcp-call.mjs" "$HUB/mcp" "$MCP_TOKEN" tools/call "{\"name\":\"$1\",\"arguments\":$2}"; }

echo "== a local device and the remote engine write to the same folder"
"$OKF" create architecture/local-beta "$SRC" --type Decision --title "Local Beta" --desc "Written on a Mac." > /dev/null
call okf_create '{"concept_id":"architecture/remote-gamma","type":"Decision","title":"Remote Gamma","description":"Written over MCP."}' > /dev/null
"$OKF" hub sync -hub "$HUB" -message "local beta" "$SRC" > /dev/null
[ -z "$(find "$SRC" -name '*.conflict-local*')" ] && ok "no conflict copies on the device" || bad "no conflict copies on the device"
grep -q 'remote-gamma.md' "$SRC/architecture/index.md" && grep -q 'local-beta.md' "$SRC/architecture/index.md" && ok "device index lists both" || bad "device index lists both"
call okf_search '{"query":"local beta"}' | grep -q 'local-beta' && ok "engine sees the device write" || bad "engine sees the device write"

echo "== five parallel remote creates in one folder"
for i in 1 2 3 4 5; do call okf_create "{\"concept_id\":\"architecture/par-$i\",\"type\":\"Fact\",\"title\":\"Par $i\",\"description\":\"Parallel $i.\"}" > "$WORK/par-$i.json" & done
wait
ok_count=0; for i in 1 2 3 4 5; do grep -q '"content"' "$WORK/par-$i.json" && ! grep -q '"isError":true' "$WORK/par-$i.json" && ok_count=$((ok_count + 1)); done
[ "$ok_count" = 5 ] && ok "all parallel creates succeed" || bad "all parallel creates succeed ($ok_count/5)"
PULLED="$WORK/pulled-par"; mkdir -p "$PULLED" && cp "$SRC/.okf-vault.json" "$PULLED/"
"$OKF" hub pull -hub "$HUB" "$PULLED" > /dev/null
n=0; for i in 1 2 3 4 5; do grep -q "par-$i.md" "$PULLED/architecture/index.md" && n=$((n + 1)); done
[ "$n" = 5 ] && ok "index lists all five" || bad "index lists all five ($n/5)"
VALID="$("$OKF" validate "$PULLED" --strict 2>&1 || true)"
echo "$VALID" | grep -q ' 0 error' && ok "bundle still validates (0 errors)" || bad "bundle still validates (0 errors)"

echo "passed: $pass  failed: $fail"; [ "$fail" -eq 0 ]
