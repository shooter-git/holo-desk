import { describe, expect, it } from 'vitest';
import { BLOCK, Convolver, prepareImpulse } from '../src/convolver.ts';
import { fft, ifft } from '../src/fft.ts';

/** A small deterministic noise source for test signals. */
function noise(n: number, seed: number, decay = 0): Float32Array {
  let s = seed;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 4294967296) * 2 - 1) * (decay ? Math.exp(-i / decay) : 1);
  }
  return out;
}

function direct(x: Float32Array, h: Float32Array, n: number): Float64Array {
  const y = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let acc = 0;
    const lo = Math.max(0, t - x.length + 1);
    const hi = Math.min(h.length - 1, t);
    for (let j = lo; j <= hi; j++) acc += (h[j] as number) * (x[t - j] as number);
    y[t] = acc;
  }
  return y;
}

describe('the FFT', () => {
  it('goes there and back', () => {
    const re = new Float64Array(1024);
    const im = new Float64Array(1024);
    const x = noise(1024, 3);
    re.set(x);
    fft(re, im);
    ifft(re, im);
    let err = 0;
    for (let i = 0; i < 1024; i++)
      err = Math.max(err, Math.abs((re[i] as number) - (x[i] as number)), Math.abs(im[i] as number));
    expect(err).toBeLessThan(1e-12);
  });
});

describe('convolution', () => {
  it('is the same as convolving directly, through every block size and the cross paths', () => {
    const len = 70000;
    const ir = {
      rate: 44100,
      ll: noise(len, 1, 9000),
      rr: noise(len, 2, 9000),
      lr: noise(len, 3, 7000),
      rl: noise(len, 4, 7000),
    };
    const conv = new Convolver(prepareImpulse(ir));
    const n = BLOCK * 900; // past the last segment's start, with all of them running
    const xl = noise(BLOCK * 300, 5);
    const xr = noise(BLOCK * 300, 6);
    const cross = 0.55;
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);
    const bl = new Float32Array(BLOCK);
    const br = new Float32Array(BLOCK);
    const ol = new Float32Array(BLOCK);
    const or = new Float32Array(BLOCK);
    for (let b = 0; b < n / BLOCK; b++) {
      bl.fill(0);
      br.fill(0);
      if (b * BLOCK < xl.length) {
        bl.set(xl.subarray(b * BLOCK, b * BLOCK + BLOCK));
        br.set(xr.subarray(b * BLOCK, b * BLOCK + BLOCK));
      }
      conv.process(bl, br, ol, or, cross);
      outL.set(ol, b * BLOCK);
      outR.set(or, b * BLOCK);
    }
    // check spread through the result (all of it would take a while directly)
    const want = (x: Float32Array, h: Float32Array, t: number) => {
      let acc = 0;
      for (let j = Math.max(0, t - x.length + 1); j <= Math.min(h.length - 1, t); j++)
        acc += (h[j] as number) * (x[t - j] as number);
      return acc;
    };
    let err = 0;
    let peak = 0;
    for (let t = 0; t < n; t += 97) {
      const l = want(xl, ir.ll, t) + cross * want(xr, ir.rl, t);
      const r = want(xr, ir.rr, t) + cross * want(xl, ir.lr, t);
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
      err = Math.max(err, Math.abs((outL[t] as number) - l), Math.abs((outR[t] as number) - r));
    }
    expect(peak).toBeGreaterThan(1);
    expect(err / peak).toBeLessThan(1e-5);
    void direct;
  });

  it('is silent until the first non-zero tap, with no added delay', () => {
    const ll = new Float32Array(3000);
    ll[200] = 1;
    const conv = new Convolver(prepareImpulse({ rate: 48000, ll, rr: ll, lr: null, rl: null }));
    const x = new Float32Array(BLOCK);
    x[0] = 1;
    const ol = new Float32Array(BLOCK);
    const or = new Float32Array(BLOCK);
    const got: number[] = [];
    for (let b = 0; b < 4; b++) {
      conv.process(b === 0 ? x : new Float32Array(BLOCK), b === 0 ? x : new Float32Array(BLOCK), ol, or, 0);
      for (let i = 0; i < BLOCK; i++) if (Math.abs(ol[i] as number) > 1e-6) got.push(b * BLOCK + i);
    }
    expect(got).toEqual([200]);
  });
});

describe('generated spaces', () => {
  it('are the same every time, start after their pre-delay and die away', async () => {
    const { generateSpace } = await import('../src/spaces.ts');
    const a = generateSpace('room', 7, 1, 44100);
    const b = generateSpace('room', 7, 1, 44100);
    expect(Buffer.from(a.ll.buffer).equals(Buffer.from(b.ll.buffer))).toBe(true);
    expect(a.ll.length).toBe(Math.round(1.6 * 44100));
    const pre = Math.round(0.006 * 44100);
    expect(a.ll.subarray(0, Math.floor(pre / 2)).every((v) => v === 0)).toBe(true);
    const energy = (from: number, to: number) => a.ll.subarray(from, to).reduce((s, v) => s + v * v, 0);
    // a room's tail: 0.1-0.2 s well above 0.6-0.7 s
    expect(energy(4410, 8820)).toBeGreaterThan(energy(26460, 30870) * 100);
    const other = generateSpace('room', 8, 1, 44100);
    expect(Buffer.from(other.ll.buffer).equals(Buffer.from(a.ll.buffer))).toBe(false);
  });
});
