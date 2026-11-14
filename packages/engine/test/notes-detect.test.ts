import { type AudioNote, parseAudioNotes, roundPitch, roundTime } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { classifyRecording, DETECT_V, detectNotes, noteCurves, notesAndCurves } from '../src/notes/index.ts';

const SR = 48000;

/** A sung line: notes one after another ([MIDI, seconds]), a band-limited sawtooth (its first 20 harmonics) with no break in its wave. */
function sing(
  notes: [number, number][],
  o: { glide?: number; vibrato?: [number, number]; amp?: number; from?: number; rate?: number } = {},
): Float32Array {
  const SR = o.rate ?? 48000;
  const total = notes.reduce((s, [, d]) => s + d, 0);
  const out = new Float32Array(Math.round(total * SR));
  const amp = o.amp ?? 0.4;
  const glide = o.glide ?? 0;
  let phase = 0;
  let at = 0;
  let i = 0;
  for (let n = 0; n < out.length; n++) {
    const t = n / SR;
    while (i + 1 < notes.length && t >= at + (notes[i] as [number, number])[1])
      at += (notes[i++] as [number, number])[1];
    let m = (notes[i] as [number, number])[0];
    // a glide from the note before, centred on the change
    const prev = notes[i - 1];
    if (prev && glide > 0 && t - at < glide / 2) m = prev[0] + ((m - prev[0]) * (t - at + glide / 2)) / glide;
    const next = notes[i + 1];
    const end = at + (notes[i] as [number, number])[1];
    if (next && glide > 0 && end - t < glide / 2) m = m + ((next[0] - m) * (t - end + glide / 2)) / glide;
    // a scoop up from `from` semitones below, over the first 120 ms
    if (o.from && i === 0 && t < 0.12) m -= o.from * (1 - t / 0.12);
    if (o.vibrato) m += (o.vibrato[1] / 100) * Math.sin(2 * Math.PI * o.vibrato[0] * t);
    phase += (440 * 2 ** ((m - 69) / 12)) / SR;
    phase -= Math.floor(phase);
    let v = 0;
    for (let k = 1; k <= 20; k++) v += Math.sin(2 * Math.PI * k * phase) / k;
    out[n] = amp * 0.6 * v;
  }
  // 5 ms fades, so a note from silence starts cleanly
  const fade = Math.round(0.005 * SR);
  for (let n = 0; n < fade && n < out.length; n++) {
    out[n] = (out[n] as number) * (n / fade);
    out[out.length - 1 - n] = (out[out.length - 1 - n] as number) * (n / fade);
  }
  return out;
}

const silence = (seconds: number, rate = SR) => new Float32Array(Math.round(seconds * rate));
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

let seed = 5;
/** Noise (white, or darker through a one-pole lowpass), `seconds` long. */
function noise(seconds: number, amp: number, smooth = 0): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  let y = 0;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const v = seed / 2 ** 30 - 1;
    y = smooth * y + (1 - smooth) * v;
    out[i] = amp * y;
  }
  return out;
}

const pitched = (n: AudioNote[]) => n.filter((x) => x.p !== null);
const cents = (a: number, b: number) => Math.abs(a - b) * 100;

describe('notes found to edit', () => {
  it('finds a melody sung detached: each note, its pitch within 5 cents, its start and end within 15 ms', () => {
    const melody: [number, number][] = [
      [60, 0.4],
      [64, 0.35],
      [67, 0.5],
      [72, 0.3],
    ];
    const parts: Float32Array[] = [silence(0.2)];
    const times: [number, number][] = [];
    let at = 0.2;
    for (const [m, d] of melody) {
      parts.push(sing([[m, d]]), silence(0.15));
      times.push([at, at + d]);
      at += d + 0.15;
    }
    const found = detectNotes([join(...parts)], SR);
    expect(found.mode).toBe('mono');
    expect(found.v).toBe(DETECT_V);
    expect(found.n).toHaveLength(4);
    found.n.forEach((n, i) => {
      const [m] = melody[i] as [number, number];
      const [start, end] = times[i] as [number, number];
      expect(cents(n.p as number, m), `${i}`).toBeLessThan(5);
      expect(Math.abs(n.t - start), `${i}`).toBeLessThan(0.015);
      expect(Math.abs(n.t + n.d - end), `${i}`).toBeLessThan(0.015);
      expect(n.u).toBeUndefined();
    });
  });

  it('finds a legato line: notes that touch, split where the pitch crosses between them', () => {
    const melody: [number, number][] = [
      [60, 0.4],
      [62, 0.3],
      [64, 0.45],
      [65, 0.3],
      [62, 0.5],
    ];
    const found = detectNotes([join(silence(0.2), sing(melody, { glide: 0.04 }), silence(0.2))], SR).n;
    expect(found).toHaveLength(5);
    let at = 0.2;
    found.forEach((n, i) => {
      const [m, d] = melody[i] as [number, number];
      expect(cents(n.p as number, m), `${i}`).toBeLessThan(5);
      expect(Math.abs(n.t - at), `${i}`).toBeLessThan(0.015);
      const next = found[i + 1];
      // one ends exactly where the next starts
      if (next) expect(n.t + n.d).toBeCloseTo(next.t, 9);
      at += d;
    });
  });

  it('keeps a held note with a vibrato as one note, on its centre', () => {
    for (const vibrato of [
      [5.5, 50],
      [5, 100],
      [6.5, 30],
    ] as [number, number][]) {
      const found = detectNotes([join(silence(0.2), sing([[64, 2]], { vibrato }), silence(0.2))], SR).n;
      expect(found, `${vibrato}`).toHaveLength(1);
      expect(cents(found[0]?.p as number, 64), `${vibrato}`).toBeLessThan(5);
    }
  });

  it('counts a scoop into a note, and a fall off its end, as part of it', () => {
    // a scoop up two semitones over 120 ms, from silence
    const scoop = detectNotes([join(silence(0.2), sing([[64, 0.7]], { from: 2 }), silence(0.2))], SR).n;
    expect(scoop).toHaveLength(1);
    expect(cents(scoop[0]?.p as number, 64)).toBeLessThan(5);
    expect(Math.abs((scoop[0]?.t as number) - 0.2)).toBeLessThan(0.015);
    // a fall of three semitones over 100 ms at its end, into silence
    const fall = detectNotes(
      [
        join(
          silence(0.2),
          sing(
            [
              [64, 0.7],
              [61, 0.05],
            ],
            { glide: 0.1 },
          ),
          silence(0.2),
        ),
      ],
      SR,
    ).n;
    expect(fall).toHaveLength(1);
    expect(cents(fall[0]?.p as number, 64)).toBeLessThan(5);
    expect(Math.abs((fall[0]?.t as number) + (fall[0]?.d as number) - 0.95)).toBeLessThan(0.02);
  });

  it('gives a note the consonant just before it: it starts there, its voice after it (`u`)', () => {
    // an "s": 90 ms of bright noise, then the voice straight after
    const found = detectNotes([join(silence(0.3), noise(0.09, 0.05), sing([[62, 0.6]]), silence(0.2))], SR).n;
    expect(found).toHaveLength(1);
    const [n] = found as [AudioNote];
    expect(Math.abs(n.t - 0.3)).toBeLessThan(0.01);
    expect(Math.abs((n.u ?? 0) - 0.09)).toBeLessThan(0.015);
    expect(Math.abs(n.t + (n.u ?? 0) - 0.39)).toBeLessThan(0.015);
    expect(cents(n.p as number, 62)).toBeLessThan(5);
  });

  it('finds a breath between two phrases as a note with no pitch', () => {
    const found = detectNotes(
      [
        join(
          silence(0.2),
          sing([[60, 0.5]]),
          silence(0.15),
          noise(0.3, 0.02, 0.6),
          silence(0.15),
          sing([[64, 0.5]]),
          silence(0.2),
        ),
      ],
      SR,
    ).n;
    expect(found.map((n) => n.p === null)).toEqual([false, true, false]);
    const breath = found[1] as AudioNote;
    expect(Math.abs(breath.t - 0.85)).toBeLessThan(0.015);
    expect(Math.abs(breath.t + breath.d - 1.15)).toBeLessThan(0.015);
    // a short click of noise between them is nothing
    const click = detectNotes(
      [
        join(
          silence(0.2),
          sing([[60, 0.5]]),
          silence(0.15),
          noise(0.03, 0.02),
          silence(0.15),
          sing([[64, 0.5]]),
          silence(0.2),
        ),
      ],
      SR,
    ).n;
    expect(click.map((n) => n.p === null)).toEqual([false, false]);
  });

  it('puts back a stretch the tracker hears an octave off its neighbours', () => {
    // 200 ms in the middle with only the even harmonics: it repeats an octave up
    const low = sing([[57, 1.2]]);
    const at = Math.round(0.5 * SR);
    const len = Math.round(0.2 * SR);
    const glitch = low.slice();
    const up = sing([[69, 0.2]], { amp: 0.25 });
    for (let i = 0; i < len; i++) glitch[at + i] = up[i] as number;
    const samples = join(silence(0.2), glitch, silence(0.2));
    const found = pitched(detectNotes([samples], SR).n);
    expect(found).toHaveLength(1);
    expect(cents(found[0]?.p as number, 57)).toBeLessThan(5);
    // and its curve with it
    const curves = noteCurves([samples], SR);
    const k = Math.round((0.8 - curves.t0) / curves.step);
    expect(Math.abs((curves.midi[k] as number) - 57)).toBeLessThan(0.5);
  });

  it('gives the notes and the curves heard once exactly as it gives each alone', () => {
    const samples = join(
      silence(0.2),
      sing([
        [60, 0.4],
        [62, 0.4],
        [64, 0.5],
      ]),
      silence(0.2),
    );
    const both = notesAndCurves([samples], SR);
    expect(both.notes).toEqual(detectNotes([samples], SR));
    expect(both.curves).toEqual(noteCurves([samples], SR));
    expect(notesAndCurves([], SR).notes).toEqual(detectNotes([], SR));
  });

  it('keeps what it finds canonical: as a song keeps it, read back the same', () => {
    const samples = join(
      silence(0.25),
      noise(0.07, 0.05),
      sing(
        [
          [60, 0.4],
          [63, 0.35],
          [60, 0.3],
        ],
        { glide: 0.03, vibrato: [5.5, 20] },
      ),
      silence(0.2),
      noise(0.25, 0.02, 0.6),
      silence(0.2),
      sing([[67, 0.6]]),
      silence(0.3),
    );
    const found = detectNotes([samples, samples], SR);
    expect(found.n.length).toBeGreaterThanOrEqual(5);
    expect(parseAudioNotes(JSON.parse(JSON.stringify(found)))).toEqual(found);
    for (const [i, n] of found.n.entries()) {
      // rounded as the song keeps them, by start, one after another
      expect([n.t, n.d, n.u ?? 0]).toEqual([roundTime(n.t), roundTime(n.d), roundTime(n.u ?? 0)]);
      if (n.p !== null) expect(n.p).toBe(roundPitch(n.p));
      const next = found.n[i + 1];
      if (next) expect(n.t + n.d).toBeLessThanOrEqual(next.t + 1e-9);
    }
    // the same samples, the same notes
    expect(detectNotes([samples], SR)).toEqual(found);
  });

  it('draws its curves every 5 ms: the pitch where it is voiced, the power, and where sound has no pitch', () => {
    const samples = join(silence(0.2), noise(0.08, 0.05), sing([[60, 0.5]]), silence(0.3));
    const c = noteCurves([samples], SR);
    expect(c.step).toBe(0.005);
    expect(c.t0).toBeGreaterThanOrEqual(0);
    expect(c.t0).toBeLessThan(c.step);
    expect(c.midi.length).toBe(c.power.length);
    expect(c.unvoiced.length).toBe(c.midi.length);
    expect(c.t0 + c.step * (c.midi.length - 1)).toBeGreaterThan(1.05);
    const at = (t: number) => Math.round((t - c.t0) / c.step);
    expect(Math.abs((c.midi[at(0.5)] as number) - 60)).toBeLessThan(0.05);
    expect(Number.isNaN(c.midi[at(0.1)] as number)).toBe(true);
    expect(Number.isNaN(c.midi[at(1.0)] as number)).toBe(true);
    expect(c.unvoiced[at(0.24)]).toBe(1);
    expect(c.unvoiced[at(0.5)]).toBe(0);
    expect(c.unvoiced[at(0.1)]).toBe(0);
    expect(c.power[at(0.5)] as number).toBeGreaterThan(0.01);
    expect(c.power[at(0.1)]).toBe(0);
  });

  it('finds the same notes whatever the rate of the file', () => {
    const at = (rate: number) =>
      detectNotes(
        [
          join(
            silence(0.2, rate),
            sing(
              [
                [60, 0.4],
                [64, 0.4],
              ],
              { glide: 0.03, rate },
            ),
            silence(0.1, rate),
            sing([[67, 0.5]], { rate }),
            silence(0.2, rate),
          ),
        ],
        rate,
      ).n;
    const ref = at(48000);
    expect(ref).toHaveLength(3);
    for (const rate of [22050, 44100, 96000]) {
      const found = at(rate);
      expect(found, `${rate}`).toHaveLength(3);
      found.forEach((n, i) => {
        const r = ref[i] as AudioNote;
        expect(Math.abs(n.t - r.t), `${rate} ${i}`).toBeLessThan(0.006);
        expect(Math.abs(n.t + n.d - r.t - r.d), `${rate} ${i}`).toBeLessThan(0.006);
        expect(cents(n.p as number, r.p as number), `${rate} ${i}`).toBeLessThan(1);
      });
    }
  });

  it('tells a line from a chord and from hits', () => {
    const line = join(
      silence(0.2),
      sing([
        [60, 0.4],
        [64, 0.4],
        [67, 0.6],
      ]),
      silence(0.2),
    );
    expect(classifyRecording([line], SR).mode).toBe('mono');
    const c = sing([[60, 1.5]], { amp: 0.15 });
    const e = sing([[64, 1.5]], { amp: 0.15 });
    const g = sing([[67, 1.5]], { amp: 0.15 });
    const chord = join(
      silence(0.2),
      c.map((v, i) => v + (e[i] as number) + (g[i] as number)),
      silence(0.2),
    );
    const kind = classifyRecording([chord], SR);
    expect(kind.mode).toBe('poly');
    expect(kind.voiced).toBeLessThan(0.25);
    const hits = silence(3);
    for (let k = 0; k < 12; k++) {
      const hit = noise(0.05, 0.8);
      for (let i = 0; i < hit.length; i++)
        hits[Math.round((0.1 + k * 0.23) * SR) + i] = (hit[i] as number) * Math.exp(-i / (0.006 * SR));
    }
    const drums = classifyRecording([hits], SR);
    expect(drums.mode).toBe('perc');
    expect(drums.onsetsPerSecond).toBeGreaterThan(3);
  });
});
