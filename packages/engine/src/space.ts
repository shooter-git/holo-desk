/**
 * Space Designer: convolution with a space, generated from a design (spaces.ts) or read from a file
 * ("pack/name"), with pre-delay, the paths' cross-bleed, a low and a high cut on the wet sound, and
 * wet and dry levels. The response itself is prepared away from the audio thread and handed over by
 * key; until it arrives the plugin passes only its dry signal.
 */
import { paramValue, SPACE_FILE, SPACE_NAMES } from '@holo/session';
import { BLOCK, Convolver, type ImpulseResponse, type PreparedImpulse } from './convolver.ts';
import { Biquad, dbToGain } from './dsp.ts';
import { resample } from './resample.ts';
import type { DecodedAudio } from './wav.ts';

/** What a Space Designer needs, in the form the engine is handed it by. */
export type ImpulseSource =
  | { kind: 'space'; name: string; seed: number; decay: number }
  | { kind: 'file'; pack: string; name: string };

/**
 * The response a Space Designer's (or a Shimmer's) settings ask for, and the key it's handed over by
 * at a rate; `nextSeed` asks for another of the same kind (a Shimmer's later generations).
 */
export function impulseFor(
  params: Record<string, number>,
  settings: Record<string, string> | undefined,
  rate: number,
  type = 'space',
  nextSeed = 0,
): { key: string; source: ImpulseSource } | null {
  const v = (id: string) => paramValue(type, params, id);
  const space = Math.round(v('space'));
  if (space >= SPACE_FILE) {
    // a Shimmer's later generations may each have their own file (ir1, ir2…), else they play the first's
    const ir = (nextSeed > 0 ? settings?.[`ir${nextSeed}`] : undefined) || settings?.ir;
    const [pack, ...rest] = (ir ?? '').split('/');
    if (!pack || !rest.length) return null;
    return { key: `file:${ir}@${rate}`, source: { kind: 'file', pack, name: rest.join('/') } };
  }
  const name = SPACE_NAMES[space] ?? 'concert';
  const seed = Math.round(v('seed')) + nextSeed;
  const decay = Math.round(v('decay') * 1000) / 1000;
  return { key: `space:${name}:${seed}:${decay}@${rate}`, source: { kind: 'space', name, seed, decay } };
}

/** Every response a plugin plays, in its order (a Shimmer: its space, then one per generation). */
export function pluginImpulses(
  type: string,
  params: Record<string, number>,
  settings: Record<string, string> | undefined,
  rate: number,
): { key: string; source: ImpulseSource }[] {
  if (type === 'space') {
    const one = impulseFor(params, settings, rate);
    return one ? [one] : [];
  }
  if (type !== 'shimmer') return [];
  const out: { key: string; source: ImpulseSource }[] = [];
  const gens = Math.round(paramValue('shimmer', params, 'generations'));
  for (let g = 0; g <= gens; g++) {
    const one = impulseFor(params, settings, rate, 'shimmer', g);
    if (one) out.push(one);
  }
  return out;
}

/** A decoded file as a response: four channels are LL, RR, LR, RL; two, a stereo pair; one, both sides. */
export function impulseFromAudio(audio: DecodedAudio, rate: number): ImpulseResponse {
  const ch = audio.channels.map((c) => (audio.rate === rate ? c : resample(c, audio.rate, rate)));
  const [a, b, c, d] = ch;
  if (!a) throw new Error('An impulse response with no audio');
  if (ch.length >= 4) return { rate, ll: a, rr: b as Float32Array, lr: c as Float32Array, rl: d as Float32Array };
  if (ch.length >= 2) return { rate, ll: a, rr: b as Float32Array, lr: null, rl: null };
  return { rate, ll: a, rr: a, lr: null, rl: null };
}

export interface SpaceHost {
  sr: number;
  impulse(key: string): PreparedImpulse | undefined;
}

export class SpaceDesigner {
  gr = 0;
  private readonly host: SpaceHost;
  private key = '';
  private conv: Convolver | null = null;
  private wet = 1;
  private dry = 0;
  private cross = 0.55;
  private delay = 0;
  private readonly preL: Float32Array;
  private readonly preR: Float32Array;
  private prePos = 0;
  private lowcut = new Biquad();
  private highcut = new Biquad();
  private useLow = false;
  private useHigh = false;
  private readonly inL = new Float32Array(BLOCK);
  private readonly inR = new Float32Array(BLOCK);
  private readonly wL = new Float32Array(BLOCK);
  private readonly wR = new Float32Array(BLOCK);

  constructor(host: SpaceHost) {
    this.host = host;
    const size = Math.ceil(host.sr * 0.26) + BLOCK;
    this.preL = new Float32Array(size);
    this.preR = new Float32Array(size);
  }

  setParams(p: Record<string, number>, settings?: Record<string, string>): void {
    const v = (id: string) => paramValue('space', p, id);
    const sr = this.host.sr;
    const want = impulseFor(p, settings, sr);
    const key = want?.key ?? '';
    if (key !== this.key) {
      this.key = key;
      this.conv = null;
      this.refresh();
    }
    this.wet = dbToGain(v('wet'));
    this.dry = v('dry') <= -60 ? 0 : dbToGain(v('dry'));
    this.cross = v('cross') / 100;
    this.delay = Math.round((v('predelay') / 1000) * sr);
    this.useLow = v('lowcut') > 20.5;
    this.useHigh = v('highcut') < 19999;
    if (this.useLow) this.lowcut.set('highpass', v('lowcut'), Math.SQRT1_2, 0, sr);
    if (this.useHigh) this.highcut.set('lowpass', v('highcut'), Math.SQRT1_2, 0, sr);
  }

  /** The response may have arrived since: pick it up. */
  refresh(): void {
    if (this.conv || !this.key) return;
    const prepared = this.host.impulse(this.key);
    if (prepared) this.conv = new Convolver(prepared);
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    if (!this.conv) this.refresh();
    const conv = this.conv;
    if (!conv) {
      // no response yet: only the dry signal
      for (let i = 0; i < n; i++) {
        l[i] = (l[i] as number) * this.dry;
        r[i] = (r[i] as number) * this.dry;
      }
      return;
    }
    // pre-delay, into a full block (the convolver works in blocks of BLOCK)
    const size = this.preL.length;
    for (let i = 0; i < BLOCK; i++) {
      const x = i < n ? (l[i] as number) : 0;
      const y = i < n ? (r[i] as number) : 0;
      const w = (this.prePos + i) % size;
      this.preL[w] = x;
      this.preR[w] = y;
      const rd = (w - this.delay + size) % size;
      this.inL[i] = this.preL[rd] as number;
      this.inR[i] = this.preR[rd] as number;
    }
    this.prePos = (this.prePos + BLOCK) % size;
    conv.process(this.inL, this.inR, this.wL, this.wR, this.cross);
    if (this.useLow) this.lowcut.process(this.wL, this.wR, BLOCK);
    if (this.useHigh) this.highcut.process(this.wL, this.wR, BLOCK);
    for (let i = 0; i < n; i++) {
      l[i] = (l[i] as number) * this.dry + (this.wL[i] as number) * this.wet;
      r[i] = (r[i] as number) * this.dry + (this.wR[i] as number) * this.wet;
    }
  }

  reset(): void {
    this.conv = null;
    this.preL.fill(0);
    this.preR.fill(0);
    this.refresh();
  }
}
