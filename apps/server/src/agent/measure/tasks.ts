/**
 * The measurements, as the measuring child runs them (child.ts; the tests call them straight): a take's
 * notes from its files, a recording's notes to edit, the mix rendered, each track rendered on its own,
 * a plugin's response or what it does to its track's sound, a file's loudness. Each answers plain
 * numbers (the agent's tool says them in words), and says how far it has got as it goes.
 *
 * A recording's notes are found as the studio's Notes view finds them (notes.ts), and a take whose
 * notes are edited is measured as it plays, its patches in place.
 *
 * Renders are the engine's (renderSession), unmastered (`finish: false`), from two bars before where
 * the measurement starts so reverbs and compressors have settled; those bars aren't measured. What
 * plays a HO[LO] Pack that isn't installed here (an instrument, a Drum Replacer's kit, a Space
 * Designer's response) is silent in the studio, so it's silent in the measurement too, and the
 * answer says so (`unplayable`).
 */
import {
  buildSampler,
  clipKey,
  compileTempo,
  frameToTick,
  insertKit,
  loadClipAudio,
  loadImpulse,
  type PreparedImpulse,
  pluginImpulses,
  prepareImpulse,
  type RenderSource,
  renderSession,
  type SamplerSpec,
  tickToFrame,
} from '@holo/engine';
import {
  bandLevels,
  bandResponse,
  type EffectHost,
  effectResponse,
  LoudnessMeter,
  type LoudnessReport,
  type MaskingBand,
  masking,
  measureRecording,
  measureRendered,
  measureTake,
  monoOf,
  spectralTilt,
  type TakeReport,
  takePieces,
  throughEffect,
} from '@holo/engine/analysis';
import {
  type AudioNotes,
  type AudioNotesMode,
  bpmAt,
  type Channel,
  type KeyPoint,
  meterAt,
  PLUGINS,
  type Plugin,
  PPQ,
  type Project,
  projectEnd,
  type Track,
  ticksPerBar,
  tickToSeconds,
} from '@holo/session';
import { findNotes, type NoteShape, playedTake } from './notes.ts';
import { decodeFile, type MeasureSource, measureSource } from './source.ts';
import { takeSpan } from './span.ts';

// ---- what the child is asked, and what it answers ----

export type ChildInput =
  | {
      kind: 'take';
      dataDir: string;
      project: Project;
      track: string;
      region?: string;
      from?: number;
      to?: number;
      /** "key", "none", or a reference track's id. */
      against: string;
      grid: number;
      /** "effects": as it comes out of the track's plugins (rendered), not its recordings as they are. */
      through?: 'effects';
    }
  | { kind: 'recording'; path: string; name: string; key: KeyPoint | null; against: 'key' | 'none' }
  | { kind: 'mix'; dataDir: string; project: Project; from?: number; to?: number }
  | { kind: 'file'; path: string; source: 'bounce' | 'file'; name: string; project?: Project }
  | { kind: 'tracks'; dataDir: string; project: Project; tracks: string[]; from?: number; to?: number }
  | { kind: 'plugin'; dataDir: string; project: Project; channel: string; plugin: string; from?: number; to?: number }
  /** A song's recording (`file`, of the song `project`), its notes found to edit. */
  | { kind: 'notes'; dataDir: string; project: string; file: string; name: string };

/** How far a measurement has got (0–1), and what it's doing. */
export type Progress = (fraction: number, stage: string) => void;

/** What of the song plays a HO[LO] Pack that isn't installed here, left silent in a measurement. */
export interface Unplayable {
  /** Tracks whose instrument (or an articulation's) is in a pack that isn't here. */
  tracks: { id: string; name: string; pack: string }[];
  /** Plugins whose kit or response is in a pack that isn't here: left out. */
  plugins: { id: string; name: string; channel: string; pack: string }[];
}

export interface TakeResult extends TakeReport {
  kind: 'take';
  /** The track (null: a recording that isn't on one), and its name or the file's. */
  track: string | null;
  name: string;
  /** Measured as it comes out of the track's plugins (rendered): which they were, in order. */
  through?: { plugins: { id: string; name: string; bypass: boolean }[]; errors: string[] };
  unplayable?: Unplayable;
}

/** A stretch of the mix: a marker's section, some bars, or some seconds. */
export interface Section {
  name: string | null;
  tick: number | null;
  end: number | null;
  /** Seconds from where the measurement starts, and how long. */
  at: number;
  length: number;
  lufs: number | null;
  shortTermMax: number | null;
}

export interface MixResult {
  kind: 'mix';
  source: 'render' | 'bounce' | 'file';
  /** The bounce's or the file's name. */
  name?: string;
  tick: number | null;
  end: number | null;
  loudness: LoudnessReport;
  sections: Section[];
  /** Octave bands (OCTAVE_BANDS), dB of mean power. */
  octaves: (number | null)[];
  /** dB per octave (0 is pink noise). */
  tilt: number | null;
  /** What the render reported. */
  errors: string[];
  /** What plays a pack that isn't installed here, silent in the render. */
  unplayable?: Unplayable;
}

export interface TrackLevel {
  id: string;
  name: string;
  /** Where it goes in the mix (the master, or a bus's name). */
  output: string;
  muted: boolean;
  /** Nothing plays on it in the range: not rendered. */
  silent: boolean;
  lufs: number | null;
  peak: number | null;
  truePeak: number | null;
  octaves: (number | null)[];
  /** Third-octave bands, when one track is measured. */
  thirds?: (number | null)[];
  /** An audio track's recordings as they are (their gain in), before its plugins and fader. */
  source?: { lufs: number | null; peak: number | null } | null;
  /** It plays this pack, which isn't installed here: silent, not rendered. */
  missing?: string;
}

export interface TracksResult {
  kind: 'tracks';
  tick: number;
  end: number;
  tracks: TrackLevel[];
  /** Two tracks measured together: where they compete. */
  masking: { a: string; b: string; bands: MaskingBand[] } | null;
  errors: string[];
  unplayable?: Unplayable;
}

export interface PluginResult {
  kind: 'plugin';
  /** A track's id, a bus's, or "master". */
  channel: string;
  plugin: { id: string; type: string; name: string; bypass: boolean };
  /** "response": an impulse through it (a filter, a reverb, a delay); "signal": the track's own sound through it. */
  method: 'response' | 'signal';
  response?: {
    /** Gain in third-octave bands (dB). */
    thirds: (number | null)[];
    /** Frames it delays the sound by. */
    latency: number;
    /** A reverb's decay (RT60, s) and its pre-delay (ms). */
    decay?: number | null;
    predelay?: number | null;
    /** A delay's first echoes: [ms, dB]. */
    echoes?: [number, number][];
  };
  signal?: {
    tick: number;
    end: number;
    in: { lufs: number | null; peak: number | null };
    out: { lufs: number | null; peak: number | null };
    octavesIn: (number | null)[];
    octavesOut: (number | null)[];
    /** Gain reduction while the track plays: the share of the time it's over 0.5 dB, and how deep (dB). */
    gr: { active: number; median: number; p90: number; max: number } | null;
  };
  errors: string[];
  unplayable?: Unplayable;
}

/** A recording's notes as the studio's Notes view finds them, to edit (notes.ts). */
export interface NotesResult {
  kind: 'notes';
  /** The song's file, and its name. */
  file: string;
  name: string;
  /** How long it is (s). */
  seconds: number;
  notes: AudioNotes;
  /** Each note's drift and vibrato as sung, by its index (null for a note with no pitch). */
  shapes: (NoteShape | null)[];
  /** What kind of recording it looks like (the notes are found as one line's for now). */
  looks: AudioNotesMode;
}

export type MeasureResult = TakeResult | MixResult | TracksResult | PluginResult | NotesResult;

// ---- helpers ----

const r1 = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const dbOf = (amp: number) => (amp > 0 ? r1(20 * Math.log10(amp)) : null);
const BLOCK = 128;

/** The plugins measured by their response to an impulse: what they do is the same at any level. */
const LINEAR = new Set(['eq', 'peq', 'reverb', 'space', 'delay', 'width']);
/** The plugins whose gain reduction is measured. */
const DYNAMICS = new Set(['compressor', 'gate', 'limiter', 'softener']);

/** A rendered stretch of a song: its channels from where the pre-roll begins, and how many frames that is. */
interface Rendered {
  channels: Float32Array[];
  sr: number;
  skip: number;
  /** Ticks measured, and where the render begins (the pre-roll's start). */
  from: number;
  to: number;
  start: number;
  errors: string[];
}

/**
 * What of a song plays a pack that isn't installed here, asked of the source a render reads (an
 * instrument it can't find, a kit or a response it can't read): each pack's instrument is asked once.
 */
export async function unplayable(project: Project, source: RenderSource): Promise<Unplayable> {
  const known = new Map<string, boolean>();
  const here = async (key: string, look: () => Promise<unknown>): Promise<boolean> => {
    let ok = known.get(key);
    if (ok === undefined) {
      ok = await look().then(
        () => true,
        () => false,
      );
      known.set(key, ok);
    }
    return ok;
  };
  const instrumentHere = (pack: string, name: string) => here(`i:${pack}/${name}`, () => source.instrument(pack, name));
  const out: Unplayable = { tracks: [], plugins: [] };
  for (const t of project.tracks) {
    for (const i of [t.instrument, ...t.articulations.map((a) => a.instrument)]) {
      if ((i.type === 'sampler' || i.type === 'performance') && !(await instrumentHere(i.pack, i.name))) {
        out.tracks.push({ id: t.id, name: t.name, pack: i.pack });
        break;
      }
    }
  }
  const sr = project.sampleRate ?? 48000;
  const channels: [string, Channel][] = [
    ['master', project.master],
    ...project.buses.map((b): [string, Channel] => [b.id, b.channel]),
    ...project.tracks.map((t): [string, Channel] => [t.id, t.channel]),
  ];
  for (const [channel, c] of channels) {
    for (const p of c.inserts) {
      const name = PLUGINS.find((d) => d.type === p.type)?.name ?? p.type;
      const kit = insertKit(p);
      const [kitPack = '', ...kitName] = (kit ?? '').split('/');
      let pack: string | null = kit && !(await instrumentHere(kitPack, kitName.join('/'))) ? kitPack : null;
      for (const want of pluginImpulses(p.type, p.params, p.settings, sr)) {
        if (pack || want.source.kind !== 'file') continue;
        const { pack: from, name: response } = want.source;
        if (!(await here(`r:${from}/${response}`, () => source.impulse(from, response)))) pack = from;
      }
      if (pack) out.plugins.push({ id: p.id, name, channel, pack });
    }
  }
  return out;
}

/**
 * The song as the studio plays it with those packs missing: their tracks silent (muted, with no
 * instrument to load) and their plugins left out, with their automation. The song itself is untouched.
 */
export function withoutUnplayable(project: Project, u: Unplayable): Project {
  if (!u.tracks.length && !u.plugins.length) return project;
  const p = structuredClone(project);
  const silent = new Set(u.tracks.map((m) => m.id));
  for (const t of p.tracks) {
    if (!silent.has(t.id)) continue;
    t.instrument = { type: 'none' };
    t.articulations = t.articulations.map((a) => ({ ...a, instrument: { type: 'none' } }));
    t.channel.mute = true;
  }
  const gone = new Set(u.plugins.map((m) => m.id));
  for (const c of [p.master, ...p.buses.map((b) => b.channel), ...p.tracks.map((t) => t.channel)]) {
    if (!c.inserts.some((x) => gone.has(x.id))) continue;
    c.inserts = c.inserts.filter((x) => !gone.has(x.id));
    c.automation = (c.automation ?? []).filter(
      (a) => !(a.param.startsWith('fx:') && gone.has(a.param.split(':')[1] ?? '')),
    );
  }
  return p;
}

/** Said with a result when something it rendered was silent for want of a pack (only `channels`', if given). */
function unplayableOf(u: Unplayable, channels?: readonly string[]): { unplayable?: Unplayable } {
  const kept = channels
    ? {
        tracks: u.tracks.filter((m) => channels.includes(m.id)),
        plugins: u.plugins.filter((m) => channels.includes(m.channel)),
      }
    : u;
  return kept.tracks.length || kept.plugins.length ? { unplayable: kept } : {};
}

/** Where a measurement starts and ends (ticks), and where its render begins: two bars before. */
export function renderRange(project: Project, from?: number, to?: number): { start: number; from: number; to: number } {
  const a = Math.max(0, from ?? 0);
  const b = to ?? projectEnd(project);
  let start = a;
  for (let k = 0; k < 2 && start > 0; k++) start = Math.max(0, start - ticksPerBar(meterAt(project.meter, start - 1)));
  return { start, from: a, to: Math.max(a + 1, b) };
}

/** The song rendered (unmastered, as it plays), `from`–`to` and its pre-roll; progress from `lo` to `hi`. */
async function render(
  project: Project,
  source: MeasureSource,
  range: { from?: number; to?: number },
  progress: Progress,
  lo = 0,
  hi = 1,
  label = '',
): Promise<Rendered> {
  const sr = project.sampleRate ?? 48000;
  const { start, from, to } = renderRange(project, range.from, range.to);
  const said = (fraction: number, text: string) => progress(lo + (hi - lo) * fraction, `${label}${text}`);
  const out = await renderSession(project, source, {
    sampleRate: sr,
    from: start,
    to,
    tail: range.to === undefined ? 2 : 0,
    finish: false,
    loop: false,
    onProgress: (text) => {
      const pct = /(\d+)%/.exec(text);
      said(pct ? 0.1 + 0.88 * (Number(pct[1]) / 100) : 0.05, text);
    },
  });
  const skip = Math.round((tickToSeconds(project.tempo, from) - tickToSeconds(project.tempo, start)) * sr);
  return { channels: out.channels, sr, skip, from, to, start, errors: out.errors.slice(0, 5) };
}

const after = (channels: Float32Array[], skip: number) => channels.map((c) => c.subarray(Math.min(skip, c.length)));

/**
 * The stretches a mix is reported in: its markers' sections, else every 8 bars (16 past 128 bars); by
 * the clock (every 30 s) when the song's form repeats bars, or it isn't on the timeline.
 */
function sections(
  project: Project | null,
  from: number,
  to: number,
  seconds: number,
): Omit<Section, 'lufs' | 'shortTermMax'>[] {
  const out: Omit<Section, 'lufs' | 'shortTermMax'>[] = [];
  if (!project || project.form?.length) {
    for (let at = 0; at < seconds - 1; at += 30)
      out.push({ name: null, tick: null, end: null, at, length: Math.min(30, seconds - at) });
    return out;
  }
  const sec = (tick: number) => tickToSeconds(project.tempo, tick) - tickToSeconds(project.tempo, from);
  const push = (name: string | null, a: number, b: number) => {
    if (b > a) out.push({ name, tick: a, end: b, at: r1(sec(a)) ?? 0, length: r1(sec(b) - sec(a)) ?? 0 });
  };
  const marks = project.markers.filter((m) => m.tick > from && m.tick < to).sort((x, y) => x.tick - y.tick);
  const before = [...project.markers]
    .filter((m) => m.tick <= from)
    .sort((x, y) => x.tick - y.tick)
    .at(-1);
  if (marks.length || before) {
    let a = from;
    let name: string | null = before?.name ?? null;
    for (const m of marks) {
      push(name, a, m.tick);
      a = m.tick;
      name = m.name;
    }
    push(name, a, to);
    return out;
  }
  let bars = 0;
  for (let t = from; t < to; ) {
    bars++;
    t += ticksPerBar(meterAt(project.meter, t));
  }
  const per = bars > 128 ? 16 : 8;
  let a = from;
  while (a < to) {
    let b = a;
    for (let k = 0; k < per && b < to; k++) b += ticksPerBar(meterAt(project.meter, b));
    push(null, a, Math.min(b, to));
    a = b;
  }
  return out;
}

/** A recording's loudness, its sections' and its bands, as the mix's answer. */
function mixOf(
  channels: Float32Array[],
  sr: number,
  project: Project | null,
  from: number,
  to: number,
): Pick<MixResult, 'loudness' | 'sections' | 'octaves' | 'tilt'> {
  const meter = new LoudnessMeter(channels, sr);
  const parts = sections(project, from, to, meter.seconds).map((s) => ({
    ...s,
    lufs: r1(meter.integrated(s.at, s.at + s.length)),
    shortTermMax: r1(meter.maxima(s.at, s.at + s.length).shortTerm),
  }));
  return {
    loudness: meter.report(),
    sections: parts.slice(0, 24),
    octaves: bandLevels(channels, sr, 'octave'),
    tilt: spectralTilt(bandLevels(channels, sr, 'third')),
  };
}

/** Whether anything plays on a track from `from` to `to`. */
function plays(track: Track, from: number, to: number): boolean {
  return track.regions.some(
    (r) =>
      !r.muted &&
      r.start < to &&
      r.start + r.length > from &&
      (track.kind === 'audio' ? !!r.audio : r.notes.some((n) => r.start + n.t < to && r.start + n.t + n.d > from)),
  );
}

/** The master as nothing: no plugins, no fader, no automation. */
const plainMaster = (c: Channel): Channel => ({
  ...c,
  volume: 0,
  pan: 0,
  mute: false,
  solo: false,
  inserts: [],
  sends: [],
  automation: [],
});

/**
 * A track alone, as it reaches the master: only it, its sends gone, out to the master, and the master
 * with nothing on it; unmuted. With `before`, only its plugins before that one, and its fader, pan and
 * stage left out (the sound that plugin hears).
 */
export function soloCopy(project: Project, trackId: string, before?: string): Project {
  const p = structuredClone(project);
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) throw new Error(`No track ${trackId}`);
  const c = t.channel;
  c.sends = [];
  c.output = 'master';
  c.solo = false;
  c.mute = false;
  if (c.stage) {
    c.stage.near.sends = [];
    c.stage.far.sends = [];
  }
  c.automation = (c.automation ?? []).filter((a) => !a.param.startsWith('send:'));
  if (before !== undefined) {
    const at = c.inserts.findIndex((x) => x.id === before);
    c.inserts = at >= 0 ? c.inserts.slice(0, at) : c.inserts;
    const kept = new Set(c.inserts.map((x) => x.id));
    c.volume = 0;
    c.pan = 0;
    delete c.stage;
    c.automation = c.automation.filter((a) => a.param.startsWith('fx:') && kept.has(a.param.split(':')[1] ?? ''));
  }
  p.tracks = [t];
  p.buses = [];
  p.master = plainMaster(p.master);
  delete p.finish;
  delete p.loop;
  return p;
}

/** What a plugin can reach while it runs here: the song's tempo, its responses, a wow's curve, a replacer's kit. */
async function hostFor(
  p: Plugin,
  project: Project,
  source: MeasureSource,
  sr: number,
): Promise<{ host: EffectHost; at: (frame: number) => void }> {
  const impulses = new Map<string, PreparedImpulse>();
  for (const want of pluginImpulses(p.type, p.params, p.settings, sr))
    impulses.set(want.key, prepareImpulse(await loadImpulse(source, want.source, sr)));
  const clips = new Map<string, Float32Array[]>();
  const curve = p.type === 'wow' ? p.settings?.curve : undefined;
  if (curve)
    clips.set(clipKey({ file: curve, stretch: 1 }), await loadClipAudio(source, { file: curve, stretch: 1 }, sr));
  const samplers = new Map<string, SamplerSpec>();
  const kit = insertKit(p);
  if (kit) {
    const [pack = '', ...rest] = kit.split('/');
    samplers.set(kit, await buildSampler(source, pack, rest.join('/'), sr));
  }
  const seg = compileTempo(project, sr);
  let frame = 0;
  const host: EffectHost = {
    sr,
    impulse: (key) => impulses.get(key),
    lowLatency: false,
    beatSeconds: () => 60 / bpmAt(project.tempo, frameToTick(seg, frame)),
    songFrame: () => frame,
    loopRange: () => null,
    clip: (key) => clips.get(key),
    beatAt: () => frameToTick(seg, frame) / PPQ,
    sampler: (key) => samplers.get(key),
  };
  return {
    host,
    at: (f) => {
      frame = f;
    },
  };
}

/** A channel of the song by id: a track's, a bus's, or the master. */
function channelOf(project: Project, id: string): { channel: Channel; kind: 'track' | 'bus' | 'master' } | null {
  if (id === 'master') return { channel: project.master, kind: 'master' };
  const t = project.tracks.find((x) => x.id === id);
  if (t) return { channel: t.channel, kind: 'track' };
  const b = project.buses.find((x) => x.id === id);
  return b ? { channel: b.channel, kind: 'bus' } : null;
}

/** A reverb's decay from its response (Schroeder's backward integral, −5 to −25 dB, times three), and its pre-delay. */
function decayOf(
  l: Float32Array,
  r: Float32Array,
  start: number,
  sr: number,
): { decay: number | null; predelay: number | null } {
  const n = l.length;
  const e = new Float64Array(n);
  let top = 0;
  for (let i = start; i < n; i++) {
    e[i] = (l[i] as number) ** 2 + (r[i] as number) ** 2;
    top = Math.max(top, Math.sqrt(e[i] as number));
  }
  // the pre-delay: where the response (past its first millisecond, the dry sound) rises to a tenth of its loudest
  const from = start + Math.round(0.001 * sr);
  let wetTop = 0;
  for (let i = from; i < n; i++) wetTop = Math.max(wetTop, Math.sqrt(e[i] as number));
  let predelay: number | null = null;
  for (let i = from; i < n; i++)
    if (Math.sqrt(e[i] as number) >= 0.1 * wetTop) {
      predelay = r1(((i - start) / sr) * 1000);
      break;
    }
  const edc = new Float64Array(n + 1);
  for (let i = n - 1; i >= from; i--) edc[i] = (edc[i + 1] as number) + (e[i] as number);
  const total = edc[from] as number;
  if (!(total > 0)) return { decay: null, predelay };
  let t5 = -1;
  let t25 = -1;
  for (let i = from; i < n; i++) {
    const d = 10 * Math.log10(Math.max((edc[i] as number) / total, 1e-30));
    if (t5 < 0 && d <= -5) t5 = i;
    if (d <= -25) {
      t25 = i;
      break;
    }
  }
  return { decay: t5 >= 0 && t25 > t5 ? r1(((t25 - t5) / sr) * 3) : null, predelay };
}

/** A delay's echoes from its response: peaks past the dry sound, a tenth of the loudest or more, 20 ms apart. */
function echoesOf(l: Float32Array, r: Float32Array, start: number, sr: number, amplitude: number): [number, number][] {
  const env = (i: number) => Math.max(Math.abs(l[i] as number), Math.abs(r[i] as number));
  let top = 0;
  const from = start + Math.round(0.005 * sr);
  for (let i = from; i < l.length; i++) top = Math.max(top, env(i));
  const out: [number, number][] = [];
  const gap = Math.round(0.02 * sr);
  for (let i = from + 1; i + 1 < l.length && out.length < 4; i++) {
    const v = env(i);
    if (v < 0.1 * top || v < env(i - 1) || v < env(i + 1)) continue;
    let best = i;
    for (let j = i; j < Math.min(l.length, i + gap); j++) if (env(j) > env(best)) best = j;
    out.push([r1(((best - start) / sr) * 1000) ?? 0, dbOf(env(best) / amplitude) ?? -144]);
    i = best + gap;
  }
  return out;
}

// ---- the tasks ----

/**
 * A track alone through its plugins and nothing else: its solo copy without its fader, pan or stage
 * (the take as its effects leave it, at the level they leave it).
 */
export function effectsCopy(project: Project, trackId: string): Project {
  const p = soloCopy(project, trackId);
  const c = (p.tracks[0] as Track).channel;
  c.volume = 0;
  c.pan = 0;
  delete c.stage;
  c.automation = (c.automation ?? []).filter((a) => a.param.startsWith('fx:'));
  return p;
}

/**
 * A take as it comes out of its track's plugins (a Pitch Correction's result, an EQ's): the track
 * rendered alone through them (effectsCopy), over its regions' bars and two bars before, the plugins'
 * delay made up for as the mix makes it up, then measured note by note on the timeline as its
 * recordings are.
 */
async function takeThrough(
  input: Extract<ChildInput, { kind: 'take' }>,
  track: Track,
  against: 'key' | 'none' | Track,
  progress: Progress,
): Promise<TakeResult> {
  const { project } = input;
  const source = measureSource(input.dataDir, project.id);
  const span = takeSpan(track, input);
  const u = await unplayable(project, source);
  const copy = effectsCopy(withoutUnplayable(project, u), track.id);
  const r = await render(copy, source, span, progress, 0, 0.9, 'Through its effects: ');
  progress(0.92, 'Reading the take');
  const mono = monoOf(after(r.channels, r.skip));
  const report = measureRendered(project, track, mono, r.sr, tickToSeconds(project.tempo, r.from), {
    from: r.from,
    to: r.to,
    ...(input.region ? { region: input.region } : {}),
    against,
    grid: input.grid,
  });
  const plugins = (copy.tracks[0] as Track).channel.inserts.map((p) => ({
    id: p.id,
    name: PLUGINS.find((d) => d.type === p.type)?.name ?? p.type,
    bypass: p.bypass,
  }));
  return {
    kind: 'take',
    track: track.id,
    name: track.name,
    ...report,
    through: { plugins, errors: r.errors },
    ...unplayableOf(u, [track.id]),
  };
}

async function take(input: Extract<ChildInput, { kind: 'take' }>, progress: Progress): Promise<TakeResult> {
  const { project } = input;
  const track = project.tracks.find((t) => t.id === input.track);
  if (track?.kind !== 'audio') throw new Error('A take is measured on an audio track');
  const against =
    input.against === 'key' || input.against === 'none'
      ? input.against
      : (project.tracks.find((t) => t.id === input.against) ?? 'key');
  if (input.through === 'effects') return takeThrough(input, track, against, progress);
  const source = measureSource(input.dataDir, project.id);
  progress(0.1, 'Reading the take');
  // a region whose notes are edited is measured as it plays
  const played = await playedTake(project, track, source, input.region);
  const report = measureTake(played.project, played.track, played.decode, {
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
    ...(input.region ? { region: input.region } : {}),
    against,
    grid: input.grid,
  });
  return { kind: 'take', track: track.id, name: track.name, ...report };
}

async function mix(input: Extract<ChildInput, { kind: 'mix' }>, progress: Progress): Promise<MixResult> {
  const source = measureSource(input.dataDir, input.project.id);
  const range = {
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
  };
  const u = await unplayable(input.project, source);
  const r = await render(structuredClone(withoutUnplayable(input.project, u)), source, range, progress, 0, 0.95);
  progress(0.96, 'Measuring');
  return {
    kind: 'mix',
    source: 'render',
    tick: r.from,
    end: r.to,
    ...mixOf(after(r.channels, r.skip), r.sr, input.project, r.from, r.to),
    errors: r.errors,
    ...unplayableOf(u),
  };
}

async function file(input: Extract<ChildInput, { kind: 'file' }>, progress: Progress): Promise<MixResult> {
  progress(0.1, `Reading ${input.name}`);
  const d = decodeFile(input.path);
  progress(0.4, 'Measuring');
  // a bounce is the song from its start, as it plays (a loop's or a repeated form's isn't laid out by bars)
  const p = input.source === 'bounce' && input.project && !input.project.loop ? input.project : null;
  const end = p ? projectEnd(p) : 0;
  return {
    kind: 'mix',
    source: input.source,
    name: input.name,
    tick: p ? 0 : null,
    end: p ? end : null,
    ...mixOf(d.channels, d.rate, p, 0, end),
    errors: [],
  };
}

async function recording(input: Extract<ChildInput, { kind: 'recording' }>, progress: Progress): Promise<TakeResult> {
  progress(0.1, `Reading ${input.name}`);
  const d = decodeFile(input.path);
  return {
    kind: 'take',
    track: null,
    name: input.name,
    ...measureRecording(d.channels, d.rate, input.key, input.against),
  };
}

async function tracks(input: Extract<ChildInput, { kind: 'tracks' }>, progress: Progress): Promise<TracksResult> {
  const { project } = input;
  const source = measureSource(input.dataDir, project.id);
  const { from, to } = renderRange(project, input.from, input.to);
  const u = await unplayable(project, source);
  const playable = withoutUnplayable(project, u);
  const out: TrackLevel[] = [];
  const kept = new Map<string, { channels: Float32Array[]; sr: number }>();
  const errors: string[] = [];
  const n = input.tracks.length;
  for (let i = 0; i < n; i++) {
    const t = project.tracks.find((x) => x.id === input.tracks[i]);
    if (!t) continue;
    const bus = project.buses.find((b) => b.id === t.channel.output);
    const base = { id: t.id, name: t.name, output: bus ? bus.name : 'master', muted: t.channel.mute };
    // an audio track's recordings, as they are
    let src: TrackLevel['source'];
    if (t.kind === 'audio') {
      const pieces = takePieces(project, t, { from, to });
      const parts: Float32Array[] = [];
      let rate = 48000;
      for (const piece of pieces) {
        const d = source.decodeAudio(piece.file);
        if (!d) continue;
        rate = d.rate;
        const g = 10 ** (piece.gain / 20);
        const mono = monoOf(d.channels);
        const part = mono.slice(Math.round(piece.fileStart * d.rate), Math.round(piece.fileEnd * d.rate));
        for (let k = 0; k < part.length; k++) part[k] = (part[k] as number) * g;
        parts.push(part);
      }
      const all = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
      let at = 0;
      for (const p of parts) {
        all.set(p, at);
        at += p.length;
      }
      if (all.length) {
        const m = new LoudnessMeter([all], rate);
        src = { lufs: r1(m.integrated()), peak: dbOf(m.samplePeak) };
      } else src = null;
    }
    const missing = u.tracks.find((m) => m.id === t.id)?.pack;
    if (missing || !plays(t, from, to)) {
      out.push({
        ...base,
        silent: true,
        lufs: null,
        peak: null,
        truePeak: null,
        octaves: [],
        ...(src !== undefined ? { source: src } : {}),
        ...(missing ? { missing } : {}),
      });
      continue;
    }
    const r = await render(soloCopy(playable, t.id), source, { from, to }, progress, i / n, (i + 1) / n, `${t.name}: `);
    errors.push(...r.errors);
    const ch = after(r.channels, r.skip);
    const m = new LoudnessMeter(ch, r.sr);
    out.push({
      ...base,
      silent: false,
      lufs: r1(m.integrated()),
      peak: dbOf(m.samplePeak),
      truePeak: dbOf(m.truePeak),
      octaves: bandLevels(ch, r.sr, 'octave'),
      ...(n === 1 ? { thirds: bandLevels(ch, r.sr, 'third') } : {}),
      ...(src !== undefined ? { source: src } : {}),
    });
    if (n === 2) kept.set(t.id, { channels: ch, sr: r.sr });
  }
  let mask: TracksResult['masking'] = null;
  if (n === 2) {
    const [a, b] = input.tracks as [string, string];
    const x = kept.get(a);
    const y = kept.get(b);
    if (x && y) {
      progress(0.97, 'Comparing the two');
      mask = { a, b, bands: masking(x.channels, y.channels, x.sr).slice(0, 6) };
    }
  }
  return {
    kind: 'tracks',
    tick: from,
    end: to,
    tracks: out,
    masking: mask,
    errors: [...new Set(errors)].slice(0, 5),
    ...unplayableOf(u, input.tracks),
  };
}

async function plugin(input: Extract<ChildInput, { kind: 'plugin' }>, progress: Progress): Promise<PluginResult> {
  const { project } = input;
  const found = channelOf(project, input.channel);
  const p = found?.channel.inserts.find((x) => x.id === input.plugin);
  if (!found || !p) throw new Error('No such plugin there');
  const def = PLUGINS.find((d) => d.type === p.type);
  const base = {
    kind: 'plugin' as const,
    channel: input.channel,
    plugin: { id: p.id, type: p.type, name: def?.name ?? p.type, bypass: p.bypass },
    errors: [] as string[],
  };
  const source = measureSource(input.dataDir, project.id);
  const sr = project.sampleRate ?? 48000;
  const u = await unplayable(project, source);
  const itself = u.plugins.find((m) => m.id === p.id);
  if (itself)
    throw new Error(
      `The ${base.plugin.name} plays a sound from ${itself.pack}, a pack that isn't installed here: it's silent in the studio too, and can't be measured until the pack is installed`,
    );
  if (LINEAR.has(p.type)) {
    progress(0.2, 'Sending an impulse through it');
    const { host } = await hostFor(p, project, source, sr);
    const long = p.type === 'reverb' || p.type === 'space' || p.type === 'delay';
    const amplitude = 0.25;
    const ir = effectResponse(p.type, p.params, p.settings, host, Math.round(sr * (long ? 4 : 0.5)), amplitude);
    if (!ir) throw new Error(`${p.type} isn't a plugin HO[LO] plays`);
    const { left, right, latency } = ir;
    const response: NonNullable<PluginResult['response']> = {
      thirds: bandResponse([left, right], sr, amplitude),
      latency,
    };
    if (p.type === 'reverb' || p.type === 'space') Object.assign(response, decayOf(left, right, latency, sr));
    if (p.type === 'delay') response.echoes = echoesOf(left, right, latency, sr, amplitude);
    return { ...base, method: 'response', response };
  }
  if (found.kind === 'bus')
    throw new Error(
      `A ${def?.name ?? p.type} on a bus isn't measured on its sound yet: measure the tracks that feed the bus, or a plugin on a track or the master`,
    );
  const owner = u.tracks.find((m) => m.id === input.channel);
  if (owner)
    throw new Error(
      `${owner.name} plays ${owner.pack}, a pack that isn't installed here: it's silent in the studio too, so its ${base.plugin.name} has nothing to work on until the pack is installed`,
    );
  // the sound the plugin hears (what plays a missing pack silent), then through it
  const playable = withoutUnplayable(project, u);
  let copy: Project;
  if (found.kind === 'track') copy = soloCopy(playable, input.channel, p.id);
  else {
    copy = structuredClone(playable);
    const at = copy.master.inserts.findIndex((x) => x.id === p.id);
    copy.master.inserts = copy.master.inserts.slice(0, at);
    const kept = new Set(copy.master.inserts.map((x) => x.id));
    copy.master.volume = 0;
    copy.master.automation = (copy.master.automation ?? []).filter(
      (a) => a.param.startsWith('fx:') && kept.has(a.param.split(':')[1] ?? ''),
    );
    delete copy.finish;
    delete copy.loop;
  }
  const range = {
    ...(input.from !== undefined ? { from: input.from } : {}),
    ...(input.to !== undefined ? { to: input.to } : {}),
  };
  const rendered = await render(copy, source, range, progress, 0, 0.85);
  progress(0.88, `Running the ${base.plugin.name}`);
  const { host, at } = await hostFor(p, project, source, sr);
  const startFrame = Math.round(tickToFrame(compileTempo(project, sr), rendered.start));
  const through = throughEffect(p.type, p.params, p.settings, host, rendered.channels, (i) => at(startFrame + i));
  if (!through) throw new Error(`${p.type} isn't a plugin HO[LO] plays`);
  // its gain reduction while the track plays (above −60 dBFS), past the pre-roll
  const reductions: number[] = [];
  for (let b = 0; b < through.gr.length; b++)
    if (b * BLOCK >= rendered.skip && (through.peaks[b] as number) > 1e-3)
      reductions.push(Math.max(0, -(through.gr[b] as number)));
  const inside = after(rendered.channels, rendered.skip);
  const outside = after(through.output, rendered.skip);
  const mIn = new LoudnessMeter(inside, sr);
  const mOut = new LoudnessMeter(outside, sr);
  let gr: NonNullable<PluginResult['signal']>['gr'] = null;
  if (DYNAMICS.has(p.type) && reductions.length) {
    const active = reductions.filter((v) => v > 0.5).sort((x, y) => x - y);
    const share = (q: number) =>
      active.length ? (active[Math.min(active.length - 1, Math.floor(q * active.length))] as number) : 0;
    gr = {
      active: Math.round((active.length / reductions.length) * 100) / 100,
      median: r1(share(0.5)) ?? 0,
      p90: r1(share(0.9)) ?? 0,
      max: r1(active.length ? (active[active.length - 1] as number) : 0) ?? 0,
    };
  }
  return {
    ...base,
    method: 'signal',
    signal: {
      tick: rendered.from,
      end: rendered.to,
      in: { lufs: r1(mIn.integrated()), peak: dbOf(mIn.samplePeak) },
      out: { lufs: r1(mOut.integrated()), peak: dbOf(mOut.samplePeak) },
      octavesIn: bandLevels(inside, sr, 'octave'),
      octavesOut: bandLevels(outside, sr, 'octave'),
      gr,
    },
    errors: rendered.errors,
    ...unplayableOf(u, found.kind === 'track' ? [input.channel] : undefined),
  };
}

async function notes(input: Extract<ChildInput, { kind: 'notes' }>, progress: Progress): Promise<NotesResult> {
  progress(0.05, `Reading ${input.name}`);
  const source = measureSource(input.dataDir, input.project);
  const wav = await source.audio(input.file).catch(() => {
    throw new Error(`The recording ${input.name} is missing`);
  });
  progress(0.15, `Finding the notes in ${input.name}`);
  return { kind: 'notes', file: input.file, name: input.name, ...findNotes(wav) };
}

/** Run one measurement. */
export async function runTask(input: ChildInput, progress: Progress): Promise<MeasureResult> {
  switch (input.kind) {
    case 'take':
      return take(input, progress);
    case 'recording':
      return recording(input, progress);
    case 'mix':
      return mix(input, progress);
    case 'file':
      return file(input, progress);
    case 'tracks':
      return tracks(input, progress);
    case 'plugin':
      return plugin(input, progress);
    case 'notes':
      return notes(input, progress);
  }
}
