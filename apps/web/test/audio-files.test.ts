import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioFiles, peaksFromBytes, peaksToBytes, Turns } from '../src/audio/files.ts';

/** A decoder that counts: how many files it has decoded, and how many at once. */
function decoder(rate = 48000, frames = 4800) {
  const state = { calls: 0, atOnce: 0, most: 0 };
  const ctx = {
    sampleRate: rate,
    async decodeAudioData(_bytes: ArrayBuffer) {
      state.calls++;
      state.most = Math.max(state.most, ++state.atOnce);
      await new Promise((done) => setTimeout(done, 15));
      state.atOnce--;
      const left = Float32Array.from({ length: frames }, (_, i) => Math.sin(i / 20));
      const right = Float32Array.from({ length: frames }, (_, i) => Math.cos(i / 20) * 0.5);
      return {
        numberOfChannels: 2,
        sampleRate: rate,
        duration: frames / rate,
        getChannelData: (c: number) => (c === 0 ? left : right),
      } as unknown as AudioBuffer;
    },
  };
  return { state, ctx: ctx as unknown as BaseAudioContext };
}

describe('jobs as many at a time as their weights allow', () => {
  const job = (weight: number, log: { now: number; most: number; done: number[] }, i: number) => async () => {
    log.now += weight;
    log.most = Math.max(log.most, log.now);
    await new Promise((ok) => setTimeout(ok, 5));
    log.now -= weight;
    log.done.push(i);
  };

  it('never runs more than there is room for, and runs them all in turn', async () => {
    const turns = new Turns(10);
    const log = { now: 0, most: 0, done: [] as number[] };
    await Promise.all([4, 4, 4, 1, 1, 9, 2].map((w, i) => turns.run(job(w, log, i), w)));
    expect(log.most).toBeLessThanOrEqual(10);
    expect(log.done).toHaveLength(7);
    // (in the order they came: the light ones don't jump the heavy one's place)
    expect(log.done.indexOf(5)).toBeLessThan(log.done.indexOf(6));
  });

  it('lets one job through however heavy it is, alone', async () => {
    const turns = new Turns(10);
    const log = { now: 0, most: 0, done: [] as number[] };
    await Promise.all([50, 3, 60].map((w, i) => turns.run(job(w, log, i), w)));
    expect(log.most).toBe(60);
    expect(log.done).toEqual([0, 1, 2]);
  });

  it('goes on after a job that fails', async () => {
    const turns = new Turns(1);
    await expect(turns.run(() => Promise.reject(new Error('no')))).rejects.toThrow('no');
    expect(await turns.run(async () => 3)).toBe(3);
  });
});

describe("a file's peaks, kept on the device", () => {
  it('come back from their bytes as they went in', () => {
    const peaks = {
      step: 256,
      rate: 44100,
      min: new Float32Array([-0.5, -0.25, 0]),
      max: new Float32Array([0.5, 1, 0.125]),
    };
    expect(peaksFromBytes(peaksToBytes(peaks))).toEqual(peaks);
  });

  it("are not made of bytes that aren't peaks", () => {
    expect(peaksFromBytes(new ArrayBuffer(8))).toBeNull();
    expect(peaksFromBytes(new Float32Array([256, 48000, 5, 0, 0]).buffer)).toBeNull();
    expect(peaksFromBytes(new Float32Array([0, 48000, 1, 0, 0]).buffer)).toBeNull();
  });
});

describe('audio files for the engine and the screen', () => {
  afterEach(() => vi.unstubAllGlobals());
  const served = () => vi.stubGlobal('fetch', async () => new Response(new ArrayBuffer(64)));
  const file = (id: string, seconds: number) => ({ id, name: id, seconds, rate: 48000, channels: 2 });
  const each = (n: number) => Array.from({ length: n }, (_, i) => `aud_${i}`);

  it('decodes a file once for its waveform and its clips together', async () => {
    served();
    const files = new AudioFiles();
    const { state, ctx } = decoder();
    // the screen asks for the peaks as the engine asks for two clips of the same file
    files.ensurePeaks('prj_a', 'aud_one', ctx);
    const [a, b] = await Promise.all([
      files.load('prj_a', { file: 'aud_one', stretch: 1 }, ctx),
      files.load('prj_a', { file: 'aud_one', stretch: 1 }, ctx),
    ]);
    expect(state.calls).toBe(1);
    expect(files.peaks.get('aud_one')?.rate).toBe(48000);
    expect(a).toHaveLength(2);
    // each asker has its own copy to hand on
    expect(a[0]).not.toBe(b[0]);
    expect(Array.from((a[0] as Float32Array).subarray(0, 4))).toEqual(
      Array.from((b[0] as Float32Array).subarray(0, 4)),
    );
  });

  it('decodes long takes a few at a time and short clips together, by how long the song says they are', async () => {
    served();
    // nine four-minute stereo takes: two at a time
    const long = new AudioFiles();
    long.know(each(9).map((id) => file(id, 240)));
    const a = decoder();
    await Promise.all(each(9).map((id) => long.load('prj_a', { file: id, stretch: 1 }, a.ctx)));
    expect(a.state.calls).toBe(9);
    expect(a.state.most).toBe(2);
    // nine ten-second clips: all at once
    const short = new AudioFiles();
    short.know(each(9).map((id) => file(id, 10)));
    const b = decoder();
    await Promise.all(each(9).map((id) => short.load('prj_a', { file: id, stretch: 1 }, b.ctx)));
    expect(b.state.most).toBe(9);
    // files whose length isn't known: one at a time
    const unknown = new AudioFiles();
    const c = decoder();
    await Promise.all(each(4).map((id) => unknown.load('prj_a', { file: id, stretch: 1 }, c.ctx)));
    expect(c.state.most).toBe(1);
  });

  it('copies straight into shared memory when every engine reads the one copy', async () => {
    served();
    const files = new AudioFiles();
    const { ctx } = decoder();
    const shared = await files.load('prj_a', { file: 'aud_one', stretch: 1 }, ctx, true);
    const own = await files.load('prj_a', { file: 'aud_one', stretch: 1 }, ctx);
    expect(shared[0]?.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(own[0]?.buffer).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(shared[1] as Float32Array)).toEqual(Array.from(own[1] as Float32Array));
  });

  it('says so when a file is missing, and tries again when asked again', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    const files = new AudioFiles();
    const { state, ctx } = decoder();
    await expect(files.load('prj_a', { file: 'aud_gone', stretch: 1 }, ctx)).rejects.toThrow(
      'Missing audio file aud_gone',
    );
    served();
    await files.load('prj_a', { file: 'aud_gone', stretch: 1 }, ctx);
    expect(state.calls).toBe(1);
  });
});
