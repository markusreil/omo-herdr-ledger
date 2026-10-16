# ledger TODO

## Repo move (revisit 2026-10-20)

- [ ] Graduate the pane out of agent-config into its own repo once the
  first real version settles (decided 2026-10-13: keep it here meanwhile).
- [ ] Switch chezmoi integration from raw-file externals to a git
  checkout of that repo (cheap today via `.chezmoiexternal.toml`
  `type = "file"` entries; a checkout gives versioning + offline use).
  Then drop the `herdr-panes/ledger/` copy here and point `bin/sync.sh`
  at the new location.

## Later

- [ ] Accumulation: aggregate the per-day `model-calls-YYYY-MM-DD.jsonl`
  archives (under `~/.omo/agent/ledger/`) into running totals —
  per-day/per-model/per-session token sums (input, output, cacheRead,
  cacheWrite) and cost. Decide surface: pane section vs. CLI vs. both.
- [ ] Midnight straddlers: a request starting before midnight and completing
  after leaves a dangling `done: false` entry in the old day's file (start
  and completion land in different files). Reconcile on read or backfill.
- [ ] Retention: decide how long to keep daily files (prune vs. keep all).
