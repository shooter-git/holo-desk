# The bar and the agent: how they work

The **bar** (Ctrl /, the search button in the control bar, or a swipe down on a phone's top bar) is
HO[LO]'s command palette. When the **agent** is turned on in Settings › Agent and this device is allowed
to use it, the bar also takes requests in plain words, with files dropped or pasted on it. The agent
carries them out on the open song through a harness installed on the host: Claude Code, Codex or Cursor.

This page is the contract between the studio, the server, the runner and the agent's tools.

## What doesn't change

The `holo` command, the `holo` skill and `pnpm skill:install` are how HO[LO], holo-packs and creations
are developed from a terminal, and they don't change:
- `packages/cli/src/{main,score,scan,experience}.ts` are untouched;
- so are `skills/holo/` and `tools/install-skill.mjs`;
- so are the HTTP routes the CLI uses (`/api/projects/:id/ops` and the rest) and the runner's render path.

The in-app agent lives in `packages/agent` (`@holo/agent`): the runner's side (`src/runner.ts`,
`src/harness/`), the MCP server (`src/mcp.ts`) and its tools (`src/tools/`). The server's side is
`apps/server/src/agent/`. It never reads or writes the user's own harness configuration (`~/.claude`,
`~/.codex`, `~/.cursor`).

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
- **Asking ends the turn.** What only the user can allow (a pack, sending to a creation, a screenshot,
  a photo, a recording) is asked with one button; the user's click starts the next turn.
- **One request, one undo step.** It's labelled "Agent: …". Its changes reach only the requesting
  device's studio. They're applied on the server only for a scan preset whose studio no longer has the
  song open.
- **Off by default.** With the agent off, `GET /api/agent` answers `{enabled:false, …}`, the studio shows
  nothing of it, and the runner runs no harness and fetches nothing: it looks for harnesses only once
  the server says `agent-on`.

## Identity and tokens

| Who | Credential | How |
|---|---|---|
| Runner | `runner.key` in the data folder: 32 random bytes as hex, mode 0600, made by the server the first time it starts | The runner reads it there (or takes `HOLO_RUNNER_KEY`) and says it in `hello {role:'runner', key}`; compared in constant time. A runner with no key still gets renders, but no jobs, pairing codes or `agent-on`. |
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
`no-runner`, `no-harness`, `not-sealed` and `signed-out`, all with 409. Other refusals carry no reason.

**With the agent off**, only these answer (under `/api/agent`): `GET /api/agent`, `POST /pairing`,
`POST /pair`, `GET /devices/requests/:id`, `GET|PUT /settings`, `GET /devices` and
`DELETE /devices/:id`. Every other route answers 409 `off`, `POST /devices/requests` included.
Turning the agent off cancels every job, so the job-scoped routes answer 403.

| Method and path | Body / query | Answer |
|---|---|---|
| `GET /api/agent` **open** | | `{enabled, allowed, pairing, runner:{connected, keyed}}`. `allowed`: the bearer is an allowed device's. `pairing`: no device is allowed yet (the studio offers the code first; otherwise asking to join, with the code as the way back in). `runner.keyed`: a runner with the key is connected, so a code can be had. |
| `POST /api/agent/pairing` **open** | | `{expires}`. Whenever a keyed runner is connected, with or without allowed devices: it's how the first device gets in, and how a device that has lost its token (its site data cleared, the only allowed one lost) gets back in. Makes a 6-digit code (10 min, single use; a new one replaces it) and sends it to keyed runners as `pairing-code`. 409 `no-runner` without a keyed runner; 429 while pairing is locked. |
| `POST /api/agent/pair` **open** | `{code, name}` (name ≤ 60) | `{token, device:{id, name}}`, and turns the agent on. Allowed devices hear `agent-devices`, so their lists show the new one at once. 401 for a wrong, expired or missing code. 5 tries per code; while no device is allowed, 20 failures in an hour lock pairing for an hour, and once one is, 10 in a day lock it for a day (429). |
| `POST /api/agent/devices/requests` **open** | `{name}` (≤ 60) | `{id, secret, code}`. `code` is 4 characters (no 0/O or 1/I), shown on both devices. 409 `off` while the agent is off; 429 with 5 waiting. A request lapses after 10 minutes. |
| `GET /api/agent/devices/requests/:id` **open** | `?secret=` | `{state:'pending'|'denied'}`. Once approved, the first answer is `{state:'approved', token, device}` and later ones `{state:'approved'}`. 404 for a wrong secret or a lapsed request. |
| `GET /api/agent/devices` | | `{devices:[{id, name, added, seen, current}], requests:[{id, name, code, created}]}`. `current` is the device asking; `requests` are those waiting. |
| `POST /api/agent/devices/requests/:id/approve` and `/deny` | | `{ok}`; 404 if none of that id is waiting. |
| `DELETE /api/agent/devices/:id` | | `{ok}`; 404. It takes effect at once: the device's studios get `agent-removed` and lose agent access, its jobs (running or waiting for a click) are cancelled, and allowed devices get `agent-devices`. |
| `GET /api/agent/settings` | | `{enabled, harness, model, effort, harnesses:[HarnessInfo], relays:[…]}`. `relays` are the sign-ins, updates and installs under way, each as its runner last told it (its `agent-harness` message, less `type`), for a studio that opens Settings later or reloads; one is let go when it ends, after 15 minutes, or when its runner goes. |
| `PUT /api/agent/settings` | `{enabled?, harness?, model?, effort?}` | The settings, as GET. `harness` is an id or null (the first that can be sealed). `model` and `effort` must match `^[A-Za-z0-9][\w.:\-\[\]=]{0,79}$` or be empty (the harness's own). Off stops every job; on sends `agent-on` to the runners; any change is announced as `agent-settings`. |
| `POST /api/agent/harnesses/refresh` | | `{ok}`. **Look again**: the runners look again (`agent-refresh`), a seal check that failed for a version included. 409 `no-runner`. |
| `POST /api/agent/harnesses/look` | | `{ok, asked}`. Settings › Agent was opened: each runner whose last look (its last `harnesses`, or the last time it was asked) is an hour old or more is sent `agent-refresh {light:true}`; `asked` is how many. At most once an hour per runner, and only when a studio asks. |
| `POST /api/agent/harnesses/:id/login` | | `{ok}`. Sent to the runner that has it; progress arrives as `agent-harness` live messages. 404 for an unknown harness; 409 `no-harness`, `busy` (a job runs on it), or no reason when it's signed in already (HO[LO] never signs out or switches accounts). |
| `POST /api/agent/harnesses/:id/login/code` | `{code}` (printable, ≤ 200) | `{ok}`, for a sign-in that asks for a pasted code. |
| `POST /api/agent/harnesses/:id/update` | | `{ok}`. 409 `no-harness` or `busy`. |
| `POST /api/agent/harnesses/:id/install` | | `{ok}`. Sent as `agent-install {harness}` to a runner that reported the harness not found, with an `installer`; progress arrives as `agent-harness` with `kind:'install'`. 404 for an unknown harness; 409 `no-runner`, `busy` (a job runs on it), or no reason when a runner has it already (Update is for that) or none can install it (a Windows host). The body is empty: the runner runs its own fixed command. |
| `POST /api/agent/requests` | `{project, text, attachments?:[id], context?, preset?}` | `{job}`. `text` is 1 to 4000 characters (empty with a preset). At most 10 attachments, each this device's for this song (400 otherwise). 404 for no such song, or a preset's scan that isn't the song's; 409 `not-open`, `busy`, `no-runner`, `no-harness`, `not-sealed`, `signed-out`. |
| `POST /api/agent/jobs/:job/cancel` | | `{ok}`. Any allowed device may stop a job; one waiting for a click is dismissed (`cancelled`). 404; 409 once it has ended. |
| `POST /api/agent/jobs/:job/permission` | `{grant:boolean, result?, attachments?:[id]}` | `{ok, job?}`, `job` being the follow-up's id. Only the device that asked may answer (403), only while the job is `awaiting` (409). `result` is at most 1000 characters; `attachments` as in a request (a screenshot, a photo, a recording). Granting can be refused as a request is (`not-open`, `busy`, `no-harness`), and with 409 when the conversation was started over since the job asked. With a job token, the same path is the tools' (below). |
| `POST /api/agent/jobs/:job/done-listening` | | `{ok}`. The user pressed Done. Only the device that asked (403); 409 once the job has ended. |
| `GET /api/agent/threads/:project` | | `{thread, job}`. `thread` is `{id, harness, turns:[{job, request, reply, label, state, at, permission?, brief?, briefWarnings?, error?}]}`, or null. `job` is the song's job that's running or waiting for a click (a `JobView`), or null: after a reload, its button comes back. |
| `POST /api/agent/threads/:project/reset` | | `{ok}`. The next request starts a new thread. 409 `busy` while a job runs on the song. |
| `POST /api/agent/attachments` | `?project=&name=&type=` and the file as the body (a recording ≤ 200 MB, anything else ≤ 25 MB, text ≤ 100 KB; 413) | `{id, name, type, size}`. Allowed types: `image/png`, `image/jpeg`, `image/webp`, `audio/wav`, `audio/x-wav`, `audio/flac`, `audio/aiff`, `audio/mpeg`, `audio/ogg`, `audio/mp4`, `audio/midi`, `application/vnd.recordare.musicxml+xml`, `application/vnd.recordare.musicxml` (`.mxl`), `text/plain`. The body goes to disk as it arrives, and is cut off at the type's limit (one whose `content-length` says it's over isn't read at all). Its first bytes must be what the type says (415): a recording's first 64 KB are checked; text must be UTF-8, MusicXML UTF-8 or UTF-16, and an `.mxl` a zip with a score in it. 404 for no such song. Kept 7 days, the device's own, for that song. |
| `PUT /api/agent/attachments/:id/meta` | JSON object (≤ 64 KB) | `{ok}`. The browser stores what it measured here. Only the device's own (403). |
| `GET /api/agent/attachments/:id/data` | | The file's bytes, as its type, `no-store`: for the studio to decode a recording the agent imports (below). Only the device that sent it, or the device whose running job may read it (an earlier request on the job's thread, from another device); 403 otherwise, 404 once it's gone. |

**`context`** in a request is what the studio sees:
`{view, selection:{track, regions, notes, from?, to?}, playhead, cycle:{on, start, end}, scan?}`.
Positions are ticks. Each part is checked; a `scan` that isn't the song's is left out.

**`preset`** is `{kind:'scan', task:'read'|'check'|'fix', scan}`. The bar shows it as "Read this scan",
"Check this scan" or "Fix what was flagged". Its prompt is fixed words with only the checked scan id in
them. A preset gets 45 minutes, and carries on if its studio goes (its changes are then saved on the
server). Scan's own Read in, which needs no agent, uses `GET /api/scans/:id/engines/reading`
(`apps/server/src/omr.ts`): the recognition engines' reading as ops the studio applies as one undo
step. That isn't an agent route.

**`HarnessInfo`** is:
`{id:'claude'|'codex'|'cursor', name, found, version?, signedIn?, account?, update?:{available, latest?}, sealed, sealUnknown?, reason?, models?:string[], efforts?:string[], host?, installer?}`.
- The runner reports all three, found or not.
- `sealed: false` means the harness can't be locked down to HO[LO]'s tools. The studio shows it as
  unavailable, with `reason`.
- `sealUnknown: true` (with `signedIn: false`) means the seal couldn't be checked yet: the harness asks
  for its sign-in before it reads its options (Cursor 2026.11.11-b912975). The studio offers Sign in;
  a request is refused `signed-out`, not `not-sealed`. The first look after the sign-in checks the seal.
- `host` is the runner's computer (its host name: letters, digits, `.`, `-`, `_`, ≤ 64).
- `installer` is given only when the harness isn't found and the runner can run its installer (Linux
  and macOS): the command Install runs there, as the confirmation shows it (≤ 200 characters).
- `update` is looked up at most every 6 hours, and never installed unasked. Claude Code's is read from
  its `stable` channel (npm's `stable` tag for an npm install, `downloads.claude.ai/claude-code-releases/stable`
  for the native one), so Update never offers a version `claude update` won't install. Codex's is
  npm's `latest`; Cursor's is what `cursor-agent about` says.
- At most 500 `models` and 50 `efforts` are kept, each checked as settings check them. They're the
  harness's own lists, read on the host (docs/agent-harnesses.md, "Models and efforts"): HO[LO]'s server
  never asks a vendor for them, it keeps what the runner reports.

### Settings › Agent

An allowed device's Settings › Agent lists Claude Code, Codex and Cursor as the host has them, a row
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
   Codex's page and a one-time code, Cursor's page while it waits. A harness signed out isn't offered
   as **Use**.
4. **Signed in**: **Use**, or **In use** for the one the agent runs with.
5. **Update to x.y** when a newer version is out; it asks first ("This updates the *Harness* your
   terminal uses too"), then shows its lines. The runner looks again before it says `done`, so the new
   version's models and efforts show with it. **Up to date** otherwise.

**Look again**, under the list, asks every runner for a fresh look (`POST …/harnesses/refresh`).

**Opening Settings › Agent** asks the host to have its runners look again if their last look is an
hour old or more (`POST …/harnesses/look`): the lists show at once as they were, and change when the
new `harnesses` report comes (as `agent-settings`). Nothing is asked while nobody opens it, and nothing
is polled.

**Model and Effort** list the harness's own names. A saved model or effort the harness no longer
offers stays selected, labelled "(no longer offered)", and a run uses the harness's default instead of
failing (the adapter drops it before the run). Cursor has no Effort list: its model names carry their
effort, and the row says so.

## REST: `/api/agent/jobs/:job/*`

These are for the agent's tools, with the job token. Without a token of the right shape they answer
401. When the job has ended (or its turn has), or the token isn't its, they answer 403. The first call
moves the job from `waiting` to `running`. Routes marked **studio** also answer 403 unless the
requester's studio has the job's song open.

| Method and path | Body / query | Answer |
|---|---|---|
| `GET …/song` | | The Project (JSON). The studio is asked to save first. |
| `GET …/describe` | | `{text}` (`describeProject`) |
| `GET …/state` **studio** | | `{playhead, position, playing, recording, bpm, selection:{track, regions, notes}, cycle, middleC, view?, scan?}` |
| `POST …/ops` | `{ops, label, batch}` (1 to 5000 ops; label ≤ 80) | `{ok, revision?}`. Sent to the requester's studio as `agent-ops`, answered once applied: 400 if it refused, 504 after 60 s. Without the studio: 403, except for a scan preset, whose batch is applied and saved here as a revision by "Agent". Each batch id is applied once. |
| `POST …/transport` **studio** | `{action:'play'|'stop'|'locate', bar?}` | `{ok}`. `locate` needs `bar`. Sent as `transport {action, at?}`, `at` in ticks; 409 if the studio can't (its audio isn't started). |
| `POST …/audition` **studio** | `{track?, events:[[delayMs, status, d1, d2]]}` (1 to 1024; status 0x80 to 0xEF) | `{ok}`. Sent as `play-notes`: heard, not recorded. |
| `POST …/listen` **studio** | `{maxMs, quietMs, last?}` (maxMs ≤ 45000, quietMs ≤ 10000) | `{notes:[PlayedNote], done, part, pending}`: one part of a listen (below). 409 while a part is under way. |
| `GET …/played` **studio** | `?seconds=` (1 to 60) | `{notes:[PlayedNote]}` from the studio's memory of what was just played (`agent-played`). 504 if it doesn't answer within 3 s; 409 with its reason if it can't say. |
| `POST …/compare` **studio** | `{from, to}` (bar numbers; `to` isn't played) | `{ok}`, once the studio has started playing those bars from before the job, then as they are now (`agent-compare`, up to 50 s). |
| `GET …/packs`, `…/packs/available` | | As `GET /api/packs` and `GET /api/packs/available`. |
| `GET …/instruments/:pack/:name` | | That instrument's knobs and microphones. |
| `GET …/scans/:id` | | The scan. 403 if it's another song's. |
| `GET …/scans/:id/strip/:page/:system` | | The system's strip (PNG). |
| `PATCH …/scans/:id/systems/:page/:system` | `{state?:'new'|'read'|'checked'|'approved', written?:[first, last], flags?:[line]}` (≤ 40 flags) | As `PATCH /api/scans/:id/systems/:page/:k`. |
| `GET …/attachments/:id` | | `{name, type, size, meta, data?}`. `data` (base64) comes for pictures, text, and MusicXML up to 1 MB (as UTF-8 text, whether it came as UTF-16 or zipped in an `.mxl`); `meta` is what the browser measured, or null. Only an attachment that the job's request, or an earlier one on its thread, named (403). 404 once it's gone. |
| `POST …/import` **studio** | `{attachment}` | What importing it brings (below): `{done:true, kind:'audio', how:'copied'|'converted'|'studio', file:AudioFile}`, `{done:true, kind:'notes', format:'midi'|'musicxml', name, song:Project, warnings}`, or after about 40 s of the studio still converting, `{done:false, line}` (the same call again waits on). 403 as `…/attachments/:id`; 415 for a picture or a text; 400 for a file that can't be read; 409 with the studio's reason, 504 when it never answered. |
| `POST …/progress` | `{line}` (≤ 200) | `{ok}`. The line under the bar. |
| `POST …/permission` | `{kind, detail, pack?}` (detail ≤ 300) | `{ok}`. `kind` is `install-pack` (with `pack`), `send-creation`, `bounce`, `render`, `screen`, `photo` or `microphone`; `render` only for a song that came from a creation (400). The job waits for the user once the turn ends. |
| `POST …/handoff` | `{brief}` (≤ 4000) | `{ok}`. Lines that mention a secret, hold a link or run a command are flagged (`briefWarnings`). |
| `POST …/finish` | `{label, reply}` (one line ≤ 80; ≤ 600) | `{ok}`. The agent is asked for one or two short sentences, about 200 characters at most; 600 is the server's limit. |
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
(`runner.ts`, `child.ts`): one lane for files (a take, a bounce, an attachment, a plugin's response)
and one for renders (the mix, tracks, a plugin on its track's sound), one measurement at a time in
each. A call waits up to 40 s (the tool's client gives it 50: Cursor cuts a call at 60). The same
question about the song as it is now (its revision and the body) joins the measurement under way, or
is answered from the cache. Renders are `renderSession` with `finish: false`, from two bars before
`from` (not measured), slower than real time; one estimated past ten minutes is refused (422,
`reason: 'too-long'`) with what to do instead. A measurement is cancelled when the last job that asked
for it is stopped or fails; when that job's turn simply ends, it runs on (up to 15 minutes) for the
next turn to collect. A lane's child is let go after a minute with nothing to do, and when the server
closes.

| Method and path | Body / query | Answer |
|---|---|---|
| `POST …/measure` | `{what:'take'\|'mix'\|'tracks'\|'plugin'\|'meters'\|'file', track?, region?, plugin?, from?, to?, against?, grid?, source?:'render'\|'bounce', attachment?}` (ids and ticks) | `{done:true, task, result, cached?}`, or `{done:false, task, progress, eta, stage}` after 40 s (`eta` in seconds). `take`: an audio `track` (or a recording `attachment`), `region?`, `against` `'key'` (default), `'none'` or an instrument track's id, `grid` in ticks (240). `mix`: rendered, or the newest file in `data/bounces/<song>/` with `source:'bounce'` (404 `reason:'no-bounce'` without one; `made` and `stale` say when it was made and whether the song changed after). `tracks`: every track alone, or `track`, and with `against` a second track (masking). `plugin`: `track` is a track's, a bus's id or `master`; EQs, Space Reverb, Space Designer, Tape Delay and Stereo Width by their response to an impulse, the rest on the track's own sound (not on a bus). `file`: an `attachment` (WAV, FLAC or AIFF; 422 for MP3, OGG, M4A), else the newest bounce. `meters` **studio**: asked of the requester's studio as `agent-meters` (3 s). A failed measurement is 422 with its reason. |
| `GET …/measure/:task` | | As above, for a measurement of the job's song by id (404 once it's forgotten). |

`agent-meters {id}` (server → studio, asked): the studio reads every channel's meter twenty times a
second while the song plays (`apps/web/src/app/agent-meters.ts`) and acks
`{playing, seconds, channels:[{id, peak:[l, r], max:[l, r], gr, grMax, clipped}]}`: dBFS of the last
3 s and since play started (null for silence), the deepest gain reduction (dB), and whether it went
past full scale. After play stops it answers what the last play showed.

The results (`packages/agent/src/api.ts`, `MeasureResult`) are numbers: a take's notes (`tick`, `pitch`
with cents, `target`, `cents`, `inKey` or `ref`, `drift`, `vibrato:[Hz, ±cents]`, `grid` ms, `db`), its
phrases and a summary; the mix's loudness (integrated, momentary and short-term maxima, LRA, true and
sample peak, samples at full scale), its sections (markers, else every 8 bars) and octave bands with a
tilt; each track's loudness, peaks, octave bands and (audio tracks) its recordings' own level; a
plugin's third-octave response, decay, pre-delay and echoes, or its gain reduction and in/out levels.
The analysis is `@holo/engine/analysis` (packages/engine/src/analysis/): pitch to a cent or two (YIN,
refined at the full rate), loudness by BS.1770-4 and EBU Tech 3341/3342 with the finish's own
K-weighting and true-peak interpolator, bands through the engine's FFT.

## Live channel (`/api/live`)

The server hands the agent only `harnesses`, `agent-progress`, `agent-session`, `agent-done`,
`agent-failed`, `agent-harness` and `history` (`AGENT_MESSAGES` in `apps/server/src/live.ts`). The
agent's other traffic uses the existing `state`, `played`, `ack`, `transport`, `play-notes` and `saved`.

**Runner → server**
- `hello {role:'runner', name, key?, caps:{render, agent}}`. `caps.render` is unchanged; `caps.agent:
  true` means it runs agent jobs. Only a keyed runner with `caps.agent` is handed jobs, sign-ins and
  `agent-on`.
- `harnesses {list:[HarnessInfo]}`. Allowed devices hear the result as `agent-settings`.
- `agent-progress {job, line}`
- `agent-session {job, session}`
- `agent-done {job, reply?}`. `reply` (one line, ≤ 600) stands as the reply only when the agent never
  called `finish`.
- `agent-failed {job, error}`
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
- `agent-run {job, thread, harness, model, effort, middleC, prompt, token, session?, workspace, base}`.
  `workspace` is the thread's id; `base` is where the tools reach the server
  (`http://127.0.0.1:<port>`); `middleC` is `'C3'` or `'C4'`, as the studio names notes.
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
- `pairing-code {code, expires}` (the runner prints it)

**Studio → server**
- `hello {role:'editor', name, agentToken?}`. A token that isn't an allowed device's leaves the studio
  without the agent.
- `state {state}`, as before, now also with `view` and `scan`. Opening another song is how the server
  sees the requester leave a job's song.
- `played {events}`: what's played here, sent while a job of this device's listens (or the `holo`
  command's listen does).
- `history {action:'undo'|'redo'|'step', label, job?}`, sent only while the agent is on and this device
  is allowed. `step` is a step of the user's own, sent only while one of this device's jobs runs. From
  a device no longer allowed, it's answered with `agent-removed`.
- acks: `{type:'ack', id, ok, …}`. An ack is taken only from the connection the request went to.

**Server → studio**, asked (answered with an ack carrying the same `id`):
- `agent-ops {id, project, job, batch, ops, label}`: ack `{ok, revision?}` once applied, or
  `{ok:false, error}`.
- `agent-flush {id}`: save now; ack `{revision}`.
- `agent-played {id, seconds}`: ack `{notes:[PlayedNote]}` from the last minute of what was played here.
- `agent-compare {id, job, from, to}`: ack once it has started playing.
- `agent-import-audio {id, project, attachment, name}`: ack `{file:AudioFile}` once the studio has
  fetched the attachment (`GET /api/agent/attachments/:id/data`), decoded it and uploaded it as a WAV
  (`POST /api/projects/:id/files`), or `{ok:false, error}` (another song open, a recording the browser
  can't read). Up to 10 minutes.
- `transport {id, action, at?}`, the existing message.

**Server → studio**, told:
- `play-notes {events, track, port:'Agent'}`, the existing message.
- `agent-status {job:JobView}`, to allowed devices' studios: those of the requesting device, and those
  with the job's song open.
- `agent-listen {job, state:'on'|'off'}`. `on` goes to the requester's studios with the song open, `off`
  to all of the requester's studios. Nothing is sent between two parts of a listen; `off` follows when
  the listen is over.
- `agent-settings {enabled, harness, model, effort, harnesses}`, to allowed devices, when the settings or
  the runners' harnesses change. Other studios get `{enabled}` alone, and only when it changed.
- `agent-harness {…}`, to allowed devices, as from the runner (checked: only http(s) links, a printable
  code).
- `agent-removed {}`, to a device that was just removed.
- `agent-devices {}`, to allowed devices: the device list, or the requests waiting, changed.
- `saved {project, revision}`, when a scan preset's batch was saved on the server.

**`PlayedNote`** is `{tick, time, pitch, velocity, length, port}`. `tick` is the song's tick when it
was played (null when the song wasn't playing); `time` is ms from the listen's start (or from the start
of the stretch `played` asked for); `length` is ms (null while still held).

**`JobView`** is:
`{id, project, device, state:'waiting'|'running'|'awaiting'|'done'|'failed'|'cancelled', request, line?, reply?, label?, permission?:{kind, detail, pack?}, brief?, briefWarnings?:[{line, kind:'command'|'url'|'secret'}], error?, started, finished?}`.
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
   the harness. It adds the turn, clears the thread's events, and starts the clock: 10 minutes, or 45
   for a scan preset. A permission still waiting on that song is passed over (`done`).
3. **Runner.** It runs at most two jobs at once, one per thread. It opens the thread's workspace
   (`${XDG_CACHE_HOME:-~/.cache}/holo/agent/<thread>`, mode 0700) and puts the token in
   `<workspace>/.holo-job` (mode 0600). It starts the harness sealed, with `@holo/agent`'s MCP server as
   its only tools (`HOLO_URL`, `HOLO_JOB`, `HOLO_JOB_TOKEN_FILE`, `HOLO_MIDDLE_C`), the prompt on stdin,
   and the thread's session resumed if it has one. Each change the tools make is an `agent-ops` batch
   for the requester's studio, which merges it into the job's undo step.
4. **End of the turn.** The agent calls `finish {label, reply}` (and `ask_permission`, `look` or
   `hand_off` before it if it needs to), then the harness exits.
   - The runner sends `agent-done` and removes the token file.
   - The server revokes the token, asks the studio to save, then stores the song as saved as the
     thread's `seen_doc`.
   - The job becomes `done`, or `awaiting` if a permission was asked.
5. **Permissions.** On the device that asked, the bar shows one button. A click runs the studio's own
   code:
   - `install-pack`: the Library's install queue;
   - `send-creation`: `sendToCreation`;
   - `bounce` ("Bounce the song"): `bounceSong`, kept with the song on the host and not downloaded;
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
   - someone presses Stop;
   - the requester opens another song (not for a scan preset, which carries on);
   - the requester undoes a step of the running job;
   - the requester's device is removed, or the agent is turned off;
   - the clock runs out;
   - the runner drops for 15 s, or the harness fails.

   The runner is sent `agent-cancel`, except when the harness failed or the runner dropped. The agent
   hears next time that its turn didn't finish. Jobs live in memory: after a restart, turns still under
   way read `failed`, and those waiting for a click `cancelled`.

## Undo grouping (studio)

`apps/web/src/app/history.ts` is pure; `apps/web/src/app/actions.ts` applies it. `Step` is
`{project, label, job?}`.
- **`agent-ops` while a gesture or drag is in progress** is queued and applied, in order, after it
  ends, so the user's step lands first. A hold that lasts 15 s is let through.
- **A batch that was already applied** (the last 500 are remembered by id) is acked again and not
  re-applied. A refused one may be tried again.
- **Merging:** if the job is running and the top undo step is the job's, the ops merge into it (any
  redo is dropped), and the step keeps the song from before the job. Otherwise a new step is pushed,
  labelled "Agent: <the batch's label>".
- **No toasts.** The bar says what the agent is doing.
- **Finishing:** when `agent-status` says the job ended with a label, its steps, undone or not, are
  relabelled "Agent: <label>".
- **Undo and redo** keep `job`, and are reported as `history`.
- **A/B** (`apps/web/src/app/compare.ts`) plays the bars from the song under the job's first step still
  in the undo history, then from the song now. Stop, or a change to the song, ends it.
- **The existing `ops` message** (from the `holo` command) is unchanged: one step per command,
  "AI: …", with a toast.

## Threads ("since your last reply")

`agent_threads(id, project, harness, session, seen_doc, seen_revision, events_json, created, updated, current)`
holds one current thread (`agt_…`) per song. `agent_turns(job, thread, request, reply, label, state, at, extra)`
holds its turns, the last 50; `extra` keeps the permission, the brief and its flagged lines, the error,
and the attachments. Changing the harness, or `reset`, starts a new thread; the old one is kept but no
longer current.

A thread keeps the user's doings since the last reply, the latest 20, and clears them once a prompt has
told them: `undo`, `redo`, `step`, and `stopped`, `failed` or `denied` for a turn that didn't end well.
`seen_doc` is the song as saved at the end of the last turn.

`describeChanges(before, after, {middleC})` (`packages/session/src/diff.ts`) lists at most 20 lines,
the last "…and N more changes" when there are more:
- song settings, tracks, mix, plugins, automation, regions;
- notes per track, as "Keys bars 9–12: 4 added, 2 removed, 3 changed".

## The agent's tools (`@holo/agent`)

`packages/agent/src/tools/index.ts` lists 42 tools (at most 48: Claude Code, Codex and Cursor each list and
call 48 sealed, docs/agent-harnesses.md), named for MCP (lower-case letters, digits and `_`). Changing and
asking tools run one at a time, in the order they're called; seeing and playing tools run alongside. A
change may also post a line under the bar (`…/progress`).

| Tool | Kind | What it does |
|---|---|---|
| `song_status` | see | Where the user is: the song's settings and tracks, the playhead, the selection, the cycle, the view, how notes are named. |
| `song_show` | see | The whole song as text: tempo and meter changes, markers, mastering, every track and bus. |
| `song_set` | change | Title, tempo, key and meter, from the start or as a change at a position; who it's by and its album (beside the song, outside undo; a creation's song keeps its creation's). |
| `marker` | change | Add, rename or remove a marker. |
| `cycle` | change | Set the cycle, or turn it off. |
| `looping` | change | Make the song a loop (a game's or an app's music), or an ordinary song again. |
| `ops_apply` | change | Raw session ops for what no other tool covers; removals, and `arrange` deletes and moves, only with `confirm`. |
| `timeline` | change | Insert, delete, copy or move whole bars across every track (one `arrange` op); delete and move only with `confirm`. |
| `notes_show` | see | A track's notes, bar by bar. |
| `notes_write` | change | Write notes from a position, in the compact notation. |
| `notes_clear` | change | Remove the notes that start in a span. |
| `regions` | change | Show, split (chop), delete (with `confirm`), copy, move, repeat, trim, gain, fade, stretch, mute, rename audio and MIDI regions; quantize and transpose MIDI; write a MIDI region's controller and pitch-bend lanes. A region by id, name or "selected". |
| `track_add` | change | Add a track: a built-in synth, a pack's instrument, or a palette's sound. |
| `track_set` | change | A track's name, fader, pan, mute, solo, arm, instrument, place and sends. |
| `synth_set` | change | List or set a built-in synth's knobs. |
| `kit_set` | change | List or set a sampled kit's microphones, tune and decay. |
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
| `compare` | play | A/B: some bars as they were before the request, then as they are now. |
| `scan_show` | see | A scan's pages and systems, or one system's strip as an image. |
| `scan_status` | change | Mark how far a scanned system's reading got. |
| `attachment_get` | see | An attachment: a picture, a recording's measurements and notes, a MIDI file's notes, a text. |
| `import` | change | Bring an attachment into the song: a recording onto an audio track, a MIDI or MusicXML file as tracks (below). |
| `look` | ask | Ask for a screenshot, a photo or a recording (a permission: it ends the turn). |
| `ask_permission` | ask | Ask to install a pack, send to the creation, bounce the song, have the creation render it, or for a screenshot, a photo or a recording. |
| `hand_off` | ask | A brief for the user's own coding agent, only for a change to HO[LO] Desk's code, holo-packs or a creation (no commands or code in it; never to read or send files, keys, passwords or tokens). |
| `finish` | ask | End the turn: the undo step's label and the reply (one or two short sentences, about 200 characters at most: what changed and where). |

There are no tools for opening, creating or exporting songs, or for creations. What the user attached
comes into the open song through `import`; a bounce, sending the song to its creation and the
creation's own render each need the user's click (`ask_permission` with `bounce`, `send-creation` or
`render`).

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
| `measure` | see | How the song sounds, measured: a take's pitch (cents against the key's nearest scale tone, or a track's notes), drift, vibrato, timing against the grid and phrase levels; the mix's loudness, peaks, clipping, sections and balance (rendered, or the newest bounce); each track alone, and where two mask each other; what a plugin does; the studio's meters while it plays; an attached recording. A render not done within 40 s says how far it got, and the same call again collects it. |
