import {
  type AudioClip,
  type AudioNote,
  type AudioNotes,
  newAudioTrack,
  newProject,
  newRegion,
  PPQ,
  type Project,
  parseAudioNotes,
} from '@holo/session';
import { describe, expect, it } from 'vitest';
import { fineTrack } from '../src/analysis/take.ts';
import { compileClips, compileTempo } from '../src/compile.ts';
import { noteGain, targetShift } from '../src/notes/curve.ts';
import { assembleClip, renderNotePatch } from '../src/notes/patch.ts';
import { type PatchJob, regionPatches } from '../src/notes/plan.ts';
import { renderSession } from '../src/render.ts';
import { stretchAudio } from '../src/stretch.ts';
import { encodeWav } from '../src/wav.ts';

const SR = 48000;

/** A sung note: from `t` for `d` seconds at a MIDI pitch, with a vibrato ([Hz, ± cents]) if asked. */
interface Sung {
  t: number;
  d: number;
  midi: number;
  vibrato?: [number, number];
}

/**
 * A synthetic voice: a band-limited pulse train (its harmonics up to 8 kHz) at the notes' pitches,
 * through three formant resonators (an "ah": 700, 1220 and 2600 Hz), with 20 ms attacks and releases.
 * Notes that touch are sung legato: the voice goes on, its pitch gliding over 40 ms where they meet.
 */
function voice(notes: Sung[], seconds: number): Float32Array {
  const n = Math.round(seconds * SR);
  const f0 = new Float64Array(n);
  const env = new Float64Array(n);
  notes.forEach((s, k) => {
    const prev = notes[k - 1];
    const next = notes[k + 1];
    const fromPrev = prev && Math.abs(prev.t + prev.d - s.t) < 1e-6 ? prev : null;
    const intoNext = next && Math.abs(s.t + s.d - next.t) < 1e-6 ? next : null;
    for (let i = Math.round(s.t * SR); i < Math.round((s.t + s.d) * SR); i++) {
      const t = i / SR - s.t;
      let m = s.midi;
      if (s.vibrato) m += (s.vibrato[1] / 100) * Math.sin(2 * Math.PI * s.vibrato[0] * t);
      if (fromPrev && t < 0.02) {
        const u = 0.5 + t / 0.04;
        m = fromPrev.midi + (m - fromPrev.midi) * u * u * (3 - 2 * u);
      }
      if (intoNext && s.d - t < 0.02) {
        const u = 0.5 - (s.d - t) / 0.04;
        m += (intoNext.midi - m) * u * u * (3 - 2 * u);
      }
      f0[i] = 440 * 2 ** ((m - 69) / 12);
      env[i] = Math.min(fromPrev ? 1 : Math.min(1, t / 0.02), intoNext ? 1 : Math.min(1, (s.d - t) / 0.02));
    }
  });
  const pulses = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = f0[i] as number;
    if (f <= 0) continue;
    phase += f / SR;
    const top = Math.floor(8000 / f);
    let v = 0;
    for (let h = 1; h <= top; h++) v += Math.cos(2 * Math.PI * h * phase);
    pulses[i] = (v / top) * (env[i] as number);
  }
  const out = new Float32Array(n);
  for (const [hz, q, g] of [
    [700, 6, 1],
    [1220, 8, 0.5],
    [2600, 10, 0.25],
  ] as const) {
    // a band pass, 0 dB at its centre
    const w = (2 * Math.PI * hz) / SR;
    const alpha = Math.sin(w) / (2 * q);
    const b0 = alpha / (1 + alpha);
    const a1 = (-2 * Math.cos(w)) / (1 + alpha);
    const a2 = (1 - alpha) / (1 + alpha);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < n; i++) {
      const x = pulses[i] as number;
      const y = b0 * (x - x2) - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      out[i] = (out[i] as number) + 0.5 * g * y;
    }
  }
  return out;
}

/** A line's notes, canonical, as the song keeps them. */
const line = (n: Partial<AudioNote>[]): AudioNotes =>
  parseAudioNotes({ mode: 'mono', v: 1, n: n.map((x) => ({ d: 0.3, p: 60, ...x })) }) as AudioNotes;

const clip = (notes: AudioNotes, more: Partial<AudioClip> = {}): AudioClip => ({
  file: 'aud_voice',
  offset: 0,
  gain: 0,
  fadeIn: 0,
  fadeOut: 0,
  stretch: 1,
  notes,
  ...more,
});

/** A recording with a region's patches rendered and played in place. */
function edited(base: Float32Array[], notes: AudioNotes): { out: Float32Array[]; patches: PatchJob[] } {
  const patches = regionPatches(clip(notes), SR);
  const rendered = patches.map((p) => ({ spec: p.spec, channels: renderNotePatch(base, SR, p.spec) }));
  return { out: assembleClip(base, rendered), patches };
}

/** The mean pitch (MIDI) the fine track hears from `from` to `to` (s; it listens from 200 ms before to 200 ms after). */
function pitchOf(x: Float32Array, from: number, to: number): number {
  const start = Math.max(0, Math.round((from - 0.2) * SR));
  const track = fineTrack(x.subarray(start, Math.round((to + 0.2) * SR)), SR);
  let sum = 0;
  let count = 0;
  for (let k = 0; k < track.t.length; k++) {
    const t = (track.t[k] as number) + start / SR;
    if (t < from || t > to || Number.isNaN(track.midi[k] as number)) continue;
    sum += track.midi[k] as number;
    count++;
  }
  return sum / count;
}

/** The RMS from `from` to `to` (s). */
function rmsOf(x: Float32Array, from: number, to: number): number {
  let sum = 0;
  const a = Math.round(from * SR);
  const b = Math.round(to * SR);
  for (let i = a; i < b; i++) sum += (x[i] as number) ** 2;
  return Math.sqrt(sum / (b - a));
}

/** The stretches where two recordings differ, [first, after the last] (closer than 40 ms: one). */
function differing(x: Float32Array, y: Float32Array): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue;
    const last = out[out.length - 1];
    if (last && i - last[1] < 0.04 * SR) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

/** The largest step from one sample to the next within 5 ms of `at`. */
function maxStep(x: Float32Array, at: number): number {
  let m = 0;
  const w = Math.round(0.005 * SR);
  for (let i = Math.max(1, at - w); i < Math.min(x.length, at + w); i++)
    m = Math.max(m, Math.abs((x[i] as number) - (x[i - 1] as number)));
  return m;
}

const bytes = (c: Float32Array | undefined) =>
  Buffer.from(c?.buffer ?? new ArrayBuffer(0), c?.byteOffset, c?.byteLength);

// a held note on its own (with a vibrato), and three sung legato, the middle one edited
const ALONE: Sung = { t: 0.5, d: 1, midi: 57, vibrato: [5.5, 25] };
const LEGATO: Sung[] = [
  { t: 0.3, d: 0.6, midi: 57, vibrato: [5.5, 25] },
  { t: 0.9, d: 0.6, midi: 60, vibrato: [5.5, 25] },
  { t: 1.5, d: 0.6, midi: 59, vibrato: [5.5, 25] },
];
const alone = voice([ALONE], 2);
const legato = voice(LEGATO, 2.4);
const legatoNotes = (middle: Partial<AudioNote>) =>
  line([
    { t: 0.3, d: 0.6, p: 57 },
    { t: 0.9, d: 0.6, p: 60, ...middle },
    { t: 1.5, d: 0.6, p: 59 },
  ]);

describe('the shift and the level a line’s notes make', () => {
  const times = Float64Array.from({ length: 2000 }, (_, i) => i / 1000);
  const at = (curve: Float64Array, s: number) => curve[Math.round(s * 1000)] as number;

  it('moves a note by where it was moved to, with 10 ms edges, and nothing anywhere else', () => {
    const shift = targetShift(line([{ t: 0.5, d: 0.5, p: 60.2, to: 62 }]).n, times);
    expect(at(shift, 0.7)).toBeCloseTo(1.8, 12);
    expect(at(shift, 0.5)).toBeCloseTo(0.9, 12);
    expect(at(shift, 0.494)).toBe(0);
    expect(at(shift, 1.006)).toBe(0);
    expect([...shift.subarray(0, 494), ...shift.subarray(1006)].every((s) => s === 0)).toBe(true);
  });

  it('crosses from one note’s shift to the next where they touch, over the shorter of 120 ms and 40% of the shorter note', () => {
    const notes = line([
      { t: 0.4, d: 0.5, p: 60, to: 62 },
      { t: 0.9, d: 0.2, p: 64, to: 63 },
      { t: 1.1, d: 0.5, p: 62 },
    ]).n;
    const shift = targetShift(notes, times);
    // between the first two, 80 ms (40% of 0.2 s) centred at 0.9 s: halfway at the middle
    expect(at(shift, 0.86)).toBeCloseTo(2, 12);
    expect(at(shift, 0.9)).toBeCloseTo(0.5, 12);
    expect(at(shift, 0.94)).toBeCloseTo(-1, 12);
    // into the unedited third: back to nothing by 1.14 s
    expect(at(shift, 1.1)).toBeCloseTo(-0.5, 12);
    expect(at(shift, 1.14)).toBe(0);
    expect(at(shift, 1.3)).toBe(0);
  });

  it('moves nothing where the sound isn’t voiced', () => {
    const midi = Float64Array.from(times, (t) => (t > 0.6 && t < 0.7 ? Number.NaN : 60));
    const shift = targetShift(line([{ t: 0.5, d: 0.5, p: 60, to: 61 }]).n, times, midi);
    expect(at(shift, 0.65)).toBe(0);
    expect(at(shift, 0.75)).toBe(1);
  });

  it('changes the level over 10 ms edges, from one note’s to the next where they touch, and is exactly 1 elsewhere', () => {
    const gain = noteGain(
      line([
        { t: 0.4, d: 0.5, g: 6 },
        { t: 0.9, d: 0.3, m: true },
        { t: 1.5, d: 0.3 },
      ]).n,
      times,
    );
    expect(at(gain, 0.6)).toBeCloseTo(10 ** (6 / 20), 12);
    expect(at(gain, 1)).toBe(0);
    expect(at(gain, 0.9)).toBeCloseTo(10 ** (6 / 20) / 2, 12);
    expect([...gain.subarray(0, 395), ...gain.subarray(1206)].every((g) => g === 1)).toBe(true);
  });
});

describe('a line’s note moved in pitch', () => {
  it('sounds where it was moved to: +100 cents to within 3', () => {
    const { out } = edited([alone], line([{ t: 0.5, d: 1, p: 57, to: 58 }]));
    const held: [number, number] = [ALONE.t + 0.06, ALONE.t + ALONE.d - 0.06];
    const moved = pitchOf(out[0] as Float32Array, ...held) - pitchOf(alone, ...held);
    expect(Math.abs(moved * 100 - 100)).toBeLessThan(3);
  });

  it('to within 3 cents up to 7 semitones either way, and 5 up to 12', () => {
    const plain = voice([{ t: 0.5, d: 1, midi: 57 }], 2);
    const before = pitchOf(plain, 0.56, 1.44);
    const errors: number[] = [];
    for (let semis = -12; semis <= 12; semis++) {
      if (semis === 0) continue;
      const { out } = edited([plain], line([{ t: 0.5, d: 1, p: 57, to: 57 + semis }]));
      const error = Math.abs((pitchOf(out[0] as Float32Array, 0.56, 1.44) - before - semis) * 100);
      errors.push(error);
      expect(error).toBeLessThan(Math.abs(semis) <= 7 ? 3 : 5);
    }
    expect(errors).toHaveLength(24);
  }, 30_000);

  it('in a stretched region: the note where the stretch has put it', () => {
    const stretch = 1.25;
    const [base] = stretchAudio([alone], stretch, SR) as [Float32Array];
    const notes = line([{ t: 0.5, d: 1, p: 57, to: 55 }]);
    const patches = regionPatches(clip(notes, { stretch }), SR);
    const out = assembleClip(
      [base],
      patches.map((p) => ({ spec: p.spec, channels: renderNotePatch([base], SR, p.spec) })),
    )[0] as Float32Array;
    const held: [number, number] = [0.56 * stretch, 1.44 * stretch];
    expect(Math.abs((pitchOf(out, ...held) - pitchOf(base, ...held) + 2) * 100)).toBeLessThan(3);
    const [first, last] = differing(base, out)[0] as [number, number];
    expect(first).toBeGreaterThan(0.48 * stretch * SR);
    expect(last).toBeLessThan(1.56 * stretch * SR);
  });

  it('copies the recording to the bit outside what it changes, its patch’s first and last frames too', () => {
    for (const [base, notes, from, to] of [
      [alone, line([{ t: 0.5, d: 1, p: 57, to: 59 }]), 0.49, 1.56],
      [legato, legatoNotes({ to: 62 }), 0.83, 1.62],
      [legato, legatoNotes({ to: 57 }), 0.83, 1.62],
    ] as const) {
      const { out, patches } = edited([base], notes);
      const o = out[0] as Float32Array;
      const [patch] = patches;
      if (!patch) throw new Error('no patch');
      const { a, b } = patch.spec;
      const rendered = renderNotePatch([base], SR, patch.spec)[0] as Float32Array;
      expect(rendered.length).toBe(b - a);
      expect(rendered[0]).toBe(base[a]);
      expect(rendered[rendered.length - 1]).toBe(base[b - 1]);
      const changed = differing(base, o);
      expect(changed).toHaveLength(1);
      const [first, last] = changed[0] as [number, number];
      expect(first).toBeGreaterThan(from * SR);
      expect(last).toBeLessThan(to * SR);
      expect(first).toBeGreaterThan(a);
      expect(last).toBeLessThan(b);
    }
  });

  it('doesn’t click where it leaves the recording or locks back onto it', () => {
    for (const [base, notes] of [
      [alone, line([{ t: 0.5, d: 1, p: 57, to: 59 }])],
      [alone, line([{ t: 0.5, d: 1, p: 57, to: 52 }])],
      [legato, legatoNotes({ to: 62 })],
      [legato, legatoNotes({ to: 57 })],
      [legato, legatoNotes({ to: 65 })],
    ] as const) {
      const { out, patches } = edited([base], notes);
      const o = out[0] as Float32Array;
      const edges = [...differing(base, o).flat(), ...patches.flatMap((p) => [p.spec.a, p.spec.b])];
      for (const e of edges) expect(maxStep(o, e)).toBeLessThanOrEqual(1.5 * maxStep(base, e));
    }
  });

  it('keeps a stereo image: every channel moved by the same marks', () => {
    const left = legato;
    const right = Float32Array.from(legato, (v) => v * 0.5);
    const { out } = edited([left, right], legatoNotes({ to: 62 }));
    const [l, r] = out as [Float32Array, Float32Array];
    let worst = 0;
    for (let i = 0; i < l.length; i++) worst = Math.max(worst, Math.abs((r[i] as number) - 0.5 * (l[i] as number)));
    expect(worst).toBeLessThan(1e-6);
    expect(differing(legato, l).length).toBe(1);
  });

  it('renders the same twice, to the byte', () => {
    const right = Float32Array.from(legato, (v, i) => v * 0.7 + 0.01 * Math.sin(i / 10));
    const [job] = regionPatches(clip(legatoNotes({ to: 63.5, g: -3 })), SR);
    if (!job) throw new Error('no patch');
    const one = renderNotePatch([legato, right], SR, job.spec);
    const two = renderNotePatch([legato, right], SR, job.spec);
    expect(bytes(one[0]).equals(bytes(two[0]))).toBe(true);
    expect(bytes(one[1]).equals(bytes(two[1]))).toBe(true);
    expect(bytes(one[0]).equals(bytes(legato.subarray(job.spec.a, job.spec.b)))).toBe(false);
  });

  it('leaves the notes of chords and hits as they were (not rendered yet)', () => {
    for (const mode of ['poly', 'perc'] as const) {
      const notes = parseAudioNotes({ mode, v: 1, n: [{ t: 0.9, d: 0.6, p: 60, to: 62, g: 6 }] }) as AudioNotes;
      const [job] = regionPatches(clip(notes), SR);
      if (!job) throw new Error('no patch');
      const [c] = renderNotePatch([legato], SR, job.spec);
      expect(bytes(c).equals(bytes(legato.subarray(job.spec.a, job.spec.b)))).toBe(true);
    }
  });
});

describe('a line’s note’s level', () => {
  it('changes by its gain: +6 dB to within 0.2, held part', () => {
    const { out } = edited([alone], line([{ t: 0.5, d: 1, p: 57, g: 6 }]));
    const db = 20 * Math.log10(rmsOf(out[0] as Float32Array, 0.56, 1.44) / rmsOf(alone, 0.56, 1.44));
    expect(Math.abs(db - 6)).toBeLessThan(0.2);
    // and not a sample changed 5 ms past its edges
    const [first, last] = differing(alone, out[0] as Float32Array)[0] as [number, number];
    expect(first).toBeGreaterThanOrEqual(Math.floor(0.495 * SR));
    expect(last).toBeLessThanOrEqual(Math.ceil(1.505 * SR));
  });

  it('is gone muted: 80 dB down at least', () => {
    const { out } = edited([legato], legatoNotes({ m: true }));
    const left = rmsOf(out[0] as Float32Array, 0.96, 1.44);
    expect(left === 0 || 20 * Math.log10(left / rmsOf(legato, 0.96, 1.44)) < -80).toBe(true);
  });

  it('moves with the pitch, both at once', () => {
    const { out } = edited([alone], line([{ t: 0.5, d: 1, p: 57, to: 60, g: -6 }]));
    const o = out[0] as Float32Array;
    expect(Math.abs((pitchOf(o, 0.56, 1.44) - pitchOf(alone, 0.56, 1.44) - 3) * 100)).toBeLessThan(3);
    // the level against the pitch moved alone
    const moved = edited([alone], line([{ t: 0.5, d: 1, p: 57, to: 60 }])).out[0] as Float32Array;
    const db = 20 * Math.log10(rmsOf(o, 0.56, 1.44) / rmsOf(moved, 0.56, 1.44));
    expect(Math.abs(db + 6)).toBeLessThan(0.2);
  });
});

describe('a song with a line’s notes edited, rendered', () => {
  const take = voice(LEGATO, 2.4);
  const source = {
    instrument: () => Promise.reject(new Error('no packs here')),
    sample: () => Promise.reject(new Error('no packs here')),
    audio: async () => encodeWav([take], SR),
    impulse: () => Promise.reject(new Error('no packs here')),
  };
  const song = (notes?: AudioNotes): Project => {
    const p = newProject('Edited');
    p.tempo = [{ tick: 0, bpm: 120 }];
    const audio = { ...clip(legatoNotes({}), { offset: 0.1, gain: -2 }) };
    if (notes) audio.notes = notes;
    else delete audio.notes;
    p.tracks = [{ ...newAudioTrack('Vocal'), id: 'trk_v', regions: [{ ...newRegion(PPQ, PPQ * 6), audio }] }];
    return p;
  };

  it('plays the recording to the bit outside its patches and the edits within them, the same every time', async () => {
    const notes = line([
      { t: 0.3, d: 0.6, p: 57, g: -6 },
      { t: 0.9, d: 0.6, p: 60 },
      { t: 1.5, d: 0.6, p: 59, to: 61 },
    ]);
    const plain = await renderSession(song(), source, { sampleRate: SR, tail: 0.5, finish: false });
    const withEdits = await renderSession(song(notes), source, { sampleRate: SR, tail: 0.5, finish: false });
    expect(withEdits.errors).toEqual([]);
    const pieces = compileClips(song(notes).tracks[0] as Project['tracks'][number], compileTempo(song(notes), SR), SR);
    const patched = pieces.filter((c) => c.key.includes('#'));
    expect(patched).toHaveLength(2);
    const inPatch = (i: number) => patched.some((c) => i >= c.start && i < c.end);
    for (const ch of [0, 1]) {
      const x = plain.channels[ch] as Float32Array;
      const y = withEdits.channels[ch] as Float32Array;
      let outside = 0;
      for (let i = 0; i < x.length; i++) if (!inPatch(i) && x[i] !== y[i]) outside++;
      expect(outside).toBe(0);
      for (const c of patched) expect(differing(x.subarray(c.start, c.end), y.subarray(c.start, c.end)).length).toBe(1);
    }
    // and the same again
    const again = await renderSession(song(notes), source, { sampleRate: SR, tail: 0.5, finish: false });
    expect(bytes(again.channels[0]).equals(bytes(withEdits.channels[0]))).toBe(true);
    expect(bytes(again.channels[1]).equals(bytes(withEdits.channels[1]))).toBe(true);
  });
});
