#!/usr/bin/env bash
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${OMO_AGENT_DIR:-$HOME/.omo/agent}"

usage() {
  echo "usage: $0 [--dry-run]"
  echo "  checks, tests, and copies agent/extensions/omo-ledger-pane.js and agent/ledger/"
  echo "  into \$OMO_AGENT_DIR (default ~/.omo/agent), then run /reload in omo."
  exit "${1:-0}"
}

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help) usage 0 ;;
    *) echo "unknown arg: $arg" >&2; usage 1 ;;
  esac
done

node --check "$SRC/agent/extensions/omo-ledger-pane.js"
node --check "$SRC/agent/ledger/extension.mjs"
node --check "$SRC/agent/ledger/stats.mjs"
node --check "$SRC/agent/ledger/stats.test.mjs"
node --check "$SRC/agent/ledger/viewer.mjs"
echo "syntax: OK"
node --test "$SRC/agent/ledger/"

if [ "$DRY_RUN" = 1 ]; then
  echo "would copy:"
  echo "  $SRC/agent/extensions/omo-ledger-pane.js -> $DEST/extensions/omo-ledger-pane.js"
  echo "  $SRC/agent/ledger/ (minus *.test.mjs) -> $DEST/ledger/"
  exit 0
fi

mkdir -p "$DEST/extensions" "$DEST/ledger"
cp "$SRC/agent/extensions/omo-ledger-pane.js" "$DEST/extensions/omo-ledger-pane.js"
cp "$SRC/agent/ledger/extension.mjs" "$SRC/agent/ledger/stats.mjs" "$SRC/agent/ledger/viewer.mjs" "$DEST/ledger/"
echo "installed. run /reload in omo, then /ledger to toggle the pane."
