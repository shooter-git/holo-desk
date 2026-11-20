/**
 * Prism's patch format: what a sound may carry in its params besides its six knobs, so a sound can
 * be a whole patch (four sources and how they morph, the filters, every modulator, the routings
 * and the effects), not only a preset with its knobs turned. Every value is a number, so a patch
 * travels wherever a synth's params already go (a song, a palette's sound, a pack instrument, the
 * engine) and is checked like any knob. Keys a sound leaves out keep the preset's values, unless it
 * starts from nothing:
 *
 *   patch:blank     0|1        1: start from a blank patch (below) instead of the preset
 *
 * Sources, n = 1…4. Each is one of four kinds, sent through its own filter, then panned and mixed:
 *   s{n}:on         0|1        it plays at all (a source off costs nothing)
 *   s{n}:kind       0…3        0 oscillators, 1 partials, 2 sample, 3 grains (PRISM_KINDS)
 *   s{n}:level      0…4        its gain (1: as made)
 *   s{n}:power      0.25…4     how its level answers what moves it: what the links make of it is raised
 *                              to this power (1 straight; 3 a cube: fades that fall away fast at the end)
 *   s{n}:pan        ±1         where it sits
 *   s{n}:coarse     ±48        semitones (not rounded: 7.02 is a pure fifth)
 *   s{n}:fine       ±100       cents
 *   s{n}:keytrack   0|1        1: it follows the key; 0: it plays at its own pitch (middle C) on every key
 *   s{n}:route      0…1        0 into filter 1, 1 into filter 2, between: some into each
 *   s{n}:stereo     0|1        1: its oscillators or partials spread across the field (their pan
 *                              spreads), its grains too (spray), or a sample plays both its sides;
 *                              0: one channel, panned (cheaper)
 *   s{n}:ftype      0…7        its own filter: 0 none, else PRISM_FILTERS[ftype - 1]
 *   s{n}:cutoff     20…20000   Hz;  s{n}:res 0…1 (a band-pass or notch: how narrow, from four
 *                              octaves wide)
 *
 *  Oscillators (kind 0): a bank of oscillators reading one waveform, each at its own pitch, level
 *  and place, so the same bank is a single saw, a detuned stack or an organ of sine partials:
 *   s{n}:wave       0…9        PRISM_WAVES (band-limited by octave at any pitch)
 *   s{n}:custom     0…4        a waveform the sound brings itself (w1…w4 below) instead; 0: none
 *   s{n}:count      1…64       oscillators (a fraction plays the last one that much)
 *   s{n}:ampa, s{n}:ampb  0…7  two amplitude spreads (PRISM_AMP_SPREADS) and
 *   s{n}:amp        0…1        where between them it is; likewise
 *   s{n}:pitcha, s{n}:pitchb (PRISM_PITCH_SPREADS), s{n}:pitch 0…1: each oscillator's frequency
 *                              over the note's (between two spreads, as frequency ratios)
 *   s{n}:pana, s{n}:panb (PRISM_PAN_SPREADS), s{n}:panmix 0…1, s{n}:width 0…1 (how far out they go)
 *   s{n}:detune     0…100      cents per step of the Detuned spread
 *   s{n}:sym        0…1        symmetry: the waveform's first half squeezed or stretched (0.5: as drawn)
 *   s{n}:phase      0…1        where every oscillator starts on a note; s{n}:free 0|1: each anywhere
 *
 *  Partials (kind 1): sine partials read from data that changes over time (a sound's analysis): each
 *  partial's level, frequency and place along the sound. Sample (kind 2) and grains (kind 3) play a
 *  recording. Their data comes from the pack instrument that plays through Prism (its zones for this
 *  source), or is one built in:
 *   s{n}:data       0…8        0 the pack's; else PRISM_PARTIAL_SETS[data - 1] (partials) or
 *                              PRISM_SAMPLES[data - 1] (sample, grains)
 *   s{n}:pos        0…1        where it starts, as a share of its length (moved by modulation, it scrubs)
 *   s{n}:speed      0…4        how fast partials and grains move along (1: as recorded; 0: they stay
 *                              at pos); a sample plays at the note's pitch
 *   s{n}:loop       0…4        PRISM_LOOPS;  s{n}:start, s{n}:end 0…1: the loop, as shares of the
 *                              length (both 0: the data's own loop, else the whole)
 *   s{n}:partials   1…128      partials heard (kind 1; a fraction plays the last one that much)
 *   s{n}:size       0.005…0.5  seconds a grain lasts;  s{n}:density 1…16 grains at once
 *   s{n}:jitter     0…1        how far each grain's start wanders (up to 50 ms either way)
 *   s{n}:spray      0…1        how far each grain's place wanders
 *   Partials also take the amplitude and pan spreads above (each partial's level and place times the
 *   data's).
 *
 * Morph: the four sources as the corners of a pad (1 top left, 2 top right, 3 bottom left, 4 bottom
 * right), heard by how near x and y are to each:
 *   xy:on 0|1 (0: every source at its own level), xy:x 0…1, xy:y 0…1, xy:power 0|1 (1: equal power)
 *
 * The filters: each source goes into filter 1 or 2 (route); filter 1 may also feed filter 2:
 *   f{k}:on 0|1, f{k}:type 0…6 (PRISM_FILTERS), f{k}:cutoff 20…20000 Hz, f{k}:res 0…1,
 *   f{k}:drive 0…1, k = 1, 2;  f:serial 0…1 (how much of filter 1 goes on into filter 2)
 *
 * Amplitude and voice: env 1 is the amplitude envelope (a voice ends when it does):
 *   amp:level 0…4, amp:pan ±1, amp:volume ±24 dB (after the effects), amp:power 0.25…4 (env 1 and
 *   what the links make of the level, raised to this power, as a source's)
 *   voice:poly 1…32 notes at once, voice:mono 0|1, voice:legato 0|1 (mono: a note played over a held
 *   one glides there without starting again), voice:glide 0…10 s, voice:glidemode 0|1 (0 the time is
 *   the whole glide; 1 per octave), voice:bend 0…24 semitones, voice:transpose ±48, voice:tune ±100 cents
 *
 * Modulators. Everything below moves at the control rate (every 32 samples), smoothly between:
 *   LFOs, n = 1…12: lfo{n}:shape 0…6 (PRISM_LFO_SHAPES), lfo{n}:custom 0…4 (a shape the sound
 *   brings, l1…l4 below, instead), lfo{n}:rate 0.01…50 Hz, lfo{n}:sync 0|1 and lfo{n}:beats
 *   1/32…128 (with sync, a cycle lasts this many quarter notes), lfo{n}:bipolar 0|1 (−1…1, else 0…1),
 *   lfo{n}:delay 0…20 s, lfo{n}:fade 0…20 s (its depth comes in), lfo{n}:phase 0…1 (where it starts),
 *   lfo{n}:mode 0…2 (PRISM_LFO_MODES: starting again on each note, running free, or kept to the song)
 *   Envelopes, n = 1…4: env{n}:a, env{n}:h, env{n}:d, env{n}:r 0…60 s, env{n}:s 0…1, and the shape of
 *   the attack, decay and release env{n}:ac, env{n}:dc, env{n}:rc ±1 (0 straight; above 0 quick
 *   then slow, below 0 slow then quick)
 *   Shapes (drawn envelopes), n = 1…4: shape{n}:n 2…48 points, shape{n}:x{k} 0…64 (seconds, or quarter
 *   notes with sync), shape{n}:y{k} 0…1, shape{n}:c{k} ±1 (the curve from point k to the next),
 *   shape{n}:loop 0…3 (PRISM_SHAPE_LOOPS), shape{n}:ls, shape{n}:le 0…47 (the loop's points),
 *   shape{n}:sync 0|1
 *   Step sequencers, n = 1…4: seq{n}:steps 1…32, seq{n}:beats 1/32…16 (quarter notes a step),
 *   seq{n}:v{k} 0…1 (step k's value), seq{n}:t{k} 0|1 (tied into the next), seq{n}:swing 0…1,
 *   seq{n}:attack, seq{n}:gate, seq{n}:release 0…1 (shares of a step: rise, hold, fall)
 *   Curves, n = 1…8, bend a source on its way to a target: curve{n}:n 2…48 points, curve{n}:x{k},
 *   curve{n}:y{k} 0…1, curve{n}:c{k} ±1
 *   Controls ctl1…ctl10 0…1: fixed values a patch can route like knobs.
 *
 * The matrix, n = 1…32 links, each a source moving a target:
 *   mod{n}:src      0…47       PRISM_MOD_SOURCES (0: the link is off)
 *   mod{n}:dst      0…128      PRISM_MOD_TARGETS: each source's (level … resonance, PRISM_SOURCE_TARGETS),
 *                              then the filters, level, pan, pitch, the morph point, each LFO's rate and
 *                              each envelope's attack, decay and release (in octaves), then each effect's
 *                              mix and first four settings (prismTargetName names one)
 *   mod{n}:depth    ±1         how far: a whole target's range at 1 (levels: how much of the way
 *                              to silence the source takes it; below 0, the other way round)
 *   mod{n}:curve    0…8        a curve the source goes through first (0: none)
 *   mod{n}:via      0…47       a second source that moves the depth (0: none), by
 *   mod{n}:viadepth ±1, through mod{n}:viacurve 0…8
 *   A bipolar source (an LFO set so, Key, Bend, a knob) swings either way; the others only push.
 *
 * The effects, in slots fx1…fx6, one after another on everything the voices make:
 *   fx{k}:type 0…6 (PRISM_EFFECTS), fx{k}:mix 0…1, and by type:
 *   Delay:      time 0.001…8 s (with sync on, quarter notes: time and timer both),
 *               timer (the right side's, 0: as the left), sync 0|1, feedback 0…0.98, cross 0…1
 *               (each side's echoes into the other), lowcut 20…5000 Hz, highcut 200…20000 Hz
 *   Chorus:     delay 0.1…30 ms, depth 0…10 ms, rate 0.01…10 Hz, feedback ±0.95, width 0…1
 *   Drive:      drive 0…1, tube 0…1, crush 0…1, output 0…2
 *   Band:       low 20…20000 Hz, high 20…20000 Hz, lowres 0…1, highres 0…1, reject 0…1 (what the
 *               band takes out, put back)
 *   Compressor: amount 0…1, release 0.01…2 s
 *   Reverb:     size 0…1, decay 0.2…30 s, predelay 0…0.25 s, damp 0…1, width 0…1
 *   Their targets in the matrix (Effect k: mix, then its first four settings in the order above).
 *
 * Waveforms and LFO shapes a sound brings, k = 1…4:
 *   w{k}:{i} ±1, i = 0…1023: one cycle of a waveform, its points in order (as many as are given, at
 *   least four); played band-limited, as the built-in ones are, with any offset taken out
 *   l{k}:{i} ±1, i = 0…63: one cycle of an LFO shape, its points in order, read straight across
 *
 * A blank patch: source 1 on, one saw oscillator, the others off; no filter on; env 1 up in 5 ms,
 * full while held, down in 0.3 s; velocity to the level at half; 8 notes; no effects.
 *
 * The six knobs (m1…m6, 0…1 each) are sources in the matrix (Macro 1…6), swinging −1…1 about their
 * middle, so a sound is as made with its knobs half way: each preset names its six and wires them
 * where they matter, so they move the sound whatever the patch.
 */

export const PRISM_SOURCES = 4;
export const PRISM_KINDS = ['Oscillators', 'Partials', 'Sample', 'Grains'];
export const PRISM_WAVES = [
  'Sine',
  'Triangle',
  'Saw',
  'Square',
  'Pulse',
  'Narrow Pulse',
  'Soft Saw',
  'Organ',
  'Hollow',
  'Bright',
];
export const PRISM_AMP_SPREADS = ['All', 'First', 'All but first', 'Odd', 'Even', 'Falling', 'Steep', 'Formant'];
export const PRISM_PITCH_SPREADS = ['Unison', 'Detuned', 'Harmonic', 'Odd', 'Octaves', 'Stretched', 'Bar', 'Fifths'];
export const PRISM_PAN_SPREADS = ['Center', 'Fan', 'Fan mirrored', 'Alternate', 'Alternate mirrored'];
export const PRISM_LOOPS = ['Off', 'Forward', 'While held', 'Back and forth', 'Whole'];
export const PRISM_FILTERS = ['Low-pass', 'High-pass', 'Band-pass', 'Notch', 'Diode', 'Ladder 12', 'Ladder 24'];
export const PRISM_LFO_SHAPES = ['Sine', 'Triangle', 'Ramp up', 'Ramp down', 'Square', 'Steps', 'Drift'];
export const PRISM_LFO_MODES = ['Each note', 'Free', 'Song'];
export const PRISM_SHAPE_LOOPS = ['Off', 'Loop', 'While held', 'Back and forth'];
export const PRISM_EFFECTS = ['Off', 'Delay', 'Chorus', 'Drive', 'Band', 'Compressor', 'Reverb'];
/** Partial sets built in (a source's data 1…). */
export const PRISM_PARTIAL_SETS = ['Struck Bar', 'Glass', 'Bell', 'Bowl', 'Voice', 'Strike'];
/** Recordings built in (made, not recorded: a source's data 1…). */
export const PRISM_SAMPLES = ['Air', 'Shimmer', 'Choir', 'Chime'];

export const PRISM_LFOS = 12;
export const PRISM_ENVS = 4;
export const PRISM_SHAPES = 4;
export const PRISM_SEQS = 4;
export const PRISM_CURVES = 8;
export const PRISM_CONTROLS = 10;
export const PRISM_LINKS = 32;
export const PRISM_FX = 6;
export const PRISM_POINTS = 48;
export const PRISM_STEPS = 32;
export const PRISM_CUSTOM_WAVES = 4;
export const PRISM_CUSTOM_POINTS = 1024;
export const PRISM_LFO_POINTS = 64;
export const PRISM_MAX_OSCS = 64;
export const PRISM_MAX_PARTIALS = 128;

/** Each effect's settings, in order: the first four are its targets in the matrix (after its mix). */
export const PRISM_FX_PARAMS: Record<number, { id: string; name: string; min: number; max: number; log?: boolean }[]> =
  {
    1: [
      { id: 'feedback', name: 'Feedback', min: 0, max: 0.98 },
      { id: 'lowcut', name: 'Low cut', min: 20, max: 5000, log: true },
      { id: 'highcut', name: 'High cut', min: 200, max: 20000, log: true },
      { id: 'cross', name: 'Cross', min: 0, max: 1 },
      { id: 'time', name: 'Time', min: 0.001, max: 8, log: true },
      { id: 'timer', name: 'Time right', min: 0, max: 8 },
      { id: 'sync', name: 'Sync', min: 0, max: 1 },
    ],
    2: [
      { id: 'rate', name: 'Rate', min: 0.01, max: 10, log: true },
      { id: 'depth', name: 'Depth', min: 0, max: 10 },
      { id: 'feedback', name: 'Feedback', min: -0.95, max: 0.95 },
      { id: 'width', name: 'Width', min: 0, max: 1 },
      { id: 'delay', name: 'Delay', min: 0.1, max: 30, log: true },
    ],
    3: [
      { id: 'drive', name: 'Drive', min: 0, max: 1 },
      { id: 'tube', name: 'Tube', min: 0, max: 1 },
      { id: 'crush', name: 'Crush', min: 0, max: 1 },
      { id: 'output', name: 'Output', min: 0, max: 2 },
    ],
    4: [
      { id: 'low', name: 'Low', min: 20, max: 20000, log: true },
      { id: 'high', name: 'High', min: 20, max: 20000, log: true },
      { id: 'lowres', name: 'Low res', min: 0, max: 1 },
      { id: 'highres', name: 'High res', min: 0, max: 1 },
      { id: 'reject', name: 'Reject', min: 0, max: 1 },
    ],
    5: [
      { id: 'amount', name: 'Amount', min: 0, max: 1 },
      { id: 'release', name: 'Release', min: 0.01, max: 2, log: true },
    ],
    6: [
      { id: 'decay', name: 'Decay', min: 0.2, max: 30, log: true },
      { id: 'damp', name: 'Damp', min: 0, max: 1 },
      { id: 'predelay', name: 'Pre-delay', min: 0, max: 0.25 },
      { id: 'width', name: 'Width', min: 0, max: 1 },
      { id: 'size', name: 'Size', min: 0, max: 1 },
    ],
  };

// ---- the matrix's sources and targets ----------------------------------------------------------

const numbered = (name: string, n: number) => Array.from({ length: n }, (_, i) => `${name} ${i + 1}`);

/** The matrix's sources, by number (0: none). */
export const PRISM_MOD_SOURCES: readonly string[] = [
  'None',
  'Velocity',
  'Key',
  'Random',
  'Mod wheel',
  'Pressure',
  'Bend',
  'Gate',
  ...numbered('Macro', 6),
  ...numbered('Control', PRISM_CONTROLS),
  ...numbered('LFO', PRISM_LFOS),
  ...numbered('Env', PRISM_ENVS),
  ...numbered('Shape', PRISM_SHAPES),
  ...numbered('Steps', PRISM_SEQS),
];
export const SRC_VELOCITY = 1;
export const SRC_KEY = 2;
export const SRC_RANDOM = 3;
export const SRC_WHEEL = 4;
export const SRC_PRESSURE = 5;
export const SRC_BEND = 6;
export const SRC_GATE = 7;
export const SRC_MACRO = 8;
export const SRC_CONTROL = SRC_MACRO + 6;
export const SRC_LFO = SRC_CONTROL + PRISM_CONTROLS;
export const SRC_ENV = SRC_LFO + PRISM_LFOS;
export const SRC_SHAPE = SRC_ENV + PRISM_ENVS;
export const SRC_SEQ = SRC_SHAPE + PRISM_SHAPES;

/**
 * How a target takes modulation. `add`: links add to it, `depth` times its whole range (between
 * min and max, in octaves where it's `log`) and it's kept in range; `mul`: links scale it (a level).
 */
export interface PrismTarget {
  name: string;
  /** The source (0…3) it belongs to, -1 for the voice, the effects or a modulator. */
  source: number;
  kind: 'add' | 'mul';
  min: number;
  max: number;
  log?: boolean;
  unit?: string;
  /** Moved per note (a voice's), or once for everything (an effect's: the modulators there are shared). */
  shared?: boolean;
}

/** Each source's targets, in order (the source's targets are source × this many, from 0). */
export const PRISM_SOURCE_TARGETS: readonly Omit<PrismTarget, 'source'>[] = [
  { name: 'Level', kind: 'mul', min: 0, max: 1 },
  { name: 'Pan', kind: 'add', min: -1, max: 1 },
  { name: 'Pitch', kind: 'add', min: -48, max: 48, unit: 'st' },
  { name: 'Position', kind: 'add', min: 0, max: 1 },
  { name: 'Speed', kind: 'add', min: 0, max: 4 },
  { name: 'Count', kind: 'add', min: 1, max: 128 },
  { name: 'Amp spread', kind: 'add', min: 0, max: 1 },
  { name: 'Pitch spread', kind: 'add', min: 0, max: 1 },
  { name: 'Pan spread', kind: 'add', min: 0, max: 1 },
  { name: 'Symmetry', kind: 'add', min: 0, max: 1 },
  { name: 'Detune', kind: 'add', min: 0, max: 100, unit: 'ct' },
  { name: 'Grain size', kind: 'add', min: 0.005, max: 0.5, log: true, unit: 's' },
  { name: 'Density', kind: 'add', min: 1, max: 16 },
  { name: 'Jitter', kind: 'add', min: 0, max: 1 },
  { name: 'Cutoff', kind: 'add', min: 8.18, max: 21096, log: true, unit: 'Hz' },
  { name: 'Resonance', kind: 'add', min: 0, max: 1 },
];
export const PER_SOURCE = PRISM_SOURCE_TARGETS.length;

const VOICE_TARGETS: Omit<PrismTarget, 'source'>[] = [
  { name: 'Filter 1 cutoff', kind: 'add', min: 8.18, max: 21096, log: true, unit: 'Hz' },
  { name: 'Filter 1 resonance', kind: 'add', min: 0, max: 1 },
  { name: 'Filter 1 drive', kind: 'add', min: 0, max: 1 },
  { name: 'Filter 2 cutoff', kind: 'add', min: 8.18, max: 21096, log: true, unit: 'Hz' },
  { name: 'Filter 2 resonance', kind: 'add', min: 0, max: 1 },
  { name: 'Filter 2 drive', kind: 'add', min: 0, max: 1 },
  { name: 'Level', kind: 'mul', min: 0, max: 1 },
  { name: 'Pan', kind: 'add', min: -1, max: 1 },
  { name: 'Pitch', kind: 'add', min: -48, max: 48, unit: 'st' },
  { name: 'Morph X', kind: 'add', min: 0, max: 1 },
  { name: 'Morph Y', kind: 'add', min: 0, max: 1 },
  ...Array.from({ length: PRISM_LFOS }, (_, i) => ({
    name: `LFO ${i + 1} rate`,
    kind: 'add' as const,
    min: -10,
    max: 10,
    unit: 'oct',
  })),
  ...Array.from({ length: PRISM_ENVS }, (_, i) =>
    ['attack', 'decay', 'release'].map((stage) => ({
      name: `Env ${i + 1} ${stage}`,
      kind: 'add' as const,
      min: -5,
      max: 5,
      unit: 'oct',
    })),
  ).flat(),
];

/** Where the voice's targets start: after the sources'. */
export const TGT_VOICE = PRISM_SOURCES * PER_SOURCE;
export const TGT_F1_CUTOFF = TGT_VOICE;
export const TGT_F1_RES = TGT_VOICE + 1;
export const TGT_F1_DRIVE = TGT_VOICE + 2;
export const TGT_F2_CUTOFF = TGT_VOICE + 3;
export const TGT_F2_RES = TGT_VOICE + 4;
export const TGT_F2_DRIVE = TGT_VOICE + 5;
export const TGT_LEVEL = TGT_VOICE + 6;
export const TGT_PAN = TGT_VOICE + 7;
export const TGT_PITCH = TGT_VOICE + 8;
export const TGT_X = TGT_VOICE + 9;
export const TGT_Y = TGT_VOICE + 10;
export const TGT_LFO_RATE = TGT_VOICE + 11;
/** Each envelope's attack, decay and release times, in octaves (three per envelope). */
export const TGT_ENV_TIME = TGT_LFO_RATE + PRISM_LFOS;
/** Where the effects' targets start: five per slot (its mix, then its first four settings). */
export const TGT_FX = TGT_VOICE + VOICE_TARGETS.length;
export const PER_FX = 5;

/** Every target, by number. */
export const PRISM_MOD_TARGETS: readonly PrismTarget[] = [
  ...Array.from({ length: PRISM_SOURCES }, (_, s) =>
    PRISM_SOURCE_TARGETS.map((t) => ({ ...t, name: `Source ${s + 1} ${t.name.toLowerCase()}`, source: s })),
  ).flat(),
  ...VOICE_TARGETS.map((t) => ({ ...t, source: -1 })),
  ...Array.from({ length: PRISM_FX }, (_, k) => [
    { name: `Effect ${k + 1} mix`, kind: 'add' as const, min: 0, max: 1, source: -1, shared: true },
    ...[0, 1, 2, 3].map((j) => ({
      name: `Effect ${k + 1} setting ${j + 1}`,
      kind: 'add' as const,
      min: 0,
      max: 1,
      source: -1,
      shared: true,
    })),
  ]).flat(),
];

/** Target `n`'s name, with an effect's settings named for the effect in its slot (`fxTypes`: each slot's type). */
export function prismTargetName(n: number, fxTypes?: readonly number[]): string {
  const t = PRISM_MOD_TARGETS[n];
  if (!t) return '';
  if (n >= TGT_FX && fxTypes) {
    const k = Math.floor((n - TGT_FX) / PER_FX);
    const j = (n - TGT_FX) % PER_FX;
    const type = fxTypes[k] ?? 0;
    const effect = PRISM_EFFECTS[type] ?? 'Effect';
    if (j === 0) return `${effect} ${k + 1} mix`;
    const p = PRISM_FX_PARAMS[type]?.[j - 1];
    return p ? `${effect} ${k + 1} ${p.name.toLowerCase()}` : t.name;
  }
  return t.name;
}

// ---- keys ----------------------------------------------------------------------------------------

/** What a patch key sets: its part, which one (`index`), its field, a point or step (`sub`) and its range. */
export interface PrismKey {
  part:
    | 'patch'
    | 'src'
    | 'xy'
    | 'flt'
    | 'amp'
    | 'voice'
    | 'lfo'
    | 'env'
    | 'shape'
    | 'seq'
    | 'curve'
    | 'ctl'
    | 'mod'
    | 'fx'
    | 'wave'
    | 'lshape';
  /** The source, filter, modulator, curve, link, effect slot or waveform (from 0); 0 where there's one. */
  index: number;
  field: string;
  /** A point (a shape's, a curve's, a waveform's) or a step; -1 where there is none. */
  sub: number;
  min: number;
  max: number;
}

type Range = [number, number];

const SRC: Record<string, Range> = {
  on: [0, 1],
  kind: [0, PRISM_KINDS.length - 1],
  level: [0, 4],
  power: [0.25, 4],
  pan: [-1, 1],
  coarse: [-48, 48],
  fine: [-100, 100],
  keytrack: [0, 1],
  route: [0, 1],
  stereo: [0, 1],
  ftype: [0, PRISM_FILTERS.length],
  cutoff: [20, 20000],
  res: [0, 1],
  wave: [0, PRISM_WAVES.length - 1],
  custom: [0, PRISM_CUSTOM_WAVES],
  count: [1, PRISM_MAX_OSCS],
  ampa: [0, PRISM_AMP_SPREADS.length - 1],
  ampb: [0, PRISM_AMP_SPREADS.length - 1],
  amp: [0, 1],
  pitcha: [0, PRISM_PITCH_SPREADS.length - 1],
  pitchb: [0, PRISM_PITCH_SPREADS.length - 1],
  pitch: [0, 1],
  pana: [0, PRISM_PAN_SPREADS.length - 1],
  panb: [0, PRISM_PAN_SPREADS.length - 1],
  panmix: [0, 1],
  width: [0, 1],
  detune: [0, 100],
  sym: [0, 1],
  phase: [0, 1],
  free: [0, 1],
  data: [0, Math.max(PRISM_PARTIAL_SETS.length, PRISM_SAMPLES.length)],
  pos: [0, 1],
  speed: [0, 4],
  loop: [0, PRISM_LOOPS.length - 1],
  start: [0, 1],
  end: [0, 1],
  partials: [1, PRISM_MAX_PARTIALS],
  size: [0.005, 0.5],
  density: [1, 16],
  jitter: [0, 1],
  spray: [0, 1],
};
const FLT: Record<string, Range> = {
  on: [0, 1],
  type: [0, PRISM_FILTERS.length - 1],
  cutoff: [20, 20000],
  res: [0, 1],
  drive: [0, 1],
};
const LFO: Record<string, Range> = {
  shape: [0, PRISM_LFO_SHAPES.length - 1],
  custom: [0, PRISM_CUSTOM_WAVES],
  rate: [0.01, 50],
  sync: [0, 1],
  beats: [1 / 32, 128],
  bipolar: [0, 1],
  delay: [0, 20],
  fade: [0, 20],
  phase: [0, 1],
  mode: [0, PRISM_LFO_MODES.length - 1],
};
const ENV: Record<string, Range> = {
  a: [0, 60],
  h: [0, 60],
  d: [0, 60],
  s: [0, 1],
  r: [0, 60],
  ac: [-1, 1],
  dc: [-1, 1],
  rc: [-1, 1],
};
const SHAPE: Record<string, Range> = {
  n: [2, PRISM_POINTS],
  loop: [0, PRISM_SHAPE_LOOPS.length - 1],
  ls: [0, PRISM_POINTS - 1],
  le: [0, PRISM_POINTS - 1],
  sync: [0, 1],
};
const POINT: Record<string, Range> = { x: [0, 64], y: [0, 1], c: [-1, 1] };
const CURVE_POINT: Record<string, Range> = { x: [0, 1], y: [0, 1], c: [-1, 1] };
const SEQ: Record<string, Range> = {
  steps: [1, PRISM_STEPS],
  beats: [1 / 32, 16],
  swing: [0, 1],
  attack: [0, 1],
  gate: [0, 1],
  release: [0, 1],
};
const STEP: Record<string, Range> = { v: [0, 1], t: [0, 1] };
const MOD: Record<string, Range> = {
  src: [0, PRISM_MOD_SOURCES.length - 1],
  dst: [0, PRISM_MOD_TARGETS.length - 1],
  depth: [-1, 1],
  curve: [0, PRISM_CURVES],
  via: [0, PRISM_MOD_SOURCES.length - 1],
  viadepth: [-1, 1],
  viacurve: [0, PRISM_CURVES],
};
const FX: Record<string, Range> = {
  type: [0, PRISM_EFFECTS.length - 1],
  mix: [0, 1],
  // every effect's settings share the slot's keys (each type reads its own)
  time: [0.001, 8],
  timer: [0, 8],
  sync: [0, 1],
  feedback: [-0.98, 0.98],
  cross: [0, 1],
  lowcut: [20, 5000],
  highcut: [200, 20000],
  delay: [0.1, 30],
  depth: [0, 10],
  rate: [0.01, 10],
  width: [0, 1],
  drive: [0, 1],
  tube: [0, 1],
  crush: [0, 1],
  output: [0, 2],
  low: [20, 20000],
  high: [20, 20000],
  lowres: [0, 1],
  highres: [0, 1],
  reject: [0, 1],
  amount: [0, 1],
  release: [0.01, 2],
  size: [0, 1],
  decay: [0.2, 30],
  predelay: [0, 0.25],
  damp: [0, 1],
};
const PLAIN: Record<string, Record<string, Range>> = {
  patch: { blank: [0, 1] },
  xy: { on: [0, 1], x: [0, 1], y: [0, 1], power: [0, 1] },
  f: { serial: [0, 1] },
  amp: { level: [0, 4], pan: [-1, 1], volume: [-24, 24], power: [0.25, 4] },
  voice: {
    poly: [1, 32],
    mono: [0, 1],
    legato: [0, 1],
    glide: [0, 10],
    glidemode: [0, 1],
    bend: [0, 24],
    transpose: [-48, 48],
    tune: [-100, 100],
  },
};

const make = (part: PrismKey['part'], index: number, field: string, sub: number, r: Range | undefined) =>
  r ? { part, index, field, sub, min: r[0], max: r[1] } : null;

/** A field with a number on its end ("x3", "v12"): the name and the number. */
function pointed(field: string): [string, number] | null {
  const m = /^([a-z]+)(\d{1,2})$/.exec(field);
  return m ? [m[1] as string, Number(m[2])] : null;
}

/** The Prism patch key `id` (see the top of this file), or null when it isn't one. */
export function prismKey(id: string): PrismKey | null {
  const ctl = /^ctl(\d{1,2})$/.exec(id);
  if (ctl) {
    const n = Number(ctl[1]);
    return n >= 1 && n <= PRISM_CONTROLS ? make('ctl', n - 1, 'value', -1, [0, 1]) : null;
  }
  const colon = id.indexOf(':');
  if (colon < 0) return null;
  const head = id.slice(0, colon);
  const field = id.slice(colon + 1);
  const m = /^([a-z]+)(\d{1,2})$/.exec(head);
  if (!m) {
    const plain = PLAIN[head];
    if (!plain) return null;
    return make(head === 'f' ? 'flt' : (head as PrismKey['part']), head === 'f' ? -1 : 0, field, -1, plain[field]);
  }
  const name = m[1] as string;
  const n = Number(m[2]);
  const within = (count: number) => n >= 1 && n <= count;
  switch (name) {
    case 's':
      return within(PRISM_SOURCES) ? make('src', n - 1, field, -1, SRC[field]) : null;
    case 'f':
      return within(2) ? make('flt', n - 1, field, -1, FLT[field]) : null;
    case 'lfo':
      return within(PRISM_LFOS) ? make('lfo', n - 1, field, -1, LFO[field]) : null;
    case 'env':
      return within(PRISM_ENVS) ? make('env', n - 1, field, -1, ENV[field]) : null;
    case 'shape':
    case 'curve': {
      if (!within(name === 'shape' ? PRISM_SHAPES : PRISM_CURVES)) return null;
      if (name === 'shape' && SHAPE[field]) return make('shape', n - 1, field, -1, SHAPE[field]);
      if (name === 'curve' && field === 'n') return make('curve', n - 1, field, -1, SHAPE.n);
      const p = pointed(field);
      if (!p || p[1] >= PRISM_POINTS) return null;
      return make(name, n - 1, p[0], p[1], (name === 'shape' ? POINT : CURVE_POINT)[p[0]]);
    }
    case 'seq': {
      if (!within(PRISM_SEQS)) return null;
      if (SEQ[field]) return make('seq', n - 1, field, -1, SEQ[field]);
      const p = pointed(field);
      return p && p[1] < PRISM_STEPS ? make('seq', n - 1, p[0], p[1], STEP[p[0]]) : null;
    }
    case 'mod':
      return within(PRISM_LINKS) ? make('mod', n - 1, field, -1, MOD[field]) : null;
    case 'fx':
      return within(PRISM_FX) ? make('fx', n - 1, field, -1, FX[field]) : null;
    case 'w':
      return within(PRISM_CUSTOM_WAVES) && /^\d{1,4}$/.test(field) && Number(field) < PRISM_CUSTOM_POINTS
        ? make('wave', n - 1, 'point', Number(field), [-1, 1])
        : null;
    case 'l':
      return within(PRISM_CUSTOM_WAVES) && /^\d{1,2}$/.test(field) && Number(field) < PRISM_LFO_POINTS
        ? make('lshape', n - 1, 'point', Number(field), [-1, 1])
        : null;
    default:
      return null;
  }
}

/** The six knobs' ids: each a source in the matrix (Macro 1…6), 0…1. */
export const PRISM_MACRO_IDS = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
