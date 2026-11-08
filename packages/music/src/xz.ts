/**
 * xz, decoded: the .xz container (streams of blocks, each one LZMA2 and checked by CRC32, CRC64 or
 * SHA-256, then an index), read a chunk at a time so a tar.xz of any size streams through. Only the
 * LZMA2 filter alone is read (what xz writes unless told otherwise); the branch-call and delta filters
 * aren't.
 */
import { createHash, type Hash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { ByteReader, type ByteSource, bytesSource } from './bytes.ts';
import { Lzma2Reader, lzma2DictSize } from './lzma.ts';

const MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
const FOOTER_MAGIC = [0x59, 0x5a];
const LZMA2 = 0x21;

// CRC-64 (ECMA-182, reflected) as two 32-bit halves
const CRC64_LO = new Uint32Array(256);
const CRC64_HI = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let lo = i;
  let hi = 0;
  for (let k = 0; k < 8; k++) {
    const odd = lo & 1;
    lo = ((lo >>> 1) | ((hi & 1) << 31)) >>> 0;
    hi >>>= 1;
    if (odd) {
      lo = (lo ^ 0xd7870f42) >>> 0;
      hi = (hi ^ 0xc96c5795) >>> 0;
    }
  }
  CRC64_LO[i] = lo;
  CRC64_HI[i] = hi;
}

/** A running check of a block's data, as its stream's flags say. */
interface Check {
  size: number;
  update(data: Uint8Array): void;
  /** Whether the stored check (its bytes) is the data's. */
  matches(stored: Uint8Array): boolean;
}

function check(type: number): Check {
  if (type === 0) return { size: 0, update: () => undefined, matches: () => true };
  if (type === 1) {
    let c = 0;
    return {
      size: 4,
      update: (d) => {
        c = crc32(d, c);
      },
      matches: (s) =>
        ((s[0] as number) | ((s[1] as number) << 8) | ((s[2] as number) << 16) | ((s[3] as number) << 24)) >>> 0 ===
        c >>> 0,
    };
  }
  if (type === 4) {
    let lo = 0xffffffff;
    let hi = 0xffffffff;
    return {
      size: 8,
      update: (d) => {
        for (let i = 0; i < d.length; i++) {
          const k = (lo ^ (d[i] as number)) & 0xff;
          lo = (((lo >>> 8) | (hi << 24)) ^ (CRC64_LO[k] as number)) >>> 0;
          hi = ((hi >>> 8) ^ (CRC64_HI[k] as number)) >>> 0;
        }
      },
      matches: (s) => {
        const v = new DataView(s.buffer, s.byteOffset, 8);
        return v.getUint32(0, true) === ~lo >>> 0 && v.getUint32(4, true) === ~hi >>> 0;
      },
    };
  }
  if (type === 10) {
    const h: Hash = createHash('sha256');
    return {
      size: 32,
      update: (d) => {
        h.update(d);
      },
      matches: (s) => Buffer.from(s).equals(h.digest()),
    };
  }
  // the other check types aren't defined yet: their size is known, so they're skipped
  const size = type === 0 ? 0 : 4 * 2 ** Math.floor((type - 1) / 3);
  return { size, update: () => undefined, matches: () => true };
}

/** A variable-length integer (seven bits a byte, low first) from a header. */
function varint(read: () => number): number {
  let v = 0;
  for (let i = 0; i < 9; i++) {
    const b = read();
    v += (b & 0x7f) * 2 ** (7 * i);
    if (!(b & 0x80)) {
      if (i > 0 && b === 0) throw new Error('An xz header is damaged');
      return v;
    }
  }
  throw new Error('An xz header is damaged');
}

const le32 = (b: Uint8Array, at: number) =>
  ((b[at] as number) | ((b[at + 1] as number) << 8) | ((b[at + 2] as number) << 16) | ((b[at + 3] as number) << 24)) >>>
  0;

export class XzReader {
  private readonly src: ByteReader;
  private streams = 0;
  private flags = -1;
  private block: { lzma: Lzma2Reader; check: Check; start: number; header: number; size: number } | null = null;
  /** The blocks of the stream being read: unpadded size and uncompressed size, for its index. */
  private records: [number, number][] = [];
  private done = false;

  constructor(source: ByteSource) {
    this.src = new ByteReader(source);
  }

  /** The next piece of data (a new array), or null at the end of the last stream. */
  next(): Uint8Array | null {
    while (!this.done) {
      if (this.block) {
        const b = this.block;
        const data = b.lzma.next();
        if (data) {
          b.check.update(data);
          b.size += data.length;
          return data;
        }
        this.endBlock(b);
        this.block = null;
        continue;
      }
      if (this.flags < 0) {
        if (!this.streamHeader()) {
          this.done = true;
          break;
        }
        continue;
      }
      const first = this.src.u8('An xz stream');
      if (first === 0) this.index();
      else this.startBlock(first);
    }
    return null;
  }

  private bytes(n: number): Uint8Array {
    return this.src.take(new Uint8Array(n), n, 'An xz stream');
  }

  /** A stream's header, after any padding before it; false at the end of the file. */
  private streamHeader(): boolean {
    let b = this.src.byte();
    // stream padding: zero bytes, four at a time
    let zeros = 0;
    while (b === 0 && this.streams) {
      zeros++;
      b = this.src.byte();
    }
    if (zeros % 4) throw new Error('An xz file is damaged (its padding)');
    if (b < 0) {
      if (!this.streams) throw new Error('Not an xz file');
      return false;
    }
    const rest = this.bytes(11);
    const head = [b, ...rest.subarray(0, 5)];
    if (MAGIC.some((m, i) => head[i] !== m)) throw new Error('Not an xz file');
    if (crc32(rest.subarray(5, 7)) !== le32(rest, 7)) throw new Error('An xz header is damaged');
    if (rest[5] !== 0 || (rest[6] as number) > 0x0f)
      throw new Error('An xz stream with flags this reader doesn’t know');
    this.flags = rest[6] as number;
    this.records = [];
    this.streams++;
    return true;
  }

  private startBlock(first: number): void {
    const size = (first + 1) * 4;
    const header = new Uint8Array(size);
    header[0] = first;
    this.src.take(header.subarray(1), size - 1, 'An xz block header');
    if (crc32(header.subarray(0, size - 4)) !== le32(header, size - 4))
      throw new Error('An xz block header is damaged');
    let at = 1;
    const read = () => {
      if (at >= size - 4) throw new Error('An xz block header is damaged');
      return header[at++] as number;
    };
    const flags = read();
    if (flags & 0x3c) throw new Error('An xz block with flags this reader doesn’t know');
    const filters = (flags & 3) + 1;
    if (flags & 0x40) varint(read);
    if (flags & 0x80) varint(read);
    let dict = 0;
    for (let i = 0; i < filters; i++) {
      const id = varint(read);
      const n = varint(read);
      if (id !== LZMA2 || filters !== 1)
        throw new Error(`An xz block filtered with ${id.toString(16)} isn’t read here (only LZMA2 alone is)`);
      if (n !== 1) throw new Error('An xz block header is damaged');
      dict = lzma2DictSize(read());
    }
    while (at < size - 4) if (read() !== 0) throw new Error('An xz block header is damaged');
    this.block = {
      lzma: new Lzma2Reader(this.src, dict),
      check: check(this.flags),
      start: this.src.taken,
      header: size,
      size: 0,
    };
  }

  private endBlock(b: NonNullable<XzReader['block']>): void {
    const packed = this.src.taken - b.start;
    for (let i = packed; i % 4; i++) if (this.src.u8('An xz block') !== 0) throw new Error('An xz block is damaged');
    const stored = this.bytes(b.check.size);
    if (!b.check.matches(stored)) throw new Error('An xz block is damaged (its check differs)');
    this.records.push([b.header + packed + b.check.size, b.size]);
  }

  /** The stream's index (each block's sizes, checked against what was read), then its footer. */
  private index(): void {
    const start = this.src.taken - 1;
    const parts: number[] = [0];
    const read = () => {
      const v = this.src.u8('An xz index');
      parts.push(v);
      return v;
    };
    const count = varint(read);
    if (count !== this.records.length) throw new Error('An xz index is damaged');
    for (const [unpadded, size] of this.records) {
      if (varint(read) !== unpadded || varint(read) !== size) throw new Error('An xz index is damaged');
    }
    while ((this.src.taken - start) % 4) if (read() !== 0) throw new Error('An xz index is damaged');
    const crc = le32(this.bytes(4), 0);
    if (crc32(Uint8Array.from(parts)) !== crc) throw new Error('An xz index is damaged');
    const indexSize = this.src.taken - start;
    const footer = this.bytes(12);
    if (crc32(footer.subarray(4, 10)) !== le32(footer, 0)) throw new Error('An xz footer is damaged');
    if ((le32(footer, 4) + 1) * 4 !== indexSize) throw new Error('An xz footer is damaged');
    if (footer[8] !== 0 || footer[9] !== this.flags || footer[10] !== FOOTER_MAGIC[0] || footer[11] !== FOOTER_MAGIC[1])
      throw new Error('An xz footer is damaged');
    this.flags = -1;
  }
}

/** A whole xz file, decoded (for small ones; a big one is read a piece at a time). */
export function decodeXz(bytes: Uint8Array): Uint8Array {
  const reader = new XzReader(bytesSource(bytes));
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
