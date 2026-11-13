import { generateSpace, prepareImpulse } from '@holo/engine';
import { describe, expect, it } from 'vitest';
import { packImpulse, unpackImpulse } from '../src/audio/impulse-cache.ts';

describe('a generated hall kept on the device', () => {
  it('comes back from its bytes as it was made, array for array', () => {
    const made = prepareImpulse(generateSpace('room', 7, 0.6, 48000));
    const back = unpackImpulse(packImpulse(made));
    expect(back).not.toBeNull();
    expect(back?.rate).toBe(made.rate);
    expect(back?.length).toBe(made.length);
    expect(back?.segments.map((s) => [s.size, s.start, s.parts])).toEqual(
      made.segments.map((s) => [s.size, s.start, s.parts]),
    );
    const same = (a: Float32Array | null | undefined, b: Float32Array | null) => {
      if (!b) return expect(a ?? null).toBeNull();
      expect(a?.length).toBe(b.length);
      for (let i = 0; i < b.length; i += 97) expect(a?.[i]).toBe(b[i]);
    };
    made.segments.forEach((s, i) => {
      same(back?.segments[i]?.ll, s.ll);
      same(back?.segments[i]?.rr, s.rr);
      same(back?.segments[i]?.lr, s.lr);
      same(back?.segments[i]?.rl, s.rl);
    });
    same(back?.head?.ll, made.head?.ll ?? null);
    same(back?.head?.rl, made.head?.rl ?? null);
    // each array has its own memory (they are handed to the engine one by one)
    expect(back?.segments[0]?.ll.buffer).not.toBe(back?.segments[0]?.rr.buffer);
  });

  it('is not made of bytes that are something else, or cut short', () => {
    expect(unpackImpulse(new ArrayBuffer(4))).toBeNull();
    expect(unpackImpulse(new Uint8Array(64).buffer)).toBeNull();
    const packed = packImpulse(prepareImpulse(generateSpace('room', 7, 0.6, 48000)));
    expect(unpackImpulse(packed.slice(0, packed.byteLength - 8))).toBeNull();
  });
});
