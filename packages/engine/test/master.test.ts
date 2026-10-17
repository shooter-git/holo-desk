import { newAudioTrack, newProject, newRegion, newTrack, PPQ, type Track } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { finish, loudness } from '../src/master.ts';
import { renderSession } from '../src/render.ts';
import { encodeWav } from '../src/wav.ts';

const SR = 44100;

/** Swelling and decaying tones, one loud stretch. */
function music(seconds: number): [Float64Array, Float64Array] {
  const n = SR * seconds;
  const l = new Float64Array(n);
  const r = new Float64Array(n);
  for (let k = 0; k < seconds * 2; k++) {
    const t0 = k * 0.5;
    const f = 110 * 2 ** (((k * 7) % 24) / 12);
    const a = 0.2 + (t0 > seconds / 2 ? 0.6 : 0);
    for (let i = Math.round(t0 * SR); i < n; i++) {
      const t = i / SR - t0;
      const env = Math.exp(-t * 2.5) * (1 - Math.exp(-t * 300)) * a;
      const s = Math.sin(2 * Math.PI * f * (i / SR)) * env;
      l[i] = (l[i] as number) + s * (k % 2 ? 1 : 0.7);
      r[i] = (r[i] as number) + s * (k % 2 ? 0.7 : 1);
    }
  }
  return [l, r];
}

describe('finish', () => {
  for (const circular of [false, true]) {
    it(`lands on its loudness under its ceiling${circular ? ' (a loop)' : ''}`, () => {
      const out = finish(music(8), SR, { lufs: -16, ceiling: -2.2, glue: true, tilt: 1, circular });
      expect(Math.abs(out.lufs + 16)).toBeLessThan(0.1);
      expect(Math.abs(loudness(out.channels, SR) - out.lufs)).toBeLessThan(1e-9);
      let peak = 0;
      for (const ch of out.channels) for (const v of ch) peak = Math.max(peak, Math.abs(v));
      expect(20 * Math.log10(peak)).toBeLessThanOrEqual(-2.2 + 1e-6);
    });
  }
});

describe('a loop', () => {
  it('renders as it plays forever: what rings past the end comes round into the start', async () => {
    const p = newProject('Loop');
    p.sampleRate = SR;
    p.tempo = [{ tick: 0, bpm: 120 }];
    p.master.inserts = [];
    p.buses[0]?.channel.inserts.splice(0); // the default reverb bus, emptied: a straight path
    const track = newAudioTrack('Ring');
    // a ring that starts a second before the end and carries on past it
    const ring = new Float32Array(SR * 3);
    for (let i = 0; i < ring.length; i++) {
      const t = i / SR - 2;
      ring[i] = t < 0 ? 0 : Math.sin(2 * Math.PI * 440 * t) * Math.exp(-t * 3) * 0.5;
    }
    track.regions = [
      { ...newRegion(0, PPQ * 6), audio: { file: 'aud_ring', offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 } },
    ];
    track.channel.sends = [];
    p.tracks = [track];
    p.loop = { start: 0, end: PPQ * 6, tail: 1 };
    const wav = encodeWav([ring], SR, 'float32');
    const source = {
      instrument: () => Promise.reject(new Error('none')),
      sample: () => Promise.reject(new Error('none')),
      audio: () => Promise.resolve(wav),
      impulse: () => Promise.reject(new Error('none')),
    };
    // a 3 s loop of a 3 s file: no tail rings past it, so the loop is the file; then its first second
    const out = await renderSession(p, source, { sampleRate: SR });
    const left = out.channels[0] as Float32Array;
    expect(left.length).toBe(SR * 4);
    for (let i = 0; i < SR * 3; i += 997) expect(left[i]).toBeCloseTo(ring[i] as number, 6);
    for (let i = 0; i < SR; i += 997) expect(left[SR * 3 + i]).toBe(left[i]);

    // through a room, the ring's reverb rings on past the end, into the silent start
    track.channel.inserts = [{ id: 'fx_room', type: 'space', bypass: false, params: { space: 0, dry: 0, wet: -6 } }];
    const roomy = await renderSession(p, source, { sampleRate: SR });
    const start = roomy.channels[0] as Float32Array;
    let early = 0;
    for (let i = 0; i < SR / 10; i++) early = Math.max(early, Math.abs(start[i] as number));
    expect(early).toBeGreaterThan(1e-3);
  }, 60_000);

  it('plays every part again each time round, when the loop ends right on a block', async () => {
    // two beats at 120 bpm and 48 kHz: 48000 frames, 375 of the engine's blocks exactly
    const rate = 48000;
    const none = {
      instrument: () => Promise.reject(new Error('none')),
      sample: () => Promise.reject(new Error('none')),
      audio: () => Promise.reject(new Error('none')),
      impulse: () => Promise.reject(new Error('none')),
    };
    const peak = (x: Float32Array, from: number, to: number) => {
      let m = 0;
      for (let i = from; i < to; i++) m = Math.max(m, Math.abs(x[i] as number));
      return m;
    };
    // a note on a MIDI track (played from its events) and one on a planned part (Glass)
    const parts: [Track, number][] = [
      [newTrack('Keys', { type: 'synth', preset: 'Soft Keys' }), 0],
      [newTrack('Glass', { type: 'glass' }), PPQ],
    ];
    for (const [track, at] of parts) {
      const p = newProject('Block loop');
      p.sampleRate = rate;
      p.tempo = [{ tick: 0, bpm: 120 }];
      p.master.inserts = [];
      p.buses = [];
      track.channel.sends = [];
      track.regions = [{ ...newRegion(0, PPQ * 2), notes: [{ t: at, d: PPQ / 4, p: 72, v: 100 }] }];
      p.tracks = [track];
      const once = await renderSession(p, none, { sampleRate: rate, finish: false, loop: false, tail: 0 });
      p.loop = { start: 0, end: PPQ * 2, tail: 0 };
      const looped = await renderSession(p, none, { sampleRate: rate, finish: false });
      // the loop render keeps its last time round: the note is there, as loud as it is the first time
      const from = (at / PPQ) * (rate / 2);
      const first = peak(once.channels[0] as Float32Array, from, from + rate / 8);
      expect(first).toBeGreaterThan(0.01);
      expect(peak(looped.channels[0] as Float32Array, from, from + rate / 8)).toBeGreaterThan(first * 0.9);
    }
  }, 60_000);

  it('sounds the same whether its end falls on a block or between two', async () => {
    // two beats at 120 bpm and 48 kHz are 375 blocks; moved 7 ticks (175 frames) later, the same loop
    // starts and ends between blocks: what's kept must be the same sound
    const rate = 48000;
    const none = {
      instrument: () => Promise.reject(new Error('none')),
      sample: () => Promise.reject(new Error('none')),
      audio: () => Promise.reject(new Error('none')),
      impulse: () => Promise.reject(new Error('none')),
    };
    const song = (at: number) => {
      const p = newProject('Phase');
      p.sampleRate = rate;
      p.tempo = [{ tick: 0, bpm: 120 }];
      p.master.inserts = [];
      p.buses = [];
      const keys = newTrack('Keys', { type: 'synth', preset: 'Soft Keys' });
      const glass = newTrack('Glass', { type: 'glass' });
      // the second key and the glass ring on past the end, into the start
      keys.regions = [
        {
          ...newRegion(at, PPQ * 2),
          notes: [
            { t: 0, d: PPQ, p: 64, v: 90 },
            { t: PPQ * 1.5, d: PPQ, p: 67, v: 80 },
          ],
        },
      ];
      glass.regions = [{ ...newRegion(at, PPQ * 2), notes: [{ t: PPQ / 2, d: PPQ * 3, p: 76, v: 70 }] }];
      keys.channel.automation = [
        {
          param: 'volume',
          points: [
            [at, -6],
            [at + PPQ, 0],
            [at + PPQ * 2, -6],
          ],
          mode: 'read',
          curve: 'smooth',
        },
      ];
      for (const t of [keys, glass]) t.channel.sends = [];
      p.tracks = [keys, glass];
      p.loop = { start: at, end: at + PPQ * 2, tail: 0 };
      return p;
    };
    const a = (await renderSession(song(0), none, { sampleRate: rate, finish: false })).channels[0] as Float32Array;
    const b = (await renderSession(song(7), none, { sampleRate: rate, finish: false })).channels[0] as Float32Array;
    expect(a.length).toBe(b.length);
    let worst = 0;
    let peak = 0;
    for (let i = 0; i < a.length; i++) {
      worst = Math.max(worst, Math.abs((a[i] as number) - (b[i] as number)));
      peak = Math.max(peak, Math.abs(a[i] as number));
    }
    expect(peak).toBeGreaterThan(0.01);
    expect(worst).toBeLessThan(1e-5);
  }, 60_000);

  it('comes round as often as its longest voice needs: a voice longer than a turn sounds over itself', async () => {
    // a 30 s loop, and a note near its end that rings for over a minute (well past the halls' settling)
    const p = newProject('Long voice');
    p.sampleRate = SR;
    p.tempo = [{ tick: 0, bpm: 120 }];
    p.master.inserts = [];
    p.buses = [];
    const t = newTrack('Glass', { type: 'glass', line: true });
    t.channel.sends = [];
    const at = PPQ * 58; // 29 s
    const perf = { t: 29, d: 70, v: 0.6, tick: at, len: PPQ, vel: 76 };
    t.regions = [{ ...newRegion(0, PPQ * 400), notes: [{ t: at, d: PPQ, p: 72, v: 76, x: { perf } }] }];
    p.tracks = [t];
    const none = {
      instrument: () => Promise.reject(new Error('none')),
      sample: () => Promise.reject(new Error('none')),
      audio: () => Promise.reject(new Error('none')),
      impulse: () => Promise.reject(new Error('none')),
    };
    const turn = SR * 30;
    const once = await renderSession(p, none, { sampleRate: SR, finish: false, from: 0, to: PPQ * 60, tail: 80 });
    p.loop = { start: 0, end: PPQ * 60, tail: 0 };
    const looped = await renderSession(p, none, { sampleRate: SR, finish: false });
    // played forever, each turn holds every earlier turn's voice still sounding: the one voice, folded
    const x = once.channels[0] as Float32Array;
    const y = looped.channels[0] as Float32Array;
    let worst = 0;
    let peak = 0;
    for (let i = 0; i < turn; i += 7) {
      let folded = 0;
      for (let j = i; j < x.length; j += turn) folded += x[j] as number;
      worst = Math.max(worst, Math.abs((y[i] as number) - folded));
      peak = Math.max(peak, Math.abs(folded));
    }
    expect(peak).toBeGreaterThan(0.01);
    expect(worst).toBeLessThan(1e-5);
  }, 120_000);
});
