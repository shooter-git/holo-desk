/**
 * bzip2, decoded: Julian Seward's format (Huffman-coded move-to-front runs of a Burrows-Wheeler
 * block, up to 900 kB each) written out in TypeScript, a block at a time, so a tar.bz2 of several
 * gigabytes streams through without being held whole. Every block's CRC and every stream's are
 * checked; streams written one after another (as pbzip2 writes them) are read as one.
 */
import { ByteReader, type ByteSource, bytesSource } from './bytes.ts';

const MAX_LEN = 20;
const GROUP_SIZE = 50;
const BLOCK_MAGIC = [0x314159, 0x265359];
const END_MAGIC = [0x177245, 0x385090];

/** bzip2's CRC: CRC-32 with its bits taken high first. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();

const corrupt = () => new Error('A bzip2 stream is damaged');

/** Bits read high first, from bytes. */
class Bits {
  private buf = 0;
  /** Unread bits in buf (its low ones). */
  private count = 0;
  private readonly src: ByteReader;
  constructor(src: ByteReader) {
    this.src = src;
  }

  private need(n: number): void {
    while (this.count < n) {
      const b = this.src.byte();
      if (b < 0) throw new Error('A bzip2 stream ends early');
      this.buf = (this.buf << 8) | b;
      this.count += 8;
    }
  }

  /** The next n bits (n up to 24), not yet taken. */
  peek(n: number): number {
    this.need(n);
    return (this.buf >>> (this.count - n)) & ((1 << n) - 1);
  }

  skip(n: number): void {
    this.count -= n;
    this.buf &= (1 << this.count) - 1;
  }

  /** The next n bits (n up to 24). */
  bits(n: number): number {
    const v = this.peek(n);
    this.skip(n);
    return v;
  }

  u32(): number {
    return (this.bits(16) * 65536 + this.bits(16)) >>> 0;
  }

  /** Drop the bits left of the byte being read. */
  align(): void {
    this.skip(this.count % 8);
  }

  /** Whether any bytes are left (after align). */
  more(): boolean {
    return this.count > 0 || this.src.more();
  }
}

/** A Huffman table as bzip2 builds one: codes assigned by length, then by symbol. */
interface Table {
  min: number;
  max: number;
  /** The largest code of each length (-1 for none). */
  limit: Int32Array;
  /** Each length's first code, less its first symbol's place in perm. */
  base: Int32Array;
  perm: Uint16Array;
}

function table(lengths: Uint8Array, alphaSize: number): Table {
  let min = MAX_LEN;
  let max = 0;
  const count = new Int32Array(MAX_LEN + 2);
  for (let i = 0; i < alphaSize; i++) {
    const l = lengths[i] as number;
    min = Math.min(min, l);
    max = Math.max(max, l);
    count[l] = (count[l] as number) + 1;
  }
  const perm = new Uint16Array(alphaSize);
  let p = 0;
  for (let l = min; l <= max; l++) for (let s = 0; s < alphaSize; s++) if (lengths[s] === l) perm[p++] = s;
  const limit = new Int32Array(MAX_LEN + 2).fill(-1);
  const base = new Int32Array(MAX_LEN + 2);
  let code = 0;
  let first = 0;
  for (let l = min; l <= max; l++) {
    const n = count[l] as number;
    base[l] = code - first;
    limit[l] = code + n - 1;
    first += n;
    code = (code + n) * 2;
  }
  return { min, max, limit, base, perm };
}

export class Bzip2Reader {
  private readonly bits: Bits;
  private inStream = false;
  private streams = 0;
  private blockMax = 0;
  private combined = 0;
  private done = false;
  private tt = new Uint32Array(0);
  private out = new Uint8Array(1 << 20);

  constructor(source: ByteSource) {
    this.bits = new Bits(new ByteReader(source));
  }

  /** The next block's bytes (a new array), or null after the last stream. */
  next(): Uint8Array | null {
    const b = this.bits;
    while (!this.done) {
      if (!this.inStream) {
        b.align();
        if (!b.more()) {
          if (!this.streams) throw new Error('Not a bzip2 stream');
          this.done = true;
          break;
        }
        // a stream's header: "BZh" and its block size in hundreds of kB
        const h0 = b.bits(8);
        const h1 = b.bits(8);
        const h2 = b.bits(8);
        const level = b.bits(8);
        if (h0 !== 0x42 || h1 !== 0x5a || h2 !== 0x68 || level < 0x31 || level > 0x39) {
          if (!this.streams) throw new Error('Not a bzip2 stream');
          // what follows the last stream isn't bzip2 (bzip2 itself ignores it too)
          this.done = true;
          break;
        }
        this.blockMax = (level - 0x30) * 100000;
        if (this.tt.length < this.blockMax) this.tt = new Uint32Array(this.blockMax);
        this.combined = 0;
        this.inStream = true;
        this.streams++;
      }
      const m0 = b.bits(24);
      const m1 = b.bits(24);
      if (m0 === END_MAGIC[0] && m1 === END_MAGIC[1]) {
        if (b.u32() !== this.combined) throw new Error('A bzip2 stream is damaged (its CRC differs)');
        this.inStream = false;
        continue;
      }
      if (m0 !== BLOCK_MAGIC[0] || m1 !== BLOCK_MAGIC[1]) throw corrupt();
      return this.block();
    }
    return null;
  }

  private block(): Uint8Array {
    const b = this.bits;
    const crc = b.u32();
    if (b.bits(1)) throw new Error('A randomised bzip2 block (bzip2 0.9.0) isn’t read here');
    const origPtr = b.bits(24);
    // the bytes the block uses
    const used: number[] = [];
    const groups16 = b.bits(16);
    for (let i = 0; i < 16; i++) {
      if (!(groups16 & (0x8000 >> i))) continue;
      const bitsOf = b.bits(16);
      for (let j = 0; j < 16; j++) if (bitsOf & (0x8000 >> j)) used.push(i * 16 + j);
    }
    if (!used.length) throw corrupt();
    const alphaSize = used.length + 2;
    const nGroups = b.bits(3);
    const nSelectors = b.bits(15);
    if (nGroups < 2 || nGroups > 6 || nSelectors < 1) throw corrupt();
    // which table each group of 50 symbols is coded with (move-to-front coded)
    const order = Array.from({ length: nGroups }, (_, i) => i);
    const selectors = new Uint8Array(nSelectors);
    for (let i = 0; i < nSelectors; i++) {
      let j = 0;
      while (b.bits(1)) if (++j >= nGroups) throw corrupt();
      const t = order[j] as number;
      order.splice(j, 1);
      order.unshift(t);
      selectors[i] = t;
    }
    const tables: Table[] = [];
    for (let t = 0; t < nGroups; t++) {
      const lengths = new Uint8Array(alphaSize);
      let len = b.bits(5);
      for (let s = 0; s < alphaSize; s++) {
        for (;;) {
          if (len < 1 || len > MAX_LEN) throw corrupt();
          if (!b.bits(1)) break;
          len += b.bits(1) ? -1 : 1;
        }
        lengths[s] = len;
      }
      tables.push(table(lengths, alphaSize));
    }

    // the move-to-front runs, into tt (each byte in its low 8 bits)
    const eob = alphaSize - 1;
    const mtf = new Uint8Array(256);
    for (let i = 0; i < used.length; i++) mtf[i] = i;
    const counts = new Int32Array(256);
    const tt = this.tt;
    const max = this.blockMax;
    let n = 0;
    let group = -1;
    let left = 0;
    let t = tables[0] as Table;
    const symbol = (): number => {
      if (left === 0) {
        if (++group >= nSelectors) throw corrupt();
        left = GROUP_SIZE;
        t = tables[selectors[group] as number] as Table;
      }
      left--;
      const code = b.peek(t.max);
      let l = t.min;
      while (code >>> (t.max - l) > (t.limit[l] as number)) if (++l > t.max) throw corrupt();
      b.skip(l);
      const s = t.perm[(code >>> (t.max - l)) - (t.base[l] as number)];
      if (s === undefined) throw corrupt();
      return s;
    };
    let s = symbol();
    while (s !== eob) {
      if (s <= 1) {
        // a run of the front byte: RUNA and RUNB as the digits 1 and 2 of a number, low first
        let run = 0;
        let weight = 1;
        do {
          if (weight > max) throw corrupt();
          run += (s + 1) * weight;
          weight *= 2;
          s = symbol();
        } while (s <= 1);
        const byte = used[mtf[0] as number] as number;
        if (n + run > max) throw corrupt();
        counts[byte] = (counts[byte] as number) + run;
        tt.fill(byte, n, n + run);
        n += run;
        continue;
      }
      const at = s - 1;
      const index = mtf[at] as number;
      mtf.copyWithin(1, 0, at);
      mtf[0] = index;
      const byte = used[index] as number;
      if (n >= max) throw corrupt();
      counts[byte] = (counts[byte] as number) + 1;
      tt[n++] = byte;
      s = symbol();
    }
    if (origPtr >= n) throw corrupt();

    // the Burrows-Wheeler transform undone: each entry's high bits point to the next
    const next = new Int32Array(256);
    for (let i = 0, sum = 0; i < 256; i++) {
      next[i] = sum;
      sum += counts[i] as number;
    }
    for (let i = 0; i < n; i++) {
      const byte = (tt[i] as number) & 0xff;
      const k = next[byte] as number;
      tt[k] = ((tt[k] as number) | (i << 8)) >>> 0;
      next[byte] = k + 1;
    }
    // and the first run-length coding: four of a byte, then how many more
    let out = this.out;
    let o = 0;
    let pos = (tt[origPtr] as number) >>> 8;
    let last = -1;
    let same = 0;
    let c = 0xffffffff;
    for (let i = 0; i < n; i++) {
      const e = tt[pos] as number;
      const byte = e & 0xff;
      pos = e >>> 8;
      let k = 1;
      let value = byte;
      if (same === 4) {
        k = byte;
        value = last;
        same = 0;
        last = -1;
      } else if (byte === last) same++;
      else {
        last = byte;
        same = 1;
      }
      if (o + k > out.length) {
        const bigger = new Uint8Array(Math.max(out.length * 2, o + k));
        bigger.set(out.subarray(0, o));
        out = this.out = bigger;
      }
      for (let j = 0; j < k; j++) {
        out[o++] = value;
        c = ((c << 8) ^ (CRC_TABLE[((c >>> 24) ^ value) & 0xff] as number)) >>> 0;
      }
    }
    if (~c >>> 0 !== crc) throw new Error('A bzip2 block is damaged (its CRC differs)');
    this.combined = (((this.combined << 1) | (this.combined >>> 31)) ^ crc) >>> 0;
    return out.slice(0, o);
  }
}

/** A whole bzip2 file, decoded (for small ones; a big one is read a block at a time). */
export function decodeBzip2(bytes: Uint8Array): Uint8Array {
  const reader = new Bzip2Reader(bytesSource(bytes));
  const parts: Uint8Array[] = [];
  let size = 0;
  for (let p = reader.next(); p; p = reader.next()) {
    parts.push(p);
    size += p.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
