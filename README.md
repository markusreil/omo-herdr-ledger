# ledger

Herdr side-pane extension for omo: a live ledger of model requests —
per-prompt rows with payload size, latency, tokens and cost, an
expandable session card, child-task cards, and machine-wide daily totals.

## Layout

- `agent/extensions/omo-ledger-pane.js` — extension entry point (must be
  `omo-*`, never `herdr-*`: senpi treats a loaded `herdr-*.js` as a user
  Herdr reporter and skips its built-in agent presence).
- `agent/ledger/extension.mjs` — activation (Herdr session check),
  `/ledger` toggle command, open/close via `herdr pane` CLI.
- `agent/ledger/viewer.mjs` — what runs inside the pane (interactive
  request/task/session/overall view, refreshed every 2 seconds).
- `bin/sync.sh` — syntax-checks and copies into `$OMO_AGENT_DIR`
  (default `~/.omo/agent`).

## Protocol (copied from omo-herdr-dag)

- Activates only inside Herdr: `HERDR_ENV=1`, `HERDR_PANE_ID` and
  `HERDR_SOCKET_PATH` set, live socket, resolvable `herdr` binary.
- Opens with `herdr pane split --current --direction right --ratio 0.65
  --no-focus`, titles with `herdr pane rename`, runs the viewer with
  `herdr pane run <id> -- ...`, closes with `herdr pane close <id>`.
- Open-pane state lives in `~/.omo/agent/ledger/state.json`, so a
  toggle finds its pane across reloads. Respects manual closure the same
  way: toggle reopens when the recorded pane is gone. If state is lost
  while a viewer still runs, toggle adopts it instead of opening a second.
- On `session_start` the extension reclaims a leftover pane automatically:
  if the recorded pane is still alive, its stale viewer is interrupted
  (`ctrl+c`) and the current viewer started in place — so forgetting to
  toggle off before `/reload` never strands a pane. Dead panes clear the
  state instead. Child (delegated) sessions never touch the pane.

## Install

No checkout needed — the installer clones to `$LEDGER_CLONE_DIR`
(default `/tmp/omo-herdr-ledger`, reused across runs) and syncs the
pane files into `$OMO_AGENT_DIR` (default `~/.omo/agent`):

```bash
curl -fsSL https://raw.githubusercontent.com/markusreil/omo-herdr-ledger/main/install.sh | bash
```

Preview only:

```bash
curl -fsSL https://raw.githubusercontent.com/markusreil/omo-herdr-ledger/main/install.sh | bash -s -- --dry-run
```

Overrides: `LEDGER_CLONE_DIR` (where to clone), `LEDGER_BRANCH`
(default `main`). `-q`/`--quiet` silences the happy path (full
output still on error), unless `CHEZMOI_VERBOSE` is set to a truthy
value (e.g. via `chezmoi apply -v`). Other args are forwarded to
`bin/sync.sh`.

Then `/reload` in omo and `/ledger` to toggle.

## Use (from a checkout)

```bash
./bin/sync.sh --dry-run
./bin/sync.sh
```

## Model-call hook

`extension.mjs` registers `pi.on('before_provider_request', …)` — fired on
every model request. Each hit appends `{ at, sessionId, taskId, model,
payloadBytes, prompt, done }` to the day's offline archive
`~/.omo/agent/ledger/model-calls-YYYY-MM-DD.jsonl` (one file per day,
kept for later analysis); `after_provider_response` flips `done` (recording
the HTTP status) and `message_end` patches the full provider `usage`
(including `cacheRead`/`cacheWrite`). The viewer shows today's file for
its own session only: inflight requests plus recent per-prompt groups.
See `TODO.md` for the planned accumulation work.
