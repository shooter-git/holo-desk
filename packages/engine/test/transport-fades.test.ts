import { newAudioTrack, newProject, PPQ, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { findClicks } from '../src/analysis/clicks.ts';
import { compileGraph, compileTempo, compileTrack, meterTicks } from '../src/compile.ts';
import { EngineCore, type EnginePost } from '../src/core.ts';
import type { ClipSpec, ToWorklet } from '../src/protocol.ts';

// Played live, the song fades where it stops or jumps: what was playing goes on from where it was for
// 15 ms, fading out, and a recording already under way where it lands fades in over the same. A
// bounce (the transport's fades off) cuts and starts at once, as it always has.

const SR = 48000;
const BLOCK = 128;
/** The transport's fade (15 ms). */
const FADE = 720;

/** A held note: harmonics falling 12 dB an octave, on a vibrato, four seconds of it. */
const held = (() => {
  let phase = 0;
  return Float32Array.from({ length: SR * 4 }, (_, i) => {
    phase += (2 * Math.PI * 220 * 2 ** ((0.3 * Math.sin((2 * Math.PI * 5.5 * i) / SR)) / 12)) / SR;
    let v = 0;
    for (let h = 1; h <= 10; h++) v += Math.sin(h * phase) / (h * h);
    return 0.3 * v;
  });
})();

/** A song of one audio track, no plugins, no buses: the mix is its clips. */
function song(): Project {
  const p = newProject('Transport');
  p.buses = [];
  p.master.inserts = [];
  const t = { ...newAudioTrack('Vocal'), id: 'trk_v' };
  t.channel.sends = [];
  p.tracks = [t];
  return p;
}

/** The held note from song frame `start` to `end`, its recording from frame `source`. */
const piece = (start: number, end: number, source = start): ClipSpec => ({
  key: 'held',
  start,
  end,
  source,
  regionStart: start,
  regionEnd: end,
  gain: 1,
  fadeIn: 0,
  fadeOut: 0,
});

/** An engine with the song and the note, its clips `clips`; the transport's fades on unless `fades` is false. */
function engine(clips: ClipSpec[], fades = true, post: EnginePost = () => {}): EngineCore {
  const p = song();
  const core = new EngineCore(SR, (m, transfer) => {
    if (m.type === 'error') throw new Error(m.message);
    post(m, transfer);
  });
  core.transportFades = fades;
  const segments = compileTempo(p, SR);
  core.receive({ type: 'init', ring: null, meters: null, transport: null });
  core.receive({ type: 'tempo', segments, ppq: PPQ, ...meterTicks(p) });
  core.receive({ type: 'audio', key: 'held', channels: [held] });
  core.receive({ type: 'graph', graph: compileGraph(p, () => 1, segments) });
  core.receive({ type: 'sequence', num: 1, events: compileTrack(p.tracks[0] as Project['tracks'][number], segments) });
  core.receive({ type: 'clips', num: 1, clips });
  return core;
}

/** `blocks` blocks played, the messages at each sent before it; the input `input` (a channel) if given. */
function play(core: EngineCore, blocks: number, at: Record<number, ToWorklet[]>, input?: Float32Array): Float32Array {
  const out = new Float32Array(blocks * BLOCK);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let b = 0; b < blocks; b++) {
    for (const m of at[b] ?? []) core.receive(m);
    const ins = input ? [input.subarray(b * BLOCK, (b + 1) * BLOCK)] : undefined;
    core.process(l, r, ins, b * BLOCK);
    out.set(l, b * BLOCK);
  }
  return out;
}

const start = (frame: number): ToWorklet => ({ type: 'play', frame, record: false, countIn: 0 });

/** The note as it plays from `from`, laid out from the frame `at` of the output (NaN elsewhere). */
function noteAt(length: number, at: number, from: number, to = length): Float32Array {
  const out = new Float32Array(length).fill(Number.NaN);
  for (let i = at; i < Math.min(length, to); i++) out[i] = held[from + (i - at)] ?? 0;
  return out;
}

describe('the transport’s fades, played live', () => {
  const AT = 40;
  const stopAt = AT * BLOCK;

  it('stop: what plays fades out over 15 ms from where it was, then nothing', () => {
    const out = play(engine([piece(0, SR * 4)]), 80, { 0: [start(SR)], [AT]: [{ type: 'stop' }] });
    for (let k = 0; k < FADE; k++) {
      const want = (held[SR + stopAt + k] as number) * (1 - (k + 1) / FADE);
      expect(Math.abs((out[stopAt + k] as number) - want)).toBeLessThan(1e-6);
    }
    expect(out.subarray(stopAt + FADE).every((v) => v === 0)).toBe(true);
    // no click, against the note going on (and nothing judged once it has faded)
    expect(findClicks(out, SR, [noteAt(out.length, 0, SR, stopAt + FADE)])).toEqual([]);
  });

  it('stop, without them (a bounce, or before): cut at once, a click', () => {
    const out = play(engine([piece(0, SR * 4)], false), 80, { 0: [start(SR)], [AT]: [{ type: 'stop' }] });
    expect(out.subarray(stopAt).every((v) => v === 0)).toBe(true);
    const clicks = findClicks(out, SR, [noteAt(out.length, 0, SR, stopAt + FADE)]);
    expect(clicks.some((c) => Math.abs(c.frame - stopAt) < 0.004 * SR)).toBe(true);
  });

  it('Stop pressed again (panic) silences what is still fading, at once', () => {
    const out = play(engine([piece(0, SR * 4)]), 80, {
      0: [start(SR)],
      [AT]: [{ type: 'stop' }],
      [AT + 1]: [{ type: 'panic' }],
    });
    expect(Math.abs(out[stopAt + 10] as number)).toBeGreaterThan(0);
    expect(out.subarray(stopAt + BLOCK).every((v) => v === 0)).toBe(true);
  });

  it('locate while playing: crossfades from where it was to where it lands', () => {
    const to = SR * 2;
    const out = play(engine([piece(0, SR * 4)]), 80, {
      0: [start(SR)],
      [AT]: [{ type: 'locate', frame: to }],
    });
    for (let k = 0; k < FADE; k++) {
      const lambda = (k + 1) / FADE;
      const want = (held[SR + stopAt + k] as number) * (1 - lambda) + (held[to + k] as number) * lambda;
      expect(Math.abs((out[stopAt + k] as number) - want)).toBeLessThan(1e-6);
    }
    // then where it landed, as it plays there
    for (let k = FADE; k < FADE + 1000; k++) expect(out[stopAt + k]).toBeCloseTo(held[to + k] as number, 6);
    const before = noteAt(out.length, 0, SR, stopAt + FADE);
    const after = noteAt(out.length, stopAt, to);
    after.fill(Number.NaN, 0, stopAt - 2000);
    expect(findClicks(out, SR, [before, after])).toEqual([]);
  });

  it('plays from a place in the middle of a recording faded in; one that starts there or later as it is', () => {
    const mid = play(engine([piece(0, SR * 4)]), 20, { 2: [start(SR)] });
    for (let k = 0; k < FADE; k++)
      expect(Math.abs((mid[2 * BLOCK + k] as number) - (held[SR + k] as number) * ((k + 1) / FADE))).toBeLessThan(1e-6);
    // a recording starting where it plays from: its own start, to the bit
    const own = play(engine([piece(SR, SR * 4, SR)]), 20, { 2: [start(SR)] });
    const plain = play(engine([piece(SR, SR * 4, SR)], false), 20, { 2: [start(SR)] });
    expect(Buffer.from(own.buffer).equals(Buffer.from(plain.buffer))).toBe(true);
  });

  it('around a cycle: what plays past its end fades out as its start fades in', () => {
    const c0 = SR;
    const c1 = SR + 30 * BLOCK + 50;
    const out = play(engine([piece(0, SR * 4)]), 80, {
      0: [{ type: 'cycle', on: true, start: c0, end: c1 }, start(c0)],
    });
    const jump = c1 - c0;
    for (let k = 0; k < FADE; k++) {
      const lambda = (k + 1) / FADE;
      const want = (held[c1 + k] as number) * (1 - lambda) + (held[c0 + k] as number) * lambda;
      expect(Math.abs((out[jump + k] as number) - want)).toBeLessThan(1e-6);
    }
    const before = noteAt(out.length, 0, c0, jump + FADE);
    const after = noteAt(out.length, jump, c0, 2 * jump);
    after.fill(Number.NaN, 0, jump - 2000);
    expect(
      findClicks(out.subarray(0, 2 * jump), SR, [before.subarray(0, 2 * jump), after.subarray(0, 2 * jump)]),
    ).toEqual([]);
    // without them (a loop rendered: its jump is the music's own), as ever
    const cut = play(engine([piece(0, SR * 4)], false), 80, {
      0: [{ type: 'cycle', on: true, start: c0, end: c1 }, start(c0)],
    });
    expect(cut[jump]).toBeCloseTo(held[c0] as number, 6);
  });

  it('locate while playing, another version’s clips just sent (an A/B’s next pass): it fades out what it played, and plays them where it lands at once', () => {
    const to = SR * 2;
    const other = { ...piece(0, SR * 4), source: 300 };
    // the version's clips come with a fade (a patch it has that the other hadn't), then the locate
    const out = play(engine([piece(0, SR * 4)]), 80, {
      0: [start(SR)],
      [AT]: [
        { type: 'clips', num: 1, clips: [other], fade: 960 },
        { type: 'locate', frame: to },
      ],
    });
    for (let k = 0; k < FADE; k++) {
      const lambda = (k + 1) / FADE;
      const want = (held[SR + stopAt + k] as number) * (1 - lambda) + (held[to + 300 + k] as number) * lambda;
      expect(Math.abs((out[stopAt + k] as number) - want)).toBeLessThan(1e-6);
    }
    for (let k = FADE; k < FADE + 1000; k++) expect(out[stopAt + k]).toBeCloseTo(held[to + 300 + k] as number, 6);
  });

  it('records a take that ends where Stop was pressed, faded or not', () => {
    const takes = (fades: boolean) => {
      const got: number[] = [];
      const core = engine([piece(0, SR * 4)], fades, (m) => {
        if (m.type === 'recorded') got.push(...(m.channels[0] as Float32Array));
      });
      const input = Float32Array.from({ length: 80 * BLOCK }, (_, i) => Math.sin(i * 0.05) * 0.2);
      play(
        core,
        80,
        {
          0: [
            { type: 'inputs', tracks: [{ num: 1, input: 0, channels: 1, monitor: false, record: true }] },
            { type: 'play', frame: SR, record: true, countIn: 0 },
          ],
          [AT]: [{ type: 'stop' }],
        },
        input,
      );
      return Float32Array.from(got);
    };
    const faded = takes(true);
    expect(faded.length).toBe(AT * BLOCK);
    expect(Buffer.from(faded.buffer).equals(Buffer.from(takes(false).buffer))).toBe(true);
  });

  it('allocates nothing as it fades: a stop, a locate, a cycle’s jump', () => {
    const core = engine([piece(0, SR * 4)]);
    play(core, 4, { 0: [{ type: 'cycle', on: true, start: SR, end: SR + 20 * BLOCK + 17 }, start(SR)] });
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    const saved = [globalThis.Float32Array, globalThis.Float64Array, globalThis.Array, globalThis.Map, globalThis.Set];
    const refuse = () => {
      throw new Error('allocated while playing');
    };
    const locate: ToWorklet = { type: 'locate', frame: SR + 500 };
    const stop: ToWorklet = { type: 'stop' };
    let heard = 0;
    try {
      Object.assign(globalThis, {
        Float32Array: refuse,
        Float64Array: refuse,
        Array: refuse,
        Map: refuse,
        Set: refuse,
      });
      for (let b = 4; b < 120; b++) {
        if (b === 50) core.receive(locate);
        if (b === 90) core.receive(stop);
        core.process(l, r, undefined, b * BLOCK);
        for (let i = 0; i < BLOCK; i++) heard = Math.max(heard, Math.abs(l[i] as number));
      }
    } finally {
      const [f32, f64, arr, map, set] = saved;
      Object.assign(globalThis, { Float32Array: f32, Float64Array: f64, Array: arr, Map: map, Set: set });
    }
    expect(heard).toBeGreaterThan(0.1);
  });
});
