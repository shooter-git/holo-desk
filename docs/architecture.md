# How HO[LO] Desk works

```
 your devices (Chrome, Edge, Firefox)                       this machine
 ┌──────────────────────────────────────────┐   HTTPS    ┌───────────────────────────────┐
 │ the studio (React)                       │  tailnet   │ HO[LO] server (Node, Fastify)    │
 │   ops ──► session ──► engine.sync() ─┐   │◄──────────►│   projects (SQLite, history)   │
 │   Web MIDI ──► shared ring ─────────┐│   │  /api      │   sample packs (files, maps)   │
 │                                     ▼▼   │  /packs    │   live channel (WebSocket)     │
 │   AudioWorklet: the whole studio        │  /api/live │   creations (session files)    │
 │   MIDI FX → instruments → strips →      │            └──────────────▲────────────────┘
 │   buses → master → your headphones      │                           │ /api
 └──────────────────────────────────────────┘                  holo (the CLI) ◄── Claude
```

## One engine

Everything HO[LO] plays is made by one engine, `packages/engine` (`@holo/engine`): the instruments,
the MIDI and audio effects, the mixer, and the song's compiler. The same code runs in three places:

- **the studio's audio thread** (and, rendering ahead, its worker threads), live, at your sound
  device's rate;
- **the studio's Bounce**, in a worker, at the song's rate (`sampleRate` in the session, 48 kHz unless
  set);
- **headless**, on the host: `holo render-audio`, the server, or a creation's build, with no browser.

A bounce and a headless render read samples and audio files with the same WAV decoder (a song's audio
files are kept as WAV for this: the host makes a FLAC or AIFF sent to it a WAV) and the same
resampler, start from the same state and add up in the same order, so they are the same numbers: a
song bounced in the studio and rendered by `holo render-audio` give byte-identical files. That is what
lets a creation ship exactly what you heard and approved in the studio.

Plugins that look ahead report how late their sound comes out, and the mixer delays every other path
into the same bus (or the master) by the difference (plugin delay compensation); a render starts that
much later and keeps from where the song begins, so it lines up with the song to the sample.

The effects Hallowed Lanterns' music is made with are ported from its own code and checked against it:
Parametric EQ, Transient Softener, Stereo Width, the compressor's linear detector and Space Designer
(with the game's halls) agree with the game's output to within 140 dB; Shimmer too, with Look-ahead
on; Tape Warmth exactly but for a constant offset any low cut takes out; and Wow & Flutter plays the
game's own drift when the creation hands it over as a curve.

## The audio thread

The live mixer is the engine in one `AudioWorkletProcessor` (`apps/web/src/audio/worklet/processor.ts`
wraps `EngineCore` from `@holo/engine`):

- **Live MIDI** arrives through a lock-free ring in a `SharedArrayBuffer`, read at the start of
  every 128-frame block. A note you press sounds in the next block, whatever the page is doing.
  Without cross-origin isolation (an insecure page) it falls back to messages.
- **The song** plays from event lists the main thread compiles per track (`@holo/engine`'s `compile.ts`). It's sent
  only when a track's regions change, and played sample-accurately by the audio thread, so a busy
  screen can't make the song stumble. A mixer setting being moved (a fader, a balance, a mute, a
  send's level, a plugin's knob) goes to the engines alone, a few dozen bytes a frame; the whole
  mix is said again only when its strips, plugins, routing or lanes change.
- **Each track** runs its MIDI effects (arpeggiator, harmonizer…), then its instruments (sampler,
  synth, drum kit; one per articulation), splitting the block at each event. Then come its inserts,
  fader and balance, and its sends to buses. Buses, then the master, follow.
- **Meters and the playhead** come back through shared memory, read by the screen every frame.
- **With shared memory, the song itself is played ahead** by worker threads on the other cores, and
  the audio thread plays the master and whatever comes in live (see Scaling, below).
- Nothing allocates on the audio thread except a voice object per note. All buffers are preallocated,
  and the per-sample helpers pass their numbers through fields and typed arrays rather than returning
  them: a call the JavaScript engine doesn't inline boxes every raw double it takes or returns, and the
  garbage that makes costs a collection pause every few blocks.
- **A generated hall is made once on a device.** A Space Designer's space (or a Shimmer's) is a few
  seconds of work: the studio makes a song's halls on up to three workers, side by side, and keeps
  each prepared response in the device's cache under the engine that made it, so a song opened again
  has its halls at once.
- **A recording's note edits play as they're made.** Each stretch the edits change is a patch, keyed
  by what it sounds like (`@holo/engine`'s `notes/plan.ts`). The studio renders the song's patches on
  up to three workers, from the recording in shared memory (`apps/web/src/audio/patches.ts`): the
  region shown in the Audio Editor first, then what the playhead comes to next. Until a patch is
  ready, the recording plays there as it was. Once it is, the track's clips are sent again with a
  `fade`: the audio thread plays the old and new lists together for 256 frames, crossfading, with
  nothing allocated. Patches are kept by the memory they take (256 MB, 96 MB on a phone), so an undo
  or a redo is heard at once. A bounce renders every patch first and never fades.
- **A recording's notes are edited from one list.** The Audio Editor's Notes view
  (`apps/web/src/ui/AudioNotes.tsx`, its tools' arithmetic in `note-tools.ts`) makes every edit
  through `@holo/session`'s `NOTE_EDITS`, as the agent's `audio_notes` and `holo notes` do, and a
  test fails when an edit there has no control in the studio. A drag shows its result as it goes and
  is one undo step when it's let go; a region's first edit keeps the notes found in its recording,
  pruned to what it plays (as a split keeps them), so the studio and the agent number them alike.
- **Convolution is spread over the period.** A hall's long partitions take their forward transform,
  the sum over the spectrum and the inverse transform in about-equal pieces, one or two per block,
  so no single block pays for a 32768-point transform; the output lands in the same block as before,
  so the numbers don't change.

## Scaling

A bounce or a headless render can be any size: it takes as long as it takes. Live playing is
different: each block of 128 frames must be done before the sound card needs it, 2.7 ms at 48 kHz.
One thread can't do that for a big mix, so the studio plays the song on several (below). Two things
measure how close a song comes:

- **The DSP meter** (the control bar, and Audio & MIDI settings) shows the busier of the audio
  thread and the busiest worker: the share of each block's time it takes. Its tooltip and the
  settings give each thread's share, the audio thread's recent peak, and how many blocks overran or
  had to wait for the workers (those light it red). Where a browser's audio thread has no fine
  clock, it shows the average only.
- **`pnpm bench`** runs the same engine headless on made-up songs of growing size (built-in synths
  playing chords, plugins and automation lanes on every track, sends to convolution halls) on one
  thread; `--ahead 6` renders them ahead on six worker threads, laid out by the studio's own pool
  (`--paced` plays them in real time and counts the blocks the audio thread had to wait for;
  `--trace` sets each worker's time against its strips'); `--session FILE` takes a real song, its
  samples from the data folder; `--no-rest` plays every strip through, as a bounce does.

### Rendering ahead

`packages/engine/src/ahead.ts` (the engine's side, with the pool that lays out who plays what),
`apps/web/src/audio/ahead.ts` (the page's workers) and `apps/companion/src/ahead.ts` (HO[LO]
Engine's, as Node threads):

- **Workers** (the device's cores but two, at most six) each hold the whole engine and take in
  every message the audio thread does, before the same block: the first worker (the leader) opens
  each block, saying how many messages come before it, and the others and the audio thread follow.
  So every thread agrees on the song, the mixer and the transport, block by block.
- **Each strip** (track or bus) is played by one worker. What leaves it for a strip another thread
  plays is handed over through a ring of blocks in a `SharedArrayBuffer`, with the gains it's sent
  at, and added where it goes in the engine's own order, so the mix is the same numbers as one engine
  playing it all. A test plays a song with halls, a bus into a bus, a stage, look-ahead, automation,
  a recording and a planned part on one engine and split between threads (its strips scattered at
  random among them), through an edit, a jump and a cycle, and compares them to the byte.
- **The audio thread** plays the master, and every live note: each strip has a twin there that plays
  only what comes in live (your keys, the AI's notes, an armed track's input) through the strip's own
  plugins and on to the master, and sleeps while there's nothing to play. A note you play sounds in
  the next block, as before.
- **The song is 85 ms ahead** (32 blocks), so a change to it (a fader, a mute, an edit), a stop or a
  jump is heard that much later. When the workers keep the audio thread waiting (they are ordinary
  threads, and a busy machine holds them up now and then), they go further ahead, up to 128 ms, and
  come back after a quiet half minute. A song starting from a stop doesn't wait: the audio thread
  skips the stop the workers had played ahead, and starts once they have the song's first few blocks.
- **Who plays what** is worked out where the workers are started: on the page, or in HO[LO] Engine,
  which lays its own out from the messages the studio sends it (the studio sends no more than it
  sends its own audio thread). Each strip's share of a block is timed where it plays: a track while
  it has something to play, a bus while it sounds, with the time it takes to fetch what other
  threads send it. Only timings taken while the song plays and the workers keep up count (a song
  being loaded, or workers far behind, time a strip at several times what it takes), and the
  engines time their strips afresh each time the song starts. A strip not timed yet goes by a guess
  (its plugins, and for a track its notes or its planned part's plans), brought to this computer's
  speed by how its timings have run against the guesses so far. The studio keeps that, and each song's timings, on the device, so a song is
  laid out by what its strips took the last time it played there. The strips are packed so the
  busiest worker has as little as can be, and so a strip's sound only ever goes to its own worker or
  a later one (a worker never waits on one after it). While playing, strips keep their workers (one
  that moves starts afresh, its notes and its reverb's tail cut, its hall built again): the layout
  changes when the song starts, and while it plays only when the audio thread has been kept waiting
  two looks running (a look every two seconds), at most every half minute.
- **A strip with nothing to play rests.** Playing live, a track with no note, clip or input and
  nothing ringing, and a bus nothing is sent to, are skipped whole (plugins and all) once they have
  been silent, below -140 dB before the fader, for four seconds; a note, a clip, an input or a send
  wakes them in the same block. A stopped song, or a quiet stretch of one, costs next to nothing.
  A bounce or a headless render plays every strip through every block, to the same numbers as ever;
  live, the difference is the tails given up, under -120 dB in the mix.
- **Samples, recordings and halls** are in shared memory: every thread plays the same copy.
- **HO[LO] Engine** runs the same pool on `worker_threads`, started and warmed up with the app and
  given each studio's song as it starts its engine; its render thread plays the master and live
  notes as the studio's audio thread does, and renders each block when the device asks for it, as
  before. Its DSP load and the threads' come back to the studio with its stats.
- **Bounces and headless renders** are as before: one engine, one thread, byte for byte the same.

### The numbers

On a 2014 server CPU (Intel Xeon E5-2620 v3, 2.4 GHz; 8 threads, in a virtual machine), with the
desktop and other work running (a load of 5 to 10 threads besides):

| Song | One thread: load (mean) | Ahead on 6 threads: audio thread | busiest worker | speed |
|---|---|---|---|---|
| 8 synth tracks, 4 voices each, 2 plugins each, no halls | 70% | 4% | 44% | 2.7× |
| 16 tracks, 6 voices, 3 plugins, 1 hall | 236% | 4% | 64% | 1.5× |
| 32 tracks, 8 voices, 4 plugins, 2 halls | 643% | 10% | 150% | 0.6× |
| 128 tracks, 16 voices, 6 plugins, 6 halls | 4692% | 37% | 1040% | 0.1× |
| A game's orchestral loop: 29 sampled and Glass tracks, 5 halls and a Shimmer, at 44.1 kHz | 182% | 4% | 50% | in time |

Speed is how much faster than real time the workers play (above 1× they keep up). The game's loop,
played in real time for a minute (`--paced`), kept the audio thread waiting for 5 blocks, all in its
first second. A song keeps up when its work spreads: the made-up songs put the same few synths on
every track, so the bigger ones outgrow six threads, while the loop's work is a dozen strips of 10 to
55% each. A strip can't be split, so the heaviest sets a floor: the loop's Shimmer alone takes about
half a block.

In the studio (Chrome, the same machine), the loop used to take 220% of the audio thread, and its
playhead fell behind. Now the audio thread takes about 2% and the busiest worker 50 to 65% (the DSP
meter's mean over 40 seconds of playing: 57%), and the playhead keeps time (39.8 seconds of song in
40). With the machine this busy, the workers kept the audio thread waiting for 50 blocks in those 40
seconds (0.13 s in all), and for 5 in the first 20 seconds of a first play.

Through HO[LO] Engine (the same machine, its null sound device at 48 kHz, 30 seconds of the loop from
bar 9, the song handed over as the studio hands it): on one thread (`--threads 0`) the render thread
took 202% of each block, the device ran short 5,619 times and 14.7 seconds of song played in 29.7.
On six threads the render thread takes 3% (its peak 10%), the busiest worker 86%, the song keeps time
(29.65 seconds in 29.71), and the device ran short 5 times, the render thread waiting for the workers
for 19 blocks, in a passage where that worker was over its block's time.

What comes next, in this order:

1. **Freeze tracks**: render a track, with its plugins, to an audio clip it plays instead (and
   unfreeze to edit it). The cheapest way past what all the cores can do, and past the heaviest
   strip's floor.
2. **WebAssembly SIMD** for the hottest DSP: sampler voices (the interpolator) and convolution, where
   the workers spend their time.
3. **Smarter sample memory**: load only the samples a song plays, and stream long ones.

## Sessions and operations

A song is one JSON document (`packages/session`, [format](session-format.md)). Every change is an
**operation** (`ops.ts`): add a track, set notes, move a region, change a plugin parameter. The
studio, the server and the CLI all apply operations through the same function, so the AI's change
and yours behave identically. In the studio each one is an undo step; the studio saves after a short
pause. The server keeps every revision a few minutes apart, so earlier versions can be recovered.

The undo history is kept on the device too (`apps/web/src/app/kept-history.ts`, in the browser's
IndexedDB), with the revision it leads up to, a moment after each save: a reload, or the song opened
there again later, brings back Undo and Redo as they were. It comes back only when the song opens at
that same revision. Once the song has been saved somewhere else (another device, a creation, a scan
read on the host), the history no longer lines up and starts afresh; so it does after an update that
changed the code for songs (the session and engine's fingerprint), as its steps hold songs as the code
before wrote them. A step holds the whole song from before it, but an edit shares every part of the
song it didn't change, and the database stores a shared part once, so a long history costs about one
song and what its steps changed. The last 20 songs' histories are kept.

So are the song's changes the host doesn't have yet: until they're saved (the studio saves a moment
after an edit, and can't while the host is out of reach or the song was changed somewhere else), the
song as it is, its history and the revision they were made on are kept on the device a tenth of a
second after each change, and when the page is hidden. A browser drops what a page writes as it goes,
so they're written while it's still there. When the song opens there again (after a reload, a closed
tab, a phone that let the page go, or another song opened), it opens with them and saves them: on the
revision they were made on, or, the song changed somewhere else since, asking which version to keep.
If the host already has the song as they left it (their save got there just before the page went),
they're let go and the history comes back. Another song opened before a save is saved in the
background, after a save of it on its way. Unsaved changes are never let go to make room.

## The live channel

The open studio connects to `/api/live`. It reports its playhead, selection and devices a few times
a second, and receives:

- `ops` from the AI or the CLI: applied as an undo step, saved, then acknowledged with the revision;
- `transport` commands (play, stop, locate, cycle);
- `play-notes` (the AI playing something now) and `midi` (a device on the network).

`GET /api/live/listen` collects what you play for a few seconds, which is how the AI answers you.

The runner (`pnpm runner`) connects to the same channel and takes renders. When its hello carries the
key in the data folder (`runner.key`), it also takes the agent's jobs, and once the server says the agent
is on (`agent-on`) it looks for the harnesses; with the agent off it runs none and fetches nothing. With
the agent on, a studio whose
hello carries an allowed device's token also hears the agent's messages: a job's changes (`agent-ops`,
grouped into one undo step), how a job is going (`agent-status`), and requests to save now, to say what
was just played, to play some bars before and after, and to show that it's listening. The agent's tools
don't use the channel: they call the job's own routes, `/api/agent/jobs/:job/*`, with the job's token.
[agent.md](agent.md) has the contract.

The channel and `/api/agent/*` are behind an Origin and Host check (`apps/server/src/guard.ts`). A page
from another site, or a request for a name that isn't HO[LO]'s (this computer, the local network, a
tailnet, or one in `HOLO_ALLOWED_HOSTS`), is refused; a site that points its own name at this computer
(DNS rebinding) still sends that name as the Host. A request with no Origin, like the `holo` command's,
passes.

## The agent

The agent is off by default and turned on in Settings › Agent. A request typed in the studio's bar
goes this way:

```
the bar ──► server ──► runner ──► harness ──► HO[LO]'s MCP server
                                                               │
the studio that asked ◄── server ◄── /api/agent/jobs/:job/* ◄──┘
```

- **The server** (`apps/server/src/agent`) checks the device and that its studio has the song open,
  and runs one job per song. It has that studio save, takes a restore point, and writes the prompt:
  the agent's rules (`packages/agent/AGENT.md`), what changed since its last reply, what the studio
  shows (view, selection, playhead, cycle, an open scan), what was attached, then the request. It hands
  the job, with a token of its own, to a runner that said the key.
- **The runner** (`packages/agent/src/runner.ts`) starts the harness chosen in Settings (Claude Code,
  Codex or Cursor) in the conversation's workspace, `${XDG_CACHE_HOME:-~/.cache}/holo/agent/<thread>`,
  with HO[LO]'s MCP server (`packages/agent/src/mcp.ts`) as its only tools, the prompt on stdin and the
  token in a file there. Each harness's command line is in [agent-harnesses.md](agent-harnesses.md).
  Tripwires stop the run at the first tool that isn't HO[LO]'s.
- **The tools** (`packages/agent/src/tools`) call the job's routes, which check the token, that the job
  is running and, for what needs the studio, that the studio that asked still has the song open.
  Changes go only to that studio, as batches it groups into one undo step, "Agent: …" (a scan read whose
  studio has gone is saved on the host instead). Listening, what was just played and before and after
  are asked of that studio too. Asking a permission (installing a pack, sending the song to its
  creation, a screenshot, a photo, the microphone) ends the turn; the user's click starts the next one.
- **A job ends** with the agent's `finish` (a label for the undo step and a reply of a sentence or
  two), or when it's stopped: Stop, the studio opening another song or undoing the job's change while it
  runs, the device removed, the agent turned off, the runner gone for 15 s, or after 10 minutes (45 for
  reading a scan). Its token stops working then.
- **Threads** (`apps/server/src/agent/threads.ts`). Each song has one conversation: the harness's own
  session, carried on from request to request, the song as the agent last saw it, and what the user did
  since (undo, redo, their own steps). The next prompt has a "since your last reply" part, so the agent
  hears what was undone or changed. A new harness, or *Start a new conversation with the agent*, starts a new thread.

A scan can also be read in without the agent, by the recognition engines (`pnpm omr on`): the Scan
window writes their reading (`packages/score/src/scan/reading.ts`) into the song as one undo step.

## Samples

A pack is a folder with `holo-pack.json`: every sample's key and velocity range, its measured root
pitch, its leveling gain, its start, end and loop. The studio fetches an instrument's files when a
track uses it, decodes them at the device's sample rate, trims them to their measured start and end,
and hands them to the audio thread (transferred, not copied). Files are kept in the browser's cache
storage, so the next load needs no network. Zones that play the same stretch of one file (a drum on two
pads) share one copy.

The packs HO[LO] plays live in their own repository, [HO[LO] Packs](https://github.com/shooter-git/holo-packs):
a folder a pack, with its map, every file's checksum and, for the packs made from recordings, the recipe
that wrote them.

**The lock.** `packs.lock.json` pins one commit of that repository and every pack's hash: the sha256 of
the pack's line in an experience's `packs.json`, its map and checksums together.
- The server fetches a pack's map from GitHub at that commit the first time it's needed
  (`packages/music/src/pack-lock.ts`, `PackMaps`).
- It keeps the map only if its hash is the lock's, in the data folder (`pack-maps/<hash>.json`), so a
  map is fetched once whoever needs it, the studio or `holo`.
- `pnpm packs lock` moves the lock to the packs repository's latest commit, and `--check` verifies
  every locked map, as CI does.

**Install and Remove.** Packs are installed from the Library (**More packs → Install**, which shows
each pack's size first) or `pnpm packs install`, from their pinned source:
- a git commit;
- notes cut from published downloads;
- an archive: 7z, ZIP (ZIP64 too) or tar, bare or compressed with gzip, bzip2 or xz. HO[LO] reads them
  itself (`packages/music/src/archives.ts`, with its own bzip2, xz, tar and ZIP readers): a big one is
  downloaded straight to disk and streamed through, never held in memory, and goes once what's wanted is
  out of it. A FLAC in one is decoded to a WAV; a WAV is taken as it is;
- files *made* from a library's recordings: the `mix` source, a drum hit's microphones mixed at fixed
  gains, a note trimmed and faded, recordings of one note layered into a section. Each input can start
  at its own frame (a fraction too) and play at its own rate, resampled to the file's by a windowed sinc
  whose sines are summed out by hand. Its downloads may be files in an archive. It's all plain
  arithmetic, so the same downloads make the same bytes anywhere.

**Remove** (`DELETE /api/packs/:id`, or `pnpm packs remove`) frees a pack's folder. The Library first
names the songs that play it (`GET /api/packs/:id/songs`), and clears the pack's files from this
device's cache.

**Palettes.** A pack may also carry ready-made sounds (`sounds`, typed in
`packages/session/src/palettes.ts`): each an instrument (a pack's, or a synth with its knobs set), the
effects it plays through (a MIDI effect such as the Arpeggiator goes before the instrument), a room
and a fader level. `requires` names the packs its sounds play. A palette has no files of its own:
source `none`, no instruments, a `files.sha256` of one comment line (GitHub's raw host can refuse an
empty file), so installing it is writing its map, and
`pnpm packs install` brings the packs it requires.
- The Library lists every pinned palette's sounds by family (from the maps, or as installed when
  offline). A click installs the packs that sound plays, one at a time while it shows how far each has
  got (`apps/web/src/audio/installs.ts`, the same queue More packs uses), then adds the track
  (`soundTrack`): its room is a bus of that name with one reverb on it, made once and shared by every
  sound that names it.
- `checkSound` asks this engine whether it has the sound's synth and effects; a sound that needs one it
  hasn't got, or a pack that isn't pinned yet, shows as coming rather than playing half-made. holo-packs'
  `tools/check.mjs` runs the same check, so a palette can name pieces still being made (`coming`).
- An experience pins the packs its songs play and the packs those require (`withRequired`, in
  `pin.ts` and `sync.ts`); a track made from a palette plays its packs directly, so the palette itself
  is never needed to build the music.

**The recipes**, in HO[LO] Packs, run this repository's own code. They measure every layer's loudness
and set it where one velocity curve meets it, so an instrument gets louder smoothly the harder it's
played.

What a pack can ask of the sampler besides its zones, each only where it does (so other packs play as
they always have): choke groups (the closed hi-hat silences the open one), how often one key may sound
at once, release samples in parts with a decay of their own (a piano's dampers and hammers, quieter the
longer a note was held), the sustain pedal's own sound, keys without dampers, a zone's own release time,
and tails faded as they load.

**Microphones.** A kit recorded on several microphones (a close one on each drum, overheads, rooms)
keeps each one's recording: its zones name their microphone (`mic`, and `pan` for a mono one) and the
instrument lists them (`mics`: id, name, starting level, pan). A hit sounds every microphone's zone for
its key, velocity and round robin together, the round robin chosen once and matched across them by
number, as one voice, so chokes, polyphony and a key's limit count hits. A sampler instrument's own
knobs (`params`: each microphone's level, the kit's tune and decay) update it where it is, like a
synth's: a level glides over a block, tune takes the next hit, decay shortens what's ringing. At their
starting levels the microphones sum to the kit as its recipe leveled it.

## Synths

Besides the samplers, the engine's own synths (`packages/engine/src/synth.ts`, `analog.ts`,
`ethereal.ts`): the presets a new track starts from, and two with knobs of their own (`SYNTH_MACROS`,
in an instrument window, or `holo synth`). **Fat Mono / Fat Poly**: three drifting oscillators into a
transistor-ladder low-pass solved with no delay in its feedback; the mono one plays the last key held
and glides when played legato. **Ethereal Pad / Keys**: a stereo supersaw with shimmering partials in a
hall of its own with an octave-up shimmer; it counts as sounding until its tail is quiet. A knob turned
while it plays updates the instrument where it is (it isn't made again), so no note is cut.

The other families, each a file with a `PRESETS` table, an `X_PRESETS` list that `makeInstrument`
(`core.ts`) dispatches on, six knobs in `SYNTH_MACROS` and a family in `SYNTH_FAMILIES`:

- `organ.ts`: a tonewheel organ (nine tempered wheels a key, sharing phase across keys; staggered
  contacts for the click; single-trigger percussion; the scanner vibrato and chorus; a preamp; a horn
  and drum rotor with their own inertia, slow and fast on the mod wheel).
- `keys.ts`: struck tine, struck reed and pinned string, each through its pickup's nonlinearity.
- `fm.ts`: four operators in eight wirings, the top one fed back.
- `morph.ts`: two spectra built by inverse FFT into a band-limited table per octave, crossfaded; also
  exports `buildTables`, `tableLevel` and `readTable` for the families below.
- `drone.ts`: ten noise-excited resonators on a note's partials, wandering and breaking into grains.
- `machine.ts`: synthesized drum-machine kits on the General MIDI drum keys (`DRUM_PRESETS` in the
  session package is every synth that's a kit, for the pads and the kit warnings).
- `wind.ts`, `plucked.ts`, `reeds.ts`, `choir.ts`, `struck.ts`: modeled flutes and pipes (tuned
  breath, delayed vibrato, drones), strings on a buzzing bridge (a resonant body, sympathetic strings,
  a self-playing drone), free reeds and rubbed glass, formant voices, and modal drums and metal with
  pitch glides and an ensemble of players.

Several carry their own hall (Ethereal's `Hall`, exported) and count as sounding until it's quiet.
`ahead.ts` guesses the heavier ones (`HEAVY_SYNTHS`) at about twice a plain synth's cost per voice.

## HO[LO] Engine and the studio

HO[LO] Engine carries its own copy of the engine. Its hello says which (the fingerprint of
`packages/engine/src` and `packages/session/src`); when it differs from the studio's own, the studio
says so and links the matching build: CI builds Windows, macOS and Linux Engines whenever the engine
changes on `main`, as a pre-release named `engine-<fingerprint>` (`GET /api/engine?engine=…` finds it,
or a build of the host's own checkout first).

## Deployment

CI publishes the studio and its server as one image on every change to `main` and each release:
`ghcr.io/shooter-git/holo-desk:main`, `:stable` and the version, `:sha-<commit>`, for amd64 and arm64,
each with a signed record of what built it. A host follows a channel (`pnpm run update`), and
`pnpm run autoupdate on` keeps it current: a timer pulls every 15 minutes, starts a new image only when
there is one, and waits while a studio is playing or recording. Each look also moves a following
checkout (on no branch, with no changes or commits of its own) forward to the code of the image it runs,
and starts the runner again (`pnpm run runner-service on`) when it moved, so the runner always speaks
the server's version. A branch is someone's work and is never moved by an update. An open studio asks for a reload when
its host has been updated. `pnpm run up` builds from a checkout instead, and the timer waits.
