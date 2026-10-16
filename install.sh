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

QUIET=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    -q | --quiet) QUIET=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done

# chezmoi apply -v exports CHEZMOI_VERBOSE: full output wins over -q.
case "${CHEZMOI_VERBOSE:-}" in
  "" | 0 | false) ;;
  *) QUIET=0 ;;
esac

if [ "$QUIET" = 0 ]; then
  exec "$CLONE_DIR/bin/sync.sh" "${ARGS[@]}"
fi

# Quiet: fully silent on success, full output on failure.
out="$(mktemp)"; err="$(mktemp)"
trap 'rm -f "$out" "$err"' EXIT INT TERM
if "$CLONE_DIR/bin/sync.sh" "${ARGS[@]}" >"$out" 2>"$err"; then
  exit 0
fi
cat "$out" "$err" >&2
exit 1
