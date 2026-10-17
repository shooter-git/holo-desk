// `node tools/demo-song.mjs`: "Night Window", HO[LO] Desk's own demo song, into the studio (or updated
// there). It's what the README's pictures and the app's icons show. An original written for HO[LO]
// (MIT, as the rest of the repo), played on the built-in synths and the CC0 packs: piano, a warm pad,
// cellos, upright bass, vibes, harp, clarinet and the drum kit, sixteen bars in D minor.
//
//   node tools/demo-song.mjs [--url http://127.0.0.1:47800]
import {
  newBus,
  newPlugin,
  newProject,
  newRegion,
  newTrack,
  PPQ,
  TRACK_COLORS,
} from '../packages/session/src/index.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--url');
const base = (at >= 0 ? args[at + 1] : (process.env.HOLO_URL ?? 'http://127.0.0.1:47800')).replace(/\/$/, '');

const BAR = PPQ * 4;
const ID = 'prj_demo';

/** A note: bar (from 1), beat in it (from 0), length in beats, pitch, velocity. */
const n = (bar, beat, beats, p, v) => ({
  t: Math.round((bar - 1) * BAR + beat * PPQ),
  d: Math.round(beats * PPQ),
  p,
  v,
});

// the chords, a bar each: Dm Bb F C | Dm Bb Gm A | Bb F Gm A | Dm Bb Gm A
const CHORDS = ['Dm', 'Bb', 'F', 'C', 'Dm', 'Bb', 'Gm', 'A', 'Bb', 'F', 'Gm', 'A', 'Dm', 'Bb', 'Gm', 'A'];
const VOICING = {
  Dm: [50, 53, 57, 62],
  Bb: [50, 53, 58, 62],
  F: [48, 53, 57, 60],
  C: [48, 52, 55, 60],
  Gm: [50, 55, 58, 62],
  A: [49, 52, 57, 61],
};
const ROOT = { Dm: 38, Bb: 34, F: 41, C: 36, Gm: 43, A: 33 };
const FIFTH = { Dm: 45, Bb: 41, F: 36, C: 43, Gm: 38, A: 40 };

const song = newProject('Night Window');
song.id = ID;
song.tempo = [{ tick: 0, bpm: 84 }];
song.key = 'D minor';
song.markers = [
  { id: 'mrk_intro', tick: 0, name: 'Intro' },
  { id: 'mrk_theme', tick: 4 * BAR, name: 'Theme' },
  { id: 'mrk_clarinet', tick: 8 * BAR, name: 'Clarinet' },
  { id: 'mrk_return', tick: 12 * BAR, name: 'Return' },
];
song.chords = CHORDS.map((symbol, i) => ({ tick: i * BAR, symbol }));
song.cycle = { on: false, start: 4 * BAR, end: 8 * BAR };

// two rooms: the default reverb and a concert hall
const reverb = song.buses[0];
reverb.name = 'Room';
const hall = newBus('Hall', '#7c8a99');
hall.channel.inserts = [newPlugin('space', { space: 4, seed: 7, wet: -2 })];
song.buses = [reverb, hall];

function track(
  name,
  instrument,
  color,
  notes,
  { volume = 0, pan = 0, room = -144, hallSend = -144, inserts = [] } = {},
) {
  const t = newTrack(name, instrument, color);
  t.regions = [{ ...newRegion(0, 16 * BAR, name), notes }];
  t.channel.volume = volume;
  t.channel.pan = pan;
  t.channel.inserts = inserts;
  t.channel.sends = [
    ...(room > -144 ? [{ bus: reverb.id, level: room, pre: false }] : []),
    ...(hallSend > -144 ? [{ bus: hall.id, level: hallSend, pre: false }] : []),
  ];
  return t;
}

// piano: broken chords to begin with, then chords under the theme (and the theme itself on top)
const piano = [];
CHORDS.forEach((c, i) => {
  const bar = i + 1;
  const [a, b, d, e] = VOICING[c];
  if (bar <= 4 || (bar >= 9 && bar <= 12)) {
    for (const [k, p] of [a, d, e, b, d, e, b, d].entries()) piano.push(n(bar, k / 2, 0.5, p, 58 + ((k * 7) % 22)));
  } else {
    for (const p of [a, b, d]) piano.push(n(bar, 0, 1.9, p, 72), n(bar, 2, 1.9, p, 62));
  }
});
const THEME = [
  [5, 0, 1, 69, 82],
  [5, 1, 1, 74, 88],
  [5, 2, 1.5, 77, 96],
  [5, 3.5, 0.5, 76, 78],
  [6, 0, 2, 74, 90],
  [6, 2, 1, 72, 76],
  [6, 3, 1, 70, 72],
  [7, 0, 1, 70, 80],
  [7, 1, 1, 74, 86],
  [7, 2, 1.5, 79, 100],
  [7, 3.5, 0.5, 77, 80],
  [8, 0, 3, 76, 92],
  [8, 3, 1, 73, 70],
];
for (const [bar, beat, len, p, v] of THEME) {
  piano.push(n(bar, beat, len, p, v));
  if (bar < 8) piano.push(n(bar + 8, beat, len, p, v - 6));
}
piano.push(n(16, 0, 1, 76, 84), n(16, 1, 1, 69, 70), n(16, 2, 2, 73, 78));

// the pad: whole chords, an octave up, swelling into the theme
const pad = CHORDS.flatMap((c, i) => VOICING[c].slice(1).map((p) => n(i + 1, 0, 4, p + 12, 60)));

// cellos: root and fifth, held, from the theme on
const cellos = CHORDS.flatMap((c, i) =>
  i < 4 ? [] : [n(i + 1, 0, 4, ROOT[c] + 12, 70), n(i + 1, 0, 4, FIFTH[c] + 12, 58)],
);

// upright bass: root, fifth, and a step into the next bar
const bass = [];
CHORDS.forEach((c, i) => {
  if (i < 4) return;
  const next = CHORDS[i + 1] ?? 'Dm';
  bass.push(n(i + 1, 0, 1.5, ROOT[c], 92), n(i + 1, 2, 1, FIFTH[c], 80), n(i + 1, 3.5, 0.5, ROOT[next] + 1, 70));
});

// vibes: an eighth-note figure high up, in the intro and under the clarinet
const vibes = [];
CHORDS.forEach((c, i) => {
  if (!(i < 4 || (i >= 8 && i < 12))) return;
  const [a, b, d, e] = VOICING[c].map((p) => p + 24);
  for (const [k, p] of [e, d, b, d, a, d, b, d].entries()) vibes.push(n(i + 1, k / 2, 0.45, p, 50 + ((k * 11) % 30)));
});

// harp: rising sixteenths in the return
const harp = [];
CHORDS.forEach((c, i) => {
  if (i < 12) return;
  const tones = VOICING[c].map((p) => p + 12);
  for (let k = 0; k < 16; k++)
    harp.push(n(i + 1, k / 4, 0.25, tones[k % 4] + 12 * Math.floor(k / 4) - 12, 64 + (k % 4) * 6));
});

// clarinet: the answer to the theme
const clarinet = [
  [9, 0, 1.5, 77, 84],
  [9, 1.5, 0.5, 74, 70],
  [9, 2, 2, 70, 76],
  [10, 0, 1, 69, 72],
  [10, 1, 1, 72, 78],
  [10, 2, 2, 77, 90],
  [11, 0, 1.5, 79, 92],
  [11, 1.5, 0.5, 77, 76],
  [11, 2, 1, 74, 80],
  [11, 3, 1, 70, 72],
  [12, 0, 2, 76, 86],
  [12, 2, 2, 73, 74],
].map(([bar, beat, len, p, v]) => n(bar, beat, len, p, v));

// drums: kick, side stick and hats from the theme on, softer under the clarinet, a fill into each part
const drums = [];
for (let bar = 5; bar <= 16; bar++) {
  const soft = bar >= 9 && bar <= 12;
  drums.push(n(bar, 0, 0.25, 36, soft ? 70 : 100), n(bar, 2.5, 0.25, 36, soft ? 60 : 84));
  if (!soft) drums.push(n(bar, 1, 0.25, 37, 80), n(bar, 3, 0.25, 37, 86));
  for (let k = 0; k < 8; k++) drums.push(n(bar, k / 2, 0.25, k === 7 && bar % 4 === 0 ? 46 : 42, k % 2 ? 54 : 70));
  if (bar % 4 === 0) drums.push(n(bar, 3.5, 0.25, 38, 90), n(bar, 3.75, 0.25, 38, 96));
}

const C = TRACK_COLORS;
song.tracks = [
  track('Piano', { type: 'sampler', pack: 'vsco2', name: 'piano' }, C[0], piano, {
    volume: -2,
    hallSend: -14,
    inserts: [newPlugin('eq'), newPlugin('compressor')],
  }),
  track('Pad', { type: 'synth', preset: 'Warm Pad' }, C[6], pad, {
    volume: -12,
    room: -10,
    inserts: [newPlugin('chorus')],
  }),
  track('Cellos', { type: 'sampler', pack: 'vsco2', name: 'cellos' }, C[5], cellos, {
    volume: -6,
    pan: -0.2,
    hallSend: -10,
  }),
  track('Upright Bass', { type: 'sampler', pack: 'meatbass', name: 'upright' }, C[4], bass, {
    volume: -3,
    inserts: [newPlugin('compressor')],
  }),
  track('Vibes', { type: 'sampler', pack: 'vcsl', name: 'vibes' }, C[1], vibes, {
    volume: -8,
    pan: -0.35,
    room: -12,
    inserts: [newPlugin('delay')],
  }),
  track('Harp', { type: 'sampler', pack: 'vsco2', name: 'harp' }, C[8], harp, { volume: -6, pan: 0.35, hallSend: -10 }),
  track('Clarinet', { type: 'sampler', pack: 'iowa', name: 'clarinet_iowa' }, C[3], clarinet, {
    volume: -4,
    pan: 0.15,
    hallSend: -12,
  }),
  track('Drums', { type: 'synth', preset: 'Drum Synth' }, C[10], drums, { volume: -6, room: -18 }),
];
// the pad swells into the theme and falls back under the clarinet
song.tracks[1].channel.automation = [
  {
    param: 'volume',
    points: [
      [0, -20],
      [4 * BAR, -12],
      [8 * BAR, -16],
      [12 * BAR, -10],
      [16 * BAR, -14],
    ],
    mode: 'read',
    curve: 'smooth',
  },
];

async function call(path, init) {
  const res = await fetch(`${base}${path}`, { headers: { 'content-type': 'application/json' }, ...init });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

const there = await fetch(`${base}/api/projects/${ID}`);
if (there.ok) {
  const current = await there.json();
  const doc = { ...song, revision: current.revision, created: current.created };
  const saved = await call(`/api/projects/${ID}`, {
    method: 'PUT',
    body: JSON.stringify({ doc, baseRevision: current.revision, author: 'demo-song' }),
  });
  console.log(`Updated "${song.title}" (${ID}, revision ${saved.revision})`);
} else {
  const saved = await call('/api/projects', { method: 'POST', body: JSON.stringify({ doc: song }) });
  console.log(`Added "${song.title}" (${saved.id})`);
}
