/**
 * PNGs, read and written with Node's zlib and nothing else: a scan's strips as the studio saved them
 * (8 bits a sample, not interlaced: grey, grey and alpha, colour, colour and alpha; or a palette's
 * picture, as written here), read into grey; a picture written back for the agent to see, in colour
 * or, far smaller, in a palette's few colours.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import type { Gray, Indexed, Rgb } from '@holo/score';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG as grey (light 255): colour weighted as the eye sees it, alpha laid on white. */
export function readPngGray(png: Buffer): Gray {
  if (png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG');
  let at = 8;
  let w = 0;
  let h = 0;
  let type = 0;
  let depth = 8;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];
  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at);
    const kind = png.toString('ascii', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (kind === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      depth = body[8] as number;
      type = body[9] as number;
      const known = type === 3 ? [1, 2, 4, 8].includes(depth) : depth === 8 && [0, 2, 4, 6].includes(type);
      if (!known || body[12] !== 0)
        throw new Error('Only 8-bit grey or colour PNGs, and palette ones, not interlaced, are read here');
    } else if (kind === 'PLTE') palette = Buffer.from(body);
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    at += 12 + length;
  }
  // (a strip is a few thousand pixels a side: anything far bigger isn't one)
  if (!w || !h || w * h > 50_000_000) throw new Error(`A ${w}×${h} PNG isn’t a strip read here`);
  if (type === 3 && !palette) throw new Error('The PNG has no palette');
  // (a palette's pixels are packed, a byte the unit its rows are filtered by)
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type] as number;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = type === 3 ? Math.ceil((w * depth) / 8) : w * channels;
  if (raw.length < (stride + 1) * h) throw new Error('The PNG’s picture is cut short');
  const rows = new Uint8Array(stride * h);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)] as number;
    if (filter > 4) throw new Error(`The PNG’s row ${y} has an unknown filter (${filter})`);
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    const up = y ? rows.subarray((y - 1) * stride, y * stride) : prev;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (out[i - channels] as number) : 0;
      const b = up[i] as number;
      const c = i >= channels ? (up[i - channels] as number) : 0;
      const x = line[i] as number;
      let v = x;
      if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[i] = v & 0xff;
    }
  }
  const data = new Uint8Array(w * h);
  if (type === 3) {
    const colours = palette as Buffer;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const bit = x * depth;
        const byte = rows[y * stride + (bit >> 3)] as number;
        const p = ((byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1)) * 3;
        if (p + 2 >= colours.length) throw new Error('The PNG names a colour its palette doesn’t have');
        data[y * w + x] = Math.round(
          0.299 * (colours[p] as number) + 0.587 * (colours[p + 1] as number) + 0.114 * (colours[p + 2] as number),
        );
      }
    }
    return { w, h, data };
  }
  for (let i = 0; i < w * h; i++) {
    const p = i * channels;
    let v: number;
    if (channels <= 2) v = rows[p] as number;
    else v = 0.299 * (rows[p] as number) + 0.587 * (rows[p + 1] as number) + 0.114 * (rows[p + 2] as number);
    if (channels === 2 || channels === 4) {
      const alpha = (rows[p + channels - 1] as number) / 255;
      v = v * alpha + 255 * (1 - alpha);
    }
    data[i] = Math.round(v);
  }
  return { w, h, data };
}

function chunk(kind: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length);
  head.write(kind, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
  return Buffer.concat([head, body, crc]);
}

/** A picture in colour as a PNG. */
export function writePngRgb(img: Rgb): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w);
  ihdr.writeUInt32BE(img.h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const stride = img.w * 3;
  const raw = Buffer.alloc((stride + 1) * img.h);
  for (let y = 0; y < img.h; y++) raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

/**
 * A picture of a palette's few colours as a PNG: one, two or four bits a pixel (eight past sixteen
 * colours), packed as tightly as they'll go. A page of ink on paper comes out a twentieth the size
 * of the same picture in colour.
 */
export function writePngIndexed(img: Indexed): Buffer {
  const n = img.palette.length;
  if (n < 1 || n > 256) throw new Error('A palette has 1 to 256 colours');
  const depth = n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w);
  ihdr.writeUInt32BE(img.h, 4);
  ihdr.set([depth, 3, 0, 0, 0], 8);
  const stride = Math.ceil((img.w * depth) / 8);
  const raw = Buffer.alloc((stride + 1) * img.h);
  for (let y = 0; y < img.h; y++) {
    const row = y * (stride + 1) + 1;
    for (let x = 0; x < img.w; x++) {
      const bit = x * depth;
      raw[row + (bit >> 3)] =
        (raw[row + (bit >> 3)] as number) | ((img.data[y * img.w + x] as number) << (8 - depth - (bit & 7)));
    }
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('PLTE', Buffer.from(img.palette.flat())),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
