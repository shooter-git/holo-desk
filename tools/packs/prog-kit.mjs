// `node tools/packs/prog-kit.mjs [--cache DIR] [--out DIR]`: the Prog Kit pack: a big progressive-rock
// kit with six toms, a bright metal snare, trashy cymbals and a gong, put together from three CC0
// libraries:
//
// - Karoryfer's Big Rusty Drums: the 24" kick, the 14", 15", 18" and 22" toms (and the 14" tuned up two
//   and four semitones for the two highest), 17" crash, 17" sizzle crash, 18" china, a three-cymbal
//   stack, 22" ride and its bell, 19" sizzle ride, 14" hi-hats;
// - Karoryfer's Frankensnare: a 14x8 aluminium snare (its hits, rimshots and sidesticks);
// - VSCO 2 Community Edition: an orchestral gong, seven layers from p to fff.
//
// Mixed tighter than the Rock Kit (the close microphones forward, less of the overheads on the toms),
// for fast, articulate tom runs and double kicks: both kick keys play the one kick, taking turns.
import { buildKit, Downloads, githubTree, hitsIn, raw } from './kit.mjs';
import { arg } from './lib.mjs';

const RUSTY = ['sfzinstruments/karoryfer.big-rusty-drums', 'f07ce00df34a46b6b08375be56fe116cf15782bc'];
const FRANKEN = ['sfzinstruments/karoryfer.frankensnare', '9151c2d79fcbb73c65d63f78918d4ba7abc91a81'];
const VSCO = ['sgossner/VSCO-2-CE', '440300901dfe9275fd84e0b7763af1f8443ae62e'];
const bases = { rusty: raw(...RUSTY), franken: raw(...FRANKEN), vsco: raw(...VSCO) };
const downloads = new Downloads(arg('cache', `${process.env.HOME}/.cache/holo-pack-sources/prog-kit`), bases);
const rusty = await githubTree(...RUSTY, downloads);
const franken = await githubTree(...FRANKEN, downloads);

const fader = (cc, amplitude = 100) => (cc / 127) * (amplitude / 100);
const vl = (prefix) => new RegExp(`^${prefix}_vl(\\d+)_rr(\\d+)\\.flac$`);
const r = (folder, mics, prefix) => hitsIn(rusty, 'rusty', `Samples/${folder}`, mics, vl(prefix));
const f = (folder, prefix) =>
  hitsIn(franken, 'franken', `Samples/${folder}`, { top: 'top', btm: 'btm', oh: 'oh' }, vl(prefix));
// Frankensnare's own mixer for the 14x8 aluminium: overheads and top full, bottom at 60
const snareMics = { top: [fader(100)], btm: [fader(60)], oh: [fader(100)] };
// another recording: its snare sits a decibel over the kick, its rimshot and sidestick move with it
const SNARE = ['snare', 'kick'];

const tom = (size, pan, keys, tune = 0, name = `tom-${size}`) => ({
  name,
  ...(tune ? { title: `Tom ${size}″ up ${tune}` } : {}),
  keys,
  tune,
  hits: r(`tom_${size}/center`, { cl: 'cl', oh: 'oh' }, `t${size}`),
  mics: { cl: [fader(100), pan], oh: [fader(45)] },
  ring: 2.8,
  fade: 0.6,
  leadsRange: true,
});
const cymbal = (name, folder, prefix, keys, amplitude, pan, extra = {}) => ({
  name,
  keys,
  hits: r(folder, { cl: 'cl', oh: 'oh' }, prefix),
  mics: { cl: [fader(50, amplitude), pan], oh: [fader(100, amplitude)] },
  ring: 5,
  fade: 1.4,
  floor: 56,
  maxRR: 2,
  ...extra,
});
const hat = (name, folder, prefix, keys, extra = {}) => ({
  name,
  keys,
  hits: r(`hihat_14/${folder}`, { cl: 'cl', oh: 'oh' }, prefix),
  mics: { cl: [fader(100, 70)], oh: [fader(100, 60)] },
  group: 1,
  ...extra,
});
// the gong: seven layers from p to fff (VSCO 2's own takes, one stereo pair), a second take of three of
// them taking turns; its quieter takes are softer than the kit's velocities reach
const GONG = 'VSCO 1 Percussion/varMetal/Gong';
const gongHits = [['p'], ['mp_hard', 'mp'], ['mp-mf'], ['mf', 'mf_3'], ['f'], ['ff', 'ff_hard'], ['fff']].flatMap(
  (takes, i) => takes.map((d, r) => ({ layer: i + 1, rr: r + 1, mics: { st: `vsco:${GONG}/gong_hit_${d}.wav` } })),
);

await buildKit({
  id: 'prog-kit',
  name: 'Prog Kit (Big Rusty Drums, Frankensnare, VSCO 2)',
  license: 'CC0-1.0',
  credit:
    'Big Rusty Drums and Frankensnare by Karoryfer Samples (CC0), and the gong of VSCO 2 Community Edition by ' +
    'Versilian Studios (CC0). Put together and mixed for HO[LO]: six toms, a 14x8 aluminium snare, a gong.',
  note: 'Big Rusty Drums and Frankensnare (FLAC) and VSCO 2 (WAV) at their pinned commits, mixed from their microphones.',
  folder: 'prog',
  instrument: { name: 'kit', title: 'Prog Kit' },
  level: -19,
  downloads,
  bases,
  // the pads, in rows of four: cymbals and hats, the four highest toms, the gong, the snare's strokes and the
  // kick, then the low toms and the rest
  pads: [
    'crash',
    'ride',
    'hat-open',
    'hat-closed',
    'tom-14-up4',
    'tom-14-up2',
    'tom-14',
    'tom-15',
    'gong',
    'sidestick',
    'snare',
    'kick',
    'tom-18',
    'tom-22',
    'rimshot',
    'hat-pedal',
    'hat-half',
    'hat-loose',
    'crash-sizzle',
    'china',
    'stack',
    'ride-bell',
    'ride-sizzle',
  ],
  pieces: [
    {
      name: 'kick',
      keys: [35, 36],
      pad: 36,
      hits: r('kick_24/kick', { kick: 'kick', oh: 'oh' }, 'k'),
      mics: { kick: [fader(100)], oh: [0.2] },
      ring: 1.4,
      fade: 0.3,
      leadsRange: true,
    },
    { name: 'sidestick', keys: [37], hits: f('14a_basic', 'ss'), mics: snareMics, ring: 0.8, levelAs: SNARE, trim: 1 },
    {
      name: 'snare',
      keys: [38],
      hits: f('14a_basic', 'sn'),
      mics: snareMics,
      ring: 1.8,
      fade: 0.5,
      leadsRange: true,
      levelAs: SNARE,
      trim: 1,
    },
    {
      name: 'rimshot',
      keys: [40],
      hits: f('14a_rimshot', 'sr'),
      mics: snareMics,
      ring: 2,
      fade: 0.5,
      levelAs: SNARE,
      trim: 1,
    },
    tom(22, 112, [41]),
    tom(18, 96, [43]),
    tom(15, 72, [45]),
    tom(14, 50, [47]),
    tom(14, 34, [48], 2, 'tom-14-up2'),
    tom(14, 18, [50], 4, 'tom-14-up4'),
    hat('hat-closed', 'tc', 'ht_tc', [42], { ring: 0.8 }),
    hat('hat-pedal', 'chik', 'ht_chik', [44], { ring: 0.8 }),
    hat('hat-open', 'open', 'ht_open', [46], { offBy: 1, ring: 3, fade: 0.8 }),
    hat('hat-loose', 'lc', 'ht_lc', [22], { offBy: 1, ring: 1.5, fade: 0.4 }),
    hat('hat-half', 'ho', 'ht_ho', [26], { offBy: 1, ring: 2.5, fade: 0.6 }),
    cymbal('crash', 'crash_17/cr', 'cr', [49], 70, 30),
    cymbal('crash-sizzle', 'crash_sizzle_17/cr', 'crs', [57], 60, 53),
    cymbal('china', 'china_18/cn', 'cn', [52], 75, 50),
    cymbal('stack', 'stack_3_layer/ed', 'st_ed', [55], 44, 73, { ring: 2.5, fade: 0.6 }),
    cymbal('ride', 'ride_22/rd', 'rd', [51], 60, 97, { ring: 4, maxRR: 3 }),
    cymbal('ride-bell', 'ride_22/bl', 'rd_bl', [53], 65, 97, { ring: 4 }),
    cymbal('ride-sizzle', 'ride_sizzle_19/rd', 'rds', [59], 60, 77, { ring: 5 }),
    {
      name: 'gong',
      keys: [39, 58],
      hits: gongHits,
      mics: { st: [1] },
      ring: 11,
      fade: 3.5,
      floor: 56,
      levelAs: ['gong', 'crash'],
      trim: 1,
    },
  ],
});
