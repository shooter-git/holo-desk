/**
 * Editing a score: what each click and keystroke in the Score does to the song, as operations. The
 * notes stay what plays, so every edit here is an edit the Piano Roll shows too, and every edit
 * there shows here. Entering a note overwrites what its staff's voice had from there for its length
 * (as MuseScore does); dynamics and articulations set velocities and lengths as they're written.
 */
import {
  type FormMark,
  type KeyPoint,
  keyAt,
  keysOf,
  type Mark,
  type MeterPoint,
  meterAt,
  type Note,
  type NoteNotation,
  newRegion,
  type Op,
  PPQ,
  type Project,
  type Region,
  type Track,
  ticksPerBar,
} from '@holo/session';
import { gateFor, levelAt, slurredAt, staffMarks, velocityFor } from './bake.ts';
import type { ScoreDoc, ScoreEvent } from './model.ts';
import { clefAt } from './notate.ts';
import {
  fifthsShift,
  keyAlters,
  normalFifths,
  pitchOf,
  type Spelling,
  spellAs,
  spellings,
  transposeSpelling,
} from './spell.ts';

/** Where entry goes on: a track's staff and voice, at a tick. */
export interface Caret {
  track: string;
  staff: number;
  voice: number;
  tick: number;
}

/** A pitch to enter: what it sounds, and how it's spelled at concert pitch (when it's spelled). */
export interface EntryPitch {
  p: number;
  sp?: [number, number];
}

export interface EditResult {
  ops: Op[];
  /** The notes made (the same objects the song will hold, so they can be selected). */
  notes: Note[];
}

interface Place {
  track: string;
  staff: number;
  voice: number;
  /** As written on the page. */
  written: Spelling;
}

/** Where every drawn note is: its part, staff and voice, and how it's written. */
export function placesOf(doc: ScoreDoc): Map<Note, Place> {
  const out = new Map<Note, Place>();
  for (const part of doc.parts) {
    for (const staff of part.staves) {
      for (const b of staff.bars) {
        for (const v of b.voices) {
          for (const e of v.events) {
            if (e.kind !== 'chord') continue;
            for (const h of e.heads) {
              if (out.has(h.ref.note)) continue;
              out.set(h.ref.note, {
                track: part.track,
                staff: staff.local,
                voice: v.n,
                written: { step: h.step, alter: h.alter, octave: h.octave },
              });
            }
          }
        }
      }
    }
  }
  return out;
}

const writtenLength = (n: Note): number => (n.n?.w && n.n.w[1] === n.d ? n.n.w[0] : n.d);

/** A note with a written length and its sound from the markings there. */
function sounded(track: Track, staff: number, tick: number, written: number, base: Note): Note {
  const marks = staffMarks(track, staff);
  const art = base.n?.a ?? [];
  const v = velocityFor(levelAt(marks, tick), art);
  const d = base.n?.g ? base.d : Math.max(1, Math.round(written * gateFor(art, slurredAt(marks, tick))));
  const n: NoteNotation = { ...base.n, dv: v };
  if (d !== written) n.w = [written, d];
  else delete n.w;
  return { ...base, d, v, n };
}

/** The region a span goes in: one covering it, one lengthened to, or a new one bar-aligned. */
function regionFor(project: Project, track: Track, start: number, end: number): { region: Region; ops: Op[] } {
  const covering = track.regions.find((r) => !r.audio && r.start <= start && r.start + r.length >= end);
  if (covering) return { region: covering, ops: [] };
  const touching = track.regions.find((r) => !r.audio && r.start <= start && r.start + r.length >= start);
  if (touching) {
    const region = { ...touching, length: end - touching.start };
    return {
      region,
      ops: [{ op: 'updateRegion', track: track.id, region: touching.id, patch: { length: region.length } }],
    };
  }
  const bar = ticksPerBar(meterAt(project.meter, start));
  const from = Math.floor(start / bar) * bar;
  const to = Math.ceil(end / bar) * bar;
  const region = newRegion(from, Math.max(bar, to - from), '');
  return { region, ops: [{ op: 'addRegion', track: track.id, region }] };
}

/**
 * Enter a chord (or a rest, with no pitches) at the caret, `len` ticks long: what the staff's voice
 * had from there for that long goes, a note sounding into it is cut back to it.
 */
export function enter(
  project: Project,
  doc: ScoreDoc,
  caret: Caret,
  pitches: EntryPitch[],
  len: number,
  art: string[] = [],
): EditResult {
  const track = project.tracks.find((t) => t.id === caret.track);
  if (!track) return { ops: [], notes: [] };
  const part = doc.parts.find((p) => p.track === track.id);
  const places = placesOf(doc);
  const end = caret.tick + len;
  const mine = (n: Note) => {
    const at = places.get(n);
    return at ? at.staff === caret.staff && at.voice === caret.voice : caret.staff === 1 && caret.voice === 1;
  };
  // make room in every region of the track
  const changed = new Map<string, Note[]>();
  for (const r of track.regions) {
    if (r.audio) continue;
    let touched = false;
    const kept: Note[] = [];
    for (const n of r.notes) {
      const s = r.start + n.t;
      if (n.n?.g || !mine(n)) {
        kept.push(n);
        continue;
      }
      const e = s + writtenLength(n);
      if (s >= caret.tick && s < end) {
        touched = true;
        continue;
      }
      if (s < caret.tick && e > caret.tick) {
        touched = true;
        const written = caret.tick - s;
        const d = Math.max(1, Math.min(n.d, Math.round(written * (n.d / writtenLength(n)))));
        const hints: NoteNotation = { ...n.n };
        if (d !== written) hints.w = [written, d];
        else delete hints.w;
        kept.push({ ...n, d, n: hints });
        continue;
      }
      kept.push(n);
    }
    if (touched) changed.set(r.id, kept);
  }
  const ops: Op[] = [];
  const notes: Note[] = [];
  if (pitches.length) {
    const { region, ops: regionOps } = regionFor(project, track, caret.tick, end);
    ops.push(...regionOps);
    const base = changed.get(region.id) ?? region.notes;
    const staves = part?.staves.length ?? 1;
    for (const pitch of pitches) {
      const hints: NoteNotation = {};
      if (pitch.sp && pitch.sp[1] !== 0) hints.sp = [pitch.sp[0], pitch.sp[1], pitch.p];
      if (staves > 1) hints.st = caret.staff;
      if (caret.voice > 1) hints.vo = caret.voice;
      if (art.length) hints.a = art;
      const n = sounded(track, caret.staff, caret.tick, len, {
        t: caret.tick - region.start,
        d: len,
        p: pitch.p,
        v: 80,
        n: hints,
      });
      notes.push(n);
    }
    changed.set(region.id, [...base, ...notes]);
  }
  for (const [region, list] of changed) ops.push({ op: 'setNotes', track: track.id, region, notes: list });
  return { ops, notes };
}

/** Add pitches to the chord of notes just entered (the same start and length). */
export function addToChord(project: Project, chord: Note[], pitches: EntryPitch[]): EditResult {
  const first = chord[0];
  if (!first) return { ops: [], notes: [] };
  const found = locate(project, first);
  if (!found) return { ops: [], notes: [] };
  const { track, region } = found;
  const notes = pitches
    .filter((p) => !chord.some((n) => n.p === p.p))
    .map((pitch): Note => {
      const hints: NoteNotation = { ...first.n };
      delete hints.sp;
      delete hints.ly;
      if (pitch.sp && pitch.sp[1] !== 0) hints.sp = [pitch.sp[0], pitch.sp[1], pitch.p];
      return { t: first.t, d: first.d, p: pitch.p, v: first.v, n: hints };
    });
  if (!notes.length) return { ops: [], notes: [] };
  return { ops: [{ op: 'addNotes', track: track.id, region: region.id, notes }], notes };
}

/** Where a note lives in the song. */
export function locate(project: Project, note: Note): { track: Track; region: Region } | null {
  for (const track of project.tracks)
    for (const region of track.regions) if (region.notes.includes(note)) return { track, region };
  return null;
}

/** Change notes by a function, region by region: one setNotes per region touched. */
export function mapNotes(
  project: Project,
  notes: readonly Note[],
  fn: (n: Note, track: Track, region: Region) => Note,
): EditResult {
  const wanted = new Set(notes);
  const ops: Op[] = [];
  const out: Note[] = [];
  for (const track of project.tracks) {
    for (const region of track.regions) {
      if (!region.notes.some((n) => wanted.has(n))) continue;
      const list = region.notes.map((n) => {
        if (!wanted.has(n)) return n;
        const next = fn(n, track, region);
        out.push(next);
        return next;
      });
      ops.push({ op: 'setNotes', track: track.id, region: region.id, notes: list });
    }
  }
  return { ops, notes: out };
}

/** The staff a note is on (1 when the score doesn't say). */
const staffOf = (n: Note, places: Map<Note, Place>): number => places.get(n)?.staff ?? n.n?.st ?? 1;

/** Turn an articulation on or off for notes (on for all if any lacks it), with its sound. */
export function toggleArticulation(project: Project, doc: ScoreDoc, notes: readonly Note[], art: string): EditResult {
  const places = placesOf(doc);
  const on = notes.some((n) => !n.n?.a?.includes(art));
  return mapNotes(project, notes, (n, track, region) => {
    const list = new Set(n.n?.a ?? []);
    if (on) list.add(art);
    else list.delete(art);
    const hints: NoteNotation = { ...n.n };
    if (list.size) hints.a = [...list];
    else delete hints.a;
    const shaped = n.n?.dv !== undefined && n.v !== n.n.dv;
    const next = sounded(track, staffOf(n, places), region.start + n.t, writtenLength(n), { ...n, n: hints });
    // a velocity shaped by hand stays
    return shaped ? { ...next, v: n.v, n: { ...next.n, dv: n.n?.dv } as NoteNotation } : next;
  });
}

/** Lengthen notes (a tie on): each by `by` ticks of writing, over what was there. */
export function extend(project: Project, doc: ScoreDoc, caret: Caret, notes: readonly Note[], by: number): EditResult {
  const cleared = enter(project, doc, caret, [], by);
  const places = placesOf(doc);
  const map = new Map<Note, Note>();
  const after = mapNotesIn(project, cleared.ops, notes, (n, track, region) => {
    const next = sounded(track, staffOf(n, places), region.start + n.t, writtenLength(n) + by, n);
    map.set(n, next);
    return next;
  });
  return { ops: after, notes: [...map.values()] };
}

/** Apply a change to notes on top of earlier ops (merging into their setNotes for the same region). */
function mapNotesIn(
  project: Project,
  earlier: Op[],
  notes: readonly Note[],
  fn: (n: Note, track: Track, region: Region) => Note,
): Op[] {
  const wanted = new Set(notes);
  const ops = earlier.slice();
  for (const track of project.tracks) {
    for (const region of track.regions) {
      if (!region.notes.some((n) => wanted.has(n))) continue;
      const i = ops.findIndex((o) => o.op === 'setNotes' && o.region === region.id);
      const current = i >= 0 ? (ops[i] as Extract<Op, { op: 'setNotes' }>).notes : region.notes;
      const list = current.map((n) => (wanted.has(n) ? fn(n, track, region) : n));
      const op: Op = { op: 'setNotes', track: track.id, region: region.id, notes: list };
      if (i >= 0) ops[i] = op;
      else ops.push(op);
    }
  }
  return ops;
}

/** Spell notes the other way (F♯ as G♭ and back). */
export function respell(project: Project, doc: ScoreDoc, notes: readonly Note[]): EditResult {
  const places = placesOf(doc);
  return mapNotes(project, notes, (n) => {
    const at = places.get(n);
    const part = doc.parts.find((p) => p.track === at?.track);
    const tr = part?.tr ?? [0, 0];
    // the spelling drawn now, at concert pitch
    const now = at ? transposeSpelling(at.written, -tr[0], -tr[1]) : spellAs(n.p, 0);
    const options = spellings(n.p).filter((s) => s.step !== now.step && Math.abs(s.alter) <= 1);
    const other = options[0] ?? spellings(n.p).find((s) => s.step !== now.step);
    if (!other) return n;
    return { ...n, n: { ...n.n, sp: [other.step, other.alter, n.p] } };
  });
}

/** Put notes in a voice (1–4), so they're drawn there whatever the layout would choose. */
export function setVoice(project: Project, notes: readonly Note[], voice: number): EditResult {
  return mapNotes(project, notes, (n) => {
    const hints: NoteNotation = { ...n.n };
    if (voice > 1) hints.vo = voice;
    else hints.vo = 1;
    return { ...n, n: hints };
  });
}

/**
 * A marking on a staff at a tick (in the region there, made if it must be), and the notes it
 * changes sounding as it says: a dynamic moves the velocities after it that the dynamics gave.
 */
export function addMark(
  project: Project,
  doc: ScoreDoc,
  track: string,
  staff: number,
  mark: Omit<Mark, 'st'>,
): EditResult {
  const t = project.tracks.find((x) => x.id === track);
  if (!t) return { ops: [], notes: [] };
  const part = doc.parts.find((p) => p.track === track);
  const end = mark.e ?? mark.t + 1;
  const { region, ops } = regionFor(project, t, mark.t, end);
  const m: Mark = { ...mark, t: mark.t - region.start, ...(mark.e !== undefined ? { e: mark.e - region.start } : {}) };
  if ((part?.staves.length ?? 1) > 1) m.st = staff;
  const same = (x: Mark) => x.k === m.k && x.t === m.t && (x.st ?? 1) === (m.st ?? 1);
  const marks = [
    ...(region.marks ?? []).filter((x) => !(same(x) && (m.k === 'dyn' || m.k === 'text' || m.k === 'expr'))),
    m,
  ];
  ops.push({ op: 'setMarksIn', track: track, region: region.id, from: 0, to: Number.MAX_SAFE_INTEGER, marks });
  return { ops: [...ops, ...rebake(project, doc, track, staff, marks, region.id)], notes: [] };
}

/** Velocities and lengths again for a staff's notes the markings shaped (not the ones shaped by hand). */
function rebake(
  project: Project,
  doc: ScoreDoc,
  trackId: string,
  staff: number,
  regionMarks: Mark[],
  regionId: string,
): Op[] {
  const track = project.tracks.find((x) => x.id === trackId);
  if (!track) return [];
  const withMarks: Track = {
    ...track,
    regions: track.regions.map((r) => (r.id === regionId ? { ...r, marks: regionMarks } : r)),
  };
  const places = placesOf(doc);
  const ops: Op[] = [];
  for (const region of withMarks.regions) {
    let touched = false;
    const list = region.notes.map((n) => {
      if (staffOf(n, places) !== staff || n.n?.dv === undefined || n.v !== n.n.dv) return n;
      const next = sounded(withMarks, staff, region.start + n.t, writtenLength(n), n);
      if (next.v === n.v && next.d === n.d) return n;
      touched = true;
      return next;
    });
    if (touched) ops.push({ op: 'setNotes', track: trackId, region: region.id, notes: list });
  }
  return ops;
}

/** Remove a staff's markings of some kinds in a span (a hairpin or slur taken away). */
export function removeMarks(
  project: Project,
  track: string,
  staff: number,
  from: number,
  to: number,
  kinds: Mark['k'][],
): Op[] {
  const t = project.tracks.find((x) => x.id === track);
  if (!t) return [];
  const ops: Op[] = [];
  for (const r of t.regions) {
    const marks = r.marks ?? [];
    const kept = marks.filter(
      (m) => !(kinds.includes(m.k) && (m.st ?? 1) === staff && r.start + m.t >= from && r.start + m.t < to),
    );
    if (kept.length !== marks.length)
      ops.push({ op: 'setMarksIn', track, region: r.id, from: 0, to: Number.MAX_SAFE_INTEGER, marks: kept });
  }
  return ops;
}

/** A clef from a tick on, on a track's staff. */
export function setClef(
  project: Project,
  doc: ScoreDoc,
  track: string,
  staff: number,
  tick: number,
  clef: string,
): Op[] {
  const t = project.tracks.find((x) => x.id === track);
  const part = doc.parts.find((p) => p.track === track);
  if (!t || !part) return [];
  const first = part.staves.flatMap((s) =>
    s.clefs
      .filter(([at]) => at === (doc.bars[0]?.start ?? 0))
      .map(([, c]): [number, number, string] => [0, s.local, c]),
  );
  const own = t.score?.clefs ?? first;
  const at = tick <= (doc.bars[0]?.start ?? 0) ? 0 : tick;
  const clefs = [
    ...own.filter((c) => !(c[0] === at && c[1] === staff)),
    [at, staff, clef] as [number, number, string],
  ].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return [{ op: 'updateTrack', track, patch: { score: { ...t.score, clefs } } }];
}

/** A key from a bar's start on (the first bar's sets the song's key). */
export function setKey(project: Project, tick: number, key: Pick<KeyPoint, 'fifths' | 'mode'> | null): Op[] {
  const keys = keysOf(project).filter((k) => k.tick !== tick);
  const list = key ? [...keys, { tick, ...key }].sort((a, b) => a.tick - b.tick) : keys;
  return [{ op: 'setProject', patch: { keys: list } }];
}

/** A time signature from a bar's start on. */
export function setMeter(project: Project, tick: number, num: number, den: number): Op[] {
  const point: MeterPoint = { tick, num, den };
  const first = project.meter[0];
  if (tick === 0 && first?.pickup) point.pickup = first.pickup;
  const meter = [...project.meter.filter((m) => m.tick !== tick), point].sort((a, b) => a.tick - b.tick);
  return [{ op: 'setProject', patch: { meter } }];
}

/** Where a repeat sign, ending or jump goes in a bar: at its start, or at its end (the bar line after it). */
export type FormKind =
  | 'start'
  | 'end'
  | 'ending1'
  | 'ending2'
  | 'segno'
  | 'coda'
  | 'toCoda'
  | 'fine'
  | 'dc'
  | 'dcFine'
  | 'dsCoda'
  | 'dsFine';

const AT_START = new Set<FormMark['k']>(['start', 'segno', 'coda', 'ending']);

/**
 * A repeat sign, an ending or a jump in the bar [start, end): a start sign, segno or coda where it
 * begins; an end sign, To Coda, Fine or D.C./D.S. at its end. The same kind there before is replaced;
 * a first ending brings its end repeat sign with it. `null` takes away all of them in the bar.
 */
export function setForm(project: Project, start: number, end: number, kind: FormKind | null): Op[] {
  const form = project.form ?? [];
  if (kind === null) {
    const kept = form.filter((f) => (AT_START.has(f.k) ? f.tick !== start : f.tick !== end));
    if (kept.length === form.length) return [];
    return [{ op: 'setProject', patch: { form: kept.length ? kept : null } }];
  }
  const add: FormMark[] =
    kind === 'ending1'
      ? [
          { tick: start, k: 'ending', e: end, passes: [1] },
          { tick: end, k: 'end' },
        ]
      : kind === 'ending2'
        ? [{ tick: start, k: 'ending', e: end, passes: [2] }]
        : kind === 'dc'
          ? [{ tick: end, k: 'dc' }]
          : kind === 'dcFine'
            ? [{ tick: end, k: 'dc', al: 'fine' }]
            : kind === 'dsCoda'
              ? [{ tick: end, k: 'ds', al: 'coda' }]
              : kind === 'dsFine'
                ? [{ tick: end, k: 'ds', al: 'fine' }]
                : [{ tick: AT_START.has(kind) ? start : end, k: kind }];
  const replaced = (f: FormMark) =>
    add.some(
      (a) => a.tick === f.tick && (a.k === f.k || ((a.k === 'dc' || a.k === 'ds') && (f.k === 'dc' || f.k === 'ds'))),
    );
  const next = [...form.filter((f) => !replaced(f)), ...add].sort((a, b) => a.tick - b.tick);
  return [{ op: 'setProject', patch: { form: next } }];
}

/**
 * Played-in music written as it's shown: starts and lengths moved to the grid the score shows them
 * on, and the voices kept as drawn. The Piano Roll then shows the tidy version.
 */
export function quantizeToScore(project: Project, doc: ScoreDoc, trackId: string): EditResult {
  const part = doc.parts.find((p) => p.track === trackId);
  if (!part) return { ops: [], notes: [] };
  const spans = new Map<Note, { start: number; end: number; voice: number; staff: number }>();
  for (const staff of part.staves) {
    for (const b of staff.bars) {
      for (const v of b.voices) {
        for (const e of v.events) {
          if (e.kind !== 'chord' || e.grace) continue;
          for (const h of e.heads) {
            const s = spans.get(h.ref.note);
            if (s) s.end = Math.max(s.end, e.tick + e.dur);
            else spans.set(h.ref.note, { start: e.tick, end: e.tick + e.dur, voice: v.n, staff: staff.local });
          }
        }
      }
    }
  }
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return { ops: [], notes: [] };
  return mapNotes(project, [...spans.keys()], (n, t, region) => {
    const s = spans.get(n) as { start: number; end: number; voice: number; staff: number };
    const hints: NoteNotation = { ...n.n, vo: s.voice };
    if (part.staves.length > 1) hints.st = s.staff;
    const moved = { ...n, t: s.start - region.start, n: hints };
    return sounded(t, s.staff, s.start, s.end - s.start, { ...moved, d: s.end - s.start });
  });
}

// ---- from what's typed to what sounds ----

function clefShift(clef: string): number {
  if (clef.endsWith('8vb')) return 1;
  if (clef.endsWith('8va')) return -1;
  if (clef.endsWith('15ma')) return -2;
  return 0;
}

/** The written key at a tick for a part (a transposing part's own). */
export function writtenKeyAt(project: Project, doc: ScoreDoc, track: string, tick: number): number {
  const part = doc.parts.find((p) => p.track === track);
  const key = keyAt(keysOf(project), tick);
  const f = key?.fifths ?? 0;
  if (!part || part.drums || !part.tr) return f;
  return normalFifths(f + fifthsShift(part.tr[0], part.tr[1]));
}

/** The middle line of a clef, as written (where entry starts when nothing came before). */
export function middleOf(clef: string): Spelling {
  if (clef.startsWith('F')) return { step: 1, alter: 0, octave: 3 };
  if (clef === 'C3') return { step: 0, alter: 0, octave: 4 };
  if (clef === 'C4') return { step: 5, alter: 0, octave: 3 };
  return { step: 6, alter: 0, octave: 4 };
}

/**
 * A letter typed on a staff: as written, in the key (F in D major is F♯), in the octave nearest the
 * last note written there; and what it sounds and how it's spelled at concert pitch.
 */
export function letterPitch(
  project: Project,
  doc: ScoreDoc,
  caret: Caret,
  step: number,
  near: Spelling | null,
): { written: Spelling; pitch: EntryPitch } {
  const part = doc.parts.find((p) => p.track === caret.track);
  const staff = part?.staves[caret.staff - 1];
  const clef = staff ? clefAt(staff.clefs, caret.tick) : 'G';
  const from = near ?? middleOf(clef);
  const alter = (keyAlters(writtenKeyAt(project, doc, caret.track, caret.tick))[step] as number) ?? 0;
  // the octave that puts it nearest
  let best: Spelling = { step, alter, octave: from.octave };
  for (const octave of [from.octave - 1, from.octave, from.octave + 1]) {
    const s = { step, alter, octave };
    if (Math.abs(pitchOf(s) - pitchOf(from)) < Math.abs(pitchOf(best) - pitchOf(from))) best = s;
  }
  return { written: best, pitch: fromWritten(doc, caret, best) };
}

/** A pitch as written on a part's staff → what it sounds, spelled at concert pitch. */
export function fromWritten(doc: ScoreDoc, caret: Caret, written: Spelling): EntryPitch {
  const part = doc.parts.find((p) => p.track === caret.track);
  const staff = part?.staves[caret.staff - 1];
  const clef = staff ? clefAt(staff.clefs, caret.tick) : 'G';
  const tr = part?.tr ?? [0, 0];
  const shifted = { ...written, octave: written.octave - clefShift(clef) };
  const concert = transposeSpelling(shifted, -tr[0], -tr[1]);
  return { p: pitchOf(concert), sp: [concert.step, concert.alter] };
}

/** The written note on a staff's top line under a clef (a C clef's own line is middle C). */
export function topLineOf(clef: string): Spelling {
  const base = clef.replace(/(8vb|8va|15ma)$/, '');
  const [step, octave, line] =
    base === 'F' ? [3, 3, 4] : base.startsWith('C') ? [0, 4, Number(base.slice(1)) || 3] : [4, 4, 2];
  const index = octave * 7 + step + 2 * (5 - line);
  return { step: index % 7, alter: 0, octave: Math.floor(index / 7) };
}

/** The written letter and octave a line or space down from a staff's top line (half a space each). */
export function staffPlace(clef: string, below: number): Spelling {
  const top = topLineOf(clef);
  const index = top.octave * 7 + top.step - below;
  return { step: ((index % 7) + 7) % 7, alter: 0, octave: Math.floor(index / 7) };
}

/** A syllable on a note in a verse (1…); empty takes it away. Lyrics go on a chord's top note. */
export function setLyric(project: Project, note: Note, verse: number, text: string): EditResult {
  return mapNotes(project, [note], (n) => {
    const ly = [...(n.n?.ly ?? [])];
    while (ly.length < verse) ly.push('');
    ly[verse - 1] = text.trim();
    while (ly.length && !ly[ly.length - 1]) ly.pop();
    const hints: NoteNotation = { ...n.n };
    if (ly.length) hints.ly = ly;
    else delete hints.ly;
    const out: Note = { ...n };
    if (Object.keys(hints).length) out.n = hints;
    else delete out.n;
    return out;
  });
}

/**
 * The notes a line of lyrics goes on, in order, from the voice a note is in: each chord's top note,
 * a note held by a tie only once.
 */
export function lyricLine(doc: ScoreDoc, note: Note): Note[] {
  for (const part of doc.parts) {
    for (const staff of part.staves) {
      for (const n of [1, 2, 3, 4]) {
        const tops: Note[] = [];
        for (const b of staff.bars) {
          for (const e of b.voices.find((v) => v.n === n)?.events ?? []) {
            if (e.kind !== 'chord' || e.grace) continue;
            const struck = e.heads.filter((h) => h.tie !== 'm' && h.tie !== 't');
            if (!struck.length) continue;
            const top = struck.reduce((a, h) => (h.pitch > a.pitch ? h : a));
            tops.push(top.ref.note);
          }
        }
        if (tops.includes(note) || staff.bars.some((b) => voiceHas(b.voices, n, note))) return tops;
      }
    }
  }
  return [];
}

const voiceHas = (voices: readonly { n: number; events: readonly ScoreEvent[] }[], n: number, note: Note) =>
  voices.some((v) => v.n === n && v.events.some((e) => e.kind === 'chord' && e.heads.some((h) => h.ref.note === note)));

/** A chord symbol at a tick (replacing the one there); empty takes it away. */
export function setChordSymbol(project: Project, tick: number, symbol: string): Op[] {
  const text = symbol.trim();
  const others = project.chords.filter((c) => c.tick !== tick);
  if (!text && others.length === project.chords.length) return [];
  const chords = text ? [...others, { tick, symbol: text }].sort((a, b) => a.tick - b.tick) : others;
  return [{ op: 'setProject', patch: { chords } }];
}

/** The beat after a tick, in its bar's meter (a dotted quarter in 6/8): where the next chord symbol goes. */
export function nextBeat(doc: ScoreDoc, tick: number): number {
  const bar = doc.bars.find((b) => tick >= b.start && tick < b.start + b.length) ?? doc.bars[doc.bars.length - 1];
  if (!bar) return tick + PPQ;
  const { num, den } = bar.meter;
  const beat = den === 8 && num % 3 === 0 && num > 3 ? (PPQ * 3) / 2 : (PPQ * 4) / den;
  const from = bar.start - bar.offset;
  const next = from + (Math.floor((tick - from) / beat + 1e-9) + 1) * beat;
  return next;
}
