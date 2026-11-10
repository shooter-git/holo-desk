import { describe, expect, it } from 'vitest';
import { createEffect, type Effect, type Host } from '../src/fx.ts';
import type { SamplerSpec } from '../src/protocol.ts';
import { detectHits, hitVelocity, kitSource } from '../src/replacer.ts';

const SR = 48000;

/** A kick of known strength: a 60 Hz body that dies away, from its very first frame. */
const KICKS: { at: number; amp: number }[] = [
  { at: 0.25, amp: 0.9 },
  { at: 0.75, amp: 0.5 },
  { at: 1.25, amp: 0.25 },
  { at: 1.5, amp: 0.7 },
  { at: 2.0, amp: 0.12 },
  { at: 2.4, amp: 0.35 },
  { at: 2.9, amp: 0.05 },
];

function drumTrack(seconds = 3.2): Float32Array {
  const x = new Float32Array(Math.round(SR * seconds));
  for (const k of KICKS) {
    const start = Math.round(k.at * SR);
    for (let i = 0; start + i < x.length; i++) {
      const t = i / SR;
      x[start + i] = (x[start + i] as number) + Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t / 0.15) * k.amp;
    }
  }
  return x;
}

/**
 * The velocity a hit should get: the track's loudest in its first four milliseconds (a soft hit on a
 * loud one's tail is louder than it was struck), in decibels above the threshold toward full scale.
 */
function expected(track: Float32Array, at: number, threshold = -30): number {
  let peak = 0;
  for (let i = Math.round(at * SR); i < Math.round((at + 0.0042) * SR); i++)
    peak = Math.max(peak, Math.abs(track[i] as number));
  return Math.max(1, Math.round((127 * (20 * Math.log10(peak) - threshold)) / -threshold));
}

/** A kit of one click: where it's played is where its sound starts, to the frame. */
const CLICK: SamplerSpec = {
  key: 'test/click',
  zones: [
    {
      left: Float32Array.from({ length: 64 }, (_, i) => (i < 8 ? 1 : 0)),
      right: null,
      root: 36,
      lo: 0,
      hi: 127,
      lovel: 1,
      hivel: 127,
      gain: 1,
      loopStart: 0,
      loopEnd: 0,
      rr: 0,
    },
  ],
  release: 0.01,
  oneShot: true,
  pitched: false,
  velocityRange: 0,
  attack: 0,
};

const host = (extra: Partial<Host> = {}): Host => ({
  sr: SR,
  lowLatency: false,
  beatSeconds: () => 0.5,
  impulse: () => undefined,
  songFrame: () => 0,
  clip: () => undefined,
  sampler: (key) => (key === CLICK.key ? CLICK : undefined),
  ...extra,
});

function through(e: Effect, l: Float32Array): [Float32Array, Float32Array] {
  const a = l.slice();
  const b = l.slice();
  for (let at = 0; at < a.length; at += 128) {
    const n = Math.min(128, a.length - at);
    e.process(a.subarray(at, at + n), b.subarray(at, at + n), n);
  }
  return [a, b];
}

/** Where a signal starts after each quiet stretch: the frames it rises past a level from silence. */
function onsets(x: Float32Array, level = 0.05, gap = SR / 20): number[] {
  const out: number[] = [];
  let last = -gap;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i] as number) > level) {
      if (i - last >= gap) out.push(i);
      last = i;
    }
  }
  return out;
}

const PARAMS = { threshold: -30, sensitivity: 50, hold: 50, dynamics: 100, curve: 0 };

describe('Drum Replacer', () => {
  it('hears every hit of a drum track where it began, as hard as it was', () => {
    const track = drumTrack();
    const hits = detectHits([track], SR, PARAMS);
    expect(hits.map((h) => h.frame / SR)).toHaveLength(KICKS.length);
    hits.forEach((h, i) => {
      const k = KICKS[i] as (typeof KICKS)[number];
      expect(Math.abs(h.frame / SR - k.at)).toBeLessThan(0.001);
      expect(Math.abs(h.velocity - expected(track, k.at))).toBeLessThanOrEqual(3);
    });
  });

  it('leaves out what is under the threshold, and what comes too soon after a hit', () => {
    const quiet = detectHits([drumTrack()], SR, { ...PARAMS, threshold: -20 });
    expect(quiet.length).toBe(KICKS.filter((k) => 20 * Math.log10(k.amp) > -20).length);
    // a retrigger longer than the gaps: the kick 0.25 s after another is passed over
    const slow = detectHits([drumTrack()], SR, { ...PARAMS, hold: 300 });
    expect(slow.map((h) => Math.round((h.frame / SR) * 100) / 100)).not.toContain(1.5);
  });

  it('turns levels into velocities through its dynamics and curve', () => {
    expect(hitVelocity(1, PARAMS)).toBe(127);
    expect(hitVelocity(10 ** (-15 / 20), PARAMS)).toBe(64);
    // no dynamics: every hit at full; a curve above 0 keeps the soft ones softer
    expect(hitVelocity(10 ** (-15 / 20), { ...PARAMS, dynamics: 0 })).toBe(127);
    expect(hitVelocity(10 ** (-15 / 20), { ...PARAMS, curve: 50 })).toBe(32);
    expect(hitVelocity(10 ** (-15 / 20), { ...PARAMS, curve: -50 })).toBeGreaterThan(80);
  });

  it('plays its kit right on each hit, the track held back by its look-ahead', () => {
    const e = createEffect('replacer', host());
    if (!e) throw new Error('replacer');
    e.setParams({ ...PARAMS, mix: 100 }, { kit: CLICK.key });
    const look = Math.round(0.005 * SR);
    expect(e.latency).toBe(look);
    const [l] = through(e, drumTrack());
    const heard = onsets(l, 0.001);
    expect(heard).toHaveLength(KICKS.length);
    heard.forEach((at, i) => {
      expect(Math.abs((at - look) / SR - (KICKS[i] as (typeof KICKS)[number]).at)).toBeLessThan(0.001);
    });
  });

  it('in Low Latency Mode holds nothing back, and plays each hit as soon as it has been measured', () => {
    const e = createEffect('replacer', host({ lowLatency: true }));
    if (!e) throw new Error('replacer');
    e.setParams({ ...PARAMS, mix: 100 }, { kit: CLICK.key });
    expect(e.latency).toBe(0);
    const heard = onsets(through(e, drumTrack())[0], 0.001);
    heard.forEach((at, i) => {
      const late = at / SR - (KICKS[i] as (typeof KICKS)[number]).at;
      expect(late).toBeGreaterThan(0.002);
      expect(late).toBeLessThan(0.0055);
    });
  });

  it('blends the recording with the kit, and keeps the recording alone with the mix down', () => {
    const x = drumTrack();
    const e = createEffect('replacer', host());
    if (!e) throw new Error('replacer');
    e.setParams({ ...PARAMS, mix: 0 }, { kit: CLICK.key });
    const look = e.latency ?? 0;
    const [dry] = through(e, x);
    for (let i = look; i < x.length; i += 97) expect(dry[i]).toBe(x[i - look]);
    e.setParams({ ...PARAMS, mix: 50 }, { kit: CLICK.key });
    e.reset();
    const [both] = through(e, x);
    // both at full: the recording, and the click on top of it
    const at = Math.round((KICKS[0] as (typeof KICKS)[number]).at * SR) + look;
    let click = 0;
    for (let i = at - 4; i < at + 12; i++) click = Math.max(click, (both[i] as number) - (x[i - look] as number));
    expect(click).toBeGreaterThan(0.5);
  });

  it('stops what it plays on panic, and plays the built-in kit without a pack', () => {
    const e = createEffect('replacer', host());
    if (!e) throw new Error('replacer');
    e.setParams({ ...PARAMS, mix: 100 });
    const x = drumTrack(0.6);
    const a = x.slice();
    const b = x.slice();
    for (let at = 0; at < 0.3 * SR; at += 128) e.process(a.subarray(at, at + 128), b.subarray(at, at + 128), 128);
    expect(Math.max(...a.subarray(0.25 * SR, 0.3 * SR).map(Math.abs))).toBeGreaterThan(0.05);
    e.silence?.();
    const tail = new Float32Array(0.1 * SR);
    for (let at = 0; at < tail.length; at += 128) e.process(tail.subarray(at, at + 128), tail.slice(at, at + 128), 128);
    expect(Math.max(...tail.subarray(0.05 * SR).map(Math.abs))).toBeLessThan(1e-4);
    expect(kitSource('')).toEqual({ kind: 'synth', preset: 'Drum Synth' });
    expect(kitSource('synth:Punch Machine')).toEqual({ kind: 'synth', preset: 'Punch Machine' });
    expect(kitSource('drums/Studio Kit')).toEqual({ kind: 'pack', key: 'drums/Studio Kit' });
  });

  it('waits for a pack kit that has not loaded, and picks it up when it comes', () => {
    let loaded = false;
    const e = createEffect('replacer', host({ sampler: (key) => (loaded && key === CLICK.key ? CLICK : undefined) }));
    if (!e) throw new Error('replacer');
    e.setParams({ ...PARAMS, mix: 100 }, { kit: CLICK.key });
    const [before] = through(e, drumTrack());
    expect(before.every((v) => v === 0)).toBe(true);
    loaded = true;
    e.refresh?.();
    e.reset();
    expect(onsets(through(e, drumTrack())[0], 0.001)).toHaveLength(KICKS.length);
  });
});
