/**
 * numpy's random numbers, drawn the same way: a SeedSequence's seeding, the PCG64 generator, and the
 * Generator's uniform, normal (ziggurat) and integer draws. A creation whose music is Python and
 * numpy (Hallowed Lanterns) and HO[LO] draw the very same numbers from the same seed, so a note's
 * humanised timing, its sample's start and its round robin come out the same in both.
 *
 * After numpy (BSD-3-Clause): numpy/random/bit_generator.pyx (SeedSequence), src/pcg64 (PCG64, by
 * Melissa O'Neill), src/distributions/distributions.c (the draws) and ziggurat_constants.h (the tables).
 */
import { FI, KI, WI } from './ziggurat.ts';

// ---- 32-bit words ----

const u32 = (x: number) => x >>> 0;
/** The low 32 bits of a·b for 32-bit words (exact). */
const mul32 = (a: number, b: number) => u32(Math.imul(a, b));

// ---- SeedSequence ----

const INIT_A = 0x43b0d7e5;
const MULT_A = 0x931e8875;
const INIT_B = 0x8b51f9dd;
const MULT_B = 0x58f38ded;
const MIX_MULT_L = 0xca01f9dd;
const MIX_MULT_R = 0x4973f715;

function seedPool(entropy: number[]): number[] {
  const pool = [0, 0, 0, 0];
  let hc = INIT_A;
  const hashmix = (value: number): number => {
    let v = u32(value ^ hc);
    hc = mul32(hc, MULT_A);
    v = mul32(v, hc);
    return u32(v ^ (v >>> 16));
  };
  const mix = (x: number, y: number): number => {
    const r = u32(mul32(MIX_MULT_L, x) - mul32(MIX_MULT_R, y));
    return u32(r ^ (r >>> 16));
  };
  for (let i = 0; i < 4; i++) pool[i] = hashmix(i < entropy.length ? (entropy[i] as number) : 0);
  for (let s = 0; s < 4; s++) {
    for (let d = 0; d < 4; d++) if (s !== d) pool[d] = mix(pool[d] as number, hashmix(pool[s] as number));
  }
  for (let s = 4; s < entropy.length; s++) {
    for (let d = 0; d < 4; d++) pool[d] = mix(pool[d] as number, hashmix(entropy[s] as number));
  }
  return pool;
}

/** generate_state(n) as 32-bit words (pairs of them, low first, are its 64-bit words). */
function generateState(pool: number[], words: number): number[] {
  const out: number[] = [];
  let hc = INIT_B;
  for (let i = 0; i < words; i++) {
    let v = u32((pool[i % 4] as number) ^ hc);
    hc = mul32(hc, MULT_B);
    v = mul32(v, hc);
    out.push(u32(v ^ (v >>> 16)));
  }
  return out;
}

// ---- 128-bit words: four 32-bit limbs (lowest first) to hand around; eight 16-bit digits to compute ----

type U128 = [number, number, number, number];

/** 2^-16 (a multiply, where a divide would hold up the carries' chain). */
const TO_DIGIT = 1 / 65536;

function toDigits<T extends Float64Array>(a: readonly number[], out: T): T {
  for (let i = 0; i < 4; i++) {
    out[2 * i] = (a[i] as number) & 0xffff;
    out[2 * i + 1] = (a[i] as number) >>> 16;
  }
  return out;
}

function toLimbs(d: Float64Array): U128 {
  return [
    (d[0] as number) + (d[1] as number) * 65536,
    (d[2] as number) + (d[3] as number) * 65536,
    (d[4] as number) + (d[5] as number) * 65536,
    (d[6] as number) + (d[7] as number) * 65536,
  ];
}

/** PCG64 (XSL-RR 128/64), with numpy's buffered 32-bit draws. */
export class Pcg64 {
  /** The state and the increment as 16-bit digits, lowest first. */
  private state = new Float64Array(8);
  private inc = new Float64Array(8);
  private has32 = false;
  private buf32 = 0;
  /** The last 64-bit draw, high and low words. */
  hi = 0;
  lo = 0;

  /** Seeded as numpy seeds it from a SeedSequence's state words (seed high, seed low, inc high, inc low; 64-bit). */
  constructor(words64: [number, number][]) {
    const [s0, s1, i0, i1] = words64 as [[number, number], [number, number], [number, number], [number, number]];
    const initstate: U128 = [s1[1], s1[0], s0[1], s0[0]];
    const initseq: U128 = [i1[1], i1[0], i0[1], i0[0]];
    // inc = initseq << 1 | 1
    toDigits(
      [
        u32((initseq[0] << 1) | 1),
        u32((initseq[1] << 1) | (initseq[0] >>> 31)),
        u32((initseq[2] << 1) | (initseq[1] >>> 31)),
        u32((initseq[3] << 1) | (initseq[2] >>> 31)),
      ],
      this.inc,
    );
    this.step();
    // state += initstate
    const add = toDigits(initstate, new Float64Array(8));
    let carry = 0;
    for (let k = 0; k < 8; k++) {
      const v = (this.state[k] as number) + (add[k] as number) + carry;
      carry = v >= 65536 ? 1 : 0;
      this.state[k] = v - carry * 65536;
    }
    this.step();
  }

  /**
   * state = state·MULT + inc (mod 2^128), in 16-bit digits: each sum of partial products stays under
   * 2^36, exact in a double. (MULT's digits, lowest first: f645 9fcc df64 4385 5da4 1fc6 ed05 2360.)
   */
  private step(): void {
    const s = this.state;
    const c = this.inc;
    const s0 = s[0] as number;
    const s1 = s[1] as number;
    const s2 = s[2] as number;
    const s3 = s[3] as number;
    const s4 = s[4] as number;
    const s5 = s[5] as number;
    const s6 = s[6] as number;
    const s7 = s[7] as number;
    let v = (c[0] as number) + s0 * 0xf645;
    let carry = (v * TO_DIGIT) | 0;
    s[0] = v - carry * 65536;
    v = (c[1] as number) + carry + s0 * 0x9fcc + s1 * 0xf645;
    carry = (v * TO_DIGIT) | 0;
    s[1] = v - carry * 65536;
    v = (c[2] as number) + carry + s0 * 0xdf64 + s1 * 0x9fcc + s2 * 0xf645;
    carry = (v * TO_DIGIT) | 0;
    s[2] = v - carry * 65536;
    v = (c[3] as number) + carry + s0 * 0x4385 + s1 * 0xdf64 + s2 * 0x9fcc + s3 * 0xf645;
    carry = (v * TO_DIGIT) | 0;
    s[3] = v - carry * 65536;
    v = (c[4] as number) + carry + s0 * 0x5da4 + s1 * 0x4385 + s2 * 0xdf64 + s3 * 0x9fcc + s4 * 0xf645;
    carry = (v * TO_DIGIT) | 0;
    s[4] = v - carry * 65536;
    v = (c[5] as number) + carry + s0 * 0x1fc6 + s1 * 0x5da4 + s2 * 0x4385 + s3 * 0xdf64 + s4 * 0x9fcc + s5 * 0xf645;
    carry = (v * TO_DIGIT) | 0;
    s[5] = v - carry * 65536;
    v =
      (c[6] as number) +
      carry +
      s0 * 0xed05 +
      s1 * 0x1fc6 +
      s2 * 0x5da4 +
      s3 * 0x4385 +
      s4 * 0xdf64 +
      s5 * 0x9fcc +
      s6 * 0xf645;
    carry = (v * TO_DIGIT) | 0;
    s[6] = v - carry * 65536;
    v =
      (c[7] as number) +
      carry +
      s0 * 0x2360 +
      s1 * 0xed05 +
      s2 * 0x1fc6 +
      s3 * 0x5da4 +
      s4 * 0x4385 +
      s5 * 0xdf64 +
      s6 * 0x9fcc +
      s7 * 0xf645;
    // the top digit's carry falls off the end (mod 2^128)
    s[7] = v - ((v * TO_DIGIT) | 0) * 65536;
  }

  /** Its state as plain numbers (to hand to another thread). */
  save(): number[] {
    return [...toLimbs(this.state), ...toLimbs(this.inc), this.has32 ? 1 : 0, this.buf32];
  }

  /** A blank generator of the constructor's own shape (one shape keeps the draws' code monomorphic). */
  private static blank(): Pcg64 {
    return new Pcg64([
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  }

  static load(s: number[]): Pcg64 {
    const c = Pcg64.blank();
    c.state = toDigits(s.slice(0, 4), new Float64Array(8));
    c.inc = toDigits(s.slice(4, 8), new Float64Array(8));
    c.has32 = s[8] === 1;
    c.buf32 = s[9] ?? 0;
    c.hi = 0;
    c.lo = 0;
    return c;
  }

  /** A generator in the same state, to draw the same numbers again. */
  clone(): Pcg64 {
    const c = Pcg64.blank();
    c.state = this.state.slice();
    c.inc = this.inc.slice();
    c.has32 = this.has32;
    c.buf32 = this.buf32;
    c.hi = this.hi;
    c.lo = this.lo;
    return c;
  }

  /** The next 64 bits, into `hi` and `lo`. */
  next64(): void {
    this.step();
    const s = this.state;
    const l0 = (s[0] as number) + (s[1] as number) * 65536;
    const l1 = (s[2] as number) + (s[3] as number) * 65536;
    const l2 = (s[4] as number) + (s[5] as number) * 65536;
    const l3 = (s[6] as number) + (s[7] as number) * 65536;
    const xh = u32(l3 ^ l1);
    const xl = u32(l2 ^ l0);
    const rot = (s[7] as number) >>> 10;
    if (rot === 0) {
      this.hi = xh;
      this.lo = xl;
    } else if (rot < 32) {
      this.lo = u32((xl >>> rot) | (xh << (32 - rot)));
      this.hi = u32((xh >>> rot) | (xl << (32 - rot)));
    } else if (rot === 32) {
      this.lo = xh;
      this.hi = xl;
    } else {
      const r = rot - 32;
      this.lo = u32((xh >>> r) | (xl << (32 - r)));
      this.hi = u32((xl >>> r) | (xh << (32 - r)));
    }
  }

  next32(): number {
    if (this.has32) {
      this.has32 = false;
      return this.buf32;
    }
    this.next64();
    this.has32 = true;
    this.buf32 = this.hi;
    return this.lo;
  }

  /** A double in [0, 1): the top 53 bits. */
  nextDouble(): number {
    this.next64();
    return (this.hi * 2097152 + (this.lo >>> 11)) * 1.1102230246251565e-16;
  }
}

const ZIG_R = 3.654152885361009; // numpy: 3.6541528853610087963519472518
const ZIG_INV_R = 0.2736612373297583; // numpy: 0.27366123732975827203338247596

/** numpy's Generator over PCG64: the draws a creation's Python makes. */
export class NumpyRandom {
  private bits: Pcg64;

  /** As np.random.default_rng(seed), for a non-negative integer seed given as 32-bit words (low first). */
  constructor(entropy: number[]) {
    const pool = seedPool(entropy.length ? entropy : [0]);
    const w = generateState(pool, 8);
    const word = (i: number): [number, number] => [w[i * 2 + 1] as number, w[i * 2] as number];
    this.bits = new Pcg64([word(0), word(1), word(2), word(3)]);
  }

  /** As np.random.default_rng(seed) for a seed below 2^53. */
  static fromSeed(seed: number): NumpyRandom {
    const words: number[] = [];
    let n = seed;
    if (n === 0) words.push(0);
    while (n > 0) {
      words.push(n % 4294967296);
      n = Math.floor(n / 4294967296);
    }
    return new NumpyRandom(words);
  }

  /** Where the stream is, as plain numbers (see `resume`). */
  save(): number[] {
    return this.bits.save();
  }

  /** A stream from a saved state: it draws what the saved one would have drawn next. */
  static resume(state: number[]): NumpyRandom {
    // made as the constructor makes one, so every generator has the same shape
    const c = new NumpyRandom([0]);
    c.bits = Pcg64.load(state);
    return c;
  }

  /** A generator that will draw what this one draws from here on. */
  clone(): NumpyRandom {
    const c = new NumpyRandom([0]);
    c.bits = this.bits.clone();
    return c;
  }

  random(): number {
    return this.bits.nextDouble();
  }

  uniform(low = 0, high = 1): number {
    return low + (high - low) * this.bits.nextDouble();
  }

  /** The last draw drawNormal() made. */
  drawn = 0;

  /** A standard normal, left in `drawn`: a voice draws one every sample, and a returned double is boxed unless inlined. */
  drawNormal(): void {
    const b = this.bits;
    for (;;) {
      b.next64();
      const lo = b.lo;
      const hi = b.hi;
      const idx = lo & 0xff;
      const sign = (lo >>> 8) & 1;
      // bits 9 to 60 of the draw
      const rabs = (hi & 0x1fffffff) * 8388608 + (lo >>> 9);
      let x = rabs * (WI[idx] as number);
      if (sign) x = -x;
      if (rabs < (KI[idx] as number)) {
        this.drawn = x;
        return;
      }
      if (idx === 0) {
        const bit = (lo >>> 17) & 1;
        for (;;) {
          const xx = -ZIG_INV_R * Math.log1p(-b.nextDouble());
          const yy = -Math.log1p(-b.nextDouble());
          if (yy + yy > xx * xx) {
            this.drawn = bit ? -(ZIG_R + xx) : ZIG_R + xx;
            return;
          }
        }
      }
      if (
        ((FI[idx - 1] as number) - (FI[idx] as number)) * b.nextDouble() + (FI[idx] as number) <
        Math.exp(-0.5 * x * x)
      ) {
        this.drawn = x;
        return;
      }
    }
  }

  standardNormal(): number {
    this.drawNormal();
    return this.drawn;
  }

  normal(loc = 0, scale = 1): number {
    return loc + scale * this.standardNormal();
  }

  /** n standard normals in a row (np.random.Generator.standard_normal(n)). */
  standardNormals(n: number): Float64Array {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = this.standardNormal();
    return out;
  }

  /** An integer in [low, high), as Generator.integers draws it (Lemire's method on 32-bit draws). */
  integers(low: number, high: number): number {
    const rng = high - low - 1;
    if (rng <= 0) return low;
    if (rng > 0xfffffffe) throw new Error('integers: ranges past 2^32 are not drawn here');
    const excl = BigInt(rng + 1);
    let m = BigInt(this.bits.next32()) * excl;
    let leftover = Number(m & 0xffffffffn);
    if (leftover < rng + 1) {
      const threshold = (0xffffffff - rng) % (rng + 1);
      while (leftover < threshold) {
        m = BigInt(this.bits.next32()) * excl;
        leftover = Number(m & 0xffffffffn);
      }
    }
    return low + Number(m >> 32n);
  }
}

// ---- SHA-256 (a creation names its random streams by hashing their names) ----

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const len = data.length;
  const blocks = Math.ceil((len + 9) / 64);
  const msg = new Uint8Array(blocks * 64);
  msg.set(data);
  msg[len] = 0x80;
  const bits = len * 8;
  const view = new DataView(msg.buffer);
  view.setUint32(msg.length - 8, Math.floor(bits / 4294967296));
  view.setUint32(msg.length - 4, bits >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(b * 64 + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15] as number;
      const y = w[i - 2] as number;
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    let [a, bb, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e as number, 6) ^ rotr(e as number, 11) ^ rotr(e as number, 25);
      const ch = ((e as number) & (f as number)) ^ (~(e as number) & (g as number));
      const t1 = ((hh as number) + S1 + ch + (K256[i] as number) + (w[i] as number)) >>> 0;
      const S0 = rotr(a as number, 2) ^ rotr(a as number, 13) ^ rotr(a as number, 22);
      const maj = ((a as number) & (bb as number)) ^ ((a as number) & (c as number)) ^ ((bb as number) & (c as number));
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = ((d as number) + t1) >>> 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] as number) + (a as number);
    h[1] = (h[1] as number) + (bb as number);
    h[2] = (h[2] as number) + (c as number);
    h[3] = (h[3] as number) + (d as number);
    h[4] = (h[4] as number) + (e as number);
    h[5] = (h[5] as number) + (f as number);
    h[6] = (h[6] as number) + (g as number);
    h[7] = (h[7] as number) + (hh as number);
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i] as number);
  return out;
}

/**
 * A stream named by its parts, as Hallowed Lanterns names them (hlaudio.core.rng): the SHA-256 of
 * the parts joined with "|", its first eight bytes (little-endian) the seed of default_rng.
 */
export function namedRandom(...parts: (string | number)[]): NumpyRandom {
  const text = parts.map((p) => String(p)).join('|');
  const digest = sha256(new TextEncoder().encode(text));
  const dv = new DataView(digest.buffer);
  const low = dv.getUint32(0, true);
  const high = dv.getUint32(4, true);
  // the seed's 32-bit words, lowest first, as many as it needs (at least one)
  const words = high ? [low, high] : [low];
  return new NumpyRandom(words);
}
