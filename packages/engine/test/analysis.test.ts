import { newAudioTrack, newProject, newRegion, newTrack, PPQ, type Project, type Track } from '@holo/session';
import { describe, expect, it } from 'vitest';
import {
  bandLevels,
  bandResponse,
  type Decoded,
  LoudnessMeter,
  lineNotes,
  masking,
  measureLoudness,
  measureRecording,
  measureTake,
  OCTAVE_BANDS,
  spectralTilt,
  THIRD_BANDS,
  takePieces,
} from '../src/analysis/index.ts';
import { loudness } from '../src/master.ts';

const SR = 48000;
const BAR = PPQ * 4;

interface ToneOptions {
  /** [Hz, ± cents] */
  vibrato?: [number, number];
  /** Cents it moves from its start to its end. */
  drift?: number;
  /** A band-limited sawtooth (its first 20 harmonics), not a sine. */
  saw?: boolean;
  amp?: number;
}

/** A tone at a MIDI pitch (with cents), `seconds` long. */
function tone(midi: number, seconds: number, o: ToneOptions = {}): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  const amp = o.amp ?? 0.4;
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    let m = midi + ((o.drift ?? 0) / 100) * (t / seconds);
    if (o.vibrato) m += (o.vibrato[1] / 100) * Math.sin(2 * Math.PI * o.vibrato[0] * t);
    phase += (440 * 2 ** ((m - 69) / 12)) / SR;
    phase -= Math.floor(phase);
    if (o.saw) {
      let v = 0;
      for (let k = 1; k <= 20; k++) v += Math.sin(2 * Math.PI * k * phase) / k;
      out[i] = amp * 0.6 * v;
    } else out[i] = amp * Math.sin(2 * Math.PI * phase);
  }
  return out;
}

const silence = (seconds: number) => new Float32Array(Math.round(seconds * SR));
const join = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
/** Tones placed at times (s) in `seconds` of silence. */
function placed(seconds: number, notes: [number, number, number, ToneOptions?][]): Float32Array {
  const out = silence(seconds);
  for (const [at, length, midi, o] of notes) out.set(tone(midi, length, o), Math.round(at * SR));
  return out;
}

let seed = 11;
const noise = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 30 - 1;
};

/** A song with an audio track whose regions play `file`, and a decoder that hands it out. */
function takeSong(
  file: Float32Array,
  regions: { start: number; length: number; offset?: number; stretch?: number; id?: string }[],
  o: { key?: string; tempo?: Project['tempo'] } = {},
): { song: Project; track: Track; decode: (f: string) => Decoded | null } {
  const song = newProject('Take');
  song.key = o.key ?? null;
  if (o.tempo) song.tempo = o.tempo;
  const track = newAudioTrack('Vocals');
  track.id = 'trk_vox';
  regions.forEach((r, i) => {
    const region = { ...newRegion(r.start, r.length, `Take ${i + 1}`), id: r.id ?? `rgn_${i}` };
    region.audio = { file: 'aud_take', offset: r.offset ?? 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: r.stretch ?? 1 };
    track.regions.push(region);
  });
  song.tracks.push(track);
  return { song, track, decode: (f) => (f === 'aud_take' ? { rate: SR, channels: [file] } : null) };
}

describe('a line’s pitch', () => {
  it('reads tones ±5, ±30 and ±50 cents off to within 2 cents', () => {
    for (const base of [45, 57, 64, 69, 76])
      for (const cents of [-50, -30, -5, 5, 30, 50]) {
        const notes = lineNotes(join(silence(0.2), tone(base + cents / 100, 0.8), silence(0.2)), SR);
        expect(notes, `${base} ${cents}`).toHaveLength(1);
        expect(Math.abs((notes[0]?.pitch ?? 0) - (base + cents / 100)) * 100, `${base} ${cents}`).toBeLessThan(2);
      }
  });

  it('reads a 5.5 Hz vibrato of ±40 cents, around the note it’s on', () => {
    const [note] = lineNotes(join(silence(0.2), tone(64, 2, { vibrato: [5.5, 40] }), silence(0.2)), SR);
    expect(note?.vibrato?.rate).toBeCloseTo(5.5, 1);
    expect(Math.abs((note?.vibrato?.depth ?? 0) - 40)).toBeLessThan(4);
    expect(Math.abs((note?.pitch ?? 0) - 64) * 100).toBeLessThan(2);
    // a steady tone has none
    expect(lineNotes(join(silence(0.2), tone(64, 2), silence(0.2)), SR)[0]?.vibrato).toBeNull();
  });

  it('reads a note that sags as it’s held', () => {
    const [sagging] = lineNotes(join(silence(0.2), tone(67, 2, { drift: -30 }), silence(0.2)), SR);
    // the held part (its attack and end left out) moves most of the 30 cents
    expect(sagging?.drift).toBeLessThan(-25);
    expect(sagging?.drift).toBeGreaterThan(-32);
    const [steady] = lineNotes(join(silence(0.2), tone(67, 2), silence(0.2)), SR);
    expect(Math.abs(steady?.drift ?? 99)).toBeLessThan(2);
  });

  it('hears a sawtooth in its own octave, low and high', () => {
    for (const m of [40, 45, 52, 57, 64, 69, 76, 81]) {
      const notes = lineNotes(join(silence(0.2), tone(m, 0.8, { saw: true }), silence(0.2)), SR);
      expect(notes, `${m}`).toHaveLength(1);
      expect(Math.round(notes[0]?.pitch ?? 0), `${m}`).toBe(m);
    }
  });

  it('splits notes where the pitch moves, from silence or straight on', () => {
    const notes = lineNotes(join(silence(0.2), tone(60, 0.5), tone(62, 0.5), tone(64, 0.5), silence(0.2)), SR);
    expect(notes.map((n) => Math.round(n.pitch))).toEqual([60, 62, 64]);
    expect(notes.map((n) => n.attack)).toEqual([true, false, false]);
    expect(notes[1]?.start).toBeCloseTo(0.7, 1);
  });
});

describe('a take on the timeline', () => {
  it('finds notes 20 ms early or late against the grid', () => {
    // 120 bpm: a sixteenth is 125 ms; notes on beats, some moved 20 ms
    const shifts = [0, 0.02, -0.02, 0, 0.02, -0.02];
    const file = placed(
      4,
      shifts.map((s, i) => [0.5 + i * 0.5 + s, 0.3, 67] as [number, number, number]),
    );
    const { song, track, decode } = takeSong(file, [{ start: 0, length: BAR * 2 }]);
    const report = measureTake(song, track, decode);
    expect(report.notes).toHaveLength(6);
    report.notes.forEach((n, i) => {
      expect(Math.abs((n.grid ?? 99) - (shifts[i] as number) * 1000), `note ${i}`).toBeLessThan(3);
    });
    expect(report.summary.timing?.late).toBe(0);
    expect(report.grid).toBe(240);
  });

  it('starts a softly sung note where its voice starts: a fade-in and a scoop on the beat read on the beat', () => {
    // as a singer's "ah" (the e2e run's test vocal): a voice's harmonics through vowel formants,
    // fading in over 50 ms while scooping up from 40 cents under over 60 ms, a vibrato coming in
    // after 0.35 s; notes 1.2 s long every two beats at 84 bpm, exactly on the beat, some off pitch;
    // a breath in some gaps, and before one note an unvoiced "s" up to the beat
    const bpm = 84;
    const beat = 60 / bpm;
    const formants: [number, number, number][] = [
      [730, 90, 1],
      [1090, 110, 0.5],
      [2440, 170, 0.25],
      [3400, 250, 0.08],
    ];
    const gain = (f: number) => formants.reduce((g, [fc, bw, a]) => g + a / (1 + ((f - fc) / bw) ** 2), 0.02);
    const sungNote = (midi: number, seconds: number): Float32Array => {
      const out = new Float32Array(Math.round(seconds * SR));
      const hz = 440 * 2 ** ((midi - 69) / 12);
      const harmonics: number[] = [];
      for (let k = 1; k * hz < 8000; k++) harmonics.push(gain(k * hz) / k);
      let phase = 0;
      let top = 0;
      for (let i = 0; i < out.length; i++) {
        const t = i / SR;
        const scoop = -40 * Math.max(0, 1 - t / 0.06);
        const vibrato = 20 * Math.min(1, Math.max(0, (t - 0.35) / 0.3)) * Math.sin(2 * Math.PI * 5.5 * t);
        phase += (hz * 2 ** ((scoop + vibrato) / 1200)) / SR;
        let v = 0;
        harmonics.forEach((g, k) => {
          v += g * Math.sin(2 * Math.PI * (k + 1) * phase + 0.3 * (k + 1));
        });
        out[i] = v;
        top = Math.max(top, Math.abs(v));
      }
      for (let i = 0; i < out.length; i++) {
        const t = i / SR;
        const env = Math.max(0, Math.min(1, t / 0.05, (seconds - t) / 0.07));
        out[i] = 0.3 * ((out[i] as number) / top + 0.004 * noise()) * env;
      }
      return out;
    };
    const pitches = [62, 64.7, 69, 67.25, 65, 63.65, 62, 69.4, 70, 68.8, 67, 65.3];
    const file = silence(beat * 2 * pitches.length + 1);
    pitches.forEach((p, i) => {
      const at = Math.round(i * 2 * beat * SR);
      const note = sungNote(p, 1.2);
      for (let k = 0; k < note.length; k++) file[at + k] = (file[at + k] as number) + (note[k] as number);
      if (i % 3 === 2) {
        // a breath, 30 ms after the note, 160 ms long, 26 dB under it
        const b0 = at + Math.round(1.23 * SR);
        const bn = Math.round(0.16 * SR);
        for (let k = 0; k < bn; k++) file[b0 + k] = 0.015 * noise() * Math.sin((Math.PI * k) / bn) ** 2;
      }
    });
    // an unvoiced "h" before note 6 (noise about 9 dB under the vowel): from 90 ms before the beat,
    // fading out over the vowel's first 30 ms, as a consonant runs into the vowel after it (counted by
    // its level alone, it would start the note 90 ms early)
    const h0 = Math.round((5 * 2 * beat - 0.09) * SR);
    for (let k = 0; k < Math.round(0.12 * SR); k++) {
      const fade = Math.min(1, (0.12 - k / SR) / 0.04);
      file[h0 + k] = (file[h0 + k] as number) + 0.1 * fade * noise();
    }
    const tempo = [{ tick: 0, bpm }];
    const { song, track, decode } = takeSong(file, [{ start: BAR, length: BAR * 7 }], { key: 'D minor', tempo });
    const report = measureTake(song, track, decode);
    expect(report.notes).toHaveLength(pitches.length);
    report.notes.forEach((n, i) => {
      expect(Math.abs(n.grid ?? 99), `note ${i + 1} (${n.grid} ms)`).toBeLessThanOrEqual(10);
      expect(Math.abs(n.pitch - (pitches[i] as number)) * 100, `note ${i + 1}`).toBeLessThan(2);
    });
    expect(Math.abs(report.summary.timing?.mean ?? 99)).toBeLessThanOrEqual(10);
    expect(report.summary.timing?.late).toBe(0);
  });

  it('places a region’s notes through its offset, its stretch and a tempo change', () => {
    // 120 bpm, then 60 from bar 3; the region starts at bar 2, 1 s into its file, played twice as long
    const file = placed(4, [
      [1.5, 0.3, 69],
      [2.5, 0.3, 72],
    ]);
    const tempo = [
      { tick: 0, bpm: 120 },
      { tick: BAR * 2, bpm: 60 },
    ];
    const { song, track, decode } = takeSong(file, [{ start: BAR, length: BAR * 2, offset: 1, stretch: 2 }], { tempo });
    const [piece] = takePieces(song, track);
    expect(piece).toMatchObject({ fileStart: 1, at: 2, stretch: 2 });
    // two bars: one at 120 (2 s), one at 60 (4 s) → 6 s of timeline, 3 s of file
    expect(piece?.fileEnd).toBeCloseTo(4, 6);
    const report = measureTake(song, track, decode);
    // file 1.5 s → 2 + 0.5 × 2 = 3 s (bar 2, beat 3: tick 5760); file 2.5 s → 5 s (bar 3 at 60 bpm, beat 2: 8640)
    expect(report.notes.map((n) => Math.round(n.pitch))).toEqual([69, 72]);
    expect(Math.abs((report.notes[0]?.tick ?? 0) - 5760)).toBeLessThan(8);
    expect(Math.abs((report.notes[1]?.tick ?? 0) - 8640)).toBeLessThan(8);
    // and its length is stretched too
    expect(report.notes[0]?.length).toBeCloseTo(0.6, 1);
  });

  it('hears the later take where two overlap, as the engine plays them', () => {
    // two regions over the same file: the second (later, on top) covers the middle of the first
    const file = placed(6, [
      [0.5, 0.4, 60],
      [2.5, 0.4, 62],
      [4.5, 0.4, 64],
    ]);
    const { song, track, decode } = takeSong(file, [
      { start: 0, length: BAR * 3, id: 'rgn_under' },
      // at 2 s on the timeline, playing the file from 4 s: its 64 at 2.5 s, where the first had its 62
      { start: BAR, length: BAR, offset: 4, id: 'rgn_over' },
    ]);
    const pieces = takePieces(song, track);
    expect(pieces.map((p) => [p.region, p.at, p.fileStart])).toEqual([
      ['rgn_under', 0, 0],
      ['rgn_over', 2, 4],
      ['rgn_under', 4, 4],
    ]);
    const report = measureTake(song, track, decode);
    expect(report.notes.map((n) => [Math.round(n.pitch), n.region])).toEqual([
      [60, 'rgn_under'],
      [64, 'rgn_over'],
      [64, 'rgn_under'],
    ]);
    // one region alone, and a range
    expect(measureTake(song, track, decode, { region: 'rgn_over' }).notes).toHaveLength(1);
    expect(measureTake(song, track, decode, { from: BAR * 2 }).notes.map((n) => n.tick)).toHaveLength(1);
  });

  it('measures against the key’s nearest scale tone, a reference track, or the nearest semitone', () => {
    // in D minor: E4 30 cents sharp; C#4 (out of the key); F4 50 cents sharp (between F and F#: F, in the key)
    const file = placed(4, [
      [0.5, 0.5, 64.3],
      [1.5, 0.5, 61],
      [2.5, 0.5, 65.5],
    ]);
    const { song, track, decode } = takeSong(file, [{ start: 0, length: BAR * 2 }], { key: 'D minor' });
    const byKey = measureTake(song, track, decode);
    expect(byKey.against).toEqual({ kind: 'key', keys: ['D minor'] });
    expect(byKey.notes.map((n) => [n.target, Math.round(n.cents), n.inKey])).toEqual([
      [64, 30, true],
      [61, 0, false],
      [65, 50, true],
    ]);
    // against a melody that plays E4 all through: the C#4 is 300 cents under it
    const melody = newTrack('Melody', { type: 'synth', preset: 'Warm Pad' });
    melody.id = 'trk_melody';
    const r = newRegion(0, BAR * 2, 'Line');
    r.notes = [{ t: 0, d: BAR * 2, p: 76, v: 90 }];
    melody.regions.push(r);
    song.tracks.push(melody);
    const byTrack = measureTake(song, track, decode, { against: melody });
    expect(byTrack.against).toEqual({ kind: 'track', track: 'trk_melody' });
    expect(byTrack.notes.map((n) => [n.ref, Math.round(n.cents)])).toEqual([
      [76, 30],
      [76, -300],
      [76, 150],
    ]);
    // (the last is half way between F4 and F#4: either is its nearest)
    const bySemitone = measureTake(song, track, decode, { against: 'none' });
    expect(bySemitone.against).toEqual({ kind: 'none' });
    expect(bySemitone.notes.map((n) => [n.target, Math.round(Math.abs(n.cents))])).toEqual([
      [64, 30],
      [61, 0],
      [expect.toSatisfy((t: number) => t === 65 || t === 66), 50],
    ]);
  });

  it('sums up the pitch and gives each phrase its level', () => {
    // a phrase, a breath, then a phrase 6 dB quieter
    const file = placed(5, [
      [0.2, 0.4, 62.2, { amp: 0.4 }],
      [0.7, 0.4, 64, { amp: 0.4 }],
      [2.5, 0.4, 65, { amp: 0.2 }],
      [3.0, 0.4, 67, { amp: 0.2 }],
    ]);
    const { song, track, decode } = takeSong(file, [{ start: 0, length: BAR * 3 }], { key: 'C major' });
    const r = measureTake(song, track, decode);
    expect(r.phrases.map((p) => p.notes)).toEqual([2, 2]);
    expect((r.phrases[0]?.db ?? 0) - (r.phrases[1]?.db ?? 0)).toBeCloseTo(6, 0);
    expect(r.summary.notes).toBe(4);
    expect(r.summary.meanAbs).toBeCloseTo(5, 0);
    expect(r.summary.within25).toBe(1);
  });

  it('measures a recording off the timeline, in seconds', () => {
    const r = measureRecording([placed(2, [[0.5, 0.6, 69.1]])], SR, { tick: 0, fifths: 0, mode: 'major' });
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatchObject({ tick: null, grid: null, target: 69 });
    expect(r.notes[0]?.at).toBeCloseTo(0.5, 2);
    expect(r.against).toEqual({ kind: 'key', keys: ['C major'] });
  });
});

describe('loudness', () => {
  const sine = (dbfs: number, seconds: number, hz = 1000) => {
    const a = 10 ** (dbfs / 20);
    const out = new Float32Array(Math.round(seconds * SR));
    for (let i = 0; i < out.length; i++) out[i] = a * Math.sin((2 * Math.PI * hz * i) / SR);
    return out;
  };

  it('reads EBU Tech 3341’s 1 kHz stereo sines: −23 dBFS as −23.0 LUFS, −33 as −33.0', () => {
    for (const level of [-23, -33]) {
      const s = sine(level, 20);
      const r = measureLoudness([s, s], SR);
      expect(Math.abs((r.integrated ?? 0) - level)).toBeLessThanOrEqual(0.1);
      expect(Math.abs((r.momentaryMax ?? 0) - level)).toBeLessThanOrEqual(0.1);
      expect(Math.abs((r.shortTermMax ?? 0) - level)).toBeLessThanOrEqual(0.1);
      expect(r.range).toBeLessThan(0.1);
      expect(r.over).toBe(0);
    }
  });

  it('reads what the finish reads', () => {
    // bursts of noise at different levels, gated as BS.1770-4 gates them
    const parts: Float32Array[] = [];
    for (const amp of [0.3, 0.05, 0.002, 0.2, 0]) parts.push(new Float32Array(SR * 3).map(() => amp * noise()));
    const left = join(...parts);
    const right = left.map((v) => v * 0.7);
    const ours = new LoudnessMeter([left, right], SR).integrated() ?? 0;
    const finish = loudness([Float64Array.from(left), Float64Array.from(right)], SR);
    expect(Math.abs(ours - finish)).toBeLessThan(0.01);
  });

  it('reads a true peak over the sample peak between samples, and counts samples at full scale', () => {
    // a sine at a quarter of the rate, sampled 45° off its crests: every sample is 0.707 of its peak
    const s = new Float32Array(SR).map((_, i) => Math.sin((Math.PI / 2) * i + Math.PI / 4));
    const r = measureLoudness([s], SR);
    expect(r.samplePeak).toBeCloseTo(-3.01, 1);
    expect(r.truePeak).toBeGreaterThan(-0.5);
    // clipped: two runs of samples at full scale
    const clipped = sine(-6, 2).map((v, i) => ((i >= 1000 && i < 1010) || (i >= 5000 && i < 5003) ? 1 : v));
    const c = measureLoudness([clipped], SR);
    expect(c).toMatchObject({ over: 13, overRuns: 2, samplePeak: 0 });
    // silence reads as silence
    expect(measureLoudness([silence(2)], SR)).toMatchObject({ integrated: null, truePeak: null, samplePeak: null });
  });

  it('reads a section of a recording', () => {
    const m = new LoudnessMeter([join(sine(-20, 5), sine(-30, 5))], SR);
    expect(m.integrated(0, 5)).toBeCloseTo(-23, 0);
    expect(m.integrated(5, 10)).toBeCloseTo(-33, 0);
  });
});

describe('the spectrum', () => {
  it('puts a sine in its band, at its level', () => {
    const s = tone(69 + 12 * Math.log2(1000 / 440), 2, { amp: 0.1 });
    const thirds = bandLevels([s], SR, 'third');
    const at = THIRD_BANDS.indexOf(1000);
    expect(thirds[at]).toBeCloseTo(-23, 0);
    thirds.forEach((v, i) => {
      if (i !== at) expect(v === null || v < -60, `${THIRD_BANDS[i]}`).toBe(true);
    });
    expect(bandLevels([s], SR, 'octave')[OCTAVE_BANDS.indexOf(1000)]).toBeCloseTo(-23, 0);
  });

  it('tilts white noise up 3 dB an octave', () => {
    const white = new Float32Array(SR * 4).map(() => 0.3 * noise());
    expect(Math.abs((spectralTilt(bandLevels([white], SR, 'third')) ?? 0) - 3)).toBeLessThan(0.5);
  });

  it('reads a filter’s gain from its response', () => {
    const impulse = new Float32Array(4096);
    impulse[0] = 1;
    expect(bandResponse([impulse], SR).every((g) => g === null || Math.abs(g) < 0.01)).toBe(true);
    // two samples averaged: down 2 dB at 10 kHz (cos(π·10k/48k)), flat in the bass
    const average = new Float32Array(4096);
    average[0] = 0.5;
    average[1] = 0.5;
    const g = bandResponse([average], SR);
    expect(g[THIRD_BANDS.indexOf(100)]).toBeCloseTo(0, 1);
    expect(g[THIRD_BANDS.indexOf(10000)]).toBeCloseTo(20 * Math.log10(Math.cos((Math.PI * 10000) / SR)), 0);
  });

  it('finds where two tracks compete, and only there', () => {
    const hz = (f: number) => 69 + 12 * Math.log2(f / 440);
    const mixOf = (...parts: Float32Array[]) => parts.reduce((a, p) => a.map((v, i) => v + (p[i] as number)));
    const a = mixOf(tone(hz(250), 4, { amp: 0.3 }), tone(hz(4000), 4, { amp: 0.1 }));
    const b = mixOf(tone(hz(250), 4, { amp: 0.3 / Math.SQRT2 }), tone(hz(1000), 4, { amp: 0.1 }));
    const bands = masking([a], [b], SR);
    expect(bands.map((x) => x.hz)).toEqual([250]);
    expect(bands[0]?.overlap).toBe(1);
    expect(bands[0]?.diff).toBeCloseTo(3, 0);
    // nothing in common
    expect(masking([tone(hz(250), 4)], [tone(hz(4000), 4)], SR)).toEqual([]);
  });
});
