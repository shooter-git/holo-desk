/**
 * The six-operator FM synth's patch format: what a sound may carry in its params besides the six
 * knobs, so a sound can be a whole patch (every operator, the matrix, every envelope, the filter,
 * the LFO, unison and the chorus/delay), not only a preset with its knobs turned. Every value is a
 * number, so a patch travels wherever a synth's params already go (a song, a palette's sound, the
 * engine) and is checked like any knob. Keys a sound leaves out keep the preset's values, unless
 * it starts from nothing:
 *
 *   patch:blank     0|1        1: the patch starts blank (every operator off, nothing wired, the
 *                              defaults below) instead of from its preset, so its keys are all of it
 *
 * Operators, n = 1…6:
 *   op{n}:on        0|1        it runs at all (an operator off is silent and costs nothing)
 *   op{n}:wave      0…7        its waveform (FM6_WAVES): 0 sine, 1 triangle, 2 saw, 3 square,
 *                              4 pulse (a quarter cycle up), 5 half sine (the lower half flattened),
 *                              6 soft saw (every harmonic, falling as 1/h²), 7 octave sine (a sine and
 *                              half as much of its octave)
 *   op{n}:custom    0…4        a waveform the sound brings itself (w1…w4 below) in place of `wave`; 0: none
 *   op{n}:ratio     0…64       its frequency over the note's
 *   op{n}:fixed     0|1        1: it keeps `hz` whatever the note
 *   op{n}:hz        0…20000    its frequency when fixed
 *   op{n}:offset    ±1000      hertz added to its frequency (beating that stays the same up the keyboard)
 *   op{n}:level     ±4         its amplitude: scales all it feeds (operators, the filter, the output);
 *                              negative turns its wave over
 *   op{n}:vel       ±1         velocity sensitivity: amplitude × (velocity / 127)^(2.45 × vel);
 *                              negative is louder played softly
 *   op{n}:out       0…4        how much of it is heard directly
 *   op{n}:pan       ±1         where it's heard, and where it enters the filter
 *   op{n}:filter    0…4        how much of it goes into the filter
 *   op{n}:phase     0…1        where its wave starts on a new note (cycles)
 *   op{n}:free      0|1        1: it starts somewhere new on every note instead
 *   op{n}:k{j} 0…127, op{n}:kv{j} ±96 dB, op{n}:kc{j} ±1  (j = 0…3) its level across the keyboard:
 *                              up to four points, each a key, a level in dB there, and the curve of
 *                              the stretch that arrives at it (below the first point and above the
 *                              last, the level stays)
 *
 * The matrix:
 *   mod:{s}>{t}     ±32        how far operator s swings operator t's phase (radians per unit of s's
 *                              output); s = t is feedback; s = f is the filter's output
 *
 * Envelopes: env1…env6 (each operator's amplitude), envf (the filter's cutoff), envp (pitch):
 *   env{x}:n        1…8        how many points
 *   env{x}:start    ±1         where it starts (and rests)
 *   env{x}:t{k} 0…600 s, env{x}:l{k} ±1, env{x}:c{k} ±1   point k: the time to reach it, its level,
 *                              and the curve on the way (0 straight; below 0 it starts slowly and
 *                              speeds up, above 0 it starts fast and settles)
 *   env{x}:sus      -1…7       the point it holds while the key is down (-1: none: it runs through,
 *                              and letting go changes nothing)
 *   env{x}:loop     -1…7       with the key down, at the sustain point it goes back to the stretch
 *                              after this point and plays round again (-1, or not before `sus`: it holds)
 *   env{x}:kt       ±2         key → times: at 1 they halve with each octave above middle C
 *   env{x}:vt       ±2         velocity → times: at 1 they halve from velocity 64 to 127
 *   Letting go jumps to the stretch after `sus`, from wherever the level is: its time is for a fall
 *   from full, so a release from lower takes less.
 *
 * The filter: two state-variable filters on what the operators send it, in stereo:
 *   flt:cutoff 20…20000 Hz (filter 1), flt:spread 0…60 semitones (filter 2 above filter 1),
 *   flt:res1, flt:res2 0…0.99, flt:mode1, flt:mode2 0…2 (0 low-pass, 1 band-pass, 2 high-pass;
 *   in between, a blend), flt:serial 0…1 (0 side by side, 1 filter 1 into filter 2),
 *   flt:mix 0…1 (0 filter 1 only, 1 filter 2 only), flt:key ±2 (semitones of cutoff per semitone of
 *   key, from middle C), flt:k{j} / flt:kv{j} (semitones) / flt:kc{j} (a key curve, as an operator's),
 *   flt:env ±96 (semitones at the envelope's top; the cutoff moves with envf's level),
 *   flt:vel ±1 (as an operator's), flt:out 0…4, flt:pan ±1
 *
 * Pitch, LFO, voice and unison:
 *   pitch:env ±48 semitones at envp's level 1
 *   lfo:wave 0…4 (sine, triangle, saw, square, random), lfo:rate 0.01…50 Hz, lfo:velrate ±48
 *   (semitones of rate at velocity 127, none at 64), lfo:phase 0…1 (where it starts on a note),
 *   lfo:fade 0…10 s (its depth comes in over this), lfo:pitch ±12 semitones, lfo:wheel 0…12
 *   semitones more at the mod wheel's top, lfo:cutoff ±96 semitones (from the cutoff up to it, as the
 *   LFO goes from its bottom to its top), lfo:amp 0…1 (tremolo)
 *   voice:transpose ±48 semitones, voice:tune ±100 cents, voice:poly 1…64 (how many oscillator
 *   voices sound at once, unison voices each counted), voice:level 0…4, voice:drift 0…50 cents
 *   (each unison voice a little out, its own way), voice:longest 0…600 s (no envelope stretch
 *   lasts longer: what it was owed carries into the stretch after it; 0: no limit)
 *   uni:voices 1…8 per note, uni:detune 0…100 cents between neighbors, uni:pan 0…1 (spread)
 *
 * The chorus/delay, after the voices: four taps on a delay line, two reading the left and two the
 * right, each swung by its own slow triangle, crossed over to the other side, with feedback:
 *   fx:dry 0…2, fx:wet ±2 (0: off), fx:time 0.001…2 s, fx:spread 0…1 (lays the taps out at
 *   1 - s/2, 1 + s/2, 1 and 1 + s times `time`), fx:tap1…fx:tap4 0…4 (or each tap's own multiple),
 *   fx:depth 0…0.03 s, fx:rate 0.01…20 Hz (or fx:rate1…fx:rate4 each), fx:feedback ±0.95,
 *   fx:lowcut 5…5000 Hz, fx:highcut 100…22000 Hz (what goes into the delay; 20000 and up: open)
 *
 * Waveforms a sound brings, k = 1…4:
 *   w{k}:{i} ±1, i = 0…1023: one cycle, its points in order from 0 (as many as are given, at least
 *   four); it is played band-limited, as the built-in waveforms are, with any offset taken out
 *
 * A blank patch: every operator off, a sine at ratio 1, level 1, no velocity sensitivity, no output
 * and nothing in the filter; every envelope up in 2 ms, held, and down in 0.1 s once let go; the
 * filter at 2000 Hz, low-pass, unheard; the LFO a 5 Hz sine that only the mod wheel sends to pitch
 * (half a semitone at its top); voice level 0.2, 32 voices, one per note; the chorus/delay off.
 *
 * The six knobs work on top of whatever patch plays: Brightness scales every mod amount, Velocity
 * every velocity sensitivity, Attack the first stretch of every envelope, Decay the stretches up to
 * the sustain point, Release those after it, and Chorus the chorus/delay's wet level.
 */

export const FM6_OPS = 6;
export const FM6_WAVES = ['Sine', 'Triangle', 'Saw', 'Square', 'Pulse', 'Half Sine', 'Soft Saw', 'Octave Sine'];
export const FM6_LFO_WAVES = ['Sine', 'Triangle', 'Saw', 'Square', 'Random'];
/** Points an envelope may have, points a key curve may have, waveforms a sound may bring and their longest. */
export const FM6_ENV_POINTS = 8;
export const FM6_KEY_POINTS = 4;
export const FM6_CUSTOM_WAVES = 4;
export const FM6_CUSTOM_POINTS = 1024;

/** What a patch key sets: its part (which operator or envelope, `index`), its field and its range. */
export interface Fm6Key {
  part: 'patch' | 'op' | 'mod' | 'env' | 'flt' | 'pitch' | 'lfo' | 'voice' | 'uni' | 'fx' | 'wave';
  /** The operator (0…5), the envelope (0…5 an operator's, 6 the filter's, 7 pitch), the waveform (0…3). */
  index: number;
  field: string;
  /** A point (a key curve's, an envelope's, a waveform's), a tap, or the matrix's target operator. */
  sub: number;
  min: number;
  max: number;
}

type Range = [number, number];

const OP: Record<string, Range> = {
  on: [0, 1],
  wave: [0, FM6_WAVES.length - 1],
  custom: [0, FM6_CUSTOM_WAVES],
  ratio: [0, 64],
  fixed: [0, 1],
  hz: [0, 20000],
  offset: [-1000, 1000],
  level: [-4, 4],
  vel: [-1, 1],
  out: [0, 4],
  pan: [-1, 1],
  filter: [0, 4],
  phase: [0, 1],
  free: [0, 1],
};
const CURVE: Record<string, Range> = { k: [0, 127], kv: [-96, 96], kc: [-1, 1] };
const ENV: Record<string, Range> = {
  n: [1, FM6_ENV_POINTS],
  start: [-1, 1],
  sus: [-1, FM6_ENV_POINTS - 1],
  loop: [-1, FM6_ENV_POINTS - 1],
  kt: [-2, 2],
  vt: [-2, 2],
};
const POINT: Record<string, Range> = { t: [0, 600], l: [-1, 1], c: [-1, 1] };
const FLT: Record<string, Range> = {
  cutoff: [20, 20000],
  spread: [0, 60],
  res1: [0, 0.99],
  res2: [0, 0.99],
  mode1: [0, 2],
  mode2: [0, 2],
  serial: [0, 1],
  mix: [0, 1],
  key: [-2, 2],
  env: [-96, 96],
  vel: [-1, 1],
  out: [0, 4],
  pan: [-1, 1],
};
const PLAIN: Record<string, Record<string, Range>> = {
  patch: { blank: [0, 1] },
  pitch: { env: [-48, 48] },
  lfo: {
    wave: [0, FM6_LFO_WAVES.length - 1],
    rate: [0.01, 50],
    velrate: [-48, 48],
    phase: [0, 1],
    fade: [0, 10],
    pitch: [-12, 12],
    wheel: [0, 12],
    cutoff: [-96, 96],
    amp: [0, 1],
  },
  voice: { transpose: [-48, 48], tune: [-100, 100], poly: [1, 64], level: [0, 4], drift: [0, 50], longest: [0, 600] },
  uni: { voices: [1, 8], detune: [0, 100], pan: [0, 1] },
  fx: {
    dry: [0, 2],
    wet: [-2, 2],
    time: [0.001, 2],
    spread: [0, 1],
    depth: [0, 0.03],
    rate: [0.01, 20],
    feedback: [-0.95, 0.95],
    lowcut: [5, 5000],
    highcut: [100, 22000],
  },
};
const TAP: Range = [0, 4];
const TAP_RATE: Range = [0.01, 20];
const MOD: Range = [-32, 32];
const SAMPLE: Range = [-1, 1];

const key = (part: Fm6Key['part'], index: number, field: string, sub: number, r: Range | undefined): Fm6Key | null =>
  r ? { part, index, field, sub, min: r[0], max: r[1] } : null;

/** A field with a point number on its end ("t3", "kv0"): the name and the number. */
function pointed(field: string): [string, number] | null {
  const m = /^([a-z]+)(\d)$/.exec(field);
  return m ? [m[1] as string, Number(m[2])] : null;
}

/** The six-operator patch key `id` (see the top of this file), or null when it isn't one. */
export function fm6Key(id: string): Fm6Key | null {
  const colon = id.indexOf(':');
  if (colon < 0) return null;
  const head = id.slice(0, colon);
  const field = id.slice(colon + 1);
  let m = /^op([1-6])$/.exec(head);
  if (m) {
    const n = Number(m[1]) - 1;
    if (OP[field]) return key('op', n, field, 0, OP[field]);
    const p = pointed(field);
    return p && p[1] < FM6_KEY_POINTS ? key('op', n, p[0], p[1], CURVE[p[0]]) : null;
  }
  if (head === 'mod') {
    m = /^([1-6f])>([1-6])$/.exec(field);
    if (!m) return null;
    return key('mod', m[1] === 'f' ? FM6_OPS : Number(m[1]) - 1, 'amount', Number(m[2]) - 1, MOD);
  }
  m = /^env([1-6fp])$/.exec(head);
  if (m) {
    const which = m[1] as string;
    const n = which === 'f' ? FM6_OPS : which === 'p' ? FM6_OPS + 1 : Number(which) - 1;
    if (ENV[field]) return key('env', n, field, 0, ENV[field]);
    const p = pointed(field);
    return p && p[1] < FM6_ENV_POINTS ? key('env', n, p[0], p[1], POINT[p[0]]) : null;
  }
  if (head === 'flt') {
    if (FLT[field]) return key('flt', 0, field, 0, FLT[field]);
    const p = pointed(field);
    return p && p[1] < FM6_KEY_POINTS ? key('flt', 0, p[0], p[1], CURVE[p[0]]) : null;
  }
  if (head === 'fx') {
    const p = pointed(field);
    if (p && p[1] >= 1 && p[1] <= 4) {
      if (p[0] === 'tap') return key('fx', 0, 'tap', p[1] - 1, TAP);
      if (p[0] === 'rate') return key('fx', 0, 'rate', p[1] - 1, TAP_RATE);
    }
  }
  const plain = PLAIN[head];
  if (plain) return key(head as Fm6Key['part'], 0, field, -1, plain[field]);
  m = /^w([1-4])$/.exec(head);
  if (m && /^\d{1,4}$/.test(field) && Number(field) < FM6_CUSTOM_POINTS)
    return key('wave', Number(m[1]) - 1, 'point', Number(field), SAMPLE);
  return null;
}
