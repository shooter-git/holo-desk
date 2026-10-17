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

A bounce and a headless render read samples and audio files with the same WAV decoder and the same
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
  screen can't make the song stumble.
- **Each track** runs its MIDI effects (arpeggiator, harmonizer…), then its instruments (sampler,
  synth, drum kit; one per articulation), splitting the block at each event. Then come its inserts,
  fader and balance, and its sends to buses. Buses, then the master, follow.
- **Meters and the playhead** come back through shared memory, read by the screen every frame.
- **With shared memory, the song itself is played ahead** by worker threads on the other cores, and
  the audio thread plays the master and whatever comes in live (see Scaling, below).
- Nothing allocates on the audio thread except a voice object per note. All buffers are preallocated.

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
  thread; `--ahead 6` renders them ahead on six worker threads, as the studio does (`--paced` plays
  them in real time and counts the blocks the audio thread had to wait for); `--session FILE` takes a
  real song, its samples from the data folder.

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
  sends its own audio thread). Each strip's share of a block is timed where it plays
  (and its heaviest remembered for a while), and a track's notes or a planned part's plans say how
  busy it will be before it plays. The strips are packed so the busiest worker has as little as can
  be, and so a strip's sound only ever goes to its own worker or a later one (a worker never waits on
  one after it). While playing, strips keep their workers (one that moves starts afresh, its notes
  and its reverb's tail cut); the layout changes when the song starts, or when a worker falls behind.
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

## The live channel

The open studio connects to `/api/live`. It reports its playhead, selection and devices a few times
a second, and receives:

- `ops` from the AI or the CLI: applied as an undo step, saved, then acknowledged with the revision;
- `transport` commands (play, stop, locate, cycle);
- `play-notes` (the AI playing something now) and `midi` (a device on the network).

`GET /api/live/listen` collects what you play for a few seconds, which is how the AI answers you.

## Samples

A pack is a folder with `holo-pack.json`: every sample's key and velocity range, its measured root
pitch, its levelling gain, its start, end and loop. The studio fetches an instrument's files when a
track uses it, decodes them at the device's sample rate, trims them to their measured start and end,
and hands them to the audio thread (transferred, not copied). Files are kept in the browser's cache
storage, so the next load needs no network.
