/**
 * PNGs, read and written with Node's zlib and nothing else: a scan's strips as the studio saved them
 * (8 bits a sample, not interlaced: grey, grey and alpha, colour, colour and alpha), read into grey;
 * a picture in colour written back, for the agent to see.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import type { Gray, Rgb } from '@holo/score';

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
  const idat: Buffer[] = [];
  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at);
    const kind = png.toString('ascii', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (kind === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      const depth = body[8];
      type = body[9] as number;
      if (depth !== 8 || body[12] !== 0 || ![0, 2, 4, 6].includes(type))
        throw new Error('Only 8-bit, non-interlaced grey or colour PNGs are read here');
    } else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    at += 12 + length;
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[type] as number;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const rows = new Uint8Array(stride * h);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)] as number;
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
