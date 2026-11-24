import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readPngGray, writePngIndexed, writePngRgb } from '../src/tools/png.ts';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(kind: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length);
  head.write(kind, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
  return Buffer.concat([head, body, crc]);
}

/** A PNG of `channels` (1 grey, 2 grey+alpha, 3 colour, 4 colour+alpha), each row with a filter of its own (0–4). */
function png(w: number, h: number, channels: number, pixel: (x: number, y: number) => number[]): Buffer {
  const type = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels] as number;
  const stride = w * channels;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < h; y++) {
    const row = new Uint8Array(stride);
    for (let x = 0; x < w; x++) row.set(pixel(x, y), x * channels);
    rows.push(row);
  }
  const raw: number[] = [];
  rows.forEach((row, y) => {
    const filter = y % 5;
    const up = y ? (rows[y - 1] as Uint8Array) : new Uint8Array(stride);
    raw.push(filter);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (row[i - channels] as number) : 0;
      const b = up[i] as number;
      const c = i >= channels ? (up[i - channels] as number) : 0;
      const p = a + b - c;
      const pred =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const v = row[i] as number;
      raw.push((v - ([0, a, b, (a + b) >> 1, pred][filter] as number) + 256) & 0xff);
    }
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, type, 0, 0, 0], 8);
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('PNGs for the agent', () => {
  it('reads every row filter, in grey and in colour', () => {
    const shade = (x: number, y: number) => (x * 13 + y * 7) % 256;
    const grey = readPngGray(png(9, 10, 1, (x, y) => [shade(x, y)]));
    expect(grey.w).toBe(9);
    expect(grey.h).toBe(10);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) expect(grey.data[y * 9 + x]).toBe(shade(x, y));
    const colour = readPngGray(png(9, 10, 3, (x, y) => [shade(x, y), shade(x, y), shade(x, y)]));
    expect([...colour.data]).toEqual([...grey.data]);
  });

  it('lays a picture with alpha on white, as the studio’s canvas saves a strip', () => {
    const seen = readPngGray(png(4, 5, 4, (x) => [0, 0, 0, x === 0 ? 0 : 255]));
    expect(seen.data[0]).toBe(255);
    expect(seen.data[1]).toBe(0);
    expect(readPngGray(png(3, 5, 2, () => [0, 128])).data[0]).toBe(127);
  });

  it('writes colour that reads back as the eye sees it', () => {
    const img = { w: 3, h: 1, data: new Uint8Array([255, 0, 0, 0, 255, 0, 40, 110, 255]) };
    const back = readPngGray(writePngRgb(img));
    expect([...back.data]).toEqual([76, 150, 106]);
  });

  it('writes a palette’s picture packed small, and reads it back', () => {
    // two, four, seven and twenty colours: one, two, four and eight bits a pixel
    for (const colours of [2, 4, 7, 20]) {
      const palette = Array.from({ length: colours }, (_, i): [number, number, number] => {
        const v = Math.round((255 * i) / (colours - 1));
        return [v, v, v];
      });
      // a width that doesn't fill its last byte, every colour used
      const w = 13;
      const h = 9;
      const data = Uint8Array.from({ length: w * h }, (_, i) => (i * 5 + Math.floor(i / w)) % colours);
      const file = writePngIndexed({ w, h, data, palette });
      const back = readPngGray(file);
      expect([back.w, back.h]).toEqual([w, h]);
      expect([...back.data]).toEqual([...data].map((i) => (palette[i] as number[])[0]));
    }
    // a page of ink on paper: far smaller than the same picture in colour
    const w = 600;
    const h = 400;
    const page = new Uint8Array(w * h);
    for (let y = 40; y < h; y += 40) page.fill(1, y * w + 20, y * w + w - 20);
    const rgb = new Uint8Array(w * h * 3);
    page.forEach((v, i) => {
      rgb.fill(v ? 0 : 255, i * 3, i * 3 + 3);
    });
    const small = writePngIndexed({
      w,
      h,
      data: page,
      palette: [
        [255, 255, 255],
        [0, 0, 0],
      ],
    });
    expect(small.length).toBeLessThan(writePngRgb({ w, h, data: rgb }).length);
    expect(small.length).toBeLessThan(1000);
    expect(() => writePngIndexed({ w: 1, h: 1, data: new Uint8Array(1), palette: [] })).toThrow('1 to 256 colours');
  });

  it('refuses what isn’t a PNG it can read', () => {
    expect(() => readPngGray(Buffer.from('not a png'))).toThrow('Not a PNG');
    // a row filter past the five there are, and a picture cut short, are refused, not read as blank rows
    const good = png(4, 3, 1, () => [128]);
    const at = good.indexOf('IDAT') + 4;
    const length = good.readUInt32BE(at - 8);
    const raw = Buffer.from(inflateSync(good.subarray(at, at + length)));
    raw[0] = 7;
    const badFilter = Buffer.concat([
      good.subarray(0, at - 8),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    expect(() => readPngGray(badFilter)).toThrow('unknown filter');
    const short = Buffer.concat([
      good.subarray(0, at - 8),
      chunk('IDAT', deflateSync(raw.subarray(0, 6))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    expect(() => readPngGray(short)).toThrow('cut short');
  });
});
