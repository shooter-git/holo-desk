/**
 * Notes cut out of a recorded run: an AIFF download read as it is, a stretch of it kept with a short
 * linear fade at each end, and written as a 32-bit float WAV. The arithmetic is exactly that of the
 * script that first cut them (ffmpeg's samples, numpy's fades, scipy's file), so every file comes out
 * byte for byte the same and its checksum holds.
 */

/** An AIFF (or uncompressed AIFF-C) file's samples, each channel as -1..1. */
export function decodeAiff(bytes: Uint8Array): { rate: number; channels: Float32Array[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== 'FORM' || (tag(8) !== 'AIFF' && tag(8) !== 'AIFC'))
    throw new Error('Not an AIFF file');
  let count = 0;
  let frames = 0;
  let bits = 0;
  let rate = 0;
  let little = false;
  let data: [number, number] | null = null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4);
    const body = at + 8;
    if (id === 'COMM') {
      count = view.getUint16(body);
      frames = view.getUint32(body + 2);
      bits = view.getUint16(body + 6);
      // an 80-bit extended float: sign and exponent, then a 64-bit mantissa
      const exp = view.getUint16(body + 8) & 0x7fff;
      const hi = view.getUint32(body + 10);
      const lo = view.getUint32(body + 14);
      rate = (hi * 2 ** 32 + lo) * 2 ** (exp - 16383 - 63);
      if (tag(8) === 'AIFC' && size >= 22) {
        const kind = tag(body + 18);
        if (kind === 'sowt') little = true;
        else if (kind !== 'NONE') throw new Error(`AIFF-C compressed as ${kind} isn't read here`);
      }
    } else if (id === 'SSND') {
      const offset = view.getUint32(body);
      data = [body + 8 + offset, size - 8 - offset];
    }
    at = body + size + (size & 1);
  }
  if (!count || !bits || !data) throw new Error('An AIFF file without its format or its samples');
  const width = Math.ceil(bits / 8);
  const n = Math.min(frames, Math.floor(data[1] / (width * count)));
  const channels = Array.from({ length: count }, () => new Float32Array(n));
  const scale = 1 / 2 ** (width * 8 - 1);
  let p = data[0];
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < count; c++) {
      let v = 0;
      if (width === 1) v = view.getInt8(p);
      else if (width === 2) v = view.getInt16(p, little);
      else if (width === 3)
        v = little
          ? (view.getInt8(p + 2) << 16) | (view.getUint8(p + 1) << 8) | view.getUint8(p)
          : (view.getInt8(p) << 16) | (view.getUint8(p + 1) << 8) | view.getUint8(p + 2);
      else v = view.getInt32(p, little);
      (channels[c] as Float32Array)[i] = v * scale;
      p += width;
    }
  }
  return { rate: Math.round(rate), channels };
}

/** numpy.linspace(start, stop, num)[i]. */
function linspace(start: number, stop: number, num: number, i: number): number {
  if (i === num - 1) return stop;
  return i * ((stop - start) / (num - 1)) + start;
}

/** frames of one channel from `start`, faded in and out over `fade` frames. */
export function cutNote(samples: Float32Array, start: number, frames: number, fade: number): Float32Array {
  if (start < 0 || start + frames > samples.length) throw new Error('A cut runs past the end of its recording');
  const out = samples.slice(start, start + frames);
  if (fade > 0 && frames >= fade) {
    for (let i = 0; i < fade; i++) {
      out[i] = Math.fround((out[i] as number) * linspace(0, 1, fade, i));
      const j = frames - fade + i;
      out[j] = Math.fround((out[j] as number) * linspace(1, 0, fade, i));
    }
  }
  return out;
}

/** One channel as a 32-bit float WAV, laid out as scipy writes one (fmt with cbSize, then fact). */
export function floatWav(samples: Float32Array, rate: number): Uint8Array {
  const bytes = samples.length * 4;
  const out = new Uint8Array(12 + 26 + 12 + 8 + bytes);
  const view = new DataView(out.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, out.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 18, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  view.setUint16(36, 0, true);
  text(38, 'fact');
  view.setUint32(42, 4, true);
  view.setUint32(46, samples.length, true);
  text(50, 'data');
  view.setUint32(54, bytes, true);
  for (let i = 0; i < samples.length; i++) view.setFloat32(58 + i * 4, samples[i] as number, true);
  return out;
}
