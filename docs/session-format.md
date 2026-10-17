# The HO[LO] session format (version 1)

A song is a JSON object. Creations read and write it in any language. The TypeScript definitions in
`packages/session/src/types.ts` are the reference; `validate.ts` reads untrusted sessions and fills
in what's missing.

```jsonc
{
  "format": "holo-session",
  "version": 1,
  "id": "prj_…", "title": "Night Window", "revision": 12,
  "created": "…", "modified": "…",
  "tempo": [{ "tick": 0, "bpm": 84 }],                     // quarter notes per minute
  "meter": [{ "tick": 0, "num": 4, "den": 4, "groups": [3, 3, 2] }],   // groups in eighths
  "key": "D minor",
  "markers": [{ "id": "…", "tick": 15360, "name": "Theme" }],
  "chords": [{ "tick": 0, "symbol": "Dm" }],
  "tracks": [ /* … */ ],
  "buses": [{ "id": "bus_…", "name": "Hall", "color": "#7c8a99", "channel": { /* … */ } }],
  "master": { /* a channel */ },
  "cycle": { "on": false, "start": 0, "end": 15360 },
  "origin": { "creation": "your-game", "piece": "theme", "exportedAt": "…", "extra": {} },
  "notes": "free text"
}
```

**Time** is in ticks, 960 to a quarter note. Bars count from 1 on screen.

## Tracks

```jsonc
{
  "id": "trk_…", "name": "Double bass (jazz)", "color": "#b07bd9", "kind": "instrument",
  "instrument": { "type": "sampler", "pack": "meatbass", "name": "upright" },
                // or { "type": "synth", "preset": "Warm Pad", "params": {…} }, a Performance or Glass
                // instrument (below), or { "type": "none" }
  "articulations": [{ "id": "pizz", "name": "Pizzicato", "instrument": { … } }],
  "input": { "port": "*", "channel": 0 },        // live MIDI: a port name or "*", channel 1-16 or 0 for all
  "armed": false,
  "midiFx": [ /* plugins */ ],
  "regions": [{
    "id": "rgn_…", "name": "", "start": 3840, "length": 7680, "muted": false,
    "notes": [{ "t": 0, "d": 480, "p": 45, "v": 92, "art": "pizz", "x": { "bend": [[0, -1], [0.1, 0]] } }],
    "cc": { "64": [[0, 127], [1920, 0]], "pb": [[0, 0]], "1": [[0, 40]] }
  }],
  "channel": { /* a channel */ },
  "origin": { "voice": "bass", "edited": false, "locked": false, "extra": {} }
}
```

- A note's `t` is ticks from its region's start, `d` its length, `p` its MIDI pitch (fractional
  allowed), `v` its velocity 1–127, `art` an articulation id, and `x` anything a creation attached.
  `x` is kept as it is.
- Controller lanes are keyed by CC number, `pb` (pitch bend, −8192…8191) or `at` (channel pressure),
  as `[tick from the region's start, value]`.
- `origin.edited` becomes true the moment anyone changes the track's music in HO[LO].

### Performance and Glass instruments

Two instruments play a whole part at once, planned where the song is compiled (a note's legato
depends on the next one), the way Hallowed Lanterns' own code plays it:

```jsonc
{ "type": "performance", "pack": "vsco2", "name": "horns",
  "play": { "seed": 13, "gainDb": -1, "lag": 0.03, "shape": { "attack": 0.5, "swell": 0.2, "taper": 1.5 },
            "dyn": [[92160, 0.4], [96000, 0.68]] } }        // dynamics through the song: [tick, 0–1], eased
{ "type": "glass", "options": { "seed": 1, "attack": 1.6, "release": 3.5, "bright": 0.85 } }
{ "type": "glass", "line": true, "options": { "seed": 22, "glide": 0.25 } }   // a singing line that slides
```

- **Performance**: a pack instrument played as the game's sampler plays it: dynamic layers, round
  robins, a start a little before the beat so a slow attack lands on it, legato hand-overs and
  re-bowing, looped sustains, its random choices (numpy's generator, named as the game names it) from
  `seed`. Its `play` takes the game's `play()` arguments. The pack must carry its `performance` data
  (a creation that measures its samples can write it into the pack's manifest); live playing goes to
  the pack's plain sampler.
- **Glass**: the game's bowed-glass voices; `options` take `glass()`'s and `glass_line()`'s arguments.
- A note can keep how its creation performed it, `x.perf`: `{ t, d }` in seconds, `v` 0–1, `p` the
  creation's pitch, `i` its place in the creation's list, and `tick`, `len`, `vel`: where the note
  was. While the note stays there, it plays as performed; move it, lengthen it or change its
  velocity and it plays from the score.
- The song's `performance.kernelCuts` names the interpolator filters the creation made first, by
  cut-off, so its pitch-shifted samples are its own to the last bit.

### Audio tracks

An audio track (`"kind": "audio"`) plays recordings instead of notes. Its regions carry `audio`, and
the recordings themselves are listed in the song's `files` and kept beside the song on the host
(`data/audio/<song id>/`), never inside the session file:

```jsonc
// in the song
"files": [{ "id": "aud_…", "name": "Vocal #01.wav", "seconds": 12.5, "rate": 48000, "channels": 1 }],
// on the track
"audioInput": { "input": 0, "channels": 1, "monitor": false },   // records input 1 (0-based), mono
"regions": [{
  "id": "rgn_…", "name": "Vocal #01", "start": 3840, "length": 7680, "muted": false, "notes": [], "cc": {},
  "audio": { "file": "aud_…", "offset": 0.012, "gain": -1.5, "fadeIn": 0, "fadeOut": 0.25, "stretch": 1 }
}]
```

- `offset` is seconds into the recording where the region starts; `gain` is dB; fades are seconds.
- `stretch` plays the recording longer (2 = twice as long) or shorter (0.5) at the same pitch (0.25–4).
- Where regions overlap on one track, the later one in the list (drawn on top) is heard, as in Logic.
- Which input *device* a track records from is each computer's own setting (Audio & MIDI), not the song's.

## Channels and plugins

```jsonc
{
  "volume": -6, "pan": -0.25, "mute": false, "solo": false,
  "inserts": [{ "id": "fx_…", "type": "compressor", "bypass": false, "params": { "threshold": -20, "ratio": 3 } }],
  "sends": [{ "bus": "bus_…", "level": -12, "pre": false }],
  "output": "master"
}
```

Plugin types and every parameter's range are in `packages/session/src/plugins.ts`; `holo plugins`
lists them. A plugin may also carry text `settings`:

- Space Designer's impulse response file is `"settings": { "ir": "my-halls/concert" }`
  (a pack and a response in it) with its Space parameter set to "From a file".
- Shimmer's is the same, and each later generation may have its own: `ir1`, `ir2`… (else it plays `ir`).
- Wow & Flutter can follow a drift curve instead of making its own: `"settings": { "curve": "aud_…" }`
  names one of the song's files, mono, whose every sample is the delay in seconds at that frame of the
  song. A creation hands over its own wobble this way, to be played exactly.
- Tape Warmth can take away a fixed centre from its saturated sound: `"settings": { "centre": "0.0012,-0.0004" }`
  (left, right). A creation whose saturation centres itself on the whole loop's average hands that
  average over this way.

### Stage

A channel can sit on a stage (`"stage"`): a near and a far seat, and how far back between them it is.

```jsonc
"stage": {
  "distance": 0.3,                                   // 0 all near … 1 all far; automation "distance"
  "near": { "depth": 0.3, "sends": [{ "bus": "bus_room", "level": -12 }] },
  "far":  { "depth": 0.7, "sends": [{ "bus": "bus_hall", "level": -3.7 }] }
}
```

After the fader, the sound is shared between the seats at equal power (cos and sin of distance·π/2).
Each seat's direct sound is set back by its depth: a low pass at 18 kHz − 8 kHz·depth (Q 0.6) and
−7 dB·depth. Its sends take the sound as it reaches the seat (before the depth), so further back is
wetter. Post-fader sends of a staged channel hear that sound too. `updateChannel` with
`"stage": null` takes it off the stage.

### Automation lanes

Lanes (`"automation"`) are `{ "param", "points": [[tick, value]…], "mode": "read"|"off", "curve" }`.
`curve: "smooth"` eases between points (a cosine: `v0 + (v1 − v0)·(½ − ½·cos(π·u))`) instead of a
straight line. Volume, pan, sends and distance move every sample; plugin parameters once a block.

## The song's finish and loop

```jsonc
"finish": { "lufs": -16, "ceiling": -2.2, "glue": true, "lowcut": 28, "tilt": 1.0 },
"loop": { "start": 0, "end": 215040, "tail": 4 }
```

`finish` masters every bounce and headless render (not the live mix): a low cut and a high-shelf tilt
at 9 kHz, glue compression (about 2 dB on the loud parts at 1.8:1), then the gain that lands the
integrated loudness on `lufs` (EBU R128) through a look-ahead limiter on the true peak (4×
interpolated) under `ceiling`. `loop` makes renders play the song from `start` to `end` (ticks) turn
after turn until everything that rings past the end has come round into the start (its longest
note, even one longer than the loop, and its halls after it), keep the last turn (finished as a
loop: its filters and dynamics see its end before its start), and add `tail` seconds of its start
after it. Notes still sounding at the end carry on into the start. In a loop render Shimmer's
octave low-passes each turn on its own, its ends padded as scipy's `sosfiltfilt` pads them, as the
game it came from does.

## Operations

`addFile` lists a recording the host already has (`POST /api/projects/:id/files?name=Take.wav` with
the bytes stores one and answers its id).

Edits travel as operations (`ops.ts`): `setProject`, `addTrack`, `removeTrack`, `moveTrack`,
`updateTrack`, `updateChannel`, `addPlugin`, `updatePlugin`, `removePlugin`, `movePlugin`, `addBus`,
`removeBus`, `updateBus`, `addRegion`, `updateRegion`, `removeRegion`, `moveRegion`, `setNotes`,
`addNotes`, `setCC`, `setAutomation` (with `curve`), `addFile`. `setProject` takes `finish` and `loop` (`null`
removes them). `POST /api/projects/:id/ops` with `{ "ops": [...], "author": "AI", "label": "…" }`
applies them through the open studio when there is one.
