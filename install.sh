#!/usr/bin/env bash
# Installs the omo-herdr-ledger pane without checking out the repo first.
#
#   curl -fsSL https://raw.githubusercontent.com/markusreil/omo-herdr-ledger/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/markusreil/omo-herdr-ledger/main/install.sh | bash -s -- --dry-run
set -euo pipefail

REPO="https://github.com/markusreil/omo-herdr-ledger.git"
CLONE_DIR="${LEDGER_CLONE_DIR:-/tmp/omo-herdr-ledger}"
BRANCH="${LEDGER_BRANCH:-main}"

if [ -d "$CLONE_DIR/.git" ]; then
  git -C "$CLONE_DIR" fetch -q origin "$BRANCH"
  git -C "$CLONE_DIR" checkout -q "$BRANCH"
  git -C "$CLONE_DIR" reset -q --hard "origin/$BRANCH"
else
  rm -rf "$CLONE_DIR"
  git clone -q --depth 1 --branch "$BRANCH" "$REPO" "$CLONE_DIR"
fi

exec "$CLONE_DIR/bin/sync.sh" "$@"
