import { newAudioTrack, newProject, PPQ, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { findClicks } from '../src/analysis/clicks.ts';
import { compileGraph, compileTempo, compileTrack, meterTicks } from '../src/compile.ts';
import { EngineCore } from '../src/core.ts';
import type { ClipSpec, ToWorklet } from '../src/protocol.ts';

// A track's clips swapped while it plays (a note edit's patch coming in or going, in the studio):
// at once, as ever, or crossfaded over the frames a `fade` gives, both lists playing meanwhile; one
// that comes while a crossfade is under way waits for it to end. Stopped, they take over at once.

const SR = 48000;
const BLOCK = 128;
const BLOCKS = 200;
/** The block before which the clips are swapped. */
const AT = 20;

/** Two seconds of a tone. */
const tone = (hz: number, level: number) =>
  Float32Array.from({ length: SR * 2 }, (_, i) => level * Math.sin((2 * Math.PI * hz * i) / SR));

/** A song of one audio track and nothing after it: no plugins, no buses, so the mix is the clips' sum. */
function song(): Project {
  const p = newProject('Crossfade');
  p.buses = [];
  p.master.inserts = [];
  const t = { ...newAudioTrack('Vocal'), id: 'trk_v' };
  t.channel.sends = [];
  p.tracks = [t];
  return p;
}

const clips = (key: string): ClipSpec[] => [
  { key, start: 0, end: SR * 2, source: 0, regionStart: 0, regionEnd: SR * 2, gain: 1, fadeIn: 0, fadeOut: 0 },
];

/** The song played block by block, `swap` sent before block AT (none: the first list throughout), `more` before theirs. */
function play(
  first: ClipSpec[],
  swap?: Extract<ToWorklet, { type: 'clips' }>,
  more: Record<number, ToWorklet[]> = {},
  audio: Record<string, Float32Array> = {},
): Float32Array {
  const p = song();
  const core = new EngineCore(SR, (m) => {
    if (m.type === 'error') throw new Error(m.message);
  });
  const segments = compileTempo(p, SR);
  core.receive({ type: 'init', ring: null, meters: null, transport: null });
  core.receive({ type: 'tempo', segments, ppq: PPQ, ...meterTicks(p) });
  core.receive({ type: 'audio', key: 'old', channels: [tone(220, 0.4)] });
  core.receive({ type: 'audio', key: 'new', channels: [tone(330, 0.3)] });
  for (const [key, data] of Object.entries(audio)) core.receive({ type: 'audio', key, channels: [data] });
  core.receive({ type: 'graph', graph: compileGraph(p, () => 1, segments) });
  core.receive({ type: 'sequence', num: 1, events: compileTrack(p.tracks[0] as Project['tracks'][number], segments) });
  core.receive({ type: 'clips', num: 1, clips: first });
  core.receive({ type: 'play', frame: 0, record: false, countIn: 0 });
  const out = new Float32Array(BLOCKS * BLOCK);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let b = 0; b < BLOCKS; b++) {
    if (b === AT && swap) core.receive(swap);
    for (const m of more[b] ?? []) core.receive(m);
    core.process(l, r, undefined, b * BLOCK);
    out.set(l, b * BLOCK);
  }
  return out;
}

const bytes = (x: Float32Array) => Buffer.from(x.buffer, x.byteOffset, x.byteLength);

/**
 * Where a crossfade of `fade` frames from `x` to `y` starts in `out`, from frame `from` on (within
 * 250 ms), and how far `out` is from it there: the frame whose crossfade fits best (old · (1 − λ) +
 * new · λ, λ rising from (1 / fade) at its first frame).
 */
function crossfadeIn(out: Float32Array, x: Float32Array, y: Float32Array, fade: number, from: number) {
  let best = { at: -1, error: Number.POSITIVE_INFINITY };
  for (let at = from; at <= from + 0.25 * SR && at + fade < out.length; at++) {
    let error = 0;
    for (let k = 0; k < fade && error < best.error; k += 1) {
      const lambda = (k + 1) / fade;
      const want = (x[at + k] as number) * (1 - lambda) + (y[at + k] as number) * lambda;
      error = Math.max(error, Math.abs((out[at + k] as number) - want));
    }
    if (error < best.error) best = { at, error };
  }
  return best;
}

/** The frames of `a` and `b` from `at` the same within rounding. */
function same(a: Float32Array, b: Float32Array, at: number, to = a.length): boolean {
  for (let i = at; i < to; i++) if (Math.abs((a[i] as number) - (b[i] as number)) > 1e-7) return false;
  return true;
}

/** How well two sounds agree over `n` frames from `at`: 2·Σxy / (Σx² + Σy²) (1: the same; −1: opposite). */
function agreement(x: Float32Array, y: Float32Array, at: number, n: number): number {
  let xy = 0;
  let xx = 0;
  let yy = 0;
  for (let i = at; i < at + n; i++) {
    xy += (x[i] as number) * (y[i] as number);
    xx += (x[i] as number) ** 2;
    yy += (y[i] as number) ** 2;
  }
  return (2 * xy) / (xx + yy);
}

describe('a track’s clips swapped while it plays', () => {
  const old = play(clips('old'));
  const neu = play(clips('new'));
  const from = AT * BLOCK;

  it('take over at once without a fade, as they always have', () => {
    const out = play(clips('old'), { type: 'clips', num: 1, clips: clips('new') });
    expect(bytes(out.subarray(0, from)).equals(bytes(old.subarray(0, from)))).toBe(true);
    expect(bytes(out.subarray(from)).equals(bytes(neu.subarray(from)))).toBe(true);
  });

  for (const fade of [960, 256]) {
    it(`crossfade linearly over ${fade} frames with one, from where the two agree best (within 250 ms)`, () => {
      const out = play(clips('old'), { type: 'clips', num: 1, clips: clips('new'), fade });
      // across it: old · (1 − λ) + new · λ, λ rising from its first frame, within 250 ms of when it was asked
      const { at: s0, error } = crossfadeIn(out, old, neu, fade, from);
      expect(error).toBeLessThan(1e-6);
      // before it: the old list, to the bit
      expect(bytes(out.subarray(0, s0)).equals(bytes(old.subarray(0, s0)))).toBe(true);
      // where they agree: as well as anywhere it could have started, or well enough
      const win = Math.min(fade, 0.03 * SR);
      let best = Number.NEGATIVE_INFINITY;
      for (let d = from; d <= from + 0.25 * SR; d += 7) best = Math.max(best, agreement(old, neu, d, win));
      expect(agreement(old, neu, s0, win)).toBeGreaterThan(Math.min(0.9, best) - 0.05);
      // after it: the new list (to the bit from the block after it ends)
      const blockAfter = Math.ceil((s0 + fade) / BLOCK) * BLOCK;
      for (let i = s0 + fade; i < blockAfter; i++) expect(out[i]).toBeCloseTo(neu[i] as number, 7);
      expect(bytes(out.subarray(blockAfter)).equals(bytes(neu.subarray(blockAfter)))).toBe(true);
    });
  }

  it('pass unheard where the two are the same sound there', () => {
    // the new list the old one but for a stretch long after the playhead (a patch elsewhere)
    const later = [
      { ...(clips('old')[0] as ClipSpec), end: SR, regionEnd: SR * 2 },
      { ...(clips('new')[0] as ClipSpec), start: SR, source: SR, regionStart: 0 },
    ];
    const out = play(clips('old'), { type: 'clips', num: 1, clips: later, fade: 960 });
    // (both lists play the same frames through it: the same within rounding)
    expect(same(out, old, 0)).toBe(true);
  });

  it('wait, coming while a crossfade is under way, for it to end: nothing sounding is cut short', () => {
    const fade = 960;
    const mid = clips('mid');
    const sung = { mid: tone(275, 0.35) };
    // a third list a block into the first crossfade
    const out = play(
      clips('old'),
      { type: 'clips', num: 1, clips: mid, fade },
      { [AT + 1]: [{ type: 'clips', num: 1, clips: clips('new'), fade }] },
      sung,
    );
    const first = play(clips('old'), { type: 'clips', num: 1, clips: mid, fade }, {}, sung);
    const m = play(clips('mid'), undefined, {}, sung);
    // the first crossfade plays out whole, to the bit
    const s1 = crossfadeIn(first, old, m, fade, from).at;
    const end = Math.ceil((s1 + fade) / BLOCK) * BLOCK;
    expect(bytes(out.subarray(0, end)).equals(bytes(first.subarray(0, end)))).toBe(true);
    // then the second, from the block it ended in, where those two agree, to the new list alone
    const second = crossfadeIn(out, m, neu, fade, end - BLOCK);
    expect(second.error).toBeLessThan(1e-6);
    expect(second.at).toBeGreaterThanOrEqual(s1 + fade);
    const after = Math.ceil((second.at + fade) / BLOCK) * BLOCK;
    expect(bytes(out.subarray(after)).equals(bytes(neu.subarray(after)))).toBe(true);
  });

  it('take over at once with the song stopped (nothing sounds to fade from)', () => {
    const out = play(clips('old'), undefined, {
      2: [
        { type: 'stop' },
        { type: 'clips', num: 1, clips: clips('new'), fade: 960 },
        { type: 'play', frame: 0, record: false, countIn: 0 },
      ],
    });
    const fresh = play(clips('new'));
    expect(bytes(out.subarray(3 * BLOCK, 20 * BLOCK)).equals(bytes(fresh.subarray(BLOCK, 18 * BLOCK)))).toBe(true);
  });

  it('crossfade a held note into itself retuned without a dip or a click, where at once it would cancel', () => {
    // a note and the same note 25 cents up (Correct Pitch on a held note), their phases opposite
    // where the crossfade is asked for
    const hz = 330;
    const up = hz * 2 ** (25 / 1200);
    const opposite = Math.PI - 2 * Math.PI * (up - hz) * (from / SR);
    const note = (f: number, phase: number) =>
      Float32Array.from({ length: SR * 2 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * f * i) / SR + phase));
    const sung = { a: note(hz, 0), b: note(up, opposite) };
    const fade = 960;
    const out = play(clips('a'), { type: 'clips', num: 1, clips: clips('b'), fade }, {}, sung);
    const a = play(clips('a'), undefined, {}, sung);
    const b = play(clips('b'), undefined, {}, sung);
    // the level through it (5 ms RMS) never below 3 dB under the note's
    const rms = (x: Float32Array, at: number) => {
      let e = 0;
      for (let i = at; i < at + 240; i++) e += (x[i] as number) ** 2;
      return Math.sqrt(e / 240);
    };
    const s0 = crossfadeIn(out, a, b, fade, from).at;
    let low = Number.POSITIVE_INFINITY;
    for (let i = s0 - 240; i < s0 + fade + 240; i += 24) low = Math.min(low, rms(out, i));
    expect(20 * Math.log10(low / rms(a, s0))).toBeGreaterThan(-3);
    // where it was asked for, it would have dipped to nothing
    let dip = Number.POSITIVE_INFINITY;
    const mixed = a.map((v, i) => {
      const k = i - from + 1;
      const l = k <= 0 ? 0 : k >= fade ? 1 : k / fade;
      return v * (1 - l) + (b[i] as number) * l;
    });
    for (let i = from - 240; i < from + fade + 240; i += 24) dip = Math.min(dip, rms(mixed, i));
    expect(20 * Math.log10(dip / rms(a, from))).toBeLessThan(-10);
    // and no click either way, against the note before it and the note after
    const before = a.slice().fill(Number.NaN, s0 + fade);
    const after = b.slice().fill(Number.NaN, 0, s0);
    expect(findClicks(out, SR, [before, after])).toEqual([]);
  });

  it('allocate nothing: finding where to start, crossfading, and one waiting its turn', () => {
    const p = song();
    const core = new EngineCore(SR, (m) => {
      if (m.type === 'error') throw new Error(m.message);
    });
    const segments = compileTempo(p, SR);
    core.receive({ type: 'init', ring: null, meters: null, transport: null });
    core.receive({ type: 'tempo', segments, ppq: PPQ, ...meterTicks(p) });
    core.receive({ type: 'audio', key: 'old', channels: [tone(220, 0.4)] });
    core.receive({ type: 'audio', key: 'new', channels: [tone(330, 0.3)] });
    core.receive({ type: 'graph', graph: compileGraph(p, () => 1, segments) });
    core.receive({
      type: 'sequence',
      num: 1,
      events: compileTrack(p.tracks[0] as Project['tracks'][number], segments),
    });
    core.receive({ type: 'clips', num: 1, clips: clips('old') });
    core.receive({ type: 'play', frame: 0, record: false, countIn: 0 });
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    for (let b = 0; b < 4; b++) core.process(l, r, undefined, b * BLOCK);
    const swaps: ToWorklet[] = [
      { type: 'clips', num: 1, clips: clips('new'), fade: 960 },
      { type: 'clips', num: 1, clips: clips('old'), fade: 960 },
    ];
    const saved = [globalThis.Float32Array, globalThis.Float64Array, globalThis.Array, globalThis.Map, globalThis.Set];
    const refuse = () => {
      throw new Error('allocated while playing');
    };
    let heard = 0;
    try {
      Object.assign(globalThis, {
        Float32Array: refuse,
        Float64Array: refuse,
        Array: refuse,
        Map: refuse,
        Set: refuse,
      });
      for (let b = 4; b < 200; b++) {
        if (b === 10) core.receive(swaps[0] as ToWorklet);
        if (b === 11) core.receive(swaps[1] as ToWorklet);
        core.process(l, r, undefined, b * BLOCK);
        for (let i = 0; i < BLOCK; i++) heard = Math.max(heard, Math.abs(l[i] as number));
      }
    } finally {
      const [f32, f64, arr, map, set] = saved;
      Object.assign(globalThis, { Float32Array: f32, Float64Array: f64, Array: arr, Map: map, Set: set });
    }
    expect(heard).toBeGreaterThan(0.1);
  });

  it('fade to no clips at all, and from none at once', () => {
    const out = play(clips('old'), { type: 'clips', num: 1, clips: [], fade: 256 });
    // (silence agrees with anything as well as anything: at once)
    const s0 = from;
    for (let k = 0; k < 256; k++) expect(out[s0 + k]).toBeCloseTo((old[s0 + k] as number) * (1 - (k + 1) / 256), 6);
    expect(out.subarray(s0 + 256).every((x) => x === 0)).toBe(true);
    const back = play([], { type: 'clips', num: 1, clips: clips('new'), fade: 256 });
    expect(bytes(back.subarray(from)).equals(bytes(neu.subarray(from)))).toBe(true);
  });
});
