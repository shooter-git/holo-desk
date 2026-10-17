import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  type AheadLink,
  compileGraph,
  compileTempo,
  compileTrack,
  EngineCore,
  generateSpace,
  meterTicks,
  prepareImpulse,
  songImpulses,
  type ToWorklet,
} from '@holo/engine';
import { decodeMessage, encodeMessage, type FromCompanion } from '@holo/engine/companion';
import { newBus, newPlugin, newProject, newRegion, newTrack, PPQ } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { AheadRelay } from '../src/ahead.ts';
import type { Native, NativePort, OpenedDevice } from '../src/native.ts';
import { nativeName } from '../src/native.ts';
import { Renderer } from '../src/renderer.ts';
import { originAllowed, run, type Threads } from '../src/server.ts';

/** The companion's threads, from its sources. */
const threads: Threads = {
  render: (workerData, transferList) =>
    new Worker(new URL('../src/render.ts', import.meta.url), { workerData, transferList }),
  ahead: () => new Worker(new URL('../src/ahead-thread.ts', import.meta.url)),
};

/** A sound device and MIDI in memory: the test says what the device wants and what's played. */
class FakeNative implements Native {
  device: OpenedDevice = {
    rate: 48000,
    period: 144,
    buffer: 144,
    exclusive: true,
    backend: 'WASAPI',
    name: 'Speakers',
    bluetooth: false,
  };
  refuseExclusive = false;
  want = 0;
  written: Float32Array[] = [];
  midi: [number, number, number][] = [];
  ports: NativePort[] = [{ slot: 0, name: 'USB MIDI Interface', open: true }];
  clock = 0;
  underruns = 0;
  cushion = 0;
  marks: [number, number][] = [];
  lost = 0;
  defaultChanged = 0;
  time = 1e6;
  opened: { exclusive: boolean }[] = [];
  audioOpen(o: { exclusive: boolean }): OpenedDevice {
    this.opened.push(o);
    if (o.exclusive && this.refuseExclusive) throw new Error('Device in use');
    return { ...this.device, exclusive: o.exclusive };
  }
  audioClose(): void {}
  renderWait(): number {
    const w = this.want;
    this.want = 0;
    return w;
  }
  renderWrite(left: Float32Array): boolean {
    this.written.push(left.slice());
    return true;
  }
  audioStatus(out: Float64Array): void {
    out.set([0, this.underruns, this.clock, 1, this.lost, this.time, 0, 0, this.defaultChanged]);
  }
  setCushion(frames: number): void {
    this.cushion = frames;
  }
  noteMark(frame: number, t: number): void {
    this.marks.push([frame, t]);
  }
  noteLatencies(): number {
    return 0;
  }
  inputs = 0;
  inputOpen(): void {
    this.inputs++;
  }
  inputClose(): void {
    this.inputs--;
  }
  inputRead(left: Float32Array, right: Float32Array): boolean {
    left.fill(0.5);
    right.fill(0.5);
    return true;
  }
  measureStart(): void {}
  measureStop() {
    return { times: [3.1, 2.9, 3.0], input: 3 };
  }
  boost(): string {
    return 'test';
  }
  now(): number {
    return this.time;
  }
  midiOpen(): void {}
  midiClose(): void {}
  midiScan(): NativePort[] {
    return this.ports;
  }
  midiRead(out: Float64Array): number {
    const n = this.midi.length;
    this.midi.forEach(([slot, word, t], i) => {
      out.set([slot, word, t], i * 3);
    });
    this.midi = [];
    return n;
  }
}

/** A studio's first messages: the song (one synth track, armed) and where live MIDI goes. */
function studio(r: Renderer, rate: number, routes = true): number {
  const p = newProject('Test');
  const segments = compileTempo(p, rate);
  const num = 1;
  r.receive({ type: 'init', ring: null, meters: null, transport: null });
  r.receive({ type: 'tempo', segments, ppq: 960, ...meterTicks(p) });
  r.receive({ type: 'graph', graph: compileGraph(p, (id) => (id === p.tracks[0]?.id ? num : 2), segments) });
  if (routes)
    r.receive({ type: 'routes', routes: { armed: [{ num, port: 'USB MIDI Interface', channel: 0 }], selected: null } });
  return num;
}

function loud(blocks: Float32Array[]): number {
  return Math.max(0, ...blocks.map((b) => Math.max(...b.map(Math.abs))));
}

function same(a: Float32Array, b: Float32Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

/** Until something is so (the threads go at their own pace). */
async function until(what: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((done) => setTimeout(done, 1));
  }
}

/**
 * Two tracks into a room (a hall) and the master, with nothing on it, every part sounding from the
 * first beat: the studio's messages for it, then its start.
 */
function song(rate: number): { messages: ToWorklet[]; lead: number; tracks: number[] } {
  const p = newProject('Ahead');
  const room = newBus('Room');
  room.channel.inserts = [newPlugin('space', { space: 0, decay: 0.5, dry: -60, wet: -6 })];
  p.buses = [room];
  p.master.inserts = [];
  const bar = PPQ * 4;
  const lead = newTrack('Lead', { type: 'synth', preset: 'Soft Keys' });
  lead.regions = [{ ...newRegion(0, bar * 4), notes: [0, 1, 2, 3].map((b) => ({ t: b * bar, d: bar, p: 64, v: 90 })) }];
  lead.channel.sends = [{ bus: room.id, level: -10, pre: false }];
  const pad = newTrack('Pad', { type: 'synth', preset: 'Warm Pad' });
  pad.regions = [{ ...newRegion(0, bar * 4), notes: [{ t: 0, d: bar * 4, p: 52, v: 80 }] }];
  p.tracks = [lead, pad];
  const nums = new Map<string, number>();
  const numOf = (id: string) => {
    if (!nums.has(id)) nums.set(id, nums.size + 1);
    return nums.get(id) as number;
  };
  const segments = compileTempo(p, rate);
  const messages: ToWorklet[] = [{ type: 'tempo', segments, ppq: PPQ, ...meterTicks(p) }];
  for (const { key, source } of songImpulses(p, rate))
    if (source.kind === 'space')
      messages.push({
        type: 'impulse',
        key,
        data: prepareImpulse(generateSpace(source.name, source.seed, source.decay, rate)),
      });
  messages.push({ type: 'graph', graph: compileGraph(p, numOf, segments) });
  for (const t of p.tracks) messages.push({ type: 'sequence', num: numOf(t.id), events: compileTrack(t, segments) });
  messages.push({ type: 'play', frame: 0, record: false, countIn: 0 });
  return { messages, lead: numOf(lead.id), tracks: p.tracks.map((t) => numOf(t.id)) };
}

/** One engine playing it all: what a bounce plays, block by block. */
function oneEngine(messages: ToWorklet[], blocks: number): Float32Array[] {
  const core = new EngineCore(48000, (m) => {
    if (m.type === 'error') throw new Error(m.message);
  });
  core.receive({ type: 'init', ring: null, meters: null, transport: null });
  for (const m of messages) core.receive(structuredClone(m));
  return Array.from({ length: blocks }, (_, k) => {
    const l = new Float32Array(128);
    core.process(l, new Float32Array(128), undefined, k * 128);
    return l;
  });
}

describe('the companion’s renderer', () => {
  it('shares Bluetooth headphones and says why', () => {
    const fake = new FakeNative();
    fake.device = { ...fake.device, name: 'Headphones (Bluetooth)', bluetooth: true };
    const posts: FromCompanion[] = [];
    new Renderer(fake, (m) => posts.push(m)).receive({ type: 'open', exclusive: true });
    expect(posts.find((m) => m.type === 'device')).toMatchObject({
      device: { note: expect.stringMatching(/Bluetooth/) },
    });
  });

  it('opens the device in exclusive mode, and shares it when exclusive mode isn’t possible', () => {
    const fake = new FakeNative();
    const posts: FromCompanion[] = [];
    new Renderer(fake, (m) => posts.push(m)).receive({ type: 'open', exclusive: true });
    expect(posts.find((m) => m.type === 'device')).toMatchObject({ device: { mode: 'exclusive', rate: 48000 } });

    const busy = new FakeNative();
    busy.refuseExclusive = true;
    const posts2: FromCompanion[] = [];
    new Renderer(busy, (m) => posts2.push(m)).receive({ type: 'open', exclusive: true });
    const d = posts2.find((m) => m.type === 'device');
    expect(d).toMatchObject({ device: { mode: 'shared' } });
    expect(d?.type === 'device' && d.device.note).toMatch(/Device in use/);
    // exclusive mode is tried for a second (a browser letting go of the device takes a moment), then shared
    expect(busy.opened.map((o) => o.exclusive)).toEqual([true, true, true, true, true, false]);
  });

  it('renders what the device asks for in 128-frame blocks, and plays USB MIDI on the routed track', () => {
    const fake = new FakeNative();
    const posts: FromCompanion[] = [];
    const r = new Renderer(fake, (m) => posts.push(m));
    r.receive({ type: 'open', exclusive: true });
    studio(r, 48000);
    fake.want = 144;
    r.tick(0);
    expect(fake.written).toHaveLength(2);
    expect(loud(fake.written)).toBe(0);
    expect(posts.find((m) => m.type === 'midiPorts')).toMatchObject({ ports: [{ name: 'USB MIDI Interface' }] });
    // a note on channel 1 arrives: it's in the very next block
    fake.midi.push([0, 0x90 | (60 << 8) | (100 << 16), fake.time]);
    fake.want = 128 * 4;
    r.tick(0);
    expect(loud(fake.written.slice(2))).toBeGreaterThan(0.01);
    expect(fake.marks).toEqual([[256, fake.time]]);
    // and goes back to the studio, already played, with the frame being heard then
    const played = posts.find((m) => m.type === 'midi');
    expect(played).toMatchObject({ events: [0, 0x90, 60, 100, expect.any(Number)] });
  });

  it('places a note at the frame being heard when it was played', () => {
    const fake = new FakeNative();
    const posts: FromCompanion[] = [];
    const r = new Renderer(fake, (m) => posts.push(m));
    r.receive({ type: 'open', exclusive: true });
    studio(r, 48000);
    // the device takes frame clock + t·rate at t µs, and plays it a buffer later
    fake.clock = 10_000 - 48000 * 2; // at 2 s it takes frame 10000
    fake.midi.push([0, 0x90 | (64 << 8) | (90 << 16), 2e6 + 1000]); // played 1 ms after that
    fake.want = 128;
    r.tick(0);
    const played = posts.find((m) => m.type === 'midi');
    expect(played?.type === 'midi' && played.events[4]).toBe(10_000 + 48 - 144);
  });

  it('leaves MIDI from devices no track listens to unplayed, but still tells the studio', () => {
    const fake = new FakeNative();
    const posts: FromCompanion[] = [];
    const r = new Renderer(fake, (m) => posts.push(m));
    r.receive({ type: 'open', exclusive: true });
    studio(r, 48000, false);
    r.tick(0); // the devices are known
    fake.midi.push([0, 0x90 | (60 << 8) | (100 << 16), fake.time]);
    fake.want = 128 * 4;
    r.tick(0);
    expect(loud(fake.written)).toBe(0);
    expect(fake.marks).toEqual([]);
    expect(posts.some((m) => m.type === 'midi')).toBe(true);
  });

  it('keeps a period in hand, more after running short while playing, and comes back down when calm', () => {
    const fake = new FakeNative();
    const r = new Renderer(fake, () => undefined);
    r.receive({ type: 'open', exclusive: true });
    expect(fake.cushion).toBe(144);
    const step = (us: number) => {
      fake.time += us;
      r.tick(0);
    };
    step(2e6);
    fake.underruns = 3;
    step(6e5);
    expect(fake.cushion).toBe(144 + 128);
    fake.underruns = 4;
    step(6e5);
    expect(fake.cushion).toBe(144 + 256);
    for (let i = 0; i < 60; i++) step(6e5);
    expect(fake.cushion).toBe(144 + 128);
    // never below the one period
    for (let i = 0; i < 200; i++) step(6e5);
    expect(fake.cushion).toBe(144);
  });

  it('doesn’t count running short while a song is being handed over', () => {
    const fake = new FakeNative();
    const r = new Renderer(fake, () => undefined);
    r.receive({ type: 'open', exclusive: true });
    fake.time += 2e6;
    r.tick(0);
    // a big message: the clock moves on while it's taken in
    const t = performance.now;
    let fakeNow = 0;
    performance.now = () => (fakeNow += 5);
    try {
      r.receive({ type: 'metronome', on: true, level: 0.5 });
    } finally {
      performance.now = t;
    }
    fake.underruns = 5;
    fake.time += 6e5;
    r.tick(0);
    expect(fake.cushion).toBe(144);
  });

  it('opens the input while an audio track records or monitors, and lets it go after', () => {
    const fake = new FakeNative();
    const r = new Renderer(fake, () => undefined);
    r.receive({ type: 'open', exclusive: true });
    r.receive({ type: 'inputs', tracks: [{ num: 3, input: 0, channels: 1, monitor: true, record: false }] });
    expect(fake.inputs).toBe(1);
    r.receive({ type: 'inputs', tracks: [{ num: 3, input: 0, channels: 1, monitor: true, record: true }] });
    expect(fake.inputs).toBe(1);
    r.receive({ type: 'inputs', tracks: [] });
    expect(fake.inputs).toBe(0);
  });

  it('opens the device again when the system’s default output changes (or the device goes)', () => {
    const fake = new FakeNative();
    const posts: FromCompanion[] = [];
    const r = new Renderer(fake, (m) => posts.push(m));
    r.receive({ type: 'open', exclusive: true });
    expect(fake.opened).toHaveLength(1);
    fake.device = { ...fake.device, name: 'Speakers', rate: 48000 };
    fake.defaultChanged = 1;
    fake.time += 2e6;
    r.tick(0);
    expect(fake.opened).toHaveLength(2);
    expect(posts.filter((m) => m.type === 'device').at(-1)).toMatchObject({ device: { name: 'Speakers' } });
  });

  it('measures the round trip natively', () => {
    const fake = new FakeNative();
    const posts: FromCompanion[] = [];
    const r = new Renderer(fake, (m) => posts.push(m));
    r.receive({ type: 'open', exclusive: true });
    r.receive({ type: 'measure', seconds: 2 });
    fake.time += 3e6;
    r.tick(0);
    expect(posts.find((m) => m.type === 'measured')).toMatchObject({ roundTrip: 3, heard: 3, input: null });
  });
});

describe('the companion rendering ahead', () => {
  it('plays the song on threads of its own, laid out by itself: one engine’s numbers, and live notes in the very next block', async () => {
    const fake = new FakeNative();
    const posts: FromCompanion[] = [];
    const r = new Renderer(fake, (m) => posts.push(m));
    const errors: string[] = [];
    const relay = new AheadRelay(
      2,
      threads.ahead,
      (m) => r.receive(m),
      (e) => errors.push(e),
    );
    try {
      relay.receive({ type: 'open', exclusive: true });
      relay.rate = 48000; // (the server has it from the device the render thread opened)
      relay.receive({ type: 'init', ring: null, meters: null, transport: null });
      const link = relay.current?.pool.link as AheadLink;
      expect(link).toBeTruthy();
      const { messages, lead, tracks } = song(48000);
      for (const m of messages) relay.receive(m);
      // block by block, each once the threads have played it and the next few (a song starting waits
      // for those): as a device with time in hand finds them
      const tick = async () => {
        await until(() => link.ready(link.consumed() + 12, 2));
        fake.want = 128;
        r.tick(0);
      };
      for (let b = 0; b < 300; b++) await tick();
      // the song starts once the threads have it (silence until then), and is one engine's numbers
      const start = fake.written.findIndex((b) => loud([b]) > 0);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start).toBeLessThan(100);
      const played = fake.written.length - start;
      const reference = oneEngine(messages, played + 1);
      expect(loud([reference[0] as Float32Array])).toBeGreaterThan(0);
      const differ = fake.written.slice(start).filter((b, i) => !same(b, reference[i] as Float32Array)).length;
      expect(differ).toBe(0);
      // a note played live goes straight to the render thread: it's in the very next block
      relay.receive({ type: 'live', events: [0x90, 76, 110, lead] });
      await tick();
      const next = fake.written.at(-1) as Float32Array;
      const ref = reference[played] as Float32Array;
      expect(Math.max(...next.map((x, i) => Math.abs(x - (ref[i] as number))))).toBeGreaterThan(0.001);
      // and the song goes on, the threads and the render thread agreeing on every message before every block
      for (let b = 0; b < 100; b++) await tick();
      expect(link.stalls()).toBe(0);
      // every track was played (and timed) on a thread, laid out by the companion itself
      for (const num of tracks) expect(link.cost(num)).toBeGreaterThan(0);
      fake.time += 1e6;
      await tick();
      const stats = posts.filter((m) => m.type === 'stats').at(-1);
      expect(stats?.type === 'stats' && stats.stats.ahead?.loads).toHaveLength(2);
      expect(errors).toEqual([]);
      expect(posts.filter((m) => m.type === 'error')).toEqual([]);
    } finally {
      await relay.close();
    }
  }, 60_000);
});

describe('who may use the companion', () => {
  it('a studio from this computer, the local network or a tailnet, and origins named', () => {
    expect(originAllowed('https://box.your-tailnet.ts.net:47801')).toBe(true);
    expect(originAllowed('http://localhost:47800')).toBe(true);
    expect(originAllowed('https://192.168.1.20:47843')).toBe(true);
    expect(originAllowed('https://evil.example')).toBe(false);
    expect(originAllowed('https://studio.example', ['https://studio.example'])).toBe(true);
    expect(originAllowed(undefined)).toBe(true);
  });
});

const addon = fileURLToPath(new URL(`../native/build/${nativeName()}`, import.meta.url));

describe.skipIf(!existsSync(addon))('HO[LO] Engine end to end (the native piece, a null sound device)', () => {
  it('takes a studio, opens the device, plays live notes and sends the meters back', async () => {
    const lines: string[] = [];
    const app = await run(
      { port: 0, shared: false, nullAudio: true, origins: [], threads: 2 },
      addon,
      threads,
      (line) => lines.push(line),
    );
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${app.port}`);
      ws.binaryType = 'arraybuffer';
      const got: FromCompanion[] = [];
      const waitFor = (pred: (m: FromCompanion) => boolean, ms = 20_000) =>
        new Promise<FromCompanion>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`timed out; got ${got.map((m) => m.type).join(' ')}`)), ms);
          const check = () => {
            const m = got.find(pred);
            if (m) {
              clearTimeout(timer);
              resolve(m);
            } else setTimeout(check, 20);
          };
          check();
        });
      ws.onmessage = (e) => got.push(decodeMessage(e.data as ArrayBuffer) as FromCompanion);
      await waitFor((m) => m.type === 'hello');
      ws.send(encodeMessage({ type: 'open', exclusive: true }));
      const device = await waitFor((m) => m.type === 'device');
      expect(device).toMatchObject({ device: { backend: 'Null', mode: 'shared' } });
      const rate = device.type === 'device' ? device.device.rate : 48000;
      const p = newProject('E2E');
      const segments = compileTempo(p, rate);
      const send = (m: unknown) => ws.send(encodeMessage(m));
      send({ type: 'init', ring: null, meters: null, transport: null });
      send({ type: 'tempo', segments, ppq: 960, ...meterTicks(p) });
      send({ type: 'graph', graph: compileGraph(p, (id) => (id === p.tracks[0]?.id ? 1 : 2), segments) });
      // (rendered ahead, the song is taken in a little later: the track is there once this comes back)
      send({ type: 'ping', id: 1 });
      await waitFor((m) => m.type === 'pong');
      send({ type: 'live', events: [0x90, 60, 110, 1] });
      const heard = await waitFor((m) => m.type === 'state' && (m.meters[4] ?? 0) > 0.01);
      expect(heard.type === 'state' && heard.meters.length).toBeLessThan(64);
      // the song renders ahead on two more threads: the studio's DSP meter hears from them too
      const stats = await waitFor((m) => m.type === 'stats' && m.stats.ahead !== undefined);
      expect(stats.type === 'stats' && stats.stats.ahead?.loads).toHaveLength(2);
      ws.close();
    } finally {
      await app.close();
    }
    expect(lines.join('\n')).toMatch(/Studio connected/);
    expect(lines.join('\n')).toMatch(/render ahead on 2 more threads/);
  }, 60_000);
});
