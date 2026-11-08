/**
 * A ZIP archive, read from its central directory (ZIP64 too, so an archive of many gigabytes, or a
 * file in it over 4 GB, reads the same), a file at a time from disk: it is never held whole. Files
 * stored or deflated are read; each one's CRC is checked. Names not marked UTF-8 are read as the
 * IBM PC's code page 437, as the format says.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { crc32, inflateRawSync } from 'node:zlib';

/** Bytes read at any place: a file on disk, or bytes in memory. */
export interface RandomAccess {
  size: number;
  read(at: number, n: number): Uint8Array;
  close?(): void;
}

export function bytesAccess(bytes: Uint8Array): RandomAccess {
  return { size: bytes.length, read: (at, n) => bytes.subarray(at, Math.min(bytes.length, at + n)) };
}

export function fileAccess(path: string): RandomAccess {
  const fd = openSync(path, 'r');
  return {
    size: fstatSync(fd).size,
    read(at, n) {
      const out = new Uint8Array(n);
      let got = 0;
      while (got < n) {
        const k = readSync(fd, out, got, n - got, at + got);
        if (k <= 0) break;
        got += k;
      }
      return out.subarray(0, got);
    },
    close: () => closeSync(fd),
  };
}

const CP437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function name(bytes: Uint8Array, utf8: boolean): string {
  if (utf8 || bytes.every((b) => b < 0x80)) return new TextDecoder().decode(bytes);
  return Array.from(bytes, (b) => (b < 0x80 ? String.fromCharCode(b) : (CP437[b - 0x80] as string))).join('');
}

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  packed: number;
  size: number;
  /** Where its local header is. */
  offset: number;
}

const u16 = (v: DataView, at: number) => v.getUint16(at, true);
const u32 = (v: DataView, at: number) => v.getUint32(at, true);
const u64 = (v: DataView, at: number) => v.getUint32(at, true) + v.getUint32(at + 4, true) * 2 ** 32;
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export class ZipFile {
  private readonly file: RandomAccess;
  private readonly entries = new Map<string, ZipEntry>();

  constructor(file: RandomAccess) {
    this.file = file;
    // the end of central directory record: in the last 64 kB (its comment can be that long)
    const tailSize = Math.min(file.size, 65557);
    const tail = file.read(file.size - tailSize, tailSize);
    const tv = view(tail);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (u32(tv, i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a ZIP archive');
    let count = u16(tv, eocd + 10);
    let cdSize = u32(tv, eocd + 12);
    let cdOffset = u32(tv, eocd + 16);
    if (u16(tv, eocd + 4) !== 0 || u16(tv, eocd + 6) !== 0) throw new Error('A ZIP archive split over several disks');
    // ZIP64: its locator just before, pointing at the real record
    const locAt = file.size - tailSize + eocd - 20;
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff || locAt >= 0) {
      const loc = locAt >= 0 ? file.read(locAt, 20) : new Uint8Array(0);
      if (loc.length === 20 && u32(view(loc), 0) === 0x07064b50) {
        const at = u64(view(loc), 8);
        const rec = file.read(at, 56);
        const rv = view(rec);
        if (rec.length < 56 || u32(rv, 0) !== 0x06064b50) throw new Error('A ZIP64 archive is damaged');
        count = u64(rv, 32);
        cdSize = u64(rv, 40);
        cdOffset = u64(rv, 48);
      } else if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
        throw new Error('A ZIP64 archive is damaged (no locator)');
      }
    }
    if (cdOffset + cdSize > file.size) throw new Error('A ZIP archive that ends early');
    const cd = file.read(cdOffset, cdSize);
    const cv = view(cd);
    let at = 0;
    for (let i = 0; i < count; i++) {
      if (at + 46 > cd.length || u32(cv, at) !== 0x02014b50) throw new Error('A ZIP archive is damaged');
      const flags = u16(cv, at + 8);
      const method = u16(cv, at + 10);
      const crc = u32(cv, at + 16);
      let packed = u32(cv, at + 20);
      let size = u32(cv, at + 24);
      const nameLen = u16(cv, at + 28);
      const extraLen = u16(cv, at + 30);
      const commentLen = u16(cv, at + 32);
      let offset = u32(cv, at + 42);
      const n = name(cd.subarray(at + 46, at + 46 + nameLen), (flags & 0x800) !== 0);
      // the ZIP64 extra field: the sizes and offset that didn't fit, in that order
      let e = at + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = u16(cv, e);
        const len = u16(cv, e + 2);
        if (id === 0x0001) {
          let p = e + 4;
          if (size === 0xffffffff) {
            size = u64(cv, p);
            p += 8;
          }
          if (packed === 0xffffffff) {
            packed = u64(cv, p);
            p += 8;
          }
          if (offset === 0xffffffff) offset = u64(cv, p);
        }
        e += 4 + len;
      }
      at = end + commentLen;
      if (n.endsWith('/')) continue;
      this.entries.set(n, { name: n, method, flags, crc, packed, size, offset });
    }
  }

  /** Every file's name, in the order the archive has them. */
  names(): string[] {
    return [...this.entries.values()].sort((a, b) => a.offset - b.offset).map((e) => e.name);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** One file's bytes, checked against its CRC. */
  read(name: string): Uint8Array {
    const e = this.entries.get(name);
    if (!e) throw new Error(`${name} isn't in the archive`);
    if (e.flags & 1) throw new Error(`${name} is encrypted in the archive`);
    const local = this.file.read(e.offset, 30);
    const lv = view(local);
    if (local.length < 30 || u32(lv, 0) !== 0x04034b50) throw new Error(`${name}: a ZIP archive is damaged`);
    const start = e.offset + 30 + u16(lv, 26) + u16(lv, 28);
    const packed = this.file.read(start, e.packed);
    if (packed.length !== e.packed) throw new Error('A ZIP archive that ends early');
    let out: Uint8Array;
    if (e.method === 0) out = packed;
    else if (e.method === 8) out = new Uint8Array(inflateRawSync(packed));
    else
      throw new Error(`${name} is compressed with method ${e.method}, which isn’t read here (only stored and deflate)`);
    if (out.length !== e.size) throw new Error(`${name} is damaged in the archive (its size differs)`);
    if (crc32(out) !== e.crc) throw new Error(`${name} is damaged in the archive (its CRC differs)`);
    return out;
  }

  close(): void {
    this.file.close?.();
  }
}
