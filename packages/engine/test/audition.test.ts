import { newAudioTrack, newProject, PPQ, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { findClicks } from '../src/analysis/clicks.ts';
import { compileGraph, compileTempo, compileTrack, meterTicks } from '../src/compile.ts';
import { EngineCore } from '../src/core.ts';
import type { ClipSpec, ToWorklet } from '../src/protocol.ts';

// An audition: a stretch of held audio heard once, now, through a track's channel, while the song is
// stopped (the Notes view's press on a note), taking over from the one before without a click, never
// allocating.

const SR = 48000;
const BLOCK = 128;
/** Frames a replaced audition fades out over, and one following it fades in over (10 ms). */
const FADE = 480;

/** A second of a tone. */
const tone = (hz: number, level: number) =>
  Float32Array.from({ length: SR }, (_, i) => level * Math.sin((2 * Math.PI * hz * i) / SR));

/** A song of one audio track: no plugins, no buses, so the mix is the track's sound at its fader. */
function song(volume = 0): Project {
  const p = newProject('Audition');
  p.buses = [];
  p.master.inserts = [];
  const t = { ...newAudioTrack('Vocal'), id: 'trk_v' };
  t.channel.sends = [];
  t.channel.volume = volume;
  p.tracks = [t];
  return p;
}

/** One piece of `key` from its frame `source`, `length` frames, joined to nothing either side (no ramps). */
const piece = (key: string, source: number, length: number, gain = 1, start = 0): ClipSpec => ({
  key,
  start,
  end: start + length,
  source,
  regionStart: start,
  regionEnd: start + length,
  gain,
  fadeIn: 0,
  fadeOut: 0,
  seamIn: true,
  seamOut: true,
});

const audition = (clips: ClipSpec[], follow = false): ToWorklet => ({
  type: 'audition',
  num: 1,
  clips,
  ...(follow ? { follow } : {}),
});

/** An engine with the song and two recordings, stopped at its start. */
function engine(p = song()): EngineCore {
  const core = new EngineCore(SR, (m) => {
    if (m.type === 'error') throw new Error(m.message);
  });
  const segments = compileTempo(p, SR);
  core.receive({ type: 'init', ring: null, meters: null, transport: null });
  core.receive({ type: 'tempo', segments, ppq: PPQ, ...meterTicks(p) });
  core.receive({ type: 'audio', key: 'rec', channels: [tone(220, 0.4)] });
  core.receive({ type: 'audio', key: 'patch', channels: [tone(330, 0.3), tone(331, 0.2)] });
  core.receive({ type: 'graph', graph: compileGraph(p, () => 1, segments) });
  core.receive({ type: 'sequence', num: 1, events: compileTrack(p.tracks[0] as Project['tracks'][number], segments) });
  return core;
}

/** `blocks` blocks played (left and right), each message sent before the block it's keyed by. */
function play(core: EngineCore, blocks: number, at: Record<number, ToWorklet[]> = {}): [Float32Array, Float32Array] {
  const outL = new Float32Array(blocks * BLOCK);
  const outR = new Float32Array(blocks * BLOCK);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let b = 0; b < blocks; b++) {
    for (const m of at[b] ?? []) core.receive(m);
    core.process(l, r, undefined, b * BLOCK);
    outL.set(l, b * BLOCK);
    outR.set(r, b * BLOCK);
  }
  return [outL, outR];
}

const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('an audition', () => {
  it('plays the frames of the audio held, through the channel, with the song stopped', () => {
    const rec = tone(220, 0.4);
    const [l, r] = play(engine(), 20, { 2: [audition([piece('rec', 1000, 1200, 0.5)])] });
    // nothing before it; then the recording from frame 1000, at the piece's gain (a centred, unity channel
    // passes it as it is, to both sides)
    expect(peak(l.subarray(0, 2 * BLOCK))).toBe(0);
    let worst = 0;
    for (let i = 0; i < 1200; i++) {
      worst = Math.max(worst, Math.abs((l[2 * BLOCK + i] as number) - (rec[1000 + i] as number) * 0.5));
      worst = Math.max(worst, Math.abs((r[2 * BLOCK + i] as number) - (rec[1000 + i] as number) * 0.5));
    }
    expect(worst).toBeLessThan(1e-6);
    // and nothing once it's played through
    expect(peak(l.subarray(2 * BLOCK + 1200))).toBe(0);
  });

  it('sounds as the song would through the same channel: its fader, its pieces, a patch’s two sides', () => {
    const p = song(-6);
    // a recording's piece, then a patch's (stereo), joined at a seam, as compileClips lays them out
    const clips = [
      { ...piece('rec', 4000, 900), seamOut: true as const },
      { ...piece('patch', 200, 1100, 1, 900), base: 'rec', at: 4900, seamIn: true as const },
    ];
    const heard = play(engine(p), 20, { 0: [audition(clips)] });
    // the song playing the same pieces from its frame 0
    const sung = play(engine(p), 20, {
      0: [
        { type: 'clips', num: 1, clips },
        { type: 'play', frame: 0, record: false, countIn: 0 },
      ],
    });
    expect(peak(heard[0])).toBeGreaterThan(0.1);
    expect(Buffer.from(heard[0].buffer).equals(Buffer.from(sung[0].buffer))).toBe(true);
    expect(Buffer.from(heard[1].buffer).equals(Buffer.from(sung[1].buffer))).toBe(true);
  });

  it('stops when another takes over, fading out over 10 ms', () => {
    const first = [piece('rec', 0, SR / 2)];
    const second = [piece('patch', 0, SR / 4)];
    const AT = 10;
    const [both] = play(engine(), 40, { 0: [audition(first)], [AT]: [audition(second)] });
    const [alone] = play(engine(), 40, { [AT]: [audition(second)] });
    const [old] = play(engine(), 40, { 0: [audition(first)] });
    const from = AT * BLOCK;
    // across the fade: the new one, plus the old one going down linearly
    for (let o = 0; o < FADE; o++) {
      const want = (alone[from + o] as number) + (old[from + o] as number) * ((FADE - o) / FADE);
      expect(Math.abs((both[from + o] as number) - want)).toBeLessThan(1e-6);
    }
    // then the new one alone, to the bit
    const after = both.subarray(from + FADE);
    expect(Buffer.from(after.slice().buffer).equals(Buffer.from(alone.subarray(from + FADE).slice().buffer))).toBe(
      true,
    );
  });

  it('takes over from a held note without a click (where 64 frames, as it once did, click)', () => {
    // a held note (a tone with a little vibrato) heard, then heard again from its top part way in
    const held = Float32Array.from({ length: SR }, (_, i) => {
      const t = i / SR;
      return 0.3 * Math.sin(2 * Math.PI * 330 * t + 0.4 * Math.sin(2 * Math.PI * 5.5 * t));
    });
    const lead = 1440; // its audition starts 30 ms before the note, out of silence
    const sung = new Float32Array(SR + lead);
    sung.set(held, lead);
    const core = engine();
    core.receive({ type: 'audio', key: 'held', channels: [sung] });
    const top = [{ ...piece('held', 0, SR / 2), fadeIn: 480 }];
    const AT = 120;
    const [out] = play(core, 200, { 0: [audition(top)], [AT]: [audition(top)] });
    // what it should sound like: the note from its top, and again from its top at the takeover
    const first = new Float32Array(out.length).fill(Number.NaN);
    const again = new Float32Array(out.length).fill(Number.NaN);
    for (let i = 0; i < out.length; i++) {
      if (i < AT * BLOCK + FADE) first[i] = sung[i] ?? 0;
      if (i >= AT * BLOCK - FADE) again[i] = sung[i - AT * BLOCK] ?? 0;
    }
    expect(findClicks(out, SR, [first, again])).toEqual([]);
    // the same takeover cut over 64 frames is found
    const cut = out.slice();
    for (let o = 0; o < FADE; o++) {
      const k = AT * BLOCK + o;
      const g = o < 64 ? (64 - o) / 64 : 0;
      cut[k] = (sung[k] as number) * g + ((sung[k - AT * BLOCK] as number) || 0);
    }
    const found = findClicks(cut, SR, [first, again]);
    expect(found.length).toBeGreaterThan(0);
    expect(Math.abs((found[0] as { frame: number }).frame - AT * BLOCK)).toBeLessThan(200);
  });

  it('follows the one sounding when asked: from where it has got to, crossfading', () => {
    const first = [piece('rec', 0, SR / 2)];
    const edited = [piece('patch', 0, SR / 2)];
    const AT = 10;
    const [out] = play(engine(), 40, { 0: [audition(first)], [AT]: [audition(edited, true)] });
    const rec = tone(220, 0.4);
    const patch = tone(330, 0.3);
    const from = AT * BLOCK;
    for (let o = 0; o < FADE + 200; o++) {
      const g = o < FADE ? o / FADE : 1;
      // (the new one from the frame the old one had got to, not from its top)
      const want = (rec[from + o] as number) * (1 - g) + (patch[from + o] as number) * g;
      expect(Math.abs((out[from + o] as number) - want)).toBeLessThan(1e-6);
    }
    // and from its top when nothing is sounding
    const [fresh] = play(engine(), 20, { 2: [audition(edited, true)] });
    expect(Math.abs((fresh[2 * BLOCK + 300] as number) - (patch[300] as number))).toBeLessThan(1e-6);
  });

  it('waits for a takeover’s fade to end before the next takes over, so nothing is cut short', () => {
    const a = [piece('rec', 0, SR / 2)];
    const b = [piece('patch', 0, SR / 2)];
    // (from the tone's start: a piece with no fades of its own starts at nought)
    const c = [piece('rec', 0, SR / 4)];
    // the third comes a block into the second's takeover: it waits for the fade, then takes over
    const [out] = play(engine(), 60, { 0: [audition(a)], 10: [audition(b)], 11: [audition(c)] });
    const [ab] = play(engine(), 60, { 0: [audition(a)], 10: [audition(b)] });
    const waited = Math.ceil((10 * BLOCK + FADE) / BLOCK) * BLOCK;
    expect(
      Buffer.from(out.subarray(0, waited).slice().buffer).equals(Buffer.from(ab.subarray(0, waited).slice().buffer)),
    ).toBe(true);
    // no step anywhere beyond the tones' own and a fade's
    let step = 0;
    for (let i = 1; i < out.length; i++) step = Math.max(step, Math.abs((out[i] as number) - (out[i - 1] as number)));
    expect(step).toBeLessThan(0.05);
  });

  it('stops with an empty list, and when the song starts playing', () => {
    const long = [piece('rec', 0, SR / 2)];
    const [stopped] = play(engine(), 20, { 0: [audition(long)], 5: [audition([])] });
    expect(peak(stopped.subarray(5 * BLOCK + FADE))).toBe(0);
    const [played] = play(engine(), 20, {
      0: [audition(long)],
      5: [{ type: 'play', frame: 0, record: false, countIn: 0 }],
    });
    // (the track has no clips: once the old sound has faded, the song is silent)
    expect(peak(played.subarray(5 * BLOCK + FADE))).toBe(0);
    expect(peak(played.subarray(0, 5 * BLOCK))).toBeGreaterThan(0.1);
    // and one sent while the song plays isn't heard
    const [during] = play(engine(), 20, {
      0: [{ type: 'play', frame: 0, record: false, countIn: 0 }],
      2: [audition(long)],
    });
    expect(peak(during)).toBe(0);
  });

  it('wakes a track that rests (as strips do, playing live)', () => {
    const core = engine();
    core.rest = true;
    // long enough for the empty track to fall asleep first
    const [l] = play(core, 2000, { 1900: [audition([piece('rec', 0, 2000)])] });
    expect(peak(l.subarray(1900 * BLOCK, 1900 * BLOCK + 2000))).toBeGreaterThan(0.1);
  });

  it('is played by the audio thread only, not by a worker rendering ahead', () => {
    // (a worker: the 'init' of one rendering ahead makes it one; here, as a worker sees it)
    const core = engine();
    (core as unknown as { split: { self: number } }).split = { self: 0 } as never;
    core.receive(audition([piece('rec', 0, 2000)]));
    const t = (core as unknown as { tracks: Map<number, { audition: unknown }> }).tracks.get(1);
    expect(t?.audition).toBeNull();
  });

  it('allocates nothing while it plays', () => {
    const core = engine();
    play(core, 4);
    core.receive(audition([piece('rec', 100, 3000), { ...piece('patch', 0, 3000, 1, 3000), base: 'rec', at: 3100 }]));
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
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
      for (let b = 0; b < 60; b++) {
        if (b === 30) core.receive(audition([piece('rec', 0, 2000)]));
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
