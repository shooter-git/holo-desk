import { describe, expect, it } from 'vitest';
import { downsample, measure, midiOf, notesOf, pitchTrack, tempoOf, yin } from '../src/audio/pitch.ts';

const RATE = 44100;

/** A sine at `hz` for `seconds`, at amplitude `amp`. */
function tone(hz: number, seconds: number, amp = 0.5, rate = RATE): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

describe('YIN', () => {
  it('hears A4 as 440 Hz, MIDI 69', () => {
    const found = yin(tone(440, 0.1).subarray(0, 2048), RATE);
    expect(found).not.toBeNull();
    expect(found?.hz).toBeCloseTo(440, 0);
    expect(Math.round(midiOf(found?.hz ?? 0))).toBe(69);
    expect(found?.clarity).toBeGreaterThan(0.9);
  });

  it('hears a low E and a high C', () => {
    const low = yin(tone(82.41, 0.2).subarray(0, 4096), RATE);
    expect(Math.round(midiOf(low?.hz ?? 0))).toBe(40);
    const high = yin(tone(1046.5, 0.1).subarray(0, 2048), RATE);
    expect(Math.round(midiOf(high?.hz ?? 0))).toBe(84);
  });

  it('hears no pitch in noise or silence', () => {
    let seed = 7;
    const noise = new Float32Array(2048).map(() => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 30 - 1;
    });
    expect(yin(noise, RATE)).toBeNull();
    expect(yin(new Float32Array(2048), RATE)).toBeNull();
  });

  it('brings the rate down for tracking, keeping the pitch', () => {
    const low = downsample(tone(440, 0.5), RATE);
    expect(low.sampleRate).toBeCloseTo(11025, 0);
    expect(Math.round(midiOf(yin(low.samples.subarray(0, 1024), low.sampleRate)?.hz ?? 0))).toBe(69);
  });
});

describe('the notes of a line', () => {
  it('finds one held A4', () => {
    const notes = notesOf(
      pitchTrack(join(new Float32Array(RATE * 0.2), tone(440, 1), new Float32Array(RATE * 0.3)), RATE),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.p).toBe(69);
    expect(notes[0]?.t).toBeCloseTo(0.2, 1);
    expect(notes[0]?.d).toBeCloseTo(1, 1);
  });

  it('finds two notes in a row: A4, then C5', () => {
    const m = measure(join(tone(440, 0.5), tone(523.25, 0.5)), RATE);
    expect(m.monophonic).toBe(true);
    expect(m.notes?.map((n) => n[2])).toEqual([69, 72]);
    const [a, c] = m.notes ?? [];
    expect(a?.[0]).toBeCloseTo(0, 1);
    expect(c?.[0]).toBeCloseTo(0.5, 1);
    expect(m.seconds).toBe(1);
    expect(m.peak).toBeCloseTo(0.5, 2);
  });

  it('finds a tempo in notes that repeat at 120 a minute', () => {
    const beat = join(tone(440, 0.15), new Float32Array(Math.round(RATE * 0.35)));
    const track = pitchTrack(join(...Array.from({ length: 12 }, () => beat)), RATE);
    expect(tempoOf(track)).toBeCloseTo(120, -1);
  });
});
