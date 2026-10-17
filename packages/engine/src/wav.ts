/**
 * WAV files, read and written the same way everywhere the engine runs, so a sample or a recording
 * becomes the same numbers in the studio's bounce and in a headless render. Reads PCM (8, 16, 24 and
 * 32-bit) and floating point (32 and 64-bit), plain or "extensible"; writes 24-bit PCM or 32-bit float.
 */

export interface DecodedAudio {
  rate: number;
  channels: Float32Array[];
}

export function decodeWav(bytes: Uint8Array): DecodedAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let at = 12;
  let format = 0;
  let count = 0;
  let rate = 0;
  let bits = 0;
  let data: [number, number] | null = null;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      count = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format's first two bytes
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      data = [body, Math.min(size, bytes.length - body)];
    }
    at = body + size + (size & 1);
  }
  if (!data || !count || !rate) throw new Error('A WAV file without its format or its data');
  const width = bits / 8;
  const frames = Math.floor(data[1] / (width * count));
  const channels = Array.from({ length: count }, () => new Float32Array(frames));
  const [start] = data;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      const p = start + (i * count + c) * width;
      let v: number;
      if (format === 3) v = bits === 64 ? view.getFloat64(p, true) : view.getFloat32(p, true);
      else if (bits === 16) v = view.getInt16(p, true) / 32768;
      else if (bits === 24) {
        const x = (bytes[p] as number) | ((bytes[p + 1] as number) << 8) | ((bytes[p + 2] as number) << 16);
        v = ((x << 8) >> 8) / 8388608;
      } else if (bits === 32) v = view.getInt32(p, true) / 2147483648;
      else if (bits === 8) v = ((bytes[p] as number) - 128) / 128;
      else throw new Error(`WAV files of ${bits}-bit samples aren't read`);
      (channels[c] as Float32Array)[i] = v;
    }
  }
  return { rate, channels };
}

/** A WAV file: 24-bit PCM, or 32-bit float (lossless for anything the engine makes). */
export function encodeWav(channels: Float32Array[], rate: number, format: 'pcm24' | 'float32' = 'float32'): Uint8Array {
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const width = format === 'pcm24' ? 3 : 4;
  const out = new Uint8Array(44 + frames * count * width);
  const view = new DataView(out.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + frames * count * width, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format === 'pcm24' ? 1 : 3, true);
  view.setUint16(22, count, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * count * width, true);
  view.setUint16(32, count * width, true);
  view.setUint16(34, width * 8, true);
  text(36, 'data');
  view.setUint32(40, frames * count * width, true);
  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      const s = (channels[c] as Float32Array)[i] as number;
      if (format === 'float32') {
        view.setFloat32(p, s, true);
        p += 4;
      } else {
        const x = Math.max(-1, Math.min(1, s));
        const v = Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff);
        out[p++] = v & 0xff;
        out[p++] = (v >> 8) & 0xff;
        out[p++] = (v >> 16) & 0xff;
      }
    }
  }
  return out;
}
