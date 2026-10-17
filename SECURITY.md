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
  authenticating proxy in front of it.

Especially valuable reports:

- anything that reads or writes files outside the data folder or a creation's declared sessions folder
  (sample pack imports, ZIP files, creation manifests, pack file paths);
- anything that runs code on the server from a song, a pack or a creation;
- anything that lets a web page on another origin talk to a running HO[LO];
- anything that makes the creation runner (`pnpm runner`) run something other than the render command a
  creation declares in its own `holo.creation.json`, or write outside its scratch folders.
