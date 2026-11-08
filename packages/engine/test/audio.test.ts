import { newAudioTrack, newProject, newRegion, PPQ } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { clipKey, compileClips, compileTempo } from '../src/compile.ts';
import { stretchAudio } from '../src/stretch.ts';

/** Upward zero crossings per second: a sine's frequency. */
function frequency(x: Float32Array, sr: number, from: number, to: number): number {
  let n = 0;
  for (let i = from + 1; i < to; i++) if ((x[i - 1] as number) < 0 && (x[i] as number) >= 0) n++;
  return (n * sr) / (to - from);
}

describe('time-stretch', () => {
  const sr = 48000;
  const sine = new Float32Array(sr * 2);
  for (let i = 0; i < sine.length; i++) sine[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * 0.5;

  for (const ratio of [0.5, 0.8, 1.25, 2]) {
    it(`makes it ${ratio}× as long at the same pitch`, () => {
      const [out] = stretchAudio([sine], ratio, sr);
      expect(out?.length).toBe(Math.round(sine.length * ratio));
      const f = frequency(out as Float32Array, sr, sr * 0.2, (out?.length ?? 0) - sr * 0.2);
      expect(f).toBeGreaterThan(215);
      expect(f).toBeLessThan(225);
      // and steady: no dips where the windows meet
      let peak = 0;
      for (let i = sr * 0.2; i < (out?.length ?? 0) - sr * 0.2; i++) peak = Math.max(peak, Math.abs(out?.[i] ?? 0));
      expect(peak).toBeLessThan(0.56);
      expect(peak).toBeGreaterThan(0.45);
    });
  }

  it('leaves audio alone at 1', () => {
    const [out] = stretchAudio([sine], 1, sr);
    expect(out).toEqual(sine);
  });
});

describe('audio regions in the engine', () => {
  it('turn into clips in song frames', () => {
    const p = newProject('Clips');
    p.tempo = [{ tick: 0, bpm: 120 }];
    const track = newAudioTrack('Gtr');
    const a = {
      ...newRegion(PPQ * 4, PPQ * 2),
      audio: { file: 'aud_1', offset: 0.5, gain: -6, fadeIn: 0.01, fadeOut: 0, stretch: 2 },
    };
    const b = { ...newRegion(0, PPQ), audio: { file: 'aud_1', offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 } };
    track.regions = [a, b];
    const segs = compileTempo(p, 48000);
    const clips = compileClips(track, segs, 48000);
    expect(clips.map((c) => c.start)).toEqual([0, 96000]);
    const c = clips[1];
    expect(c?.end).toBe(96000 + 48000);
    expect(c?.key).toBe('aud_1@2.0000');
    // half a second into the recording, stretched twice as long: a second into the stretched audio
    expect(c?.source).toBe(48000);
    expect(c?.gain).toBeCloseTo(0.501, 3);
    expect(c?.fadeIn).toBe(480);
    expect(clipKey(b.audio)).toBe('aud_1');
  });

  it('play only the top region where they overlap', () => {
    const p = newProject('Takes');
    p.tempo = [{ tick: 0, bpm: 120 }];
    const track = newAudioTrack('Vox');
    const clip = (file: string) => ({ file, offset: 0, gain: 0, fadeIn: 0.1, fadeOut: 0, stretch: 1 });
    // take 1 over bars 1-2, take 2 (newer, on top) over beats 2-3
    track.regions = [
      { ...newRegion(0, PPQ * 4), audio: clip('take1') },
      { ...newRegion(PPQ, PPQ * 2), audio: clip('take2') },
    ];
    const clips = compileClips(track, compileTempo(p, 48000), 48000);
    expect(clips.map((c) => [c.key, c.start, c.end, c.source])).toEqual([
      ['take1', 0, 24000, 0],
      ['take2', 24000, 72000, 0],
      ['take1', 72000, 96000, 72000],
    ]);
    // the second piece of take 1 keeps take 1's own fade timing
    expect(clips[2]?.regionStart).toBe(0);
    expect(clips[2]?.fadeIn).toBe(4800);
  });
});

describe('sample-rate conversion', () => {
  it('keeps a tone in tune and in level, 44.1 to 48 kHz and back', async () => {
    const { resample } = await import('../src/resample.ts');
    const x = new Float32Array(44100);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 1000 * i) / 44100) * 0.5;
    const y = resample(x, 44100, 48000);
    expect(y.length).toBe(48000);
    // compare with the ideal tone away from the edges
    let err = 0;
    for (let i = 2000; i < 46000; i++)
      err = Math.max(err, Math.abs((y[i] as number) - Math.sin((2 * Math.PI * 1000 * i) / 48000) * 0.5));
    expect(err).toBeLessThan(1e-4);
    const back = resample(y, 48000, 44100);
    let err2 = 0;
    for (let i = 2000; i < 42000; i++) err2 = Math.max(err2, Math.abs((back[i] as number) - (x[i] as number)));
    expect(err2).toBeLessThan(2e-4);
  });
});

describe('rendering', () => {
  it('gives the same numbers every time, from the same session', async () => {
    const { renderSession } = await import('../src/render.ts');
    const { newTrack } = await import('@holo/session');
    const p = newProject('Same');
    p.tempo = [{ tick: 0, bpm: 100 }];
    const keys = newTrack('Keys', { type: 'synth', preset: 'Soft Keys' });
    const drums = newTrack('Drums', { type: 'synth', preset: 'Drum Synth' });
    keys.regions = [
      { ...newRegion(0, PPQ * 4), notes: [0, 1, 2, 3].map((i) => ({ t: i * PPQ, d: PPQ, p: 60 + i * 4, v: 90 })) },
    ];
    drums.regions = [
      {
        ...newRegion(0, PPQ * 4),
        notes: [0, 1, 2, 3].map((i) => ({ t: i * PPQ, d: PPQ / 2, p: i % 2 ? 38 : 36, v: 100 })),
      },
    ];
    keys.channel.inserts = [
      { id: 'fx_r', type: 'reverb', bypass: false, params: {} },
      { id: 'fx_s', type: 'space', bypass: false, params: { space: 0, dry: 0, wet: -6 } },
    ];
    p.tracks = [keys, drums];
    const source = {
      instrument: () => Promise.reject(new Error('no packs here')),
      sample: () => Promise.reject(new Error('no packs here')),
      audio: () => Promise.reject(new Error('no audio here')),
      impulse: () => Promise.reject(new Error('no packs here')),
    };
    const a = await renderSession(p, source, { sampleRate: 44100, tail: 1 });
    const b = await renderSession(p, source, { sampleRate: 44100, tail: 1 });
    expect(a.errors).toEqual([]);
    expect(a.channels[0]?.length).toBe(Math.round(44100 * 3.4));
    let loud = 0;
    for (const v of a.channels[0] ?? []) loud = Math.max(loud, Math.abs(v));
    expect(loud).toBeGreaterThan(0.05);
    expect(
      Buffer.from(a.channels[0]?.buffer ?? new ArrayBuffer(0)).equals(
        Buffer.from(b.channels[0]?.buffer ?? new ArrayBuffer(0)),
      ),
    ).toBe(true);
    expect(
      Buffer.from(a.channels[1]?.buffer ?? new ArrayBuffer(0)).equals(
        Buffer.from(b.channels[1]?.buffer ?? new ArrayBuffer(0)),
      ),
    ).toBe(true);
  });
  it('plays the repeats as written: a bar with a repeat sign plays twice', async () => {
    const { renderSession } = await import('../src/render.ts');
    const { newTrack } = await import('@holo/session');
    const p = newProject('Twice');
    p.tempo = [{ tick: 0, bpm: 120 }];
    const drums = newTrack('Drums', { type: 'synth', preset: 'Drum Synth' });
    drums.regions = [{ ...newRegion(0, PPQ * 4), notes: [{ t: 0, d: PPQ / 2, p: 36, v: 110 }] }];
    p.tracks = [drums];
    p.form = [{ tick: PPQ * 4, k: 'end' }];
    const source = {
      instrument: () => Promise.reject(new Error('no packs here')),
      sample: () => Promise.reject(new Error('no packs here')),
      audio: () => Promise.reject(new Error('no audio here')),
      impulse: () => Promise.reject(new Error('no packs here')),
    };
    const sr = 44100;
    const out = await renderSession(p, source, { sampleRate: sr, tail: 1 });
    expect(out.errors).toEqual([]);
    // two bars at 120 (the bar twice), and the tail
    expect(out.channels[0]?.length).toBe(sr * 5);
    const peak = (from: number, to: number) => {
      let m = 0;
      for (const v of (out.channels[0] ?? new Float32Array()).subarray(Math.round(from * sr), Math.round(to * sr)))
        m = Math.max(m, Math.abs(v));
      return m;
    };
    // the kick at the start of each time through, and quiet before the second
    expect(peak(0, 0.2)).toBeGreaterThan(0.05);
    expect(peak(1.7, 1.99)).toBeLessThan(peak(0, 0.2) / 20);
    expect(peak(2, 2.2)).toBeGreaterThan(0.05);
  });
});

describe('a kit on several microphones, rendered headless', () => {
  it('loads each microphone and its pan from the pack, and mixes them at the song’s knobs', async () => {
    const { renderSession } = await import('../src/render.ts');
    const { encodeWav } = await import('../src/wav.ts');
    const { newTrack } = await import('@holo/session');
    const sr = 48000;
    // a mono close microphone (a steady 0.25) and a stereo room (0.1 left, 0.05 right), half a second each
    const files: Record<string, Uint8Array> = {
      'snare/close.wav': encodeWav([new Float32Array(sr / 2).fill(0.25)], sr),
      'snare/room.wav': encodeWav([new Float32Array(sr / 2).fill(0.1), new Float32Array(sr / 2).fill(0.05)], sr),
    };
    const zone = (file: string, mic: string, pan?: number) => ({
      file,
      root: 38,
      lo: 38,
      hi: 38,
      lovel: 1,
      hivel: 127,
      gain: 0,
      start: 0,
      end: sr / 2,
      loopStart: 0,
      loopEnd: 0,
      rate: sr,
      rr: 1,
      mic,
      ...(pan !== undefined ? { pan } : {}),
    });
    const source = {
      instrument: async (pack: string, name: string) => ({
        pack,
        name,
        release: 0.05,
        attack: 0,
        oneShot: true,
        pitched: false,
        velocityRange: 0,
        mics: [
          { id: 'close', name: 'Close' },
          { id: 'room', name: 'Room', level: -6.0206 },
        ],
        zones: [zone('snare/close.wav', 'close', 1), zone('snare/room.wav', 'room')],
      }),
      sample: async (_pack: string, file: string) => files[file] as Uint8Array,
      audio: () => Promise.reject(new Error('no audio here')),
      impulse: () => Promise.reject(new Error('no packs here')),
    };
    const p = newProject('Kit');
    p.tempo = [{ tick: 0, bpm: 120 }];
    const kit = newTrack('Kit', { type: 'sampler', pack: 'test', name: 'kit' });
    kit.regions = [{ ...newRegion(0, PPQ * 4), notes: [{ t: 0, d: PPQ / 2, p: 38, v: 127 }] }];
    p.tracks = [kit];
    const at = (out: Float32Array[], side: number) => (out[side] as Float32Array)[Math.round(sr * 0.1)] as number;
    const plain = await renderSession(p, source, { sampleRate: sr, tail: 0.5, finish: false });
    expect(plain.errors).toEqual([]);
    // the close microphone hard right (√2 × 0.25 there, nothing left), the room at its starting -6 dB
    expect(at(plain.channels, 0)).toBeCloseTo(0.05, 4);
    expect(at(plain.channels, 1)).toBeCloseTo(0.25 * Math.SQRT2 + 0.025, 4);
    // the song's knobs: the close microphone off, the room up to 0 dB
    kit.instrument = { type: 'sampler', pack: 'test', name: 'kit', params: { 'mic:close': -60, 'mic:room': 0 } };
    const mixed = await renderSession(p, source, { sampleRate: sr, tail: 0.5, finish: false });
    expect(at(mixed.channels, 0)).toBeCloseTo(0.1, 4);
    expect(at(mixed.channels, 1)).toBeCloseTo(0.05, 4);
  });
});
