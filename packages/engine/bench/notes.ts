/**
 * How fast a line's note edits render (notes/psola.ts): the time to render a region's patches, per
 * second of the patches' audio (what's rendered: each edited note, the glides either side and 30 ms
 * past them) and per second of the notes edited. The studio renders a patch as an edit lands; the
 * aim is 60 ms or less per second at 48 kHz stereo.
 *
 *   node packages/engine/bench/notes.ts                  a made-up voice, 30 s, at 48 kHz stereo
 *   node packages/engine/bench/notes.ts --seconds 60 --rate 44100 --runs 9
 *   node packages/engine/bench/notes.ts --file take.wav  a recording (its notes found, every other one
 *                                                        moved a semitone up, every fourth 3 dB down)
 *
 * The made-up voice sings phrases of legato notes with a vibrato and rests between them (a pulse train
 * through three formants, the right side a little different from the left), and every other note is
 * moved: up or down a few semitones, some made louder or softer. Each run renders every patch; the
 * median run is reported.
 */
import { readFileSync } from 'node:fs';
import { type AudioClip, type AudioNote, type AudioNotes, parseAudioNotes } from '@holo/session';
import { lineNotes, monoOf } from '../src/analysis/take.ts';
import { renderNotePatch } from '../src/notes/patch.ts';
import { isEdited, regionPatches } from '../src/notes/plan.ts';
import { decodeWav } from '../src/wav.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const file = arg('file');
const runs = Number(arg('runs') ?? 5);

/** A made-up voice, `seconds` long at `sr`: its two channels, and the notes it sings. */
function madeUp(seconds: number, sr: number): { channels: Float32Array[]; notes: AudioNote[] } {
  const n = Math.round(seconds * sr);
  const f0 = new Float64Array(n);
  const env = new Float64Array(n);
  const notes: AudioNote[] = [];
  const tune = [57, 59, 60, 62, 64, 62, 60, 59, 57, 55, 57, 60];
  let t = 0.3;
  let k = 0;
  while (t < seconds - 2) {
    // a phrase of four notes, legato, then a rest
    const start = t;
    for (let q = 0; q < 4; q++) {
      const d = 0.35 + 0.1 * ((k * 7) % 5);
      notes.push({ t: Math.round(t * 1e4) / 1e4, d: Math.round(d * 1e4) / 1e4, p: tune[k % tune.length] as number });
      t += d;
      k++;
    }
    const end = t;
    for (let i = Math.round(start * sr); i < Math.min(n, Math.round(end * sr)); i++) {
      const s = i / sr;
      const note = notes.findLast((x) => x.t <= s) as AudioNote;
      const m = (note.p as number) + 0.3 * Math.sin(2 * Math.PI * 5.5 * (s - start));
      f0[i] = 440 * 2 ** ((m - 69) / 12);
      env[i] = Math.min(1, (s - start) / 0.03, (end - s) / 0.03);
    }
    t += 0.4;
  }
  const pulses = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = f0[i] as number;
    if (f <= 0) continue;
    phase += f / sr;
    const top = Math.floor(8000 / f);
    let v = 0;
    for (let h = 1; h <= top; h++) v += Math.cos(2 * Math.PI * h * phase);
    pulses[i] = (v / top) * (env[i] as number);
  }
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (const [hz, q, g] of [
    [700, 6, 1],
    [1220, 8, 0.5],
    [2600, 10, 0.25],
  ] as const) {
    const w = (2 * Math.PI * hz) / sr;
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
      left[i] = (left[i] as number) + 0.5 * g * y;
      right[i] = (right[i] as number) + 0.4 * g * y * (hz > 1000 ? 1.2 : 1);
    }
  }
  return { channels: [left, right], notes };
}

let sr: number;
let channels: Float32Array[];
let found: AudioNote[];
let moves: (n: AudioNote, i: number) => AudioNote;
if (file) {
  const decoded = decodeWav(new Uint8Array(readFileSync(file)));
  sr = decoded.rate;
  channels = decoded.channels.slice(0, 2);
  found = lineNotes(monoOf(channels), sr).map((n) => ({ t: n.start, d: n.end - n.start, p: n.pitch }));
  moves = (n, i) => (i % 2 ? n : { ...n, to: (n.p as number) + 1, ...(i % 4 === 0 ? { g: -3 } : {}) });
} else {
  sr = Number(arg('rate') ?? 48000);
  const made = madeUp(Number(arg('seconds') ?? 30), sr);
  channels = made.channels;
  found = made.notes;
  const steps = [2, -3, 5, -1];
  moves = (n, i) =>
    i % 2 ? n : { ...n, to: (n.p as number) + (steps[(i / 2) % 4] as number), ...(i % 6 === 0 ? { g: 4 } : {}) };
}
const notes = parseAudioNotes({ mode: 'mono', v: 1, n: found.map(moves) }) as AudioNotes;
const clip: AudioClip = { file: 'bench', offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1, notes };
const jobs = regionPatches(clip, sr);
const patchSeconds = jobs.reduce((s, j) => s + (j.spec.b - j.spec.a), 0) / sr;
const noteSeconds = notes.n.filter(isEdited).reduce((s, n) => s + n.d, 0);

const times: number[] = [];
for (let r = 0; r < runs; r++) {
  const t0 = performance.now();
  for (const job of jobs) renderNotePatch(channels, sr, job.spec);
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
const median = times[times.length >> 1] as number;
const seconds = (channels[0]?.length ?? 0) / sr;
console.log(
  `${file ?? 'made-up voice'}: ${seconds.toFixed(1)} s at ${sr} Hz, ${channels.length} channel(s); ` +
    `${notes.n.filter(isEdited).length} of ${notes.n.length} notes edited (${noteSeconds.toFixed(1)} s), ` +
    `${jobs.length} patches (${patchSeconds.toFixed(1)} s)`,
);
console.log(
  `render: ${median.toFixed(0)} ms (median of ${runs}); ` +
    `${((median / patchSeconds) | 0).toString()} ms per second of patch audio, ` +
    `${((median / noteSeconds) | 0).toString()} ms per second of notes edited`,
);
