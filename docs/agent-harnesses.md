# Running the harnesses sealed

This page records what step C0 of the agent plan found by running each harness headlessly with one MCP
server of ours as its only tools. The adapters in `packages/agent/src/harness/` follow it.

- **Where:** Linux x64, 2026-11-11. Claude Code 2.1.322, Codex CLI 0.167.1, Cursor CLI 2026.11.10-731fb78
  (it updated itself to 2026.11.11-043ef28 during the spike; see Cursor below).
- **How:** `tools/agent-spike.mjs`. It has a stub MCP server (`echo`, `image` returning a 64×64 PNG of one
  colour, `slow {ms}`) and runs a harness once in `${XDG_CACHE_HOME:-~/.cache}/holo/agent-spike/<harness>`,
  prompt on stdin, saving the raw stream. Cheapest models: Claude `haiku` (one `sonnet` run), Codex
  `gpt-6-luna` at low effort, Cursor `composer-2.5`.
- **Recordings:** `packages/agent/test/fixtures/<harness>-*.jsonl`, sanitized (home folder as `~`, user name as
  `user`, image data trimmed). They're listed at the end.

"Seen" below means observed in a run. "Source" means read in the harness's own bundled code, not run.

## Summary

| Check | Claude Code | Codex | Cursor |
|---|---|---|---|
| Only our MCP tools | Yes: `--tools=` removes every built-in tool; `init` lists only `mcp__holo__*` | Nearly: no shell, file read, web or apps; `apply_patch` remains but is refused (read-only sandbox, approvals never) | Yes, with the hidden `--allowed-tools`: the model gets only GetDynamicTools and CallDynamicTool |
| User's MCP servers kept out | Yes (`--strict-mcp-config`; claude.ai connectors off) | Yes (`--ignore-user-config`; none configured here to prove it) | Only with a private `HOME`; account-enabled plugins' servers still connect and are visible, but calls are rejected |
| Shell/read attempt | Nothing to call; with built-ins on, `dontAsk` denies at once | Nothing to call (`exec_command` gone); a forced write is refused | Denied by the workspace `cli.json`, no hang, no `--force` |
| Tool calls run without a prompt | `--allowedTools=mcp__holo__*` | needs `default_tools_approval_mode="approve"` | `--approve-mcps` plus `allow: Mcp(holo:*)` |
| Prompt on stdin | Yes (`-p`, no argument) | Yes (`-`) | Yes (`-p`, no argument) |
| The agent's instructions | `--append-system-prompt-file` | the workspace's `AGENTS.md`, after the user's global `$CODEX_HOME/AGENTS.md` | the workspace's `AGENTS.md` |
| Session id | `init.session_id` | `thread.started.thread_id` | `init.session_id` |
| Resume | `--resume=<id>`: works | `exec resume … <id> -`: works; `--ephemeral` breaks it | `--resume=<id>`: works only with the same private `HOME` |
| MCP image reaches the model | Yes (named the colour) | Yes | Yes |
| MCP tool timeout | per-server `"timeout"` (ms) in the MCP config | `mcp_servers.holo.tool_timeout_sec` | **fixed at 60 s** in print mode |
| Model / effort | `--model=<alias>` `--effort=<low…max>` | `--model=<id>` `-c model_reasoning_effort="…"` | effort is part of the model id |
| Signed-in check | `claude auth status` (JSON, exit 0/1) | `codex login status` (stderr text, exit 0/1) | `cursor-agent status --format json` (exit 0 both) |
| Sign-in without a TTY | URL printed, pasted `code#state` on stdin (source) | `codex login --device-auth`: URL + one-time code (source) | `NO_OPEN_BROWSER=1`: URL printed, then polls (source) |
| Check for an update without installing | the `stable` channel file on downloads.claude.ai | npm registry / GitHub releases | `cursor-agent about --format json` |
| Updates itself during a run | not with `DISABLE_AUTOUPDATER=1` | not seen | **yes, unless `--disable-auto-update`** |
| Startup to first event | 0.3–0.5 s | 0.06–0.5 s | 3–7 s warm, 15–34 s cold |
| Stop | process-group SIGTERM: all gone | same | same; also needed after a normal exit (worker daemon) |
| Verdict | **Sealed** | **Sealed, with caveats** | **Sealed, with caveats** |

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
- Models: the aliases `--help` names for `--model`, plus `sonnet`, `opus` and `haiku`. An effort outside
  `low…max` is left out of the run.
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

## Codex

**Command** (prompt on stdin):

```
codex exec --json --skip-git-repo-check --ignore-user-config --ignore-rules
  --model=<id> -c model_reasoning_effort="<effort>"
  -c sandbox_mode="read-only" -c approval_policy="never" -c web_search="disabled"
  -c features.multi_agent_v2.disable_native_tools=true
  -c check_for_update_on_startup=false -c project_root_markers=[]
  -c mcp_servers.holo.command="<node>" -c mcp_servers.holo.args=["<mcp.ts>"]
  -c mcp_servers.holo.env={NAME="value"}
  -c mcp_servers.holo.tool_timeout_sec=240 -c mcp_servers.holo.startup_timeout_sec=20
  -c mcp_servers.holo.default_tools_approval_mode="approve"
  --disable shell_tool --disable unified_exec --disable apps --disable plugins --disable remote_plugin
  --disable browser_use --disable browser_use_external --disable in_app_browser --disable computer_use
  --disable image_generation --disable multi_agent --disable hooks --disable goals --disable view_image
  --disable tool_suggest --disable skill_search --disable skill_mcp_dependency_install
  --disable workspace_dependencies --disable shell_snapshot --disable plugin_discovery_prefetch --disable sleep_tool
  --sandbox=read-only --cd=<ws> -
```

**Resume:**

```
codex exec resume <the same options, without --sandbox and --cd> <thread id> -
```

`exec resume` takes neither `-s` nor `-C`. The `-c sandbox_mode` and the spawn's working folder cover them.
Values given with `-c` show in `ps`: never put the job token there. Our server reads it from `.holo-job`.

**Why each switch** (all seen):
- **Inspecting without spending.** `codex debug prompt-input -c … --disable … "hi"` prints the tools and
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
- **`features.multi_agent_v2.disable_native_tools=true`** removes the `collaboration.*` sub-agent tools
  (`spawn_agent`…). `--disable multi_agent` alone only does that for v1 models such as `gpt-5.6-luna`.
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
- The agent's instructions are the workspace's `AGENTS.md` (mode 0600).
- **The seal is checked once per version**, remembered in `<root>/.harnesses.json`: `codex debug prompt-input`
  with the run's `-c` settings and `--disable` list, in an empty `CODEX_HOME` of its own (`<root>/.codex-probe`,
  so none of the user's config or MCP servers is read or started). Codex is offered only when the model's tools
  are code mode's own (`exec`, `wait`, `request_user_input`, `request_user_input_async`) and, reached through
  `exec`, `apply_patch`, `clock__curr_time`, the three MCP resource tools and `mcp__holo__*`.
- Models: those `codex debug models` lists as visible (`--bundled` when it can't fetch them), each with its
  efforts, read once per version and every 6 hours. `ultra` isn't offered: it hands work to sub-agents, which a
  sealed run doesn't have.
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

**Many tools:** MCP tools reach the model through the two meta-tools (search, then call), not one by one. No cap
showed, but more than 3 tools wasn't tried.

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
- **The sandbox fallback.** A run starts with `--sandbox=enabled`. If Cursor answers
  `Sandbox mode is enabled but not available`, the adapter notes that for this version and runs the turn again
  with `--sandbox=disabled`, as every later run of that version does. A new version tries the sandbox again.
- The agent's instructions are the workspace's `AGENTS.md`.
- Status (`status --format json`), models (`cursor-agent models`) and the update check (`about --format json`)
  run with the probe's private home. Sign-in (`login`, with `NO_OPEN_BROWSER=1`) and `update` run with the user's
  own home and config, so they sign in and update the Cursor the terminal uses, and only on a click.
- The tripwire also stops a run when one of HO[LO]'s own calls is refused: Cursor's permissions aren't as set.

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

The Claude shell fixtures were recorded with an earlier prompt (`ls ~` and `/etc/hostname`, no write). The
Claude fixtures predate `--settings`, so their `init` still has `memory_paths`. `cursor-shell-denied.jsonl` and
`cursor-other-server-rejected.jsonl` were recorded without `--allowed-tools`.
