import { type ParamDef, PLUGINS } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { prepareImpulse } from '../src/convolver.ts';
import { createEffect, type Host } from '../src/fx.ts';
import { generateSpace } from '../src/spaces.ts';

const SR = 48000;
const host = (lowLatency: boolean): Host => ({
  sr: SR,
  lowLatency,
  beatSeconds: () => 0.5,
  impulse: () => undefined,
  songFrame: () => 0,
  clip: () => undefined,
});

/** Plucked chords with silence between: what a track gives its plugins. */
function music(seconds: number): [Float32Array, Float32Array] {
  const n = SR * seconds;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const k = Math.floor(t / 0.5);
    const tt = t - k * 0.5;
    const env = tt < 0.3 ? Math.exp(-tt * 8) : 0;
    const f = [220, 277, 330, 440][k % 4] as number;
    l[i] = (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 1.5 * t)) * env * 0.5;
    r[i] = (l[i] as number) * 0.8;
  }
  return [l, r];
}

/** Runs a chain over the signal 128 frames at a time; the loudest output sample and the lowest gain reduction. */
function run(types: string[], lowLatency: boolean, params: Record<string, Record<string, number>> = {}) {
  const fx = types.map((t) => {
    const e = createEffect(t, host(lowLatency));
    if (!e) throw new Error(t);
    e.setParams(params[t] ?? {});
    return e;
  });
  const [l, r] = music(4);
  let peak = 0;
  let finite = true;
  const gr: Record<string, number> = {};
  for (let at = 0; at < l.length; at += 128) {
    const bl = l.subarray(at, at + 128);
    const br = r.subarray(at, at + 128);
    fx.forEach((e, i) => {
      e.process(bl, br, bl.length);
      gr[types[i] as string] = Math.min(gr[types[i] as string] ?? 0, e.gr);
    });
    for (let i = 0; i < bl.length; i++) {
      const v = Math.abs(bl[i] as number);
      if (!Number.isFinite(v)) finite = false;
      if (v > peak) peak = v;
    }
  }
  return { peak, finite, gr };
}

const audioFx = PLUGINS.filter((p) => p.kind === 'audio').map((p) => p.type);

describe('audio effects', () => {
  for (const lowLatency of [false, true]) {
    for (const type of audioFx) {
      it(`${type} stays finite and sensible${lowLatency ? ' (Low Latency Mode)' : ''}`, () => {
        const { peak, finite, gr } = run([type], lowLatency);
        expect(finite).toBe(true);
        expect(peak).toBeLessThan(4);
        expect(gr[type]).toBeGreaterThan(-40);
      });
    }
  }

  it('a whole chain, as the plugin tour has it', () => {
    const chain = ['eq', 'compressor', 'gate', 'saturator', 'chorus', 'delay', 'reverb', 'limiter'];
    for (const lowLatency of [false, true]) {
      const { peak, finite, gr } = run(chain, lowLatency, { eq: { b1Gain: 4, b2Gain: -5, b3Gain: 3, hpOn: 1 } });
      expect(finite).toBe(true);
      expect(peak).toBeLessThan(1.01);
      expect(gr.limiter).toBeGreaterThan(-24);
    }
  });
});

describe('a setting moved on its own', () => {
  // (a small room for the spaces, whatever they ask for)
  const room = prepareImpulse(generateSpace('room', 1, 0.3, SR));
  const withRoom: Host = { ...host(false), impulse: () => room, loopRange: () => null };
  const moving = PLUGINS.filter((p) => p.kind === 'audio' && createEffect(p.type, withRoom)?.setParam);
  for (const def of moving) {
    it(`tunes ${def.type} as the whole set does, to the byte`, () => {
      const whole = createEffect(def.type, withRoom);
      const one = createEffect(def.type, withRoom);
      if (!whole || !one?.setParam) throw new Error(def.type);
      const params: Record<string, number> = Object.fromEntries(def.params.map((p) => [p.id, p.default]));
      if (def.type === 'peq') Object.assign(params, { t1: 1, f1: 80, t2: 3, f2: 900, g2: -5, t3: 6, f3: 8000, g3: 3 });
      whole.setParams(params);
      one.setParams(params);
      const [l, r] = music(3);
      const l2 = l.slice();
      const r2 = r.slice();
      // every setting in turn, from the first to the last, as lanes move them
      let seed = 5;
      const next = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      const movable = def.params.filter((p) => !['space', 'seed', 'decay', 'generations'].includes(p.id));
      for (let at = 0, k = 0; at < l.length; at += 128, k++) {
        if (k % 7 === 3) {
          const p = movable[k % movable.length] as ParamDef;
          let v = p.min + next() * (p.max - p.min);
          if (p.step) v = Math.round(v / p.step) * p.step;
          params[p.id] = v;
          whole.setParams(params);
          one.setParam(p.id, params);
        }
        whole.process(l.subarray(at, at + 128), r.subarray(at, at + 128), 128);
        one.process(l2.subarray(at, at + 128), r2.subarray(at, at + 128), 128);
        expect(whole.gr).toBe(one.gr);
      }
      expect(Buffer.from(l.buffer).equals(Buffer.from(l2.buffer))).toBe(true);
      expect(Buffer.from(r.buffer).equals(Buffer.from(r2.buffer))).toBe(true);
    });
  }
});
