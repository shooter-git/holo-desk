/**
 * LZMA and LZMA2, decoded: the algorithm of Igor Pavlov's LZMA SDK (public domain) written out in
 * TypeScript, enough to read a 7z archive's header (which 7-Zip compresses with LZMA as a rule) and
 * its streams when they are LZMA or LZMA2. The whole output is known in advance here, so the output
 * itself is the dictionary.
 */

const INIT = 1024; // a probability of one half, in 11 bits
const STATES = 12;
const POS_BITS_MAX = 4;
const LEN_TO_POS_STATES = 4;
const ALIGN_BITS = 4;
const END_POS_MODEL_INDEX = 14;
const FULL_DISTANCES = 1 << (END_POS_MODEL_INDEX >> 1);
const MATCH_MIN_LEN = 2;
const END_MARKER = 0xffffffff;

/** The range coder's reading half: a code within a range, both 32-bit, refined bit by bit. */
class RangeDecoder {
  private range = 0xffffffff;
  private code: number;
  private readonly input: Uint8Array;
  readonly end: number;
  at: number;

  constructor(input: Uint8Array, at: number, end: number) {
    if (end - at < 5 || input[at] !== 0) throw new Error('Not an LZMA stream');
    this.input = input;
    this.end = end;
    this.code =
      (input[at + 1] as number) * 2 ** 24 +
      (input[at + 2] as number) * 65536 +
      (input[at + 3] as number) * 256 +
      (input[at + 4] as number);
    this.at = at + 5;
  }

  /** The stream was read to its end and nothing is left over. */
  get finished(): boolean {
    return this.code === 0 && this.at === this.end;
  }

  private normalize(): void {
    if (this.range < 2 ** 24) {
      this.range *= 256;
      this.code = this.code * 256 + (this.at < this.end ? (this.input[this.at] as number) : 0);
      this.at++;
    }
  }

  /** One bit, by the probability at probs[i] (which learns from it). */
  bit(probs: Uint16Array, i: number): number {
    const p = probs[i] as number;
    const bound = (this.range >>> 11) * p;
    let b: number;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = p + ((2048 - p) >> 5);
      b = 0;
    } else {
      this.code -= bound;
      this.range -= bound;
      probs[i] = p - (p >> 5);
      b = 1;
    }
    this.normalize();
    return b;
  }

  /** n bits with even odds. */
  direct(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      this.range = Math.floor(this.range / 2);
      let b = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        b = 1;
      }
      this.normalize();
      v = v * 2 + b;
    }
    return v;
  }
}

function tree(rc: RangeDecoder, probs: Uint16Array, base: number, bits: number): number {
  let m = 1;
  for (let i = 0; i < bits; i++) m = (m << 1) | rc.bit(probs, base + m);
  return m - (1 << bits);
}

function treeReverse(rc: RangeDecoder, probs: Uint16Array, base: number, bits: number): number {
  let m = 1;
  let v = 0;
  for (let i = 0; i < bits; i++) {
    const b = rc.bit(probs, base + m);
    m = (m << 1) | b;
    v |= b << i;
  }
  return v;
}

// a length coder's probabilities, in one array: its two choices, low and mid (8 a position state), high
const LEN_LOW = 2;
const LEN_MID = LEN_LOW + 8 * (1 << POS_BITS_MAX);
const LEN_HIGH = LEN_MID + 8 * (1 << POS_BITS_MAX);
const LEN_PROBS = LEN_HIGH + 256;

function length(rc: RangeDecoder, probs: Uint16Array, posState: number): number {
  if (rc.bit(probs, 0) === 0) return tree(rc, probs, LEN_LOW + posState * 8, 3);
  if (rc.bit(probs, 1) === 0) return 8 + tree(rc, probs, LEN_MID + posState * 8, 3);
  return 16 + tree(rc, probs, LEN_HIGH, 8);
}

/** The decoder's state: its probabilities, the last four distances, and where it is in the output. */
class LzmaDecoder {
  pos = 0;
  private lc = 0;
  private lp = 0;
  private pb = 0;
  private state = 0;
  private rep0 = 0;
  private rep1 = 0;
  private rep2 = 0;
  private rep3 = 0;
  private literal = new Uint16Array(0);
  private readonly isMatch = new Uint16Array(STATES << POS_BITS_MAX);
  private readonly isRep = new Uint16Array(STATES);
  private readonly isRepG0 = new Uint16Array(STATES);
  private readonly isRepG1 = new Uint16Array(STATES);
  private readonly isRepG2 = new Uint16Array(STATES);
  private readonly isRep0Long = new Uint16Array(STATES << POS_BITS_MAX);
  private readonly posSlot = new Uint16Array(LEN_TO_POS_STATES << 6);
  private readonly posDecoders = new Uint16Array(1 + FULL_DISTANCES - END_POS_MODEL_INDEX);
  private readonly align = new Uint16Array(1 << ALIGN_BITS);
  private readonly len = new Uint16Array(LEN_PROBS);
  private readonly repLen = new Uint16Array(LEN_PROBS);
  readonly out: Uint8Array;

  constructor(out: Uint8Array) {
    this.out = out;
  }

  /** The literal context bits, literal position bits and position bits of a stream (lc, lp, pb). */
  setProps(lc: number, lp: number, pb: number): void {
    if (lc > 8 || lp > 4 || pb > 4) throw new Error('Not LZMA properties');
    this.lc = lc;
    this.lp = lp;
    this.pb = pb;
    this.literal = new Uint16Array(0x300 << (lc + lp));
    this.reset();
  }

  /** Every probability to one half, the state and distances to their start. */
  reset(): void {
    for (const p of [
      this.literal,
      this.isMatch,
      this.isRep,
      this.isRepG0,
      this.isRepG1,
      this.isRepG2,
      this.isRep0Long,
      this.posSlot,
      this.posDecoders,
      this.align,
      this.len,
      this.repLen,
    ])
      p.fill(INIT);
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
  }

  private distance(rc: RangeDecoder, len: number): number {
    const lenState = len < LEN_TO_POS_STATES - 1 ? len : LEN_TO_POS_STATES - 1;
    const posSlot = tree(rc, this.posSlot, lenState << 6, 6);
    if (posSlot < 4) return posSlot;
    const directBits = (posSlot >> 1) - 1;
    let dist = (2 | (posSlot & 1)) * 2 ** directBits;
    if (posSlot < END_POS_MODEL_INDEX) dist += treeReverse(rc, this.posDecoders, dist - posSlot, directBits);
    else {
      dist += rc.direct(directBits - ALIGN_BITS) * (1 << ALIGN_BITS);
      dist += treeReverse(rc, this.align, 0, ALIGN_BITS);
    }
    return dist;
  }

  /** Decode until the output reaches `end` (or, when one is allowed, an end marker). True at a marker. */
  decode(rc: RangeDecoder, end: number, markerAllowed: boolean): boolean {
    const { out } = this;
    if (end > out.length) throw new Error('LZMA data runs past its output');
    const pbMask = (1 << this.pb) - 1;
    const lpMask = (1 << this.lp) - 1;
    while (this.pos < end) {
      const pos = this.pos;
      const posState = pos & pbMask;
      const state = this.state;
      if (rc.bit(this.isMatch, (state << POS_BITS_MAX) + posState) === 0) {
        const prev = pos > 0 ? (out[pos - 1] as number) : 0;
        const base = 0x300 * (((pos & lpMask) << this.lc) + (prev >> (8 - this.lc)));
        let symbol = 1;
        if (state >= 7) {
          let matchByte = out[pos - this.rep0 - 1] as number;
          do {
            const matchBit = (matchByte >> 7) & 1;
            matchByte = (matchByte << 1) & 0xff;
            const b = rc.bit(this.literal, base + ((1 + matchBit) << 8) + symbol);
            symbol = (symbol << 1) | b;
            if (matchBit !== b) break;
          } while (symbol < 0x100);
        }
        while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(this.literal, base + symbol);
        out[pos] = symbol & 0xff;
        this.pos = pos + 1;
        this.state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }
      let len: number;
      if (rc.bit(this.isRep, state) !== 0) {
        if (pos === 0) throw new Error('Corrupt LZMA data');
        if (rc.bit(this.isRepG0, state) === 0) {
          if (rc.bit(this.isRep0Long, (state << POS_BITS_MAX) + posState) === 0) {
            this.state = state < 7 ? 9 : 11;
            out[pos] = out[pos - this.rep0 - 1] as number;
            this.pos = pos + 1;
            continue;
          }
        } else {
          let dist: number;
          if (rc.bit(this.isRepG1, state) === 0) dist = this.rep1;
          else {
            if (rc.bit(this.isRepG2, state) === 0) dist = this.rep2;
            else {
              dist = this.rep3;
              this.rep3 = this.rep2;
            }
            this.rep2 = this.rep1;
          }
          this.rep1 = this.rep0;
          this.rep0 = dist;
        }
        len = length(rc, this.repLen, posState);
        this.state = state < 7 ? 8 : 11;
      } else {
        this.rep3 = this.rep2;
        this.rep2 = this.rep1;
        this.rep1 = this.rep0;
        len = length(rc, this.len, posState);
        this.state = state < 7 ? 7 : 10;
        const dist = this.distance(rc, len);
        if (dist === END_MARKER) {
          if (!markerAllowed) throw new Error('Corrupt LZMA data');
          return true;
        }
        this.rep0 = dist;
      }
      len += MATCH_MIN_LEN;
      const dist = this.rep0;
      if (dist >= pos) throw new Error('Corrupt LZMA data');
      if (pos + len > end) throw new Error('LZMA data runs past its output');
      const from = pos - dist - 1;
      for (let i = 0; i < len; i++) out[pos + i] = out[from + i] as number;
      this.pos = pos + len;
    }
    return false;
  }
}

/** lc, lp and pb from the byte that packs them. */
function props(byte: number): [number, number, number] {
  if (byte >= 9 * 5 * 5) throw new Error('Not LZMA properties');
  return [byte % 9, Math.floor(byte / 9) % 5, Math.floor(byte / 45)];
}

/**
 * An LZMA stream (as a 7z coder holds one: five property bytes, then the data) of a known size. An end
 * marker may close it, early or not.
 */
export function decodeLzma(
  input: Uint8Array,
  at: number,
  end: number,
  properties: Uint8Array,
  size: number,
): Uint8Array {
  if (properties.length < 5) throw new Error('Not LZMA properties');
  const out = new Uint8Array(size);
  const dec = new LzmaDecoder(out);
  dec.setProps(...props(properties[0] as number));
  const rc = new RangeDecoder(input, at, end);
  if (dec.decode(rc, size, true) && dec.pos !== size) throw new Error('LZMA data ends early');
  return out;
}

/** An LZMA2 stream (chunks, each uncompressed or LZMA with or without a reset) of a known size. */
export function decodeLzma2(input: Uint8Array, at: number, end: number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  const dec = new LzmaDecoder(out);
  let ready = false;
  let p = at;
  const byte = () => {
    if (p >= end) throw new Error('LZMA2 data ends early');
    return input[p++] as number;
  };
  for (;;) {
    const control = byte();
    if (control === 0) break;
    if (control === 1 || control === 2) {
      const n = byte() * 256 + byte() + 1;
      if (p + n > end || dec.pos + n > size) throw new Error('Corrupt LZMA2 data');
      out.set(input.subarray(p, p + n), dec.pos);
      dec.pos += n;
      p += n;
      continue;
    }
    if (control < 0x80) throw new Error('Corrupt LZMA2 data');
    const unpacked = ((control & 0x1f) << 16) + byte() * 256 + byte() + 1;
    const packed = byte() * 256 + byte() + 1;
    const mode = (control >> 5) & 3;
    if (mode >= 2) dec.setProps(...props(byte()));
    else if (mode === 1) dec.reset();
    else if (!ready) throw new Error('Corrupt LZMA2 data');
    ready = true;
    if (p + packed > end) throw new Error('LZMA2 data ends early');
    const rc = new RangeDecoder(input, p, p + packed);
    dec.decode(rc, dec.pos + unpacked, false);
    if (!rc.finished) throw new Error('Corrupt LZMA2 data');
    p += packed;
  }
  if (dec.pos !== size) throw new Error('LZMA2 data ends early');
  return out;
}
