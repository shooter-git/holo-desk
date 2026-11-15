import { describe, expect, it } from 'vitest';
import { channelPcm, pcm16, pcmChannel } from '../src/audio/pack-files.ts';

/** A WAV file's bytes: chunks as given, after the RIFF header. */
function riff(chunks: [string, Uint8Array][]): ArrayBuffer {
  const size = chunks.reduce((n, [, body]) => n + 8 + body.length + (body.length & 1), 4);
  const out = new Uint8Array(8 + size);
  const view = new DataView(out.buffer);
  const tag = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  view.setUint32(4, size, true);
  tag(8, 'WAVE');
  let at = 12;
  for (const [id, body] of chunks) {
    tag(at, id);
    view.setUint32(at + 4, body.length, true);
    out.set(body, at + 8);
    at += 8 + body.length + (body.length & 1);
  }
  return out.buffer;
}

function fmt(format: number, channels: number, rate: number, bits: number, extensibleAs?: number): Uint8Array {
  const body = new Uint8Array(extensibleAs === undefined ? 16 : 40);
  const view = new DataView(body.buffer);
  view.setUint16(0, format, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, rate, true);
  view.setUint32(8, (rate * channels * bits) / 8, true);
  view.setUint16(12, (channels * bits) / 8, true);
  view.setUint16(14, bits, true);
  if (extensibleAs !== undefined) {
    view.setUint16(16, 22, true);
    view.setUint16(24, extensibleAs, true);
  }
  return body;
}

function frames(values: number[]): Uint8Array {
  const body = new Uint8Array(values.length * 2);
  const view = new DataView(body.buffer);
  for (const [i, v] of values.entries()) view.setInt16(i * 2, v, true);
  return body;
}

describe('a 16-bit WAV, read as it is', () => {
  // three stereo frames: left 1, 2, 3; right -1, -2, -32768
  const stereo = frames([1, -1, 2, -2, 3, -32768]);

  it('finds its frames past any chunk before them', () => {
    const odd = new Uint8Array(3); // a chunk of an odd length is padded to an even one
    const wav = riff([
      ['fmt ', fmt(1, 2, 44100, 16)],
      ['LIST', odd],
      ['data', stereo],
    ]);
    const info = pcm16(wav);
    expect(info).toEqual({ rate: 44100, channels: 2, offset: 12 + 8 + 16 + 8 + 4 + 8, frames: 3 });
    if (!info) return;
    expect([...pcmChannel(wav, info, 0, 0, 3)]).toEqual([1, 2, 3]);
    expect([...pcmChannel(wav, info, 1, 1, 3)]).toEqual([-2, -32768]);
    // a stretch past the end is cut at it
    expect([...pcmChannel(wav, info, 0, 2, 10)]).toEqual([3]);
  });

  it('reads the extensible header by its sub-format', () => {
    expect(
      pcm16(
        riff([
          ['fmt ', fmt(0xfffe, 1, 48000, 16, 1)],
          ['data', frames([7])],
        ]),
      )?.frames,
    ).toBe(1);
    // a float sub-format isn't 16-bit PCM
    expect(
      pcm16(
        riff([
          ['fmt ', fmt(0xfffe, 1, 48000, 32, 3)],
          ['data', frames([7, 7])],
        ]),
      ),
    ).toBeNull();
  });

  it('leaves anything else to the decoder', () => {
    expect(
      pcm16(
        riff([
          ['fmt ', fmt(1, 2, 44100, 24)],
          ['data', stereo],
        ]),
      ),
    ).toBeNull();
    expect(
      pcm16(
        riff([
          ['fmt ', fmt(3, 1, 44100, 32)],
          ['data', stereo],
        ]),
      ),
    ).toBeNull();
    expect(pcm16(new TextEncoder().encode('fLaC and so on').buffer as ArrayBuffer)).toBeNull();
    expect(pcm16(riff([['fmt ', fmt(1, 2, 44100, 16)]]))).toBeNull();
  });
});

describe('a decoded sample kept as 16-bit', () => {
  it('rounds to the nearest step and holds full scale', () => {
    const data = new Float32Array([0, 0.5, -0.5, 1 / 65536 + 1e-7, 1, -1, 1.5, 0.25]);
    const audio = { getChannelData: () => data } as unknown as AudioBuffer;
    expect([...channelPcm(audio, 0, 0, data.length)]).toEqual([0, 16384, -16384, 1, 32767, -32768, 32767, 8192]);
    expect([...channelPcm(audio, 0, 1, 3)]).toEqual([16384, -16384]);
  });
});
