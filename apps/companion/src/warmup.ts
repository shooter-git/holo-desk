/**
 * The engine played once through before anyone listens: JavaScript runs a piece of code slowly the
 * first few times (until it has compiled it), and the first note of an instrument could then take
 * longer than a whole period of a low-latency device. So at start the companion plays a throwaway
 * song with every instrument kind and every plugin, a few seconds' worth as fast as it can, and lets
 * it go. What it plays for the studio is untouched: that's a fresh engine.
 */
import { compileGraph, compileTempo, EngineCore, meterTicks, type SamplerSpec } from '@holo/engine';
import { newBus, newPlugin, newProject, newTrack, PLUGINS, SYNTH_PRESETS, type Track } from '@holo/session';

const RATE = 48000;
const BLOCK = 128;

export function warmUp(blocks = 2000): number {
  const t0 = performance.now();
  const p = newProject('Warm-up');
  // (the drum kit is a synth preset)
  const synths = SYNTH_PRESETS.map((preset) => newTrack(preset, { type: 'synth', preset }));
  const sampler = newTrack('Sampler', { type: 'sampler', pack: 'warmup', name: 'sine' });
  const tracks: Track[] = [...synths, sampler];
  const midi = PLUGINS.filter((d) => d.kind === 'midi');
  const audio = PLUGINS.filter((d) => d.kind === 'audio' && d.type !== 'space');
  // every MIDI effect on a track of its own, every audio effect on one bus the tracks all send to
  midi.forEach((d, i) => {
    tracks[i % tracks.length]?.midiFx.push(newPlugin(d.type));
  });
  const bus = newBus('Everything');
  bus.channel.inserts = audio.map((d) => newPlugin(d.type));
  for (const t of tracks) t.channel.sends.push({ bus: bus.id, level: -6, pre: false });
  p.tracks = tracks;
  p.buses = [...p.buses, bus];

  const nums = new Map<string, number>();
  const numOf = (id: string) => {
    let n = nums.get(id);
    if (n === undefined) {
      n = nums.size + 1;
      nums.set(id, n);
    }
    return n;
  };
  const core = new EngineCore(RATE, () => undefined);
  const segments = compileTempo(p, RATE);
  core.receive({ type: 'init', ring: null, meters: null, transport: null });
  core.receive({ type: 'tempo', segments, ppq: 960, ...meterTicks(p) });
  core.receive({ type: 'sampler', spec: sineSampler('warmup/sine') });
  core.receive({ type: 'graph', graph: compileGraph(p, numOf, segments) });
  core.receive({ type: 'metronome', on: true, level: 0.5 });
  core.receive({ type: 'play', frame: 0, record: false, countIn: 0 });

  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  const all = tracks.map((t) => numOf(t.id));
  for (let b = 0; b < blocks; b++) {
    const live: number[] = [];
    const step = b % 40;
    const pitch = 36 + ((b / 40) % 36);
    for (const num of all) {
      if (step === 0) live.push(0x90, pitch, 100, num, 0x90, pitch + 4, 80, num, 0xb0, 1, (b >> 3) & 127, num);
      if (step === 10) live.push(0xe0, 0, 80, num, 0xd0, 60, 0, num, 0xb0, 64, 127, num);
      if (step === 30) live.push(0x80, pitch, 0, num, 0x80, pitch + 4, 0, num, 0xb0, 64, 0, num, 0xe0, 0, 64, num);
    }
    if (live.length) core.receive({ type: 'live', events: live });
    core.process(left, right, undefined, b * BLOCK);
  }
  core.receive({ type: 'stop' });
  return performance.now() - t0;
}

function sineSampler(key: string): SamplerSpec {
  const n = RATE / 4;
  const left = new Float32Array(n);
  for (let i = 0; i < n; i++) left[i] = Math.sin((2 * Math.PI * 440 * i) / RATE) * 0.3;
  return {
    key,
    zones: [
      { left, right: null, root: 69, lo: 0, hi: 127, lovel: 0, hivel: 127, gain: 1, loopStart: 0, loopEnd: 0, rr: 0 },
    ],
    release: 0.2,
    oneShot: false,
    pitched: true,
    velocityRange: 30,
    attack: 0.002,
  };
}
