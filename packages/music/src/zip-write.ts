/**
 * A ZIP archive written to a file, one entry after another: what a song's stems are handed over in.
 * Entries are stored as they are (a WAV hardly packs, and nothing has to unpack it), each written
 * and let go before the next, so an archive of many long files costs the memory of one. ZIP64 where
 * it's needed: an archive past 4 GB, or more than 65,535 entries.
 */
import { closeSync, openSync, writeSync } from 'node:fs';
import { crc32 } from 'node:zlib';

const FOUR_GB = 0xffffffff;

interface Entry {
  name: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

export interface ZipWriterOptions {
  /** Write the ZIP64 records whatever the archive's size (for a test: a real one needs over 4 GB). */
  zip64?: boolean;
}

export class ZipWriter {
  private readonly fd: number;
  private readonly zip64: boolean;
  private at = 0;
  private readonly entries: Entry[] = [];
  private closed = false;

  constructor(path: string, options: ZipWriterOptions = {}) {
    this.fd = openSync(path, 'w');
    this.zip64 = options.zip64 === true;
  }

  private write(bytes: Uint8Array): void {
    let done = 0;
    while (done < bytes.length) done += writeSync(this.fd, bytes, done, bytes.length - done);
    this.at += bytes.length;
  }

  /** A file into the archive, under a name (forward slashes for folders). `when`: the time it's stamped with. */
  add(name: string, bytes: Uint8Array, when: Date = new Date()): void {
    if (this.closed) throw new Error('The archive is closed');
    if (bytes.length >= FOUR_GB) throw new Error(`${name} is too large for one file of an archive (4 GB)`);
    const named = new TextEncoder().encode(name.replace(/\\/g, '/').replace(/^\/+/, ''));
    if (!named.length || named.length > 0xffff) throw new Error('A file in an archive needs a name');
    const entry: Entry = {
      name: named,
      crc: crc32(bytes),
      size: bytes.length,
      offset: this.at,
      // (MS-DOS's time and date: two seconds to a step, years from 1980)
      time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
      date: (Math.max(0, when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
    };
    const head = new Uint8Array(30 + named.length);
    const v = new DataView(head.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, 0x0800, true); // the name is UTF-8
    v.setUint16(8, 0, true); // stored
    v.setUint16(10, entry.time, true);
    v.setUint16(12, entry.date, true);
    v.setUint32(14, entry.crc, true);
    v.setUint32(18, entry.size, true);
    v.setUint32(22, entry.size, true);
    v.setUint16(26, named.length, true);
    v.setUint16(28, 0, true);
    head.set(named, 30);
    this.write(head);
    this.write(bytes);
    this.entries.push(entry);
  }

  /** How many files it holds so far, and how long it is. */
  get count(): number {
    return this.entries.length;
  }

  get size(): number {
    return this.at;
  }

  /** The archive's directory and end: nothing more goes in. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      const start = this.at;
      for (const e of this.entries) {
        const far = this.zip64 || e.offset >= FOUR_GB;
        const extra = far ? 12 : 0;
        const head = new Uint8Array(46 + e.name.length + extra);
        const v = new DataView(head.buffer);
        v.setUint32(0, 0x02014b50, true);
        v.setUint16(4, far ? 45 : 20, true);
        v.setUint16(6, far ? 45 : 20, true);
        v.setUint16(8, 0x0800, true);
        v.setUint16(10, 0, true);
        v.setUint16(12, e.time, true);
        v.setUint16(14, e.date, true);
        v.setUint32(16, e.crc, true);
        v.setUint32(20, e.size, true);
        v.setUint32(24, e.size, true);
        v.setUint16(28, e.name.length, true);
        v.setUint16(30, extra, true);
        v.setUint32(42, far ? FOUR_GB : e.offset, true);
        head.set(e.name, 46);
        if (far) {
          // the ZIP64 extra field: where the file starts, which didn't fit above
          const x = 46 + e.name.length;
          v.setUint16(x, 0x0001, true);
          v.setUint16(x + 2, 8, true);
          v.setUint32(x + 4, e.offset >>> 0, true);
          v.setUint32(x + 8, Math.floor(e.offset / 2 ** 32), true);
        }
        this.write(head);
      }
      const size = this.at - start;
      const count = this.entries.length;
      const big = this.zip64 || count >= 0xffff || size >= FOUR_GB || start >= FOUR_GB;
      if (big) {
        const u64 = (v: DataView, at: number, n: number) => {
          v.setUint32(at, n >>> 0, true);
          v.setUint32(at + 4, Math.floor(n / 2 ** 32), true);
        };
        const recordAt = this.at;
        const rec = new Uint8Array(56 + 20);
        const v = new DataView(rec.buffer);
        v.setUint32(0, 0x06064b50, true);
        u64(v, 4, 44);
        v.setUint16(12, 45, true);
        v.setUint16(14, 45, true);
        u64(v, 24, count);
        u64(v, 32, count);
        u64(v, 40, size);
        u64(v, 48, start);
        // its locator: where that record is
        v.setUint32(56, 0x07064b50, true);
        u64(v, 64, recordAt);
        v.setUint32(72, 1, true);
        this.write(rec);
      }
      const end = new Uint8Array(22);
      const v = new DataView(end.buffer);
      v.setUint32(0, 0x06054b50, true);
      v.setUint16(8, Math.min(count, 0xffff), true);
      v.setUint16(10, Math.min(count, 0xffff), true);
      v.setUint32(12, big ? FOUR_GB : size, true);
      v.setUint32(16, big ? FOUR_GB : start, true);
      this.write(end);
    } finally {
      closeSync(this.fd);
    }
  }
}
