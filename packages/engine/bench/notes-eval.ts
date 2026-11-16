/**
 * How well notes are found in real singing: the notes found to edit a recording (notes/detect.ts
 * `detectNotes`) and a take's measured notes (analysis/take.ts `lineNotes`, the baseline), against
 * the Choral Singing Dataset's hand-corrected pitch and note labels (Cuesta et al., 2018: 48 solo
 * voices, four to a section, of three pieces). It's CC BY-NC 4.0, so it's never kept in the
 * repository: download it and give its folder.
 *
 *   node packages/engine/bench/notes-eval.ts <dataset-dir> [names...] [--jobs 8]
 *
 * names: the files to score, by name or the start of one (CSD_ER, CSD_LI_alto_2); all of them when
 * none. --jobs scores that many files at once (each file's timings are only fair with one).
 *
 * - The pitch curve (`noteCurves`, the fine track with its octaves put back) against each `.f0` (time,
 *   Hz, 0 for unvoiced, every 5.8 ms): the share of what's voiced it hears, the share of what it hears
 *   where nothing is, the share within 50 cents, and the median and 90th percentile of its error.
 * - The notes against the section's `_notes.lab` (start s, mean Hz, length s): a labelled note is
 *   found by a note that starts within 100 ms of it with a pitch within 50 cents, the closest starts
 *   paired first, each note found used once. Precision, recall, the onset error's median and 90th
 *   percentile, the pitch error's median. A note found to edit starts on its beat (after its
 *   consonant); its breaths and noises (no pitch) aren't counted.
 * - Each file, then summed: each section, the soprano, alto and tenor files together (what detection
 *   aims at: precision and recall 85% or more, onsets within 30 ms median), and the basses on their
 *   own. The labels are one file per section, not per singer, and they follow its first singer: their
 *   pitches are within a few cents of that singer's, and its voice starts a few ms before each label
 *   from silence, where the other three are off by tens of cents and ms (a quarter of their starts
 *   by more than 100 ms). So the first singers' files are summed on their own too.
 * - How long detection takes, per minute of recording.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { lineNotes } from '../src/analysis/take.ts';
import { detectNotes, noteCurves } from '../src/notes/detect.ts';
import { decodeWav } from '../src/wav.ts';

/** A labelled note found within this (s) and this (cents). */
const ONSET_S = 0.1;
const PITCH_C = 50;

interface Scored {
  found: number;
  labelled: number;
  matched: number;
  onset: number[];
  pitch: number[];
}

interface Result {
  name: string;
  section: string;
  seconds: number;
  detectMs: number;
  lineMs: number;
  track: { truth: number; heard: number; both: number; within: number; error: number[] };
  detect: Scored;
  line: Scored;
}

const hzOf = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const cents = (hz: number, ref: number) => 1200 * Math.log2(hz / ref);
const rows = (text: string) =>
  text
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number));

/** Labelled notes [start, Hz] matched by found notes [start, MIDI]: the closest starts first, each used once. */
function score(found: [number, number][], labels: [number, number][]): Scored {
  const pairs: [number, number, number][] = [];
  labels.forEach(([s, hz], i) => {
    found.forEach(([t, p], j) => {
      const dt = Math.abs(t - s);
      if (dt <= ONSET_S && Math.abs(cents(hzOf(p), hz)) <= PITCH_C) pairs.push([dt, i, j]);
    });
  });
  pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  const usedL = new Set<number>();
  const usedF = new Set<number>();
  const out: Scored = { found: found.length, labelled: labels.length, matched: 0, onset: [], pitch: [] };
  for (const [dt, i, j] of pairs) {
    if (usedL.has(i) || usedF.has(j)) continue;
    usedL.add(i);
    usedF.add(j);
    out.matched++;
    out.onset.push(dt * 1000);
    out.pitch.push(Math.abs(cents(hzOf((found[j] as [number, number])[1]), (labels[i] as [number, number])[1])));
  }
  return out;
}

function scoreFile(dir: string, name: string): Result {
  const [, piece, section] = name.split('_') as [string, string, string];
  const wav = decodeWav(new Uint8Array(readFileSync(join(dir, `${name}.wav`))));
  const mono = wav.channels[0] as Float32Array;
  const t0 = performance.now();
  const notes = detectNotes(wav.channels, wav.rate);
  const t1 = performance.now();
  const line = lineNotes(mono, wav.rate);
  const t2 = performance.now();
  const curves = noteCurves(wav.channels, wav.rate);
  // the pitch curve against the truth, at the truth's times
  const truth = rows(readFileSync(join(dir, `${name}.f0`), 'utf8'));
  const track = { truth: 0, heard: 0, both: 0, within: 0, error: [] as number[] };
  for (const [t, hz] of truth as [number, number][]) {
    const k = Math.round((t - curves.t0) / curves.step);
    const m = k >= 0 && k < curves.midi.length ? (curves.midi[k] as number) : Number.NaN;
    const heard = !Number.isNaN(m);
    if (hz > 0) track.truth++;
    if (heard) track.heard++;
    if (hz > 0 && heard) {
      track.both++;
      const e = Math.abs(cents(hzOf(m), hz));
      track.error.push(e);
      if (e <= PITCH_C) track.within++;
    }
  }
  const labels = rows(readFileSync(join(dir, `CSD_${piece}_${section}_notes.lab`), 'utf8')).map(
    ([s, hz]) => [s, hz] as [number, number],
  );
  return {
    name,
    section,
    seconds: mono.length / wav.rate,
    detectMs: t1 - t0,
    lineMs: t2 - t1,
    track,
    detect: score(
      notes.n.filter((n) => n.p !== null).map((n) => [n.t + (n.u ?? 0), n.p as number]),
      labels,
    ),
    line: score(
      line.map((n) => [n.start, n.pitch]),
      labels,
    ),
  };
}

/** Score the files, `jobs` at a time (one: here, on this thread). */
async function run(dir: string, names: string[], jobs: number): Promise<Result[]> {
  if (jobs <= 1) return names.map((n) => scoreFile(dir, n));
  const results: Result[] = [];
  const queue = [...names];
  await Promise.all(
    Array.from(
      { length: jobs },
      () =>
        new Promise<void>((done, fail) => {
          const w = new Worker(new URL(import.meta.url), { workerData: { dir } });
          const next = () => w.postMessage(queue.shift() ?? null);
          w.on('message', (r: Result) => {
            results.push(r);
            next();
          });
          w.on('error', fail);
          w.on('exit', () => done());
          next();
        }),
    ),
  );
  return results;
}

const quantile = (values: number[], q: number) => {
  if (!values.length) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] as number;
};
const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : '-').padStart(5);
const num = (v: number, places = 0) => (Number.isNaN(v) ? '-' : v.toFixed(places)).padStart(5);

function sum(list: Result[]): Omit<Result, 'name' | 'section'> {
  const scored = (pick: (r: Result) => Scored): Scored => ({
    found: list.reduce((a, r) => a + pick(r).found, 0),
    labelled: list.reduce((a, r) => a + pick(r).labelled, 0),
    matched: list.reduce((a, r) => a + pick(r).matched, 0),
    onset: list.flatMap((r) => pick(r).onset),
    pitch: list.flatMap((r) => pick(r).pitch),
  });
  return {
    seconds: list.reduce((a, r) => a + r.seconds, 0),
    detectMs: list.reduce((a, r) => a + r.detectMs, 0),
    lineMs: list.reduce((a, r) => a + r.lineMs, 0),
    track: {
      truth: list.reduce((a, r) => a + r.track.truth, 0),
      heard: list.reduce((a, r) => a + r.track.heard, 0),
      both: list.reduce((a, r) => a + r.track.both, 0),
      within: list.reduce((a, r) => a + r.track.within, 0),
      error: list.flatMap((r) => r.track.error),
    },
    detect: scored((r) => r.detect),
    line: scored((r) => r.line),
  };
}

function line(label: string, r: Omit<Result, 'name' | 'section'>): string {
  const notes = (s: Scored) =>
    `${pct(s.matched, s.found)} ${pct(s.matched, s.labelled)} ${num(quantile(s.onset, 0.5))} ${num(quantile(s.onset, 0.9))} ${num(quantile(s.pitch, 0.5), 1)}`;
  const t = r.track;
  const perMinute = (r.detectMs / 1000 / r.seconds) * 60;
  return [
    label.padEnd(20),
    num(r.seconds),
    `| ${notes(r.detect)}`,
    `| ${notes(r.line)}`,
    `| ${pct(t.both, t.truth)} ${pct(t.heard - t.both, t.heard)} ${pct(t.within, t.both)} ${num(quantile(t.error, 0.5), 1)} ${num(quantile(t.error, 0.9), 1)}`,
    `| ${num(perMinute, 2)}`,
  ].join(' ');
}

function report(results: Result[]): void {
  const notesHead = 'prec. recall on50 on90 cents';
  console.log(
    [
      ''.padEnd(26),
      `| ${'detectNotes'.padEnd(29)}`,
      `| ${'lineNotes (baseline)'.padEnd(29)}`,
      `| ${'pitch curve vs .f0'.padEnd(29)}`,
      '| detect',
    ].join(' '),
  );
  console.log(
    [
      'file'.padEnd(20),
      's'.padStart(5),
      `| ${notesHead}`,
      `| ${notesHead}`,
      `| voic. extra  ≤50c   med   p90`,
      '| s/min',
    ].join(' '),
  );
  for (const r of results) console.log(line(r.name, r));
  console.log('');
  const groups: [string, (r: Result) => boolean][] = [
    ['soprano', (r) => r.section === 'soprano'],
    ['alto', (r) => r.section === 'alto'],
    ['tenor', (r) => r.section === 'tenor'],
    ['S+A+T', (r) => r.section !== 'bass'],
    ['S+A+T, singer 1', (r) => r.section !== 'bass' && r.name.endsWith('_1')],
    ['bass', (r) => r.section === 'bass'],
    ['all', () => true],
  ];
  for (const [label, keep] of groups) {
    const list = results.filter(keep);
    if (list.length) console.log(line(`${label} (${list.length})`, sum(list)));
  }
  console.log(
    '\nprec./recall %: labelled notes found within 100 ms and 50 cents; on50/on90: onset error median/90th percentile (ms); cents: pitch error median.',
  );
  console.log(
    "voic.: % of the truth's voiced frames heard; extra: % of heard frames the truth calls unvoiced; ≤50c: % within 50 cents; med/p90: cents.",
  );
}

if (!isMainThread) {
  const { dir } = workerData as { dir: string };
  parentPort?.on('message', (name: string | null) => {
    if (name === null) process.exit(0);
    parentPort?.postMessage(scoreFile(dir, name));
  });
} else await main();

/** Score the files the command line names, and report. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jobsAt = args.indexOf('--jobs');
  const jobs = jobsAt >= 0 ? Math.max(1, Number(args[jobsAt + 1]) || 1) : 1;
  const plain = args.filter((_, i) => i !== jobsAt && i !== jobsAt + 1);
  const dir = plain[0];
  if (!dir) {
    console.error('usage: node packages/engine/bench/notes-eval.ts <choral-singing-dataset-dir> [names...] [--jobs N]');
    process.exit(1);
  }
  const wanted = plain.slice(1);
  const names = readdirSync(dir)
    .filter((f) => /^CSD_[A-Z]+_[a-z]+_\d\.wav$/.test(f))
    .map((f) => f.slice(0, -4))
    .filter((n) => !wanted.length || wanted.some((w) => n.startsWith(w)))
    .sort();
  if (!names.length) {
    console.error(`no CSD_<piece>_<section>_<n>.wav files in ${dir}`);
    process.exit(1);
  }
  const results = await run(dir, names, Math.min(jobs, availableParallelism(), names.length));
  report(results.sort((a, b) => (a.name < b.name ? -1 : 1)));
}
