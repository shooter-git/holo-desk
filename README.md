<p align="center"><img src="docs/images/banner.jpg" alt="HO[LO] Desk: a studio for writing, recording and mixing music. Headphones On [Lights Out]." width="100%"></p>

<p align="center">A studio in your browser for writing, playing and mixing music: tracks, a Piano Roll and a mixer laid out the way Logic users expect, live MIDI from your keyboard and drum pads, orchestral sample packs, and an AI collaborator that works in the open session with you.</p>

![The studio: tracks, the Inspector with its channel strips, and the Piano Roll](docs/images/studio.jpg)

## What it does

- **Write and edit.** Tracks and regions on a timeline. A Piano Roll with the keyboard down the left: drag notes to new pitches and times, stretch them, set velocities, and draw any controller (mod wheel, expression, sustain, pitch bend, aftertouch, any CC). Quantize, transpose, split, repeat, undo everything.
- **Play it live.** USB MIDI keyboards and drum pads through Web MIDI, delivered to the audio engine through shared memory: a key you press sounds in the next 128-frame block. You can also play the computer keyboard (Musical Typing) or the touch keyboard and drum pads on a phone. Record with count-in, cycle and metronome (right-click the metronome, or open Settings › Metronome, for its sound and volume). For the shortest time from key to ear, run [HO[LO] Engine](#play-it-in-a-few-milliseconds-holo-engine) on the computer you play on.
- **Scores.** Any track as notation (press <kbd>N</kbd>): the score and the Piano Roll are the same notes, so an edit in either shows in both. Write by typing letters and note values, playing a MIDI keyboard, or clicking on a staff; add dynamics, articulations, slurs, lyrics, chord symbols, repeats and endings, D.C. and D.S. jumps, guitar tab and drum parts. Markings sound as they read, and playback follows the repeats. MusicXML goes in and out (MuseScore, Sibelius, Finale, Dorico), and the full score or each part prints, or saves as a PDF.
- **Scan sheet music.** Photograph a page with your phone or open an image or a PDF: HO[LO] straightens it, finds the systems and shows each line of the page above the bars it became, for a quick review. Optional open-source recognition engines (Audiveris and homr, `pnpm omr on`) read it into the song as one undo step, and read it again to flag the bars where they differ from what's written. The agent, if you turn it on, can read it too.
- **Record and edit audio.** Audio tracks record a microphone or an instrument through an audio interface (lined up with what you heard, using this device's measured round trip), or take WAV, FLAC, MP3, Ogg and AIFF files dropped on the tracks. Trim from either edge, drag fades, set gain, normalize, and time-stretch without changing pitch (Alt-drag a region's end, as in Logic) in the tracks area or the Audio Editor.
- **Mix and automate.** Channel strips with instruments, MIDI effects, audio effects, sends, buses, pan, faders and meters. Put a channel on a **Stage**: a near seat and a far seat, each with its own rooms and depth, and a Distance that moves it between them. Automation lanes (press <kbd>A</kbd>) draw how volume, pan, mute, sends, distance and any plugin parameter move through the song, in straight lines or smooth curves, sample-accurately.
- **Bounce.** <kbd>Ctrl B</kbd> renders the song (or the cycle) to a 24-bit WAV with the same engine, faster than real time, and keeps a copy with the song. The stock plugins are Channel EQ, Parametric EQ (eight free bands), Compressor, Noise Gate, Transient Softener, Limiter, Space Designer (convolution with generated rooms, halls and cathedrals, or any impulse response), Shimmer, Space Reverb, Tape Delay, Chorus, Wow & Flutter, Rotary Speaker, Phaser, Tremolo (or auto-pan), String Resonance (a grand's strings ringing in sympathy, with an extended grand's bass strings), Stereo Width, Tape Warmth, Saturation, Lo-fi, Drum Replacer (each hit on a drum track played again on any kit, and turned into notes), Pitch Correction (a voice pulled to the nearest note of a key and scale, hard and robotic or natural), Arpeggiator, Harmonizer, Scale Quantizer, Velocity Processor and Session Drummer (a drummer that plays along in ten styles, with fills). Plugins that look ahead (the limiter, Shimmer, the Drum Replacer, Pitch Correction) are delay-compensated: everything else waits for them, so it all arrives together. A song can carry its **finish** (mastering to a loudness under a true-peak ceiling, with glue) and be marked a **loop**, so a game's music renders as it plays forever, its end ringing into its start.
- **Real instruments.** Free sample libraries (VSCO 2 Community Edition, the Versilian Community Sample Library, Karoryfer's Meatbass, a FreePats guitar, a Steinway Model D, and rock, prog and jazz drum kits) with every sample measured for its true pitch, level and loop. **Performance** instruments play a whole part as a real player would (dynamic layers, round robins, legato hand-overs, re-bowing, attacks that land on the beat), and **Glass** is a bowed-glass voice. There are about sixty built-in synths in eight families, so something always plays, with no download: **Fat Mono** and **Fat Poly** (three drifting oscillators driven into a transistor-ladder filter), **Ethereal Pad** and **Ethereal Keys** (a wide supersaw in a shimmering hall of its own), a **tonewheel organ** with its rotating speaker, modeled **tine, reed and clav** electric keys, a four-operator **FM** synth, a morphing **wavetable** synth, evolving **drones**, an analog-style **drum machine** (four kits on the General MIDI drum keys), modeled **flutes, pipes, zithers, lutes, free reeds, a glass harmonica, a choir, taiko and war drums, gongs and an anvil**. Each has six knobs in its window (the button on its instrument slot). **Import your own packs** as SFZ or folders of WAV files.
- **An AI collaborator.** A [Claude Code](https://claude.com/claude-code) skill that reads the open session and writes into it as undoable steps. It harmonizes, writes counter-melodies and bass lines, sets up a live harmonizer that follows your playing, and listens to what you play and answers it. The studio's command bar can take the same kind of request too, carried out by your own Claude Code, Codex or Cursor, once you turn that on.
- **Round trips with your own projects.** A game or an app whose music is code can send a piece into HO[LO] and get your edits back, and render the song itself so you can compare its own sound with the studio's, edits and all ([how](docs/creations.md)).
- **Music for your next project.** `holo init` gives a new game or app ("an experience") its songs folder and a pinned copy of HO[LO]'s engine, so the project builds its own music, sample for sample as the studio renders it, with or without HO[LO] Desk; `holo update-engine` moves it on when you choose ([how](docs/creations.md#music-for-a-new-project-an-experience)).
- **Everywhere.** Desktop, tablet and phone (portrait and landscape), installable as an app, in Docker, reached by your own devices over HTTPS on your tailnet.

<p align="center"><img src="docs/images/phone.jpg" width="820" alt="The Piano Roll, the mixer and the touch keyboard on a phone"></p>

## Quick start

You need Node.js 24 or newer and pnpm 10 (`corepack enable`), or just Docker.

```bash
git clone https://github.com/shooter-git/holo-desk.git && cd holo-desk
pnpm install
cp .env.example .env
pnpm packs install          # the sample libraries (a few GB), or install them from the studio's Library
pnpm build && pnpm start    # or `pnpm dev` while working on HO[LO] itself
```

Open <http://localhost:47800> and press **Start the studio**.

**In Docker** (the server, the built studio and your data in `./data`), from the image CI publishes:

```bash
cp .env.example .env
pnpm run update             # pull ghcr.io/shooter-git/holo-desk:stable and start it (or: pnpm run update main)
pnpm run autoupdate on      # then it keeps itself up to date (Linux: a systemd timer, as you)
pnpm run runner-service on  # and the runner, for creations' renders and the agent (Linux: a service, as you)
```

Install sample packs from the studio's Library (**More packs → Install**; browse them at
[HO[LO] Packs](https://github.com/shooter-git/holo-packs)). Every image is published by
CI with a signed record of what built it: `stable` and the version on each release, `main` on every
change merged, `sha-<commit>` always. The timer looks every 15 minutes and never restarts HO[LO] while a
studio is playing or recording; an open studio offers to reload when its host has been updated. Songs
and packs live in `./data`, outside the image, so an update never touches them. An update also moves this
checkout to the code of the image it started (a release's tag, or main's head), so its compose file, its
tools and the runner match the server, and starts the runner again. `pnpm run update` takes a checkout on
main along (it's then on no branch, and follows); a checkout on any other branch, or with changes or
commits of your own, is your work and stays as it is. (A checkout older than v0.7.2 doesn't move itself
yet: bring it up to date once.)

To run your own changes instead, `pnpm run up` builds from this checkout (`holo-desk:local`); automatic
updates wait until you `pnpm run update` again.

## Your other devices

Browsers only allow MIDI and shared-memory audio on a secure page. HO[LO] listens on this machine only
(`127.0.0.1`), and [Tailscale](https://tailscale.com) gives your own devices a trusted HTTPS address
with nothing to install on them but the Tailscale app:

```bash
pnpm tailnet on             # https://<this machine>.<your tailnet>.ts.net:47801
```

HO[LO] is hosted on one machine and played on others. Plug your keyboard or drum pads into the laptop
(or other computer, or Android phone) you'll play on, open that address in Chrome, Edge or Firefox
there, and wear your headphones on that device. The notes never cross the network: only the song and
the samples come from the host (once; the device keeps the samples). Give each device a name in
**Settings › General** so the others and the AI know which is which. If the host goes away, the
studio keeps working and saves your changes when it's back.

### A studio, a screen and a remote

A common setup: HO[LO] hosted on one machine, the studio full screen on another (<kbd>Ctrl Shift F</kbd>,
or the button beside the settings), and your phone by the instruments as **HO[LO] Remote**: press the
phone button in the studio's control bar and scan the code, or open `/remote` on the phone. The remote
shows the studio's position and levels as they change and drives it: play, stop, record, cycle,
metronome and count-in, undo, the tracks (select, mute, solo, arm) and their faders, markers and *go to
bar*, and a keyboard and drum pads that play into the selected (or armed) track. Add it to the Home
Screen to open it like an app; it keeps the screen awake. Press **Start the studio** on the computer
once, and the remote does the rest.

![HO[LO] Remote on a phone: the display, the transport and the tracks](docs/images/remote.jpg)

Devices that aren't on a tailnet can use HTTPS on your local network instead:

```bash
pnpm lan on                 # https://<this machine's address>:47843, with its own certificate authority
```

Install the certificate it hands out (`http://<this machine>:47844/holo-ca.crt`) on each device once.
Anyone on that network can then use HO[LO], so turn it off (`pnpm lan off`) when you don't need it.

**A keyboard plugged into an iPhone or iPad** reaches the studio through Apple's network MIDI:
`pnpm netmidi on`, then connect a network session to the address it prints, from a MIDI app on the phone.
[Latency and devices](docs/latency-and-devices.md) explains this and the other options. To use the `holo` command from a machine other than the host, point it there:
`HOLO_URL=https://<host>.<your tailnet>.ts.net:47801 holo status`.

## Play it in a few milliseconds: HO[LO] Engine

A browser has to play through the operating system's shared mixer: on Windows that's 20 ms at the very
best, and often 40 or more from key to ear. **HO[LO] Engine** is a small app for the computer you play
on. It plays the studio's sound itself, with native audio (WASAPI exclusive mode on Windows, Core Audio
on macOS), and reads every USB MIDI instrument natively: keyboards, drum pads, controllers, an
interface carrying several instruments. The browser stays the screen.

1. Download it for that computer from the studio itself: **Settings › Audio** → **Download it for…**
   links the build that carries the studio's own engine. CI builds one for Windows, macOS and Linux
   whenever the engine changes on `main`, and publishes it as a pre-release named for the engine
   (`engine-<fingerprint>`); a build of your own checkout (`pnpm engine:build --release`) is offered
   first. The [releases](https://github.com/shooter-git/holo-desk/releases/latest) have them too:
   `holo-engine-windows-x64.exe`, `holo-engine-macos-arm64.zip` (Apple silicon), `holo-engine-macos-x64.zip`
   or `holo-engine-linux-x64.zip`. It's one file, with nothing to install.
2. Start it. On Windows, the first time, SmartScreen says it doesn't know the app: **More info → Run
   anyway**. On a Mac, unzip it and the first time right-click it and choose **Open**. A small window
   says it's waiting for the studio.
3. Open HO[LO] Desk in the browser on that computer. The studio finds it by itself, plays through it
   and keeps the browser's own audio quiet (it doesn't even need **Start the studio**). **Settings ›
   Audio** says so and shows its numbers. Close the window and the browser plays again.

It plays the same engine as the studio (the same code, the same sound) and opens every MIDI device it
finds, as they're plugged in. It tells the studio which engine it carries: when HO[LO] has moved on (new
instruments, say) and the Engine hasn't, the studio says so and offers the matching one. Notes go where the browser would send them: armed tracks by their input and
channel, else the selected track. What you play comes back to the studio, timed as you heard it, for
recording. On Windows it has the sound device to itself while the studio is open (exclusive mode: other
apps are silent); tick **Share the sound device with other apps** in Settings › Audio to let them
play too, for a few milliseconds more. How deep it buffers is its own business: it keeps a period in hand, deepens when the device runs short or the computer comes close, opens the device at a longer period when that persists, and remembers what each device needed. [Latency and devices](docs/latency-and-devices.md#holo-engine)
has the details.

From the repository: `pnpm engine:build` once (it needs [Zig 0.16](https://ziglang.org/download/), or a
C compiler for this computer), then `pnpm engine`. `pnpm engine:build --release win32-x64 linux-x64` makes
the downloads in `apps/companion/dist` (the macOS ones build on a Mac).

## The AI collaborator

```bash
pnpm skill:install          # the `holo` command, and the Claude Code skill in every project
holo status                 # what's open, the playhead, the selection, your MIDI devices
holo show --track Strings --from 9 --to 17
holo write --track Strings --at 9 "A4:2 C#5:2 E5:4"
holo fx add Keys harmonizer key=9 scale=6 voice1=2 voice2=4
holo listen --seconds 8
```

Then ask Claude things like *"harmonize the melody in bars 9 to 16 with a counter-line on the oboe"*
or *"put a live harmonizer on my keys in A lydian, thirds and fifths"*. Each change appears in the
open studio as one step you can undo. See [skills/holo/SKILL.md](skills/holo/SKILL.md).

Claude reads and writes notation too (`holo score show`, `holo score write`).

### The agent in the studio

The studio can take requests in plain words too, in its bar (<kbd>Ctrl /</kbd>). This is off until you
turn it on in **Settings › Agent**, and while it's off nothing in the studio mentions it. The agent runs
your own Claude Code, Codex or Cursor on the host, signed in as you, with the runner going there
(`pnpm runner`, the one that also renders [creations](docs/creations.md); on Linux,
`pnpm run runner-service on` keeps it running as a service). Settings › Agent lists all three: one the
host doesn't have has an **Install** button, which runs its vendor's official installer there once you
confirm (it says what runs, and where). One you install yourself in a terminal shows up with **Look
again**, or, if it went somewhere the runner doesn't look, once you run `pnpm run runner-service on`
again.

The first device pairs with a 6-digit code the runner prints; the code works once, for 10 minutes. A
later device asks to join, and a device already allowed approves it in its own Settings › Agent, where
any device can also be removed, at once. A device that has lost its way back in (its site data
cleared, or the only allowed device lost) pairs with a new code from the runner, the same way. The
harness, its model and effort, its install, its sign-in and its updates are there too. An install or
an update runs only when you click it and confirm, and it's the same harness your terminal uses. The
models and efforts are the harness's own, as it lists them on the host, and they're looked at again
when you open Settings › Agent an hour or more after the last look.

Type a request and press Enter. A picture, a recording, a MIDI or MusicXML file or a text file dropped
or pasted on the bar goes with it (a picture is redrawn on your device first, without its location
data). The reply is a sentence or two under the field, with a button only when the agent needs your
click: to install a pack, send the song to its creation, share the screen, take a photo or record from
the microphone. Close the bar and the work goes on: the bar's button shows a turning ring while the
agent works, then a dot until you open the bar again (a phone has the bar's button too, at the top). The
agent works on the open song and nothing else:

- its notes, score, tracks, instruments, effects, mix, automation, tempo, key, meter, markers and cycle;
- playing to you, listening as you play, and reading what you just played (its tempo, meter, key and
  pickup);
- finding sounds, and installing a HO[LO] Pack once you've clicked;
- playing the bars it changed as they were, then as they are;
- with the Scan window open, **Read this scan**, **Check it** and **Fix flagged**.

Everything it changes for one request is one undo step, "Agent: …", and before your next request it's
told what you undid or changed since. It can't change HO[LO]'s code, its packs, a creation's code or
any file: asked to, it writes a brief for you to copy into your own coding agent in that repository
(only for a change to that code, never to read or send your files, keys or passwords).
Its harness runs with HO[LO]'s tools and nothing else: no shell, files or web, and none of your own
settings, skills or MCP servers. [docs/agent.md](docs/agent.md) has how it works.

The `holo` command and the skill work as they always have, with the agent on or off.

## Sample packs

```bash
pnpm packs list
pnpm packs install vsco2 vcsl          # by name, or all
pnpm packs install --from ~/samples    # from files you already have (hard-linked)
pnpm packs import ~/Downloads/MyPiano.zip --name "My Piano"
pnpm packs import ~/Samples/MyKit --name "My Kit"   # a kit: a folder for each piece, any microphones
pnpm packs import-bfd ~/BFD --name "BFD"           # your own BFD: its inventory, then a kit if it can
pnpm packs remove rock-kit             # to make room: its samples go
```

Or install them from the studio: the Library's **More packs** lists every pack HO[LO] pins that isn't
installed yet, with its size. **Install** has the computer that runs HO[LO] fetch it while the Library
shows how far it has got. Every file is checked against its pinned checksum. **Remove**, on an
installed pack, frees the disk it takes: it names the songs that play it first, and More packs can
install it again.

**Palettes** are sets of ready-made sounds for a style: a cinematic hybrid score, a classic symphony
orchestra, a felt piano with chamber strings, cold glassy pulses, minimalist patterns, a darker Viennese
voicing of the grand, and instruments of Asian traditions (gamelan, Chinese, Japanese, Indian, Southeast
Asian and Korean). Each sound is an instrument with its effects, its room and a level matched to the
rest of its palette. In the Library, **Palettes** lists them by family: a click installs the packs that
sound plays (if they aren't installed yet) and adds a new track ready to play. A palette has no audio of
its own, and a sound that waits for something HO[LO] doesn't have yet is shown as coming.

**The packs live in their own repository, [HO[LO] Packs](https://github.com/shooter-git/holo-packs).**
Each pack there has its own page: where its sounds come from, every instrument, its license, its size
and a kit's pads. Its catalog lists every instrument by family (pianos, drum kits, strings, woodwinds,
brass…). There's no audio there, or here: each pack is a map of its samples, their sources and their
checksums. HO[LO] pins one commit of it in `packs.lock.json`, with every pack's hash. New packs reach
the studio when that lock moves on:

```bash
pnpm packs lock                        # pin HO[LO] Packs' latest commit (then commit packs.lock.json)
pnpm packs lock --check                # every pinned map fetched and checked against the lock
```

Today they include:
- a Steinway Model D (bitKlavier Grand, CC BY 4.0);
- three drum kits: Rock, Prog and Jazz;
- VSCO 2's orchestra and the Versilian Community Sample Library;
- a jazz double bass;
- a classical guitar;
- the University of Iowa's clarinet and bassoon.

[Browse them all](https://github.com/shooter-git/holo-packs#instruments).

The kits are on the General MIDI drum keys your pads send (36 kick, 38 snare, 42/44/46 hi-hat, 41 to
50 toms, 49 crash, 51 ride…), with the hi-hat choking itself, and Roland's edge keys for the half-open
hats (22, 26). The studio's drum pads show the kit's own pieces, each pad named for what it
plays. Velocity follows each drum's real loudness: every layer is measured and set where one
velocity curve meets it, so a drum gets louder smoothly the harder it's hit and changes its timbre at
each layer, the same way for every drum and every key of the piano.

A kit recorded on several microphones can keep each one: every microphone of a hit sounds together,
and the kit's window (the button on its instrument slot) has a level for each (the close microphones,
overheads, rooms), turned while it plays. Every kit also has **Tune** and **Decay** there. They're
kept in the song, and `holo kit Drums mic:room=-6 decay=70` sets them from the command line.

You can also import your own from the studio: **Library → Import a sample pack (.zip)**. SFZ
instruments come in with their mapping. Folders of samples named by note (C4, F#3, `_v2`, `_rr1`…)
become instruments, and a folder of one-shot hits becomes a drum kit on the General MIDI keys.

A kit's folder with a folder for each piece (Kick, Snare, Hi-Hat Closed, Hi-Hat Open, Tom 1, Crash,
Ride…) becomes one kit: each piece on its General MIDI key, the hi-hat choking itself, its velocity
layers placed by how loud they measure (as the pinned kits' are) and its takes as round robins. Where
its samples were recorded on several microphones, in folders of their own (`Snare/Close`,
`Snare/OH`, `Snare/Room`) or named in the files (`Snare_Top_v1.wav`, `Kick_In_v2_rr1.wav`), every
microphone of a hit sounds together and the kit's window has a level for each. SFZ kits that give
each microphone a controller (`label_cc`, `amplitude_oncc`) come in the same way.

Your own packs' ids start with `mine-`, so installing HO[LO]'s packs never overwrites one, and their
samples are hard-linked rather than copied where they're on the same disk. They stay in your data
folder, but bouncing or recording one into a song makes ordinary audio files, and sending that song
back to an experience puts its audio in the experience's repository.

`pnpm packs import-bfd` reads BFD from your own copy: it writes an inventory of the folder (names,
sizes and headers, no audio) to `bfd-inventory.txt` in the data folder, and imports plain WAV or FLAC
files in a folder for each piece as a kit of your own. BFD's own sample format isn't mapped yet: the
inventory is what the mapping will be written from.

## Key commands

They follow Logic's (Ctrl in place of ⌘): Space play/stop, R record, C cycle, K metronome, X mixer,
P Piano Roll, I Inspector, Y Library, Q quantize, Ctrl T split, Ctrl R repeat, Ctrl Z undo, Ctrl K
Musical Typing, A automation, Ctrl B bounce. N shows the Score and Shift N writes in it: letters for
notes, 1–7 for values (as in MuseScore), Shift L lyrics, Shift Q chord symbols. Ctrl / opens the bar,
where every command, track and marker is found by name (the search button in the control bar, or a
swipe down on a phone's top bar). Press <kbd>?</kbd> in the studio for the whole
list.

## Development

```bash
pnpm dev        # the server (:47800) and the studio with hot reload (:47810)
pnpm engine     # HO[LO] Engine from the repository (after `pnpm engine:build`)
pnpm test       # unit tests
pnpm typecheck
pnpm lint       # Biome
```

| Folder | |
|---|---|
| `apps/web` | the studio: React UI, the engine in an AudioWorklet, Web MIDI |
| `apps/server` | the server: projects (SQLite), packs, the live channel, creations |
| `apps/companion` | HO[LO] Engine: the engine on a render thread, the song rendered ahead on worker threads, with native audio and MIDI (one C file over miniaudio and the OS's MIDI) |
| `packages/engine` | the audio engine: instruments, effects, the mix; the same code live, in bounces and headless (`holo render-audio`) |
| `packages/session` | the session format, operations, notation, MIDI files |
| `packages/music` | an experience's build: the pinned renderer a project carries, its sample fetching and checks |
| `packages/cli` | the `holo` command |
| `packages/agent` | the agent in the studio: its tools (an MCP server), its instructions (`AGENT.md`) and how the runner starts each harness sealed |
| `skills/holo` | the Claude Code skill |
| `local/` | not in the repository (git ignores it): your own tools for your own creations, such as an importer |
| `packs.lock.json` | the sample packs HO[LO] plays: a commit of [HO[LO] Packs](https://github.com/shooter-git/holo-packs) (their maps, sources and checksums; no audio) and every pack's hash |
| `deploy` | Docker |
| `docs` | [architecture](docs/architecture.md), [session format](docs/session-format.md), [creations](docs/creations.md), [latency](docs/latency-and-devices.md), [the bar and the agent](docs/agent.md), [the agent's harnesses](docs/agent-harnesses.md) |

The pre-commit hook (`git config core.hooksPath .githooks`) stops commits that would publish a
secret, an email address or a home-folder path.

## Privacy and security

HO[LO] has no accounts and sends nothing anywhere. The agent is off unless you turn it on, and off, no
harness is run and nothing is looked up for it. On, it runs your own Claude Code, Codex or Cursor, which sends what
it reads (the song, a scanned page, a file you attached) to Anthropic, OpenAI or Cursor as any session
of yours does, as you, and only the devices you've allowed can ask it anything. HO[LO] binds to
`127.0.0.1`, and only devices on your own tailnet can reach it when you turn that on. HO[LO] Engine
listens on `127.0.0.1:47830` only, and lets in a studio served from this computer, the local network or
a tailnet (`--origin` names any other). Your songs and packs stay in `./data`. Read
[SECURITY.md](SECURITY.md) before exposing it any other way.

## Made with HO[LO] Desk

Projects whose music was written in HO[LO] Desk:

| | Project | |
|---|---|---|
| <a href="https://github.com/shooter-git/hallowed-lanterns"><img src="https://raw.githubusercontent.com/shooter-git/hallowed-lanterns/main/docs/banner.jpg" width="240" alt="Hallowed Lanterns: a lane under hundreds of lit jack-o'-lanterns at sunset"></a> | **[Hallowed Lanterns](https://github.com/shooter-git/hallowed-lanterns)** | A lantern-lit night walk through a pumpkin patch, in the browser. Its soundtrack was composed with HO[LO] Desk, and its music still makes the round trip: the game sends a piece to the studio and gets the edits back. [Walk it](https://shooter-git.github.io/hallowed-lanterns/). |

Made something with HO[LO] Desk? Open a pull request that adds it to this table, with a link and a
line about it.

## License and credits

HO[LO] Desk is [MIT licensed](LICENSE). The sample libraries are their authors' work, credited in
[CREDITS.md](CREDITS.md). HO[LO] Desk is an independent project, not affiliated with Apple or Avid.
Logic Pro and Pro Tools are trademarks of their owners and are named here only to describe familiar
workflows.
