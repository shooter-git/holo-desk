# Running the harnesses sealed

This page records what step C0 of the agent plan found by running each harness headlessly with one MCP
server of ours as its only tools. The adapters in `packages/agent/src/harness/` follow it.

- **Where:** Linux x64, 2026-11-11. Claude Code 2.1.322, Codex CLI 0.167.1, Cursor CLI 2026.11.10-731fb78
  (it updated itself to 2026.11.11-043ef28 during the spike; see Cursor below). Antigravity CLI 1.5.13 on
  2026-11-21, by hand (see Antigravity below).
- **How:** `tools/agent-spike.mjs`. It has a stub MCP server (`echo`, `image` returning a 64×64 PNG of one
  colour, `slow {ms}`) and runs a harness once in `${XDG_CACHE_HOME:-~/.cache}/holo/agent-spike/<harness>`,
  prompt on stdin, saving the raw stream. Cheapest models: Claude `haiku` (one `sonnet` run), Codex
  `gpt-6-luna` at low effort, Cursor `composer-2.5`.
- **Recordings:** `packages/agent/test/fixtures/<harness>-*.jsonl`, sanitized (home folder as `~`, user name as
  `user`, image data trimmed). They're listed at the end.

"Seen" below means observed in a run. "Source" means read in the harness's own bundled code, not run.

## Summary

| Check | Claude Code | Codex | Cursor | Antigravity |
|---|---|---|---|---|
| Only our MCP tools | Yes: `--tools=` removes every built-in tool; `init` lists only `mcp__holo__*` | Nearly: no shell, file read, web or apps; `apply_patch` remains but is refused (read-only sandbox, approvals never) | Yes, with the hidden `--allowed-tools`: the model gets only GetDynamicTools and CallDynamicTool | Yes, as a workspace custom agent with `excludeDefaultComponents: true` and `tools: []`, HO[LO]'s tools `eager`: the model has `mcp_holo_*`, `list_resources`, `read_resource` and `manage_task`; `init` still lists every built-in |
| User's MCP servers kept out | Yes (`--strict-mcp-config`; claude.ai connectors off) | Yes (`--ignore-user-config`; none configured here to prove it) | Only with a private `HOME`; account-enabled plugins' servers still connect and are visible, but calls are rejected | Only with a private `HOME` (the user's servers, plugins, hooks, rules and settings are all under `~/.gemini`; no flag) |
| Shell/read attempt | Nothing to call; with built-ins on, `dontAsk` denies at once | Nothing to call (`exec_command` gone); a forced write is refused | Denied by the workspace `cli.json`, no hang, no `--force` | Nothing to call, says so; without the agent, `run_command` is denied by the `--settings` deny rule |
| Tool calls run without a prompt | `--allowedTools=mcp__holo__*` | needs `default_tools_approval_mode="approve"` | `--approve-mcps` plus `allow: Mcp(holo:*)` | `--settings` with `allow: mcp(holo/*)`; without it, refused (`denied_actions`) |
| Prompt on stdin | Yes (`-p`, no argument) | Yes (`-`) | Yes (`-p`, no argument) | Only as one stream-json line (`--input-format=stream-json`); `-p` takes the prompt as its value |
| The agent's instructions | `--append-system-prompt-file` | the workspace's `AGENTS.md`, after the user's global `$CODEX_HOME/AGENTS.md`, when a thread starts | the workspace's `AGENTS.md`, when a conversation starts (not on resume: seen) | the custom agent's body: its system prompt |
| Session id | `init.session_id` | `thread.started.thread_id` | `init.session_id` | `conversation_id`, on every event |
| Resume | `--resume=<id>`: works | `exec resume … <id> -`: works; `--ephemeral` breaks it | `--resume=<id>`: works only with the same private `HOME` | `--conversation=<id>`: works with the same private `HOME`; an unknown id starts a new conversation (a warning on stderr) |
| MCP image reaches the model | Yes (named the colour) | Yes | Yes | Only a small one: a file of about 10 KB or less (it named the colour). A bigger one is saved to a file the sealed agent can't open, so HO[LO]'s tools make their pictures that small for it (see **Pictures** under Antigravity) |
| MCP tool timeout | per-server `"timeout"` (ms) in the MCP config | `mcp_servers.holo.tool_timeout_sec` | **fixed at 60 s** in print mode | per-server `timeoutSeconds` in `mcp_config.json` (the start too); 180 s by default |
| Model / effort | `--model=<alias>` `--effort=<low…max>` | `--model=<id>` `-c model_reasoning_effort="…"` | effort is part of the model id | `--model=<slug>`; a model's effort variants (`…-low`) or `--effort` with the model's family name |
| Signed-in check | `claude auth status` (JSON, exit 0/1) | `codex login status` (stderr text, exit 0/1) | `cursor-agent status --format json` (exit 0 both) | none: `agy models` lists (exit 0), or says "Please sign in" (exit 1) |
| Sign-in without a TTY | URL printed, pasted `code#state` on stdin (source) | `codex login --device-auth`: URL + one-time code (source) | `NO_OPEN_BROWSER=1`: URL printed, then polls (source) | hidden `agy acp --login`: URL printed, pasted code (or landing URL) on stdin |
| Check for an update without installing | the `stable` channel file on downloads.claude.ai | npm registry / GitHub releases | `cursor-agent about --format json` | the manifest `install.sh` reads (`…/manifests/<os>_<arch>.json`) |
| Official installer (Install) | `curl -fsSL https://claude.ai/install.sh \| bash` | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | `curl https://cursor.com/install -fsS \| bash` | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` |
| Models / efforts from | `--help` (aliases; `--effort`'s choices), per version | `codex debug models`, per version and hourly | `cursor-agent models` at each look; effort is in the model id | `agy models` at each look; a model's `-low`…`-max` variants are one model with those efforts |
| Defaults from | none listed: a run needs both chosen | the same catalog: lowest `priority`, `default_reasoning_level` | `models`' "(default)" | none said (a run without `--model` doesn't name its model); none needed |
| Updates itself during a run | not with `DISABLE_AUTOUPDATER=1` | not seen | **yes, unless `--disable-auto-update`** | **yes, in the background, unless its home's `last_check.timestamp` is under 15 minutes old** |
| Startup to first event | 0.3–0.5 s | 0.06–0.5 s | 3–7 s warm, 15–34 s cold | not measured; about 4 s to the first tool call |
| Stop | process-group SIGTERM: all gone | same | same; also needed after a normal exit (worker daemon) | process-group SIGTERM: `agy` and the MCP server gone |
| Verdict | **Sealed** | **Sealed, with caveats** | **Sealed, with caveats** | **Sealed, with caveats** (below) |

## Every harness's environment

Each run, sign-in, update and probe gets an environment built by `harnessEnv`
(`packages/agent/src/harness/env.ts`), never the runner's own:
- **An allowlist:** `HOME`, `PATH`, `LANG`, `LANGUAGE`, `TERM`, `TMPDIR`, `TZ`, `USER`, `LOGNAME`, `LC_*`,
  `XDG_*`, the proxy variables and `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR` (on Windows, also
  what a program needs to start), plus that harness's own sign-in variables. Then each adapter's switches
  (below).
- **No ssh agent.** No `SSH_*` variable is passed (`SSH_AUTH_SOCK` among them), whatever sets it.
- **`PATH` without scripts folders.** `pnpm runner` puts the repository's `node_modules/.bin` first, and pnpm
  its `node-gyp-bin`; a harness gets neither, and no empty or relative entry (those would be looked up in its
  workspace). Only absolute folders are kept, in order.
- **Git without ssh or the user's git config**, set last so nothing undoes it. In an end-to-end run, Cursor
  fetched its plugins with `git fetch` over `ssh git@github.com` (24 connections), and ssh reads the real
  `~/.ssh` and talks to the user's agent whatever `HOME` says. Now:
  - `GIT_SSH_COMMAND=false`: git's ssh is `false`, which fails at once ("Could not read from remote
    repository"), with no network;
  - `GIT_CONFIG_COUNT=2`, `GIT_CONFIG_KEY_0` and `_1` = `url.https://github.com/.insteadOf`,
    `GIT_CONFIG_VALUE_0=git@github.com:`, `GIT_CONFIG_VALUE_1=ssh://git@github.com/`: GitHub's ssh addresses
    are fetched over anonymous https, so public repositories (Cursor's plugins) still come;
  - `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`: none of the user's or the system's git config,
    so none of their credential helpers or URL rewrites (Cursor's `XDG_CONFIG_HOME` is the real one, where
    `git/config` may be);
  - `GIT_TERMINAL_PROMPT=0`: git never asks for a name or password; a private repository just fails.

## Install

Settings › Agent lists all four harnesses. One the runner doesn't find has **Install**, which runs its
vendor's official installer, as the vendor's docs give it:

| Harness | Command | Puts it in |
|---|---|---|
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | `~/.local/bin/claude` |
| Codex | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | `~/.local/bin/codex` |
| Cursor | `curl https://cursor.com/install -fsS \| bash` | `~/.local/bin/cursor-agent` |
| Antigravity | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | `~/.local/bin/agy` (it then runs `agy install`, which adds `~/.local/bin` to the shell's PATH) |

How it runs (`install` in `packages/agent/src/harness/adapter.ts`, the command in each adapter's spec):
- **A fixed string, run by bash:** `bash -o pipefail -c '<command>'`, with bash found on PATH or in
  `/bin`, `/usr/bin`. Nothing from the studio, the server or a request is in it: `agent-install` names
  the harness only. `pipefail` makes a download that fails (curl's `-f`) fail the install, rather than
  hand the shell an empty script that "succeeds". Running the vendor's pipe as it's documented was
  chosen over downloading to a temporary file: the command the user confirms is then exactly the one
  the vendor publishes, and the one that runs.
- **As the user's own update runs:** the allowlisted environment of `harnessEnv` with the user's real
  `HOME` (no sealed run's private home, no `SSH_*`, no other tools' keys), in `<root>/.probe`. Only on a
  click (the studio asks first), never while that harness has a job or another relay, and refused when
  the harness is found (Update is for that). Linux and macOS only: on Windows no `installer` is reported.
- **Then a fresh look.** The runner looks again before it says `done`, so Settings shows the version
  and Sign in at once. The adapters look in `~/.local/bin` whatever PATH says, so what the installers
  put there is found; if nothing can be found after an installer that succeeded, the install fails
  with "Installed in ~/.local/bin, which the runner doesn't see: run `pnpm run runner-service on` again
  on the host" (the service's PATH is the one it was turned on with).
- The tests run fake installers only: `packages/agent/test/harness-install.test.ts` gives the installer a
  PATH holding a fake `curl` (it records what it was asked for and prints a fake script) and links to
  the few tools that script uses, so no real download can happen.

## Models and efforts

The Model and Effort pickers follow what each vendor releases. HO[LO]'s server never asks a vendor:
each harness lists its own on the host, the runner reports the result (`HarnessInfo.models`,
`efforts`), and the server keeps it.

| Harness | Models | Efforts | Read again |
|---|---|---|---|
| Claude Code | the aliases `--help` names for `--model`, plus `sonnet`, `opus`, `haiku` | the choices `--help` lists for `--effort` (`low…max` if it lists none) | with each new version (`--help` is read once per version) |
| Codex | `codex debug models` (visible ones; `--bundled` offline) | per model, from the same catalog (`ultra` left out) | with each new version, and when the catalog is an hour old |
| Cursor | `cursor-agent models` | none: the model id carries it (`…-low`, `…[fast=true]`) | at every look |
| Antigravity | `agy models`, each model's effort variants as one model | per model: its variants' endings (`low`, `medium`, `high`, `xhigh`, `max`) | at every look |

When the runner looks:
- when the agent is turned on, or a runner joins while it's on (`agent-on`);
- after a sign-in, an update or an install (before it says `done`);
- **Look again** (`agent-refresh`), which also re-checks a seal that failed for a version;
- **when Settings › Agent is opened** and the runner's last look is an hour old or more (the server
  sends `agent-refresh {light:true}`, at most once an hour per runner): the versions, sign-ins, models
  and efforts as they are now, each seal as remembered for its version. A new version, noticed then or
  after an update, is read in full at once (its `--help`, its catalog, its seal).

When the models don't all take the same efforts (Codex's catalog, Antigravity's variants), the runner
also reports each model's (`HarnessInfo.modelEfforts`, read from what's already listed), and the Effort
picker offers those of the model a run uses.

A saved model or effort the harness no longer offers isn't an error: the adapter drops it before the
run (the model when the last look listed others; the effort when the harness doesn't take it with that
model), and the run uses the harness's default. The picker shows it as "(no longer offered)". Claude
Code has no default to fall back on, so it's refused instead (below).

### Defaults

Settings › Agent says what a run uses when Model or Effort is left empty (`HarnessInfo.defaultModel`,
`defaultEfforts`), so the model and effort in use can always be read there.

| Harness | Default model | Default effort |
|---|---|---|
| Claude Code | none: a model must be chosen | none: an effort must be chosen |
| Codex | the visible model with the lowest `priority` in `codex debug models` | the model's `default_reasoning_level` in the same catalog |
| Cursor | the one `cursor-agent models` marks "(default)" (`auto`) | none: the model id carries it |
| Antigravity | none said: the account's, unnamed | none said: the model's own |

- **Codex.** Its app server (`codex app-server`, `model/list`) marks the lowest-priority model
  `isDefault`, and keeps marking it with `-c model=…` set: it's the built-in default, which a run has,
  since a run ignores config.toml. Its `defaultReasoningEffort` is the catalog's
  `default_reasoning_level`. Checked 2026-11-17 with Codex 0.169.0: `gpt-6.1-sol`, `low`.
- **Cursor.** `models` runs with the probe's private home, as a run has its own: neither reads the user's
  cli-config.json. A run's `--model` is saved as its thread's default (the workspace home's
  cli-config.json, "Cursor" below), so a run given no model starts without that file, as a new thread
  does, and gets Cursor's default rather than the model an earlier run of the thread had.
- **Antigravity.** A run without `--model` runs, but its `init` then has no `model`, and `models` marks
  none, so Settings says "Antigravity's default model and effort". A family given without an effort
  (`--model=gemini-3.8-flash`) runs at the model's own effort, also unnamed.
- **Claude Code.** Its default model follows the account (its plan) and its default effort a per-model
  list Anthropic serves, so neither can be read before a run, and nothing it prints says the effort
  (only its private transcript does). So it has none here (`mustChoose`): Settings asks for both, and a
  request without them, or with one `--help` no longer lists, is refused (409 `choose`) by the server
  and again by the adapter. The names it offers are its own aliases (`opus`, `sonnet`, `haiku`, and
  what `--help` names), each the latest model of its kind the account has, so the list follows new
  models and plans without a change here. Every alias takes every effort `--help` lists (checked
  2026-11-17 with 2.1.322: `haiku` at `max` runs). A run's `init` names the full model (`model`); the
  adapter keeps what each alias stood for in the runner's notes (`.harnesses.json`, `aliases:claude`),
  forgotten when another account signs in, and Settings shows it.

## Claude Code

**Command** (prompt on stdin):

```
claude -p --output-format=stream-json --verbose
  --model=<alias or id> --effort=<low|medium|high|xhigh|max>
  --tools=
  --strict-mcp-config --mcp-config=<ws>/mcp.json
  --allowedTools=mcp__holo__*
  --permission-mode=dontAsk
  --setting-sources=project --settings=<ws>/settings.json
  [--append-system-prompt-file=<ws>/instructions.md]
  --disable-slash-commands --no-chrome
  [--resume=<session id>]
```

Environment, on top of the allowlist: `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `DISABLE_AUTOUPDATER=1`,
`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`.

`<ws>/mcp.json`:

```json
{ "mcpServers": { "holo": { "type": "stdio", "command": "<node>", "args": ["<mcp.ts>"], "env": {}, "timeout": 240000 } } }
```

`<ws>/settings.json`:

```json
{ "disableAllHooks": true, "autoMemoryEnabled": false, "disableClaudeAiConnectors": true }
```

**What the `init` event showed** (seen):
- `tools`: only `mcp__holo__echo`, `mcp__holo__image`, `mcp__holo__slow`.
- `mcp_servers`: `[{"name":"holo","status":"connected","source":"dynamic"}]`.
- `slash_commands: []`, `skills: []`. Without `--disable-slash-commands`, 19 skills were listed (the user's and
  bundled ones). They can't run without the Skill tool, but the flag drops them.
- `plugins`: four built into Claude Code (`cc-plugin-agents-md`, `-telemetry`, `-privacy`,
  `-plugin-authoring`). No user plugins.
- `agents`: the built-in list; unreachable without the Task tool.
- `memory_paths` disappears with `autoMemoryEnabled: false`.
- claude.ai connectors (the account has some) didn't load in `-p` even without the env variable; keep both
  switches anyway.
- `--setting-sources=` (empty) was also accepted. There's no `~/.claude/settings.json`, `CLAUDE.md` or hook on
  this machine, so excluding them couldn't be observed, only configured.

**Permissions** (seen). `--allowedTools=mcp__holo__*` runs our tools with no prompt
(`permission_decision: {decision:"accept", source:"config"}`). With the built-in tools left on (the `loose`
variant) and `--permission-mode=dontAsk`, the model's `Bash` and `Read` calls were denied at once. Each gave a
`{"type":"system","subtype":"permission_denied","tool_name":"Bash",…}` event and an entry in
`result.permission_denials`. Nothing hung.

**Events** (stream-json, one per line):
- `{"type":"system","subtype":"init","session_id","tools","mcp_servers","model","permissionMode",…}`
- `{"type":"assistant","message":{"content":[{"type":"tool_use","id","name":"mcp__holo__echo","input"}]},"session_id"}`.
  Each content block comes as its own `assistant` event (same `message.id`): `text`, `thinking`, `tool_use`.
- `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id","content":[…],"is_error"?}]}}`
- `{"type":"result","subtype":"success","is_error":false,"result":"<final text>","session_id","num_turns","permission_denials":[],"total_cost_usd",…}`
- Also seen, to be ignored: `system/thinking_tokens`, `rate_limit_event`, and `system/post_turn_summary` (in a
  non-sealed run).

**Tripwire:** abort unless `init.tools` are all `mcp__holo__*` and `init.mcp_servers` is just `holo`; also
abort on any `tool_use` whose name isn't `mcp__holo__*` and on any `permission_denied` event.

**Images** (seen): the model named the colour. Claude saves MCP images under
`~/.claude/projects/<workspace-slug>/<session>/tool-results/` and adds a text block naming that path.

**Resume** (seen): `--resume=<session_id>` gave the same `session_id` and the history. It also worked from
another folder, since sessions are found by id; still resume from the thread's workspace.

**Timeouts.**
- Seen: the per-server `"timeout"` in milliseconds. With 3000, a slow call gave the tool result
  `MCP server "holo" tool "slow" timed out after 3s` (`is_error`), and Claude sent `notifications/cancelled`.
- Source: without it, `MCP_TOOL_TIMEOUT` (ms) applies, and the default is effectively unlimited. A stdio
  server also has an idle timeout, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, 30 min by default.
- `tools/call` carries `_meta.progressToken`, so progress notifications are possible.

**Model and effort** (seen). `--model=haiku` ran `claude-haiku-5-5`, and `--model=sonnet` ran
`claude-sonnet-5-5`. An unknown effort isn't an error: stderr says
`Unknown --effort value 'bogus' — ignoring it and using the default effort. Valid values: low, medium, high, xhigh, max.`,
and the run continues. Validate it in the adapter.

**Many tools** (seen): with 45 extra tools (48 in all), `sonnet` called `mcp__holo__extra_44` directly. Without
`--tools`'s ToolSearch, Claude sends MCP tools as they are. `init` listed 123 tools with 120 extra.

**MCP handshake** (seen): Claude first sends `server/discover` with the string id `"server-discover-probe-1"`.
After a `-32601` answer it sends `initialize` with protocol `2025-11-25`.

**Sign-in.**
- `claude auth status` prints JSON by default (`--text` for text). Signed in, it has `loggedIn: true`,
  `authMethod`, `email`, `orgId`, `orgName`, `subscriptionType` and `loginExpiresAt`, and exits 0. Signed out
  (seen with an empty `HOME`), it has `{"loggedIn":false,"authMethod":"none",…}` and exits 1.
- `claude auth login [--claudeai|--console] [--email <e>] [--sso]` (source, not run). When stdin and stdout
  aren't a TTY, it:
  - prints `Opening browser to sign in…`, then `If the browser didn't open, visit: <url>`, then
    `Paste code here if prompted > `;
  - tries to open a browser and listens on a localhost callback;
  - reads `code#state` lines from stdin;
  - ends with `Login successful.` (exit 0) or `Login failed: …` (exit 1).

  So the relay shows the URL, and a pasted code is written to stdin.

**Update.** `claude update` has no check-only flag (not run). Read-only checks:
- `claude doctor` prints the install type, version and `Auto-update channel: latest`, but not the newest
  version.
- `GET https://downloads.claude.ai/claude-code-releases/latest` (or `/stable`) answers the newest version as
  plain text (`2.1.322`; stable `2.1.311`).
- For npm installs, `npm view @anthropic-ai/claude-code dist-tags`.

**Startup and stopping** (seen). `init` comes 0.3–0.5 s after spawn, and small runs take 2–6 s. A
process-group SIGTERM ended Claude (exit 143) and the MCP server, which got SIGTERM; nothing was left.

**What it writes in the user's folders** (seen):
- the transcript `~/.claude/projects/<workspace-slug>/<session>.jsonl` (needed for resume) and the tool-result
  images;
- `~/.claude.json` on every run, but only caches (`cachedGrowthBookFeatures`, `cachedGrowthBookFeaturesAt`,
  `clientDataCacheSlots`, `additionalModelOptionsAnsweredAt`). No project entry or setting changes. The user's
  own running Claude sessions write it too.

**In the adapter** (`packages/agent/src/harness/claude.ts`):
- The agent's instructions (`packages/agent/AGENT.md`) are written to `<ws>/instructions.md` and given with
  `--append-system-prompt-file`. The runner takes them off the front of the prompt, so they aren't there twice.
- Before Claude Code is offered, its `--help` (read once per version) must name every option a sealed run uses:
  `--tools`, `--strict-mcp-config`, `--mcp-config`, `--allowedTools`, `--permission-mode`, `--setting-sources`,
  `--settings`, `--disable-slash-commands`, `--append-system-prompt`, `--effort` and `--resume`. An older Claude
  Code is listed as unavailable, with what it lacks.
- Models: the aliases `--help` names for `--model`, plus `sonnet`, `opus` and `haiku`. Efforts: the choices
  `--help` lists for `--effort` (`(low, medium, high, xhigh, max)` in 2.1.322; commander's
  `(choices: "…")` form is read too), `low…max` when it lists none. An effort it doesn't list is left out
  of the run, and so is a model it no longer names.
- Install: `curl -fsSL https://claude.ai/install.sh | bash` (the native installer, `~/.local/bin/claude`).
- Sign-in status: `claude auth status --json`. `claude auth login` is offered only while it says signed out.
- **The update check reads the `stable` channel**: `https://downloads.claude.ai/claude-code-releases/stable`,
  whatever channel the install follows (`claude doctor` names it; on this machine it's `latest`). An install on
  either channel can reach the version `stable` names, so Update never offers one `claude update` won't install;
  an install on `latest` is usually ahead of it and updates itself. An npm install (its path has
  `node_modules`) is checked against the `stable` tag, `https://registry.npmjs.org/@anthropic-ai/claude-code/stable`,
  instead. The answer is kept for 6 hours, per version, in `<root>/.harnesses.json` (`<root>` is
  `${XDG_CACHE_HOME:-~/.cache}/holo/agent`).
- `claude update` runs only when the user clicks Update in Settings › Agent, with `DISABLE_AUTOUPDATER` left out
  of its environment.
- **A HO[LO] tool named without its prefix doesn't trip the run.** At low effort the model once called
  `track_add` instead of `mcp__holo__track_add`. Claude Code has no tool by that name and answers "No such tool
  available", and the model calls it again by its full name. So a bare name the `init` event offered with the
  prefix is passed over; any other name still stops the run.
- What a sealed run still does on its own (seen in a trace): it rewrites `~/.claude.json` (caches) and rotates
  `~/.claude/backups`, keeps its session in `~/.claude/projects/<workspace>`, writes a plugin-store cache entry,
  and runs `rg` and `git ls-files` in the workspace (which isn't a repository) and `ps`. No settings, skills,
  hooks or credentials change.

## Codex

**Command** (prompt on stdin):

```
codex exec --json --skip-git-repo-check --ignore-user-config --ignore-rules
  --model=<id> -c model_reasoning_effort="<effort>"
  -c sandbox_mode="read-only" -c approval_policy="never" -c web_search="disabled"
  -c features.multi_agent_v2.disable_native_tools=true
  -c check_for_update_on_startup=false -c project_root_markers=[]
  -c features.shell_tool=false -c features.unified_exec=false -c features.apps=false
  -c features.plugins=false -c features.remote_plugin=false -c features.browser_use=false
  -c features.browser_use_external=false -c features.in_app_browser=false -c features.computer_use=false
  -c features.image_generation=false -c features.multi_agent=false -c features.hooks=false
  -c features.goals=false -c features.view_image=false -c features.tool_suggest=false
  -c features.skill_search=false -c features.skill_mcp_dependency_install=false
  -c features.workspace_dependencies=false -c features.shell_snapshot=false
  -c features.plugin_discovery_prefetch=false -c features.sleep_tool=false
  -c mcp_servers.holo.command="<node>" -c mcp_servers.holo.args=["<mcp.ts>"]
  -c mcp_servers.holo.env={NAME="value"}
  -c mcp_servers.holo.tool_timeout_sec=240 -c mcp_servers.holo.startup_timeout_sec=20
  -c mcp_servers.holo.default_tools_approval_mode="approve"
  --sandbox=read-only --cd=<ws> -
```

**Resume:**

```
codex exec resume <the same options, without --sandbox and --cd> <thread id> -
```

`exec resume` takes neither `-s` nor `-C`. The `-c sandbox_mode` and the spawn's working folder cover them.
Values given with `-c` show in `ps`: never put the job token there. Our server reads it from `.holo-job`.

**Why each switch** (all seen):
- **Inspecting without spending.** `codex debug prompt-input -c … "hi"` prints the tools and
  instructions the model would get, without a model call. The session record
  (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) shows the rest.
- **Code mode.** Every model in `codex debug models` has `tool_mode: code_mode_only`. The model's one real tool
  is `exec`: JavaScript in a V8 isolate, described as "no Node, no file system, no network access". It reaches
  the other tools through `tools.*` and lists them in `ALL_TOOLS`.
- **Without the switches** (the `loose` variant), `ALL_TOOLS` had 347 entries. They included `exec_command`,
  `write_stdin`, `view_image`, `image_gen__imagegen`, the goal tools, `request_plugin_install` and **331
  `mcp__codex_apps__*` tools: the account's ChatGPT apps**.
- **With them**, the model has `exec`, `wait`, `request_user_input` and `request_user_input_async`. `ALL_TOOLS`
  is `apply_patch`, `clock__curr_time`, `list_mcp_resources`, `list_mcp_resource_templates`,
  `read_mcp_resource` and `mcp__holo__*`.
- **`send_message_to_user_async`** joins them from 0.169.1 (checked 2026-11-18 on a host with it). It's the
  user-input pair's sibling: one argument, the message, and nothing else. In 0.169.0 it was an "under
  development" feature, off; in 0.169.1 `--disable send_message_to_user_async` is accepted but the tool is
  still offered, so the seal allows it rather than refusing Codex.
- **`features.multi_agent_v2.disable_native_tools=true`** removes the `collaboration.*` sub-agent tools
  (`spawn_agent`…). `features.multi_agent=false` alone only does that for v1 models such as `gpt-5.6-luna`.
- **Features are switched off as settings** (`-c features.<name>=false`), not with `--disable <name>`. Codex's
  help calls the two equivalent, and they are for a name it knows. For one it doesn't, `--disable` stops Codex
  with `Error: Unknown feature flag: <name>`, so a release that renamed or dropped a feature on the list would
  stop every run (and the seal check). The setting is ignored instead, and the seal check still refuses a Codex
  that leaves the model a renamed feature's tools (checked 2026-11-18 on 0.169.0: sealed with the settings and
  an unknown name among them, and without them `exec_command`, `view_image`, `write_stdin` and `sleep` were
  back). `codex features list` shows each feature's stage (`removed` ones too) and whether it's on.
- **`default_tools_approval_mode="approve"`.** Without it every MCP call failed with
  `MCP tool call requires approval, but approval policy is never`. The valid values are `auto`, `prompt`,
  `writes` and `approve`. It's set on our server only (`mcp_servers.holo.…`).
- **`check_for_update_on_startup=false`** (added in the adapter) keeps a run from looking for a newer Codex as
  it starts. The runner looks for updates itself, and installs one only when the user clicks Update. (Codex
  wasn't seen updating itself during a run either way.)
- **`project_root_markers=[]`** (added in the adapter) has Codex take `AGENTS.md` from the workspace only, none
  from the folders above it.
- **The user's global `AGENTS.md` is still read.** Seen later with `codex debug prompt-input` (0.167.1, a
  stand-in `CODEX_HOME` holding an `AGENTS.md`, and the run's `-c` and `--disable` switches):
  - `$CODEX_HOME/AGENTS.md` comes first in the model's one "AGENTS.md instructions" message, then
    `--- project-doc ---` and the workspace's `AGENTS.md`;
  - `--ignore-user-config` skips only `config.toml` (its help says "auth still uses `CODEX_HOME`");
  - `-c project_doc_max_bytes=0` drops the workspace's file but not the global one, and
    `-c user_instructions=""` changes nothing.

  A run can't have a `CODEX_HOME` of its own: the sign-in, and the sessions resume needs, are in the user's. So
  the adapter leaves the file as it is (HO[LO] never reads or writes `~/.codex`). Its text reaches the model
  before HO[LO]'s instructions, but it can't give the model a tool, and `AGENT.md` says that only the request
  and HO[LO]'s instructions say what to do.
- **`apply_patch` couldn't be removed.** `include_apply_patch_tool` and `tools.apply_patch` are ignored. A forced
  attempt was refused:
  `patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings`. No file was
  written.
- **With the shell left on**, `exec_command` failed on this machine only because Codex's sandbox can't start
  here (`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`). On a machine where it starts, a
  read-only sandbox still lets `ls ~` and file reads run. Disabling `shell_tool` and `unified_exec` is what
  seals it.
- **The MCP server isn't sandboxed.** It wrote its log under the read-only sandbox, so our server can reach the
  HO[LO] API.

**Events** (`--json`):
- `{"type":"thread.started","thread_id"}` (the session id), then `{"type":"turn.started"}`.
- `{"type":"item.started"|"item.completed","item":{"id","type":"mcp_tool_call","server":"holo","tool","arguments","result":{"content":[…],"structured_content"}|null,"error":{"message"}|null,"status":"in_progress"|"completed"|"failed"}}`
- `{"type":"item.completed","item":{"id","type":"agent_message","text"}}`. There may be several (a progress
  line, then the answer); the last one is the reply.
- `{"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","cache_write_input_tokens","output_tokens","reasoning_output_tokens"}}`
- A failed resume prints nothing on stdout, exits 1 and writes the error on stderr:
  `Error: thread/resume: thread/resume failed: no rollout found for thread id …`.

**Tripwire.** In code mode, only MCP calls appear in `--json`. The `exec_command` and `apply_patch` attempts
above weren't in the stream at all: they show only in the session record, and a refusal also shows on stderr
as `ERROR codex_core::tools::router: error=…`.
- So "abort on `command_execution`" can't be the whole tripwire. Instead, abort on:
  - any item type other than `agent_message`, `reasoning`, `todo_list` and `mcp_tool_call` with
    `server: "holo"`;
  - any `codex_core::tools::router: error` line on stderr.
- Our MCP server can also check `_meta["x-codex-turn-metadata"].sandbox_mode === "read-only"`. Codex sends it
  with every `tools/call`, together with `model` and `reasoning_effort`.

**Images** (seen): the model named the colour.

**Resume** (seen): the same `thread_id` and the history. The recorded turn context kept `sandbox: read-only`,
`approval: never` and `effort: low`, but the adapter passes every option again anyway. With `--ephemeral`
nothing is saved, and resume fails as above: don't use it.

**Timeouts** (seen). `tool_timeout_sec=3` gave a failed item:
`tool call error: tool call failed for \`holo/slow\` … timed out awaiting tools/call after 3s`. Codex sent
`notifications/cancelled`. It sends no `progressToken`.

**Model and effort** (seen). `--model=gpt-6-luna -c model_reasoning_effort="low"` was recorded as such. Each
model's efforts are in `codex debug models` (read-only): `supported_reasoning_levels` is `low…max`, plus
`ultra` on some. Bad values aren't rejected when the config loads, so validate them against that catalog.

**MCP handshake** (seen): `initialize` with protocol `2025-06-18`, client `codex-mcp-client`.

**Sign-in.**
- `codex login status` writes `Logged in using ChatGPT` on **stderr** and exits 0. Signed out (seen with an
  empty `CODEX_HOME`), it writes `Not logged in` and exits 1. There's no JSON.
- `codex login --device-auth` (source, not run) prints `Open this link in your browser and sign in` and
  `Enter this one-time code after you are signed in (expires in 15 minutes)`, then waits. That works without
  a TTY and from another device.
- The default `codex login` opens a browser with a localhost callback (port 1455 in OpenAI's docs; not run),
  which a phone can't complete. `--with-api-key` reads a key from stdin.

**Update.** `codex update` has no check-only flag (not run). The install is the standalone one
(`~/.codex/packages/standalone/releases/<version>`). Read-only checks:
`npm view @openai/codex version` (`0.167.1`) or the latest GitHub release (`rust-v0.167.1`).

**Startup and stopping** (seen). `thread.started` comes 0.06–0.5 s after spawn, and runs take 2.5–9 s. A
process-group SIGTERM ended Codex; the MCP server saw stdin close. Nothing lingers.

**What it writes in the user's folders** (seen):
- `~/.codex/sessions/…/rollout-*.jsonl` (needed for resume);
- SQLite files (`state_5`, `logs_2`, `thread_history_1`, `goals_1`, `memories_1`, `queue_1`),
  `models_cache.json`, `installation_id`, and `skills/.system` (4 bundled skills, listed in the instructions;
  useless without file reading);
- only when not disabled: `cache/codex_apps_*` and `plugins/cache/openai-curated-remote/*`.

`config.toml` isn't touched (there's none here). `--ignore-user-config` kept the sign-in. `--ignore-rules` was
accepted.

**Verdict:** sealed. There's no shell, file reading, web, image viewing, apps or user MCP servers. The only
write tool left, `apply_patch`, is refused. The caveats:
- the tripwire can't see refused non-MCP attempts in `--json`;
- `features.multi_agent_v2.disable_native_tools` is an undocumented key that may change, so the adapter should
  check `codex debug prompt-input` once per Codex version and mark Codex unavailable if any tool beyond those
  above appears;
- the user's global `$CODEX_HOME/AGENTS.md` reaches the model as instructions (text only).

**In the adapter** (`packages/agent/src/harness/codex.ts`):
- The agent's instructions are the workspace's `AGENTS.md` (mode 0600). They reach the model as one message
  when a thread starts, so a resumed turn carries them at the head of its prompt (`rulesAtStartOnly`, as
  Cursor's; not checked with Codex itself).
- **The seal is checked once per version**, remembered in `<root>/.harnesses.json`: `codex debug prompt-input`
  with the run's `-c` settings, in an empty `CODEX_HOME` of its own (`<root>/.codex-probe`,
  so none of the user's config or MCP servers is read or started). Codex is offered only when the model's tools
  are code mode's own (`exec`, `wait`, `request_user_input`, `request_user_input_async`,
  `send_message_to_user_async`) and, reached through `exec`, `apply_patch`, `clock__curr_time`, the three MCP
  resource tools and `mcp__holo__*`. The result is remembered with a short hash of the switches and the allowed
  tools (`rules`), so a runner whose rules changed checks the same version again.
- **Checked every day on GitHub, before users update.** `.github/workflows/codex-check.yml` runs
  `tools/codex-check.mjs` against Codex's newest release and its newest test build (`-alpha`, when it's
  ahead): the same `codex debug prompt-input` with the same switches, in an empty `CODEX_HOME`, so nothing
  signs in and no model is called. When HO[LO] would refuse one, the scheduled run opens an issue named after
  the finding (the unknown tools, or what Codex said when it stopped), and adds each later version that has it
  to that issue rather than opening another. It also notes switched-off features a Codex has removed or
  doesn't know, which are harmless but can leave the list. It runs on pull requests that change the Codex
  adapter, and by hand for one version (Actions › Codex check › Run workflow).
- Models: those `codex debug models` lists as visible (`--bundled` when it can't fetch them), each with its
  efforts, read once per version and again once the list is an hour old. `ultra` isn't offered: it hands work
  to sub-agents, which a sealed run doesn't have.
- Install: `curl -fsSL https://chatgpt.com/codex/install.sh | sh` (the standalone install, `~/.local/bin/codex`).
- The tripwire also lets `error` items through, and Codex's top-level `error` events ("Reconnecting… 2/5") are
  shown, not taken as a failure; `turn.failed` is.
- Sign-in: `codex login --device-auth`, its link and one-time code relayed. Status: `codex login status`.
- The update check is `https://registry.npmjs.org/@openai/codex/latest`. `codex update` runs only on a click.

## Cursor

**Command** (prompt on stdin):

```
cursor-agent -p --output-format=stream-json --workspace=<ws> --trust --approve-mcps
  --sandbox=disabled            (enabled where it works; see below)
  --disable-auto-update
  --allowed-tools=mcp_tool_call,get_mcp_tools_tool_call
  --model=<id>
  [--resume=<session id>]
```

**Environment.**
- `HOME=<ws>/home`: a private home kept with the thread.
- `XDG_CONFIG_HOME=<real home>/.config`: on Linux the sign-in is read from `$XDG_CONFIG_HOME/cursor/auth.json`.
- `CURSOR_CONFIG_DIR=<ws>/home/.cursor`.
- In the adapter, also `XDG_CACHE_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME` inside the private home
  (`<ws>/home/.cache`, `.local/share`, `.local/state`).
- And git as every harness has it ("Every harness's environment", above): Cursor fetches the account's
  plugins with `git fetch` from `git@github.com:`, which used the user's own SSH key (ssh reads the real
  `~/.ssh` whatever `HOME` is). With `GIT_SSH_COMMAND=false` and GitHub's ssh addresses rewritten to
  `https://github.com/`, they come over anonymous https, and the ssh agent's `SSH_AUTH_SOCK` isn't passed.

The whole environment of a run, then: `PATH` (absolute folders, without `node_modules/.bin`), `LANG` and the
other allowlisted variables that are set, `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN` if set, `HOME=<ws>/home`,
`XDG_CONFIG_HOME=<real home>/.config`, `CURSOR_CONFIG_DIR=<ws>/home/.cursor`, `XDG_CACHE_HOME`,
`XDG_DATA_HOME`, `XDG_STATE_HOME` (in the private home), `GIT_SSH_COMMAND=false`, `GIT_TERMINAL_PROMPT=0`,
`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_COUNT=2` and the two `insteadOf`
rewrites.

`<ws>/.cursor/mcp.json`:

```json
{ "mcpServers": { "holo": { "command": "<node>", "args": ["<mcp.ts>"], "env": {} } } }
```

`<ws>/.cursor/cli.json`:

```json
{ "permissions": { "allow": ["Mcp(holo:*)"], "deny": ["Shell(*)", "Read(**)", "Write(**)", "WebFetch(*)"] } }
```

**Why each part** (seen unless marked):
- **`--sandbox=enabled`** fails here before doing anything, with exit 1:
  `Error: Sandbox mode is enabled but not available on this system… possibly due to AppArmor configuration.`
  Use it only where it starts.
- **The project `cli.json`** may hold only known keys. `"version": 1` made Cursor reject the file
  (`Invalid project config … Unrecognized key: "version"`).
- **Permissions are honoured in print mode without `--force`.**
  - `ls ~` gave `permissionDenied: "Command blocked by permissions configuration"`.
  - Reading `/etc/hostname` gave `error: "Permission denied"`.
  - Writing `note.txt` gave `readPermissionDenied`.
  - `grep` and `glob` returned nothing.
  - Nothing hung.
- **Deny wins over allow.** Adding `Mcp(*:*)` to `deny` also blocked `holo`. Cursor's default config allows
  `Shell(ls)`, and the project `Shell(*)` deny overrides it.
- **An MCP server that's loaded but not in `allow`** (a second server, `other`, approved by `--approve-mcps`) is
  still listed to the model. Calling it gave `rejected: "User rejected MCP: other-echo"`.
- **`--allowed-tools`** is hidden, marked "internal only", and enforced by Cursor's backend. Asked for a shell,
  the model said its only tools were GetDynamicTools and CallDynamicTool, and made only
  `getMcpToolsToolCall`s. Without the flag it had used shell, read, edit, grep and glob, which the permissions
  denied. A wrong value lists the valid ones (snake_case: `mcp_tool_call`, `get_mcp_tools_tool_call`,
  `shell_tool_call`…).
- **The private `HOME`.**
  - A global `~/.cursor/mcp.json` is loaded whatever `--workspace`, `CURSOR_CONFIG_DIR` or `CURSOR_DATA_DIR`
    say, and its servers are "ready" without any approval. This was tested with a stand-in file under a
    temporary `HOME`.
  - `--approve-mcps` approves every server Cursor loads (source).
  - Cursor also loads Claude Code plugins from the home folder (source).
  - So the user's servers are kept out only by not giving Cursor the real `HOME`.
  - On macOS and Windows the sign-in is stored elsewhere (macOS `~/.cursor/auth.json`, Windows
    `%APPDATA%\Cursor\auth.json`, source), so this needs checking there before Cursor is offered.
- **`CURSOR_CONFIG_DIR`** is required: Cursor saves `--model` as the default model in the config folder's
  `cli-config.json` (`model`, `selectedModel`, `modelSelectionHistory`, `hasChangedDefaultModel: true`).
  Without it, that lands in the user's `~/.cursor/cli-config.json`, which happened during this spike. With
  `XDG_CONFIG_HOME` set and no `CURSOR_CONFIG_DIR`, Cursor writes a new `cli-config.json` next to the user's
  `auth.json`.
- **`--disable-auto-update`** is hidden. Without it, each run starts a background update 2 s in (source), and it
  did: the CLI went from 2026.11.10-731fb78 to 2026.11.11-043ef28 during the first run.
- **Plugins.** Even with the private `HOME`, the plugins enabled on the Cursor account are downloaded into
  `<home>/.cursor/plugins` on the first run: clerk, cloudflare, coinbase, github, gmail, google-calendar,
  google-docs, google-drive, google-sheets, google-slides, huggingface-skills, onedrive, robinhood, supabase
  and x.
  - Their MCP servers are contacted on every run (OAuth client registrations in
    `<home>/.cursor/projects/<slug>/mcp-auth.json`).
  - The GitHub plugin's tools were visible to the model through GetDynamicTools.
  - They can't be called: they're not in `allow`, and calls are rejected as with `other`.
  - No switch was found that stops them.

**Events** (stream-json):
- `{"type":"system","subtype":"init","apiKeySource":"login","cwd","session_id","model":"Composer 2.5","permissionMode":"default"}`
- `{"type":"user","message":{"role":"user","content":[{"type":"text","text"}]},"session_id"}`
- `{"type":"thinking","subtype":"delta"|"completed","text","session_id","timestamp_ms"}`
- `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text"}]},"session_id","model_call_id","timestamp_ms"}`
- `{"type":"tool_call","subtype":"started"|"completed","call_id","tool_call":{"<kind>":{"args","result"}},"session_id","timestamp_ms"}`.
  The kinds seen:
  - `mcpToolCall`:
    - `args`: `providerIdentifier`, `serverIdentifier`, `toolName`, `name: "holo-echo"`, `args`.
    - `result`: `success.content[{text:{text}} | {image:{data,mimeType}}]` with `isError`, or
      `permissionDenied`, `rejected`, or `error.error`.
  - `getMcpToolsToolCall`: `args.server`, `toolName` or `pattern`.
  - `shellToolCall`, `readToolCall`, `editToolCall`, `grepToolCall`, `globToolCall`,
    `readMcpResourceToolCall`.
- `{"type":"connection","subtype":"reconnecting","attempt","endpoint_url"}`
- `{"type":"result","subtype":"success","is_error","result","session_id","request_id","duration_ms","usage":{…}}`.
  `result` joins all the turn's assistant text (including lines like "Checking…"), so take the reply from
  our `finish` tool or the last `assistant` event.

**Tripwire:** abort on any `tool_call` other than `mcpToolCall` with `providerIdentifier: "holo"` and
`getMcpToolsToolCall`, and on any `permissionDenied` or `rejected` result.

**Images** (seen): the model named the colour.

**Resume** (seen).
- With the same private `HOME`, `--resume=<session_id>` kept the history.
- With a different `HOME` (or an unknown id), Cursor **silently starts an empty conversation under that id**,
  with no error. The private home must therefore live in the thread's workspace and never move.

**Timeouts** (seen). There's no setting in print mode. A 70 s tool call failed after exactly 60 s with
`error: "MCP error -32001: Request timed out"` (the MCP SDK default), and Cursor sent
`notifications/cancelled`. It sends no `progressToken`, so progress can't extend it.
(`--mcp-tool-timeout` exists only for `cursor-agent worker`.) **Every HO[LO] tool must answer within about
50 s.**

**Model and effort** (seen).
- `cursor-agent models` (read-only) lists ids that already carry the effort: `claude-opus-5-5-low`…`-max`,
  `gpt-5.6-sol-none`…`-max`, `grok-4.7-low`…`-xhigh`, `-fast` variants…
- Brackets: `composer-2.5[fast=true]` was accepted ("Composer 2.5 Fast").
  `composer-2.5[effort=high]` and `claude-opus-4-8[effort=low]` were refused before any model call
  (`Cannot use this model: … Available models: …`). The help's `[effort=…]` example doesn't hold.
- So effort is picked as part of the model id, and there's no separate effort.

**MCP handshake** (seen): `initialize` with protocol `2025-11-25`, client `Cursor`, one server process per run.
It sends `tools/call` with no `_meta`. It once tried `resources/read`; our `-32601` answer was fine.

**Many tools:** MCP tools reach the model through the two meta-tools (search, then call), not one by one. With 48
and with 96 tools, one GetDynamicTools for `holo` returned them all (see "Tool count").

**Sign-in.**
- `cursor-agent status --format json` exits 0 either way:
  - signed in: `{"status":"authenticated","isAuthenticated":true,"hasAccessToken","hasRefreshToken","userInfo":{…}}`;
  - signed out (seen with empty folders): `{"status":"unauthenticated","isAuthenticated":false,…,"message":"Not logged in"}`.
- `NO_OPEN_BROWSER=1 cursor-agent login` (source, not run) prints
  `Waiting for browser authentication...` and `Open a browser and navigate to this link: <url>`, then polls
  until the sign-in completes. There's no code to paste and no TTY needed. Run it with the user's own `HOME`
  and config, so it signs in where the terminal does.

**Update.** `cursor-agent about --format json` gives `cliVersion`, `latestStatus` (`update_available` or
`up_to_date`) and `latestVersion`. `cursor-agent update [--channel …]` installs.

**Startup and stopping** (seen).
- `init` comes 3–7 s after spawn when the per-project worker is already running, and 15–34 s cold (the first
  run in a new home also downloads plugins and skills).
- The CLI starts `index.js worker-server`. It listens on `<home>/.cursor/projects/<slug>/worker.sock`, outlives
  the CLI, and is reused by the next run.
- It's in the run's process group, so a process-group SIGTERM after the run (or on cancel) removes it and the
  MCP server. Seen: nothing left.

**What it writes:** everything goes under the private home (`projects/<slug>/`, `chats/`, `plugins/`,
`skills-cursor/`, `cli-config.json`), plus `NODE_COMPILE_CACHE` under `<home>/.cache`. The real sign-in file can
be refreshed by Cursor itself.

**Verdict:** sealed for what runs: only `holo` tools can be called; shell, file and web calls are denied or
absent. The caveats:
- it depends on two hidden flags (`--allowed-tools`, `--disable-auto-update`);
- the account's plugin MCP servers are still connected and visible, though not callable;
- the private `HOME` is verified on Linux only;
- tools must return within 60 s.

The adapter should run the init-time checks (the `cli.json` read back, `mcp list` showing `holo`) and mark
Cursor unavailable when they fail. What it does instead is the flag probe below.

**In the adapter** (`packages/agent/src/harness/cursor.ts`):
- **Linux only, so far.** On macOS and Windows Cursor is listed as unavailable, since the sign-in's place there
  hasn't been checked.
- **The flag probe.** Before Cursor is offered (once per version, remembered in `<root>/.harnesses.json`), the
  adapter runs `cursor-agent -p --output-format=stream-json --workspace=<probe> --trust --disable-auto-update
  --allowed-tools=holo_probe`, with no prompt and a private home of its own (`<root>/.cursor-home`). An unknown
  value makes Cursor list the valid ones before it does anything else. Cursor is offered only when that list has
  `mcp_tool_call` and `get_mcp_tools_tool_call`, so a version that drops or renames the hidden flag isn't used.
- **Signed out, the newest Cursor checks its sign-in first.** Cursor 2026.11.11-b912975, on a host where it isn't
  signed in, answers the probe with `Error: Authentication required. Please run 'agent login' first, or set
  CURSOR_API_KEY environment variable.` before it reads its options. An earlier adapter took that for a missing
  option ("This Cursor no longer takes the option that limits it to HO[LO]'s tools") and remembered it for the
  version, so signing in never cleared it. Now an authentication refusal (`cursorWantsSignIn`) reports Cursor
  signed out with its seal unknown (`sealUnknown`), and nothing is remembered: Settings shows **Sign in**, and
  the first look after it probes again. A probe that times out isn't remembered either. A "no" this adapter
  remembers carries `probe: 2`; one without it (an earlier adapter's) is probed again at the next look. A "no"
  for the version is also forgotten after a sign-in through Settings, and by **Look again**.
- Install: `curl https://cursor.com/install -fsS | bash` (`~/.local/bin/cursor-agent`).
- **The sandbox fallback.** A run starts with `--sandbox=enabled`. If Cursor answers
  `Sandbox mode is enabled but not available`, the adapter notes that for this version and runs the turn again
  with `--sandbox=disabled`, as every later run of that version does. A new version tries the sandbox again.
- The agent's instructions are the workspace's `AGENTS.md`. Cursor reads it when a conversation starts and
  not on resume (seen, 2026.11.11: rules changed between turns never showed up in the conversation's stored
  chat), so a resumed turn carries them at the head of its prompt (`rulesAtStartOnly`). A new conversation's
  prompt leaves them out, since `AGENTS.md` has them.
- Status (`status --format json`), models (`cursor-agent models`) and the update check (`about --format json`)
  run with the probe's private home. Sign-in (`login`, with `NO_OPEN_BROWSER=1`) and `update` run with the user's
  own home and config, so they sign in and update the Cursor the terminal uses, and only on a click.
- The tripwire also stops a run when one of HO[LO]'s own calls is refused: Cursor's permissions aren't as set.
- What a sealed run still does on its own (seen in a trace): it fetches its plugins (`cursor/plugins` and a few
  skills repositories) with `git fetch`, now over anonymous https with no ssh (see "Every harness's
  environment"), and its worker starts a TypeScript language server with `npx -y typescript-language-server
  --stdio`, which npm downloads into the private home on first use. Neither is offered to the model as a tool.

## Antigravity

Google's Antigravity CLI (`agy`), 1.5.13, on 2026-11-21, signed in with a free account.
Recorded by hand (the binary in a scratch folder with a HOME of its own, the stub MCP server of
`tools/agent-spike.mjs`), not with the spike tool. The cheapest model, `gemini-3.8-flash-low`.

**Google's terms.** Antigravity's FAQ says that "wrapping `agy` inside third-party coding agents or
applications" "is not supported under consumer plans", and that using third-party software with an
Antigravity sign-in can get the account suspended (Antigravity and Gemini CLI). HO[LO] runs the official
program, unmodified, and never reads its sign-in, but that's what the FAQ describes. So the studio asks
before Sign in and Use (Google's words, with a link to the FAQ), and the server never picks Antigravity by
itself: it runs only once it's chosen in Settings › Agent (`CHOSEN_ONLY` in `apps/server/src/agent/store.ts`).
Since June 2026 Gemini CLI no longer serves Google AI Pro, Ultra or free accounts, so Antigravity is the
only way a Google subscription reaches a coding agent.

**What it reads, and the private home.** Everything of the user's is under `~/.gemini`: settings
(`antigravity-cli/settings.json`), MCP servers (`config/mcp_config.json`), hooks, plugins, rules
(`AGENTS.md`, `GEMINI.md`, `config/rules/`), conversations. No flag or variable moves that folder or keeps
any of it out: `ANTIGRAVITY_GEMINI_DIR`, `ANTIGRAVITY_APP_DATA_DIR`, `JETSKI_APP_DATA_DIR` and
`ANTIGRAVITY_CONFIG_REL_DIR` changed nothing (seen with strace). So a run's `HOME` is `<ws>/home`, with
the XDG folders inside it, as Cursor's is.
- **The sign-in** is in the desktop's keyring (Secret Service, over the session bus: `DBUS_SESSION_BUS_ADDRESS`
  is passed, and `XDG_RUNTIME_DIR` stays the user's) or, without one, in
  `~/.gemini/antigravity-cli/antigravity-oauth-token` (mode 0600). The private home gets a link to that file
  in the user's home, made again before each run (a token renewed in there may replace the link with a
  file). HO[LO] never reads it. With a keyring the link points at nothing and isn't used.
- **Its sign-in has the `cloud-platform` scope**, besides the email and Antigravity's own.
- **No API key:** `GEMINI_API_KEY` (and `AGY_ADC_AUTH`) aren't passed. They'd need `"modelProvider": "gemini"`
  in settings anyway; HO[LO] runs on the subscription only.

**The seal.**
- **A custom agent:** `<ws>/.agents/agents/holo.md`, run with `--agent=holo`, with
  `excludeDefaultComponents: true` and `tools: []` (added in the changelog: "opt out of default prompt
  sections and built-in tools"), `subagent: false`, and the agent's instructions as its body (its system
  prompt; obeyed in a run). Asked to list its tools, the model named `mcp_holo_echo`, `mcp_holo_image`,
  `mcp_holo_slow`, `list_resources`, `read_resource` and `manage_task`, and its prompt fell from about 9,300
  input tokens to 880. Asked for a shell, a write and a web fetch, it said it has no such tools. `tools:`
  takes built-in names only: `mcp_holo_echo` and `call_mcp_tool` there are refused ("not found in registry").
- **HO[LO]'s tools up front:** each listed in the MCP config as `"tools": {"<name>": {"eager": true}}`. Left
  lazy, the model gets `call_mcp_tool` and reads each tool's schema with the built-in `read_file` from
  `~/.gemini/antigravity-cli/mcp/<server>/<tool>.json`, which the agent doesn't have. `"*"` doesn't work
  (the tools stay lazy), so the adapter names each of HO[LO]'s tools (`TOOLS`).
- **Settings for the run only** (`--settings=<json>`, never saved): `allow: mcp(holo/*)`, and `deny`
  `command(*)`, `read_file(*)`, `write_file(*)`, `read_url(*)`, `execute_url(*)`. Without the agent, they
  hold on their own: `run_command` was refused ("Matches user-configured deny rule"). Without the allow,
  HO[LO]'s calls are refused too (headless can't ask), listed in the result's `denied_actions`. An unknown
  settings key stops it at once (`--settings: unknown setting`).
- **`init` can't vouch for it:** it lists every built-in tool (about 60) whatever the agent has. So once per
  version the adapter runs a probe that costs nothing: an agent naming a tool no Antigravity has
  (`holo_probe_not_a_tool`) is refused before any model is asked ("unknown component: tool … not found in
  registry", exit 3, no tokens). That shows this version reads the workspace's agent and holds it to its
  `tools`, with the run's own switches and settings. A probe that isn't refused, or a settings key it no
  longer knows, leaves it unsealed.
- **The rest:** `--disable-slash-commands` (without it, a prompt starting `/model x` is taken as its command:
  "/model takes no arguments", exit 2); rules files in the folders above the workspace weren't read.
- **Tripwire** (`antigravityReader`): any tool step but `mcp_holo_*`, `call_mcp_tool` or the resource tools
  for the `holo` server, and `manage_task` (its own background tasks, of which it can start none); any
  `subagent_info`; any `denied_actions` (where a call Antigravity refuses shows, one of HO[LO]'s included:
  `antigravity-mcp-denied.jsonl`); an `init` whose `agent` isn't `holo`. A tool's own error (state `ERROR`,
  "No such track") isn't a trip, and its words are never read for one: until v0.9.25 an error that said
  "permission" was taken for a refusal, and HO[LO]'s own tools say `ask_permission` in theirs (`measure`
  of a song not bounced yet), which stopped a run that had done nothing wrong.

**The prompt.** `-p` takes the prompt as its value ("-p took "--output-format" as its prompt"), so it's
passed with `--input-format=stream-json` as one line, `{"event":"user","message":{"content":"…"}}`, and
stdin is closed: one turn, then it exits 0.

**The stream** (`--output-format=stream-json`): `{"event":"init","conversation_id",init:{model?,cwd,agent,tools,permission_mode}}`,
then `step_update` events (`step_index`, `state` `ACTIVE`/`DONE`/`ERROR`, `step_type` `user_input`,
`agent_response` with `text_delta`, `tool` with `tool_name` and `tool_info`, `system_message`, `unknown`),
then one `{"event":"result",result:{status,response,error?,denied_actions?,usage,…}}`. `status` is `SUCCESS`,
or `ERROR`, `CANCELED` and the like with `error`. A run refused before it starts (a model it doesn't know)
prints only the result and `error: …` and `AGY_ERROR: {…}` on stderr, and exits 1. An MCP image is offloaded
to a file in its conversation's folder (the step's output ends `[Resource offloaded to file://…/media_0.png]`)
and, when it is small, reaches the model too (it named the colour).

**Pictures.** Only a small picture reaches the model: Antigravity saves every picture a tool returns to
`<home>/.gemini/antigravity-cli/brain/<conversation>/.system_generated/steps/<n>/media_<k>.png` and gives
the model the picture itself only when its file is small. Measured on 1.5.15 with a stub server returning
PNGs of a coloured block, the model asked for the colour (the same on `gemini-4-neon` and
`gemini-3.8-flash`):

| Picture | File | Seen |
|---|---|---|
| 64×64, plain | 155 B | yes |
| 48×48, noise | 5,722 B | yes |
| 1560×700, plain | 7,699 B | yes (four at once, and 24 of 420×900 at once: all, in order) |
| 64×64, noise | 9,905 B | yes |
| 72×72, noise | 12,318 B | no |
| 90×90 to 1560×700, noise | 19 KB to 504 KB | no |

So the limit is the file's size, somewhere from 10 to 12 KB, whatever the picture's size in pixels or how
many come at once; each picture seen costs about 1,200 input tokens. No setting changes it (the changelog
says of `read_resource` that it "offloads every blob to disk and inlines only small text and image
resources"). A scan's zoomed part is 100 KB to 1 MB as a PNG in colour, so none ever reached the model: it
got the `[Resource offloaded …]` line and said it had no way to look.

- **Its file viewer can't be used.** With `tools: ["view_file"]` the model opens the saved picture by
  itself (a `read_file` step, "Showing binary file of type image/png") and sees it. But reading can't be
  held to that folder: without `read_file(*)` in `deny` it read a file beside the sign-in file and
  `/etc/hostname` (reads are allowed unless denied; an `allow` of `read_file(<folder>/**)` limits nothing);
  with the deny and that allow, the deny wins and the picture is refused too; `read_file(!<folder>/**)` is
  no negation. So the agent stays without it.
- **HO[LO] makes its pictures small instead.** The workspace's MCP config tells HO[LO]'s server the limit
  (`HOLO_PICTURE_BYTES`, 9,000: `ANTIGRAVITY_PICTURE_BYTES`). `scan_show` then gives a system's parts in a
  palette's few colours, cut narrower until each fits (docs/agent.md, "Reading a scan"), and the server
  leaves out any other picture past the limit (an attached photo) and says so in the tool's text, so the
  model reports it instead of guessing. Should Antigravity lower the limit, the model is back to
  `[Resource offloaded …]` lines: it says it can't see the pictures.

**Signed out.** `agy models` says "Please sign in to view available models" at once (exit 1). A print-mode
run doesn't: it starts its browser sign-in and waits, silently, with nothing on stdout or stderr (its log
says "triggering interactive OAuth"). So the probe runs only once `models` lists, the server refuses a
signed-out harness, and a run that prints nothing for two minutes is stopped ("may be waiting for a
sign-in"; `startup` in the adapter spec), never tried again without its session.

**Sign-in.** It has no `login` command; the TUI's needs a terminal (`bubbletea: could not open TTY`). The
ACP server's `authenticate` answers "No browser is available here … Run `agy acp --login` in a terminal".
`agy acp --login` needs no terminal: it prints "Open this link in a browser to log in with Google:", the
link (redirect `https://antigravity.google/oauth-callback`), then "Then paste the authorization code, or the
full URL of the page you land on, and press Enter:", and reads it on stdin (a bad one: "couldn't log in:
token exchange failed: …", exit 1). The link is about 700 characters (its client, challenge and six scopes),
longer than any other harness's: the server passes on sign-in links of up to 2,048. The page it lands on
shows the code alone, with "Copy to Clipboard", and takes it out of the address. Run with the user's own home, so it's the sign-in the terminal uses.
Asked while signed in, it starts a new sign-in; HO[LO] never asks then. No account name is given anywhere
but its logs and the token file, so the row says "Signed in" without one.

**Updates.** It updates itself in the background when it starts a session (`models`, a run, its ACP
server), unless `<home>/.gemini/antigravity-cli/last_check.timestamp` was touched less than 15 minutes ago
(its log: "skipping update (fast path)"). No flag, setting or variable turns that off, so the adapter
touches it in the private home before every run and probe. `agy update` updates on a click ("You are
already on the latest version"). The newest version is in the manifest `install.sh` reads,
`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/<os>_<arch>.json`
(`version`, `url`, `sha512`).

**Models and efforts.** `agy models` prints "Fetching available models..." then `slug<tab>Name` lines, which
follow the account's plan (a free account: `gemini-3.8-flash-high`, `-medium`, `-low`, `claude-sonnet-4-6`,
`claude-opus-4-6-thinking`, `gpt-oss-120b-medium`). The variants of a model that differ only by their
ending (`low`, `medium`, `high`, `xhigh`, `max`, `--effort`'s values) are one model in the picker, with
those efforts. A run with an effort passes the variant's own name (`--model=gemini-3.8-flash-low`); one
without, the family's (`--model=gemini-3.8-flash`, which runs; so does `gpt-oss-120b --effort medium`). A
variant with another `--effort` is refused ("conflicts with --effort=low"), and so is an unknown model,
with the list (exit 1).

**Schemas.** Gemini refuses the whole request if any tool's schema has a list whose items have no type
("…properties[parts].items: missing field", 400): `import`'s `parts` (names or numbers) had none. It's a
list of text now (a number among it is taken as text, and the import reads "2" as the second part), and
a test keeps every list's items typed. Objects without listed properties are accepted. With that, a run
with HO[LO]'s own MCP server had all its tools and called `song_status`.

**Resume.** `--conversation=<id>`, in the same private home: it remembered a number. An unknown id prints
`warning: conversation "…" not found` and starts a new conversation, whose id the `init` gives.

**Stop.** Its process group is `agy` and the MCP server; SIGTERM ends both. Nothing outlived it.

**Caveats.**
- The consumer-plan terms, above.
- A HO[LO] MCP server that can't start isn't in the stream or the log: the model just answers that it has
  no such tool. So HO[LO]'s server marks the workspace at its first `initialize` (`HOLO_MCP_READY_FILE`,
  set in Antigravity's MCP config only; `.holo-mcp-ready`, removed before each run), and a run that used
  none of HO[LO]'s tools without the mark fails: "HO[LO]'s tools didn't start in Antigravity, so it
  answered without them". The server starts before the model is asked (its tools are in the first
  request: with the server gone, the model didn't have them, cached schemas or not).
- Linux only, so far: on macOS the keyring and the private home are unchecked.
- **A refused conversation stays refused.** Seen on 2026-11-22: a resumed turn's result was
  `ERROR`, "INVALID_ARGUMENT (code 400): Request contains an invalid argument.", with nothing more.
  Its log showed the reply streaming (the model had written several tool calls, some with an
  object's keys wrapped in quotes, names with a space) and the 400 coming at its end, before any call
  ran. The next turn, carried on with another request, was refused the same way on its first reply.
  So a refused request isn't carried on: docs/agent.md, "Ending early". (A turn stopped mid-reply
  isn't one: Antigravity leaves the stopped step out of what it sends next, and the conversation
  went on.) How each harness says one: "A refused conversation", below.

## A refused conversation

A conversation the model service refused outright isn't carried on (docs/agent.md, "Ending early").
`refusedRequest` in `packages/agent/src/harness/adapter.ts` knows one by the start of the error in the
harness's own result, never a tool's answer, the model's words or stderr. Checked on 2026-11-22.

**How it was seen.** Antigravity's in real use. Claude Code's and Codex's by running each as a sealed run
is (the adapter's argv, output format and environment switches, an empty config folder of its own, HO[LO]'s
server replaced by a one-tool stand-in) against a stand-in for its model API on 127.0.0.1 that answered as
the real API answers each case: a 400 for a broken history, for an invalid argument and for a prompt too
long, and for contrast low credit, a 401, 403, 404, 429 and 529 (for Codex also a quota, a model a ChatGPT
plan doesn't have, and the context-window error inside a stream that began well). Claude Code was pointed at
it with `ANTHROPIC_BASE_URL` and a dummy `ANTHROPIC_API_KEY`; Codex with `-c model_provider=…` and a provider
of its own (`OPENAI_BASE_URL` isn't read: that first try reached the real API, whose 401 for a dummy key reads
just as the stand-in's does). The versions run were Claude Code 2.1.322 and Codex 0.167.1; for 2.1.330 and
0.171.0 the same code was read in Claude Code's strings and Codex's source, not run. A stand-in can't show
Cursor's or Antigravity's: Cursor's words for an error come from its own server, and Antigravity asks nothing
without a Google sign-in. Their programs were read instead.

**Claude Code** (2.1.322 run, 2.1.330's strings the same). The `result` has `is_error: true`,
`api_error_status` (the HTTP status) and `result`, its own words, never the API's JSON:
- a broken history: `API Error: 400 due to tool use concurrency issues.` (a `tool_use` without its
  `tool_result`; it repairs the history and asks again first), `API Error: 400 orphaned tool_result in
  conversation history.`, `API Error: 400 duplicate tool_use ID in conversation history.`;
- any other 400: `API Error: 400 ` and the API's message, such as `API Error: 400
  messages.1.content.1.tool_use.input: Input should be a valid dictionary` or an invalid thinking signature;
- too long: `Prompt is too long` (with ` · the request is ~N tokens (limit M) …` when it can measure), or for
  the request's bytes (a 413) `Request too large (max 32MB). Accumulated images and attachments …`. Said only
  once it couldn't compact the conversation to fit: the recorded run says `status: compacting`, then
  `compact_result: failed`, then the error. Carried on, the next request is as long: these count too.
- ordinary: `Credit balance is too low` (a 400 as well), `Invalid API key · Fix external API key` and
  `Failed to authenticate. API Error: 403 …`, `There's an issue with the selected model (…). It may not exist
  or you may not have access to it. …` (a 404), `API Error: Request rejected (429) · …`, `API Error: 529
  Overloaded. …`, `Your ANTHROPIC_API_KEY belongs to a disabled organization · …`, and a 400 about the
  account or the model in the API's words (`API Error: 400 invalid model name`, `… organization has been
  disabled`), which `ORDINARY` excludes by phrase;
- not one: `API Error: an image in the conversation could not be processed and was removed. …`: it took the
  picture out itself, so the conversation can go on.

So the pattern is `API Error: 400 `, `Prompt is too long` or `Request too large`, first. The earlier guess,
`API Error: 400` with `"type":"invalid_request_error"` in the text, matched none of these.

**Codex** (0.167.1 run, 0.171.0's source the same). `turn.failed`'s `error.message` is its error's text:
- a 400 is the only status it shows as the API's own body, as it came (`CodexErr::InvalidRequest(body_text)`
  in `codex-api/src/api_bridge.rs`): `{"error":{"message":"No tool output found for function call
  call_….","type":"invalid_request_error","param":"input","code":null}}`, and an invalid argument the same
  with its `param` and `code`. Over the WebSocket a ChatGPT sign-in uses, it's the error event as it came:
  `{"type":"error","status":400,"error":{"type":"invalid_request_error",…}}` (recorded too, with the stand-in
  answering on a WebSocket: `supports_websockets` on the provider; `responses_websocket.rs` hands the event on
  as the body). An older Codex put `unexpected status 400 Bad Request: ` first, still matched;
- any other status: the message alone, with its address and ids: `unexpected status 401 Unauthorized:
  Incorrect API key provided: …, url: …, request id: …`, ``The model `…` does not exist or you do not have
  access to it.`` (404, and 403), `Quota exceeded. Check your plan and billing details.`, `exceeded retry limit,
  last status: 429 Too Many Requests, request id: …`. A model a ChatGPT plan doesn't have is a raw 400 too,
  `{"detail":"The '…' model is not supported when using Codex with a ChatGPT account."}`, but no
  `invalid_request_error`: ordinary;
- the context window: `Codex ran out of room in the model's context window. Start a new thread or clear
  earlier history before retrying.`, from a `response.failed` with `context_length_exceeded`, and in 0.171.0
  from a 400 with that code as well. Not one the first time: Codex records the context as full in the
  thread, and at the next turn, resumed or not, compacts the conversation before its first request,
  dropping the oldest items if even that overflows (`core/src/session/turn.rs`, `core/src/compact.rs`), so
  the thread should recover. That the full context is recorded when a turn overflows isn't confirmed by a
  run, so a resumed run that fails so again in the conversation the last run failed so in counts
  (`refusedIfRepeated` in the adapter spec: the runner notes that conversation in the workspace,
  `.holo-failed-once`, and any other outcome clears it). 0.167.1 shows that 400 raw
  (`"code":"context_length_exceeded"`) and marks nothing: that counts at once.

So the pattern is a JSON body that says `"type":"invalid_request_error"`, or `unexpected status 400 Bad
Request: ` and anything after it. Neither version writes the second for a 400, but every other status is
written so, with the body's message (and an older Codex wrote a 400 so, with the body): if a later one
writes a 400 that way too, its refusals still count. `ORDINARY` keeps the account's, the plan's and the
model's, and a refused sign-in (`, auth error: …`, which Codex adds). The earlier guess needed that prefix
and the JSON both, which 0.167.1 and 0.171.0 never write for a 400.

**Cursor** (2026.11.11-043ef28, and 2026.11.22-e9042b2, read in their bundles). A failed run writes no
`result` (the ones it writes all say `is_error: false`): print mode prints the error as `String(error)` on
stderr and exits 1. The error's words are Cursor's server's own (a title and a detail, with an error type:
`BAD_REQUEST` and `CONVERSATION_TOO_LONG` among them), and one for a refused conversation hasn't been seen.
So none of its failures counts: there's no error in its stream to go by, and a pattern for its stderr would
be a guess. It summarizes its own context when it grows (a failure there says "Context summarization
failed").

**Antigravity** (1.5.14). The `result` has `status: ERROR` and `error` `INVALID_ARGUMENT (code 400): Request
contains an invalid argument.` (seen in real use, under "Caveats" above). Its form is `%s (code %d): %s`,
the API's status name first: a location the API doesn't serve is `FAILED_PRECONDITION (code 400)`, a quota
`RESOURCE_EXHAUSTED (code 429)`. How it says a conversation too long for the model hasn't been seen (it
compacts its conversation itself); one that reaches the result as an `INVALID_ARGUMENT` counts like the rest.

## Tool count

Can the agent have more than 40 tools? Tried on 2026-11-12 with `tools/agent-spike-tools.mjs`: Claude Code
2.1.322, Codex CLI 0.167.1, Cursor CLI 2026.11.11-043ef28.

- **The server:** N tools, `tool_01`…, each answering `ok-NN-<nonce>` (a new nonce each time the server
  starts). Descriptions and schemas are padded to the sizes of HO[LO]'s 38 real tools, cycled. So 48 tools are
  43.0k characters of `tools/list` (HO[LO]'s 38 are 35.4k), and 96 are 87.1k.
- **The runs:** each harness ran sealed, with the adapters' own argv, environment and workspace files, imported
  from `packages/agent/src/harness`. Two differences: no agent instructions, and Codex with `--ephemeral`.
  Neither changes the tools. The models were the cheapest, as in C0. One prompt: count the holo tools, call the
  last two, say what they returned. The server's log shows each call.

| | Claude Code (`haiku`, low) | Codex (`gpt-6-luna`, low) | Cursor (`composer-2.5`) |
|---|---|---|---|
| 48 tools: seen | 48 (`init` listed 48) | 48 | 48 (one GetDynamicTools returned all) |
| `tool_45`, `tool_48` | called; both answers reported | called; both reported | called; both reported |
| 96 tools: seen, `tool_93` and `tool_96` | 96; both called and reported | 96; both | 96; both (one GetDynamicTools, 87k characters) |
| Warnings about the tool count | none | none | none |

What the tools cost differs:
- **Claude** sends every tool in every request: about 18.2k prompt tokens with 48 tools and 33.3k with 96, so
  about 315 tokens per tool of HO[LO]'s weight.
- **Codex** (code mode) never lists MCP tools in the prompt, at any count (3 or 48, in `debug prompt-input`). It
  calls them "deferred nested tools", and the model finds them in `ALL_TOOLS`. Its prompt stayed the same size
  (24k and 23k input tokens).
- **Cursor** brings them in when the model looks them up: GetDynamicTools without a tool name returned every
  description and schema (16k and 32k input tokens).

**Verdict:** no limit up to 96 in any harness, so the cap can rise to 48 with twice that in reserve. The
`--disable-auto-update` flag kept Cursor at its version, and the settings and sign-in files were unchanged.

## Effects on `docs/agent.md` and the plan

1. **Long tool calls.** Cursor kills any MCP call at 60 s. `POST …/listen {maxMs}` up to 180 s doesn't fit.
   Either cap every tool at about 50 s and let `listen` return `{notes, more:true}` so the agent calls it again,
   or split long waits into start and poll. Claude (per-server `timeout`) and Codex (`tool_timeout_sec`) can
   be set to 240 s. *Done:* a listen comes in parts of at most 40 s (`{notes, done, part, pending}`), heard
   as one by the server; the tool says "call listen again" between parts.
2. **Cursor's sandbox** can't be required. Use "`--sandbox enabled` where it starts" (the adapter tries it, and
   falls back per version; see Cursor's "In the adapter").
3. **Cursor's environment** isn't the shared allowlist. Add `HOME=<ws>/home`, `XDG_CONFIG_HOME` (the real one,
   Linux) and `CURSOR_CONFIG_DIR=<ws>/home/.cursor`, plus the hidden `--disable-auto-update` and
   `--allowed-tools`. The workspace layout gains `home/`, which must persist for resume.
4. **Codex** needs `default_tools_approval_mode="approve"`,
   `features.multi_agent_v2.disable_native_tools=true` and the `--disable` list. Its tripwire is the item-type
   allowlist plus stderr, not "any `command_execution`". `--ephemeral` must not be used.
5. **Effort.**
   - Claude: `low…max`, checked by us, since a bad value is ignored silently.
   - Codex: from `codex debug models`, per model.
   - Cursor: none. `HarnessInfo.efforts` is empty and the model ids carry the effort.
6. **`mcp.ts`** must:
   - accept string ids;
   - answer unknown methods (Claude's `server/discover`, Cursor's `resources/read`) with `-32601`;
   - speak `2025-11-25` and `2025-06-18`;
   - ignore `_meta`;
   - expect `notifications/cancelled`.
7. **Sign-in relays differ.** Only Claude needs the pasted code (`POST …/login/code` → stdin as `code#state`).
   Codex shows a URL and a one-time code (`--device-auth`). Cursor shows a URL and polls.
8. **Update checks.**
   - Claude: `downloads.claude.ai/claude-code-releases/<channel>`, with the channel from `claude doctor`. The
     adapter reads the `stable` channel (npm's `stable` tag for an npm install), which an install on either
     channel can reach.
   - Codex: npm or GitHub. The adapter reads npm.
   - Cursor: `about --format json`.

   All three updaters run only on a click. `DISABLE_AUTOUPDATER=1` and `--disable-auto-update` keep agent runs
   from updating, and `check_for_update_on_startup=false` keeps a Codex run from looking.
9. **Codex's `-c` values show in `ps`.** This confirms the plan: the job token stays in `.holo-job`.
10. **The "checksums unchanged" check** applies to settings files. `~/.claude.json` is rewritten by Claude Code
    on every run (caches only), and transcripts in `~/.claude/projects` and `~/.codex/sessions` are how resume
    works.

## Side effects of this spike on this machine

- **The Cursor CLI updated itself** from 2026.11.10-731fb78 to 2026.11.11-043ef28 during the first full run,
  before `--disable-auto-update` was used. `~/.local/bin/cursor-agent` and `agent` now point to the new
  version; the old one is still on disk.
- **`~/.cursor/cli-config.json` changed.** Two early runs used the real `HOME`, and Cursor saved `composer-2.5`
  as the default model (`model`, `selectedModel`, `modelSelectionHistory`, `modelParameters`, `maxMode`,
  `privacyCache` added; `hasChangedDefaultModel` false → true). To go back to Auto, pick Auto once with `/model` in an
  interactive `cursor-agent` session, or remove those keys.
- **`~/.config/cursor/cli-config.json` was created** (Cursor's default config) by a test with `XDG_CONFIG_HOME`
  set and no `CURSOR_CONFIG_DIR`. Cursor doesn't read it while `XDG_CONFIG_HOME` is unset, and it can be
  deleted.
- **Harness state from the runs:**
  - `~/.claude/projects/<spike-workspace-slug>/`;
  - `~/.codex/sessions/2026/11/11/rollout-*.jsonl`, plus Codex's SQLite, cache and plugin-cache files;
  - `~/.cursor/projects/<spike-workspace-slug>/` and `~/.cursor/chats/<id>/` (the two early runs);
  - `~/.cache/holo/agent-spike/`.

## Fixtures

All are in `packages/agent/test/fixtures/`.

| File | Run |
|---|---|
| `claude-normal.jsonl` | echo + image, final answer (session reused by the next) |
| `claude-resume.jsonl` | resume of that session |
| `claude-shell.jsonl` | asked for `ls ~` and `/etc/hostname`: no tools to try, says so |
| `claude-shell-denied.jsonl` | built-in tools left on (not our argv): `Bash` and `Read` denied by `dontAsk` |
| `claude-timeout.jsonl` | `slow 8000` with a 3 s server timeout |
| `codex-normal.jsonl` | echo + image, final answer |
| `codex-resume.jsonl` | resume of that thread |
| `codex-shell.jsonl` | asked for a shell, a read and a write: lists its tools, does nothing |
| `codex-write-rejected.jsonl` | forced `apply_patch`: refused (the refusal shows only on stderr) |
| `codex-mcp-approval-required.jsonl` | without `default_tools_approval_mode`: both MCP calls fail |
| `codex-timeout.jsonl` | `slow 8000` with `tool_timeout_sec=3` |
| `cursor-normal.jsonl` | echo + image, final answer |
| `cursor-resume.jsonl` | resume of that session |
| `cursor-shell.jsonl` | asked for a shell, a read and a write, with `--allowed-tools`: no such tools |
| `cursor-shell-denied.jsonl` | the same without `--allowed-tools`: shell, read and edit denied by `cli.json` |
| `cursor-other-server-rejected.jsonl` | a second loaded server not in `allow`: call rejected |
| `cursor-timeout.jsonl` | `slow 70000`: cut at 60 s |
| `antigravity-normal.jsonl` | echo + image, final answer, as the `holo` agent |
| `antigravity-resume.jsonl` | `--conversation` of an earlier one: "what number did I ask you to remember?" |
| `antigravity-shell-denied.jsonl` | asked for `ls /` without the agent: `run_command` refused by the deny rule |
| `antigravity-mcp-denied.jsonl` | no agent, no settings, lazy tools: `read_file` of a schema, then `call_mcp_tool` refused (`denied_actions`) |
| `antigravity-bad-model.jsonl` (and `.stderr.txt`) | an unknown `--model`: refused before it starts, with the list |
| `antigravity-probe.jsonl` (and `.stderr.txt`) | the seal probe: the agent's made-up tool refused, no tokens |
| `antigravity-slash.jsonl` | `/model x` as the prompt, without `--disable-slash-commands`: taken as its command |
| `claude-refused-history.jsonl` | stand-in API: a tool call, then a 400 for a `tool_use` without its `tool_result` |
| `claude-refused-invalid.jsonl` | stand-in API: a 400 for an invalid argument, before any tool |
| `claude-refused-too-long.jsonl` | stand-in API: a tool call, then "prompt is too long"; compacting fails too |
| `claude-credit.jsonl` | stand-in API: a 400 for low credit |
| `claude-unauthorized.jsonl` | stand-in API: a 401 for the key |
| `claude-model-missing.jsonl` | stand-in API: a 404 for the model |
| `claude-rate-limited.jsonl` | stand-in API: a 429 |
| `codex-refused-tool-output.jsonl` | stand-in API: a 400, "No tool output found for function call …" |
| `codex-refused-invalid.jsonl` | stand-in API: a 400 for an invalid argument |
| `codex-refused-too-long.jsonl` | stand-in API: a 400, `context_length_exceeded` (shown raw by 0.167.1) |
| `codex-context-window.jsonl` | stand-in API: `response.failed` with `context_length_exceeded` in a 200 stream |
| `codex-quota.jsonl` | stand-in API: a 429, `insufficient_quota` |
| `codex-unauthorized.jsonl` | stand-in API: a 401 for the key |
| `codex-model-chatgpt.jsonl` | stand-in API: a 400 `{"detail":…}`, a model a ChatGPT plan doesn't have |
| `codex-model-missing.jsonl` | stand-in API: a 404 for the model |
| `codex-rate-limited.jsonl` | stand-in API: a 429, until its retries ran out |
| `codex-refused-websocket.jsonl` | stand-in API over a WebSocket: a 400 error event, "No tool output found …" |

The Claude shell fixtures were recorded with an earlier prompt (`ls ~` and `/etc/hostname`, no write). The
Claude fixtures predate `--settings`, so their `init` still has `memory_paths`. `cursor-shell-denied.jsonl` and
`cursor-other-server-rejected.jsonl` were recorded without `--allowed-tools`. `antigravity-shell-denied.jsonl` and
`antigravity-mcp-denied.jsonl` were recorded without the agent (their `init` has no `agent`: the tripwire stops
them there; the tests run them as the agent to reach the tool). The `claude-refused-*`, `claude-credit` and the
like (Claude Code 2.1.322) and `codex-refused-*`, `codex-quota` and the like (Codex 0.167.1) were recorded
against a stand-in for the model API ("A refused conversation"), with a one-tool stand-in for HO[LO]'s server
(`song_status`); their paths are made neutral. A Codex run refused after one of HO[LO]'s calls is the recorded
refusal with the recorded normal run's call put first, and one refused as `unexpected status 400 Bad Request: …`
is a recorded run with its error written in that form.
