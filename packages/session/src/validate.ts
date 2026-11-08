/**
 * Reading a session that came from outside (a file, a creation, the network): check its shape and
 * fill in anything an older or a hand-written session left out, so the rest of the code can trust it.
 */
import { newChannel, TRACK_COLORS } from './defaults.ts';
import { KEY_MODES, textForKeys } from './keysig.ts';
import {
  type Bus,
  type Channel,
  type FormMark,
  type KeyMode,
  type KeyPoint,
  type Mark,
  type MarkKind,
  type Note,
  type NoteNotation,
  type PerformancePlay,
  type Plugin,
  PPQ,
  type Project,
  type Region,
  type ScoreSettings,
  SESSION_FORMAT,
  SESSION_VERSION,
  type Seat,
  type Stage,
  type TempoPoint,
  type Track,
  type TrackScore,
} from './types.ts';

export class SessionError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, where: string, fallback?: number): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (fallback !== undefined && v === undefined) return fallback;
  throw new SessionError(`${where} must be a number`);
};
const str = (v: unknown, where: string, fallback?: string): string => {
  if (typeof v === 'string') return v;
  if (fallback !== undefined && v === undefined) return fallback;
  throw new SessionError(`${where} must be text`);
};
const arr = (v: unknown, where: string): unknown[] => {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v;
  throw new SessionError(`${where} must be a list`);
};

function plugin(v: unknown, where: string): Plugin {
  if (!isObj(v)) throw new SessionError(`${where} must be an object`);
  const params: Record<string, number> = {};
  if (isObj(v.params)) for (const [k, x] of Object.entries(v.params)) params[k] = num(x, `${where}.params.${k}`);
  const out: Plugin = {
    id: str(v.id, `${where}.id`),
    type: str(v.type, `${where}.type`),
    bypass: v.bypass === true,
    params,
  };
  if (isObj(v.settings)) {
    const settings: Record<string, string> = {};
    for (const [k, x] of Object.entries(v.settings)) if (typeof x === 'string') settings[k] = x.slice(0, 200);
    if (Object.keys(settings).length) out.settings = settings;
  }
  return out;
}

function channel(v: unknown, where: string, output = 'master'): Channel {
  if (v === undefined) return newChannel(output);
  if (!isObj(v)) throw new SessionError(`${where} must be an object`);
  return {
    volume: num(v.volume, `${where}.volume`, 0),
    pan: Math.max(-1, Math.min(1, num(v.pan, `${where}.pan`, 0))),
    mute: v.mute === true,
    solo: v.solo === true,
    inserts: arr(v.inserts, `${where}.inserts`).map((p, i) => plugin(p, `${where}.inserts[${i}]`)),
    sends: arr(v.sends, `${where}.sends`).map((s, i) => {
      if (!isObj(s)) throw new SessionError(`${where}.sends[${i}] must be an object`);
      return {
        bus: str(s.bus, `${where}.sends[${i}].bus`),
        level: num(s.level, 'send level', -12),
        pre: s.pre === true,
      };
    }),
    output: str(v.output, `${where}.output`, output),
    ...(Array.isArray(v.automation)
      ? {
          automation: v.automation.map((a, i) => {
            if (!isObj(a)) throw new SessionError(`${where}.automation[${i}] must be an object`);
            return {
              param: str(a.param, `${where}.automation[${i}].param`),
              points: arr(a.points, `${where}.automation[${i}].points`)
                .map((pt): [number, number] => {
                  if (!Array.isArray(pt) || pt.length !== 2)
                    throw new SessionError('automation points are [tick, value]');
                  return [num(pt[0], 'automation tick'), num(pt[1], 'automation value')];
                })
                .sort((x, y) => x[0] - y[0]),
              mode: a.mode === 'off' ? ('off' as const) : ('read' as const),
              ...(a.curve === 'smooth' ? { curve: 'smooth' as const } : {}),
            };
          }),
        }
      : {}),
    ...(isObj(v.stage) ? { stage: stage(v.stage, `${where}.stage`) } : {}),
  };
}

function seat(v: unknown, where: string): Seat {
  if (!isObj(v)) throw new SessionError(`${where} must be an object`);
  return {
    depth: Math.max(0, Math.min(1, num(v.depth, `${where}.depth`, 0))),
    sends: arr(v.sends, `${where}.sends`).map((x, i) => {
      if (!isObj(x)) throw new SessionError(`${where}.sends[${i}] must be an object`);
      return { bus: str(x.bus, `${where}.sends[${i}].bus`), level: num(x.level, 'seat send level', -12) };
    }),
  };
}

function stage(v: Record<string, unknown>, where: string): Stage {
  return {
    distance: Math.max(0, Math.min(1, num(v.distance, `${where}.distance`, 0))),
    near: seat(v.near, `${where}.near`),
    far: seat(v.far, `${where}.far`),
  };
}

// ---- score hints: optional, so one that doesn't make sense is left out rather than refused ----

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const int = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined;
const word = (v: unknown, max = 24): string | undefined =>
  typeof v === 'string' && v.length <= max && /^[a-z][a-z0-9-]*$/i.test(v) ? v : undefined;
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);
const pair = (v: unknown): v is [unknown, unknown] => Array.isArray(v) && v.length === 2;

function notation(v: unknown): NoteNotation | undefined {
  if (!isObj(v)) return undefined;
  const n: NoteNotation = {};
  if (Array.isArray(v.sp) && v.sp.length === 3) {
    const step = int(v.sp[0], 0, 6);
    const alter = int(v.sp[1], -3, 3);
    if (step !== undefined && alter !== undefined && finite(v.sp[2])) n.sp = [step, alter, v.sp[2]];
  }
  if (pair(v.w) && finite(v.w[0]) && finite(v.w[1]) && v.w[0] > 0 && v.w[1] > 0) n.w = [v.w[0], v.w[1]];
  const vo = int(v.vo, 1, 4);
  if (vo) n.vo = vo;
  const st = int(v.st, 1, 4);
  if (st) n.st = st;
  if (Array.isArray(v.a)) {
    const a = v.a.map((x) => word(x)).filter((x): x is string => !!x);
    if (a.length) n.a = a.slice(0, 12);
  }
  if (v.g === 'a' || v.g === 'p') n.g = v.g;
  const dv = int(v.dv, 1, 127);
  if (dv) n.dv = dv;
  if (Array.isArray(v.ly) && v.ly.some((x) => typeof x === 'string' && x)) {
    n.ly = v.ly.slice(0, 12).map((x) => (typeof x === 'string' ? x.slice(0, 64) : ''));
  }
  if (pair(v.tb) && int(v.tb[0], 1, 12) && finite(v.tb[1])) n.tb = [v.tb[0] as number, v.tb[1]];
  if (pair(v.tu) && int(v.tu[0], 2, 64) && int(v.tu[1], 1, 64)) n.tu = [v.tu[0] as number, v.tu[1] as number];
  const hd = word(v.hd, 16);
  if (hd) n.hd = hd;
  if (v.stem === 'up' || v.stem === 'down') n.stem = v.stem;
  const fi = text(v.fi, 16);
  if (fi) n.fi = fi;
  return Object.keys(n).length ? n : undefined;
}

const MARK_KINDS = new Set<MarkKind>([
  'dyn',
  'cresc',
  'dim',
  'slur',
  'text',
  'expr',
  'oct',
  'breath',
  'caesura',
  'gliss',
]);

function mark(v: unknown): Mark | null {
  if (!isObj(v) || !finite(v.t) || !MARK_KINDS.has(v.k as MarkKind)) return null;
  const m: Mark = { t: v.t, k: v.k as MarkKind };
  if (finite(v.e) && v.e >= v.t) m.e = v.e;
  const st = int(v.st, 1, 4);
  if (st) m.st = st;
  const vo = int(v.vo, 1, 4);
  if (vo) m.vo = vo;
  if (typeof v.v === 'string') m.v = v.v.slice(0, 80);
  else if (finite(v.v)) m.v = v.v;
  return m;
}

const CLEFS = new Set(['G', 'F', 'C1', 'C2', 'C3', 'C4', 'C5', 'G8vb', 'G8va', 'G15ma', 'F8vb', 'F8va', 'perc', 'tab']);

function trackScore(v: unknown): TrackScore | undefined {
  if (!isObj(v)) return undefined;
  const s: TrackScore = {};
  const name = text(v.name, 80);
  if (name) s.name = name;
  const abbr = text(v.abbr, 24);
  if (abbr) s.abbr = abbr;
  const staves = int(v.staves, 1, 4);
  if (staves) s.staves = staves;
  if (finite(v.split)) s.split = Math.max(0, Math.min(127, Math.round(v.split)));
  if (Array.isArray(v.clefs)) {
    const clefs = v.clefs
      .filter((c): c is [number, number, string] => {
        if (!Array.isArray(c) || c.length !== 3) return false;
        return finite(c[0]) && c[0] >= 0 && !!int(c[1], 1, 4) && CLEFS.has(c[2] as string);
      })
      .map((c): [number, number, string] => [c[0], c[1], c[2]])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (clefs.length) s.clefs = clefs;
  }
  if (pair(v.tr) && int(v.tr[0], -48, 48) !== undefined && int(v.tr[1], -28, 28) !== undefined) {
    s.tr = [v.tr[0] as number, v.tr[1] as number];
  }
  if (isObj(v.drums)) {
    const drums: Record<string, [number, string]> = {};
    for (const [pitch, place] of Object.entries(v.drums)) {
      if (!/^\d{1,3}$/.test(pitch) || !pair(place)) continue;
      const line = int(place[0], -16, 16);
      const head = word(place[1], 16);
      if (line !== undefined && head) drums[pitch] = [line, head];
    }
    if (Object.keys(drums).length) s.drums = drums;
  }
  if (isObj(v.tab) && Array.isArray(v.tab.tuning)) {
    const tuning = v.tab.tuning.filter((p): p is number => !!int(p, 0, 127)).slice(0, 12);
    if (tuning.length) {
      s.tab = { tuning };
      const capo = int(v.tab.capo, 1, 24);
      if (capo) s.tab.capo = capo;
      if (v.tab.only === true) s.tab.only = true;
    }
  }
  if (finite(v.grid) && v.grid > 0) s.grid = v.grid;
  if (v.hidden === true) s.hidden = true;
  return Object.keys(s).length ? s : undefined;
}

function keyPoints(v: unknown): KeyPoint[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v
    .filter((k): k is Record<string, unknown> => isObj(k) && finite(k.tick) && k.tick >= 0)
    .filter((k) => int(k.fifths, -7, 7) !== undefined && KEY_MODES.includes(k.mode as KeyMode))
    .map((k) => ({ tick: k.tick as number, fifths: k.fifths as number, mode: k.mode as KeyMode }))
    .sort((a, b) => a.tick - b.tick);
}

const FORM_KINDS = new Set<FormMark['k']>(['start', 'end', 'ending', 'segno', 'coda', 'toCoda', 'fine', 'dc', 'ds']);

function formMarks(v: unknown): FormMark[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: FormMark[] = [];
  for (const f of v) {
    if (!isObj(f) || !finite(f.tick) || f.tick < 0 || !FORM_KINDS.has(f.k as FormMark['k'])) continue;
    const m: FormMark = { tick: f.tick, k: f.k as FormMark['k'] };
    const times = int(f.times, 2, 99);
    if (m.k === 'end' && times) m.times = times;
    if (m.k === 'ending') {
      if (!finite(f.e) || f.e <= f.tick) continue;
      m.e = f.e;
      const passes = Array.isArray(f.passes) ? f.passes.filter((p): p is number => !!int(p, 1, 99)) : [];
      m.passes = passes.length ? [...new Set(passes)].sort((a, b) => a - b) : [1];
    }
    if ((m.k === 'dc' || m.k === 'ds') && (f.al === 'fine' || f.al === 'coda')) m.al = f.al;
    if ((m.k === 'dc' || m.k === 'ds') && f.repeats === true) m.repeats = true;
    out.push(m);
  }
  return out.sort((a, b) => a.tick - b.tick);
}

const PAGE_SIZES = new Set(['letter', 'a4', 'a3', 'tabloid']);

function scoreSettings(v: unknown): ScoreSettings | undefined {
  if (!isObj(v)) return undefined;
  const s: ScoreSettings = {};
  for (const k of ['subtitle', 'composer', 'lyricist', 'arranger', 'copyright'] as const) {
    const t = text(v[k], 200);
    if (t) s[k] = t;
  }
  if (Array.isArray(v.groups)) {
    const groups = v.groups.filter(
      (g): g is [string, string, 'bracket' | 'brace' | 'line'] =>
        Array.isArray(g) &&
        g.length === 3 &&
        typeof g[0] === 'string' &&
        typeof g[1] === 'string' &&
        (g[2] === 'bracket' || g[2] === 'brace' || g[2] === 'line'),
    );
    if (groups.length) s.groups = groups.map((g) => [g[0], g[1], g[2]]);
  }
  if (Array.isArray(v.breaks)) {
    const breaks = v.breaks
      .filter(
        (b): b is [number, 'system' | 'page'] =>
          pair(b) && finite(b[0]) && b[0] >= 0 && (b[1] === 'system' || b[1] === 'page'),
      )
      .map((b): [number, 'system' | 'page'] => [b[0], b[1]])
      .sort((a, b) => a[0] - b[0]);
    if (breaks.length) s.breaks = breaks;
  }
  if (isObj(v.page)) {
    const page: NonNullable<ScoreSettings['page']> = {};
    if (PAGE_SIZES.has(v.page.size as string)) page.size = v.page.size as NonNullable<typeof page.size>;
    if (v.page.landscape === true) page.landscape = true;
    if (finite(v.page.staff)) page.staff = Math.max(3, Math.min(15, v.page.staff));
    if (Object.keys(page).length) s.page = page;
  }
  if (v.concert === true) s.concert = true;
  return Object.keys(s).length ? s : undefined;
}

function tempoPoint(t: unknown, i: number): TempoPoint {
  if (!isObj(t)) throw new SessionError(`tempo[${i}] must be an object`);
  const tick = num(t.tick, `tempo[${i}].tick`);
  const point: TempoPoint = { tick, bpm: Math.max(5, Math.min(999, num(t.bpm, `tempo[${i}].bpm`))) };
  const words = text(t.text, 60);
  if (words) point.text = words;
  if (t.mm === true) point.mm = true;
  if (finite(t.ramp) && t.ramp > tick) {
    point.ramp = t.ramp;
    point.to = Math.max(5, Math.min(999, finite(t.to) ? t.to : point.bpm));
  }
  if (t.gen === true) point.gen = true;
  return point;
}

function note(v: unknown, where: string): Note {
  if (!isObj(v)) throw new SessionError(`${where} must be an object`);
  const n: Note = {
    t: num(v.t, `${where}.t`),
    d: Math.max(1, num(v.d, `${where}.d`)),
    p: num(v.p, `${where}.p`),
    v: Math.max(1, Math.min(127, num(v.v, `${where}.v`, 90))),
  };
  if (typeof v.art === 'string') n.art = v.art;
  if (isObj(v.x)) n.x = v.x;
  const hints = notation(v.n);
  if (hints) n.n = hints;
  return n;
}

function region(v: unknown, where: string): Region {
  if (!isObj(v)) throw new SessionError(`${where} must be an object`);
  const cc: Region['cc'] = {};
  if (isObj(v.cc)) {
    for (const [lane, pts] of Object.entries(v.cc)) {
      cc[lane] = arr(pts, `${where}.cc.${lane}`).map((pt) => {
        if (!Array.isArray(pt) || pt.length !== 2)
          throw new SessionError(`${where}.cc.${lane} points are [tick, value]`);
        return [num(pt[0], 'cc tick'), num(pt[1], 'cc value')];
      });
    }
  }
  const r: Region = {
    id: str(v.id, `${where}.id`),
    name: str(v.name, `${where}.name`, ''),
    start: num(v.start, `${where}.start`),
    length: Math.max(1, num(v.length, `${where}.length`)),
    muted: v.muted === true,
    notes: arr(v.notes, `${where}.notes`).map((n, i) => note(n, `${where}.notes[${i}]`)),
    cc,
  };
  if (typeof v.color === 'string') r.color = v.color;
  if (isObj(v.audio)) {
    const a = v.audio;
    r.audio = {
      file: str(a.file, `${where}.audio.file`),
      offset: Math.max(0, num(a.offset, `${where}.audio.offset`, 0)),
      gain: num(a.gain, `${where}.audio.gain`, 0),
      fadeIn: Math.max(0, num(a.fadeIn, `${where}.audio.fadeIn`, 0)),
      fadeOut: Math.max(0, num(a.fadeOut, `${where}.audio.fadeOut`, 0)),
      stretch: Math.max(0.25, Math.min(4, num(a.stretch, `${where}.audio.stretch`, 1))),
    };
  }
  if (Array.isArray(v.marks)) {
    const marks = v.marks.map(mark).filter((m): m is Mark => m !== null);
    if (marks.length) r.marks = marks.sort((a, b) => a.t - b.t);
  }
  return r;
}

function instrument(v: unknown, where: string): Track['instrument'] {
  if (!isObj(v)) return { type: 'none' };
  if (v.type === 'sampler') {
    const out: Track['instrument'] = {
      type: 'sampler',
      pack: str(v.pack, `${where}.pack`),
      name: str(v.name, `${where}.name`),
    };
    // its knobs (a microphone's level, tune, decay): only numbers, and only when there are some
    if (isObj(v.params)) {
      const params = Object.fromEntries(
        Object.entries(v.params)
          .filter(([, x]) => typeof x === 'number' && Number.isFinite(x))
          .map(([k, x]) => [k, x as number]),
      );
      if (Object.keys(params).length) out.params = params;
    }
    return out;
  }
  if (v.type === 'synth') {
    const out: Track['instrument'] = { type: 'synth', preset: str(v.preset, `${where}.preset`, 'Soft Keys') };
    if (isObj(v.params)) out.params = Object.fromEntries(Object.entries(v.params).map(([k, x]) => [k, num(x, k)]));
    return out;
  }
  if (v.type === 'performance') {
    const out: Track['instrument'] = {
      type: 'performance',
      pack: str(v.pack, `${where}.pack`),
      name: str(v.name, `${where}.name`),
    };
    if (isObj(v.play)) out.play = performancePlay(v.play, `${where}.play`);
    return out;
  }
  if (v.type === 'glass') {
    const out: Track['instrument'] = { type: 'glass' };
    if (v.line === true) out.line = true;
    if (isObj(v.options))
      out.options = Object.fromEntries(Object.entries(v.options).map(([k, x]) => [k, num(x, `${where}.options.${k}`)]));
    return out;
  }
  return { type: 'none' };
}

const PLAY_NUMBERS = [
  'seed',
  'gainDb',
  'pan',
  'width',
  'legatoGap',
  'xf',
  'detune',
  'layerBias',
  'release',
  'tail',
  'panSpread',
  'humanizeV',
  'slide',
  'lag',
] as const;

function performancePlay(v: Record<string, unknown>, where: string): PerformancePlay {
  const out: PerformancePlay = {};
  for (const k of PLAY_NUMBERS) if (typeof v[k] === 'number') out[k] = num(v[k], `${where}.${k}`);
  if (typeof v.legato === 'boolean') out.legato = v.legato;
  if (isObj(v.shape)) {
    const sh: NonNullable<PerformancePlay['shape']> = {};
    for (const k of ['attack', 'swell', 'taper'] as const) if (typeof v.shape[k] === 'number') sh[k] = v.shape[k];
    out.shape = sh;
  }
  if (Array.isArray(v.dyn))
    out.dyn = v.dyn.map((pt): [number, number] => {
      if (!Array.isArray(pt) || pt.length !== 2) throw new SessionError(`${where}.dyn points are [tick, value]`);
      return [num(pt[0], 'dyn tick'), num(pt[1], 'dyn value')];
    });
  return out;
}

function track(v: unknown, i: number): Track {
  const where = `tracks[${i}]`;
  if (!isObj(v)) throw new SessionError(`${where} must be an object`);
  const input = isObj(v.input) ? v.input : {};
  const t: Track = {
    id: str(v.id, `${where}.id`),
    name: str(v.name, `${where}.name`, `Track ${i + 1}`),
    color: str(v.color, `${where}.color`, TRACK_COLORS[i % TRACK_COLORS.length] ?? '#3fa7d6'),
    kind: v.kind === 'audio' ? 'audio' : 'instrument',
    instrument: instrument(v.instrument, `${where}.instrument`),
    articulations: arr(v.articulations, `${where}.articulations`).map((a, j) => {
      if (!isObj(a)) throw new SessionError(`${where}.articulations[${j}] must be an object`);
      return {
        id: str(a.id, 'articulation id'),
        name: str(a.name, 'articulation name', str(a.id, 'articulation id')),
        instrument: instrument(a.instrument, 'articulation instrument'),
      };
    }),
    input: {
      port: str(input.port, `${where}.input.port`, '*'),
      channel: num(input.channel, `${where}.input.channel`, 0),
    },
    armed: v.armed === true,
    midiFx: arr(v.midiFx, `${where}.midiFx`).map((p, j) => plugin(p, `${where}.midiFx[${j}]`)),
    regions: arr(v.regions, `${where}.regions`).map((r, j) => region(r, `${where}.regions[${j}]`)),
    channel: channel(v.channel, `${where}.channel`),
  };
  if (isObj(v.audioInput)) {
    t.audioInput = {
      input: Math.max(0, Math.round(num(v.audioInput.input, `${where}.audioInput.input`, 0))),
      channels: v.audioInput.channels === 2 ? 2 : 1,
      monitor: v.audioInput.monitor === true,
    };
  }
  if (isObj(v.origin)) {
    t.origin = { voice: str(v.origin.voice, `${where}.origin.voice`), edited: v.origin.edited === true };
    if (v.origin.locked === true) t.origin.locked = true;
    if (isObj(v.origin.extra)) t.origin.extra = v.origin.extra;
  }
  const score = trackScore(v.score);
  if (score) t.score = score;
  return t;
}

/** A session from untrusted JSON: checked, with defaults filled in. Throws SessionError. */
export function parseProject(value: unknown): Project {
  if (!isObj(value)) throw new SessionError('A session must be a JSON object');
  if (value.format !== SESSION_FORMAT)
    throw new SessionError(`Not a HO[LO] session (format must be "${SESSION_FORMAT}")`);
  const version = num(value.version, 'version');
  if (version > SESSION_VERSION) {
    throw new SessionError(`This session is version ${version}; this studio reads up to ${SESSION_VERSION}`);
  }
  const now = new Date().toISOString();
  const tempo = arr(value.tempo, 'tempo').map(tempoPoint);
  const meter = arr(value.meter, 'meter').map((m, i) => {
    if (!isObj(m)) throw new SessionError(`meter[${i}] must be an object`);
    const point: Project['meter'][number] = {
      tick: num(m.tick, `meter[${i}].tick`),
      num: num(m.num, `meter[${i}].num`),
      den: num(m.den, `meter[${i}].den`),
    };
    if (Array.isArray(m.groups)) point.groups = m.groups.map((g) => num(g, 'meter group'));
    const bar = (point.num * PPQ * 4) / point.den;
    if (point.tick === 0 && finite(m.pickup) && m.pickup > 0 && m.pickup < bar) point.pickup = m.pickup;
    return point;
  });
  const keys = keyPoints(value.keys);
  const form = formMarks(value.form);
  const score = scoreSettings(value.score);
  const keyText = typeof value.key === 'string' ? value.key : null;
  if (!tempo.length) tempo.push({ tick: 0, bpm: 120 });
  if (!meter.length) meter.push({ tick: 0, num: 4, den: 4 });
  const cycle = isObj(value.cycle) ? value.cycle : {};
  const buses = arr(value.buses, 'buses').map((b, i): Bus => {
    if (!isObj(b)) throw new SessionError(`buses[${i}] must be an object`);
    return {
      id: str(b.id, `buses[${i}].id`),
      name: str(b.name, `buses[${i}].name`, `Bus ${i + 1}`),
      color: str(b.color, `buses[${i}].color`, '#7c8a99'),
      channel: channel(b.channel, `buses[${i}].channel`),
    };
  });
  return {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    id: str(value.id, 'id'),
    title: str(value.title, 'title', 'Untitled'),
    revision: num(value.revision, 'revision', 0),
    created: str(value.created, 'created', now),
    modified: str(value.modified, 'modified', now),
    tempo,
    meter,
    // the key points win over the text, which is kept when it still names the first of them
    key: keys ? textForKeys(keys, keyText) : keyText,
    ...(keys ? { keys } : {}),
    ...(form?.length ? { form } : {}),
    ...(score ? { score } : {}),
    markers: arr(value.markers, 'markers').map((m, i) => {
      if (!isObj(m)) throw new SessionError(`markers[${i}] must be an object`);
      return {
        id: str(m.id, 'marker id', `mrk_${i}`),
        tick: num(m.tick, 'marker tick'),
        name: str(m.name, 'marker name', ''),
      };
    }),
    chords: arr(value.chords, 'chords').map((c, i) => {
      if (!isObj(c)) throw new SessionError(`chords[${i}] must be an object`);
      return { tick: num(c.tick, 'chord tick'), symbol: str(c.symbol, 'chord symbol') };
    }),
    tracks: arr(value.tracks, 'tracks').map(track),
    buses,
    master: channel(value.master, 'master', ''),
    cycle: {
      on: cycle.on === true,
      start: num(cycle.start, 'cycle.start', 0),
      end: num(cycle.end, 'cycle.end', PPQ * 16),
    },
    origin: isObj(value.origin)
      ? {
          creation: str(value.origin.creation, 'origin.creation'),
          piece: str(value.origin.piece, 'origin.piece'),
          exportedAt: str(value.origin.exportedAt, 'origin.exportedAt', now),
          ...(typeof value.origin.sourceHash === 'string' ? { sourceHash: value.origin.sourceHash } : {}),
          ...(isObj(value.origin.extra) ? { extra: value.origin.extra } : {}),
        }
      : null,
    notes: str(value.notes, 'notes', ''),
    ...(typeof value.sampleRate === 'number' && [44100, 48000, 88200, 96000].includes(value.sampleRate)
      ? { sampleRate: value.sampleRate }
      : {}),
    ...(isObj(value.finish)
      ? {
          finish: {
            lufs: Math.max(-40, Math.min(0, num(value.finish.lufs, 'finish.lufs', -16))),
            ceiling: Math.max(-12, Math.min(0, num(value.finish.ceiling, 'finish.ceiling', -1))),
            glue: value.finish.glue !== false,
            lowcut: Math.max(5, Math.min(200, num(value.finish.lowcut, 'finish.lowcut', 28))),
            tilt: Math.max(-6, Math.min(6, num(value.finish.tilt, 'finish.tilt', 0))),
          },
        }
      : {}),
    ...(isObj(value.performance) && isObj(value.performance.kernelCuts)
      ? {
          performance: {
            kernelCuts: Object.fromEntries(
              Object.entries(value.performance.kernelCuts).map(([k, x]) => [k, num(x, 'kernel cut')]),
            ),
          },
        }
      : {}),
    ...(isObj(value.loop)
      ? {
          loop: {
            start: Math.max(0, num(value.loop.start, 'loop.start', 0)),
            end: Math.max(1, num(value.loop.end, 'loop.end')),
            tail: Math.max(0, Math.min(60, num(value.loop.tail, 'loop.tail', 0))),
          },
        }
      : {}),
    ...(Array.isArray(value.files)
      ? {
          files: value.files.map((f, i) => {
            if (!isObj(f)) throw new SessionError(`files[${i}] must be an object`);
            return {
              id: str(f.id, `files[${i}].id`),
              name: str(f.name, `files[${i}].name`, 'Audio'),
              seconds: num(f.seconds, `files[${i}].seconds`, 0),
              rate: num(f.rate, `files[${i}].rate`, 48000),
              channels: num(f.channels, `files[${i}].channels`, 2),
            };
          }),
        }
      : {}),
  };
}

/** Where a session ends: the last region's end, at least one bar. */
export function projectEnd(project: Project): number {
  let end = PPQ * 4;
  for (const t of project.tracks) for (const r of t.regions) end = Math.max(end, r.start + r.length);
  return end;
}
