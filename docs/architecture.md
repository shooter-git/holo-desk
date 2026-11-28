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
  set); or, for a device that asks (a phone or a tablet, unless Settings › Audio says otherwise),
  on the host, the same way from the same files (below);
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
- **An inactive track isn't there.** The engines play the song as `performed()` (`@holo/session`'s
  `form.ts`) gives it, and that leaves inactive tracks out: no strip, instrument, plugin or send is
  built for one, and nothing of it is loaded (its samples, recordings, spaces, note patches). A mute,
  by contrast, only closes the fader. Switched on again, it's a new track to the engines.
- **Where the song stops or jumps, it fades.** Stopped, located while it plays, or around a cycle,
  what was playing (its recordings, a planned part's voices) goes on from where it was for 15 ms,
  fading out, and a recording already under way where the song lands fades in over the same, so
  neither a stop nor a jump clicks; an A/B's passes go from one to the next the same way, the next
  version's sound from its first frame. Stop pressed again silences what is still fading at once. A
  take ends where Stop was pressed, as ever. The engines that play live turn this on
  (`transportFades`); a bounce and a headless render never stop part way, and a loop's jump there
  is the music's own, so they play as they always have.
- **Meters and the playhead** come back through shared memory, read by the screen every frame. The
  screen draws in one frame loop (`apps/web/src/ui/frame.ts`) that rests when nothing moves, and skips
  what's out of sight: on a phone held upright, the views under the agent's page are hidden and their
  frames skipped (`FramePause`) until it closes or is held to see through, while the transport's display
  keeps going. Each draws what it has to on its first frame back.
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
  `fade`: the engine plays the old and new lists together for 20 ms, crossfading, with nothing
  allocated. The two are one voice at two pitches, so the crossfade starts where they agree best
  within the next 250 ms (where they're out of phase, a crossfade dips), and one that comes while
  another is under way waits for it to end. Patches are kept by the memory they take (256 MB, 96 MB on a phone), so an undo
  or a redo is heard at once. They're kept on the device too (`patch-store.ts`, in the browser's cache
  under the engine that rendered them, 512 MB, 128 MB on a phone, and no more than a quarter of what
  the device allows, the least lately used going first): a patch's key says everything its sound
  depends on, so one found there is always right, and a song opened again, or undone to an earlier
  state after a reload, plays its edits at once. It's read before a patch is rendered and written
  after; where storage is refused or full, nothing is kept. A bounce renders every patch first and
  never fades.
- **A recording's notes are edited from one list.** The Audio Editor's Notes view
  (`apps/web/src/ui/AudioNotes.tsx`, its tools' arithmetic in `note-tools.ts`) makes every edit
  through `@holo/session`'s `NOTE_EDITS`, as the agent's `audio_notes` and `holo notes` do, and a
  test fails when an edit there has no control in the studio. A drag shows its result as it goes and
  is one undo step when it's let go; a region's first edit keeps the notes found in its recording,
  pruned to what it plays (as a split keeps them), so the studio and the agent number them alike. The
  Macros dialog (`NoteMacros.tsx`) is made from the macros' arguments in the same list, previews
  through a gesture and applies as one undo step; Level reads each note's level from the curve the
  notes were found with (`noteLevel`), as the host reads it for the agent.
- **A note copied is the note itself; a linked edit is the same edits again.** The Notes view's
  clipboard (`note-clipboard.ts`, in memory, the tab's own) holds the note copied and its recording;
  `paste` and `copy-settings` take it as their context's `source`, so a paste is self-contained
  wherever it's made (the agent hands them the note `from` numbers). With Link on, every set of notes
  `runEdit` makes remembers the notes and the edit it was made from, so a commit knows the edits that
  made it and `@holo/session`'s `linkedNoteEdits` makes them again in each other region playing the
  recording (on the notes found at the same place, where that region plays them), all one batch:
  the agent's and `holo notes`' `linked` go through the same function.
- **A note is heard as it's pressed.** With Hear notes on (the Notes view's bar, kept on the device),
  a press plays the note through its track's channel, as edited, from 30 ms before it starts to its
  end (`audio/audition.ts`): an `audition` message gives the engine the pieces to play, cut as the
  song cuts them (the recording, or a patch where one is rendered; the recording there while it
  isn't, and nothing waits for it). It fades in over 10 ms (its start is often in the middle of the
  note before) and out over 10 ms at the note's end. The core plays them once on a voice each track
  has from the start, nothing allocated, a new one taking over from the last, which fades out over
  10 ms (a held note cut over a ms or two clicks); the audio thread plays it (a twin, where a worker
  renders the track ahead), and so does HO[LO] Engine. Never while the song plays. While a note is
  dragged, the patches of where the drag has got to are rendered before anything else, one at a time
  for the region and only the latest wanted after it, and the note goes on as they come in, from
  where it has got to, crossfaded into its new sound (from the top once it has ended); they're the
  patches the song plays once it's let go, under the same keys, so its sound is usually there
  already. The engine's click measure (`analysis/clicks.ts`) is what the tests hold these to. Hearing and the device's patches are listening aids, not
  note edits: the agent and `holo notes` hear an edit through `measure take`, and need neither.
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
- **Samples and a phone's recordings are held as 16-bit**, half the memory of floats. A sample whose
  file is 16-bit stays so on every device (taken straight from the file's bytes when it's at the
  engine's rate), played at a 32768th a step, exactly as its floats would be. On a phone or a
  tablet a recording is held that way too (`apps/web/src/audio/compact.ts`), fitted to the take:
  its loudest frame decides what one step is worth, always a power of two, so the engine plays the
  frames exactly as the floats they stand for; a take that wasn't 16-bit to begin with is rounded
  to the nearest step, with no dither. It's the copy that device listens to: a bounce and a
  headless render read the files, and a computer holds floats as ever. A recording whose notes are
  edited is held as floats everywhere (its patches are rendered from them and join them to the
  sample): one held as 16-bit is decoded again as floats the first time its notes are edited, or
  pressed in the Notes view. A plugin's data in the song's files (a drift curve) is never held as
  16-bit, nor anything while HO[LO] Engine plays.
- **HO[LO] Engine** runs the same pool on `worker_threads`, started and warmed up with the app and
  given each studio's song as it starts its engine; its render thread plays the master and live
  notes as the studio's audio thread does, and renders each block when the device asks for it, as
  before. Its DSP load and the threads' come back to the studio with its stats.
- **Bounces and headless renders** are as before: one engine, one thread, byte for byte the same.
  The host's bounce alone may be split over threads (A bounce on the host), and is still that file
  to the byte.

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
3. **Smarter sample memory**: stream long samples and recordings. (A render already loads only the
   samples its song can sound, below; a phone's studio loads those of the keys its song plays.)

## Track stacks in the tracks pane

The song's side of stacks (what they are, the one-block rule, that they route nothing) is in
`docs/session-format.md`. In the studio a stack's header is a row of the track list, as tall as a
track's, so a row's place is still its number times a row's height and nothing that lays out, draws
or hit-tests the pane had to learn a second geometry. The pane works from a song whose `tracks` are
its rows (`rowsSong` in `apps/web/src/app/track-rows.ts`): each header is a stand-in track there,
with the stack's name and colour and nothing to play, and `stackRow` tells it from a track. The
header's own lane draws its tracks' regions as thin strips; presses in it do nothing.

Whether a stack is open is this device's own, kept by song (the last twenty songs'), and never an
undo step. The tracks folded away are left out of what the pane shows (`shownTracks`), so the arrow
keys step past them and the selection moves to the nearest track showing when a stack closes around
it.

A dragged row becomes one operation (`planDrop`): a track lands in a stack when it's dropped under
its open header or among its tracks, leaves its own when it's dropped outside it, and stays as it
was at a stack's lower edge; a header moves its whole stack. The studio adds the routing in that
same step where the stack has a bus, and says so in a toast.

The Mixer lists the same rows (`trackRows`): a stack is a narrow tab before its strips, standing
through the strips' shared grid of rows, and a closed stack's strips are left out. A strip dragged
in the Mixer moves among the strips shown and stays in the stack it's in. HO[LO] Remote is told the
stacks in the studio's report (`stacks`, and each track's `stack`) and lays its own lists out with
`remoteRows`; which stacks are closed there is that device's own.

## The Step Grid

A drum part shown as steps is the track's own notes: nothing is stored for a step. Reading
(`readSteps` in `packages/agent/src/edits/steps.ts`) gives each note to the step it's nearest and
keeps how far it is from it, so a part played by hand opens as it was played and stays that way
until a step is changed; several notes of one pitch on a step (a flam) are one lit step. Every edit
is in that file too (`STEP_EDITS`: set, clear, velocity, fill, euclid, shift, humanize, copy, swing,
clear-row, write), each a function from the track's part to operations on it, and three things call
them: the studio's grid (`apps/web/src/ui/StepGrid.tsx`), the agent's `steps` tool and `holo steps`.
Tests hold all three to the list: an edit added there without a control in the studio or an action in
the tool fails. A step lit where the part has no region gets one over the free part of that bar,
joined to its neighbours made in the same edit.

The grid is a view of the notes editor, beside the Piano Roll and the Score, offered for a kit (a drum
synth, or a sampled instrument whose map names pads or says it isn't played by pitch); any other
track shows its Piano Roll, whatever was last chosen (`apps/web/src/app/note-view.ts`). It draws
with elements, not a canvas: a page is at most four bars of steps, and the steps' swell as they're
lit or struck is the browser's own animation, left out where motion is to be spared.

## A bounce on the host

A studio renders its own bounce in the page, its instruments' samples loaded there as floats (those
the song can sound: see Samples): more than a phone's browser holds for a big song. So a device can have the host make it
(`apps/server/src/host-bounce.ts`): the page sends the song as it has it, the stretch to bounce and
the tail (`POST /api/projects/:id/bounces/host`), then asks how far it has got
(`GET /api/bounce-jobs/:id`). When it's done, a computer downloads the file straight from the host,
never holding it. The host renders as the studio's worker does, with the same options, its samples and
recordings read from the data folder, so the file is the one that studio would have made (a test
compares them to the byte).

**A song's stems are made the same way, by the host only** (`stems: true` on the same request; a
device has no path of its own for them, so a small host is slower and nothing falls back). What a
stem is is worked out in one place, `packages/agent/src/edits/stems.ts`, which the studio's dialog,
the host's job, the agent's offer and `holo render-audio --stems` all read: the song rendered with
every other track inactive (not played, its instruments not loaded) and without the song's finish,
for each track that's on, not muted (or soloed, while any is) and has something to play. So a stem
carries its own share of every bus it's sent to, and the stems added together are the mix before
the finish; a test renders a song both ways and compares them to within the 24 bits each is written
at. That sum is exact unless something reacts to the level of the whole (a limiter on Stereo Out,
a compressor on a bus several tracks reach, the finish): `stemWarnings` says which, and the dialog
shows it before anything is made. With `by: 'stacks'` (`stems: "stacks"` on the request) a stem is a
track stack, its tracks rendered together, and each track in no stack has its own; a bus that reacts to
level is then a warning only when stems of more than one group reach it. The job renders the stems one after another, each split over
threads as a bounce is, into one ZIP written entry by entry (`packages/music/src/zip-write.ts`:
stored, ZIP64 when it's needed), so it costs the memory of one bounce; it has a bounce's time for
each stem. The ZIP is kept, listed, saved and deleted as a bounce is, and is told from one by its
name (`.zip`); measuring a song's newest bounce never takes it for the mix.

**On a host with cores to spare, the bounce is rendered on several of them**, and is the same
file to the byte (`RenderOptions.split` in `packages/engine/src/render.ts`, `renderThreads` in the
engine's `node.ts`; `packages/engine/test/render-split.test.ts` compares them on real threads).
It uses the render-ahead pool (Rendering ahead), run as playing live never is: every engine has
the whole song before the first block (the threads hold what they're sent until told to go), who
plays which strip is laid out once and never again (a strip that changes hands starts afresh), no
strip rests and nothing fades at the transport (a render's own settings), and the mixing thread
waits for each block instead of playing silence. If a thread's engine reports an error, a thread
stops, or no block comes for two minutes, the same process renders the song again on one engine:
slower, never another file, never stuck.

- **How many threads:** one fewer than the cores the server may use (`renderWorkersFor`), six at
  most, never more than the song has strips; with fewer than three cores, one engine as before,
  since one thread beside the mixer costs more than it saves. `HOLO_BOUNCE_THREADS` is a ceiling
  for a host shared with other work (`1`: one engine).
- **How the strips are shared out:** by what each cost the last time the song was bounced here
  (its share of a block's time, averaged over the render), kept in `data/bounces/.render/`; a
  song bounced for the first time goes by the pool's guesses, brought to this host's speed by its
  last bounce of any song. The layout only decides how soon the file is made, never what's in it.
- **What it gains:** the mixing, shared between the threads. Loading the samples and mastering
  stay on one, so a song that is mostly loading gains little, and none loses. On 4 cores of a 2019
  desktop CPU, three threads, seconds for the whole bounce (one engine, then the first bounce on
  threads, then later ones):

  | Song | One engine | First | Later |
  |---|---|---|---|
  | 4:07, 23 tracks, 4 buses (a Shimmer a third of the work by itself), mastered | 145 | 97 | 80 |
  | 2:43, 29 Performance and Glass tracks, 13 buses, 5 halls, mastered | 122 | 67 | 69 |
  | 2:02, 13 tracks, 6 halls | 43 | 26 | 26 |
  | 2:48, 31 sampled tracks, one bus | 26 | 23 | 21 |
  | 0:50, 8 tracks (mostly loading) | 20 | 17 | 17 |
  | 3:19, 4 recordings | 6 | 6 | 6 |

  It holds about a fifth more memory at its peak (each engine its own mixer; the samples are
  shared). Given fewer cores than threads it is still no slower than one engine with two, and a
  tenth slower with one (where it isn't used).

One bounce at a time, each in a process of its own at the lowest priority, forked when its turn
comes and gone when it ends: a long render never holds up the server, a small host is slow at it
and nothing worse, and on Linux the system stops that process, not the server, should memory run
out. A few may wait their turn. `/api/health` says the host is busy while one waits or runs, so an
update waits for it. When the host can't take a bounce (one from before it made any, too many
waiting, started again meanwhile), the device makes it as it always has. A bounce the host tried
and couldn't make (a pack that isn't installed, out of memory) is said to have failed, with why.
**Settings › Audio, Bounce on** chooses, on each device: Automatic (the host on a phone or a
tablet, this device elsewhere), This device, or The host.

**A phone or a tablet saves a bounce from a tap** (`apps/web/src/app/bounce-save.ts`). Its line
stays when the bounce is done ("Bounced 4:07 of …", with Save), until it's saved or put away, and
nothing downloads by itself: an installed iPhone or iPad app has no browser around it, and a link
to a download takes it to a page of the file with no way back. There, Save hands the file to the
share sheet (Save to Files, AirDrop…), which opens only straight from a tap, so the file is
fetched as the line appears and held until then; on other touch devices Save follows the link.
The bounce a device asked for is kept on it (`apps/web/src/app/host-bounce.ts`): one still being
made is followed again after a reload, and on a phone or a tablet a finished one is there, with
its line, when the app is closed and opened again. A host that was started again meanwhile has
forgotten its jobs but not their files: the page finds the bounce among the song's
(`GET /api/projects/:id/bounces`), by its name and by when the host began it.

**A song's bounces are listed in Songs while it's open** (`SongBounces` in
`apps/web/src/ui/Songs.tsx`), nested under its row: one line saying how many there are, folded
until it's pressed, so the list of songs stays a list of songs. Opened, each shows with what it's of, when it was made, its length and its size,
the newest first, to save on this device again or to delete for good (asked first, in its row).
`GET /api/projects/:id/bounces` answers `{file, bytes, url, made, seconds?}` for each (`made`: the
file's time, ms; `seconds` when the file says its length), and `DELETE
/api/projects/:id/bounces/:file` removes one. Saving from the list is saving from the line: a
computer and a browser on a phone download from the tap, and in an installed iPhone or iPad app
the bounce becomes the one whose line is showing (the one file held is its), its row saying when
Save can be pressed. A studio's own bounce is uploaded under a name no list matches
(`.up_….part`) and takes its own when it's whole, as the host's are, so one on its way is never
listed, saved or measured half written.

**A device with the agent's notices on is told when its bounce is done** (docs/agent.md, Notices
outside HO[LO]): it sends its agent token with the request, and the host, when the bounce ends,
sends it a notice by the rule the agent's follow. A tap opens HO[LO] on the song, with the bounce's
line waiting.

## A recording's waveform

A recording is drawn from its peaks: the lowest and the highest value of every 256 frames. The host
makes them from the WAV, read a piece at a time and one file at a time (`apps/server/src/peaks.ts`),
the first time a studio asks (`GET /api/projects/:id/files/:file/peaks`), and keeps them beside the
file; the studio keeps them on the device too. So a device draws a long take without decoding it:
before its audio has started, and for an inactive track, whose recording it never loads. A file the
host doesn't read (an MP3), or a host that doesn't answer, leaves a device where it was before the
host made any: the peaks are taken from its own decoding of the file.

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
song as it is, its history and the revision they were made on, with the song as it was at that
revision, are kept on the device a tenth of a second after each change, and when the page is hidden. A browser drops what a page writes as it goes,
so they're written while it's still there. When the song opens there again (after a reload, a closed
tab, a phone that let the page go, or another song opened), it opens with them and saves them: on the
revision they were made on, or, the song changed somewhere else since, asking which version to keep.
If the host already has the song as they left it (their save got there just before the page went),
they're let go and the history comes back. Another song opened before a save is saved in the
background, after a save of it on its way. Unsaved changes are never let go to make room. A page that's
hidden saves to the host too, while it still runs; a save with no answer within 30 s and the time
to send the song at 20 KB/s (a page frozen with it on its way) is given up and made again, given
twice as long each time after till the host answers (a slow network gets there in the end), and one
refused because the host already has that very song is taken as saved.

The agent may have saved its changes on the host while the page was away (docs/agent.md, "The studio
that asked, away"). Then the history comes back with them as their job's step on top, and changes kept
on the device go onto them, as if they had come while the page was there. Where they can't be put
together, or the song they were made on isn't known for certain, the song is as the host has it and
they're one Undo away, and a notice says so.

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
(on a phone or a tablet, its page) goes this way:

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
  Codex, Cursor or Antigravity) in the conversation's workspace, `${XDG_CACHE_HOME:-~/.cache}/holo/agent/<thread>`,
  with HO[LO]'s MCP server (`packages/agent/src/mcp.ts`) as its only tools, the prompt on stdin and the
  token in a file there. Each harness's command line is in [agent-harnesses.md](agent-harnesses.md).
  Tripwires stop the run at the first tool that isn't HO[LO]'s.
- **The tools** (`packages/agent/src/tools`) call the job's routes, which check the token, that the job
  is running and, for what needs the studio, that the studio that asked still has the song open.
  Changes go only to that studio, as batches it groups into one undo step, "Agent: …". While it's away
  (a phone switched to another app, the tab closed) they're saved on the host, and it picks them up as
  that step when it's back. Listening, what was just played and before and after are asked of that
  studio too, and wait for the reply's buttons while it's away. Asking a permission (installing a pack, sending the song to its
  creation, a screenshot, a photo, the microphone) ends the turn; the user's click starts the next one.
- **The terminal** has all of it too: `holo regions`, `timeline`, `measure`, `played`, `details`,
  `import`, `packs` and `holo tool NAME` run the same tools on the song from a terminal, through the
  command line's own routes instead of a job's (docs/agent.md, "What doesn't change, and the terminal").
- **A job ends** with the agent's `finish` (a label for the undo step and a reply of a sentence or
  two), or when it's stopped: Stop (at any time), the studio undoing the job's
  change while it runs, the device removed, the agent turned off, the runner gone for 15 s, 15 minutes
  without a word from it (a tool call under way counts until it answers), or 2 hours however busy it is
  (3 for reading a scan). Its token stops working then. Opening another song doesn't end it: its
  changes are saved on the host from then on, and the studio picks them up as its one undo step when
  the song opens there again, so a device may have a request at work on each of several songs (two
  run at a time on the runner; more wait their turn). docs/agent.md, "Several songs at once".
- **Threads** (`apps/server/src/agent/threads.ts`). Each song has one conversation: the harness's own
  session, carried on from request to request, the song as the agent last saw it, and what the user did
  since (undo, redo, their own steps). The next prompt has a "since your last reply" part, so the agent
  hears what was undone or changed. The conversation stays the song's when the harness changes: each harness keeps a session of its own in it, and one that wasn't there is told what was asked and answered without it ([agent.md](agent.md), "Threads"). *Start a new conversation with the agent* starts a new thread.

A scan can also be read in without the agent, by the recognition engines (Audiveris and homr, on by
default): the Scan window writes their reading (`packages/score/src/scan/reading.ts`) into the song as
one undo step. In Docker they're a container beside the studio's (the image CI publishes from
`deploy/omr`, pulled with the studio's), on a network with no way out. Run without Docker, the server
runs the same image itself (`apps/server/src/omr-docker.ts`) the first time a scan wants it, in a
container with no network at all, and talks to it through `docker exec`. `pnpm omr off` turns them off.

## Samples

A pack is a folder with `holo-pack.json`: every sample's key and velocity range, its measured root
pitch, its leveling gain, its start, end and loop. The studio fetches an instrument's files when a
track uses it, decodes them at the device's sample rate, trims them to their measured start and end,
and hands them to the audio thread (transferred, not copied). Files are kept in the browser's cache
storage, so the next load needs no network. Zones that play the same stretch of one file (a drum on two
pads) share one copy.

**A render loads the samples its song can sound** (`packages/engine/src/played.ts`): a bounce, in the
page or on the host, `holo render-audio`, a measurement, a creation's build. A big sampled
instrument is thousands of zones, gigabytes once decoded, and a song plays a few dozen keys of it.
What's rendered is the same to the byte as with every zone loaded, because of how the sampler
chooses: its zones are in sets (those a note strikes, each part of its release samples, the
pedal's two), and a note takes from a set the zones that score lowest for it, semitones outside a
zone's keys first, then velocity outside its range. Only zones at exactly the lowest score are
ever looked at. So for each key the song's notes send an instrument, every zone less than a
semitone further from it than the nearest is loaded (each velocity layer and round robin of the
keys that play it, both neighbours of a key between two); the same of each part of the release
samples, and for the pedal's own voice; the pedal's sounds whole; and a set with zones on the
instrument's microphones keeps one. Tests play thousands of made-up instruments and phrases, and
render made-up songs, both ways and compare them to the byte. Where a song's keys can't be told
from its notes, the whole instrument is loaded, as it always was: a track with a MIDI effect (an
arpeggiator, a harmonizer and the Session Drummer play keys of their own), a Drum Replacer's kit,
an instrument that plays through Prism or has a partial set among its zones. `samples: 'all'`
(`holo render-audio --all-samples`) loads every zone regardless. A file missing for a zone the
song can't sound no longer stops its render.

A pack instrument may play through Prism, the morphing synth, instead of the sampler: its `synth` names
one of Prism's sounds and `params` is its whole patch (the keys in `packages/session/src/prism.ts`). Its
zones are then the patch's data, each for the source it names (`source`, 1…4): a sample for a Sample or
Grains source, or, with `partials: true`, a partial set (a Partials source's sound over time, in the
file format `writePartials` in `packages/engine/src/prism-sources.ts` documents). So a pack of your own
can carry whole patches with their own recordings and analyses, and the track's params go over them.

**A kit's pads** (`pads` in an instrument, each a key and the piece it plays) may have settings of
their own (`packages/session/src/kit-pads.ts`): a level, tune and pan, a saturator, a velocity curve,
a pitch envelope, a filter, one-shot or gated. A song turns them as the instrument's params
(`pad:KEY:ID`). In the sampler, a hit on such a pad reads its sample at the pad's pitch (the pitch
envelope sweeping it), saturates it at the level the pack set it to, filters it, and only then gives
it its level: the velocity curve, the pad's level and pan, the kit's envelope and each microphone's
level. Level, tune, pan, the curve and gating are taken as a hit starts; only a saturator, a pitch
envelope or a filter is work at every frame, and only for the hits of the pads that have one. A pad
without settings plays through exactly the code it always did.

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
there is one, and waits while a studio is playing or recording, the host is making a bounce, or the
agent is working on a request (`busy` in `/api/health`; a reply that only waits for the user's OK holds
nothing up). Each look also moves a following
checkout (on no branch, with no changes or commits of its own) forward to the code of the image it runs,
and starts the runner again (`pnpm run runner-service on`) when it moved, so the runner always speaks
the server's version. A branch is someone's work and is never moved by an update. An open studio asks for a reload when
its host has been updated. `pnpm run up` builds from a checkout instead, and the timer waits.

A new version is started with care (`startNew` in tools/update.mjs):

- **The songs' database is copied first.** The updater asks the running server (`POST /api/backup`,
  with the runner key in the data folder, as `holo pair` proves it's this computer's owner asking). The
  server makes the copy from its open database with SQLite's online backup (`Store.backup`,
  apps/server/src/backup.ts), so it's whole whatever is being saved meanwhile: `backups/holo-<version>-<UTC
  time>.db` in the data folder, written under another name until it's whole, readable by its owner
  only. It answers 507, having written nothing, when the disk hasn't room for the database, its
  write-ahead log and 64 MB to spare; the update says so and goes on without a copy. Only files named
  that way are ever let go (the newest three are kept, and what a copy cut short left): anything else
  someone keeps in the folder stays. A server from before copies answers 404: the update says the next
  one is copied first.
- **A server that answers is never stopped for a copy.** If the runner key can't be read, or the copy
  doesn't come, the update says so and goes on without one. Only a server that isn't answering
  `/api/health` at all is stopped (the new version is about to take its place), and the copy made from
  the host with the same backup: `backups/holo-before-update-<UTC time>.db`, when the host's Node has
  it (22.16 or later). `pnpm run update` with HO[LO] stopped copies that way too, and `pnpm run up`
  asks for a copy before it builds.
- **The version before is kept at hand.** The image the container runs is tagged `holo-desk:previous`
  before the new one starts.
- **A version that can't be started, or doesn't answer, is undone.** The updater waits three minutes
  (`HOLO_UPDATE_WAIT_S`, in seconds, in the environment or `.env`) for `/api/health` from a container
  running the new image. Without it, or when Docker couldn't start the container at all, `.env` is set
  to `HOLO_IMAGE=holo-desk:previous`, with `HOLO_ROLLED_BACK_FROM` (that image's id) and
  `HOLO_ROLLED_BACK_IMAGE` (the image it was following), and the version before is started again; the
  look ends as failed, the checkout and the runner stay where they were. From then on each look
  fetches the image it was following and goes forward only to another one than that id; `pnpm run
  update`, by hand, tries the channel's image again whatever it is, once it could be fetched.
- **Never on a guess.** Silence counts as "didn't start" only when the version before could be heard
  on `/api/health` just before the update. Where it couldn't (HO[LO]'s port isn't reachable from where
  the updater runs, HO[LO] was stopped), the new version is started as it always was, and the update
  says it wasn't checked.
- A look asks whether HO[LO] is busy before it fetches, and again after the copy, just before it starts
  the new version.
- Going back relies on a database a newer version has opened still being one the version before reads:
  changes to its tables are additions (a new table, a new column that may be empty), never a change to
  what's there.
- A copy is never put back by itself: that's done by hand (the README says how).
