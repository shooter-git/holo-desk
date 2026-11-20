/**
 * What a Prism voice costs: each kind of source on its own (an oscillator bank of growing size, a
 * partial set, a sample, grains), each preset's voice, and each preset's effects, timed after the
 * code has warmed up, as a share of one core in real time.
 *
 *   node packages/engine/bench/prism.ts            everything, 4 seconds each at 48 kHz
 *   node packages/engine/bench/prism.ts --seconds 8 --only "Drift Pad"
 *
 * "voice" is what one more note adds (four notes less one, over three); "effects" is the rest of one
 * note: the effects and the per-block work every instrument does. A preset that plays one note at a
 * time is timed whole.
 */
import { PRISM_PRESETS, PrismSynth, prismPatch } from '../src/prism.ts';

const SR = 48000;
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const seconds = Number(opt('seconds') ?? 4);
const only = opt('only');
const host = { beatSeconds: () => 0.5, beatAt: () => 0, playing: () => false };

/** Seconds of rendering `notes` notes, as a share (%) of real time. */
function time(preset: string, params: Record<string, number>, notes: number): number {
  const s = new PrismSynth(SR, preset, params, host);
  const l = new Float32Array(128);
  const r = new Float32Array(128);
  for (let k = 0; k < notes; k++) s.noteOn(48 + k * 5, 100);
  const n = SR * seconds;
  const t0 = performance.now();
  for (let i = 0; i < n; i += 128) {
    l.fill(0);
    r.fill(0);
    s.render(l, r, 0, 128);
  }
  return ((performance.now() - t0) / (seconds * 1000)) * 100;
}

function measure(preset: string, params: Record<string, number>): { voice: number; rest: number } {
  for (let w = 0; w < 3; w++) time(preset, params, 4);
  const one = time(preset, params, 1);
  const four = time(preset, params, 4);
  const voice = Math.max(0, (four - one) / 3);
  return { voice, rest: Math.max(0, one - voice) };
}

// one source alone: no filter, no effects, a held envelope
const alone = (more: Record<string, number>) => ({ 'patch:blank': 1, 'mod1:src': 0, 'env1:r': 0.1, ...more });
const kinds: [string, Record<string, number>][] = [
  ['1 saw', alone({ 's1:wave': 2 })],
  ['7 saws, stereo', alone({ 's1:wave': 2, 's1:count': 7, 's1:pitcha': 1, 's1:stereo': 1, 's1:pana': 1 })],
  ['16 sines', alone({ 's1:wave': 0, 's1:count': 16, 's1:pitcha': 2 })],
  ['64 sines', alone({ 's1:wave': 0, 's1:count': 64, 's1:pitcha': 2 })],
  ['24 partials', alone({ 's1:kind': 1, 's1:data': 5, 's1:partials': 24, 's1:speed': 1, 's1:loop': 1 })],
  [
    '24 partials, stereo',
    alone({ 's1:kind': 1, 's1:data': 5, 's1:partials': 24, 's1:loop': 1, 's1:stereo': 1, 's1:pana': 3 }),
  ],
  ['sample', alone({ 's1:kind': 2, 's1:data': 1, 's1:loop': 4 })],
  ['grains (8)', alone({ 's1:kind': 3, 's1:data': 2, 's1:density': 8, 's1:loop': 4, 's1:stereo': 1, 's1:spray': 1 })],
  ['ladder 24', alone({ 's1:wave': 2, 'f1:on': 1, 'f1:type': 6, 'f1:cutoff': 800 })],
];

console.log(`Prism at ${SR} Hz, ${seconds} s each (% of one core)`);
if (!only)
  for (const [name, params] of kinds) {
    const { voice } = measure('Pulse Bells', params);
    console.log(`  ${name.padEnd(22)} ${voice.toFixed(2).padStart(6)}% a voice`);
  }
for (const preset of PRISM_PRESETS) {
  if (only && only !== preset) continue;
  if (prismPatch(preset).voice.mono) {
    // one note at a time: its voice and its effects together
    for (let w = 0; w < 3; w++) time(preset, {}, 1);
    console.log(`  ${preset.padEnd(22)} ${time(preset, {}, 1).toFixed(2).padStart(6)}% its one voice and effects`);
    continue;
  }
  const { voice, rest } = measure(preset, {});
  console.log(`  ${preset.padEnd(22)} ${voice.toFixed(2).padStart(6)}% a voice, ${rest.toFixed(2)}% effects`);
}
