# HO[LO] reference

## Ranges (sounding pitch, scientific names: middle C = C4 = MIDI 60)

| Instrument | Comfortable | Full | Notes |
|---|---|---|---|
| Violins | G3–E6 | G3–A7 | pizzicato rings briefly; tremolo and spiccato for energy |
| Violas | C3–A5 | C3–E6 | |
| Cellos | C2–A4 | C2–C6 | |
| Contrabass | E1–D3 | E1–G3 | sounds an octave below written |
| Flute | D4–D6 | C4–C7 | weak low, brilliant high |
| Oboe | D4–D6 | Bb3–A6 | the lyrical lead |
| Clarinet | E3–C6 | D3–Bb6 | dark chalumeau below G4 |
| Bassoon | Bb1–D4 | Bb1–E5 | |
| French horn | C3–F5 | B1–F5 | warm in the middle |
| Trombone | E2–F4 | E2–Bb4 | |
| Tuba | D1–F3 | D1–F4 | |
| Harp | C2–C7 | C1–G7 | |
| Glockenspiel | G5–C8 | | sounds two octaves above written |
| Timpani | D2–A3 | | one note per drum; rolls for sustain |
| Piano | A0–C8 | | |

## Notation

`NOTE:DUR`, `r:DUR`, `(A B C):DUR`; durations in `--unit`s, may be `1/2` or `1.5`; `!` accent (+20
velocity), `?` ghost (−35), `~` tie into the next same pitch, `@96` exact velocity. Names: `C#4`, `Db4`,
`Bb-1`, or MIDI numbers `61`.

## Positions

`bar`, `bar.beat`, `bar.beat.sixteenth`, `bar.beat.sixteenth.tick`; `t:3840` is a raw tick. 960 ticks
per quarter note.

## MIDI effects (on tracks)

- `harmonizer`: `key` 0–11 (C…B), `scale` (0 Major, 1 Natural minor, 2 Harmonic minor, 3 Melodic
  minor, 4 Dorian, 5 Phrygian, 6 Lydian, 7 Mixolydian, 8 Locrian, 9 Major pentatonic, 10 Minor
  pentatonic, 11 Chromatic), `voice1..3` scale steps from the played note (2 = a third above, 4 = a
  fifth, −3 = a fourth below, 0 = off), `velocity` %, `original` 0/1.
- `arpeggiator`: `mode` (0 up, 1 down, 2 up/down, 3 as played, 4 random, 5 chord), `rate` (0 1/4, 1
  1/8, 2 1/8T, 3 1/16, 4 1/16T, 5 1/32), `octaves` 1–4, `gate` %, `latch` 0/1, `swing` %.
- `scale`: `transpose` semitones, `key`, `scale`, `quantize` 0/1.
- `velocity`: `scale` %, `offset`, `random`, `min`, `max`.

## Audio effects (tracks, buses, master)

`eq` (Channel EQ), `peq` (Parametric EQ: eight bands, each `t1`–`t8` type 0 off, 1 low cut, 2 low
shelf, 3 bell, 4 notch, 5 band pass, 6 high shelf, 7 high cut, with `f`, `g`, `q`), `compressor`
(`detector` 0 log, 1 linear), `gate`, `softener` (Transient Softener), `limiter`, `space` (Space
Designer), `shimmer`, `reverb`, `delay`, `chorus`, `wow` (Wow & Flutter), `width` (Stereo Width:
`width` %, `position` −100 left … 100 right, `mono` and `monoFreq` for the lows), `tape` (Tape Warmth),
`saturator`; `holo plugins` lists every parameter with its range.

## Audio regions

On an audio track a region's `audio` is `{ file, offset (s into the recording), gain (dB), fadeIn,
fadeOut (s), stretch (1 = as recorded, 2 = twice as long at the same pitch, 0.25–4) }`. To change one,
send the whole object back with the field changed:

```json
[{ "op": "updateRegion", "track": "trk_…", "region": "rgn_…",
   "patch": { "audio": { "file": "aud_…", "offset": 0, "gain": -3, "fadeIn": 0.01, "fadeOut": 0.5, "stretch": 1 } } }]
```

Stretching changes how long the region plays, so set its `length` too (ticks).

## Raw operations

`holo ops file.json` applies a list of operations (the same ones the studio uses), e.g.

```json
[{ "op": "updateChannel", "target": "trk_…", "patch": { "volume": -6 } },
 { "op": "addNotes", "track": "trk_…", "region": "rgn_…", "notes": [{ "t": 0, "d": 480, "p": 69, "v": 90 }] }]
```

Note times are ticks from the region's start. See docs/session-format.md in the holo-desk repository.
