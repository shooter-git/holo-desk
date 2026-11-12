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
                // a kit keeps its knobs where they're turned: { …, "params": { "mic:room": -6,
                // "tune": -1, "decay": 70 } } (each microphone's level in dB, -60 is off; tune in
                // semitones; decay in percent of each hit's ring; see samplerKnobs in packages/session)
                // or { "type": "synth", "preset": "Warm Pad", "params": {…} } (the synths with knobs,
                // "Fat Mono", "Tonewheel Jazz", "FM Keys" and most others, take them there:
                // { "cutoff": 450, … }, see SYNTH_MACROS in packages/session), a Performance or Glass
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
(`data/audio/<song id>/`, as WAV: a FLAC or AIFF sent there is made a WAV under the same id), never
inside the session file:

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

## The score

A song can be written out as a score. The notes stay what plays (and what the piano roll shows);
the score adds what notation needs on top, all of it optional, so a song without it is unchanged
and an older HO[LO] still plays it.

```jsonc
// on a note: how it's written
"n": { "sp": [6, -1, 70],            // spelled B♭: letter (0 C … 6 B), accidental, the pitch it spells
       "w": [960, 480],              // written a quarter, sounding an eighth (a staccato)
       "vo": 1, "st": 1,             // voice 1–4, staff 1… of the part
       "a": ["stacc", "acc"],        // articulations and ornaments
       "g": "a",                     // a grace note: "a" acciaccatura, "p" appoggiatura
       "dv": 72,                     // the velocity the dynamics last gave it
       "ly": ["Hal-", "Sing"],       // lyric syllables by verse ("-" joins, "_" holds)
       "tb": [3, 62],                // tablature string (1 the highest), for this pitch
       "tu": [5, 4],                 // a tuplet the timing alone doesn't say
       "hd": "x", "stem": "down", "fi": "3" }
// on a region: markings over its notes, ticks from the region's start
"marks": [{ "t": 0, "k": "dyn", "v": "mf" }, { "t": 0, "k": "slur", "e": 1920, "st": 1, "vo": 1 },
          { "t": 960, "k": "cresc", "e": 3840 }, { "t": 3840, "k": "oct", "e": 5760, "v": 8 }]
// on a track: the part
"score": { "abbr": "Pno.", "staves": 2, "split": 60, "clefs": [[0, 1, "G"], [0, 2, "F"]],
           "tr": [2, 1],                                  // written a major second above (B♭ clarinet)
           "drums": { "36": [-3, "normal"], "42": [5, "x"] },
           "tab": { "tuning": [64, 59, 55, 50, 45, 40], "capo": 2 }, "grid": 240, "hidden": false }
// on the song
"keys": [{ "tick": 0, "fifths": -1, "mode": "minor" }, { "tick": 30720, "fifths": 2, "mode": "major" }],
"form": [{ "tick": 3840, "k": "start" }, { "tick": 11520, "k": "end", "times": 3 },
         { "tick": 11520, "k": "ending", "e": 15360, "passes": [1, 2] }, { "tick": 23040, "k": "ds", "al": "coda" }],
"score": { "composer": "…", "groups": [["trk_a", "trk_b", "brace"]], "breaks": [[15360, "system"]],
           "page": { "size": "a4", "staff": 7 }, "concert": true }
```

- **Hints follow the note.** A hint that depends on the note's sound carries the value it was made
  for: the spelling its pitch, the written length its sounding length, `dv` its velocity. When the
  note changes (dragged in the piano roll), the hint no longer matches and the score works it out
  afresh; the rest (articulations, lyrics, voice) stays with the note.
- **Ties and tuplets** come from the timing: one long note across a bar line is drawn as tied notes.
- **Marks**: `dyn`, `cresc`, `dim`, `slur`, `text` (above: "pizz."), `expr` (below: "dolce"), `oct`
  (8, 15, −8), `breath`, `caesura`, `gliss`. Pedal is the sustain lane (CC 64).
- **Clefs**: `G`, `F`, `C1`–`C5`, `G8vb`, `G8va`, `G15ma`, `F8vb`, `F8va`, `perc`, `tab`.
- **Keys**: `fifths` −7…7, `mode` major, minor, dorian, phrygian, lydian, mixolydian or locrian. The
  first point is the song's `key`: setting one sets the other.
- **Form**: `start`/`end` repeat a passage (`times`, 2 when unset); `ending` is a first or second
  ending to `e`, taken on `passes`; `segno`, `coda`, `toCoda`, `fine`; `dc`/`ds` jump to the start or
  the segno, `al` `fine` or `coda`, and `repeats: true` plays the repeats again after the jump.
  The timeline holds the music once, as written. Playing it follows the form: a repeat goes back to
  the last `start` (or the last `end`, or the top, where a pickup plays again), an ending is skipped
  on the passes it doesn't list, the first `dc`/`ds` jumps once, and only after it do `toCoda` and
  `fine` count. `performed(project)` (in `@holo/session`) is the song as heard, which the engines play;
  `playMap`, `writtenAt` and `playedAt` go between the two timelines, and `unrollOps` writes the form
  out. Engines from before the form (a creation's pinned copy) play the music straight through.
- **Ornaments**: `tr`, `mord`, `pmord`, `turn`, `trem1`–`trem4` and `arp` in a note's `n.a` play as
  the notes they stand for (a trill on the note above in the key, about 13 a second, ending on the
  note; a chord rolled from the bottom), made at playback by `realize`: the song keeps the one note.
- **A pickup**: the first meter point's `pickup` is how many ticks of the first bar are written (an
  upbeat). The bar stays a full bar on the timeline; it is bar 0, and the next is bar 1.
- **Tempo marks**: a tempo point may carry `text` ("Allegro", "rit."), `mm` (show ♩ = 120), and a
  gradual change `ramp` (until this tick) `to` (bpm). Points with `gen` were made by the score from a
  ramp or a fermata, and are made again when that changes.

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
- Tape Warmth can take away a fixed center from its saturated sound: `"settings": { "center": "0.0012,-0.0004" }`
  (left, right). A creation whose saturation centers itself on the whole loop's average hands that
  average over this way. (Songs saved before it was spelled `center` say `centre`, which is still read.)
- A Drum Replacer's kit is `"settings": { "kit": "drums/Studio Kit" }` (a pack's instrument, loaded
  with the song's instruments), `"synth:Analog Machine"` (a drum machine), or absent for the Drum Synth.

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
after turn until everything that rings past the end has come around into the start (its longest
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
`splitRegion`, `addNotes`, `setNotesIn` and `setMarksIn` (replace only what starts in `[from, to)` of a
region), `setCC`, `setAutomation` (with `curve`), `addFile`, `arrange`. `setProject` takes `finish`, `loop`, `keys`, `form` and `score` (`null`
removes them). `POST /api/projects/:id/ops` with `{ "ops": [...], "author": "AI", "label": "…" }`
applies them through the open studio when there is one.

`{ "op": "splitRegion", "track", "region", "at", "id" }` cuts a region in two at `at` (a tick of the song,
inside the region), as the studio's Split does: the left half keeps the region's id, the right half takes
`id` (the caller's, new to the song). Notes, controller points and marks go to the half they start in (a
note keeps its length; a line over the cut stops there); an audio region's right half plays on from where
the cut fell in its recording.

`{ "op": "arrange", "edit": "insert" | "delete" | "copy" | "move", "from", "to", "at"? }` changes bars across
the whole song (`arrange.ts`), every position a tick on a bar line:
- `insert`: empty bars `[from, to)`; what was at `from` moves to `to`. They are whole bars of the meter just
  before `from`.
- `delete`: takes out `[from, to)`; what came after moves back to `from`.
- `copy`: plays `[from, to)` again at `at`; what was at `at` moves later.
- `move`: takes `[from, to)` to `at` (not inside them).

Everything with a time moves with its bars: regions and their notes, controller lanes and marks, automation,
tempo (ramps too), meter, keys, markers, chords, the cycle and the loop, repeats and jumps (an `end`, `fine`,
`toCoda`, `dc` or `ds` belongs to the bar before its tick), the score's breaks, clefs, and a Performance
instrument's dynamics. A region inside one stretch moves whole and keeps its id; one an edit cuts goes in
pieces with new ids, except that a MIDI region stays one region where the song only opens up (an insert) or
closes up (a delete). Automation and dynamics hold their value through inserted bars and keep their shape
on both sides of a cut. Pieces of one recording that end up side by side, playing on where the other
stopped, are one region again, so deleting inserted bars gives the song back as it was. The operation is
worked out on the song where it's applied, so it never acts on an old copy; in the studio it's one undo
step. Positions off a bar line, and edits at the start of a song with a pickup, are refused.
