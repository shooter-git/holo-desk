# The bar and the agent: how they work

The **bar** (Ctrl /, the slash button in the control bar, or a swipe down on a phone's top bar; Escape,
a press outside it or, on a touch screen, a swipe up on it closes it) is HO[LO]'s command palette. When
the **agent** is turned on in Settings › Agent and this device is allowed to use it, the bar also takes
requests in plain words, with files dropped or pasted on it. The agent carries them out on the open song
through a harness installed on the host: Claude Code, Codex, Cursor or Antigravity.

On a desktop with the agent off the bar is a card that drops from the top: it only finds commands, so
it's as small as what it finds. On a phone or a tablet, and on a desktop with the agent on for this
device, the same openers bring up **the page** instead, with the song's whole conversation ("The page",
below): a desktop's is a dock down the right side, which slides in and out beside the studio.

This page is the contract between the studio, the server, the runner and the agent's tools.

## What doesn't change, and the terminal

The `holo` command, the `holo` skill and `pnpm skill:install` are how HO[LO], holo-packs and creations
are developed from a terminal (Claude Code, Codex or Cursor working through `holo`), and how music is
made there for creations. The terminal has everything the agent has, and more; what it already did
doesn't change:
- every `holo` command keeps what it does and what it prints, the "AI" author of its changes included;
  new commands and flags are additions;
- the HTTP routes the CLI uses (`/api/projects/:id/ops` and the rest) work as they did, and the
  runner's render path is untouched; the terminal's new routes are additions (below);
- `pnpm skill:install` (`tools/install-skill.mjs`) installs the skill as it did; it never touches the
  user's harness configuration.

The commands that do what the agent's tools do (`holo regions`, `notes`, `timeline`, `measure`,
`played`, `capture`, `details`, `import`, `packs`, `holo listen --analyze`, and `holo tool NAME` for any tool by name;
`packages/cli/src/tool-commands.ts`) run the agent's own tools, through a `JobApi` over the CLI's routes
(`packages/cli/src/terminal-api.ts`): the song as saved, changes through `/api/projects/:id/ops` (one
undo step, "AI: …"), the studio's playhead and selection from `/api/live/state`, what was just played
from `GET /api/live/played`, measurements from `/api/projects/:id/measure` (below), and files on the
terminal's computer where the agent takes attachments. A tool's words about its fields are said as
flags. `packages/cli/src/parity.ts` maps every tool to its commands, or says why it belongs to a
request in the bar (`compare`, `attachment_get`, `look`, `ask_permission`, `hand_off`, `version`, `finish`); its
test fails when a tool has neither. The agent gets nothing of this: its tools reach HO[LO] only through
the job routes.

The in-app agent lives in `packages/agent` (`@holo/agent`): the runner's side (`src/runner.ts`,
`src/harness/`), the MCP server (`src/mcp.ts`) and its tools (`src/tools/`). The server's side is
`apps/server/src/agent/`. It never reads or writes the user's own harness configuration (`~/.claude`,
`~/.codex`, `~/.cursor`, `~/.gemini`).

## Rules

- **The open song only.** The agent changes only the song the requesting studio has open. It never
  touches HO[LO]'s code, `packs.lock.json`, holo-packs, a creation's code or engine, or any other file.
  Asked to, it writes a brief for the user's harness in that repository (`hand_off`). A brief is only for
  a change to HO[LO] Desk's code, holo-packs or a creation: asked to read or send files, keys, passwords,
  tokens or anything else, the agent refuses in its reply, with no brief.
- **Tools, not trust.** The harness gets HO[LO]'s MCP tools only: no shell, no file tools, no web, none
  of the user's MCP servers. Every tool call goes through `/api/agent/jobs/:job/*`, which checks the job
  token and that the job is running.
- **Data, not instructions.** Names in the song, scans, attachments and what was played are material.
  Only the request and `packages/agent/AGENT.md` tell the agent what to do.
- **Only `finish` reaches the user.** Every turn ends with it, a question's too: a reply of a sentence
  or two of plain text, and the details in the view. What the harness writes in its own chat isn't
  shown. A turn that ends without `finish` is carried on once, in the same conversation, asking for it;
  only when that doesn't bring it are the harness's last words a plain stand-in (`agent-done`, below).
- **Asking ends the turn.** What only the user can allow (a pack, sending to a creation, a screenshot,
  a photo, a recording) is asked with one button; the user's click starts the next turn.
- **They press play.** The agent shows its work under its reply, in a view it composes (below): buttons
  that play or compare versions, switches, sliders, lists of places to go; when they'll have something to
  decide while they listen, a dock of the few controls they'll reach for then (most replies need none).
  It doesn't start playback or move the user's view, selection or playhead itself, unless the request
  was to see or hear something now (`go` on `finish`, the transport).
- **One request, one undo step.** It's labeled "Agent: …". Its changes reach only the requesting
  device's studio: live while it's there, and while it's away (a phone in another app, the tab closed)
  saved on the server, for it to pick up as that step when it's back.
- **The user may leave.** A request goes on while they're away, and its reply waits for them. What
  needs their studio in front of them (playing, listening) is refused meanwhile, saying so, and goes in
  the reply's view.
- **Off by default.** With the agent off, `GET /api/agent` answers `{enabled:false, …}`, the studio shows
  nothing of it, and the runner runs no harness and fetches nothing: it looks for harnesses only once
  the server says `agent-on`.

## Identity and tokens

| Who | Credential | How |
|---|---|---|
| Runner | `runner.key` in the data folder: 32 random bytes as hex, mode 0600, made by the server the first time it starts | The runner reads it there (or takes `HOLO_RUNNER_KEY`) and says it in `hello {role:'runner', key}`; compared in constant time. A runner with no key still gets renders, but no jobs, pairing codes or `agent-on`. `holo pair` reads the key the same way and sends it as `X-Holo-Runner-Key` to `POST /pairing`. |
| Allowed device | device token (32 random bytes, base64url) | `Authorization: Bearer <token>` on `/api/agent/*`; `hello {agentToken}` on `/api/live`, said again in every hello. The server stores only `sha256(token)`. The studio keeps it in `localStorage` (`holo:agent-token`). |
| A job's tools | job token (32 random bytes, base64url) | `Authorization: Bearer <token>` on `/api/agent/jobs/:job/*`. Kept in `<workspace>/.holo-job` (mode 0600), never in argv or the environment. Valid only while that job runs; revoked once its harness exits or the job ends. |

The Origin and Host guard (`apps/server/src/guard.ts`) covers every WebSocket upgrade, `/api/live`,
`/api/agent` and `/api/agent/*`. It answers 403 when:
- the `Host` isn't one of HO[LO]'s names: this computer, a private address, the machine's bare name, a
  `.local`, `.lan`, `.home.arpa`, `.internal` or `.ts.net` name, or one in `HOLO_ALLOWED_HOSTS` (this
  stops DNS rebinding);
- or the `Origin` is another site's. Allowed are the request's own Host, this computer, the local
  network and tailnets on any port, and `HOLO_ALLOWED_HOSTS`.

A request with no `Origin` (the CLI, the runner, curl) passes the Origin check.

## REST: `/api/agent`

The routes marked **open** answer any device. All others need a device token, and answer 401 without
one. A refusal is `{error, reason?}`. The reasons the studio acts on are `off`, `busy`, `not-open`,
`no-runner`, `no-harness`, `not-sealed`, `signed-out` and `choose` (a harness with no defaults, Claude
Code, has no model or effort chosen, or one it no longer offers), all with 409. Other refusals carry no
reason.

**With the agent off**, only these answer (under `/api/agent`): `GET /api/agent`, `POST /pairing`,
`POST /pair`, `GET /devices/requests/:id`, `GET|PUT /settings`, `GET /devices`,
`DELETE /devices/:id` and `GET|DELETE /push`. Every other route answers 409 `off`, `POST /devices/requests` included.
Turning the agent off cancels every job, so the job-scoped routes answer 403.

| Method and path | Body / query | Answer |
|---|---|---|
| `GET /api/agent` **open** | | `{enabled, allowed, pairing, runner:{connected, keyed, state, host?}}`. `allowed`: the bearer is an allowed device's. `pairing`: no device is allowed yet (the studio offers the code first; otherwise asking to join, with the code as the way back in). `runner.keyed`: a runner with the key is connected, so it prints a code too. `runner.state`: `ready` (one with the key), `old` (from before keys), `no-key` (a current one that couldn't read the key), `wrong-key` (another HO[LO]'s) or `none`; Settings › Agent says what to do for each. `runner.host`: the runner's computer (from its hello's `runner on <host>`), only to an allowed device. |
| `POST /api/agent/pairing` **open** | `{fresh?}` | With or without allowed devices: it's how the first device gets in, and how a device that has lost its token (its site data cleared, the only allowed one lost) gets back in. A code is 6 digits, works for 10 minutes and once, and a new one replaces the one before. **From `holo pair`** (header `X-Holo-Runner-Key`, the runner key, compared in constant time): `{code, expires}`, a new code each time, with or without a runner; 403 for any other key. **From the studio** (no header): `{expires}`, and the code goes to keyed runners as `pairing-code`; one that still works is kept (`holo pair` may have just printed it) unless `fresh` is true (New code). 409 `no-runner` without a keyed runner (the studio then asks for the code from `holo pair`); 429 while pairing is locked, either way. |
| `POST /api/agent/pair` **open** | `{code, name}` (name ≤ 60) | `{token, device:{id, name}}`, and turns the agent on. Allowed devices hear `agent-devices`, so their lists show the new one at once. 401 for a wrong, expired or missing code. 5 tries per code; while no device is allowed, 20 failures in an hour lock pairing for an hour, and once one is, 10 in a day lock it for a day (429). |
| `POST /api/agent/devices/requests` **open** | `{name}` (≤ 60) | `{id, secret, code}`. `code` is 4 characters (no 0/O or 1/I), shown on both devices. 409 `off` while the agent is off; 429 with 5 waiting. A request lapses after 10 minutes. |
| `GET /api/agent/devices/requests/:id` **open** | `?secret=` | `{state:'pending'|'denied'}`. Once approved, the first answer is `{state:'approved', token, device}` and later ones `{state:'approved'}`. 404 for a wrong secret or a lapsed request. |
| `GET /api/agent/devices` | | `{devices:[{id, name, added, seen, current}], requests:[{id, name, code, created}]}`. `current` is the device asking; `requests` are those waiting. |
| `POST /api/agent/devices/requests/:id/approve` and `/deny` | | `{ok}`; 404 if none of that id is waiting. |
| `DELETE /api/agent/devices/:id` | | `{ok}`; 404. It takes effect at once: the device's studios get `agent-removed` and lose agent access, its jobs (running or waiting for a click) are cancelled, and allowed devices get `agent-devices`. |
| `GET /api/agent/settings` | | `{enabled, harness, model, effort, harnesses:[HarnessInfo], relays:[…], usage:{days, rows:[…]}}`. `usage` is what the requests of the last `days` (30) days used, as their harnesses counted it, added up by harness, model and effort: each row is `{harness, model, effort, requests, input, cached, output}` (below, "Usage"). `relays` are the sign-ins, updates and installs under way, each as its runner last told it (its `agent-harness` message, less `type`), for a studio that opens Settings later or reloads; one is let go when it ends, after 15 minutes, or when its runner goes. |
| `PUT /api/agent/settings` | `{enabled?, harness?, model?, effort?}` | The settings, as GET. `harness` is an id or null (the first that can be sealed, never Antigravity: it runs only once it's chosen, and with none chosen a request is refused `no-harness`, saying so, when it's the only one). `model` and `effort` must match `^[A-Za-z0-9][\w.:\-\[\]=]{0,79}$` or be empty (the harness's own default; Claude Code has none, and refuses requests until both are set). Off stops every job; on sends `agent-on` to the runners; any change is announced as `agent-settings`. |
| `POST /api/agent/harnesses/refresh` | | `{ok}`. **Look again**: the runners look again (`agent-refresh`), a seal check that failed for a version included. 409 `no-runner`. |
| `POST /api/agent/harnesses/look` | | `{ok, asked}`. Settings › Agent was opened: each runner whose last look (its last `harnesses`, or the last time it was asked) is an hour old or more is sent `agent-refresh {light:true}`; `asked` is how many. At most once an hour per runner, and only when a studio asks. A runner that looked more recently is asked only what its harnesses' accounts have left (`agent-limits`), at most once a minute. |
| `POST /api/agent/harnesses/:id/login` | | `{ok}`. Sent to the runner that has it; progress arrives as `agent-harness` live messages. 404 for an unknown harness; 409 `no-harness`, `busy` (a job runs on it), or no reason when it's signed in already (HO[LO] never signs out or switches accounts). |
| `POST /api/agent/harnesses/:id/login/code` | `{code}` (printable, ≤ 200) | `{ok}`, for a sign-in that asks for a pasted code. |
| `POST /api/agent/harnesses/:id/update` | | `{ok}`. 409 `no-harness` or `busy`. |
| `POST /api/agent/harnesses/:id/install` | | `{ok}`. Sent as `agent-install {harness}` to a runner that reported the harness not found, with an `installer`; progress arrives as `agent-harness` with `kind:'install'`. 404 for an unknown harness; 409 `no-runner`, `busy` (a job runs on it), or no reason when a runner has it already (Update is for that) or none can install it (a Windows host). The body is empty: the runner runs its own fixed command. |
| `POST /api/agent/requests` | `{project, text, attachments?:[id], context?, preset?}` | `{job}`. `text` is 1 to 4000 characters (empty with a preset). At most 10 attachments, each this device's for this song (400 otherwise). 404 for no such song, or a preset's scan that isn't the song's; 409 `not-open`, `busy`, `no-runner`, `no-harness`, `not-sealed`, `signed-out`. |
| `POST /api/agent/jobs/:job/continue` | | `{job}`: **Try again**. The request whose last go failed is carried on in the same conversation, as a new job that continues it (below, "Why a request failed, and Try again"). Only the device that asked (403); 404 for no such request; 409 when it didn't fail, a later request was made on the song since, or the conversation was started over; and refused as a request is (`not-open`, `busy`, `no-runner`, `no-harness`, `not-sealed`, `signed-out`, `choose`). |
| `POST /api/agent/jobs/:job/cancel` | | `{ok}`. Any allowed device may stop a job; one waiting for a click is dismissed (`cancelled`). 404; 409 once it has ended. |
| `POST /api/agent/jobs/:job/permission` | `{grant:boolean, result?, attachments?:[id]}` | `{ok, job?}`, `job` being the follow-up's id. Only the device that asked may answer (403), only while the job is `awaiting` (409). `result` is at most 1000 characters; `attachments` as in a request (a screenshot, a photo, a recording). Granting can be refused as a request is (`not-open`, `busy`, `no-harness`), and with 409 when the conversation was started over since the job asked. With a job token, the same path is the tools' (below). |
| `POST /api/agent/jobs/:job/done-listening` | | `{ok}`. The user pressed Done. Only the device that asked (403); 409 once the job has ended. |
| `GET /api/agent/threads/:project` | | `{thread, job, now}`. `thread` is `{id, harness, turns:[{job, request, reply, label, state, at, permission?, brief?, briefWarnings?, view?, go?, error?}]}`, or null. `job` is the song's job that's running or waiting for a click (a `JobView`), or null: after a reload, its button comes back. `now` is the host's time (ms). |
| `GET /api/agent/away/:project` | `?from=` (a revision) | `{away}`: what this device's studio, back on the song at revision `from`, picks up of the changes its job saved on the server while it was away (below): `{job, label, running, base, head, batches:[{batch}], song}`, the batches after `from` by id, `head` the revision they bring the song to and `song` the song then, read together (no save comes between them), `label` the job's once it has finished (its last batch's before). From a revision before the run (a save of the studio's got there, its answer lost), the whole run, `base` its first revision; otherwise `base` is `from`. `away` is null when there's nothing to pick up from `from`: no such run of the song's latest job of this device's, `from` past its first revision but not one of its own, or the song saved since by someone else. 400 for a `from` that isn't a revision. |
| `POST /api/agent/threads/:project/reset` | | `{ok}`. The next request starts a new thread. 409 `busy` while a job runs on the song. |
| `GET /api/agent/push` | `?key=1` (subscribing) | `{key, mode:'off'|'long'|'every', endpoint?, unseen}`: this device's notices outside HO[LO] (below). `key` is the host's VAPID public key (base64url, 65 bytes uncompressed), or null while none has been made: only `?key=1` makes it, as a device subscribes. `endpoint` is the subscription's, when on; `unseen` how many replies this device asked for no device has seen (its badge). Answers with the agent off. |
| `PUT /api/agent/push` | `{mode:'long'|'every', subscription:{endpoint, keys:{p256dh, auth}}}` | As GET. Turns notices on for this device, or changes when they come. `subscription` is the browser's `PushSubscription.toJSON()`: `endpoint` must be `https` on 443, ≤ 1000 characters, no user or password, on `fcm.googleapis.com`, `*.push.apple.com`, `*.push.services.mozilla.com` or `*.notify.windows.com`; `p256dh` a P-256 point (65 bytes, uncompressed) and `auth` 16 bytes, base64url (400 otherwise). Another device with the same endpoint (the same browser, paired again) loses it. |
| `DELETE /api/agent/push` | | As GET (`mode:'off'`). Off: the subscription and this device's unseen replies are deleted. Answers with the agent off. |
| `POST /api/agent/seen` | `{project}` | `{unseen}`. The song's conversation was seen on this device: its replies count as unseen on no device now. `unseen` is this device's count after it (the studio sets its badge to it). |
| `POST /api/agent/attachments` | `?project=&name=&type=` and the file as the body (a recording ≤ 200 MB, anything else ≤ 25 MB, text ≤ 100 KB; 413) | `{id, name, type, size}`. Allowed types: `image/png`, `image/jpeg`, `image/webp`, `audio/wav`, `audio/x-wav`, `audio/flac`, `audio/aiff`, `audio/mpeg`, `audio/ogg`, `audio/mp4`, `audio/midi`, `application/vnd.recordare.musicxml+xml`, `application/vnd.recordare.musicxml` (`.mxl`), `text/plain`. The body goes to disk as it arrives, and is cut off at the type's limit (one whose `content-length` says it's over isn't read at all). Its first bytes must be what the type says (415): a recording's first 64 KB are checked; text must be UTF-8, MusicXML UTF-8 or UTF-16, and an `.mxl` a zip with a score in it. 404 for no such song. Kept 7 days, the device's own, for that song. |
| `PUT /api/agent/attachments/:id/meta` | JSON object (≤ 64 KB) | `{ok}`. The browser stores what it measured here. Only the device's own (403). |
| `GET /api/agent/attachments/:id/data` | | The file's bytes, as its type, `no-store`: for the studio to decode a recording the agent imports (below). Only the device that sent it, or the device whose running job may read it (an earlier request on the job's thread, from another device); 403 otherwise, 404 once it's gone. |

**`context`** in a request is what the studio sees:
`{view, selection:{track, regions, notes, from?, to?}, playhead, cycle:{on, start, end}, scan?}`.
Positions are ticks. Each part is checked; a `scan` that isn't the song's is left out.

**`preset`** is `{kind:'scan', task:'read'|'check'|'fix', scan}`. The bar shows it as "Read this scan",
"Check this scan" or "Fix what was flagged". Its prompt is fixed words with only the checked scan id in
them. A preset may take up to 3 hours (a request, 2: "Ending early", below), and carries on if its
studio goes (its changes are then saved on the server). Scan's own Read in, which needs no agent, uses `GET /api/scans/:id/engines/reading`
(`apps/server/src/omr.ts`): the recognition engines' reading as ops the studio applies as one undo
step. That isn't an agent route.

**`HarnessInfo`** is:
`{id:'claude'|'codex'|'cursor'|'antigravity', name, found, version?, signedIn?, account?, plan?, limits?:HarnessLimits, update?:{available, latest?}, sealed, sealUnknown?, reason?, models?:string[], efforts?:string[], modelEfforts?:{[model]:effort[]}, defaultModel?, defaultEfforts?:{[model]:effort}, aliases?:{[alias]:model}, mustChoose?, host?, installer?}`.
- The runner reports all four, found or not.
- `sealed: false` means the harness can't be locked down to HO[LO]'s tools. The studio shows it as
  unavailable, with `reason`.
- `sealUnknown: true` (with `signedIn: false`) means the seal couldn't be checked yet: the harness asks
  for its sign-in before it reads its options (Cursor 2026.11.11-b912975), or its check would start a
  browser sign-in (Antigravity). The studio offers Sign in;
  a request is refused `signed-out`, not `not-sealed`. The first look after the sign-in checks the seal.
- `plan` is the account's plan in its vendor's own word ("max", "Pro+", ≤ 40 characters), when the
  harness says. `limits` is what the account has left, as its vendor reports it (below, "Usage"); a
  harness that doesn't report it (Cursor), or isn't found, has none.
- `host` is the runner's computer (its host name: letters, digits, `.`, `-`, `_`, ≤ 64).
- `installer` is given only when the harness isn't found and the runner can run its installer (Linux
  and macOS): the command Install runs there, as the confirmation shows it (≤ 200 characters).
- `update` is looked up at most every 6 hours, and never installed unasked. Claude Code's is read from
  its `stable` channel (npm's `stable` tag for an npm install, `downloads.claude.ai/claude-code-releases/stable`
  for the native one), so Update never offers a version `claude update` won't install. Codex's is
  npm's `latest`; Cursor's is what `cursor-agent about` says; Antigravity's is the manifest its installer
  reads.
- `modelEfforts` gives each model's efforts when the models don't all take the same (Antigravity, Codex):
  a model listed with none takes none (its effort comes with it). The Effort picker offers the efforts
  of the model a run uses, "Requests use" says only what that model takes, and choosing a model clears
  a saved effort it doesn't take.
- At most 500 `models` and 50 `efforts` are kept, each checked as settings check them. They're the
  harness's own lists, read on the host (docs/agent-harnesses.md, "Models and efforts"): HO[LO]'s server
  never asks a vendor for them, it keeps what the runner reports.
- `defaultModel` is what a run uses when the agent's Model is empty, and `defaultEfforts` the effort
  each model runs at when Effort is empty (docs/agent-harnesses.md, "Defaults"), as Codex and Cursor
  list them. Antigravity names neither, and runs with its own. Claude Code lists none (`mustChoose: true`): a request needs a model and an effort chosen,
  and is refused without (409 `choose`), by the server and again by the runner, rather than run with
  whatever it picks. `aliases` say what each alias stood for at its last run (`opus` → the
  full name its `init` gave). Up to 500 `defaultEfforts` and 50 `aliases` are kept, names and
  efforts checked as settings check them.

### Settings › Agent

An allowed device's Settings › Agent lists Claude Code, Codex, Cursor and Antigravity as the host has them, a row
each (`apps/web/src/ui/harness-row.ts`), through a harness's whole life:

1. **Not installed**, with **Install** when the runner gave an `installer`. Install asks first: "This
   downloads and runs *Harness*'s official installer on *host* (*command*)", then **Install** or **Not
   now**. Without an installer (a Windows host), the row says to install it there and Look again.
2. **Installing**: the installer's lines under the row (a few a second), then how it ended. The runner
   looks again before it says `done`, so the row shows the version and Sign in at once; an install that
   finished but left nothing the runner can find fails with "Installed in ~/.local/bin, which the
   runner doesn't see: run `pnpm run runner-service on` again on the host".
3. **Signed out**: **Sign in**, whatever the seal (a harness that can't be sealed keeps Sign in, and says
   why it can't be used). The sign-in is each harness's own relay: Claude Code's page and a pasted code,
   Codex's page and a one-time code, Cursor's page while it waits, Google's page and a pasted code for
   Antigravity. A harness signed out isn't offered as **Use**.
4. **Signed in**: **Use**, or **In use** for the one the agent runs with: the one chosen, or with none
   chosen the first that can be limited to HO[LO]'s tools, as the server picks it (never Antigravity).

For Antigravity, **Sign in** and **Use** ask first (`caution` in `harness-row.ts`): Google's FAQ says
running `agy` inside another app "is not supported under consumer plans", and that third-party software
with an Antigravity sign-in can get the account suspended, Gemini CLI included; it links the FAQ, then
**Sign in anyway** or **Use it anyway**, or **Not now**. The server never picks it on the user's behalf.
5. **Update to x.y** when a newer version is out; it asks first ("This updates the *Harness* your
   terminal uses too"), then shows its lines. The runner looks again before it says `done`, so the new
   version's models and efforts show with it. **Up to date** otherwise.

**Look again**, under the list, asks every runner for a fresh look (`POST …/harnesses/refresh`).

**Opening Settings › Agent** asks the host to have its runners look again if their last look is an
hour old or more (`POST …/harnesses/look`): the lists show at once as they were, and change when the
new `harnesses` report comes (as `agent-settings`). Nothing is asked while nobody opens it, and nothing
is polled.

**Usage**, under each harness's row (`apps/web/src/ui/harness-usage.ts`, drawn by `HarnessUsage.tsx`),
says what its account has left and what the requests through HO[LO] used:

- A limit is a line: its name by its length ("Weekly", "5-hour"), a bar of what's left, and the words
  ("37% left", "Used up", then "resets in 2 h 10 min" under a day away, "resets Thu 3 Dec, 07:02"
  otherwise). The bar is the studio's blue, the warning colour when a fifth or less is left, and empty
  with a red outline when nothing is.
- Folded, a row shows its longest limit alone. The harness the agent runs with shows every limit its
  model counts against. Where a vendor's limits go by groups of models (Antigravity: its own models,
  and the others it serves), the group is named over its limits, and the group of the model in use
  leads (`groupFor` in `@holo/agent/limits`: a group lists its models by the vendor's names, matched to
  the harness's ids by their letters and digits).
- **More** unfolds the rest: every limit of every group with the models in it, the plan, anything the
  vendor says beside its limits, how long ago they were read once that's ten minutes or more, and the
  requests of the last 30 days by model and effort (requests, tokens in, tokens out). **Less** folds
  it again.
- A limit that has started again since it was read is never shown as full: the account may have been
  used elsewhere. Its bar is an outline, and it says "Reset 4 h ago · not read since".
- A harness that doesn't report what's left says so, with its plan, a link to its vendor's own usage
  page, and the requests through HO[LO] in a line: "Pro+ plan · Cursor doesn't report what's left of
  its plan: see Cursor's usage page".
- Claude Code says what's left only with a request, so before its first one its row says it shows
  after the next. The others are asked as Settings › Agent opens.
- A harness that isn't installed says nothing; one signed out, only what was counted.

Nothing of this shows outside Settings › Agent: no bar, badge or notice in the studio or the agent's page.

**Model and Effort** list the harness's own names, with no line under them unless one saved is no
longer offered. Such a model or effort stays selected, labeled "(no longer offered)", with a line saying
so, and a run uses the harness's default instead of failing (the adapter drops it before the run).
Cursor has no Effort list: its model names carry their effort, and the row says "Comes with the model".
Antigravity's model names carry theirs too (`gemini-3.8-flash-low`), but the runner shows each model's
variants as one model with those efforts, so it has both pickers.

Each picker's empty choice names the default, value first: "Gpt-6.1-sol (Codex's default)", and for
Effort the default of the model a run uses. Claude Code has no defaults to name, so its pickers have no
empty choice: "Choose a model" and "Choose an effort" until both are chosen, and one it no longer offers
says to choose another. **Requests use**, under them, says what a run with these settings uses, as the
adapter decides it, in the menus' names: "Gpt-6.1-sol at low effort", "Auto: Cursor chooses the model",
"Opus at high effort (last ran as Opus <its version>)" for Claude Code once a run has said what the
alias stands for (Claude Code lists only aliases, so its Model menu adds each one's version then:
"Opus (<its version>)"), or, in the warning color, what's left to choose ("Choose an effort first").
The choice is the host's, shared by every allowed device, so a request from a phone runs as one from
the desktop. A run that says something new of an alias sends the harness list again at once (the runner's
`harnesses` message), so the row follows without a look.

### Usage

Two things, both shown only in Settings › Agent (above), both as the vendors and their harnesses
report them: HO[LO] works nothing out, and asks no vendor anything itself. docs/agent-harnesses.md,
"Limits and usage", says where each harness's come from.

**What an account has left: `HarnessLimits`** (`packages/agent/src/limits.ts`, `@holo/agent/limits`):
`{at, note?, groups:[{name?, models?:string[], windows:[{minutes, used, resets?}]}]}`.
- A window is `minutes` long (300: five hours; 10080: a week), `used` from 0 to 1, and starts again
  at `resets` (ms) when the vendor says.
- A group is the windows some models share. A harness with one limit for every model has one group
  without a name; `models` are the vendor's own names for them.
- `at` is when they were read; `note` is a line the vendor says beside them (Codex: early resets of
  its limit the account may still take).
- The runner reads them at each look, again when Settings › Agent opens (`agent-limits`), and after
  each of a harness's runs (the run says them, or the harness is asked a moment after the turn's end:
  nothing waits for it). They're kept in the runner's notes with the account they were read for
  (`limits:<id>` in `.harnesses.json`): another account's aren't shown.
- The server checks what a runner reports before a studio sees it (`checkLimits`): at most 8 groups
  of 6 windows and 40 models, the share used held to 0…1, names in one line.

**What the requests used.** A run's end carries `usage: {input, cached, output}`: tokens the model
read that weren't from its vendor's cache, tokens read from the cache, and tokens it wrote. Every go
of a turn counts (one carried on to ask for `finish`, a retry). The server keeps one row a request
that said (`agent_usage`: the job, its harness, the model and effort it was handed to its runner
with, the counts, when), names the harness's default model when none was chosen and it lists one, and
drops rows after 90 days. `GET /api/agent/settings` adds up the last 30 days. A turn stopped from the
studio says nothing and isn't counted; nor is one whose harness didn't say.

## REST: `/api/agent/jobs/:job/*`

These are for the agent's tools, with the job token. Without a token of the right shape they answer
401. When the job has ended (or its turn has), or the token isn't its, they answer 403. The first call
moves the job from `waiting` to `running`.

**The studio that asked, away.** The user may send a request and leave: switch the phone to another
app, put it down, close the tab, or open another song. None of these ends the job: it runs on, its
changes land, and its reply waits. A device may so have requests at work on several songs at once,
one a song (below, "Several songs at once").
- **Away, or a moment away.** The requester's studio is away when its connection has closed, when it
  has another song open (no studio of that device has the job's), or when
  its page is hidden (the studio reports `hidden`) and doesn't answer within 8 s (`hiddenMs`): the
  browser froze it, as a phone's does in the background, though its connection may close only later.
  It's back once it reports the song open from a page in view (one that says so just before what it
  was sent runs out of time isn't taken as frozen). A studio that went with its page in
  view (a reload, its network) may be back in a moment: routes that need it wait up to 15 s (`awayMs`)
  from when it went, for that device's studio to report the song open again, then go on there.
  Meanwhile the job's line under the bar says "Waiting for the studio that asked to come back" (the
  other devices with the song open see it), and the line it had comes back after. One that went with
  its page hidden, that opened another song, or that went longer ago, isn't waited for. The wait
  comes out of the call's own time: a
  listen's part is that much shorter, `…/ops` has that much less of its minute, and `meters` waits
  only as long as its 45 s leave.
- **Changes land.** While it's away, `…/ops` applies each batch on the server and saves it as a
  revision by "Agent", once per batch id (`saveHere` in jobs.ts), and tells the studios with the song
  open `saved`. The batches saved one after another, with no one else's save between, are the job's
  **run**: from the revision the first was made on (`base`, kept in the song's history as the run
  begins) to the last one's (`head`). A studio that's back gets batches again only once it has picked
  the run up (it reports `head` or later as its revision); it has 3 s (`catchUpMs`) to, else the batch
  is saved on the server too. The revision of the run it says it's at is kept in the song's history,
  once, even when the agent has saved again since (the run's last few revisions past the one the
  studio last said are kept at hand for that, as saved, not parsed; let go as the studio catches up,
  and as the job ends: then the one it says is the song as it is). A batch sent to a studio whose
  connection closes before it answers is
  answered 409 `away` at once: the change may or may not have gone in, and the agent is told to read
  the song before making it again.
- **What needs the studio itself** (routes marked **studio**: playing, auditioning, listening, what was
  just played, A/B, the meters, the studio's commands, an import the studio converts) answers 409
  `away` at once while it's away (`BACKGROUND` in jobs.ts): the user doesn't have the song in front of
  them (their studio's page is in the background or closed, or another song is open in it), so
  nothing can be played, heard or read in it until they're back; changes still land; what there is to
  hear or see goes in the reply's view. `…/measure` with `meters` says instead that levels don't need
  the studio (`METERS_AWAY`): the mix and the tracks are rendered and measured on the host, as every
  other measurement is, away or not. `…/state` answers what the studio showed as it went, with
  `away: true`, nothing playing, and the song's tempo and cycle as saved. `…/song`, `…/describe` and
  `…/version` read the song as saved here, which has the job's changes.
- **Picked up.** The studio picks the run up (`pickUpAgent` in apps/web/src/app/actions.ts) when it
  hears the song was saved since its revision (`saved`, or the `saved` the host sends a studio that
  joins behind), when its own save is refused for that (409), and as the song opens after a reload
  (its history kept at an earlier revision: `behind`). It asks `GET /api/agent/away/:project` with its
  revision, which answers the song as the batches left it, and takes it in as the job's step, in turn
  with the job's batches and after a gesture under way (one that never ends holds it 15 s at most, as
  it does a batch): below, "Undo grouping". A pick-up asked for while one is under way joins it, and
  it looks again after (unless the server didn't answer); what the studio does next (open the song as
  it now is, save its own changes on top) goes by the revision it's at then. A save refused while a
  pick-up moved the studio on is made again on top; a save refused because the server has this very
  song (an earlier save got there, its answer lost) is taken as saved. A pick-up's answer, a whole
  song, is waited for as long as it keeps coming, and given up after 15 s with nothing of it; then the
  studio's own changes stay to be saved, and it's asked again later, a little longer each time (up to
  a minute), one try again a song, let go as another opens: never which version to keep while the
  answer may be the agent's. A save is given up when it takes longer than 30 s and as long again as
  sending the song at 20 KB/s takes (a page frozen with it on its way), and made again; each try
  after one that ran out is given twice as long as the last, till the host answers, so a network
  slower than that pace gets there in the end. (A browser's `fetch` doesn't say how much of a
  request has gone, so a save's time can't follow it as the pick-up's answer's does.)

A scan preset, which carries on without its studio, isn't waited for: the routes that need the studio
answer it 403 at once. `…/version` and an import read on the server don't need it, and answer it as
they answer any job. The command line's own requests to a studio are as they were.

| Method and path | Body / query | Answer |
|---|---|---|
| `GET …/song` | | The Project (JSON). The studio is asked to save first. |
| `GET …/describe` | | `{text}` (`describeProject`) |
| `GET …/state` | | `{playhead, position, playing, recording, bpm, selection:{track, regions, notes, audioNotes?}, cycle, middleC, view?, scan?, about}`. `audioNotes` is `{region, notes}` when notes are selected in the Audio Editor's Notes: their places in the region's notes, from 0 (`audio_notes` reads it for "selected"). While the studio is away: `away: true`, and what it showed as it went (above). |
| `POST …/ops` | `{ops, label, batch}` (1 to 5000 ops; label ≤ 80) | `{ok, revision?}`. Sent to the requester's studio as `agent-ops`, answered once applied: 400 if it refused, 504 after 60 s (less the time it waited for the studio). While it's away, or back but not yet caught up: applied and saved here as a revision by "Agent" (above), `revision` that revision; 400 if it doesn't apply. Each batch id is applied once, here or there. |
| `POST …/transport` **studio** | `{action:'play'|'stop'|'locate', bar?}` | `{ok}`. `locate` needs `bar`. Sent as `transport {action, at?}`, `at` in ticks; 409 if the studio can't (its audio isn't started). |
| `POST …/audition` **studio** | `{track?, events:[[delayMs, status, d1, d2]]}` (1 to 1024; status 0x80 to 0xEF) | `{ok}`. Sent as `play-notes`: heard, not recorded. |
| `POST …/listen` **studio** | `{maxMs, quietMs, last?}` (maxMs ≤ 45000, quietMs ≤ 10000) | `{notes:[PlayedNote], done, part, pending}`: one part of a listen (below). 409 while a part is under way. |
| `GET …/played` **studio** | `?seconds=` (1 to 60) | `{notes:[PlayedNote]}` from the studio's memory of what was just played (`agent-played`). 504 if it doesn't answer within 3 s; 409 with its reason if it can't say. |
| `POST …/capture` **studio** | none | `{ops, notes, tracks, regions}`: what the studio's Capture would keep of what was just played, as `addRegion` operations for the tool to send back through `…/ops` (so they're in the job's undo step), with how many notes play and the tracks' and regions' names; or `{nothing}` with why there's none. The studio forgets the phrase as it answers (`agent-capture`). 504 if it doesn't answer within 3 s; 409 with its reason. |
| `POST …/compare` **studio** | `{from, to}` (bar numbers; `to` isn't played) | `{ok}`, once the studio has started playing those bars from before the job, then as they are now (`agent-compare`, up to 50 s). |
| `POST …/version` | `{name}` (a few words, not `before` or `after`) | `{ok, revision}`: the studio saves (`agent-flush`), and the song as saved is kept in its history (`snapshotNow`, author "Agent: <name>") as a version the reply's view can play or keep. While the studio is away, the song as saved here (it has the job's changes). 409 for a name used already this turn, or past 8. |
| `GET …/commands` **studio** | | `{commands:[{id, title}]}`: the bar's commands the requester's studio can run now (`agent-commands`), for a view's `command` buttons. |
| `GET …/packs`, `…/packs/available` | | As `GET /api/packs` and `GET /api/packs/available`. |
| `GET …/instruments/:pack/:name` | | That instrument's knobs and microphones. |
| `GET …/scans/:id` | | The scan. 403 if it's another song's. |
| `GET …/scans/:id/strip/:page/:system` | | The system's strip (PNG). |
| `PATCH …/scans/:id/systems/:page/:system` | `{state?:'new'|'read'|'checked'|'approved', written?:[first, last], flags?:[line]}` (≤ 40 flags) | As `PATCH /api/scans/:id/systems/:page/:k`. |
| `GET …/attachments/:id` | | `{name, type, size, meta, data?}`. `data` (base64) comes for pictures, text, and MusicXML up to 1 MB (as UTF-8 text, whether it came as UTF-16 or zipped in an `.mxl`); `meta` is what the browser measured, or null. Only an attachment that the job's request, or an earlier one on its thread, named (403). 404 once it's gone. |
| `POST …/import` | `{attachment}` | What importing it brings (below), the studio's conversion **studio**: `{done:true, kind:'audio', how:'copied'|'converted'|'studio', file:AudioFile}`, `{done:true, kind:'notes', format:'midi'|'musicxml', name, song:Project, warnings}`, or after about 40 s of the studio still converting, `{done:false, line}` (the same call again waits on). 403 as `…/attachments/:id`; 415 for a picture or a text; 400 for a file that can't be read; 409 with the studio's reason, 504 when it never answered. |
| `POST …/progress` | `{line}` (≤ 200) | `{ok}`. The line under the bar. |
| `POST …/permission` | `{kind, detail, pack?}` (detail ≤ 300) | `{ok}`. `kind` is `install-pack` (with `pack`), `send-creation`, `bounce`, `render`, `screen`, `photo` or `microphone`; `render` only for a song that came from a creation (400). The job waits for the user once the turn ends. |
| `POST …/handoff` | `{brief}` (≤ 4000) | `{ok}`. Lines that mention a secret, hold a link or run a command are flagged (`briefWarnings`). |
| `POST …/finish` | `{label, reply, view?, go?, dock?}` (one line ≤ 80; ≤ 600; a view, a go and a dock, resolved: below) | `{ok}`. The agent is asked for one or two short sentences, about 200 characters at most; 600 is the server's limit. The view, the go and the dock are checked again (`checkView`, `checkGo`, `checkDock` in strict form, 400 with where the problem is; a dock without a view is refused), and every version the view or the dock names must be one the job kept (`before`, one from `…/version`, or `after`, kept when the turn ends): its revision goes with it. |
| `PUT …/details` | `{artist?, album?}` (each a name, or null to clear) | `{ok, artist, album}`, as `PUT /api/projects/:id/details` answers for the job's song: the library keeps them beside the song (no new revision, outside undo). 400 for a creation's song. |

**Listening.** A harness can cut a tool call at 60 s, so a listen comes in parts: the `listen` tool asks
for at most 40 s at a time, and the server takes at most 45 s. A listen hears only the requester's
studio, and is heard whole across its parts:
- The first part begins it, and the studio shows it's listening, with Done.
- A part ends `done` on `quietMs` of silence after a note, on Done, or when the part sent with `last`
  runs out. After `maxMs` it ends not done, and the tool asks for the next part.
- Every note's `time` counts from the listen's start, so parts concatenate. A note held over the end of
  a part goes whole to a later one; `pending` counts those.
- Between parts the studio keeps showing it listens, and what's played goes to the next part. With no
  next part within 15 s, the listen is over and what came after the last part is let go.
- Done pressed between parts ends the next part at once, with what was played up to Done.

### Measuring (`…/measure`)

`apps/server/src/agent/measure/`. Measurements run in child processes at the lowest priority
(`runner.ts`, `child.ts`): one lane for files (a take, a bounce, an attachment, a plugin's response, a
recording's notes) and one for renders (the mix, tracks, a plugin on its track's sound, a take through its effects), one
measurement at a time in each. A call waits up to 40 s (the tool's client gives it 50: Cursor cuts a
call at 60); while it waits, the job's line under the bar says how far the measurement has got ("Still
measuring the mix: 35% done, about 2 min left"), as each step comes from the child. The same question
about the song as it is now (its revision and the body) joins the measurement under way, or is
answered from the cache; a recording's notes are kept by its file and the engine's code instead
(below), whatever the song's revision. Renders are `renderSession` with `finish: false`, from two bars before `from`
(not measured), slower than real time; one estimated past ten minutes is refused (422, `reason:
'too-long'`) with what to do instead. What plays a HO[LO] Pack that isn't installed (asked of the same
source the render reads) is silent in a measurement, as in the studio: its tracks are muted with no
instrument to load, and plugins that play such a pack's kit or response are left out, in the measured
copy only; the result's `unplayable` lists them (`{tracks:[{id, name, pack}], plugins:[{id, name,
channel, pack}]}`), a silent track's level says `missing: pack`, and a plugin measured on such a
track, or one playing such a pack itself, fails with why. A measurement is cancelled when the last job
that asked for it is stopped or fails; when that job's turn simply ends, it runs on (up to 15 minutes)
for the next turn to collect. A lane's child is let go after a minute with nothing to do, and when the
server closes.

| Method and path | Body / query | Answer |
|---|---|---|
| `POST …/measure` | `{what:'take'\|'mix'\|'tracks'\|'plugin'\|'meters'\|'file'\|'notes', track?, region?, plugin?, from?, to?, against?, grid?, through?:'recording'\|'effects', source?:'render'\|'bounce', attachment?, seconds?}` (ids and ticks) | `{done:true, task, result, cached?}`, or `{done:false, task, progress, eta, stage}` after 40 s (`eta` in seconds). `take`: an audio `track` (or a recording `attachment`), `region?`, `against` `'key'` (default), `'none'` or an instrument track's id, `grid` in ticks (240), `through` `'recording'` (default: its files, at once) or `'effects'`: rendered in the render lane as the track comes out of its plugins (a solo copy with its sends gone, out to a bare master, its fader, pan and stage left out, `finish:false`) over its regions' bars (`region`'s, within `from`–`to`; 422 where it plays nothing) and two bars before, the plugins' delay made up for as in the mix, then measured as its recordings are, with `through:{plugins, errors}` in the result. A region whose notes are edited is measured as it plays: its recording at the song's rate, stretched, with its patches in place (`renderNotePatch`, `assembleClip`), so a tuned note is measured where it now sings. `notes`: an audio `track` and `region?` (its only recording when left out): the recording's notes as the studio's Notes view finds them (`decodeWav` at its own rate, then `notesAndCurves`), each note's drift and vibrato as sung (over its held part, as a take's are measured), each note's level as recorded (`noteLevel`: dB of full scale over its held part, from the same power curve the studio reads it from, for the `level` macro and a MIDI track's velocities), and what kind of recording it looks like (`classifyRecording`): `{kind:'notes', file, name, seconds, notes, shapes:[{drift, vibrato:[Hz, ±cents]\|null}\|null], levels:[dB\|null], looks}`. Kept by the song's file and the engine's code (`engineCode`), not the song's revision, so the agent and the terminal find a file's notes once. `mix`: rendered, or the newest file in `data/bounces/<song>/` with `source:'bounce'` (404 `reason:'no-bounce'` without one; `made` and `stale` say when it was made and whether the song changed after; one deleted in the studio's Songs is no longer among them). `tracks`: every track alone, or `track`, and with `against` a second track (masking). `plugin`: `track` is a track's, a bus's id or `master`; EQs, the reverbs (Space Reverb, Room Reverb, Smooth Hall, Space Designer), the delays (Tape Delay, Dual Delay) and Stereo Width by their response to an impulse, the rest on the track's own sound (not on a bus). `file`: an `attachment` (WAV, FLAC or AIFF; 422 for MP3, OGG, M4A), else the newest bounce. `meters` **studio**: `seconds?` (1–30, 8 by default), asked of the requester's studio as `agent-meters`, which has that long plus 4 s to answer. A failed measurement is 422 with its reason. |
| `GET …/measure/:task` | | As above, for a measurement of the job's song by id (404 once it's forgotten). |

**The terminal's measurements** (`holo measure`; `apps/server/src/agent/measure/terminal.ts`) are the
same, for any song, with the agent on or off. Each is planned as the agent's are
(`measure/plan.ts`) and run by the same runner, so the same question about the same song as it is now
is the same measurement whoever asks it, or comes from the cache. The studio with the song open saves
first; a measurement the terminal asked for runs to its end. Refusals say what to do in `holo`'s words
(`--from` and `--to`, `holo bounce`, `--source bounce`).

| Method and path | Body / query | Answer |
|---|---|---|
| `POST /api/projects/:id/measure` | As `POST …/measure`, with `file` (a recording sent first) where the agent gives an `attachment` | As `POST …/measure`. `meters` asks the studio with the song open (409 without one). |
| `GET /api/projects/:id/measure/:task` | | As `GET …/measure/:task`. |
| `POST /api/projects/:id/measure/files` | `?name=`; the recording as the body (`application/x-holo-audio`: WAV, FLAC or AIFF, ≤ 200 MB) | `{file, name, size}` (201). The same bytes always get the same `file` (`mfl_…`, from their SHA-256), so a recording sent again joins its measurement. Kept a day in `data/measure-files/<song>/`. 415 for anything but a recording; 413 past the size. |

**What was just played, for the terminal**: `GET /api/live/played?seconds=&project=` (1 to 60 s, 20
by default) asks the studio with `project` open (or the most recently active one) for its memory of
what was played, as `…/played` does (`agent-played`): `{notes:[PlayedNote]}`; 409 without a studio,
504 when it doesn't answer within 3 s. `POST /api/live/capture?project=` asks the same studio what its Capture would keep, as `…/capture`
does: `holo capture` applies the operations through the song's ops.

`agent-meters {id, seconds}` (server → studio, asked): the studio reads every channel's meter twenty
times a second while the song plays (`apps/web/src/app/agent-meters.ts`, keeping the last 30 s) and
acks `{playing, seconds, covered, channels:[{id, peak:[l, r], max:[l, r], gr, grMax, clipped}]}`:
dBFS over the last `covered` seconds of play (the `seconds` asked, or all of the play if it was
shorter) and since play started (null for silence), the deepest gain reduction (dB), and whether it
went past full scale; `seconds` is how much play was watched. When play started less than `seconds`
ago, it waits until it has watched that long (or play stops) before it answers, so a measurement
taken as playback starts isn't a second's worth. After play stops it answers what the last play
showed.

The results (`packages/agent/src/api.ts`, `MeasureResult`) are numbers: a take's notes (`tick`, `pitch`
with cents, `target`, `cents`, `inKey` or `ref`, `drift`, `vibrato:[Hz, ±cents]`, `grid` ms, `db`), its
phrases and a summary; the mix's loudness (integrated, momentary and short-term maxima, LRA, true and
sample peak, samples at full scale), its sections (markers, else every 8 bars) and octave bands with a
tilt; each track's loudness, peaks, octave bands and (audio tracks) its recordings' own level; a
plugin's third-octave response, decay, pre-delay and echoes, or its gain reduction and in/out levels;
a recording's notes as found (`AudioNotes`), with each one's drift and vibrato.
The analysis is `@holo/engine/analysis` (packages/engine/src/analysis/): pitch to a cent or two (YIN,
refined at the full rate); a note from silence starts where its voice does (its level within 20 dB
of its attack's loudest, and voiced: a soft attack or a scoop counts from its beginning, a breath or
an unvoiced consonant before it doesn't), out of the note before where the pitch moves; loudness by BS.1770-4 and EBU Tech 3341/3342 with the finish's own
K-weighting and true-peak interpolator, bands through the engine's FFT.

**Several songs at once.** One job runs per song, and a device may have one at work on each of
several songs: it asks on a song, opens another, asks there, and goes back and forth. Only the song
that's open is in the studio; the others' requests work on the host, as above, so a device carries no
more than its one song.
- **Leaving a song.** Before another song opens while this device's request is at work on the open
  one (or on its way to the host), the studio saves the open song first (`openSong` and
  `saveBeforeLeaving` in actions.ts, 4 s at most), so the agent's changes, saved on the host from then
  on, land on the song with everything done in the studio so far. The agent's batches are held
  meanwhile (they'd make the song unsaved again as fast as it's saved). What isn't saved in time stays
  on the device and is put together with the agent's when the song opens there again, as when a page
  goes. The studio then tells the server which song it has open at once. A batch held, or on its way
  to the studio as it leaves, is answered `{ok:false, reason:'not-open'}` (it never went in there),
  and the server saves it itself; `agent-flush` names its song, and is answered the same way. `…/state`
  answers what the studio showed on that song as it left it. Of two songs asked for one after the
  other while the first waits on the save, the last asked for opens.
- **Coming back.** The song opens as the host has it, with the history this device kept of it and
  the agent's changes since as their job's step (`behind`, above): one Undo takes the song back to
  before the request, whether the changes came while it was open or not. While a request is at work
  on a song, the device keeps the song as saved even when it has no history yet (`Keepable.agent` in
  kept-history.ts), so a song left before the agent's first change still gets its step.
- **How many at once.** The runner runs two jobs at a time. One more waits its turn there
  (`agent-queued`): "Waiting for another request to finish" under its request, for as long as that
  takes, and its limits count from when it starts.
- **What the studio shows.** The bar's button turns for the open song's request only; its dot says a
  reply of this device's hasn't been read, on the open song or on another (both show when a reply
  waits elsewhere while the open song's request works). A reply is read once the bar or the page is
  open on its song (`unseen` in agent.ts, by song). With a reply waiting on another song, the bar
  offers a row for it under the field, "“Song”: a reply is waiting", which opens that song at the
  reply; a song still at work is found by typing ("“Song”: the agent is at work") and adds nothing to
  the bar otherwise. In the Songs dialog, a song this device's request works on has a ring in place of
  its icon, and one whose reply waits has a dot on it. Where a reply asks the studio to go (`go`) is a
  place in its own song: it isn't gone to while another song is open.

## Live channel (`/api/live`)

The server hands the agent only `harnesses`, `agent-queued`, `agent-started`, `agent-progress`,
`agent-session`, `agent-done`, `agent-failed`, `agent-harness` and `history` (`AGENT_MESSAGES` in
`apps/server/src/live.ts`). The
agent's other traffic uses the existing `state`, `played`, `ack`, `transport`, `play-notes` and `saved`.

**Runner → server**
- `hello {role:'runner', name, key?, caps:{render, agent}}`. `caps.render` is unchanged; `caps.agent:
  true` means it runs agent jobs. Only a keyed runner with `caps.agent` is handed jobs, sign-ins and
  `agent-on`.
- `harnesses {list:[HarnessInfo], from?:'run'}`. Allowed devices hear the result as `agent-settings`.
  `from:'run'`: said again with no look made, because a run said what an alias stood for (Claude
  Code's) or what its account has left, or because only the limits were read again (`agent-limits`);
  the rest is as its last look found it, and it doesn't count as a look (`…/harnesses/look`).
- `agent-queued {job, why?:'harness'}`: the runner holds the job until another has finished (it runs
  two at once, and one a conversation), or, with `why: 'harness'`, until the job's harness has signed
  in or updated. The server lets it wait as long as that takes: no quiet and no ceiling count for it,
  and its line under the bar says "Waiting for another request to finish" ("Waiting for Claude Code to
  be ready" for its harness). Stop still stops it.
- `agent-started {job}`: a job it held starts. Its ceiling and its quiet count from now (any other
  message of the runner's about the job starts them too). A job that starts at once is said neither.
- `agent-progress {job, line}`
- `agent-session {job, session}`
- `agent-done {job, reply?, usage?}`. `usage: {input, cached, output}` is the tokens the turn used, as
  its harness counted them (below, "Usage"); the server keeps it by the job's harness, model and
  effort. `reply`, the harness's last chat message, stands as the reply only when
  the agent never called `finish`, even once asked for it (below, "End of the turn"). It's often markdown, so it's made plain first (`plainReply` in
  `apps/server/src/agent/plain.ts`): its markup goes, paragraphs, headings, list items and table rows
  keep a line each, and past 600 characters it's cut at the end of a sentence, with "…".
- `agent-failed {job, error, fresh?, usage?, why?, resets?}` (`usage` as for `agent-done`: a failed turn used what it
  used). `fresh: true`: the harness's model service refused the
  conversation itself, and the thread's next request starts a new conversation (below, "Ending early").
  `why` is said only when the harness made it plain: `usage` (its account is out of usage; `resets`, in
  ms, when the limit that refused it starts again, when that's known), `signed-out` or `not-installed`
  (below, "Why a request failed, and Try again"). The server keeps what it knows of (`checkFailureKind`
  in `@holo/agent/limits`: a reset ahead, within 35 days).
- `agent-harness {harness, kind:'login'|'update'|'install'|'refresh', state:'running'|'done'|'failed', url?, code?, ask?:'code', line?, error?}`.
  A sign-in, an update or an install says `done` or `failed` only after the runner has looked at its
  harnesses again (its `harnesses` comes first).

All of these but `hello` are taken only from a keyed runner. The `agent-*` messages about a job are
taken only from the runner it was handed to, while it runs.

**Server → runner** (keyed runners only)
- `agent-on {}`: the agent is on. Sent to a runner with `caps.agent` when it joins while the agent is
  on, and to every such runner when the agent is turned on (`PUT /settings`, or a pairing while it's
  off). Only then does the runner look for the harnesses. There is no `agent-off`: with the agent off,
  the runner is handed nothing.
- `agent-run {job, thread, harness, model, effort, middleC, prompt, token, session?, workspace, base, limitMs}`.
  `workspace` is the thread's id; `base` is where the tools reach the server
  (`http://127.0.0.1:<port>`); `middleC` is `'C3'` or `'C4'`, as the studio names notes; `limitMs` is
  the job's ceiling (below), which the runner's own limit is set a minute past.
- `agent-cancel {job}`
- `agent-login {harness}`
- `agent-login-code {harness, code}`
- `agent-update {harness}`
- `agent-install {harness}`: run the harness's official installer (the runner's own fixed command),
  then look again.
- `agent-refresh {light?}`. Without `light` (Look again), the runner forgets any seal check that failed
  for a version, looks again, and answers `harnesses`, then `agent-harness {kind:'refresh', state:'done'}`
  for each harness. With `light: true` (Settings › Agent was opened), it looks again quietly, unless a
  look is under way: versions, sign-ins, models and efforts as they are now, each seal as remembered for
  its version; it answers `harnesses` only.
- `agent-limits {}`: Settings › Agent was opened. The runner asks each harness that's found, signed in
  and not signing in or updating what its account has left (`Harness.limits()`), and says the list
  again (`harnesses {from:'run'}`) if any answered. Nothing else is looked at, and nothing is asked
  while a look is under way (a look reads the limits too).
- `pairing-code {code, expires}` (the runner prints it)

**Studio → server**
- `hello {role:'editor', name, agentToken?}`. A token that isn't an allowed device's leaves the studio
  without the agent.
- `state {state}`, as before, now also with `view` and `scan`; `hidden` when the page is hidden, and
  `revision`, the song's revision it carries on from (how the server knows it has picked up a job's
  changes saved there). Opening another song is how the server sees the requester leave a job's song:
  the studio says so at once, not at its next report, and the job's changes are saved on the server
  from then on.
- `played {events}`: what's played here, sent while a job of this device's listens (or the `holo`
  command's listen does).
- `history {action:'undo'|'redo'|'step', label, job?}`, sent only while the agent is on and this device
  is allowed. `step` is a step of the user's own, sent only while one of this device's jobs runs. From
  a device no longer allowed, it's answered with `agent-removed`.
- acks: `{type:'ack', id, ok, …}`. An ack is taken only from the connection the request went to.

**Server → studio**, asked (answered with an ack carrying the same `id`):
- `agent-ops {id, project, job, batch, ops, label, continues?}` (`continues`: the first go of the request
  this job carries on, whose undo step the batch joins): ack `{ok, revision?}` once applied and kept on the
  device (`keepNow`, docs/architecture.md: a reload or a closed tab after it brings the change back and
  saves it), or `{ok:false, error}`. A page that goes before then never acks, and the tool hears 409
  `away` (above).
- `agent-flush {id, project}`: save now; ack `{revision}`, or `{ok:false, reason:'not-open'}` when
  another song is open (the song is then as the host has it).
- `agent-played {id, seconds}`: ack `{notes:[PlayedNote]}` from the last minute of what was played here.
- `agent-capture {id}`: ack `{ops, notes, tracks, regions}`, what Capture would keep of the last phrase
  played here (not applied here: whoever asked applies it), or `{nothing}`; the phrase is forgotten.
- `agent-compare {id, job, from, to}`: ack once it has started playing.
- `agent-commands {id}`: ack `{commands:[{id, title}]}`, the bar's commands (by their fixed ids, not a
  marker's or a track's) this studio can run now.
- `agent-import-audio {id, project, attachment, name}`: ack `{file:AudioFile}` once the studio has
  fetched the attachment (`GET /api/agent/attachments/:id/data`), decoded it and uploaded it as a WAV
  (`POST /api/projects/:id/files`), or `{ok:false, error}` (another song open, a recording the browser
  can't read). Up to 10 minutes.
- `agent-front {id}`: ack `{ok:true, front}`, `front` being whether the page is in view
  (`document.visibilityState === 'visible'`). Asked of each of a device's studios that last said it
  isn't hidden, when a notice is due for that device (below, "Notices outside HO[LO]"); one that
  doesn't answer in 1.5 s (a page its browser froze) doesn't hold the notice back.
- `transport {id, action, at?}`, the existing message.

**Server → studio**, told:
- `play-notes {events, track, port:'Agent'}`, the existing message.
- `agent-status {job:JobView, now}`, to allowed devices' studios: those of the requesting device
  (whichever song they have open), and those with the job's song open. `JobView.title` is the song's
  title as the request was made: a studio with another song open names the job's song by it. `now` is the host's time (ms): a job's times are the host's, so the studio
  keeps how far its own clock is from it (`skew`, changed only by a second or more) and counts how long
  a request has worked on the host's clock (`serverNow`, `elapsedMs`). Its own requests are stamped
  with it too, so the page orders the conversation by one clock.
- `agent-listen {job, state:'on'|'off'}`. `on` goes to the requester's studios with the song open, `off`
  to all of the requester's studios. Nothing is sent between two parts of a listen; `off` follows when
  the listen is over.
- `agent-settings {enabled, harness, model, effort, harnesses}`, to allowed devices, when the settings or
  the runners' harnesses change. Other studios get `{enabled}` alone, and only when it changed.
- `agent-harness {…}`, to allowed devices, as from the runner (checked: only http(s) links, a printable
  code).
- `agent-removed {}`, to a device that was just removed.
- `agent-devices {}`, to allowed devices: the device list, or the requests waiting, changed.
- `saved {project, revision}`, when a job's batch was saved on the server (its studio away), to the
  studios with the song open.

**`PlayedNote`** is `{tick, time, pitch, velocity, length, port}`. `tick` is the song's tick when it
was played (null when the song wasn't playing); `time` is ms from the listen's start (or from the start
of the stretch `played` asked for); `length` is ms (null while still held).

**`JobView`** is:
`{id, project, device, harness?, stop?:{why, resets?}, continues?, state:'waiting'|'running'|'awaiting'|'done'|'failed'|'cancelled', request, line?, reply?, label?, permission?:{kind, detail, pack?}, brief?, briefWarnings?:[{line, kind:'command'|'url'|'secret'}], view?:{blocks, versions, dock?}, go?, error?, started, finished?}`.
- `waiting` lasts until the runner or the job's tools are first heard from.
- `briefWarnings` are the brief's lines (from 0) the studio flags, each once: `secret` for a line that
  mentions one (ssh, `.ssh`, `id_rsa`/`id_ed25519`, private keys, `.pem`, `.env`, credentials, tokens,
  passwords, API keys, secrets, keychains, `~/.aws`, `~/.config/gh`, `.netrc` and the like, `/etc/passwd`
  or `shadow`), else `url` for a link, else `command` for a command to run (`briefWarnings` in
  `apps/server/src/agent/jobs.ts`).
- The server keeps the last 50 ended jobs in memory; the bar reads older turns from the thread.

## A request's life

1. **Request.** The studio makes each file ready (a picture redrawn in the browser at up to 2048 px on
   its long side, a recording up to 25 MB measured when the browser decodes it, a MIDI file read into
   notes). It posts each to
   `/api/agent/attachments`, then what it measured to `…/meta`, then posts `/api/agent/requests` with
   their ids and the context.
2. **Server.** Checks the song is open in this device's studio (`not-open`), that no other job runs on
   it (`busy`), the attachments, and that there's a harness to run it (`no-runner`, `no-harness`,
   `not-sealed`, `signed-out`). It asks the studio to save (`agent-flush`, up to 10 s), then takes a
   restore point (`store.snapshotNow(project, 'Agent')`). It builds the prompt from the song as saved:
   1. the agent's rules (`packages/agent/AGENT.md`, at most 40,000 characters; a short fallback if it's
      missing);
   2. "Since your last reply", on a thread that has one: what the user did since (undo, redo, their own
      steps, a turn that stopped or failed, a "Not now"), then `describeChanges(seen, now, {middleC})`,
      or "The song is as you left it.";
   3. "What the studio shows": the context, in words;
   4. "Attachments": each id, name, type, size, and a few words of what was measured;
   5. "The request": the user's words, or a preset's fixed words.

   It makes the job (`agj_…`, `waiting`) and its token, and sends `agent-run` to the runner that has
   the harness. It adds the turn, clears the thread's events, and starts the job's two limits: its
   quiet and its ceiling ("Ending early", below). A permission still waiting on that song is passed
   over (`done`).
3. **Runner.** It runs at most two jobs at once, one per thread. It opens the thread's workspace
   (`${XDG_CACHE_HOME:-~/.cache}/holo/agent/<thread>`, mode 0700) and puts the token in
   `<workspace>/.holo-job` (mode 0600). It starts the harness sealed, with `@holo/agent`'s MCP server as
   its only tools (`HOLO_URL`, `HOLO_JOB`, `HOLO_JOB_TOKEN_FILE`, `HOLO_MIDDLE_C`), the prompt on stdin,
   and the thread's session resumed if it has one. The rules (`AGENT.md`) go where the harness reads
   them (a system prompt, or the workspace's `AGENTS.md`), not in the prompt too; a harness that reads
   `AGENTS.md` only when a conversation starts (Cursor, Codex) gets them at the head of a resumed turn's
   prompt, so the rules as they are now reach it. Each change the tools make is an `agent-ops` batch
   for the requester's studio, which merges it into the job's undo step (saved on the server while
   that studio is away, and picked up by it as that step). The runner stops the harness a minute past
   the job's `limitMs`, counted from the turn's start (the go asked for `finish` below included), if the
   server hasn't ended the job by then; a job without one gets an hour.
4. **End of the turn.** The agent calls `finish {label, reply}` (and `ask_permission`, `look` or
   `hand_off` before it if it needs to), then the harness exits.
   - A run that ends well without a `finish` that went through (the harness answered in its own chat,
     or gave up after `finish` refused its view) is carried on once in its conversation, with only
     `FINISH_NOW` (`packages/agent/src/harness/adapter.ts`) as the prompt, under the same job and token:
     one turn, one undo step. HO[LO]'s MCP server marks a `finish` that goes through with
     `.holo-finished` beside the job's token, cleared before each run; a refused one leaves none. If
     that go doesn't finish either, or fails, the first go's last words stand; a tripwire still stops it.
   - A refused `finish` answers that nothing has reached the user yet, why, and the view's grammar, so
     the model can write it again (or leave the view out and stop mentioning it).
   - The runner sends `agent-done` and removes the token file.
   - The server revokes the token, asks the studio to save, then stores the song as saved as the
     thread's `seen_doc`.
   - The job becomes `done`, or `awaiting` if a permission was asked.
5. **Permissions.** On the device that asked, the bar shows one button. A click runs the studio's own
   code:
   - `install-pack`: the Library's install queue;
   - `send-creation`: `sendToCreation`;
   - `bounce` ("Bounce the song"): `bounceSong`, kept with the song on the host and not downloaded (made in that
     studio's page, or by the host where its device has its bounces made there: Settings › Audio);
     the result says its length and its path under `bounces/`;
   - `render` ("Hear it as my-game"): the creation renders the song (`POST /api/projects/:id/render`),
     and the studio waits (up to 30 minutes) until it's back as a soloed audio track, or failed;
   - `screen`: one frame of what the user picks to share (a phone, which can't, takes a photo instead),
     shown before Send;
   - `photo`: the camera or a picture, redrawn as a JPEG, shown before Send;
   - `microphone`: a recording of up to two minutes, as WAV, measured.

   What was captured goes up as an attachment. The studio then posts
   `/permission {grant:true, result, attachments}`. The server starts the follow-up turn as a new job on
   the same thread (the same harness session). Its prompt says what was allowed and what happened, and
   lists the attachments. `{grant:false}` ends the job `done` with the reply "Not now", and the agent
   hears so next time.
6. **Ending early.** The job ends `cancelled` or `failed`, and its token is revoked, when:
   - someone presses Stop on the bar, at any time, whatever the limits below;
   - the requester undoes a step of the running job;
   - the requester's device is removed, or the agent is turned off;
   - it goes quiet for 15 minutes (`idleMs`): no tool call, no line under the bar, no message from its
     runner about it. A tool call under way (a render, a measurement) counts until it answers, so a
     long one never makes a job quiet. "It went quiet for 15 minutes"; "It didn’t start in 15 minutes"
     for one never heard from. A job its runner says it holds (`agent-queued`) isn't quiet: it waits
     its turn however long, and its quiet starts as it does;
   - it reaches its ceiling, however busy it is, against a run that never ends: 2 hours (`clockMs`), 3
     for a scan preset (`scanClockMs`), counted from when it starts (not while its runner holds it).
     "It took longer than 2 hours";
   - the runner drops for 15 s, or the harness fails.

   The runner is sent `agent-cancel`, except when the harness failed or the runner dropped. The agent
   hears next time that its turn didn't finish.

   **A restart of HO[LO]** (`Jobs.recover`, as it starts). A job's clocks, its token and its runner's
   word of it live in memory, so a turn that was working can't go on: it reads `failed`, with the
   error "HO[LO] restarted while it was working", and the agent hears so next time, in the same
   conversation. What it had changed is in the song, and is kept with its turn (`changes`, below). An
   update of HO[LO] waits for a working request (`busy` in `/api/health`), so this is for a crash or a
   reboot. The runner outlives HO[LO] and may still run that turn (nothing it does reaches a song: its
   token is gone); as it comes back it's sent `agent-cancel` for each such job, and again for any job
   it says it's at work on (`agent-queued`, `agent-started`, `agent-progress`, `agent-session`) that
   isn't running here, so the conversation's next request isn't kept waiting behind it. A turn waiting
   for the user's click (`awaiting`) still waits: its job is made again from its turn, and the click
   starts the follow-up as before. It's let go (`cancelled`) only when its conversation was started
   over, its device is no longer allowed, or it's from before turns kept who asked.

   The thread's session is carried on after all of these (after a stop, "Continue" goes on where it
   was), but one: a harness whose model service refused the conversation itself, as the error in the
   harness's own result says it (`refusedRequest` in `packages/agent/src/harness/adapter.ts`:
   Antigravity's `INVALID_ARGUMENT (code 400): …`; Claude Code's `API Error: 400 …`, and its `Prompt is
   too long` and `Request too large`, which it says once it couldn't compact the conversation to fit;
   Codex's showing the API's own JSON with an `invalid_request_error`, or `unexpected status 400 Bad
   Request: …`; never a tool's
   answer, the model's words or stderr, so never Cursor's, whose stream doesn't say why a run failed:
   docs/agent-harnesses.md, "A refused conversation", has each wording and where it was seen). That
   request is the conversation so far, so carried on it would be refused again, whatever was asked. The
   same 400s about the account (billing, credits, a quota, a disabled organization), a location, a model
   it can't use or a sign-in are ordinary failures: another conversation would fare no better. So is
   Codex's "ran out of room in the model's context window", the first time: Codex compacts that
   conversation before the next turn's first request. A resumed turn that fails so again in the
   conversation the last one failed so in counts as refused (`refusedIfRepeated`).
   A resumed turn refused before it called any tool starts again at once as a new conversation, in the
   same job, once. One refused later (its changes stand) fails; the runner's `agent-failed` says
   `fresh`, and the server forgets the thread's session and the song it last saw. The next request
   starts a new conversation on the same thread, whose "Since your last reply" says it's a new
   conversation after a refused turn and to read the song as it is now (not how it changed since a song
   it never saw).

## Why a request failed, and Try again

A failed request's reply is its harness's own words. Under it the studio says what would help, from what
the host knows for sure (`JobView.stop`, a turn's `stop`: `afterFailure` in apps/web/src/app/agent.ts),
on the conversation's last exchange, for the device that asked:

| What's known | Under the reply |
|---|---|
| nothing (it may have been passing: the service overloaded, a rate limit by the minute, the network), or `interrupted` (HO[LO] or its runner stopped under it) | **Try again** |
| `usage` | "*Codex* is out of usage: its limit starts again in 2 h 10 min." ("Thu 3 Dec, 07:02" past a day; no time when the harness didn't say). No Try again. |
| `signed-out` | "*Codex* is signed out: sign it in again in Settings › Agent." No Try again. |
| `not-installed` | "*Codex* isn't installed on the host any more: Settings › Agent can install it." No Try again. |

**Never on a guess.** The runner's adapter says `why` (`kindOf` in
`packages/agent/src/harness/adapter.ts`), only for the error in the harness's own result (never a
tool's answer, the model's words or stderr), and only from:
- that error's fixed words, per harness (`Spec.classify`; docs/agent-harnesses.md, "Why a turn failed");
- the harness's own word that the account's limit refused the request (Claude Code's `rate_limit_event`
  with the status `rejected`, and no extra usage taking it);
- or the account's limits as they are then, with a window the model counts against used up (`usedUp`
  in `@holo/agent/limits`): what the run itself said of them (Claude Code), else asked of the harness
  (Codex, Antigravity), ten seconds at most, and only for an error that reads like a limit (the words
  decide whether the limits are read, never what they mean).

A failure HO[LO] ended itself (a tripwire, the ceiling, the quiet) has none. Cursor's stream says
nothing of why a run failed, so its failures always keep Try again.

**Try again** (`POST /api/agent/jobs/:job/continue`, `Jobs.carryOn`) starts a new job on the same
thread, in the harness's same session, that **continues** the failed one:
- it's the same request: its words (or its preset), what the studio showed then, the attachments still
  kept; its prompt has "Since your last reply" as ever (which says the last turn failed, and how), and
  the request under these words (`carryOnRequest` in apps/server/src/agent/prompt.ts): the last go
  didn't finish, what it changed is still in the song, read the song before changing anything, make a
  change again only if it isn't there;
- its `before` and `previous` are the first go's, so a view's versions and the A/B span the whole
  request;
- its `continues` (in the job's view, its turn and its `agent-ops`) is the request's **first** go,
  however many goes there have been. The page shows a request's goes as one exchange, its latest
  (`conversation()`), and the studio keeps them one undo step ("Undo grouping", below).

It works from what the turn kept, so also for a request HO[LO] restarted under.

## Undo grouping (studio)

`apps/web/src/app/history.ts` is pure; `apps/web/src/app/actions.ts` applies it. `Step` is
`{project, label, job?}`.
- **`agent-ops` while a gesture or drag is in progress** is queued and applied, in order, after it
  ends, so the user's step lands first. A hold that lasts 15 s is let through.
- **A batch that was already applied** (the last 500 are remembered by id) is acked again and not
  re-applied. A refused one may be tried again.
- **Merging:** if the job is running and the top undo step is the job's, the ops merge into it (any
  redo is dropped), and the step keeps the song from before the job. Otherwise a new step is pushed,
  labeled "Agent: <the batch's label>".
- **A request tried again is one step.** A job that carries an earlier go on (`continues` on its
  `agent-ops`) joins that go's step while it's still on top: the step becomes this job's (undoing it
  stops this one, and its label is this one's), remembers the request's first go (`Step.first`) so a
  third go joins too, and keeps the song from before the request. When the user has edited since the
  go that failed, the new go opens a step of its own, as any job does.
- **No toasts.** The bar says what the agent is doing.
- **Finishing:** when `agent-status` says the job ended with a label, its steps, undone or not, are
  relabeled "Agent: <label>".
- **Undo and redo** keep `job`, and are reported as `history`.
- **A reload** brings the history back as this device kept it (`kept-history.ts`; docs/architecture.md,
  "Sessions and operations"), `job` and all. A running job's next batch still merges into its step
  (batches wait while what was kept comes back), and Undo of it after the reload stops the job as
  before. A job that ended while the page was away never told it its label: the steps take the label
  from the song's thread (`GET /api/agent/threads/:project`).
- **Picking up what was saved on the server** while the studio was away (`history.pickUp`, above "The
  studio that asked, away") makes the same step a live batch would: it joins the job's step on top, or
  opens one labeled "Agent: <label>", whose Undo goes back to the song before those changes (and before
  the job, when it all happened away), and stops the job if it's still running. Then:
  - with nothing of its own unsaved, the studio's song becomes the server's as the agent left it;
  - with changes of its own not saved yet (made just before the page went, or kept on the device and
    brought back by a reload), those are put onto the server's song (`mergeSongs` in
    apps/web/src/app/merge-songs.ts), and saved on top: nobody's changes are lost. The agent's are
    kept just as the server has them, ids and all (bars it copied, then changed, included), as the
    merge is of songs, not of the agent's operations made again. It compares this studio's song with
    the song its changes were made on, part by part: objects by key, lists of things with an id
    (tracks, regions, plugins, buses, markers, files) or an automation lane's setting or a send's bus
    by that, anything else (a region's notes, a tempo map) whole. That song is the one at the revision
    the studio carries on from, as last saved, opened or picked up here, and kept on the device with
    changes not saved yet (`baseSong` in kept-history.ts), so a reload has it too; else the song's
    history is asked for that very revision. It's never guessed: no other revision stands in for it.
    A batch of the job's that came here too, late (to a page frozen past its time), is taken back out
    of this studio's changes first, so it isn't made twice (the open song's last five are kept as they
    came, let go as another song opens);
  - where they can't be put together, the song becomes the server's, the step's Undo brings this
    studio's own back, and a notice says which: both changed the same thing differently (a region's
    notes, a track renamed two ways, one removed what the other changed), or the merged song would
    point at what it doesn't have where neither side did (a send at a bus, an automation lane at a
    plugin or a send, a note at an articulation, an audio region at a file, a channel's output, a
    score's group of parts at a track) or keep an id twice (`broken` in merge-songs.ts): "couldn't be
    put together"; what either side had already is no clash (the studio lets a region's notes keep
    an articulation the track it's moved to doesn't have); or what this studio's
    changes were made on isn't known: "The agent changed the song while this device had unsaved
    changes";
  - after a reload, the history kept at a revision of the run comes back with the step on top: joined
    to the job's step on top when it has one (it keeps the song from before the job), else a step whose
    Undo goes back to the song the history leads to (kept with it, else as the song's history kept that
    revision); the song is as the server has it with the run, if the agent saved again as the page
    opened. Kept at another revision, or at one not known with no job's step on top, it starts afresh
    as before. The server not answering, it's asked twice more, a few seconds apart; the history stays
    on the device till then.

  The studio then carries on from the server's revision; the job's later batches come live again and
  merge into the step. A batch already applied (the last 500 remembered, those picked up included)
  isn't applied again, here or there. The A/B and the view's versions work as after a reload: from the
  job's first step still in the history, and from the song's history.
- **The bar after a reload** follows this device's requests across it (`holo:agent-follow` in the
  browser's storage): those still working, and those that ended with the bar closed until it's opened.
  As the live channel opens, each is asked of the song's thread (`catchUp`): the bar's button turns while
  one works, with its line, or shows a reply is waiting, which the bar shows with its view when opened.
- **A/B** (`apps/web/src/app/compare.ts`) plays the bars from the song under the job's first step still
  in the undo history, then from the song now. Stop, or a change to the song, ends it.
- **The existing `ops` message** (from the `holo` command) is unchanged: one step per command,
  "AI: …", with a toast.

## What a reply shows (the view)

Under its sentence a reply can show a view: blocks the agent composes from a closed set of pieces, whose
controls act on the open song. Nothing in the code is a use case (there's no "A/B player"): an A/B is
two play buttons, a tuning report a list whose rows go to notes, a mix a table of sliders. What to show,
and whether to show anything, is the agent's call; `packages/agent/AGENT.md` gives it principles, not a
catalog. The format is `packages/agent/src/view.ts` (`@holo/agent/view`), shared by the agent, the
server and the studio, and importing only `@holo/session`.

**Blocks:** `text` (and `quiet`), `row`, `group` (with a `title`), `list` (rows of `text`, `detail`, and a
`do`), `table` (`head`, `rows` of words, numbers, or a text, button, slider or toggle), `button`
(a label and a `do`), `choice` (a switch of two to six options: the one clicked stays lit), `slider` and
`toggle` (bound to a setting), `chart` (points `{y, x?, label?, go?}`, as a `line`, `bars` or `dots`,
with a `unit`, `min`, `max` and a `ref` line), `notes` and `wave` (a few bars of a track's notes, or its
recording, as the song is or as a version had it). A recording's `notes` are its sung notes where they play
now, faint where they were sung when an edit moved them, so a shifted or tuned take shows its edit.

**Actions** (`do`): `play` (bars `from` to `to` of a version, or of the song as it is, with some tracks
`solo`; clicked again it stops), `go` (a bar, a track, a region, a track's `notes` from one position to
another of one pitch, a view, a plugin's window: a recording's notes are selected in the Audio Editor's Notes
view, numbered as it numbers them, and the `notes` view opens that view), `set` (a setting to a value), `keep` (a version made the
song again), `command` (one of the bar's commands, by id: the agent reads the list in `song_status`,
and a command added to the bar is the agent's to use too) and `ask` (a next request, sent when clicked).

**Settings** (a slider's, a toggle's, a `set`'s) are a channel's (a track's, a bus's, the master's):
`volume`, `pan`, `mute`, `solo`, `send:<bus>`, `fx:<plugin>:<param>`, or `on:<plugin>` (on or bypassed).
The agent names them as `TYPE[#N].PARAM` and `TYPE.on`; `finish` resolves its names to ids
(`packages/agent/src/tools/present.ts`) and refuses, with the reason, what isn't in the song.

**Versions.** `before` is the restore point taken as the job starts; `version` keeps more as the agent
makes them (`POST …/version`); `after`, the song as the turn left it, is kept at the turn's end when the
view names it; `previous` is the previous request's `before` (each turn keeps its own in `extra`), to
compare an earlier change, and is refused on a conversation's first request. A view that plays both
`before` and `after` is refused when the job's tools changed nothing: they'd be the same song. Each is a revision in the song's history (`GET /api/projects/:id/history/:rev`, 200 kept),
so a view still plays after a reload, and a version that has aged out says so.

**The dock.** `finish` may also give a `dock`: a few of the view's controls again, in one row a phone
keeps at hand once the reply has been read (the tray, below), for a reply that leaves something to decide
while the person listens or looks at the studio (three takes and Keep). It's kept in the view
(`View.dock`) and checked as its blocks are (`checkDock`: problems said at `dock[1]…`), then: `button`,
`choice` and `toggle` blocks only, with any action; at most 5 controls (each button and toggle, and each
option of a choice, is one); labels of at most 20 characters. A dock needs a view (the tool and the
server refuse one without), and its versions are kept and resolved with the view's. It's never drawn on
the page or in the bar, where the view holds the same controls. What goes in it is the agent's call, as
the view is; most replies have none.

**Limits:** 24 blocks at the top, 80 pieces in all (list items and table rows count), three deep, 10,000
characters as JSON; 24 list items or table rows, 6 columns, 6 options, 256 points, 8 versions a turn;
a dock's 5 controls and 20-character labels. Words are plain text, drawn as text.

**In the studio** (`apps/web/src/ui/AgentView.tsx`, `apps/web/src/app/agent-view.ts`) the view sits
between the reply and a brief, drawn with the studio's own buttons, switches, rows and canvases. It's
checked again before it's drawn. A click does only what the user could do themselves:
- A version plays through the A/B's player (`playPasses` in `actions.ts`) and stops if the song changes;
  the song as it is plays as playback does, so a slider moved while it plays is heard. A recording's
  note edits in the bars it plays are rendered first (a version's too), the transport waiting as Play
  waits for sounds, so an A/B is heard edited from its first note.
- A slider's drag (or a burst of keys) is one undo step, as a fader's; a `set` or a toggle is one too,
  named for the setting ("Vocal: Volume").
- `keep` replaces the song with the version, under its own id, as one undo step ("Keep “Lower”",
  "Keep the original").
- A `go` or a `command` closes the bar, and the page where it covers the studio (a phone held upright),
  so the studio shows; a sheet or a desktop's dock beside the studio stays open. The rest leave it open.
- A button that changes the song says how, in the studio's words: a `set` its setting and value, a
  `keep` its version, a `command` its own title, an `ask` its request.
- `go` on `finish` runs once, on the device that asked, as the reply arrives (not after a reload).

## The page (phones, tablets, and a desktop's dock)

On a phone or a tablet, and on a desktop with the agent on for this device (`usesPage` in
apps/web/src/app/page-layout.ts: every layout but a desktop's, and a desktop's too once `isOn`), the bar
opens as the page (`apps/web/src/ui/TalkPage.tsx`). Every opener only sets `bar`, so Ctrl /, the slash
button and the swipe down all bring it; a second press of the slash button puts it away.

- **Where it goes.** On a phone held upright, a solid panel between the control bar and the transport,
  the whole width; the transport and the tabs stay in sight and in reach. On a phone on its side, a
  sheet 340 px wide down the right edge, under the transport row; while its field has the keyboard it
  widens across the content column, its header goes, the newest turn folds to a line, and the field
  shows three lines. On a tablet, a sheet a third of the width (340 to 420 px) under the control bar,
  beside the studio; it and the Library or Inspector overlay close each other. A window narrower than
  1180 px is a tablet to the studio (app/layout.ts), so it gets the sheet. On a desktop with the agent
  on, a dock 380 px wide down the right side, under the control bar (`pageDocks`). It slides in and out
  over the studio in 0.2 s (not with reduced motion), kept drawn while it goes (`useDockLeaving` in
  ui/Bar.tsx). Only the dock moves: the studio is laid out again once each way, never for each frame
  of the slide, which a big song or a busy machine couldn't keep up with. In a window 1360 px wide or
  wider the studio gives it the room once it's out (`data-dock` on the page's root, styles/app.css)
  and takes it back in the frame it starts to leave in, so nothing is under a dock at rest; narrower,
  it stays over the studio's right edge, as a sheet is. It stays out while the studio is worked in: the studio's keys go to the studio unless
  they're typed in the dock, Ctrl / from the studio goes to its field, and Ctrl / from its field (or
  Escape there, or its header's button) slides it in. A plugin's window opens in the middle of what
  the dock leaves. With the agent off a desktop keeps the bar. Where the control bar, the
  transport and the column are is measured while it's open; it keeps to what shows above a keyboard
  that covers the page (iOS). On Android the keyboard makes the page shorter, so the field sits just
  above the transport.
- **What it holds.** A header (a grip on a phone held upright, where the song's name and the Commands
  button are in the control bar over it; Done on a sheet; "HO[LO]-agent" and a button that slides it in on a
  dock, as tall as the tracks' toolbar beside it), then the song's conversation, oldest first
  (`conversation()` in apps/web/src/app/agent.ts: every turn the host keeps, the jobs it told of
  standing for theirs, a request on its way and one turned down; its last is always what the bar would
  show). Earlier turns are a line each, the request then the start of the reply, opened with a tap; a
  reply's view is drawn only for a turn that's open. The newest is whole. The conversation starts
  under the header; one longer than the page scrolls, kept at its newest turn, at the foot beside the
  field. One shorter gives the room it leaves to its earlier turns: a turn whose line cuts it short
  shows its request over the start of its reply, on as many lines as there's room for (to three and
  six), the turn nearest the newest first, never so many that the page would scroll
  (`apps/web/src/ui/turn-room.ts`).
  A request working shows its line, how long it has worked (on the host's clock, a second at a time,
  only while it's shown) and Stop. What's typed finds commands in a list over the field, its first row
  nearest it; the field grows with the words to six lines, Enter sends or runs the row, Shift Enter
  starts a new line. A row of the list closes the page, as the bar does.
- **Opening and closing.** It opens at the foot of the conversation and reads it afresh (again if the
  song changes while it's open). On a touch screen the field doesn't take the keyboard as it opens
  when there's a conversation to read. The Commands button closes it, and so do Done (a sheet's; on a
  phone held upright it shows only while the keyboard is up, when the control bar may be out of sight,
  and is always there for a screen reader), a swipe down from its header or from anywhere on a page
  with nothing above to scroll to (held upright) or to the right (a sheet), and a tab on a phone held
  upright. Holding the header still (the grip, and a little way under it), or
  drawing the page partway, fades it to almost clear (13%) while the finger stays, so the studio under
  it shows; it takes no taps while faded (`apps/web/src/ui/page-swipe.ts`).
- **Windows.** A window opened after it (a plugin's, an instrument's, a stage's) shows whole, over it:
  on a phone the window is a sheet over everything, and the page waits under it; on a tablet it floats,
  opening beside the sheet when there's room for it there, over it when there isn't. A press on the
  page brings it back over; a press on a window, that window (`windowOpened`, `windowLeft`).
- **Keys.** The page keeps the studio's keys while it covers the studio (held upright) or has the
  keyboard; a sheet beside the studio leaves them to it otherwise. What's over it takes them first: a
  dialog, or a window opened after it, so Escape closes that before the page. It's under dialogs
  (`--z-page`), so Ctrl / doesn't open it while one is up, and a dialog opened over it makes it inert.
  In its field, Up and Down choose a row of the list only while the words are on one line; in more,
  they move the caret.
- **Solid.** It's the studio's own surface, opaque, with nothing blurred behind it: no cost on a
  phone's GPU or memory beyond its own drawing.
- **The panes under it rest.** Held upright, the views under the page are hidden and their frames
  skipped (`FramePause` in apps/web/src/ui/frame.ts; docs/architecture.md); the transport's display
  keeps going. They draw again as it
  closes or while it's held to see through.
- What's typed, and the files going with it, stay as the window crosses between the desktop's and
  the tablet's layouts (the bar becoming the sheet, or back).

### The tray (phones)

On a phone, once the page has shown a reply that has a dock, that row waits in the studio after the page
closes (`apps/web/src/ui/Tray.tsx`, `trayFor` in `apps/web/src/app/tray.ts`): above the transport held
upright, at the foot of the content column on its side. It's a row of the layout, so it covers nothing;
the view above it gives up its height. Its controls do what the view's do (a version plays, one is kept,
a setting set, a command run, a go taken, with the page's rules), each with its own short label; ^ opens
the page, and × or a swipe across it (either way, unless the row would scroll that way) puts it away.

- **When.** Only the song's newest exchange, once it has ended (not waiting for a click), with a dock
  that passes the check, that the page has shown on this device and that wasn't put away; only while
  the page is closed. The next request takes it: while a request works, or a reply hasn't been read, the
  bar's button's ring and dot are the only signs. A tablet and a desktop have none: their sheet or bar
  can stay open beside the studio.
- **Kept.** `holo:agent-tray` in the browser's storage, `{seen, gone}`: the jobs whose reply with a dock
  the page showed, and those whose tray was put away, as job ids (`agj_` and 12 hex digits; anything
  else is dropped as it's read), the latest 20 of each.
- **After a reload.** As a song opens on a phone (a reload, or another song), its conversation is
  read once, quietly, when a reply read here with a dock wasn't put away (`trayWantsThread`;
  `loadThread(project, false)`): only its turns are kept. The song's job that's working or waiting for
  a click isn't told of from there, so it's neither taken as seen nor as a reply waiting: the bar's
  button's ring and dot, and the requests followed, stay as they are. So the tray comes back without
  the page being opened, and nothing is asked when no tray could show.
- **Cost.** Hidden, it's nothing: no listeners, timers or observers until it shows, and that one read
  as a song opens.

## Notices outside HO[LO]

Settings › Agent has **Tell me outside HO[LO]**: Off, Long runs or Every reply, for this device only,
Off until it's chosen. Choosing one asks the browser's permission on that click, subscribes its push
manager to the host's key, and hands the host the subscription (`PUT /api/agent/push`); Off
unsubscribes, then `DELETE /api/agent/push`. Under the choice, what the browser needs first
(`notifySupport` in apps/web/src/app/notify.ts): a secure page (`pnpm tailnet on`, `pnpm lan on`), on an
iPhone or iPad HO[LO] opened from the Home Screen, or the notices it has blocked.

- **When one goes** (`Notify`, apps/server/src/agent/push.ts, on `jobs.onJobEnd`). Only for the device
  whose request it was, and only if it has notices on. Every reply: the job ended `done` or `failed`.
  Long runs: the same, after more than 60 s of the turn's own work (what follows an OK is a job of its
  own, begun at the click, so the wait for the OK never counts). Both: it ended `awaiting` (it needs the user's OK). Never
  for `cancelled`. Every ending but a cancel is kept as unseen (`agent_unseen`, the device's newest
  50), the badge's count.
- **A bounce the host made** (`Notify.bounced`, on `HostBounces.onEnd`: docs/architecture.md, A bounce
  on the host). A device that asks the host for a bounce sends its agent token with the request, when
  it has one; done or failed, the host tells that device by the same rule (Every reply: always; Long
  runs: a bounce that took over 60 s; not while HO[LO] is in front), and only while the agent is on.
  The notice is "<song>: the bounce is ready (4:07)." or "<song>: the bounce failed.", `kind: 'bounce'`
  with its `song`, on a topic and a tag of its own, so it sits beside the agent's notice for that song
  and doesn't replace it. It counts as nothing unseen (the badge is the agent's replies). A tap brings
  the open studio to the front, or opens HO[LO] on the song; the bounce is there, waiting to be saved.
- **Not while HO[LO] is in front.** Each of the device's studios that last said it isn't hidden is
  asked `agent-front`; if one answers `front: true` within 1.5 s, nothing is sent. A frozen page (an
  iPhone in another app) may still read as not hidden, but can't answer, so the notice goes.
- **What goes.** `{title:'HO[LO] Desk', body:'<song>: a reply is ready.' | '…: it needs your OK to go on.' | '…: the request stopped.', project, job, unseen}`,
  about 200 bytes, the song's name on one line of at most 60 characters. Encrypted for the device
  (RFC 8291, aes128gcm, one record of 4096) and signed (RFC 8292: an ES256 JWT for the push service's
  origin, 12 hours, `sub` the project's URL), with `TTL: 43200`, `Urgency: normal` and
  `Topic` (the first 22 characters of base64url(sha256(song id)): a push service keeps only a song's
  latest for a device that's off). `send` gives up after 10 s and follows no redirect. 404 or 410
  deletes the subscription; any other failure is logged once and changes nothing. The log says each
  send.
- **Storage.** `push.key` in the data folder (a P-256 JWK, mode 0600, kept as `runner.key` is), made
  only when a device turns notices on (`GET /api/agent/push?key=1`), never as the server or a studio
  starts. `agent_push(device, endpoint, p256dh, auth, mode, added)` and
  `agent_unseen(job, device, project, at)`, both deleted with the device; Off deletes the device's rows
  of both. On the device, the choice is kept as `holo:notices` (`{device, mode}`, in the browser's
  storage); Off clears it.
- **The service worker** (apps/web/src/sw-template.js, built as `sw.js`). `push`: shows the notice
  (`tag` the song, so a song's newest takes the place of the last; `data.url` `/?project=…&turn=…`) and
  sets the app badge to `unseen`. Every push shows one: an iPhone allows no silent pushes.
  `notificationclick`: a studio window already open (not `/remote`) comes in front and is posted
  `{type:'open-turn', project, job}`; with none, `/?project=…&turn=…` opens.
- **Opening at the reply.** main.tsx passes `open-turn` to `openTurn` (actions.ts); `startup()` reads
  `?turn=` (and takes it out of the address). The page opens at that turn once the studio has started
  (`audioReady`: on a phone, past Start the studio). If the notice is another song's, that song
  opens: a request at work on the one that's left carries on there.
- **Seen.** The page, and the bar on a desktop, post `/api/agent/seen` as they open and as a reply ends
  while they're open, and set the badge to the answer. The bar's own dot is unchanged.
- **Keeping them going** (`syncPush`). When HO[LO] opens, and as it comes back in front, the studio
  reads `GET /api/agent/push` and sets the badge. With a choice kept on the device, it gives the host
  the browser's subscription again (`PUT`, with the kept mode) whenever the host doesn't have it: the
  browser renewed it (Firefox does now and then) and a notice sent to the old one got 410, so the host
  let it go; or the browser lost it with the site's data (subscribed afresh, the permission already
  given), or made it for another key. Only Off, chosen on the device, clears the choice (and
  unsubscribes the browser), so it's never undone. A choice kept as another device (this browser
  allowed again since, with a new id) counts for nothing; one made before the choice was kept on the
  device is taken from the host.
- **Where it works.** Android and computers, from a browser tab. An iPhone or iPad only from HO[LO]
  added to the Home Screen (iOS 16.4 or later), which keeps its own storage, so it's allowed as a
  device of its own.

Limits, plainly:
- An iPhone has no silent pushes, so a reply seen on another device updates its badge only when HO[LO]
  next opens there, or with its next notice.
- The service worker exists only in production builds: a development server has no notices.
- The host needs outbound internet, to the push services over HTTPS.
- A subscription the browser renews while HO[LO] is closed reaches the host only when HO[LO] next opens
  on that device: the service worker holds no device token, so it has no `pushsubscriptionchange`
  handler. Until then the device gets no notices (the first one sent to the old subscription ends it
  on the host).

## Threads ("since your last reply")

`agent_threads(id, project, harness, session, seen_doc, seen_revision, events_json, created, updated, current)`
holds one current thread (`agt_…`) per song. `agent_turns(job, thread, request, reply, label, state, at, extra)`
holds its turns, the last 50, each with the `device` that asked; `extra` keeps the permission, the brief and its flagged lines, the view (its dock too) and
its go, the error, and the attachments, and what a turn needs to be read or carried on later: when it
began and ended and the song's title then, the harness, model and effort it ran with, what the studio
showed as it was asked (`context`) and its preset, what the agent was told the user did before it
(`heard`), what its tools changed (`changes`: each batch's label in order, with how many in a row had
it, 40 at most, written as each batch goes in), the revisions it calls `before` and `previous`, and
`stop` when HO[LO] knows why it didn't go on (`{why, resets?}`: `interrupted`, HO[LO] or its runner
stopped under it; `usage`, `signed-out`, `not-installed`, as its runner said), and `continues`, the
first go of the request it carries on. A turn in `GET /api/agent/threads/:project` says its `harness`,
`stop` and `continues` too. Changing the harness, or `reset`, starts a new thread; the old one is kept but no
longer current.

A thread keeps the user's doings since the last reply, the latest 20, and clears them once a prompt has
told them: `undo`, `redo`, `step`, and `stopped`, `failed` or `denied` for a turn that didn't end well.
`seen_doc` is the song as saved at the end of the last turn.

`describeChanges(before, after, {middleC})` (`packages/session/src/diff.ts`) lists at most 20 lines,
the last "…and N more changes" when there are more:
- song settings, tracks, mix, plugins, automation, regions;
- notes per track, as "Keys bars 9–12: 4 added, 2 removed, 3 changed".

## The agent's tools (`@holo/agent`)

`packages/agent/src/tools/index.ts` lists 43 tools (at most 48: Claude Code, Codex and Cursor each list and
call 48 sealed, docs/agent-harnesses.md; Antigravity has them all up front), named for MCP (lower-case letters, digits and `_`). Changing and
asking tools run one at a time, in the order they're called; seeing and playing tools run alongside. A
change may also post a line under the bar (`…/progress`).

| Tool | Kind | What it does |
|---|---|---|
| `song_status` | see | Where the user is: the song's settings and tracks, the playhead, the selection, the cycle, the view, how notes are named. |
| `song_show` | see | The whole song as text: tempo and meter changes, markers, mastering, every track and bus. |
| `song_set` | change | Title, tempo, key and meter, from the start or as a change at a position; who it's by and its album (beside the song, outside undo; a creation's song keeps its creation's). |
| `marker` | change | Add, rename or remove a marker (a marker starts a section of the Arrangement lane). |
| `chords` | change | The song's chord symbols (the Chords lane's and the Score's: written, not played): list them, set or remove one at a bar and beat, or write several. |
| `cycle` | change | Set the cycle, or turn it off. |
| `looping` | change | Make the song a loop (a game's or an app's music), or an ordinary song again. |
| `ops_apply` | change | Raw session ops for what no other tool covers; removals, and `arrange` deletes and moves, only with `confirm`. |
| `timeline` | change | Insert, delete, copy, move or repeat whole bars across every track (one `arrange` op); delete and move only with `confirm`. `sections` lists the song's sections (each from a marker to the next, as the Arrangement lane shows them), and delete, copy, move and repeat take one by name (`section`), with `at` a bar or `before`/`after` another section. |
| `notes_show` | see | A track's notes, bar by bar, and after them which are outside the song's key. |
| `notes_write` | change | Write notes from a position, in the compact notation. |
| `notes_clear` | change | Remove the notes that start in a span. |
| `stack` | change | Track stacks: tracks kept together under one header (a folder), mixed through a bus when the stack has one (a summing stack). List them; `make` one from tracks (with `bus: "new"` or a bus's name); `add` and `remove` tracks; give it a `bus` or take it away; `rename`, `move`, `unstack`. A stack routes nothing by itself: where the tool changes a track's output (into the stack's bus, back to Stereo Out) it does it in the same step and says so. `track_add` and `track_set` take a `stack` too. |
| `steps` | change | A drum track as the Step Grid shows it: its bars as lines of steps, a row a piece of the kit (`X` accent, `x` hit, `o` soft, `g` ghost, `.` none). Shown with no action; `write` rows from lines; `set`, `clear`, `velocity`, `fill`, `euclid`, `shift`, `humanize`, `copy`, `swing`, `clear-row`: each of the grid's own edits (`STEP_EDITS` in `packages/agent/src/edits/steps.ts`, which the studio's grid makes its changes with too). For a kit only. |
| `regions` | change | Show, split (chop), delete (with `confirm`), copy, move, repeat, trim, gain, fade, stretch, mute, rename audio and MIDI regions; quantize (to a grid, at a `strength`, with a `swing` on a straight grid) and transpose MIDI, and move a region's notes into the song's key (`into_key`); write a MIDI region's controller and pitch-bend lanes. A region by id, name or "selected". |
| `audio_notes` | change | A recording's notes, note by note, as the Audio Editor's Notes edits them: show, detect, one action for each of the session's note edits (`NOTE_EDITS`): pitch, drift, vibrato, glide, formant, level, mute, timing, split, join, octave, add, remove, reset, a note's sound or edits pasted onto others (`paste`, `copy-settings`), and the macros (correct pitch, quantize time, level); and `midi`, the notes as a new MIDI track (below). Any edit can be `linked`: made in every region playing the same recording too. |
| `track_add` | change | Add a track: a built-in synth, a pack's instrument, or a palette's sound. |
| `track_set` | change | A track's name, fader, pan, mute, solo, arm, instrument, place and sends, and whether it's inactive (kept, but not played or loaded). |
| `synth_set` | change | List or set a built-in synth's knobs. |
| `kit_set` | change | List or set a sampled kit's microphones, tune and decay, and each pad's own sound. |
| `instruments` | see | What can play a track: the synths and the installed packs' instruments. |
| `plugins` | see | The stock plugins, and one's parameters. |
| `fx` | change | Show, add, set, move (reorder) or remove plugins on a track, a bus or the master; a plugin with a key and scale is added in the song's key (an audio effect's automation follows its key changes). |
| `automate` | change | List what can move on a channel, show a lane, write, clear, turn off or read (back on) a lane; a plugin's parameter by type (`eq.hsGain`), position (`eq#2.hsGain`) or id (`fx_….hsGain`). |
| `finish_master` | change | How bounces and renders are mastered. |
| `score_show` | see | The song as score text; with `check`, what a player would stumble on. |
| `score_parts` | see | The parts' staves, clefs and transpositions. |
| `score_write` | change | Write bars from score text (from a scan's system, marking it read). |
| `score_part` | change | How a part is written: staves, clefs, transposition, names, tablature. |
| `score_meta` | change | The score's credits, and a pickup. |
| `packs` | see | The installed packs, or the catalog. |
| `transport` | play | Play, stop, or move the playhead in the studio. |
| `audition` | play | Play notes now, heard and not written. |
| `listen` | play | Listen to what the user plays, in parts, until quiet, Done or `max` (≤ 600 s). |
| `played` | play | What the user just played (up to 60 s back). |
| `analyze_played` | see | Tempo, meter, key, pickup and grid of a performance, and its notes as score text. |
| `capture` | change | Keep what the user just played as regions, as the studio's Capture does: on the tracks that sounded it, where it was played (or from the playhead's bar while stopped), pedal and bends included. |
| `compare` | play | A/B at once: some bars as they were before the request, then as they are now (only when the user asked to hear it now; a view's play buttons let them compare at their own pace). |
| `scan_show` | see | A scan's pages and systems; or one system as images: its strip, then the strip enlarged in parts with guides (below). |
| `scan_status` | change | Mark how far a scanned system's reading got. |
| `attachment_get` | see | An attachment: a picture, a recording's measurements and notes, a MIDI file's notes, a text. |
| `import` | change | Bring an attachment into the song: a recording onto an audio track, a MIDI or MusicXML file as tracks (below). |
| `look` | ask | Ask for a screenshot, a photo or a recording (a permission: it ends the turn). |
| `ask_permission` | ask | Ask to install a pack, send to the creation, bounce the song, export its stems (a WAV for each track, in one ZIP; `stems-stacks`: a WAV for each track stack and each track in none), have the creation render it, or for a screenshot, a photo or a recording. |
| `hand_off` | ask | A brief for the user's own coding agent, only for a change to HO[LO] Desk's code, holo-packs or a creation (no commands or code in it; never to read or send files, keys, passwords or tokens). |
| `version` | change | Keep the song as it is now as a named version, for the reply's view to play or keep. |
| `finish` | ask | End the turn, always, a question's too: the undo step's label, the reply (one or two short sentences of plain text, about 200 characters at most: what changed and where, or the answer), what shows under it (`view`) and where the studio goes as it arrives (`go`, when they asked to see something). |

### Reading a scan: zoomed parts and guides

A model is shown a picture no more than about 1,600 pixels a side, so a whole system came through with
its staff lines a dozen or so pixels apart, and a notehead on a line looked much like one in the space
beside it. `scan_show` with a system (`packages/agent/src/tools/scan.ts`, `packages/score/src/scan/zoom.ts`)
gives the strip as it is, for the whole system at once, then the strip cut into overlapping parts, each
enlarged so its staff lines are about 34 pixels apart (and cut across, a group of staves at a time, when
a system is too tall), each within the model's size. On the parts, guides:

- every staff line drawn over in blue, following the page as it bends (each staff traced across, its
  five lines together);
- the middle of every space, and of every space between ledger lines, dotted in green;
- where ledger lines go above and below, dashed in orange, out to the sixth or halfway to the next staff;
- at both margins, each line and space named: as pitches for the clefs given (`clefs`, each staff's, top
  to bottom), or by place (L1 to L5, S1 to S4, +1 and -1 for the first ledger lines) when no clefs are
  given or the staves found aren't as many as the clefs given.

So a notehead has exactly one guide through its middle: solid blue for a line, green dots for a space.
Where one could still be on a line or in the space beside it (small or heavy writing, a head touching
both lines), `scan_show` with `part` shows that part again twice as large (staff lines about 68 pixels
apart), in pieces, with the same guides, its margins named for that part's own staves; the reading
instructions ask for that look before such a note is written.
The reading instructions (`apps/server/src/agent/prompt.ts`) ask for every notehead read from where it
sits, bar by bar; for every head on a stem (a chord, an octave), on ledger lines too, a stem that runs on
past a head, away from its flag or beam, ending at another however slight the mark there. They say that a handwritten head may be a
small stroke, a slash, a dash or a cross through its ledger line, its pitch where its middle is (not its
heavier end); that a ledger line on its own is not a note; and that off the staff the ledger lines drawn
on the page name a note, not its distance, since a hand seldom spaces them as evenly as the staff: with
none drawn through it or between it and the staff, a note is in the space just beyond the staff.

**Where a harness shows its model only small pictures** (Antigravity: a file of about 10 KB at most,
docs/agent-harnesses.md), a part in colour, 100 KB to 1 MB, would never be seen. The runner tells HO[LO]'s
server the limit (`HOLO_PICTURE_BYTES`; `pictureBytes` in a tool's context), and `scan_show` then gives:

- each part in a palette's few colours (`fewColours`): the paper white, its tone and shadows evened out
  (most of a photographed page's bytes; a dark edge with no paper near stays ink), the ink in four
  shades, or two for a part that doesn't fit in four, and the guides in their own colours. It reads as
  well as the part in colour at about a twentieth of the size;
- the parts cut narrower (`maxWidth`: 640 px down to 300) until every one fits, each still with its named
  margins, and repeating two staff spaces of the one before at least, so a notehead at an edge is whole in
  one of them. The cut is chosen with every staff's names as pitches, whatever clefs were given (they
  change a part's size by a hundred bytes or so), so a part's number is the same with clefs and without,
  and it's kept for the run (a system is asked for again for each closer look). A handwritten grand staff
  comes to a dozen or two parts, a printed one fewer;
- forty parts to a reply: a system in more (four staves across a wide page) says where the rest are, and
  `from` shows them;
- the whole system first, made small;
- the same for a part looked at closer, whose stretch of the strip is too narrow to find its staves by:
  they're the strip's, as found there (`found`), moved to where its lines are in that stretch.

When nothing fits, there are no pictures and the tool's text tells the model to say so, not to guess. Any
other tool's picture past the limit (an attached photo) is left out by the server, with a line saying it
was. Without a limit, a system's pictures are what they were.

The strips are the studio's PNGs, read and written by `packages/agent/src/tools/png.ts` (Node's zlib, no
other library; a palette's pictures are written a few bits a pixel). A strip that can't be read as a
picture is shown as it is, without parts.

There are no tools for opening, creating or exporting songs, or for creations. What the user attached
comes into the open song through `import`; a bounce, the song's stems, sending the song to its
creation and the creation's own render each need the user's click (`ask_permission` with `bounce`,
`stems` or `stems-stacks`, `send-creation` or `render`). In a terminal those are `holo bounce`, `holo stems` (`--by stacks`),
`holo send` and `holo render`.

### A recording's notes: `audio_notes`

`packages/agent/src/tools/audio-notes.ts`. Its actions are `show`, `detect` and one per entry of the
session's `NOTE_EDITS` (`packages/session/src/note-edits.ts`), made from it: each edit's name, summary
and arguments (a field per argument name, its type the loosest the edits give it, with no defaults),
read strictly with `readNoteArgs` and refused in its words, then made with the entry's `apply`. An
edit added to the list is an action here, and a `holo notes` command, with no change to either; the
parity test (`packages/cli/test/parity.test.ts`) fails if either lacks one.
- **The region**: `region` (an id, a name, or "selected"), `track` (alone: its only recording), or
  neither: the only audio track's only recording.
- **The notes** (`notes`): `selectNotes`'s words, "all", "selected" (`selection.audioNotes`, above),
  numbers from 1 ("1-12,15"), "bars 9-13", "pitch E4" (middle C named the studio's way). An edit that
  works on notes needs them; `add` takes none.
- **Found, then kept.** A region without notes in the song has them found on the host (`measure` with
  `what:'notes'`) and cut to what it plays (`pruneNotes`: the notes it plays and the two nearest either
  side), and is numbered so; viewing changes nothing. Its first edit keeps them in the song with that
  edit, in one `updateRegion` (one undo step). After that the notes it keeps are edited, and nothing is
  found again. While they're still being found (40 s), the tool says how far it has got, and the same
  call again gets them.
- **What applies where**: an edit for a line's notes only (`move`, `resize`, `attack`, `join`,
  `boundary`, `transition`) is refused on chords' notes, saying so.
- `show` pages them 40 at a time: each note's number, where its beat plays (bar.beat.sixteenth), its
  pitch as found with its cents and where it's moved (spelled in the key there; "off the key" when it
  isn't in it), its length, its drift and vibrato as sung (matched to the notes found by start, length
  and pitch), and its edits. After an edit, the notes it changed are shown the same way.
- **The macros** are entries of `NOTE_EDITS` like the rest (`packages/session/src/note-macros.ts`), on
  the notes chosen: `correct-pitch` moves each note's centre `centre` % of the way to its nearest
  semitone (or note of the key's scale where it plays, `snap: "scale"`) and takes `drift` % of its
  drift out, leaving notes within `tolerance` cents alone (all the way, a second time changes
  nothing); `quantize-time` (a line's notes) moves each note's beat, after its consonant, `amount` %
  of the way to the `grid` (the piano roll's note values), each note whole, through the same moves as
  `move`, so the warp stays valid and no move goes past 4 s; `level` brings the notes' levels as they
  play toward their mean (or `target` dB), `amount` % of the way, leaving notes with no pitch (breaths)
  alone unless `breaths` is on or they're all that's chosen. A note's level isn't in the song:
  `level` (an entry with `needsLevels`) reads it from the notes measurement's `levels`, matched to the
  region's notes by start and length (a note split or added since has none), waiting while
  they're being found and refusing, saying why, when none can be read.
- **`midi`** (the session's `NOTE_EXTRAS`, beside the edits) adds a MIDI track named after the audio
  track ("Vocal notes"), just below it, with one region over the audio region's span
  (`notesToMidi`, `packages/session/src/notes-midi.ts`): each note at the tick where its beat plays as
  edited (its moves, the region's offset and stretch, the tempo map), to where it ends, at the nearest
  semitone of where it's tuned, its velocity from its level as recorded with its gain (the loudest at
  110; 100 for all when the levels can't be read); breaths, muted notes and notes outside the region
  are left out. One batch, one undo step; the recording's notes aren't kept by it. It takes no
  `notes`. The parity tests check `NOTE_EXTRAS` in the agent, `holo notes` and the studio as they check
  the edits.
- **A note's sound or edits, pasted** (`paste`, `copy-settings`, `audio-notes-edit.ts` `pasteNotes`,
  `copySettings`): `from` is the number of the note copied from, among the region's notes, or among
  another region's of the same recording (`from_region`: its id or name); the tool hands the note
  itself to the edit (its context's `source`), so the edit carries what it copies. A region playing
  another recording is refused: pasting between recordings needs a source-file field, a later stage.
  `paste` (a line's notes) makes each note play the copied note's sound in its place (`s`, its pitch
  and unvoiced start as found, `p` and `u`, as the renderer reads a pasted note); the note's other
  edits stay, its pitch move kept as a distance from the semitone nearest its pitch as found, carried
  onto the new pitch's. It never reads past the copied sound's end: a note no longer than it plays its
  start; a longer one is cut where it runs out, its first part playing all of it stretched over the
  note as far as the warp lets it, and the rest muted (squeezed to a quarter of its length: a quarter
  of what the note has past the sound's length stays quiet at its end).
  `copy-settings` gives each note the copied note's drift, vibrato, glide, formant, level, mute and
  attack (`COPIED_SETTINGS`), each put back where that note has none, and its pitch move as a
  distance from each note's own nearest semitone (so a source tuned onto its semitone tunes each onto
  its own); never where a note starts or ends, nor its sound. `reset` gives a pasted note back its own
  pitch as found, from the notes measured (it waits for them while they're being found).
- **`linked`** (any edit): the edit is made in every other region of the song playing the same
  recording too (`linkedNoteEdits`, `packages/session/src/note-link.ts`), on the same notes: those
  found by the same detection at the same start in the recording that the region plays. A region with
  no notes of its own yet gets those found, cut to what it plays, with the edit (the notes are
  measured for it, waiting while they're being found). Every region changed is one `updateRegion` in
  the one batch (one undo step, its label ending "linked: N regions"), and the answer ends with a
  "Linked:" line saying which regions changed and how, or that none plays those notes.

### Bringing things in: `import`, a bounce, a creation's render

**`import {attachment, at?, track?, name?, tempo?, parts?}`** brings an attachment of the
conversation's into the song (`POST …/import`, `apps/server/src/agent/import/`), then sends its changes
as one batch, one undo step with the rest of the request (`addFile`, `addTrack`, `addRegion`;
`ops_apply` still refuses `addFile`).
- **A recording** becomes one of the song's audio files, kept as WAV so every renderer reads it. A WAV
  the engine's reader takes (PCM of 8 to 32 bits, or float) is copied as it is, its rate and channels
  kept; FLAC and AIFF are decoded on the host (`decodeInput`) and written as 32-bit float WAV; MP3, Ogg,
  M4A and any other WAV go to the requester's studio (`agent-import-audio`), which decodes them and
  uploads them as WAV. It goes from `at` (the playhead when unsaid) on the audio track `track` names,
  or a new audio track named `name` (or the file's name). A job asking again for the same attachment
  gets the same file.
- **A MIDI or MusicXML file** (`.mid`, `.musicxml`/`.xml` in UTF-8 or UTF-16, `.mxl`) is read on the
  host (`projectFromMidi(readMidi(…))`, `readMusicXml(await scoreText(…))`) and merged by
  `mergeOps(song, file, {at, tempo, parts, into?, name?})` (`packages/session/src/merge.ts`):
  - `parts` chooses the file's parts by name (or the start of one) or number from 1; every part with
    notes when unsaid. Each becomes a new track, or the one part goes onto `track` (an instrument
    track) as a region.
  - Everything gets new ids: tracks, regions, plugins, articulations.
  - The song keeps its meter and key. The notes keep their beats from `at` (the playhead's bar when
    unsaid), and each region starts and ends on the song's bar lines. A file with a pickup lands with
    its first full bar at `at`, the pickup just before (at `at` when there's no room).
  - A send goes to the song's bus of the same name, or is left out: never to a bus the song lacks. A
    channel's output to such a bus goes to the master.
  - Automation, a performance's dynamics and clef changes move with the notes; a staff's first clef
    stays at the start.
  - `tempo:'keep'` (the default) leaves the song's tempo; `'adopt'` puts the file's tempo map from
    where it lands to the bar line after it ends, and the song's own tempo back there if the song goes
    on past it.
  - What wasn't brought (markers, chord symbols, repeats, a different meter, the file's tempo) is said
    in the tool's answer.
- **Time.** A tool call must finish within about 50 s: the client gives `…/import` 50 s and the server
  answers within about 40. A studio still converting by then answers `{done:false}`, and the tool asks
  the agent to call it again with the same arguments; the conversion carries on meanwhile (up to 10
  minutes).

**`bounce` and `render`** are permission kinds: the agent asks, the user clicks, and the studio does it
(`bounceSong`, or the creation's render through `renderForAgent`). The follow-up turn hears what
happened: the bounce's length and path (`bounces/<song>/<file>.wav`, which a measurement reads), or
that the creation's render is back as a soloed audio track.

**Audio files are WAV.** `POST /api/projects/:id/files` makes a FLAC or AIFF a 32-bit float WAV under
the same id (the `holo audio` command, which sends FLAC, gets the same answer as before), and the
server makes the songs' FLAC and AIFF files kept before this was so WAV once as it starts
(`apps/server/src/audio-files.ts`): the WAV replaces the file, never sits beside it. A bounce and a
headless render read only WAV.

### Measuring

| Tool | Kind | What it does |
|---|---|---|
| `measure` | see | How the song sounds, measured (a take whose notes are edited as it plays, edits in): a take's pitch (cents against the key's nearest scale tone, or a track's notes; its notes spelled as the key spells them), drift, vibrato, timing against the grid and phrase levels, as recorded or as it comes out of its track's plugins (`through: "effects"`, rendered: to check a Pitch Correction or an effect); the mix's loudness, peaks, clipping, sections and balance (rendered, or the newest bounce); each track alone, and where two mask each other; what a plugin does; the studio's meters while it plays (the last `seconds` of it, 8 by default, waiting until it has played that long); an attached recording; what plays a pack that isn't installed is silent, and said. A render not done within 40 s says how far it got, and the same call again collects it. |
