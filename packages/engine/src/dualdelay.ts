/**
 * Dual Delay: a delay line for each side, each with its own time (a note value stretched by its
 * groove, in time with the song, or free in milliseconds), feedback into itself and a crossfeed into
 * the other side. The repeats pass a gentle high cut and low cut (one pole each, so each repeat is a
 * little darker and thinner than the one before), and any path's phase can be flipped. The mix is a
 * straight crossfade: 100% is the echoes alone, for a send.
 *
 * A time that changes (the tempo, a knob) glides to its new length rather than jumping, so it never
 * clicks; held still, it is a whole number of frames, so a repeat is read whole (reading between two
 * frames would dull it a little more at every pass).
 */
import { DELAY_NOTES, paramValue } from '@holo/session';
import type { Effect, Host } from './fx.ts';

/** Seconds a side holds at most. */
const MAX_SECONDS = 4;

/** A one-pole low-pass's coefficient for a corner at `f` (the bilinear transform's: tan, so it lands there). */
function onePole(f: number, sr: number): number {
  const k = Math.tan((Math.PI * Math.min(f, sr * 0.49)) / sr);
  return k / (1 + k);
}

export interface DelayShape {
  /** Each side's time, in seconds. */
  left: number;
  right: number;
  fbL: number;
  fbR: number;
  /** Left into right, and right into left. */
  xLR: number;
  xRL: number;
  lowcut: number;
  highcut: number;
  mix: number;
}

/** Dual Delay's settings at a tempo (seconds a quarter note), worked out once. */
export function delayShape(params: Record<string, number>, beatSeconds: number): DelayShape {
  const v = (id: string) => paramValue('dualdelay', params, id);
  const sync = v('sync') >= 0.5;
  const side = (note: string, grooveId: string, time: string) => {
    const s = sync ? (DELAY_NOTES[Math.round(v(note))]?.beats ?? 1) * (v(grooveId) / 50) * beatSeconds : v(time) / 1000;
    return Math.min(MAX_SECONDS, Math.max(0.0005, s));
  };
  const sign = (id: string) => (v(id) >= 0.5 ? -1 : 1);
  return {
    left: side('noteL', 'grooveL', 'timeL'),
    right: side('noteR', 'grooveR', 'timeR'),
    fbL: (sign('invL') * v('fbL')) / 100,
    fbR: (sign('invR') * v('fbR')) / 100,
    xLR: (sign('invX') * v('crossLR')) / 100,
    xRL: (sign('invX') * v('crossRL')) / 100,
    lowcut: v('lowcut'),
    highcut: v('highcut'),
    mix: v('mix') / 100,
  };
}

/** One repeat as the window draws it: when (s), which side, how loud (signed) and how dark (0 none … 1 dull). */
export interface Tap {
  time: number;
  side: 0 | 1;
  gain: number;
  dark: number;
}

/**
 * The echoes of a click on both inputs, up to `seconds` or until they fall below −60 dB: each side's
 * repeats, the crossfeeds' among them, with the filters' darkening counted by passes.
 */
export function delayTaps(params: Record<string, number>, beatSeconds: number, seconds = 4, most = 64): Tap[] {
  const s = delayShape(params, beatSeconds);
  // paths are walked as (time, side, gain, passes); a path's gain multiplies through each pass
  const out: Tap[] = [];
  let front: { t: number; side: 0 | 1; g: number; k: number }[] = [
    { t: s.left, side: 0, g: 1, k: 1 },
    { t: s.right, side: 1, g: 1, k: 1 },
  ];
  const byKey = new Map<string, Tap>();
  while (front.length && out.length < most) {
    const next: typeof front = [];
    for (const p of front) {
      if (p.t > seconds || Math.abs(p.g) < 0.001) continue;
      const key = `${p.side}:${Math.round(p.t * 2000)}`;
      const had = byKey.get(key);
      if (had) had.gain += p.g;
      else {
        const tap: Tap = { time: p.t, side: p.side, gain: p.g, dark: 1 - 0.75 ** (p.k - 1) };
        byKey.set(key, tap);
        out.push(tap);
      }
      const self = p.side === 0 ? s.fbL : s.fbR;
      const cross = p.side === 0 ? s.xLR : s.xRL;
      const t1 = p.side === 0 ? s.left : s.right;
      const t2 = p.side === 0 ? s.right : s.left;
      if (self) next.push({ t: p.t + t1, side: p.side, g: p.g * self, k: p.k + 1 });
      if (cross) next.push({ t: p.t + t2, side: p.side === 0 ? 1 : 0, g: p.g * cross, k: p.k + 1 });
    }
    // (only the loudest few hundred paths go on: a long, cross-fed tail branches quickly)
    front = next.sort((a, b) => Math.abs(b.g) - Math.abs(a.g)).slice(0, 256);
  }
  return out.filter((t) => Math.abs(t.gain) >= 0.001).sort((a, b) => a.time - b.time);
}

export class DualDelay implements Effect {
  gr = 0;
  private readonly bl: Float32Array;
  private readonly br: Float32Array;
  private readonly size: number;
  private w = 0;
  private params: Record<string, number> = {};
  /** The tempo the times were worked out at (seconds a quarter note). */
  private beat = 0;
  private s: DelayShape;
  /** Each side's delay now and where it's headed (frames). */
  private dL = -1;
  private dR = -1;
  private hc = 0;
  private lc = 0;
  private glide = 0;
  /** The filters' states: low-pass then the low cut's low-pass (its high-pass is what's left), per side. */
  private lpL = 0;
  private lpR = 0;
  private hpL = 0;
  private hpR = 0;
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
    this.size = Math.ceil(host.sr * MAX_SECONDS) + 4;
    this.bl = new Float32Array(this.size);
    this.br = new Float32Array(this.size);
    this.s = delayShape({}, 0.5);
    this.glide = 1 - Math.exp(-1 / (0.05 * host.sr));
  }
  setParams(p: Record<string, number>): void {
    this.params = p;
    const sr = this.host.sr;
    this.beat = this.host.beatSeconds();
    this.s = delayShape(p, this.beat);
    this.hc = onePole(this.s.highcut, sr);
    this.lc = onePole(this.s.lowcut, sr);
  }
  /** `d` frames before the write index `w` on a side (fractional, between two frames). */
  private read(buf: Float32Array, w: number, d: number): number {
    const size = this.size;
    let pos = w - d;
    if (pos < 0) pos += size;
    const i = Math.floor(pos);
    const f = pos - i;
    const a = buf[i] as number;
    if (f === 0) return a;
    const b = buf[i + 1 === size ? 0 : i + 1] as number;
    return a + (b - a) * f;
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    const sr = this.host.sr;
    // in time with the song: the tempo here, now
    const beat = this.host.beatSeconds();
    if (beat !== this.beat) {
      this.beat = beat;
      this.s = delayShape(this.params, beat);
    }
    const s = this.s;
    const toL = Math.min(this.size - 2, Math.max(1, Math.round(s.left * sr)));
    const toR = Math.min(this.size - 2, Math.max(1, Math.round(s.right * sr)));
    if (this.dL < 0) {
      this.dL = toL;
      this.dR = toR;
    }
    const { bl, br, hc, lc, glide, size } = this;
    const { fbL, fbR, xLR, xRL, mix } = s;
    let { dL, dR, lpL, lpR, hpL, hpR, w } = this;
    for (let i = 0; i < n; i++) {
      if (dL !== toL) dL = Math.abs(toL - dL) < 1e-3 ? toL : dL + (toL - dL) * glide;
      if (dR !== toR) dR = Math.abs(toR - dR) < 1e-3 ? toR : dR + (toR - dR) * glide;
      const yl = this.read(bl, w, dL);
      const yr = this.read(br, w, dR);
      lpL += (yl - lpL) * hc;
      lpR += (yr - lpR) * hc;
      hpL += (lpL - hpL) * lc;
      hpR += (lpR - hpR) * lc;
      const el = lpL - hpL;
      const er = lpR - hpR;
      const a = l[i] as number;
      const b = r[i] as number;
      bl[w] = a + fbL * el + xRL * er;
      br[w] = b + fbR * er + xLR * el;
      w = w + 1 === size ? 0 : w + 1;
      l[i] = a + (el - a) * mix;
      r[i] = b + (er - b) * mix;
    }
    this.w = w;
    this.dL = dL;
    this.dR = dR;
    this.lpL = Math.abs(lpL) < 1e-20 ? 0 : lpL;
    this.lpR = Math.abs(lpR) < 1e-20 ? 0 : lpR;
    this.hpL = Math.abs(hpL) < 1e-20 ? 0 : hpL;
    this.hpR = Math.abs(hpR) < 1e-20 ? 0 : hpR;
  }
  reset(): void {
    this.bl.fill(0);
    this.br.fill(0);
    this.lpL = this.lpR = this.hpL = this.hpR = 0;
  }
}
