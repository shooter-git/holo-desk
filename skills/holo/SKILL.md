---
name: holo
description: Work in HO[LO] Desk, the user's browser studio, live while it is open - compose, score, harmonize, write melodies, bass lines, counter-melodies and drum parts, re-orchestrate, set up live MIDI effects (a harmonizer or arpeggiator that follows what the user plays), mix, listen to what the user plays and answer it, set up the music of a new project (an "experience": a game, an app) so it builds its own songs with a pinned copy of HO[LO]'s engine, and move a creation's music into HO[LO] and back. Use whenever the user mentions HO[LO], the studio or the DAW, starts the music for a new project or experience, or asks for any music to be written, changed, played or harmonized "in the studio", "live" or "as I play".
---

# HO[LO] Desk

HO[LO] Desk is the user's studio in the browser (Logic-style: tracks, Piano Roll, Mixer). You work in it
through the `holo` command. When a studio is open, every change you make appears there at once as one
undo step labeled `AI: …`, and saves; with no studio open, changes go straight to the saved song.

## Start every session with

```bash
holo status
```

(HO[LO] may be hosted on another machine than yours: `holo` talks to `HOLO_URL`, by default this machine's
port 47800; if it says HO[LO] isn't answering, ask the user where HO[LO] runs and set `HOLO_URL`, e.g.
`https://<host>.<tailnet>.ts.net:47801`.) It says which song is open and on which device, where the
playhead is, what's selected, which MIDI devices are connected,
and how the studio names notes (Logic's middle C is **C3**; `holo` speaks scientific names, middle C =
**C4**, unless you add `--names logic`). When you talk to the user about notes, use the studio's naming.

Then read before you write:

```bash
holo show                                   # the song: tempo, meter, key, tracks, plugins, buses
holo show --track Strings --from 9 --to 17  # a track's notes, bar by bar (bar.beat.sixteenth.tick)
holo instruments                            # what can play (built-in presets, sample packs)
```

## Writing music

Positions are `bar.beat.sixteenth` (`14`, `14.3`, `14.3.2`). Notes are a compact notation, durations in
a unit you choose (`--unit 1/8` by default; `1/4`, `1/16`, `1/8T`…):

```
"D5:1 | B5:2 A5:1 F#5:1 A5:2 | r:3 (D4 F#4 A4):3"
 NOTE:DUR   r:DUR is a rest   (A B C):DUR a chord   | is only for reading
 suffixes: ! accent, ? ghost, ~ tie to the next same pitch, @96 an exact velocity
```

```bash
holo write --track Strings --at 9 --unit 1/8 "A4:2 C#5:2 E5:4"   # adds into the region there (or makes one)
holo write --track Strings --at 9 --replace "…"                     # replaces what was in that span
holo clear --track Strings --from 9 --to 13
holo track add "Counter-melody" --instrument vsco2/oboe
holo track set Strings --volume -4 --pan -0.3 --instrument synth:"Warm Pad"
holo track add Bass --instrument synth:"Fat Mono"                # a Moog-style mono: legato glides
holo synth Bass cutoff=450 emphasis=0.5 glide=0.12 drive=0.7     # its knobs (holo synth Bass lists them)
holo synth Pad space=0.7 shimmer=0.6 bloom=2                     # Ethereal Pad/Keys: a shimmering hall of its own
holo track add Organ --instrument synth:"Tonewheel Gospel"      # drawbar organ, rotor fast on the mod wheel
holo synth Organ drawbars=6 rotor=2 drive=0.5                    # stepped knobs take their option's number
holo track add Beat --instrument synth:"Analog Machine"         # a drum machine on the GM drum keys
holo kit Drums mic:room=-6 mic:overheads=2 tune=-1 decay=70      # a kit's microphones, tune and decay (holo kit Drums lists them)
holo automate --track Strings volume 9=-24 13=-6 17=-6 21=-30  # a swell and a fade (dB)
holo automate --track Keys reverb.mix 1=10 17=45                # a plugin moving (on its first reverb)
holo automate --bus Hall volume 33=0 41=-60                     # a bus; --track master for the master
holo automate --track Piano distance 9=0.3 25=0.6 --smooth      # back on its stage, eased (on a stage)
holo finish --lufs -16 --ceiling -1                             # master every bounce and render
holo looping 1 57 --tail 4                                      # a game's loop: renders loop it forever
holo tempo 92 · holo key "A lydian" · holo marker 17 "Chorus"
```

Make each musical idea one command (one undo step for the user). Prefer adding a new track for a new
voice (a harmony, a counter-melody) over writing into the user's own part, unless they asked you to
change it. Say what you did in musical terms ("a counter-melody in thirds above the theme, bars 9–16, on
the oboe").

## Scores: reading and writing notation

The studio shows any track as a score (the editor's **Score** view, or `N`), and you can read and write
music as notation too, bar by bar. Use it when the user thinks in notation, asks for a score, a part,
lyrics, dynamics or articulations, or wants music written precisely (a hymn, a lead sheet, a string
quartet). Parts are P1, P2… in track order; pitches are **as written on the page** (a B♭ clarinet a
tone up, a guitar an octave up: `holo score parts` says which).

```bash
holo score parts                       # P1 Piano (2 staves), P2 Clarinet in B♭ (written a major 2nd above sounding)…
holo score show --bars 1-8             # every part, bar by bar
holo score show --part P2 --bars 9-12  # one part (it keeps its number)
holo score check                       # out-of-range notes, slips, a bar missing between bars
holo score write bars.txt              # bars from a file (or - for stdin, or the text itself)
holo score part P2 --staves 2 --clefs G,F   # a part's staves, clefs, transposition (--transpose 2,1|none)
holo score part P3 --tab on --tuning drop-d --capo 2   # tab under a fretted part (--tab only: tab alone; off)
holo score meta --composer "…" --lyricist "…"
holo score pickup 1                    # the song starts with a one-beat upbeat (bar 0)
holo score unroll                      # write the repeats and jumps out as they play
```

A file of bars reads like this:

```
bar 9  key G major  tempo 88 "Andante"  |:
  P1 s1: p ( g4:q a4:q b4:q. c5:e ) d5:w~
  P1 s2: [g2 d3]:w
  lyrics P1 s1 1: O come, all ye *
  chords: G@1 D7@3
bar 10  :|
  P1 s1: d5:h r:h
  P1 s2: [g2 d3]:h r:h
```

Values `w h q e s t x` (whole … 64th) with dots (`q.`); `[c4 e4 g4]:h` a chord; `r:q` a rest; `R` a
whole-bar rest; `~` ties into the next note or bar; `3:2{e5:e f5:e g5:e}` a triplet; `+stacc +staccis
+ten +acc +marc +ferm +tr +mord +turn +arp +trem3` after the value; `+grace` (or `+appog`) for a grace
note before the next. Before a note: a dynamic (`pp`…`ff`, `sfz`, `fp`), `<` or `>` to start a
hairpin and `!` to end it, `(` and `)` around a slur, `"pizz."` above or `_"dolce"` below, `8va` …
`loco`. A line per staff and voice: `P1:`, `P1 s2:`, `P1 s1 v2:`. Every line must fill its bar (rests
included): a bar that doesn't is refused with the reason, and nothing in it is written. Each bar
replaces what the staves and voices it names had there; the others keep theirs. Dynamics and
articulations become how it plays (velocity, length), so the score sounds as it reads.

Repeats are written once and played as marked: `|:` and `:|` (`:|x3`), `ending 1` / `ending 2`,
`segno`, `coda`, `to coda`, `fine`, `D.C. al Fine`, `D.S. al Coda` in the bar headers. The timeline
keeps the music as written; playback, bounces and renders follow the repeats and jumps, and trills,
mordents, turns, tremolos and arpeggios play as the notes they stand for. Write a repeated passage
once with its signs rather than copying it out; `holo score unroll` writes it out when a part should
differ the second time.

## Live: what "real time" means here

You think in seconds; music happens in milliseconds. So:

- **To harmonize or transform what the user plays, as they play it**, put a MIDI effect on their track.
  It runs in the audio thread with no delay, and you tune it:
  ```bash
  holo fx add Keys harmonizer key=9 scale=6 voice1=2 voice2=4 velocity=75   # thirds and fifths in A lydian
  holo fx set Keys harmonizer voice2=-3                                       # change it while they play
  holo fx add Keys arpeggiator mode=2 rate=3 octaves=2 gate=70
  holo fx add Keys scale key=2 scale=7 quantize=1                             # every note snapped to D mixolydian
  holo plugins                                                                # every plugin and parameter
  ```
- **Call and response**: `holo listen --seconds 8` returns what the user just played (pitches, velocities,
  where in the song). Answer with `holo audition --track Keys "…"` (heard now, not recorded) or write it
  into the bars that follow.
- **Write while it loops**: `holo loop 9 17` then `holo play`; each `holo write` is heard on the next pass.
- **Transport**: `holo play [--from 9]`, `holo stop`, `holo locate 1`, `holo loop off`.
- **Bounce**: `holo bounce` renders the song (or the cycle) to a WAV in the studio and keeps it with the
  song on the host; the command prints where.
- **Audio**: `holo audio FILE.wav --at 9 [--track "Vocal"]` puts a recording or a stem on an audio track
  (a new one unless `--track` names one). Audio regions show in `holo show` with their file, gain,
  fades and stretch; change those with raw `updateRegion` ops (see reference.md).

## Craft

- Read the key, the meter and its grouping (`4/4 (3+3+2)`), the chords and the existing parts first;
  write inside them. Check the result with `holo show --track …`.
- Keep each instrument in its range and idiom (see [reference.md](reference.md)): a cello isn't a flute,
  pizzicato strings don't sustain, drum pads use the General MIDI map (36 kick, 38 snare, 42/46 hats…).
- Shape velocity: phrases rise and fall; accents land on the meter's groups; ghost notes are soft.
- Voice-lead harmony smoothly (common tones held, small steps) unless the style wants otherwise.

## Music for a new project (an experience)

The user composes the music of new projects ("experiences": games, apps, anything interactive) in HO[LO],
and the project builds its songs itself with a pinned copy of HO[LO]'s engine (no HO[LO] Desk needed).
**Whenever the user starts music for a new project, set it up first** (in the project's folder, or a new
one beside their other projects; HO[LO] only shows it from the creations folder, `HOLO_CREATIONS_DIR`):

```bash
holo init ../moon-garden --title "Moon Garden"   # holo.creation.json, music/sessions, music/holo (the engine), npm run music
holo new "Title Theme" --for moon-garden          # a song of its own: its file is written, the studio opens it
holo send --to moon-garden                        # or give it the open song (one of the user's own)
```

Then compose and edit through the song files and `holo` commands:

- Write with `holo write`, `holo track`, `holo fx`, `holo automate`… as for any song; they go into the open
  studio as undoable steps. `holo send` writes the song's file (`music/sessions/<piece>.holo.json`):
  that file is the score the project builds, so send after each round of changes the user is happy with.
- You may also edit a song's file directly (docs/session-format.md); then `holo pull moon-garden title-theme`
  brings it into the studio, so the user hears it.
- `npm run music` in the project builds every song whose file changed into `music/build/` (lossless WAV),
  exactly as the studio renders it. Never commit `music/build/` or sample files; commit the song files,
  `holo.creation.json` and `music/holo/` when the user asks for a commit.
- `holo render` (with `pnpm runner` running on the host) has the project render the open song with its own
  pinned engine, beside the studio's mix.
- A badge in *Songs* (**Builds with engine … · holo update-engine**) means the project's pinned engine is
  older than the studio's in what it plays: its code, or a pack its songs play. Tell the user;
  `holo update-engine ../moon-garden` moves it to the studio's engine, rebuilds every song and reports
  how far each moved. Run it only when the user agrees: it changes what the project builds.
- An experience pins only the sample packs its songs play (`music/holo/packs.json`). `holo send` (and
  the studio's Send) adds a pack a song starts playing and lets go of one no song plays, and says so.
  If it says a pack can't be played with the project's engine, that pack is newer than the engine:
  `holo update-engine` (with the user's go-ahead). The packs and their pages are in
  [HO[LO] Packs](https://github.com/shooter-git/holo-packs).
- Don't use `holo init` on a project that already has a `holo.creation.json` (it refuses), and never on a
  creation whose music is its own code: that one keeps its own round trip (next section).

## Creations whose music is code

A creation's music is code; HO[LO] edits a copy of its notes, and the creation plays the edited tracks
back through its own renderer. The round trip:

```bash
holo creations                          # creations HO[LO] can see, and their exported pieces
holo pull my-game theme                # open a piece in the studio
#   … edit in the studio, or with holo write / fx …
holo send                               # write it back into the creation (its sessions folder)
```

A creation's own tools and conventions (its importer, how it counts bars, how it renders) may be
described on this machine in `local/<creation>/README.md` in the HO[LO] checkout: read it when it's
there. HO[LO] counts bars from **1** (as Logic does).

Then render in the creation as usual. Only tracks marked **edited** replace the creation's own
notes; everything else stays generated by its code. To bring the creation's newest code into HO[LO],
export the piece again from the creation (`holo creations` shows how) and pull it.

To hear the song as the creation will play it, without sending anything, run `holo render`: the creation
renders it with the studio's edits (through `pnpm runner` on the host; a long orchestral piece can
take several minutes) and its mix comes back on a soloed audio track for the user to compare. It writes nothing in
the creation's repository; if no runner is running, say so and leave starting it to the user.

Ask before `holo send` and before rendering in the creation's own folder (`render.py` without a runner):
both write files in the creation's repository.

## Safe by default

- Every change is undoable in the studio (Ctrl Z); songs keep their history on the server.
- Never delete songs. Don't change tempo, key or meter unless asked.
- If `holo` says the server isn't answering, tell the user to start HO[LO] (`pnpm dev` or `pnpm up` in
  the holo-desk folder); don't start or stop it yourself.
