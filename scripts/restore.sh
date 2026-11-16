#!/usr/bin/env bash
# Restore one vault from a backup copy of the okf-hub R2 bucket into a hub.
#
#   OKF_HUB_TOKEN=... bash scripts/restore.sh <backup-dir> <vault-id> <hub-url>
#
# <backup-dir> is the folder rclone copies the bucket into (it contains
# vaults/<vault-id>/blobs/ and vaults/<vault-id>/refs/). Blobs are re-uploaded
# through the hub API, which re-verifies every SHA-256, then the head is set to
# the newest ref with the normal compare-and-swap. The hub's own Durable Object
# and R2 state are rebuilt as a side effect, including a fresh ref.
#
# Safe by default: it refuses to touch a hub whose head is already set to a
# different commit (that hub holds newer or unrelated data).
set -euo pipefail

BACKUP="${1:?usage: restore.sh <backup-dir> <vault-id> <hub-url>}"
VAULT="${2:?vault id (v_ + 32 hex)}"
HUB="${3:?hub url}"
: "${OKF_HUB_TOKEN:?set OKF_HUB_TOKEN to the hub bearer token}"

SRC="$BACKUP/vaults/$VAULT"
[ -d "$SRC/blobs" ] && [ -d "$SRC/refs" ] || { echo "restore: $SRC has no blobs/ and refs/" >&2; exit 1; }

AUTH="Authorization: Bearer $OKF_HUB_TOKEN"
API="$HUB/api/v1/vaults/$VAULT"

LATEST_REF="$(ls "$SRC/refs" | sort | tail -1)"
TARGET="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["commit"])' "$SRC/refs/$LATEST_REF")"
[ -f "$SRC/blobs/$TARGET" ] || { echo "restore: newest ref points at $TARGET, which is missing from the backup" >&2; exit 1; }
echo "restore: newest ref $LATEST_REF -> commit $TARGET"

CURRENT="$(curl -sf -H "$AUTH" "$API/head" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["head_commit"])')"
if [ "$CURRENT" = "$TARGET" ]; then
  echo "restore: hub already at $TARGET; nothing to do"
  exit 0
fi
if [ -n "$CURRENT" ]; then
  echo "restore: hub head is $CURRENT, not empty; refusing to overwrite (restore into a fresh hub or vault)" >&2
  exit 1
fi

# Upload only what the hub is missing, in batches the hub accepts.
HASHES_FILE="$(mktemp)"
trap 'rm -f "$HASHES_FILE"' EXIT
ls "$SRC/blobs" > "$HASHES_FILE"
TOTAL="$(wc -l < "$HASHES_FILE" | tr -d ' ')"
MISSING="$(python3 -I - "$HASHES_FILE" "$API/blobs/check-missing" "$OKF_HUB_TOKEN" <<'PY'
import json, sys, urllib.request
hashes = open(sys.argv[1]).read().split()
missing = []
for i in range(0, len(hashes), 5000):
    req = urllib.request.Request(sys.argv[2], data=json.dumps({"hashes": hashes[i:i+5000]}).encode(),
        headers={"Authorization": "Bearer " + sys.argv[3], "Content-Type": "application/json"})
    missing += json.load(urllib.request.urlopen(req)).get("missing") or []
print("\n".join(missing))
PY
)"
UPLOADED=0
for h in $MISSING; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "$AUTH" -H 'Content-Type: application/octet-stream' \
    --data-binary "@$SRC/blobs/$h" "$API/blobs/$h")"
  [ "$code" = 201 ] || { echo "restore: upload of $h failed (HTTP $code)" >&2; exit 1; }
  UPLOADED=$((UPLOADED + 1))
done
echo "restore: $TOTAL blobs in backup, uploaded $UPLOADED"

code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"new_commit_hash\":\"$TARGET\",\"expected_previous_head\":null}" "$API/commit")"
[ "$code" = 200 ] || { echo "restore: setting head failed (HTTP $code)" >&2; exit 1; }
echo "restore: head set to $TARGET. Run 'okf hub pull' to verify."
