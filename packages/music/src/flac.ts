/**
 * FLAC, decoded: the format as RFC 9639 lays it out (constant, verbatim, fixed and LPC subframes,
 * Rice-coded residuals, stereo decorrelation), each frame's CRCs checked and the whole against the
 * stream's MD5, to exactly the integers that were encoded. Then a PCM WAV of them laid out as ffmpeg
 * writes one (fmt, an INFO list naming the software, data), so a file converted with ffmpeg once comes
 * out byte for byte the same.
 */
import { createHash } from 'node:crypto';

export interface Pcm {
  rate: number;
  /** Bits a sample (8 to 24). */
  bits: number;
  channels: Int32Array[];
}

const RATES = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];
const BITS = [0, 8, 12, 0, 16, 20, 24, 32];

/** Bits read from the high end of each byte first. */
class Bits {
  at = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get byte(): number {
    return this.at >> 3;
  }

  bits(n: number): number {
    let v = 0;
    while (n > 0) {
      const i = this.at >> 3;
      if (i >= this.bytes.length) throw new Error('A FLAC file ends early');
      const off = this.at & 7;
      const avail = 8 - off;
      const take = n < avail ? n : avail;
      v = v * (1 << take) + (((this.bytes[i] as number) >> (avail - take)) & ((1 << take) - 1));
      this.at += take;
      n -= take;
    }
    return v;
  }

  signed(n: number): number {
    if (n === 0) return 0;
    const v = this.bits(n);
    return v >= 2 ** (n - 1) ? v - 2 ** n : v;
  }

  /** Zero bits up to the next one bit. */
  unary(): number {
    let n = 0;
    for (;;) {
      const i = this.at >> 3;
      if (i >= this.bytes.length) throw new Error('A FLAC file ends early');
      const off = this.at & 7;
      const rest = ((this.bytes[i] as number) << off) & 0xff;
      if (rest === 0) {
        n += 8 - off;
        this.at += 8 - off;
        continue;
      }
      const lead = Math.clz32(rest) - 24;
      this.at += lead + 1;
      return n + lead;
    }
  }

  align(): void {
    this.at = (this.at + 7) & ~7;
  }
}

function table(poly: number, bits: number): Uint16Array | Uint8Array {
  const out = bits === 8 ? new Uint8Array(256) : new Uint16Array(256);
  const top = 1 << (bits - 1);
  const mask = (1 << bits) - 1;
  for (let i = 0; i < 256; i++) {
    let c = i << (bits - 8);
    for (let k = 0; k < 8; k++) c = c & top ? ((c << 1) ^ poly) & mask : (c << 1) & mask;
    out[i] = c;
  }
  return out;
}
const CRC8 = table(0x07, 8);
const CRC16 = table(0x8005, 16);

function crc8(bytes: Uint8Array, from: number, to: number): number {
  let c = 0;
  for (let i = from; i < to; i++) c = CRC8[c ^ (bytes[i] as number)] as number;
  return c;
}

function crc16(bytes: Uint8Array, from: number, to: number): number {
  let c = 0;
  for (let i = from; i < to; i++) c = (CRC16[(c >> 8) ^ (bytes[i] as number)] as number) ^ ((c << 8) & 0xffff);
  return c;
}

function residual(r: Bits, out: Int32Array, order: number, n: number): void {
  const method = r.bits(2);
  if (method > 1) throw new Error('A FLAC residual coded a reserved way');
  const partitionOrder = r.bits(4);
  const paramBits = method === 0 ? 4 : 5;
  const unencoded = (1 << paramBits) - 1;
  const per = n >> partitionOrder;
  if (per << partitionOrder !== n || per < order) throw new Error('A FLAC residual partitioned wrongly');
  let i = order;
  for (let p = 0; p < 1 << partitionOrder; p++) {
    const count = p === 0 ? per - order : per;
    const param = r.bits(paramBits);
    if (param === unencoded) {
      const raw = r.bits(5);
      for (let k = 0; k < count; k++) out[i++] = r.signed(raw);
    } else {
      const scale = 1 << param;
      for (let k = 0; k < count; k++) {
        const v = r.unary() * scale + r.bits(param);
        out[i++] = v & 1 ? -(v + 1) / 2 : v / 2;
      }
    }
  }
}

function subframe(r: Bits, n: number, depth: number): Int32Array {
  if (r.bits(1) !== 0) throw new Error('A FLAC subframe without its padding bit');
  const type = r.bits(6);
  const wasted = r.bits(1) ? r.unary() + 1 : 0;
  const bps = depth - wasted;
  const out = new Int32Array(n);
  if (type === 0) out.fill(r.signed(bps));
  else if (type === 1) for (let i = 0; i < n; i++) out[i] = r.signed(bps);
  else if (type >= 8 && type <= 12) {
    const order = type - 8;
    for (let i = 0; i < order; i++) out[i] = r.signed(bps);
    residual(r, out, order, n);
    for (let i = order; i < n; i++) {
      const a = out[i - 1] as number;
      const b = out[i - 2] as number;
      const c = out[i - 3] as number;
      const d = out[i - 4] as number;
      const e = out[i] as number;
      if (order === 1) out[i] = e + a;
      else if (order === 2) out[i] = e + 2 * a - b;
      else if (order === 3) out[i] = e + 3 * a - 3 * b + c;
      else if (order === 4) out[i] = e + 4 * a - 6 * b + 4 * c - d;
    }
  } else if (type >= 32) {
    const order = type - 31;
    for (let i = 0; i < order; i++) out[i] = r.signed(bps);
    const precision = r.bits(4) + 1;
    if (precision === 16) throw new Error('A FLAC predictor with a reserved precision');
    const shift = r.signed(5);
    if (shift < 0) throw new Error('A FLAC predictor with a negative shift');
    const coefficients = new Array<number>(order);
    for (let i = 0; i < order; i++) coefficients[i] = r.signed(precision);
    residual(r, out, order, n);
    const scale = 2 ** shift;
    for (let i = order; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < order; j++) sum += (coefficients[j] as number) * (out[i - 1 - j] as number);
      out[i] = (out[i] as number) + Math.floor(sum / scale);
    }
  } else throw new Error('A FLAC subframe of a reserved type');
  if (wasted) {
    const scale = 2 ** wasted;
    for (let i = 0; i < n; i++) out[i] = (out[i] as number) * scale;
  }
  return out;
}

/** A FLAC file's samples as the integers that were encoded. */
export function decodeFlac(bytes: Uint8Array): Pcm {
  if (bytes.length < 42 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'fLaC') throw new Error('Not a FLAC file');
  const r = new Bits(bytes);
  r.at = 32;
  let rate = 0;
  let count = 0;
  let bits = 0;
  let total = 0;
  let md5: Uint8Array | null = null;
  // the metadata blocks: STREAMINFO first, the rest skipped
  for (let last = false; !last; ) {
    last = r.bits(1) === 1;
    const type = r.bits(7);
    const size = r.bits(24);
    if (type === 0) {
      r.bits(16);
      r.bits(16);
      r.bits(24);
      r.bits(24);
      rate = r.bits(20);
      count = r.bits(3) + 1;
      bits = r.bits(5) + 1;
      total = r.bits(36);
      md5 = bytes.slice(r.byte, r.byte + 16);
      r.at += 128;
    } else r.at += size * 8;
  }
  if (!rate || !bits) throw new Error('A FLAC file without its stream information');
  if (bits > 24) throw new Error(`FLAC at ${bits} bits a sample isn't read here`);
  const blocks: Int32Array[][] = Array.from({ length: count }, () => []);
  const hash = createHash('md5');
  const width = Math.ceil(bits / 8);
  let decoded = 0;
  while (r.byte < bytes.length) {
    const start = r.byte;
    if (r.bits(14) !== 0x3ffe || r.bits(1) !== 0) throw new Error('A FLAC frame out of sync');
    r.bits(1);
    const sizeCode = r.bits(4);
    const rateCode = r.bits(4);
    const channelCode = r.bits(4);
    const depthCode = r.bits(3);
    if (r.bits(1) !== 0) throw new Error('A FLAC frame out of sync');
    // the frame or sample number, coded as UTF-8 codes its characters
    const first = r.bits(8);
    const extra =
      first < 0x80
        ? 0
        : first < 0xc0
          ? -1
          : first < 0xe0
            ? 1
            : first < 0xf0
              ? 2
              : first < 0xf8
                ? 3
                : first < 0xfc
                  ? 4
                  : first < 0xfe
                    ? 5
                    : 6;
    if (extra < 0) throw new Error('A FLAC frame with a bad number');
    for (let i = 0; i < extra; i++) if ((r.bits(8) & 0xc0) !== 0x80) throw new Error('A FLAC frame with a bad number');
    let n: number;
    if (sizeCode === 0) throw new Error('A FLAC frame of a reserved size');
    else if (sizeCode === 1) n = 192;
    else if (sizeCode <= 5) n = 576 << (sizeCode - 2);
    else if (sizeCode === 6) n = r.bits(8) + 1;
    else if (sizeCode === 7) n = r.bits(16) + 1;
    else n = 256 << (sizeCode - 8);
    let frameRate = rate;
    if (rateCode === 12) frameRate = r.bits(8) * 1000;
    else if (rateCode === 13) frameRate = r.bits(16);
    else if (rateCode === 14) frameRate = r.bits(16) * 10;
    else if (rateCode === 15) throw new Error('A FLAC frame of a reserved rate');
    else if (rateCode) frameRate = RATES[rateCode] as number;
    if (frameRate !== rate) throw new Error('A FLAC frame at another rate');
    const channels = channelCode < 8 ? channelCode + 1 : channelCode < 11 ? 2 : 0;
    if (!channels || channels !== count) throw new Error('A FLAC frame with other channels');
    const depth = depthCode === 0 ? bits : (BITS[depthCode] as number);
    if (!depth || depth !== bits) throw new Error('A FLAC frame at another depth');
    const crc = r.bits(8);
    if (crc8(bytes, start, r.byte - 1) !== crc) throw new Error('A FLAC frame header is damaged (its CRC differs)');
    const frame: Int32Array[] = [];
    for (let c = 0; c < channels; c++) {
      const side = (channelCode === 8 && c === 1) || (channelCode === 9 && c === 0) || (channelCode === 10 && c === 1);
      frame.push(subframe(r, n, depth + (side ? 1 : 0)));
    }
    r.align();
    const check = r.bits(16);
    if (crc16(bytes, start, r.byte - 2) !== check) throw new Error('A FLAC frame is damaged (its CRC differs)');
    const [left, right] = frame as [Int32Array, Int32Array];
    if (channelCode === 8) for (let i = 0; i < n; i++) right[i] = (left[i] as number) - (right[i] as number);
    else if (channelCode === 9) for (let i = 0; i < n; i++) left[i] = (left[i] as number) + (right[i] as number);
    else if (channelCode === 10) {
      for (let i = 0; i < n; i++) {
        const side = right[i] as number;
        const mid = (left[i] as number) * 2 + (side & 1);
        left[i] = (mid + side) / 2;
        right[i] = (mid - side) / 2;
      }
    }
    for (let c = 0; c < channels; c++) (blocks[c] as Int32Array[]).push(frame[c] as Int32Array);
    const bytesOut = Buffer.alloc(n * channels * width);
    for (let i = 0, p = 0; i < n; i++) {
      for (let c = 0; c < channels; c++, p += width)
        bytesOut.writeIntLE((frame[c] as Int32Array)[i] as number, p, width);
    }
    hash.update(bytesOut);
    decoded += n;
    if (total && decoded >= total) break;
  }
  if (total && decoded !== total) throw new Error('A FLAC file with other than its number of samples');
  if (md5?.some((b) => b) && !Buffer.from(hash.digest()).equals(md5))
    throw new Error("A FLAC file's samples don't match its MD5");
  const out = blocks.map((list) => {
    const ch = new Int32Array(decoded);
    let at = 0;
    for (const b of list) {
      ch.set(b, at);
      at += b.length;
    }
    return ch;
  });
  return { rate, bits, channels: out };
}

/**
 * Integer samples as a PCM WAV, laid out as ffmpeg writes one: fmt (16 bytes, or the extensible form
 * ffmpeg uses past 16 bits), then, when the software is named, an INFO list with that ISFT tag, then
 * the data. 8-bit samples are unsigned, as WAV has them.
 */
export function pcmWav(pcm: Pcm, software?: string): Uint8Array {
  const { rate, bits, channels } = pcm;
  if (bits !== 8 && bits !== 16 && bits !== 24) throw new Error(`A ${bits}-bit WAV isn't written here`);
  if (channels.length < 1 || channels.length > 2) throw new Error('Only mono and stereo WAVs are written here');
  const width = bits / 8;
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * channels.length * width;
  const extensible = bits > 16;
  const fmt = extensible ? 40 : 16;
  const tag = software === undefined ? null : Buffer.from(`${software}\0`, 'latin1');
  const tagBytes = tag ? tag.length + (tag.length & 1) : 0;
  const list = tag ? 8 + 4 + 8 + tagBytes : 0;
  const out = Buffer.alloc(12 + 8 + fmt + list + 8 + dataBytes + (dataBytes & 1));
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WAVE', 8, 'latin1');
  out.write('fmt ', 12, 'latin1');
  out.writeUInt32LE(fmt, 16);
  out.writeUInt16LE(extensible ? 0xfffe : 1, 20);
  out.writeUInt16LE(channels.length, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * channels.length * width, 28);
  out.writeUInt16LE(channels.length * width, 32);
  out.writeUInt16LE(bits, 34);
  let at = 36;
  if (extensible) {
    out.writeUInt16LE(22, at);
    out.writeUInt16LE(bits, at + 2);
    out.writeUInt32LE(channels.length === 1 ? 0x4 : 0x3, at + 4);
    // the PCM subformat's GUID
    Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(out, at + 8);
    at += 24;
  }
  if (tag) {
    out.write('LIST', at, 'latin1');
    out.writeUInt32LE(list - 8, at + 4);
    out.write('INFO', at + 8, 'latin1');
    out.write('ISFT', at + 12, 'latin1');
    out.writeUInt32LE(tag.length, at + 16);
    tag.copy(out, at + 20);
    at += list;
  }
  out.write('data', at, 'latin1');
  out.writeUInt32LE(dataBytes, at + 4);
  at += 8;
  for (let i = 0; i < frames; i++) {
    for (const ch of channels) {
      const v = ch[i] as number;
      if (width === 1) out[at] = v + 128;
      else out.writeIntLE(v, at, width);
      at += width;
    }
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}
