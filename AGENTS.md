# omo-herdr-ledger

Ledger pane extension for omo/Herdr. See `README.md` for layout and use.

## Sync policy

This repo owns its footprint in two places — keep both in sync:

1. Live install: `~/.omo/agent` (via `./bin/sync.sh`).
2. Chezmoi source (`~/.local/share/chezmoi`): `run_install-ledger-pane.sh`
   curl-bashes this repo's `install.sh` on apply. Chezmoi rarely needs
   touching, but remember it exists — a fix pushed here only reaches
   `chezmoi apply` users once `main` has it.

Whenever changes are made here, ask the user whether they should be
promoted to live (`./bin/sync.sh`) and/or synced to chezmoi. Never
`chezmoi apply` before a fix is pushed — the pre-fix `install.sh` from
`main` would revert the live files.
