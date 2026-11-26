# herdr-llama-swap

A [Herdr](https://herdr.dev) plugin that monitors and controls a **remote** [llama-swap](https://github.com/mostlygeek/llama-swap) model server over its HTTP API. It shows which model is loaded, what phase it is in (prompt processing, decoding, loading), tokens/sec, context usage, GPU/VRAM and host RAM, and lets you unload, pause, resume or switch models.

Pure Node.js (>= 22), standard library only: no `npm install`, no build step.

## Architecture

- **Daemon** (`src/daemon.js`): started by the plugin's `[[startup]]` hook. Polls the API every `pollMs`, writes `state.json` atomically, reports workspace tokens to Herdr (`herdr workspace report-metadata --source llama-swap`) and sends Herdr notifications on transitions (model changed, went offline / came back, model unloaded or crashed, new error text). Backs off exponentially to 30 s after 3 consecutive failures.
- **Dashboard** (`src/dashboard.js`): a dependency-free ANSI TUI shown in a Herdr popup pane. It polls the API itself and does not need the daemon.
- **CLI** (`src/cli.js`): scriptable status and control commands.
- **Pure core** (`src/lib/state.js`): turns raw API responses into one state object; fully unit-tested with a mock server.

## Install

```sh
herdr plugin install joesteffee/herdr-llama-swap --yes
# or, from a checkout:
herdr plugin link .
```

### Keybinding

Keybindings live in the user config, not the plugin manifest. Add this to ~/.config/herdr/config.toml:

```toml
[[keys.command]]
key = "alt+s"
type = "plugin_action"
command = "llama-swap.open-dashboard"
description = "Open llama-swap dashboard (alt+s)"
```

then run `herdr server reload-config` (verify with `herdr config check`). You can also invoke the action `llama-swap Dashboard` from the command palette or run `bin/herdr-llama-swap`.

### Popup placement

`placement = "popup"` in `herdr-plugin.toml` is the only place it takes effect: the v0.9.5 CLI rejects `--placement popup` (possible values are overlay, split, tab, zoomed), so `bin/herdr-llama-swap` opens the pane with no --placement flag and lets the manifest decide. Only one popup can be open at a time (`ui_busy` error).

## Configuration

Endpoint resolution order: `--url`, `$LLAMASWAP_URL`, `$HERDR_PLUGIN_CONFIG_DIR/config.json`, default `https://llama-swap.int.somewhat.me`.

```json
{ "url": "https://llama-swap.example.lan", "pollMs": 2000 }
```

`pollMs` defaults to 2000 and is clamped to a minimum of 500 (also `$LLAMASWAP_POLL_MS`).

| Variable | Purpose |
|---|---|
| `LLAMASWAP_URL` | endpoint override |
| `HERDR_PLUGIN_CONFIG_DIR` | directory containing `config.json` |
| `HERDR_PLUGIN_STATE_DIR` | state dir (fallback `${XDG_STATE_HOME:-~/.local/state}/herdr-llama-swap`) holding `state.json`, `daemon.pid`, `daemon.log` |
| `HERDR_BIN_PATH` | herdr binary (default `herdr`) |
| `HERDR_WORKSPACE_ID` | workspace for token reports (else the focused workspace is looked up) |

## Commands

```
herdr-llama-swap status [--json]      one poll, human-readable or JSON (`once` is an alias)
herdr-llama-swap models               list models and load state
herdr-llama-swap dashboard [--once]   live TUI; snapshot with --once or when not a TTY
herdr-llama-swap open [--target workspace|split|popup]   open the live dashboard in Herdr (default: workspace)
herdr-llama-swap daemon start|stop|status|run|once
herdr-llama-swap unload <id> [--yes]  refuses ids that are not currently loaded
herdr-llama-swap pause|resume [--yes]
Global: --url URL  --json  --yes  --help  --version
```

Run as `node src/cli.js <command>`. Exit codes: 0 ok, 1 failure, 2 usage error. `unload`, `pause` and `resume` always print what they will do and need `--yes` when stdin is not a TTY.

### Dashboard keys

`r` refresh, `l` switch model, `u` unload (confirm), `p` pause, `R` resume, `q` quit. Actions are disabled while the server is offline.

**Switch** is labelled "switch (warm-up request)": llama-swap has no explicit load endpoint, so the dashboard sends `POST /v1/completions` with `{"model":"<id>","prompt":"","max_tokens":1}`, which makes llama-swap swap the model in on demand. A second confirmation is required, and the request can take minutes while the model loads.

### Sample dashboard

```
llama-swap  https://llama-swap.int.somewhat.me  [ONLINE]

Model   inkling-2-mini  Inkling-2-Mini-GGUF (Q4, 1x128k, best-speed)
Phase   prompt
Decode  - tok/s    Prompt  - tok/s
Context █████████░░░░░░░░░░░░░░░ 50159/131072 (38.3%)  cache 12205  decoded 0

GPU     util 96%  temp 52°C  fan 51%  power 0W
VRAM    ████████████████████░░░░ 6.8/8.0 GiB
RAM     ██████░░░░░░░░░░░░░░░░░░ 66.7/251.6 GiB  cpu 40%
TTL     15m00s idle timeout
```

(In the live TUI the TTL line counts down while the model is idle; the countdown is estimated locally because llama-swap only reports the configured TTL.)

## API endpoints used

| Endpoint | Use |
|---|---|
| `GET /health` | online/offline |
| `GET /v1/models` | model list, loaded/unloaded status |
| `GET /running` | loaded model, state, TTL, proxy port |
| `GET /metrics` | Prometheus: GPU util/VRAM/temp/fan/power, host RAM, per-core CPU (averaged) |
| `GET /upstream/<model>/slots` | llama.cpp slot counters, only while that model is loaded |
| `POST /api/models/unload/<id>`, `/api/models/pause`, `/api/models/resume` | control (GET returns 405) |
| `POST /v1/completions` | warm-up request for switching |

`/upstream/<model>/metrics` returns **501** and is not used. Tokens/sec are **derived from slot counters** (`n_decoded`, `n_prompt_tokens_processed` deltas between polls) because llama-server runs without `--metrics`. Rates are `-` on the first sample, after a counter reset, or when idle without change.

## Security

The llama-swap endpoint has **no authentication**; anyone on the network can unload, pause, or send requests. Keep it on a trusted LAN or behind a reverse proxy with auth. The plugin sends no credentials and uses plain HTTP(S) as configured.

## Troubleshooting

- Plugin logs: `herdr plugin log list --plugin llama-swap`
- Daemon: `node src/cli.js daemon status`; log at `<state dir>/daemon.log`
- State: `<state dir>/state.json` (default `~/.local/state/herdr-llama-swap/state.json`)
- Quick check: `node src/cli.js status` (exit 1 means offline)
- No workspace tokens: set `HERDR_WORKSPACE_ID` or ensure `herdr` is on `PATH` / `HERDR_BIN_PATH` is set.

## Development

```sh
node --test
```

Tests use a local mock server and need no network.

## License

MIT, © Joe Steffee

## Opening the dashboard as a normal pane

`herdr-llama-swap open [--target workspace|split|popup]` (also `bin/herdr-llama-swap --target ...`; bare `bin/herdr-llama-swap` still opens the popup):

- `workspace` (default): reuses the workspace labelled `llama-swap` (focuses it) or creates one with cwd = plugin root. The root pane comes from `workspace list` (`root_pane.pane_id`), falling back to the first pane of that workspace in `pane list` (matched by `workspace_id`), since `workspace get` does not expose it. The dashboard is (re)started only when it is not already the pane's foreground process, decided with `herdr pane process-info --pane <id>` (a `src/cli.js dashboard` cmdline). So pressing `q` and running `open` again brings it back, while running `open` twice in a row creates nothing new. This is a **normal, persistent, tiled pane** that can sit beside your agents.
- `split`: resolves the target pane from `$HERDR_PANE_ID`, else `$HERDR_PLUGIN_CONTEXT_JSON`, else the `focused: true` entry of `pane list` (then a `$HERDR_WORKSPACE_ID` match), and calls `herdr pane split --pane <id> --direction right`, then runs the dashboard in the new pane. `--current` is never used: it requires `HERDR_PANE_ID`, which a plain shell does not have.
- `popup`: the session-modal popup (`plugin pane open --entrypoint dashboard`); it closes with `q`.

It prints the workspace/pane id (or JSON with `--json`); on failure one line goes to stderr and the exit code is 1.

Plugin action id: `llama-swap.open-terminal` ("llama-swap: open live status pane", runs `--target workspace`). Keybindings must be added in your own herdr `config.toml` (`[[keys.command]]` with `type = "plugin_action"`), because manifest keybinds are ignored in herdr 0.9.5.
