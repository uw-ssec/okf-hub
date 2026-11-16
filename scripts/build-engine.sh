#!/usr/bin/env bash
# Build the okf Wasm engine, derivekey, and the tool schemas from the uw-ssec
# fork. OKF_FORK_DIR=<path> builds from a local checkout (development);
# otherwise the commit in engine/FORK_COMMIT is checked out into .work/fork.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORK_DIR="${OKF_FORK_DIR:-}"
if [ -z "$FORK_DIR" ]; then
  FORK_DIR="$ROOT/.work/fork"
  COMMIT="$(tr -d '[:space:]' < "$ROOT/engine/FORK_COMMIT")"
  [ -d "$FORK_DIR/.git" ] || git clone -q https://github.com/uw-ssec/okf-agent-memory.git "$FORK_DIR"
  git -C "$FORK_DIR" fetch -q origin
  git -C "$FORK_DIR" -c advice.detachedHead=false checkout -q "$COMMIT"
fi
mkdir -p "$ROOT/src/engine" "$ROOT/.work/bin"
(cd "$FORK_DIR" && GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "$ROOT/src/engine/okf-engine.wasm" ./cmd/okf-wasm-engine)
(cd "$FORK_DIR" && go build -o "$ROOT/.work/bin/derivekey" ./cmd/okf-wasm-engine/derivekey)
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$ROOT/src/engine/wasm_exec.js"
cp "$FORK_DIR/pkg/okf/schemas/tools.json" "$ROOT/src/okf-tools.json"
echo "engine built from $FORK_DIR ($(git -C "$FORK_DIR" rev-parse --short HEAD))"
