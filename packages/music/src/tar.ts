/**
 * A tar archive, read as it streams past: POSIX (ustar and pax) and GNU headers, long names either
 * way, sizes past 8 GB. Each header's checksum is checked. Only the files asked for are kept (each
 * whole, as it ends); the rest stream by.
 */

export interface TarEntry {
  name: string;
  data: Uint8Array;
}

const BLOCK = 512;

const text = (b: Uint8Array) => {
  const end = b.indexOf(0);
  return new TextDecoder().decode(end < 0 ? b : b.subarray(0, end));
};

/** A header's number: octal digits, or (GNU, past 8 GB) base 256 when its first byte's top bit is set. */
function number(b: Uint8Array): number {
  if ((b[0] as number) & 0x80) {
    let v = (b[0] as number) & 0x7f;
    for (let i = 1; i < b.length; i++) v = v * 256 + (b[i] as number);
    return v;
  }
  const s = text(b).trim();
  if (s && !/^[0-7]+$/.test(s)) throw new Error('A tar header is damaged');
  return s ? Number.parseInt(s, 8) : 0;
}

/** pax records ("<length> <key>=<value>\n"), as a map. */
function pax(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const len = Number.parseInt(new TextDecoder().decode(data.subarray(at, space)), 10);
    if (!(len > 0) || at + len > data.length) throw new Error('A tar pax header is damaged');
    const record = new TextDecoder().decode(data.subarray(space + 1, at + len - 1));
    const eq = record.indexOf('=');
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    at += len;
  }
  return out;
}

export class TarReader {
  private readonly want: (name: string) => boolean;
  private readonly header = new Uint8Array(BLOCK);
  private headerAt = 0;
  /** The entry whose data is streaming past: its bytes left, and where they go (null: nowhere). */
  private entry: {
    name: string;
    type: string;
    size: number;
    left: number;
    pad: number;
    data: Uint8Array | null;
  } | null = null;
  /** A long name (GNU or pax) for the next entry, and its pax size. */
  private longName: string | null = null;
  private paxSize: number | null = null;
  private zeros = 0;
  private ended = false;

  constructor(want: (name: string) => boolean = () => true) {
    this.want = want;
  }

  /** The next bytes; the wanted files they complete. */
  push(chunk: Uint8Array): TarEntry[] {
    const out: TarEntry[] = [];
    let at = 0;
    while (at < chunk.length && !this.ended) {
      const e = this.entry;
      if (e) {
        if (e.left > 0) {
          const n = Math.min(e.left, chunk.length - at);
          if (e.data) e.data.set(chunk.subarray(at, at + n), e.size - e.left);
          e.left -= n;
          at += n;
          if (e.left > 0) continue;
          this.finish(e, out);
        }
        const skip = Math.min(e.pad, chunk.length - at);
        e.pad -= skip;
        at += skip;
        if (e.pad === 0) this.entry = null;
        continue;
      }
      const n = Math.min(BLOCK - this.headerAt, chunk.length - at);
      this.header.set(chunk.subarray(at, at + n), this.headerAt);
      this.headerAt += n;
      at += n;
      if (this.headerAt === BLOCK) {
        this.headerAt = 0;
        this.readHeader(out);
      }
    }
    return out;
  }

  /** The archive has ended: it mustn't have stopped inside a file. */
  end(): void {
    if (this.entry || this.headerAt) throw new Error('A tar archive ends early');
    if (!this.ended && this.zeros === 0) throw new Error('A tar archive ends early');
  }

  private readHeader(out: TarEntry[]): void {
    const h = this.header;
    if (h.every((b) => b === 0)) {
      // two empty blocks end the archive
      if (++this.zeros === 2) this.ended = true;
      return;
    }
    this.zeros = 0;
    const stored = number(h.subarray(148, 156));
    let unsigned = 0;
    let signed = 0;
    for (let i = 0; i < BLOCK; i++) {
      const b = i >= 148 && i < 156 ? 0x20 : (h[i] as number);
      unsigned += b;
      signed += b > 127 ? b - 256 : b;
    }
    if (stored !== unsigned && stored !== signed) throw new Error('A tar header is damaged (its checksum differs)');
    const type = String.fromCharCode(h[156] as number);
    const ustar = text(h.subarray(257, 263)) === 'ustar' && h[262] === 0;
    let name = text(h.subarray(0, 100));
    if (ustar) {
      const prefix = text(h.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
    }
    if (this.longName !== null) name = this.longName;
    const size = this.paxSize ?? number(h.subarray(124, 136));
    const meta = type === 'L' || type === 'x' || type === 'K' || type === 'g';
    if (!meta) {
      this.longName = null;
      this.paxSize = null;
    }
    const file = type === '0' || type === '\0' || type === '7';
    const keep = meta ? type === 'L' || type === 'x' : file && this.want(name);
    const entry = {
      name,
      type,
      size,
      left: size,
      pad: (BLOCK - (size % BLOCK)) % BLOCK,
      data: keep ? new Uint8Array(size) : null,
    };
    this.entry = entry;
    if (size === 0) {
      this.finish(entry, out);
      this.entry = null;
    }
  }

  private finish(e: NonNullable<TarReader['entry']>, out: TarEntry[]): void {
    if (e.type === 'L' && e.data) this.longName = text(e.data);
    else if (e.type === 'x' && e.data) {
      const p = pax(e.data);
      const path = p.get('path');
      if (path !== undefined) this.longName = path;
      const size = p.get('size');
      if (size !== undefined) this.paxSize = Number.parseInt(size, 10);
    } else if (e.data) out.push({ name: e.name, data: e.data });
  }
}

/** Every file in a tar archive held in memory (for small ones). */
export function readTar(bytes: Uint8Array, want?: (name: string) => boolean): TarEntry[] {
  const reader = new TarReader(want);
  const out = reader.push(bytes);
  reader.end();
  return out;
}
