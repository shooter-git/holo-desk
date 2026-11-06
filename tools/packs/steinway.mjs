// `node tools/packs/steinway.mjs [--cache DIR] [--out DIR]`: the Steinway Model D pack, from the
// bitKlavier Grand sample library (Princeton University, CC BY 4.0), written into
// packs/manifests/steinway.json and packs/checksums/steinway.sha256.
//
// bitKlavier recorded a new Steinway D in Taplin Auditorium in 2021 from nine microphone positions:
// 16 velocity layers every minor third from A0, the hammers coming back (a sample a key), the strings
// ringing off as the dampers fall (three layers every minor third) and the pedal. This takes two
// positions: the Stage Lid ORTF pair (a balanced image of the whole instrument, a little of the hall)
// and the Piano Bar inside the piano (close, a player's perspective, no room). Its notes ring for up to
// 74 seconds; each is kept until it falls to -58 dB (a fade to silence over its last second or so, 20 s at most),
// which is what a device has to hold. Nothing else is changed: the files are the library's 44.1 kHz
// 16-bit release, bit for bit, up to the fade.
//
// The layers were recorded and balanced by bitKlavier to divide the piano's dynamic range evenly; here
// each is measured (its loudness, as BS.1770 weighs it) and set where the velocity curve meets it, so a
// key played harder gets louder smoothly and changes timbre at each layer, as the piano does.
import { join } from 'node:path';
import {
  arg,
  Downloads,
  decayRate,
  loudness,
  makeFiles,
  memoryMb,
  pinDownloads,
  spreadLayers,
  tailEnd,
  writeManifest,
} from './lib.mjs';

const cache = arg('cache', join(process.env.HOME ?? '.', '.cache/holo-pack-sources/steinway'));
const out = arg('out', null);

const HOST = 'https://g-ef94ef.f0ad1.36fe.data.globus.org/10.34770';
const IMAGES = [
  {
    tag: 'ortf',
    doi: 'csaa-6a71',
    base: `${HOST}/csaa-6a71/403/bitKlavierGrand_StageLidORTF_44k16b/`,
    name: 'grand',
    title: 'Steinway D Grand',
    light: { name: 'grand-light', title: 'Steinway D Grand, Light' },
  },
  {
    tag: 'bar',
    doi: 'r75s-9j74',
    base: `${HOST}/r75s-9j74/36/bitKlavierGrand_PianoBar_44k16b/`,
    name: 'grand-close',
    title: 'Steinway D Grand, Close',
  },
];

const PC = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
const midi = (note, octave) => (octave + 1) * 12 + PC[note];
const RATE = 44100;
/** Where a struck note is kept to, and how it fades. */
const FULL = { floor: -58, cap: 20, fade: 1.5 };
/** The light instrument: half the layers, shorter tails (cut as they load, from the same files). */
const LIGHT = { floor: -52, cap: 10, fade: 0.8 };
/** Keys from F#6 up have no dampers on a Steinway D. */
const UNDAMPED = 90;
/** A damper stops a bass string more slowly than a treble one. */
const damperTime = (key) => Math.round((0.12 + 0.38 * Math.min(1, Math.max(0, (96 - key) / 75))) * 1000) / 1000;

/** The library's file names, as its catalog lists them (one position has its own names for the sharps). */
async function catalog(image) {
  const res = await fetch(`https://datacommons.princeton.edu/discovery/catalog/doi-10-34770-${image.doi}.json`);
  if (!res.ok) throw new Error(`The bitKlavier catalog (${image.doi}): ${res.status}`);
  const files = (await res.json()).files.filter((f) => f.full_path.includes('_44k16b/') && f.name.endsWith('.wav'));
  const names = new Map();
  for (const f of files) {
    if (!f.download_url.startsWith(image.base)) throw new Error(`${f.name} isn't under ${image.base}`);
    const m = /^(harm)?([A-G])_(\d)v(\d+)\(\d+\)\.wav$/.exec(f.name);
    const canonical = m ? `${m[1] ?? ''}${m[2]}#${m[3]}v${m[4]}.wav` : f.name;
    names.set(canonical, f.full_path.split('/').pop());
  }
  return names;
}

const bases = Object.fromEntries(IMAGES.map((i) => [i.tag, i.base]));
const downloads = new Downloads(cache, bases);
const files = {};
const instruments = [];
const memory = [];

for (const image of IMAGES) {
  console.log(`${image.title} (${image.tag}):`);
  const names = await catalog(image);
  const dl = (canonical) => {
    const upstream = names.get(canonical);
    if (!upstream) throw new Error(`${canonical} isn't in the ${image.tag} catalog`);
    return `${image.tag}:${upstream}`;
  };
  await downloads.all([...names.keys()].map(dl));
  const made = (canonical) => `${image.tag}/${canonical.replace('#', 's')}`;

  const sustain = [];
  const harm = [];
  const rel = [];
  const pedal = [];
  for (const canonical of names.keys()) {
    const note = /^([A-G]#?)(\d)v(\d+)\.wav$/.exec(canonical);
    const ring = /^harm([A-G]#?)(\d)v(\d+)\.wav$/.exec(canonical);
    const hammer = /^rel(\d+)\.wav$/.exec(canonical);
    const foot = /^pedal([DU])(\d)\.wav$/.exec(canonical);
    if (note) sustain.push({ canonical, key: midi(note[1], Number(note[2])), layer: Number(note[3]) });
    else if (ring) harm.push({ canonical, key: midi(ring[1], Number(ring[2])), layer: Number(ring[3]) });
    else if (hammer) rel.push({ canonical, key: 20 + Number(hammer[1]) });
    else if (foot) pedal.push({ canonical, down: foot[1] === 'D', rr: Number(foot[2]) });
  }
  if (sustain.length !== 480 || harm.length !== 90 || rel.length !== 88 || pedal.length !== 4)
    throw new Error(
      `${image.tag}: ${sustain.length} notes, ${harm.length} ring-offs, ${rel.length} hammers, ${pedal.length} pedals`,
    );

  // measure every note: its loudness, where it has fallen away, how fast it decays
  for (const s of [...sustain, ...harm, ...rel, ...pedal]) {
    const d = downloads.decoded(dl(s.canonical));
    if (d.rate !== RATE) throw new Error(`${s.canonical}: ${d.rate} Hz`);
    s.frames = d.channels[0].length;
    s.loudness = loudness(d.channels, RATE, 0, 0.4);
    if (s.layer !== undefined && !s.canonical.startsWith('harm')) {
      s.end = Math.min(s.frames, tailEnd(d.channels, RATE, FULL.floor, RATE) + Math.round(0.5 * RATE), FULL.cap * RATE);
      s.lightEnd = Math.min(
        s.end,
        tailEnd(d.channels, RATE, LIGHT.floor, RATE) + Math.round(0.3 * RATE),
        LIGHT.cap * RATE,
      );
      if (s.layer === 8) s.decay = decayRate(d.channels, RATE, 0.3, 3);
    } else {
      // ring-offs, hammers and the pedal: short, kept down to -80 dB
      s.end = Math.min(s.frames, tailEnd(d.channels, RATE, -80, Math.round(0.2 * RATE)) + Math.round(0.05 * RATE));
    }
    const fade = s.layer !== undefined && !s.canonical.startsWith('harm') ? FULL.fade : 0.05;
    files[made(s.canonical)] = {
      in: [[dl(s.canonical), 1, 1]],
      start: 0,
      frames: s.end,
      fadeIn: 0,
      fadeOut: Math.min(Math.round(fade * RATE), Math.round(s.end * 0.4)),
    };
  }

  // the layers, by their loudness over the keyboard
  const layerLevel = (list, k) => {
    const of = list.filter((s) => s.layer === k);
    return of.reduce((a, s) => a + s.loudness, 0) / of.length;
  };
  const levels = Array.from({ length: 16 }, (_, i) => layerLevel(sustain, i + 1));
  // every position plays its loudest layer at the same level: the stage pair's, 4 dB down (a track's
  // fader starts at 0 dB, and a chord played hard under the pedal must stay under full scale)
  if (!IMAGES[0].target) IMAGES[0].target = spreadLayers(levels).ref - 4;
  const target = IMAGES[0].target;
  const spread = spreadLayers(levels, { target });
  const offset = target - spread.ref;
  const harmLevels = [1, 2, 3].map((k) => layerLevel(harm, k));
  const harmSpread = spreadLayers(harmLevels, { target: spreadLayers(harmLevels).ref + offset });
  console.log(
    `  layers ${levels[0].toFixed(1)} to ${levels[15].toFixed(1)} dB, velocity range ${spread.range.toFixed(1)} dB; ` +
      `ring-offs ${harmLevels.map((l) => l.toFixed(1)).join(' ')} (range ${harmSpread.range.toFixed(1)} dB)`,
  );

  // each sampled note covers the keys a semitone either side (the lowest and highest, the ends too)
  const keyRange = (key) => [key === 21 ? 0 : key - 1, key === 108 ? 127 : key + 1];
  const decayOf = new Map(sustain.filter((s) => s.decay !== undefined).map((s) => [s.key, s.decay]));
  const zone = (s, extra) => {
    const [lo, hi] = keyRange(s.key);
    return {
      file: made(s.canonical),
      root: s.key,
      lo,
      hi,
      start: 0,
      end: s.end,
      loopStart: 0,
      loopEnd: 0,
      rate: RATE,
      rr: 0,
      ...extra,
    };
  };
  const struck = (layers) =>
    sustain
      .filter((s) => layers.includes(s.layer))
      .sort((a, b) => a.key - b.key || a.layer - b.layer)
      .map((s) => {
        const v = layers === ALL ? spread.layers[s.layer - 1] : lightSpread.layers[layers.indexOf(s.layer)];
        return zone(s, { lovel: v.lovel, hivel: v.hivel, gain: round(v.gain), release: damperTime(s.key) });
      });
  const ALL = Array.from({ length: 16 }, (_, i) => i + 1);
  const LAYERS = [2, 4, 6, 8, 10, 12, 14, 16];
  const lightSpread = spreadLayers(
    LAYERS.map((k) => levels[k - 1]),
    { range: spread.range, target },
  );
  const releases = [
    // the strings ringing off as the dampers fall: quieter the longer the note was held, as it is
    ...harm
      .sort((a, b) => a.key - b.key || a.layer - b.layer)
      .map((s) => {
        const v = harmSpread.layers[s.layer - 1];
        const decay = Math.min(20, Math.max(0.5, decayOf.get(s.key) ?? 4));
        return zone(s, {
          lovel: v.lovel,
          hivel: v.hivel,
          gain: round(v.gain),
          trigger: 'release',
          decay: round(decay),
        });
      }),
    // each key's hammer and key coming back up, the same however long it was held
    ...rel
      .sort((a, b) => a.key - b.key)
      .map((s) => ({
        ...zone(s, {}),
        lo: s.key,
        hi: s.key,
        lovel: 1,
        hivel: 127,
        gain: round(offset),
        trigger: 'release',
        part: 1,
        decay: 0,
      })),
  ];
  const pedals = pedal
    .sort((a, b) => Number(b.down) - Number(a.down) || a.rr - b.rr)
    .map((s) => ({
      file: made(s.canonical),
      root: 60,
      lo: 0,
      hi: 127,
      lovel: 1,
      hivel: 127,
      gain: round(offset),
      start: 0,
      end: s.end,
      loopStart: 0,
      loopEnd: 0,
      rate: RATE,
      rr: s.rr,
      trigger: s.down ? 'pedalDown' : 'pedalUp',
    }));
  const playing = {
    category: 'Piano',
    pitched: true,
    release: 0.3,
    attack: 0,
    oneShot: false,
    velocityRange: round(spread.range),
    releaseVelocityRange: round(harmSpread.range),
    polyphony: 128,
    notePolyphony: 2,
    offTime: 0.12,
    undamped: UNDAMPED,
  };
  const full = { name: image.name, title: image.title, ...playing, zones: [...struck(ALL), ...releases, ...pedals] };
  instruments.push(full);
  memory.push(`${image.title}: ${memoryMb(full.zones).toFixed(0)} MB`);
  if (image.light) {
    const zones = struck(LAYERS).map((z) => {
      const s = sustain.find((x) => made(x.canonical) === z.file);
      return { ...z, end: s.lightEnd, fadeOut: Math.min(Math.round(LIGHT.fade * RATE), Math.round(s.lightEnd * 0.4)) };
    });
    const light = {
      name: image.light.name,
      title: image.light.title,
      ...playing,
      zones: [...zones, ...releases, ...pedals],
    };
    instruments.push(light);
    memory.push(`${image.light.title}: ${memoryMb(light.zones).toFixed(0)} MB`);
  }
}

function round(x) {
  return Math.round(x * 100) / 100;
}

const source = {
  kind: 'mix',
  note:
    "bitKlavier Grand's 44.1 kHz 16-bit release (Princeton University Research Data Service), each note kept until " +
    'it falls to -58 dB (20 s at most) and faded there, otherwise bit for bit.',
  bases,
  downloads: {},
  bits: 16,
  files,
};
source.downloads = pinDownloads(source, downloads);
const pack = {
  format: 'holo-pack',
  version: 1,
  id: 'steinway',
  name: 'Steinway Model D (bitKlavier Grand)',
  license: 'CC-BY-4.0',
  credit:
    'bitKlavier Grand Sample Library by Matthew Wang, Andrés Villalta, Jeffrey Gordon, Katie Chou, Christien Ayers ' +
    'and Daniel Trueman, Princeton University (CC BY 4.0, doi:10.34770/csaa-6a71 and doi:10.34770/r75s-9j74): a ' +
    'Steinway D recorded in Taplin Auditorium in 2021. Trimmed for HO[LO]: each note ends where it falls to -58 dB.',
  source,
  root: 'samples',
  instruments,
};
console.log(`Writing: ${Object.keys(files).length} files`);
await makeFiles(pack, downloads, out);
console.log(`${writeManifest(pack)}\n${memory.join('\n')} (decoded, at 48 kHz)`);
