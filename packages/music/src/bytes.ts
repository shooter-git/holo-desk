/**
 * Bytes read in order, from memory or a file, a piece at a time: what the bzip2 and xz decoders read
 * an archive through, so one of several gigabytes never has to be held whole.
 */
import { closeSync, openSync, readSync } from 'node:fs';

export interface ByteSource {
  /** Fill `into` from the front with the next bytes; how many (0 once there are none left). */
  read(into: Uint8Array): number;
}

/** Bytes in memory, read in order. */
export function bytesSource(bytes: Uint8Array): ByteSource {
  let at = 0;
  return {
    read(into) {
      const n = Math.min(into.length, bytes.length - at);
      into.set(bytes.subarray(at, at + n));
      at += n;
      return n;
    },
  };
}

/** A file read in order (close it when done). */
export function fileSource(path: string): ByteSource & { close(): void } {
  const fd = openSync(path, 'r');
  return {
    read: (into) => readSync(fd, into, 0, into.length, null),
    close: () => closeSync(fd),
  };
}

/** A byte source with a buffer in front, read a byte or a run at a time. */
export class ByteReader {
  private readonly source: ByteSource;
  private readonly buf: Uint8Array;
  private at = 0;
  private end = 0;
  /** Bytes taken so far. */
  taken = 0;

  constructor(source: ByteSource, size = 1 << 16) {
    this.source = source;
    this.buf = new Uint8Array(size);
  }

  private fill(): boolean {
    if (this.at < this.end) return true;
    this.end = this.source.read(this.buf);
    this.at = 0;
    return this.end > 0;
  }

  /** The next byte, or -1 at the end. */
  byte(): number {
    if (this.at >= this.end && !this.fill()) return -1;
    this.taken++;
    return this.buf[this.at++] as number;
  }

  /** The next byte, which must be there. */
  u8(what = 'The data'): number {
    const b = this.byte();
    if (b < 0) throw new Error(`${what} ends early`);
    return b;
  }

  /** The next n bytes into `into` (from its front), all of which must be there. */
  take(into: Uint8Array, n = into.length, what = 'The data'): Uint8Array {
    let got = 0;
    while (got < n) {
      if (this.at >= this.end && !this.fill()) throw new Error(`${what} ends early`);
      const k = Math.min(n - got, this.end - this.at);
      into.set(this.buf.subarray(this.at, this.at + k), got);
      this.at += k;
      got += k;
    }
    this.taken += n;
    return into.subarray(0, n);
  }

  /** Whether any bytes are left. */
  more(): boolean {
    return this.fill();
  }
}
