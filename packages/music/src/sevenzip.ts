/**
 * A 7z archive, read: its header (compressed with LZMA by 7-Zip as a rule) and the files in its
 * folders when they are stored, Deflate (Node's zlib), LZMA or LZMA2. Enough for the sample libraries
 * published as one; filters, encryption and the other methods aren't read. Every file's CRC is checked.
 */
import { crc32, inflateRawSync } from 'node:zlib';
import { decodeLzma, decodeLzma2 } from './lzma.ts';

const SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];

// the header's property ids
const END = 0x00;
const HEADER = 0x01;
const ARCHIVE_PROPERTIES = 0x02;
const ADDITIONAL_STREAMS = 0x03;
const MAIN_STREAMS = 0x04;
const FILES = 0x05;
const PACK_INFO = 0x06;
const UNPACK_INFO = 0x07;
const SUBSTREAMS_INFO = 0x08;
const SIZE = 0x09;
const CRC = 0x0a;
const FOLDER = 0x0b;
const UNPACK_SIZE = 0x0c;
const NUM_UNPACK_STREAMS = 0x0d;
const EMPTY_STREAM = 0x0e;
const NAME = 0x11;

interface Coder {
  method: string;
  properties: Uint8Array;
}

interface Folder {
  coders: Coder[];
  /** Index of its first packed stream. */
  pack: number;
  size: number;
  crc: number | null;
  /** The files in it, in order: each one's size and CRC. */
  streams: { size: number; crc: number | null }[];
}

interface Streams {
  packPos: number;
  packSizes: number[];
  folders: Folder[];
}

interface Entry {
  folder: number;
  offset: number;
  size: number;
  crc: number | null;
}

class Reader {
  at = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  u8(): number {
    if (this.at >= this.bytes.length) throw new Error('A 7z header ends early');
    return this.bytes[this.at++] as number;
  }

  u32(): number {
    return this.u8() + this.u8() * 256 + this.u8() * 65536 + this.u8() * 2 ** 24;
  }

  /** 7z's number: as many leading one bits in the first byte as there are bytes after it. */
  number(): number {
    const first = this.u8();
    let mask = 0x80;
    let value = 0;
    for (let i = 0; i < 8; i++) {
      if ((first & mask) === 0) return value + (first & (mask - 1)) * 2 ** (8 * i);
      value += this.u8() * 2 ** (8 * i);
      mask >>= 1;
    }
    return value;
  }

  take(n: number): Uint8Array {
    if (this.at + n > this.bytes.length) throw new Error('A 7z header ends early');
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }

  /** n bits, the first in the high bit of the first byte. */
  bits(n: number): boolean[] {
    const out: boolean[] = [];
    let byte = 0;
    for (let i = 0; i < n; i++) {
      if (i % 8 === 0) byte = this.u8();
      out.push((byte & (0x80 >> (i % 8))) !== 0);
    }
    return out;
  }

  /** n CRCs, some of which may be left out. */
  digests(n: number): (number | null)[] {
    const defined = this.u8() ? Array.from({ length: n }, () => true) : this.bits(n);
    return defined.map((d) => (d ? this.u32() : null));
  }
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function readFolder(r: Reader): Coder[] {
  const n = r.number();
  const coders: Coder[] = [];
  let ins = 0;
  let outs = 0;
  for (let i = 0; i < n; i++) {
    const flags = r.u8();
    if (flags & 0x80) throw new Error('A 7z folder with alternative methods');
    const method = hex(r.take(flags & 0x0f));
    let numIn = 1;
    let numOut = 1;
    if (flags & 0x10) {
      numIn = r.number();
      numOut = r.number();
    }
    const properties = flags & 0x20 ? r.take(r.number()) : new Uint8Array(0);
    coders.push({ method, properties });
    ins += numIn;
    outs += numOut;
  }
  for (let i = 0; i < outs - 1; i++) {
    r.number();
    r.number();
  }
  const packed = ins - (outs - 1);
  if (packed > 1) for (let i = 0; i < packed; i++) r.number();
  if (packed !== 1 || outs !== 1) throw new Error('A 7z folder with more than one stream');
  return coders;
}

function readStreams(r: Reader): Streams {
  const streams: Streams = { packPos: 0, packSizes: [], folders: [] };
  let sizes: number[][] = [];
  for (;;) {
    const id = r.number();
    if (id === END) break;
    if (id === PACK_INFO) {
      streams.packPos = r.number();
      const n = r.number();
      for (;;) {
        const sub = r.number();
        if (sub === END) break;
        if (sub === SIZE) for (let i = 0; i < n; i++) streams.packSizes.push(r.number());
        else if (sub === CRC) r.digests(n);
        else throw new Error('Not a 7z header');
      }
      if (streams.packSizes.length !== n) throw new Error('Not a 7z header');
    } else if (id === UNPACK_INFO) {
      if (r.number() !== FOLDER) throw new Error('Not a 7z header');
      const n = r.number();
      if (r.u8() !== 0) throw new Error('A 7z header kept outside its archive');
      let pack = 0;
      for (let i = 0; i < n; i++) {
        streams.folders.push({ coders: readFolder(r), pack, size: 0, crc: null, streams: [] });
        pack++;
      }
      if (r.number() !== UNPACK_SIZE) throw new Error('Not a 7z header');
      for (const f of streams.folders) f.size = r.number();
      let sub = r.number();
      if (sub === CRC) {
        const crcs = r.digests(n);
        streams.folders.forEach((f, i) => {
          f.crc = crcs[i] as number | null;
        });
        sub = r.number();
      }
      if (sub !== END) throw new Error('Not a 7z header');
    } else if (id === SUBSTREAMS_INFO) {
      const counts = streams.folders.map(() => 1);
      sizes = streams.folders.map(() => []);
      let crcs: (number | null)[] | null = null;
      for (;;) {
        const sub = r.number();
        if (sub === END) break;
        if (sub === NUM_UNPACK_STREAMS) for (let i = 0; i < counts.length; i++) counts[i] = r.number();
        else if (sub === SIZE) {
          for (let i = 0; i < counts.length; i++) {
            for (let j = 0; j < (counts[i] as number) - 1; j++) (sizes[i] as number[]).push(r.number());
          }
        } else if (sub === CRC) {
          let n = 0;
          streams.folders.forEach((f, i) => {
            if (!(counts[i] === 1 && f.crc !== null)) n += counts[i] as number;
          });
          crcs = r.digests(n);
        } else throw new Error('Not a 7z header');
      }
      let next = 0;
      streams.folders.forEach((f, i) => {
        const count = counts[i] as number;
        const known = sizes[i] as number[];
        const total = known.reduce((a, b) => a + b, 0);
        if (count > 0 && total > f.size) throw new Error('Not a 7z header');
        for (let j = 0; j < count; j++) {
          const size = j < count - 1 ? (known[j] as number) : f.size - total;
          let crc: number | null = null;
          if (count === 1 && f.crc !== null) crc = f.crc;
          else if (crcs) crc = (crcs as (number | null)[])[next++] as number | null;
          f.streams.push({ size, crc });
        }
      });
    } else throw new Error('Not a 7z header');
  }
  // without substream information, each folder is one file
  for (const f of streams.folders) if (!f.streams.length) f.streams.push({ size: f.size, crc: f.crc });
  return streams;
}

/** The files' names, and which of them have no data. */
function readFiles(r: Reader): { names: string[]; empty: boolean[] } {
  const n = r.number();
  let names: string[] = [];
  let empty = Array.from({ length: n }, () => false);
  for (;;) {
    const type = r.number();
    if (type === END) break;
    const size = r.number();
    if (type === EMPTY_STREAM) empty = r.bits(n);
    else if (type === NAME) {
      if (r.u8() !== 0) throw new Error('A 7z header kept outside its archive');
      const text = new TextDecoder('utf-16le').decode(r.take(size - 1));
      names = text.split('\0');
      names.pop();
      if (names.length !== n) throw new Error('Not a 7z header');
    } else r.take(size);
  }
  return { names, empty };
}

export class SevenZip {
  private readonly entries = new Map<string, Entry>();
  private readonly streams: Streams;
  private readonly unpacked = new Map<number, Uint8Array>();
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    if (bytes.length < 32 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('Not a 7z archive');
    const head = new Reader(bytes);
    head.at = 8;
    const startCrc = head.u32();
    if (crc32(bytes.subarray(12, 32)) !== startCrc) throw new Error('A 7z archive with a damaged start');
    const offset = head.u32() + head.u32() * 2 ** 32;
    const size = head.u32() + head.u32() * 2 ** 32;
    const crc = head.u32();
    if (32 + offset + size > bytes.length) throw new Error('A 7z archive that ends early');
    let header = bytes.subarray(32 + offset, 32 + offset + size);
    if (crc32(header) !== crc) throw new Error('A 7z archive with a damaged header');
    let r = new Reader(header);
    let id = r.number();
    while (id === 0x17) {
      // an encoded header: one folder, holding the real one
      header = this.unpack(readStreams(r), 0);
      r = new Reader(header);
      id = r.number();
    }
    if (id !== HEADER) throw new Error('Not a 7z header');
    id = r.number();
    if (id === ARCHIVE_PROPERTIES) {
      for (;;) {
        const type = r.number();
        if (type === END) break;
        r.take(r.number());
      }
      id = r.number();
    }
    if (id === ADDITIONAL_STREAMS) throw new Error('A 7z archive with additional streams');
    this.streams = { packPos: 0, packSizes: [], folders: [] };
    if (id === MAIN_STREAMS) {
      this.streams = readStreams(r);
      id = r.number();
    }
    let files: { names: string[]; empty: boolean[] } = { names: [], empty: [] };
    if (id === FILES) {
      files = readFiles(r);
      id = r.number();
    }
    if (id !== END) throw new Error('Not a 7z header');
    // the files with data take the folders' streams in order
    let folder = 0;
    let index = 0;
    let at = 0;
    files.names.forEach((name, i) => {
      if (files.empty[i]) {
        this.entries.set(name, { folder: -1, offset: 0, size: 0, crc: null });
        return;
      }
      while (folder < this.streams.folders.length && index >= (this.streams.folders[folder] as Folder).streams.length) {
        folder++;
        index = 0;
        at = 0;
      }
      const f = this.streams.folders[folder];
      if (!f) throw new Error('A 7z archive with more files than streams');
      const stream = f.streams[index++] as { size: number; crc: number | null };
      this.entries.set(name, { folder, offset: at, size: stream.size, crc: stream.crc });
      at += stream.size;
    });
  }

  /** Every file's name (folders included, with no data). */
  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** One file's bytes, checked against its CRC. */
  read(name: string): Uint8Array {
    const e = this.entries.get(name);
    if (!e) throw new Error(`${name} isn't in the archive`);
    if (e.folder < 0) return new Uint8Array(0);
    let data = this.unpacked.get(e.folder);
    if (!data) {
      data = this.unpack(this.streams, e.folder);
      this.unpacked.set(e.folder, data);
    }
    const out = data.subarray(e.offset, e.offset + e.size);
    if (e.crc !== null && crc32(out) !== e.crc) throw new Error(`${name} is damaged in the archive (its CRC differs)`);
    return out;
  }

  /** A folder's whole unpacked data. */
  private unpack(streams: Streams, index: number): Uint8Array {
    const folder = streams.folders[index];
    if (!folder) throw new Error('Not a 7z header');
    if (folder.coders.length !== 1) throw new Error('A 7z folder with more than one coder isn’t read here');
    const coder = folder.coders[0] as Coder;
    let start = 32 + streams.packPos;
    for (let i = 0; i < folder.pack; i++) start += streams.packSizes[i] as number;
    const end = start + (streams.packSizes[folder.pack] as number);
    if (end > this.bytes.length) throw new Error('A 7z archive that ends early');
    let out: Uint8Array;
    if (coder.method === '00') out = this.bytes.slice(start, end);
    else if (coder.method === '040108') out = new Uint8Array(inflateRawSync(this.bytes.subarray(start, end)));
    else if (coder.method === '030101') out = decodeLzma(this.bytes, start, end, coder.properties, folder.size);
    else if (coder.method === '21') out = decodeLzma2(this.bytes, start, end, folder.size);
    else throw new Error(`A 7z folder compressed with method ${coder.method} isn’t read here`);
    if (out.length !== folder.size) throw new Error('A 7z folder that unpacks to the wrong size');
    if (folder.crc !== null && crc32(out) !== folder.crc) throw new Error('A 7z folder is damaged (its CRC differs)');
    return out;
  }
}
