/**
 * Writing a score as text: the same words `scoreText` prints, read back into the song. Each bar
 * replaces what the staves and voices it names have in that bar (the others keep theirs), and its
 * header adds the time, key, tempo, repeats and chords it names. A bar whose notes don't add up to
 * the bar is refused, with the reason, and the rest are written.
 */
import {
  applyOp,
  applyOps,
  type ChordMark,
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
  parseKey,
  type TempoPoint,
  type Track,
  ticksPerBar,
} from '@holo/session';
import { gateFor, isDynamic, levelAt, slurredAt, staffMarks, velocityFor } from './bake.ts';
import { setClef } from './edit.ts';
import { GM_DRUM_STAFF } from './instruments.ts';
import type { Bar, Part, ScoreDoc } from './model.ts';
import { clefAt, notate } from './notate.ts';
import { type Spelling, transposeSpelling } from './spell.ts';

export interface WriteResult {
  ops: Op[];
  /** Bar numbers written. */
  written: number[];
  /** Bars refused, with why. */
  errors: string[];
  warnings: string[];
}

const VALUE: Record<string, number> = { breve: 7680, w: 3840, h: 1920, q: 960, e: 480, s: 240, t: 120, x: 60, y: 30 };
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const STEPS = 'cdefgab';

export function parseValue(text: string): number | null {
  const m = /^(breve|[whqestxy])(\.{0,2})$/.exec(text);
  if (!m) return null;
  const base = VALUE[m[1] as string] as number;
  return base * (2 - 1 / 2 ** (m[2] as string).length);
}

/** "f#5", "bb4", "c4" as written: letter, accidental, octave. */
export function parseWrittenPitch(text: string): Spelling | null {
  const m = /^([a-g])(##|#|bb|b|x|n)?(-?\d)$/i.exec(text);
  if (!m) return null;
  const acc = (m[2] ?? '').toLowerCase();
  const alter = acc === '#' ? 1 : acc === '##' || acc === 'x' ? 2 : acc === 'b' ? -1 : acc === 'bb' ? -2 : 0;
  return { step: STEPS.indexOf((m[1] as string).toLowerCase()), alter, octave: Number(m[3]) };
}

const pitchOf = (s: Spelling) => (s.octave + 1) * 12 + (LETTER_PC[s.step] as number) + s.alter;

function clefShift(clef: string): number {
  if (clef.endsWith('8vb')) return 1;
  if (clef.endsWith('8va')) return -1;
  if (clef.endsWith('15ma')) return -2;
  return 0;
}

/** A drum written at a place on the staff: the General MIDI piece drawn there (hats before cymbals). */
function drumAt(track: Track, s: Spelling): number {
  const place = s.step + 7 * (s.octave - 4) - 6;
  const own = Object.entries(track.score?.drums ?? {}).find(([, [line]]) => line === place);
  if (own) return Number(own[0]);
  const gm = Object.entries(GM_DRUM_STAFF).find(([, [line]]) => line === place);
  return gm ? Number(gm[0]) : 38;
}

// ---- reading a line ----

interface Head {
  written: Spelling;
  tie: boolean;
}

type Token =
  | { k: 'event'; heads: Head[]; len: number; art: string[]; tie: boolean; grace?: 'a' | 'p'; full?: boolean }
  | { k: 'dyn'; v: string }
  | { k: 'hairpin'; form: 'cresc' | 'dim' }
  | { k: 'hairpinEnd' }
  | { k: 'slur' }
  | { k: 'slurEnd' }
  | { k: 'oct'; v: number }
  | { k: 'loco' }
  | { k: 'words'; text: string; place: 'text' | 'expr' }
  | { k: 'tuplet'; num: number; numbase: number }
  | { k: 'tupletEnd' };

const TOKENS = /_?"[^"]*"|\d+:\d+\{|\}|\[[^\]]*\][^\s{}]*|[^\s{}]+/g;

export function readTokens(line: string): { tokens: Token[]; error?: string } {
  const tokens: Token[] = [];
  for (const raw of line.match(TOKENS) ?? []) {
    if (raw === '|') continue;
    if (raw === '}') tokens.push({ k: 'tupletEnd' });
    else if (/^\d+:\d+\{$/.test(raw)) {
      const [num, numbase] = raw.slice(0, -1).split(':').map(Number) as [number, number];
      tokens.push({ k: 'tuplet', num, numbase });
    } else if (raw === '(') tokens.push({ k: 'slur' });
    else if (raw === ')') tokens.push({ k: 'slurEnd' });
    else if (raw === '<' || raw === '>') tokens.push({ k: 'hairpin', form: raw === '<' ? 'cresc' : 'dim' });
    else if (raw === '!') tokens.push({ k: 'hairpinEnd' });
    else if (raw === 'loco') tokens.push({ k: 'loco' });
    else if (/^(8va|8vb|15ma|15mb)$/.test(raw))
      tokens.push({ k: 'oct', v: (raw.startsWith('15') ? 15 : 8) * (raw.endsWith('b') ? -1 : 1) });
    else if (/^_?"/.test(raw))
      tokens.push({ k: 'words', text: raw.replace(/^_?"|"$/g, ''), place: raw.startsWith('_') ? 'expr' : 'text' });
    else if (isDynamic(raw)) tokens.push({ k: 'dyn', v: raw });
    else if (raw === 'R') tokens.push({ k: 'event', heads: [], len: 0, art: [], tie: false, full: true });
    else {
      const event = readEvent(raw);
      if (!event) return { tokens, error: `"${raw}" isn't a note, a rest or a marking` };
      tokens.push(event);
    }
  }
  return { tokens };
}

function readEvent(raw: string): Token | null {
  let text = raw;
  const tie = text.endsWith('~');
  if (tie) text = text.slice(0, -1);
  const colon = text.lastIndexOf(':');
  if (colon < 0) return null;
  const head = text.slice(0, colon);
  const [valueText = '', ...arts] = text.slice(colon + 1).split('+');
  const len = parseValue(valueText);
  if (len === null) return null;
  const grace: 'a' | 'p' | undefined = arts.includes('grace') ? 'a' : arts.includes('appog') ? 'p' : undefined;
  const art = arts.filter((a) => a !== 'grace' && a !== 'appog' && /^[a-z][a-z0-9-]*$/.test(a));
  const base = { k: 'event' as const, len, art, tie, ...(grace ? { grace } : {}) };
  if (head === 'r') return { ...base, heads: [] };
  const names = head.startsWith('[') ? head.slice(1, -1).trim().split(/\s+/) : [head];
  const heads: Head[] = [];
  for (const n of names) {
    const t = n.endsWith('~');
    const written = parseWrittenPitch(t ? n.slice(0, -1) : n);
    if (!written) return null;
    heads.push({ written, tie: t || tie });
  }
  return { ...base, heads };
}

// ---- writing ----

interface Address {
  part: number;
  staff: number;
  voice: number;
  /** The line named its voice (so the notes keep it). */
  named: boolean;
}

function readAddress(text: string): Address | null {
  const m = /^P(\d+)(?:\s+s(\d+))?(?:\s+v(\d+))?$/i.exec(text.trim());
  if (!m) return null;
  return { part: Number(m[1]) - 1, staff: Number(m[2] ?? 1), voice: Number(m[3] ?? 1), named: m[3] !== undefined };
}

interface Block {
  number: number;
  header: string;
  lines: string[];
}

function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*bar\s+(\d+)\b(.*)$/.exec(line);
    if (m) out.push({ number: Number(m[1]), header: (m[2] ?? '').trim(), lines: [] });
    else if (line.trim() && out.length) out.at(-1)?.lines.push(line.trim());
  }
  return out;
}

/** Where a bar is: an existing one by its number, or the next ones past the end of the song. */
function barSpan(doc: ScoreDoc, meter: readonly MeterPoint[], n: number): { start: number; length: number } {
  const bar = doc.bars.find((b) => b.number === n);
  if (bar) return { start: bar.start, length: bar.length };
  const last = doc.bars.at(-1) as Bar;
  let start = last.start + last.length;
  for (let k = last.number + 1; k < n; k++) start += ticksPerBar(meterAt(meter, start));
  return { start, length: ticksPerBar(meterAt(meter, start)) };
}

/** A song's ticks a bar header changes: the time, key, tempo, repeats and chords it names. */
function applyHeader(
  project: Project,
  span: { start: number; length: number },
  header: string,
  warnings: string[],
): Project {
  const end = span.start + span.length;
  let p = project;
  const patch: Parameters<typeof applyOp>[1] & { op: 'setProject' } = { op: 'setProject', patch: {} };
  const time = /\btime\s+(\d+)\/(\d+)(?:\s*\(([\d+\s]+)\))?/.exec(header);
  if (time) {
    const m: MeterPoint = { tick: span.start, num: Number(time[1]), den: Number(time[2]) };
    if (time[3]) m.groups = time[3].split('+').map((g) => Number(g.trim()));
    const now = meterAt(p.meter, span.start);
    if (now.num !== m.num || now.den !== m.den || (now.groups ?? []).join() !== (m.groups ?? []).join()) {
      const pickup = p.meter[0]?.pickup;
      patch.patch.meter = [...p.meter.filter((x) => x.tick !== span.start), m].sort((a, b) => a.tick - b.tick);
      if (span.start === 0 && pickup) (patch.patch.meter[0] as MeterPoint).pickup = pickup;
    }
  }
  const key = /\bkey\s+([A-Ga-g][#b]?\s+(?:major|minor|dorian|phrygian|lydian|mixolydian|locrian))/.exec(header);
  if (key) {
    const k = parseKey(key[1]);
    const keys = keysOf(p);
    const now = keyAt(keys, span.start);
    if (k && (!now || now.fifths !== k.fifths || now.mode !== k.mode)) {
      patch.patch.keys = [...keys.filter((x) => x.tick !== span.start), { tick: span.start, ...k } as KeyPoint];
    }
  }
  const tempos = [...header.matchAll(/\btempo(?:\s+(\d+(?:\.\d+)?))?(?:\s+"([^"]*)")?(?:@(\d+(?:\.\d+)?))?/g)];
  if (tempos.length) {
    let list: TempoPoint[] = p.tempo.slice();
    for (const t of tempos) {
      const unit = (PPQ * 4) / meterAt(p.meter, span.start).den;
      const tick = Math.round(span.start + (Number(t[3] ?? 1) - 1) * unit);
      const prev = list.filter((x) => x.tick <= tick).at(-1);
      const point: TempoPoint = { tick, bpm: t[1] ? Number(t[1]) : (prev?.bpm ?? 120) };
      if (t[2]) point.text = t[2];
      if (t[1]) point.mm = true;
      list = [...list.filter((x) => x.tick !== tick), point].sort((a, b) => a.tick - b.tick);
    }
    patch.patch.tempo = list;
  }
  const form: FormMark[] = [];
  if (/(^|\s)\|:/.test(header)) form.push({ tick: span.start, k: 'start' });
  const rep = /:\|(?:x(\d+))?/.exec(header);
  if (rep) form.push({ tick: end, k: 'end', ...(rep[1] ? { times: Number(rep[1]) } : {}) });
  const ending = /\bending\s+([\d,]+)/.exec(header);
  if (ending) {
    const passes = (ending[1] as string).split(',').map(Number).filter(Boolean);
    const open = (p.form ?? []).find(
      (f) => f.k === 'ending' && f.e === span.start && f.passes?.join() === passes.join(),
    );
    if (open) form.push({ ...open, e: end });
    else form.push({ tick: span.start, k: 'ending', e: end, passes });
  }
  if (/\bsegno\b/.test(header)) form.push({ tick: span.start, k: 'segno' });
  if (/(^|\s)coda\b/.test(header) && !/to coda|al coda/i.test(header.replace(/\bcoda\b.*$/, ''))) {
    if (!/to coda/i.test(header)) form.push({ tick: span.start, k: 'coda' });
  }
  if (/\bto coda\b/i.test(header)) form.push({ tick: end, k: 'toCoda' });
  if (/(^|\s)fine\b/i.test(header) && !/al fine/i.test(header)) form.push({ tick: end, k: 'fine' });
  const jump = /\b(D\.C\.|D\.S\.)(?:\s+al\s+(Fine|Coda))?/i.exec(header);
  if (jump) {
    const al = jump[2]?.toLowerCase() as 'fine' | 'coda' | undefined;
    form.push({ tick: end, k: (jump[1] as string).toUpperCase() === 'D.C.' ? 'dc' : 'ds', ...(al ? { al } : {}) });
  }
  if (form.length) {
    const same = (a: FormMark, b: FormMark) => a.tick === b.tick && a.k === b.k;
    const kept = (p.form ?? []).filter(
      (f) => !form.some((g) => same(f, g) || (g.k === 'ending' && f.k === 'ending' && f.tick === g.tick)),
    );
    patch.patch.form = [...kept, ...form];
  }
  if (/\bpickup\b/.test(header) && !p.meter[0]?.pickup)
    warnings.push('a pickup is set with `holo score pickup`, not in a bar');
  if (Object.keys(patch.patch).length) p = applyOp(p, patch);
  return p;
}

/** Everything a song needs to read bars as a part's: its part list and each line's place. */
export function writeScoreText(project: Project, text: string): WriteResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const written: number[] = [];
  const all = blocks(text);
  if (!all.length) return { ops: [], written, errors: ['no bars: start each with "bar N"'], warnings };

  // the headers first: a time change moves every bar after it
  let work = project;
  const before = notate(project);
  for (const b of all) work = applyHeader(work, barSpan(before, work.meter, b.number), b.header, warnings);
  const headerOps: Op[] = [];
  if (work !== project) {
    const patch: Record<string, unknown> = {};
    for (const k of ['meter', 'keys', 'tempo', 'form'] as const) if (work[k] !== project[k]) patch[k] = work[k];
    headerOps.push({ op: 'setProject', patch });
  }

  const doc = notate(work);
  const ops: Op[] = [...headerOps];
  const apply = (list: Op[]) => {
    work = applyOps(work, list);
    ops.push(...list);
  };
  // ties, slurs, hairpins and octave lines can run on from one bar to the next
  const open = new Map<string, OpenLine>();

  const planned: { block: Block; span: { start: number; length: number }; plans: Plan[]; chords?: string }[] = [];
  for (const block of all) {
    const span = barSpan(doc, work.meter, block.number);
    const lines = block.lines.filter((l) => /^P\d+/i.test(l));
    const lyrics = block.lines.filter((l) => /^lyrics\s/i.test(l));
    const chords = block.lines.find((l) => /^chords:/i.test(l));
    let ok = true;
    const plans: Plan[] = [];
    for (const line of lines) {
      const colon = line.indexOf(':');
      const address = readAddress(line.slice(0, colon));
      const part = address ? doc.parts[address.part] : undefined;
      if (!address || !part) {
        errors.push(`bar ${block.number}: "${line.slice(0, colon)}" isn't a part (they're P1…P${doc.parts.length})`);
        ok = false;
        continue;
      }
      const track = work.tracks.find((t) => t.id === part.track) as Track;
      const key = `${address.part}.${address.staff}.${address.voice}`;
      const state = open.get(key) ?? newOpen();
      const plan = planLine(line.slice(colon + 1), address, part, track, span, block.number, state, errors);
      if (!plan) {
        ok = false;
        continue;
      }
      open.set(key, state);
      plans.push(plan);
    }
    // a bar is written whole or not at all
    if (!ok && plans.length !== lines.length) continue;
    for (const lyric of lyrics) applyLyrics(lyric, plans, errors, block.number);
    planned.push({ block, span, plans, ...(chords ? { chords } : {}) });
  }
  // lines still open at the end close at the last bar written
  const lastEnd = planned.length ? (planned.at(-1)?.span.start ?? 0) + (planned.at(-1)?.span.length ?? 0) : 0;
  for (const state of open.values()) closeAll(state, lastEnd);

  for (const { block, span, plans, chords } of planned) {
    const end = span.start + span.length;
    // clef changes the bar names, where they change anything
    for (const line of block.lines.filter((l) => /^clef\s/i.test(l))) {
      const m = /^clef\s+(P\d+(?:\s+s\d+)?)\s+(\S+?)(?:@(\d+(?:\.\d+)?))?$/i.exec(line);
      const address = m ? readAddress(m[1] as string) : null;
      const part = address ? doc.parts[address.part] : undefined;
      const staff = part?.staves[(address?.staff ?? 1) - 1];
      if (!m || !address || !part || !staff) {
        errors.push(`bar ${block.number}: "${line}" isn't a clef line (clef P1 s2 F)`);
        continue;
      }
      const unit = (PPQ * 4) / meterAt(work.meter, span.start).den;
      const at = Math.round(span.start + (Number(m[3] ?? 1) - 1) * unit);
      if (clefAt(staff.clefs, at) !== m[2])
        apply(setClef(work, notate(work), part.track, address.staff, at, m[2] as string));
    }
    for (const plan of plans) apply(placeLine(work, doc, plan, span));
    if (chords) {
      const unit = (PPQ * 4) / meterAt(work.meter, span.start).den;
      const list: ChordMark[] = [];
      for (const c of chords
        .replace(/^chords:\s*/i, '')
        .split(/\s+/)
        .filter(Boolean)) {
        const [symbol = '', at = '1'] = c.split('@');
        list.push({ tick: Math.round(span.start + (Number(at) - 1) * unit), symbol });
      }
      apply([
        {
          op: 'setProject',
          patch: {
            chords: [...work.chords.filter((c) => c.tick < span.start || c.tick >= end), ...list].sort(
              (a, b) => a.tick - b.tick,
            ),
          },
        },
      ]);
    }
    written.push(block.number);
  }
  return { ops, written, errors, warnings };
}

/** A slur, hairpin or octave line still open: where it starts, and the bar's marks it goes into. */
interface Running {
  t: number;
  into: Mark[];
  mark: Omit<Mark, 't'>;
}

interface OpenLine {
  /** Notes still tied into the next bar, by pitch. */
  ties: Map<number, Note & { _start: number }>;
  slur: Running | null;
  hairpin: Running | null;
  oct: Running | null;
  /** The last note's start, for closing a line on it. */
  last: number | null;
}

const newOpen = (): OpenLine => ({ ties: new Map(), slur: null, hairpin: null, oct: null, last: null });

function close(run: Running | null, at: number | null): void {
  if (!run || run.t < 0 || at === null || at <= run.t) return;
  run.into.push({ ...run.mark, t: run.t, e: at } as Mark);
}

function closeAll(state: OpenLine, end: number): void {
  close(state.slur, state.last);
  close(state.hairpin, end);
  close(state.oct, state.last);
  state.slur = state.hairpin = state.oct = null;
}

interface Plan {
  address: Address;
  part: Part;
  track: Track;
  /** New notes (song ticks) and marks (song ticks), and the notes continuing ties from before. */
  notes: (Note & { _start: number })[];
  marks: Mark[];
  /** Chords in order (for lyrics): each one's notes. */
  chords: Note[][];
}

function planLine(
  body: string,
  address: Address,
  part: Part,
  track: Track,
  span: { start: number; length: number },
  number: number,
  state: OpenLine,
  errors: string[],
): Plan | null {
  const { tokens, error } = readTokens(body);
  if (error) {
    errors.push(`bar ${number} P${address.part + 1}: ${error}`);
    return null;
  }
  const staff = part.staves[address.staff - 1];
  if (!staff) {
    errors.push(`bar ${number} P${address.part + 1}: there's no staff ${address.staff}`);
    return null;
  }
  const tr = part.tr ?? [0, 0];
  const marks: Mark[] = [];
  const notes: (Note & { _start: number })[] = [];
  const chords: Note[][] = [];
  const st = part.staves.length > 1 ? address.staff : undefined;
  const vo = address.named ? address.voice : undefined;
  const place = (m: Mark): Mark => ({ ...m, ...(st ? { st } : {}), ...(vo ? { vo } : {}) });
  let t = 0;
  let ratio: { num: number; numbase: number } | null = null;
  const pending: Mark[] = [];
  const ties = new Map<number, Note & { _start: number }>();
  // a line opened here waits for the next note to know where it starts
  const opening: Running[] = [];
  const begin = (mark: Omit<Mark, 't'>): Running => {
    const run: Running = { t: -1, into: marks, mark: place({ t: 0, ...mark } as Mark) };
    opening.push(run);
    return run;
  };
  for (const tok of tokens) {
    switch (tok.k) {
      case 'tuplet':
        ratio = { num: tok.num, numbase: tok.numbase };
        break;
      case 'tupletEnd':
        ratio = null;
        break;
      case 'dyn':
        pending.push({ t: 0, k: 'dyn', v: tok.v });
        break;
      case 'hairpin':
        close(state.hairpin, span.start + t);
        state.hairpin = begin({ k: tok.form });
        break;
      case 'hairpinEnd':
        if (state.hairpin && state.hairpin.t < 0) state.hairpin.t = span.start + t;
        close(state.hairpin, span.start + t);
        state.hairpin = null;
        break;
      case 'slur':
        state.slur = begin({ k: 'slur' });
        break;
      case 'slurEnd':
        close(state.slur, state.last);
        state.slur = null;
        break;
      case 'oct':
        state.oct = begin({ k: 'oct', v: tok.v });
        break;
      case 'loco':
        close(state.oct, state.last);
        state.oct = null;
        break;
      case 'words':
        pending.push({ t: 0, k: tok.place, v: tok.text });
        break;
      case 'event': {
        const at = span.start + t;
        for (const m of pending) marks.push(place({ ...m, t: at }));
        pending.length = 0;
        for (const run of opening) run.t = at;
        opening.length = 0;
        if (tok.full) {
          t = span.length;
          break;
        }
        const len = ratio ? (tok.len * ratio.numbase) / ratio.num : tok.len;
        const chord: Note[] = [];
        if (!tok.grace) state.last = at;
        const octave = state.oct
          ? Math.sign(Number(state.oct.mark.v)) * (Math.abs(Number(state.oct.mark.v)) === 15 ? 2 : 1)
          : 0;
        for (const h of tok.heads) {
          const clef = clefAt(staff.clefs, at);
          const writtenPitch = pitchOf(h.written);
          const p = part.drums ? drumAt(track, h.written) : writtenPitch - tr[0] - 12 * clefShift(clef) + 12 * octave;
          // a note tied from before grows instead of starting again
          const held = state.ties.get(p);
          if (held && held._start + held.d === at && !tok.grace) {
            held.d += len;
            state.ties.delete(p);
            if (h.tie) ties.set(p, held);
            chord.push(held);
            continue;
          }
          const n: Note & { _start: number } = { _start: at, t: at, d: tok.grace ? 90 : len, p, v: 80 };
          const hints: NoteNotation = {};
          if (!part.drums && h.written.alter !== 0) {
            const concert = transposeSpelling(
              { ...h.written, octave: h.written.octave - clefShift(clef) + octave },
              -tr[0],
              -tr[1],
            );
            hints.sp = [concert.step, concert.alter, p];
          }
          if (tok.art.length) hints.a = tok.art;
          if (tok.grace) hints.g = tok.grace;
          if (vo) hints.vo = vo;
          if (st) hints.st = st;
          n.n = hints;
          if (tok.grace) n.t = n._start = Math.max(span.start, at - 90);
          if (h.tie) ties.set(p, n);
          notes.push(n);
          chord.push(n);
        }
        if (chord.length && !tok.grace) chords.push(chord);
        if (!tok.grace) t += len;
        break;
      }
    }
  }
  // what runs on into the next bar
  state.ties = ties;
  for (const m of pending) marks.push(place({ ...m, t: span.start + t }));
  for (const run of opening) run.t = span.start + t;
  const total = Math.round(t);
  if (total !== Math.round(span.length)) {
    const beats = (x: number) => Math.round((x / PPQ) * 100) / 100;
    errors.push(
      `bar ${number} P${address.part + 1}${part.staves.length > 1 ? ` s${address.staff}` : ''}${address.named ? ` v${address.voice}` : ''}: ` +
        `its notes and rests add up to ${beats(total)} quarter beats, the bar has ${beats(span.length)}`,
    );
    return null;
  }
  return { address, part, track, notes, marks, chords };
}

function applyLyrics(line: string, plans: Plan[], errors: string[], number: number): void {
  const m = /^lyrics\s+(P\d+(?:\s+s\d+)?(?:\s+v\d+)?)\s+(\d+):\s*(.*)$/i.exec(line);
  if (!m) {
    errors.push(`bar ${number}: "${line}" isn't a lyrics line (lyrics P1 1: Hal- le- lu- jah)`);
    return;
  }
  const address = readAddress(m[1] as string);
  const verse = Number(m[2]) - 1;
  const plan = plans.find(
    (p) =>
      address &&
      p.address.part === address.part &&
      p.address.staff === address.staff &&
      p.address.voice === address.voice,
  );
  if (!plan) return;
  const syllables = (m[3] as string).split(/\s+/).filter(Boolean);
  plan.chords.forEach((chord, i) => {
    const syl = syllables[i];
    const top = chord.reduce((a, b) => (b.p > a.p ? b : a));
    if (!syl || syl === '*') return;
    const ly = (top.n?.ly ?? []).slice();
    while (ly.length < verse) ly.push('');
    ly[verse] = syl;
    top.n = { ...top.n, ly };
  });
}

/**
 * A line's notes into the song: the region under the bar (made or lengthened if it must be), the
 * notes the staff and voice had in the bar replaced, the rest kept, velocities and lengths from the
 * dynamics and articulations.
 */
function placeLine(work: Project, doc: ScoreDoc, plan: Plan, span: { start: number; length: number }): Op[] {
  const out: Op[] = [];
  const end = span.start + span.length;
  const track = work.tracks.find((t) => t.id === plan.track.id) as Track;
  let region = track.regions.find((r) => !r.audio && r.start <= span.start && r.start + r.length >= end);
  if (!region) {
    const touching = track.regions.find((r) => !r.audio && r.start <= span.start && r.start + r.length >= span.start);
    if (touching) {
      out.push({ op: 'updateRegion', track: track.id, region: touching.id, patch: { length: end - touching.start } });
      region = { ...touching, length: end - touching.start };
    } else {
      region = newRegion(span.start, span.length, '');
      out.push({ op: 'addRegion', track: track.id, region });
    }
  }
  const r0 = region.start;
  // what the staff and voice had here goes; the other staves' and voices' notes stay
  const drop = new Set<Note>();
  const part = doc.parts.find((p) => p.track === track.id);
  const staff = part?.staves[plan.address.staff - 1];
  const index = doc.bars.findIndex((b) => b.start === span.start);
  for (const v of (index >= 0 ? staff?.bars[index]?.voices : undefined) ?? []) {
    if (v.n !== plan.address.voice) continue;
    for (const e of v.events) if (e.kind === 'chord') for (const h of e.heads) drop.add(h.ref.note);
  }
  const from = span.start - r0;
  const to = end - r0;
  const kept = region.notes.filter((n) => n.t >= from && n.t < to && !drop.has(n));
  // the dynamics, written and already there, on this staff
  const marksHere = [
    ...staffMarks(track, plan.address.staff).filter((m) => m.t < span.start || m.t >= end),
    ...plan.marks,
  ].sort((a, b) => a.t - b.t);
  const fresh: Note[] = plan.notes
    .filter((n) => n._start >= span.start)
    .map((n) => {
      const art = n.n?.a ?? [];
      const level = levelAt(marksHere, n._start);
      const v = velocityFor(level, art);
      const written = n.d;
      const sounding = n.n?.g ? n.d : Math.max(1, Math.round(written * gateFor(art, slurredAt(marksHere, n._start))));
      const hints: NoteNotation = { ...n.n, dv: v };
      if (sounding !== written) hints.w = [written, sounding];
      return { t: n._start - r0, d: sounding, p: n.p, v, n: hints };
    });
  // notes tied on from an earlier bar were lengthened there: fix their sounding length too
  out.push({ op: 'setNotesIn', track: track.id, region: region.id, from, to, notes: [...kept, ...fresh] });
  const markKeep = (region.marks ?? []).filter((m) => m.t >= from && m.t < to && (m.st ?? 1) !== plan.address.staff);
  const markOther = (region.marks ?? []).filter(
    (m) =>
      m.t >= from &&
      m.t < to &&
      (m.st ?? 1) === plan.address.staff &&
      m.vo !== undefined &&
      m.vo !== plan.address.voice,
  );
  const newMarks = plan.marks.map((m) => ({ ...m, t: m.t - r0, ...(m.e !== undefined ? { e: m.e - r0 } : {}) }));
  out.push({
    op: 'setMarksIn',
    track: track.id,
    region: region.id,
    from,
    to,
    marks: [...markKeep, ...markOther, ...newMarks],
  });
  return out;
}
