# Security policy

Please report security problems privately using GitHub's
[private vulnerability reporting](https://github.com/shooter-git/holo-desk/security/advisories/new)
for this repository. Don't open a public issue.

Include what you found, how to reproduce it and what an attacker could do with it. We'll acknowledge
your report within a few days and keep you informed while we fix it, and we're happy to credit you.

## How HO[LO] is meant to run

HO[LO] Desk has **no accounts and no passwords**. Anyone who can reach its port can open, change and
delete songs, import sample packs and write sessions into the creations folder it was given. So:

- it listens on `127.0.0.1` only (the default, and what the Docker setup publishes);
- your other devices reach it through Tailscale Serve, which only devices on your own tailnet can use;
- don't publish its port on a network you don't trust, or put it on the internet, without an
  authenticating proxy in front of it (and add the proxy's name to `HOLO_ALLOWED_HOSTS`, below).

## The agent

The agent in the studio is off until it's turned on in Settings › Agent. On, it carries out requests
typed in the studio's bar with the user's own Claude Code, Codex or Cursor, which the runner
(`pnpm runner`) starts on the host. Unlike the rest of HO[LO], it has a list of who may use it. What
keeps it to the open song:

- **Other sites.** The live channel (`/api/live`, and any WebSocket upgrade) and every route under
  `/api/agent` refuse a request from a page on another site (its `Origin`), and a request for a name
  that isn't HO[LO]'s (its `Host`), which stops DNS rebinding. HO[LO]'s names are this computer, the
  local network, a tailnet and those in `HOLO_ALLOWED_HOSTS`. A request with no `Origin` passes: it
  comes from a program on a computer that can reach HO[LO] (the `holo` command, the runner), not from a
  page in a browser. See `apps/server/src/guard.ts`.
- **The runner key.** The server makes `runner.key` in its data folder (32 random bytes, mode 0600) the
  first time it starts. The runner reads it there (or from `HOLO_RUNNER_KEY`) and says it when it
  connects; the server compares it in constant time. The agent's jobs, and the pairing code, go only to
  a runner that said it. Renders work with or without it.
- **Devices.** The first device pairs with a 6-digit code that only the runner prints, on the host. It
  works once, for 10 minutes and 5 tries, and 20 wrong codes in an hour lock pairing for an hour. A
  device that has lost its way back in (its site data cleared, the only allowed device lost) can pair
  with a new code the same way, whenever a keyed runner is connected, and the allowed devices see it in
  their list at once; since that way stays open, once a device is allowed 10 wrong codes in a day lock
  pairing for a day. A later device asks to join, and a device already allowed approves or denies it.
  Each device holds a token of 32 random bytes; the server keeps only its sha256, compared in constant
  time. Removing a device in Settings › Agent takes effect at once: its requests are refused, its
  running job stops and its studio loses the agent.
- **Jobs.** Each request is a job with a token of its own, which the agent's tools must show at
  `/api/agent/jobs/:job/*`. The token works only while that job runs and only for the job's song (another
  song's scan or attachment is refused), and it's revoked when the job ends. Before each job the
  server takes a restore point of the song. The job's changes go only to the studio that asked, as one
  undo step.
- **The harness, sealed.** The runner starts the harness with HO[LO]'s MCP tools and nothing else: no
  shell, file or web tools, and none of the user's own MCP servers, skills, hooks or settings. Each
  conversation has its own workspace, `${XDG_CACHE_HOME:-~/.cache}/holo/agent/<thread>` (mode 0700). The
  harness gets an allowlisted environment (what a program needs to start and reach the network, and its
  own sign-in variables; never the ssh agent's `SSH_AUTH_SOCK` or any `SSH_*`, and a `PATH` without
  `node_modules/.bin`), the request on stdin and never in its arguments, and the job's token in a file
  only its owner can read. Git, which Cursor uses to fetch its plugins, never runs ssh (ssh would read
  the real `~/.ssh` whatever `HOME` says) and never reads the user's git config or asks for a password:
  `GIT_SSH_COMMAND=false`, GitHub's ssh addresses rewritten to anonymous https, `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_TERMINAL_PROMPT=0`. Tripwires stop the run, its whole process
  group, at the first sign of a tool other than HO[LO]'s. Each harness's flags are in
  `packages/agent/src/harness/`, and what each still does on its own (Codex reads the user's global
  `AGENTS.md`; Cursor connects the account's plugins but refuses calls to them) is in
  [docs/agent-harnesses.md](docs/agent-harnesses.md).
- **Scope.** The agent works on the open song only. It can't change HO[LO]'s code, holo-packs,
  `packs.lock.json`, a creation's code or engine, or any file; asked to, it writes a brief for the user
  to paste into their own coding agent in that repository. A brief is only for such a change: asked to
  have files, keys, passwords or tokens read or sent, the agent refuses, and the studio flags any line
  of a brief that mentions a secret, holds a link or runs a command. Screenshots, photos and
  recordings are sent only after the user's click, and pictures are redrawn in the browser first,
  without their location data. Attachments are kept on the host for 7 days. HO[LO] itself never reads
  or writes the user's harness configuration (`~/.claude`, `~/.codex`, `~/.cursor`), and never signs a
  harness out or switches its account. Two things change a harness, each only when an allowed device's
  user clicks it and confirms: **Update**, which runs the harness's own updater (`claude update`,
  `codex update`, `cursor-agent update`), and **Install**, offered only for a harness the host doesn't
  have, which runs its vendor's official installer, a fixed command in the runner's code (Claude Code's
  `curl -fsSL https://claude.ai/install.sh | bash`, Codex's `curl -fsSL https://chatgpt.com/codex/install.sh | sh`,
  Cursor's `curl https://cursor.com/install -fsS | bash`, by `bash -o pipefail -c`). Nothing from the
  studio, the server or a request reaches either command: the server only names the harness. Both run
  as the user, with the user's own home and the harness's allowlisted environment, never while that
  harness has a job, and the confirmation says on which computer and what runs.
- **Attachments and imports.** Only an allowed device can send a file, and its token is checked
  before a byte of the body is read. A recording may be up to 200 MB and anything else 25 MB (a text
  100 KB): the body goes straight to disk and is cut off, and removed, past its type's limit, and a
  file whose first bytes aren't its type is removed. A file's bytes are given back only to the device
  that sent it, or to the device whose running job may read it (`GET /api/agent/attachments/:id/data`);
  a job reads only its conversation's attachments for its own song. The agent's `import` copies or
  converts such an attachment into that song's own audio folder, or reads a MIDI or MusicXML file into
  notes: nothing else on disk is read or written, and a file the studio says it converted must be one of
  that song's.

## Especially valuable reports

- anything that reads or writes files outside the data folder or a creation's declared sessions folder
  (sample pack imports, ZIP files, creation manifests, pack file paths);
- anything that runs code on the server from a song, a pack or a creation;
- anything that lets a web page on another origin talk to a running HO[LO], or gets a page from another
  site, or a request for another name, past the Origin and Host check;
- anything that makes the runner (`pnpm runner`) run something other than the render command a
  creation declares in its own `holo.creation.json` or a harness as `packages/agent/src/harness/` starts
  it, or write outside its scratch folders and the agent's workspaces;
- a request to the agent that changes anything but the open song of the studio that asked: another
  song, a file, HO[LO]'s code, a pack;
- a harness run that reaches a shell, a file, the web, or the user's own configuration, MCP servers,
  skills or hooks;
- a device token or a job token that works beyond its scope: after the device is removed or the job
  has ended, or for another job or song;
- a way to guess the pairing code, or to get past its tries and its lockout;
- a runner without the key being handed the agent's jobs or the pairing code.
