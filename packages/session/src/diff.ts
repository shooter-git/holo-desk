/**
 * What changed in a song between two versions, in plain musical words: how the AI hears of the
 * person's edits (and undos) since it last looked. Only the two versions are compared, so an edit
 * that was undone is no change at all, and a note moved twice is one note moved.
 *
 * Lines come in a fixed order (the song's settings, tracks, mix, plugins, automation, regions,
 * notes), at most `max` of them; the last then says how many more there were.
 */

import { fileToTicks } from './audio-notes.ts';
import { noteChanges as audioNoteChanges, noteChangesText } from './audio-notes-edit.ts';
import { automationTargets } from './automation.ts';
import { keyText } from './keysig.ts';
import { type MiddleC, noteName } from './notation.ts';
import { formatParam, pluginDef } from './plugins.ts';
import { describeInstrument } from './summary.ts';
import { meterAt, ticksPerBar, ticksPerBeat, tickToBarBeat } from './time.ts';
import type {
  AudioClip,
  AudioNote,
  Channel,
  Finish,
  Instrument,
  KeyPoint,
  MeterPoint,
  Note,
  Plugin,
  Project,
  Region,
  Seat,
  TempoPoint,
  Track,
} from './types.ts';

export interface ChangeOptions {
  /** How pitches are named: middle C as C4 (scientific, the default) or C3 (Logic). */
  middleC?: MiddleC;
  /** At most this many lines (20), the last of them "…and N more changes" when there are more. */
  max?: number;
}

/** What changed from `before` to `after`, a short line each; none when they're the same song. */
export function describeChanges(before: Project, after: Project, options: ChangeOptions = {}): string[] {
  const { middleC = 'C4', max = 20 } = options;
  if (before === after) return [];
  const ctx: Context = { a: before, b: after, meter: after.meter, middleC, strips: strips(before, after) };
  const lines = [
    ...songChanges(ctx),
    ...trackChanges(ctx),
    ...mixChanges(ctx),
    ...pluginChanges(ctx),
    ...automationChanges(ctx),
    ...regionChanges(ctx),
    ...noteChanges(ctx),
  ];
  if (lines.length <= max) return lines;
  const kept = Math.max(0, max - 1);
  const more = lines.length - kept;
  return [...lines.slice(0, kept), `…and ${more} more change${more === 1 ? '' : 's'}`];
}

/** A channel strip both versions have: a track's, a bus's or the master's. */
interface Strip {
  name: string;
  was: Channel;
  now: Channel;
  /** A track's MIDI effects (none on a bus or the master). */
  fxWas: Plugin[];
  fxNow: Plugin[];
}

interface Context {
  a: Project;
  b: Project;
  /** Bars are counted in the song as it is now. */
  meter: readonly MeterPoint[];
  middleC: MiddleC;
  strips: Strip[];
}

// ---- words ----

const MINUS = '−';

/** A number as people write it: no trailing zeros, a real minus sign. */
const num = (v: number, digits = 2) => {
  const s = String(+Math.abs(v).toFixed(digits));
  return v < 0 && s !== '0' ? `${MINUS}${s}` : s;
};

const dbText = (v: number) =>
  v <= -144 ? `${MINUS}∞` : `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v).toFixed(1)}`;

const panText = (v: number) => {
  const n = Math.round(v * 64);
  return n === 0 ? 'center' : `${n < 0 ? 'left' : 'right'} ${Math.abs(n)}`;
};

const percent = (v: number) => `${Math.round(v * 100)}%`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A few parts in full; past `most`, the first ones and how many more. */
function list(parts: string[], most = 4): string {
  if (parts.length <= most) return parts.join('; ');
  return `${parts.slice(0, most).join('; ')}; and ${parts.length - most} more`;
}

/** A position: "bar 9", "bar 9 beat 3", or bar.beat.sixteenth(.tick) off the beat. */
function at(meter: readonly MeterPoint[], tick: number): string {
  const p = tickToBarBeat(meter, tick);
  if (p.div === 1 && p.tick === 0) return p.beat === 1 ? `bar ${p.bar}` : `bar ${p.bar} beat ${p.beat}`;
  return `${p.bar}.${p.beat}.${p.div}${p.tick ? `.${p.tick}` : ''}`;
}

/** The bars a stretch of time covers: "bar 9" or "bars 9–12" (`end` is where it stops). */
function bars(meter: readonly MeterPoint[], start: number, end: number): string {
  const first = tickToBarBeat(meter, start).bar;
  const last = end > start ? tickToBarBeat(meter, end - 1).bar : first;
  return first === last ? `bar ${first}` : `bars ${first}–${last}`;
}

/** A length in bars when it is whole bars (at the meter where it starts), else in beats. */
function lengthText(meter: readonly MeterPoint[], start: number, length: number): string {
  const m = meterAt(meter, start);
  const inBars = length / ticksPerBar(m);
  if (Number.isInteger(inBars)) return plural(inBars, 'bar');
  return `${num(length / ticksPerBeat(m))} beats`;
}

function instrumentText(i: Instrument): string {
  // describeInstrument knows samplers and synths; the others are named here
  if (i.type === 'performance') return `${i.pack}/${i.name} (performance)`;
  if (i.type === 'glass') return i.line ? 'Glass Line' : 'Glass';
  return describeInstrument(i);
}

const pluginName = (p: Plugin) => pluginDef(p.type)?.name ?? p.type;

const CC_NAMES: Record<string, string> = {
  '1': 'mod wheel',
  '2': 'breath',
  '7': 'volume (CC 7)',
  '10': 'pan (CC 10)',
  '11': 'expression',
  '64': 'sustain pedal',
  pb: 'pitch bend',
  at: 'aftertouch',
};

// ---- comparing ----

/** The same value, deep; a key set to undefined is the same as no key (as it is once saved). */
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false;
    return true;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k in x) if (x[k] !== undefined && !equal(x[k], y[k])) return false;
  for (const k in y) if (y[k] !== undefined && x[k] === undefined) return false;
  return true;
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const x of items) out.set(x.id, x);
  return out;
}

/** Whether the ids both lists share come in a different order. */
function reordered(was: readonly { id: string }[], now: readonly { id: string }[]): boolean {
  const inNow = new Set(now.map((x) => x.id));
  const inWas = new Set(was.map((x) => x.id));
  const a = was.filter((x) => inNow.has(x.id));
  const b = now.filter((x) => inWas.has(x.id));
  return a.some((x, i) => x.id !== b[i]?.id);
}

/** Changes to points keyed by tick (tempo, meter and key changes, chord symbols). */
function pointChanges<T extends { tick: number }>(
  meter: readonly MeterPoint[],
  was: readonly T[],
  now: readonly T[],
  text: (p: T) => string,
): string[] {
  const old = new Map(was.map((p) => [p.tick, p]));
  const ticks = new Set(now.map((p) => p.tick));
  const parts: string[] = [];
  for (const p of now) {
    const q = old.get(p.tick);
    if (!q) parts.push(`${text(p)} added at ${at(meter, p.tick)}`);
    else if (!equal(p, q)) {
      const [x, y] = [text(q), text(p)];
      parts.push(x === y ? `${y} at ${at(meter, p.tick)} changed` : `${x} → ${y} at ${at(meter, p.tick)}`);
    }
  }
  for (const q of was) if (!ticks.has(q.tick)) parts.push(`${text(q)} at ${at(meter, q.tick)} removed`);
  return parts;
}

// ---- the song's settings ----

const tempoText = (p: TempoPoint) =>
  `${num(p.bpm)} bpm${p.ramp !== undefined && p.to !== undefined ? ` easing to ${num(p.to)}` : ''}` +
  `${p.text ? ` "${p.text}"` : ''}`;

const meterText = (m: MeterPoint) => `${m.num}/${m.den}${m.groups ? ` (${m.groups.join('+')})` : ''}`;

/** Key changes after the start (the first key is the song's `key`, said on its own). */
const laterKeys = (p: Project): KeyPoint[] => (p.keys ?? []).filter((k) => k.tick > 0);

const FINISH: ['lufs' | 'ceiling' | 'lowcut' | 'tilt', string, string][] = [
  ['lufs', 'loudness', ' LUFS'],
  ['ceiling', 'ceiling', ' dBTP'],
  ['lowcut', 'low cut', ' Hz'],
  ['tilt', 'tilt', ' dB'],
];

function finishText(f: Finish): string {
  return `${num(f.lufs)} LUFS, ceiling ${num(f.ceiling)} dBTP${f.glue ? ', glued' : ''}, low cut ${num(f.lowcut)} Hz, tilt ${num(f.tilt)} dB`;
}

function songChanges({ a, b, meter }: Context): string[] {
  const out: string[] = [];
  if (a.title !== b.title) out.push(`Title "${a.title}" → "${b.title}"`);

  const [t0, t1] = [a.tempo[0], b.tempo[0]];
  if (t0 && t1 && t0.bpm !== t1.bpm) out.push(`Tempo ${num(t0.bpm)} → ${num(t1.bpm)} bpm`);
  if (t0 && t1 && (t0.text ?? '') !== (t1.text ?? '')) {
    out.push(t1.text ? `Tempo marking "${t1.text}" at the start` : 'Tempo marking at the start removed');
  }
  // the score's own points (made from ramps and fermatas) follow from the others
  const laterTempo = (p: Project) => p.tempo.filter((x) => x.tick > 0 && !x.gen);
  const tempo = pointChanges(meter, laterTempo(a), laterTempo(b), tempoText);
  if (tempo.length) out.push(`Tempo changes: ${list(tempo)}`);

  const [m0, m1] = [a.meter[0], b.meter[0]];
  if (m0 && m1 && meterText(m0) !== meterText(m1)) out.push(`Meter ${meterText(m0)} → ${meterText(m1)}`);
  if (m1 && (m0?.pickup ?? 0) !== (m1.pickup ?? 0)) {
    out.push(
      m1.pickup ? `Starts with a pickup of ${num(m1.pickup / ticksPerBeat(m1), 3)} beat(s)` : 'Pickup bar removed',
    );
  }
  const meters = pointChanges(meter, a.meter.slice(1), b.meter.slice(1), meterText);
  if (meters.length) out.push(`Meter changes: ${list(meters)}`);

  if (a.key !== b.key) {
    out.push(b.key === null ? 'Key cleared' : a.key === null ? `Key set to ${b.key}` : `Key ${a.key} → ${b.key}`);
  }
  const keys = pointChanges(meter, laterKeys(a), laterKeys(b), keyText);
  if (keys.length) out.push(`Key changes: ${list(keys)}`);

  const markers = markerChanges(a, b, meter);
  if (markers.length) out.push(`Markers: ${list(markers)}`);
  const chords = pointChanges(meter, a.chords, b.chords, (c) => c.symbol);
  if (chords.length) out.push(`Chord symbols: ${list(chords)}`);
  if (!equal(a.form ?? [], b.form ?? [])) out.push('Repeats and jumps changed');

  if (!equal(a.cycle, b.cycle)) {
    const range = bars(meter, b.cycle.start, b.cycle.end);
    if (a.cycle.on !== b.cycle.on) out.push(b.cycle.on ? `Cycle on (${range})` : 'Cycle off');
    else out.push(`Cycle ${bars(meter, a.cycle.start, a.cycle.end)} → ${range}`);
  }
  if (!equal(a.loop, b.loop)) {
    const [l0, l1] = [a.loop, b.loop];
    if (!l1) out.push('No longer a loop');
    else if (!l0) out.push(`Song set to loop ${bars(meter, l1.start, l1.end)} (tail ${num(l1.tail)} s)`);
    else {
      const parts: string[] = [];
      if (l0.start !== l1.start || l0.end !== l1.end) {
        parts.push(`${bars(meter, l0.start, l0.end)} → ${bars(meter, l1.start, l1.end)}`);
      }
      if (l0.tail !== l1.tail) parts.push(`tail ${num(l0.tail)} → ${num(l1.tail)} s`);
      out.push(`Loop ${parts.join('; ')}`);
    }
  }
  if (!equal(a.finish, b.finish)) {
    const [f0, f1] = [a.finish, b.finish];
    if (!f1) out.push('Finish (mastering) removed');
    else if (!f0) out.push(`Finish (mastering) set: ${finishText(f1)}`);
    else {
      const parts = FINISH.filter(([k]) => f0[k] !== f1[k]).map(
        ([k, name, unit]) => `${name} ${num(f0[k])} → ${num(f1[k])}${unit}`,
      );
      if (f0.glue !== f1.glue) parts.push(f1.glue ? 'glue on' : 'glue off');
      out.push(`Finish (mastering): ${parts.join('; ')}`);
    }
  }
  if ((a.sampleRate ?? 48000) !== (b.sampleRate ?? 48000)) {
    out.push(`Render rate ${a.sampleRate ?? 48000} → ${b.sampleRate ?? 48000} Hz`);
  }
  if (!equal(a.score, b.score)) out.push('Score credits or layout changed');
  if (a.notes !== b.notes) out.push('Song notes edited');
  return out;
}

function markerChanges(a: Project, b: Project, meter: readonly MeterPoint[]): string[] {
  const old = byId(a.markers);
  const now = byId(b.markers);
  const parts: string[] = [];
  for (const m of b.markers) {
    const o = old.get(m.id);
    if (!o) parts.push(`"${m.name}" added at ${at(meter, m.tick)}`);
    else {
      if (o.name !== m.name) parts.push(`"${o.name}" renamed "${m.name}"`);
      if (o.tick !== m.tick) parts.push(`"${m.name}" moved to ${at(meter, m.tick)}`);
    }
  }
  for (const o of a.markers) if (!now.has(o.id)) parts.push(`"${o.name}" removed`);
  return parts;
}

// ---- tracks ----

/** What a track holds: its notes (or recordings) and the bars they span. */
function contents(meter: readonly MeterPoint[], t: Track): string {
  if (!t.regions.length) return 'empty';
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  let notes = 0;
  for (const r of t.regions) {
    start = Math.min(start, r.start);
    end = Math.max(end, r.start + r.length);
    notes += r.notes.length;
  }
  const what = t.kind === 'audio' ? plural(t.regions.length, 'region') : plural(notes, 'note');
  return `${what}, ${bars(meter, start, end)}`;
}

function trackChanges({ a, b, meter }: Context): string[] {
  const out: string[] = [];
  const was = byId(a.tracks);
  const now = byId(b.tracks);
  for (const t of a.tracks) {
    if (!now.has(t.id)) out.push(`Removed track ${t.name} (${contents(meter, t)})`);
  }
  for (const t of b.tracks) {
    const o = was.get(t.id);
    if (!o) {
      const what = t.kind === 'audio' ? 'audio track' : 'track';
      const sound = t.kind === 'audio' ? '' : `: ${instrumentText(t.instrument)}`;
      out.push(`Added ${what} ${t.name}${sound} (${contents(meter, t)})`);
      continue;
    }
    if (o.name !== t.name) out.push(`Track "${o.name}" renamed "${t.name}"`);
    if (!equal(o.instrument, t.instrument)) {
      const [x, y] = [instrumentText(o.instrument), instrumentText(t.instrument)];
      out.push(x === y ? `${t.name}: ${y} sound edited` : `${t.name}: instrument ${x} → ${y}`);
    }
    if (!equal(o.articulations, t.articulations)) out.push(`${t.name}: articulations changed`);
    if (!equal(o.score, t.score)) out.push(`${t.name}: how it's written on the score changed`);
  }
  if (reordered(a.tracks, b.tracks)) out.push('Track order changed');
  return out;
}

// ---- the mix ----

/** The channel strips both versions have, in the mixer's order: tracks, buses, the master. */
function strips(a: Project, b: Project): Strip[] {
  const out: Strip[] = [];
  const tracks = byId(a.tracks);
  for (const t of b.tracks) {
    const o = tracks.get(t.id);
    if (o) out.push({ name: t.name, was: o.channel, now: t.channel, fxWas: o.midiFx, fxNow: t.midiFx });
  }
  const buses = byId(a.buses);
  for (const x of b.buses) {
    const o = buses.get(x.id);
    if (o) out.push({ name: x.name, was: o.channel, now: x.channel, fxWas: [], fxNow: [] });
  }
  out.push({ name: 'Master', was: a.master, now: b.master, fxWas: [], fxNow: [] });
  return out;
}

function mixChanges(ctx: Context): string[] {
  const { a, b } = ctx;
  const out: string[] = [];
  const was = byId(a.buses);
  const now = byId(b.buses);
  for (const x of a.buses) if (!now.has(x.id)) out.push(`Removed bus ${x.name}`);
  for (const x of b.buses) {
    const o = was.get(x.id);
    if (!o) out.push(`Added bus ${x.name}`);
    else if (o.name !== x.name) out.push(`Bus "${o.name}" renamed "${x.name}"`);
  }
  for (const s of ctx.strips) {
    const parts = channelChanges(ctx, s.was, s.now);
    if (parts.length) out.push(`${s.name}: ${parts.join('; ')}`);
  }
  return out;
}

function channelChanges({ a, b }: Context, was: Channel, now: Channel): string[] {
  const parts: string[] = [];
  const busName = (id: string) =>
    id === 'master'
      ? 'Master'
      : id === ''
        ? 'nowhere'
        : (b.buses.find((x) => x.id === id)?.name ?? a.buses.find((x) => x.id === id)?.name ?? id);
  if (was.volume !== now.volume) parts.push(`volume ${dbText(was.volume)} → ${dbText(now.volume)} dB`);
  if (was.pan !== now.pan) parts.push(`pan ${panText(was.pan)} → ${panText(now.pan)}`);
  if (was.mute !== now.mute) parts.push(now.mute ? 'muted' : 'unmuted');
  if (was.solo !== now.solo) parts.push(now.solo ? 'soloed' : 'solo off');
  if (was.output !== now.output) parts.push(`output ${busName(was.output)} → ${busName(now.output)}`);

  // a send to a bus that's gone went with the bus (its own line says so)
  const live = new Set(b.buses.map((x) => x.id));
  const old = new Map(was.sends.map((s) => [s.bus, s]));
  const sending = new Set(now.sends.map((s) => s.bus));
  for (const s of now.sends) {
    const o = old.get(s.bus);
    const to = `send to ${busName(s.bus)}`;
    if (!o) parts.push(`${to} ${dbText(s.level)} dB added`);
    else {
      if (o.level !== s.level) parts.push(`${to} ${dbText(o.level)} → ${dbText(s.level)} dB`);
      if (o.pre !== s.pre) parts.push(`${to} ${s.pre ? 'before' : 'after'} the fader`);
    }
  }
  for (const o of was.sends) {
    if (!sending.has(o.bus) && live.has(o.bus)) parts.push(`send to ${busName(o.bus)} removed`);
  }

  const seat = (s: Seat) => ({ depth: s.depth, sends: s.sends.filter((x) => live.has(x.bus)) });
  const [st0, st1] = [was.stage, now.stage];
  if (!st0 && st1) parts.push(`placed on the stage (distance ${percent(st1.distance)})`);
  else if (st0 && !st1) parts.push('taken off the stage');
  else if (st0 && st1) {
    if (st0.distance !== st1.distance) parts.push(`stage distance ${percent(st0.distance)} → ${percent(st1.distance)}`);
    if (!equal(seat(st0.near), seat(st1.near)) || !equal(seat(st0.far), seat(st1.far))) {
      parts.push('stage seats changed');
    }
  }
  return parts;
}

// ---- plugins ----

function pluginChanges(ctx: Context): string[] {
  const out: string[] = [];
  for (const s of ctx.strips) {
    const parts = [...pluginParts(s.fxWas, s.fxNow), ...pluginParts(s.was.inserts, s.now.inserts)];
    if (parts.length) out.push(`${s.name}: ${parts.join('; ')}`);
  }
  return out;
}

function pluginParts(was: readonly Plugin[], now: readonly Plugin[]): string[] {
  const parts: string[] = [];
  const old = byId(was);
  const ids = new Set(now.map((p) => p.id));
  for (const p of was) if (!ids.has(p.id)) parts.push(`removed ${pluginName(p)}`);
  for (const p of now) {
    const o = old.get(p.id);
    const name = pluginName(p);
    if (!o) {
      parts.push(`added ${name}`);
      continue;
    }
    if (o.bypass !== p.bypass) parts.push(`${name} ${p.bypass ? 'bypassed' : 'back on'}`);
    const def = pluginDef(p.type);
    const fallback = (id: string) => def?.params.find((x) => x.id === id)?.default;
    const moved = [...new Set([...Object.keys(o.params), ...Object.keys(p.params)])].filter(
      (id) => (o.params[id] ?? fallback(id)) !== (p.params[id] ?? fallback(id)),
    );
    const settings = !equal(o.settings ?? {}, p.settings ?? {});
    const param = moved.length === 1 && !settings ? def?.params.find((x) => x.id === moved[0]) : undefined;
    if (param) {
      const v = (x: Plugin) => x.params[param.id] ?? param.default;
      parts.push(`${name} ${param.name} ${formatParam(param, v(o))} → ${formatParam(param, v(p))}`);
    } else if (moved.length || settings) parts.push(`${name} settings changed`);
  }
  if (reordered(was, now)) parts.push('plugin order changed');
  return parts;
}

// ---- automation ----

function automationChanges(ctx: Context): string[] {
  const { a, b, meter } = ctx;
  const out: string[] = [];
  for (const s of ctx.strips) {
    const was = s.was.automation ?? [];
    const now = s.now.automation ?? [];
    if (was === now || (!was.length && !now.length)) continue;
    const old = new Map(was.map((l) => [l.param, l]));
    const params = new Set(now.map((l) => l.param));
    // names only when something changed: listing a channel's targets walks its plugins
    let names: Map<string, string> | undefined;
    const name = (param: string) => {
      names ??= new Map([...automationTargets(a, s.was), ...automationTargets(b, s.now)].map((x) => [x.param, x.name]));
      return names.get(param) ?? param;
    };
    const parts: string[] = [];
    for (const l of now) {
      const o = old.get(l.param);
      if (!o) {
        parts.push(`${name(l.param)} added (${plural(l.points.length, 'point')})`);
        continue;
      }
      if (!equal(o.points, l.points) || (o.curve ?? 'linear') !== (l.curve ?? 'linear')) {
        parts.push(`${name(l.param)} changed${changedSpan(meter, o.points, l.points)}`);
      }
      if (o.mode !== l.mode) parts.push(`${name(l.param)} ${l.mode === 'off' ? 'turned off' : 'turned on'}`);
    }
    for (const o of was) if (!params.has(o.param)) parts.push(`${name(o.param)} removed`);
    if (parts.length) out.push(`${s.name} automation: ${parts.join('; ')}`);
  }
  return out;
}

/** Where two lanes' points differ, as " in bars 9–12" (nothing when only the curve changed). */
function changedSpan(meter: readonly MeterPoint[], was: [number, number][], now: [number, number][]): string {
  const key = (p: [number, number]) => `${p[0]}:${p[1]}`;
  const a = new Set(was.map(key));
  const b = new Set(now.map(key));
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const p of was) if (!b.has(key(p))) [first, last] = [Math.min(first, p[0]), Math.max(last, p[0])];
  for (const p of now) if (!a.has(key(p))) [first, last] = [Math.min(first, p[0]), Math.max(last, p[0])];
  return first <= last ? ` in ${bars(meter, first, last + 1)}` : '';
}

// ---- regions ----

const AUDIO_WORDS: [keyof AudioClip, string][] = [
  ['file', 'recording'],
  ['offset', 'start in the file'],
  ['gain', 'gain'],
  ['fadeIn', 'fade in'],
  ['fadeOut', 'fade out'],
  ['stretch', 'stretch'],
];

function regionChanges({ a, b, meter }: Context): string[] {
  const out: string[] = [];
  const tracksNow = byId(b.tracks);
  const where = new Map<string, { r: Region; t: Track }>();
  for (const t of a.tracks) for (const r of t.regions) where.set(r.id, { r, t });
  const stillHere = new Set<string>();
  for (const t of b.tracks) for (const r of t.regions) stillHere.add(r.id);
  const tracksWas = byId(a.tracks);

  for (const t of b.tracks) {
    // a new track's regions are said with the track
    if (!tracksWas.has(t.id)) continue;
    for (const r of t.regions) {
      const o = where.get(r.id);
      if (!o) {
        out.push(`${t.name}: new region at ${bars(meter, r.start, r.start + r.length)}`);
        continue;
      }
      const parts: string[] = [];
      if (o.t.id !== t.id) {
        const from = tracksNow.get(o.t.id)?.name ?? o.t.name;
        parts.push(`moved here from ${from}${o.r.start !== r.start ? `, to ${at(meter, r.start)}` : ''}`);
      } else if (o.r.start !== r.start) parts.push(`moved to ${at(meter, r.start)}`);
      if (o.r.length !== r.length) {
        parts.push(
          `resized from ${lengthText(meter, o.r.start, o.r.length)} to ${lengthText(meter, r.start, r.length)}`,
        );
      }
      if (o.r.muted !== r.muted) parts.push(r.muted ? 'muted' : 'unmuted');
      let notesLine: string | null = null;
      if (!equal(o.r.audio, r.audio)) {
        const [x, y] = [o.r.audio, r.audio];
        if (x && y) {
          const words = AUDIO_WORDS.filter(([k]) => x[k] !== y[k]).map(([, word]) => word);
          if (words.length) parts.push(`${words.join(', ')} changed`);
          if (!equal(x.notes, y.notes)) {
            const said = notesChange(a, b, o.r, r);
            if (said.bars) notesLine = `${t.name} ${said.bars}: ${said.text}`;
            else parts.push(said.text);
          }
        } else parts.push('recording changed');
      }
      if (o.r.cc !== r.cc) {
        const lanes = [...new Set([...Object.keys(o.r.cc), ...Object.keys(r.cc)])].filter(
          (k) => !equal(o.r.cc[k] ?? [], r.cc[k] ?? []),
        );
        if (lanes.length) parts.push(`${lanes.map((k) => CC_NAMES[k] ?? `CC ${k}`).join(', ')} changed`);
      }
      if (!equal(o.r.marks ?? [], r.marks ?? [])) parts.push('score markings changed');
      if (parts.length) out.push(`${t.name}: region at ${at(meter, o.r.start)} ${parts.join('; ')}`);
      if (notesLine) out.push(notesLine);
    }
  }
  for (const t of a.tracks) {
    const name = tracksNow.get(t.id)?.name;
    // a removed track's regions went with it
    if (name === undefined) continue;
    for (const r of t.regions) {
      if (!stillHere.has(r.id)) out.push(`${name}: region removed from ${bars(meter, r.start, r.start + r.length)}`);
    }
  }
  return out;
}

/**
 * How an audio region's notes changed, in words ("4 notes tuned, 1 moved"), and the bars the notes
 * that changed play in now ("bars 9–12"; those that went, where they played); no bars when it's the
 * notes as a whole that changed (their edits turned off, found again).
 */
function notesChange(a: Project, b: Project, was: Region, now: Region): { text: string; bars?: string } {
  const x = was.audio?.notes;
  const y = now.audio?.notes;
  const whole: string[] = [];
  if (x && y && (x.mode !== y.mode || x.v !== y.v)) whole.push('notes found again');
  else if (x && y && !x.off !== !y.off) whole.push(y.off ? 'note edits turned off' : 'note edits turned on');
  const changes = whole.length ? null : audioNoteChanges(x, y);
  const text = changes && noteChangesText(changes);
  if (!changes || !text) {
    if (!whole.length) whole.push(y ? (x ? 'notes changed' : 'notes found') : 'notes taken away');
    return { text: whole.join('; ') };
  }
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  const place = (project: Project, region: Region, notes: AudioNote[]) => {
    if (!notes.length) return;
    const tick = fileToTicks(project, region);
    for (const n of notes) {
      first = Math.min(first, tick(n.t));
      last = Math.max(last, tick(n.t + n.d));
    }
  };
  place(b, now, changes.now);
  place(a, was, changes.was);
  return first <= last ? { text, bars: bars(b.meter, Math.round(first), Math.round(last)) } : { text };
}

// ---- notes ----

/** A note where it sounds: its region's start plus its own. */
interface Placed {
  at: number;
  n: Note;
}

/** What a note is played as; notation hints and a creation's extras aren't compared. */
const sameNote = (x: Note, y: Note) => x.d === y.d && x.v === y.v && (x.art ?? '') === (y.art ?? '');

/** Same notes in the same places, region by region (most tracks don't change: this is the quick look). */
function sameNotes(was: Track, now: Track): boolean {
  if (was.regions === now.regions) return true;
  if (was.regions.length !== now.regions.length) return false;
  for (let i = 0; i < was.regions.length; i++) {
    const [x, y] = [was.regions[i] as Region, now.regions[i] as Region];
    if (x.start !== y.start) return false;
    if (x.notes === y.notes) continue;
    if (x.notes.length !== y.notes.length) return false;
    for (let j = 0; j < x.notes.length; j++) {
      const [m, n] = [x.notes[j] as Note, y.notes[j] as Note];
      if (m.t !== n.t || m.p !== n.p || !sameNote(m, n)) return false;
    }
  }
  return true;
}

/** A track's notes by where they sound and their pitch. */
function placeNotes(t: Track): Map<string, Placed[]> {
  const out = new Map<string, Placed[]>();
  for (const r of t.regions) {
    for (const n of r.notes) {
      const placed = { at: r.start + n.t, n };
      const key = `${placed.at}:${n.p}`;
      const here = out.get(key);
      if (here) here.push(placed);
      else out.set(key, [placed]);
    }
  }
  return out;
}

/** How a note changed: "longer and louder". */
function howChanged(x: Note, y: Note): string {
  const words: string[] = [];
  if (x.d !== y.d) words.push(y.d > x.d ? 'longer' : 'shorter');
  if (x.v !== y.v) words.push(y.v > x.v ? 'louder' : 'softer');
  if ((x.art ?? '') !== (y.art ?? '')) words.push('played another way');
  return words.join(' and ');
}

/** At most this many lines of notes for one track. */
const NOTE_LINES = 4;

interface Tally {
  first: number;
  last: number;
  added: number;
  removed: number;
  changed: number;
  /** The changes themselves, kept while there are few enough to name. */
  items: { at: number; text: string }[];
}

const barSpan = (t: Tally) => (t.first === t.last ? `bar ${t.first}` : `bars ${t.first}–${t.last}`);

const counts = (t: Tally) =>
  [t.added && `${t.added} added`, t.removed && `${t.removed} removed`, t.changed && `${t.changed} changed`]
    .filter(Boolean)
    .join(', ');

function noteChanges({ a, b, meter, middleC }: Context): string[] {
  const out: string[] = [];
  const was = byId(a.tracks);
  for (const t of b.tracks) {
    const o = was.get(t.id);
    if (!o || sameNotes(o, t)) continue;
    const byBar = new Map<number, Tally>();
    const count = (at: number, kind: 'added' | 'removed' | 'changed', text: string) => {
      const bar = tickToBarBeat(meter, at).bar;
      let tally = byBar.get(bar);
      if (!tally) {
        tally = { first: bar, last: bar, added: 0, removed: 0, changed: 0, items: [] };
        byBar.set(bar, tally);
      }
      tally[kind]++;
      if (tally.items.length < 3) tally.items.push({ at, text });
    };
    const name = (p: number) => noteName(p, middleC);
    const added = (x: Placed) => count(x.at, 'added', `${name(x.n.p)} added`);
    const removed = (x: Placed) => count(x.at, 'removed', `${name(x.n.p)} removed`);
    const changed = (x: Placed, y: Placed) => count(y.at, 'changed', `${name(y.n.p)} ${howChanged(x.n, y.n)}`);

    const before = placeNotes(o);
    const after = placeNotes(t);
    for (const [key, now] of after) {
      const old = before.get(key);
      if (!old) {
        for (const y of now) added(y);
        continue;
      }
      if (old.length === 1 && now.length === 1) {
        const [x, y] = [old[0] as Placed, now[0] as Placed];
        if (!sameNote(x.n, y.n)) changed(x, y);
        continue;
      }
      // several notes on one pitch at one place (rare): pair the unchanged ones first
      const left = old.slice();
      const unpaired: Placed[] = [];
      for (const y of now) {
        const i = left.findIndex((x) => sameNote(x.n, y.n));
        if (i >= 0) left.splice(i, 1);
        else unpaired.push(y);
      }
      unpaired.forEach((y, i) => {
        const x = left[i];
        if (x) changed(x, y);
        else added(y);
      });
      for (const x of left.slice(unpaired.length)) removed(x);
    }
    for (const [key, old] of before) if (!after.has(key)) for (const x of old) removed(x);

    // neighbouring bars (one quiet bar between them at most) are said together
    const runs: Tally[] = [];
    for (const bar of [...byBar.keys()].sort((x, y) => x - y)) {
      const tally = byBar.get(bar) as Tally;
      const run = runs[runs.length - 1];
      if (run && bar <= run.last + 2) {
        run.last = bar;
        run.added += tally.added;
        run.removed += tally.removed;
        run.changed += tally.changed;
        run.items.push(...tally.items);
      } else runs.push({ ...tally, items: tally.items.slice() });
    }
    // a part edited all over says its first places, then the rest in one line: it mustn't crowd out
    // the other tracks
    const shown = runs.length > NOTE_LINES ? runs.slice(0, NOTE_LINES - 1) : runs;
    for (const run of shown) {
      const named = run.added + run.removed + run.changed <= 3;
      const what = named
        ? run.items
            .sort((x, y) => x.at - y.at)
            .map((x) => x.text)
            .join(', ')
        : counts(run);
      out.push(`${t.name} ${barSpan(run)}: ${what}`);
    }
    const rest = runs.slice(shown.length);
    const [first, last] = [rest[0], rest[rest.length - 1]];
    if (first && last) {
      const sum: Tally = { first: first.first, last: last.last, added: 0, removed: 0, changed: 0, items: [] };
      for (const run of rest) {
        sum.added += run.added;
        sum.removed += run.removed;
        sum.changed += run.changed;
      }
      out.push(`${t.name} ${barSpan(sum)} (${rest.length} more places): ${counts(sum)}`);
    }
  }
  return out;
}
