/**
 * A laid-out score as MEI, the encoding Verovio draws. Every note, chord and rest keeps its id, so
 * what's clicked on the drawing is a note in the song. A window of bars can be written on its own
 * (the score view draws only what's on screen), starting with the clefs, keys and meter in force there.
 */
import { type KeyPoint, PPQ } from '@holo/session';
import type { Bar, ChordEvent, Control, Head, Part, ScoreDoc, ScoreEvent, Staff } from './model.ts';
import { barIndexAt, clefAt } from './notate.ts';
import { fifthsShift, letterOf, normalFifths } from './spell.ts';

export interface MeiOptions {
  /** Bars to write, by index: [from, to). All of them when unset. */
  from?: number;
  to?: number;
  /** Write the title and credits (for pages and print). */
  credits?: boolean;
  /** Write the parts' names beside their staves (the default), or leave them out (narrow screens). */
  labels?: boolean;
  /** Bars of rest one after another drawn as one bar with their count (a part to play from). */
  multiRest?: boolean;
  /** Under the title (a part's name on its pages). */
  heading?: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const attrs = (a: Record<string, string | number | undefined | false>): string =>
  Object.entries(a)
    .filter(([, v]) => v !== undefined && v !== false && v !== '')
    .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
    .join('');

const ACCID: Record<string, string> = { '-2': 'ff', '-1': 'f', '0': 'n', '1': 's', '2': 'x' };
const ACCID_GES: Record<string, string> = { '-2': 'ff', '-1': 'f', '1': 's', '2': 'ss' };

const ARTIC: Record<string, string> = {
  stacc: 'stacc',
  staccis: 'stacciss',
  ten: 'ten',
  acc: 'acc',
  marc: 'marc',
  up: 'upbow',
  down: 'dnbow',
  open: 'open',
  stop: 'stop',
  harm: 'harm',
  snap: 'snap',
};

const HEADS: Record<string, string> = {
  x: 'x',
  'circle-x': 'x',
  diamond: 'diamond',
  slash: 'slash',
  triangle: 'isotriangle',
  square: 'square',
};

export function clefAttrs(clef: string, prefix = 'clef.'): Record<string, string | number | undefined> {
  const dis = clef.endsWith('8vb') || clef.endsWith('8va') ? 8 : clef.endsWith('15ma') ? 15 : undefined;
  const place = clef.endsWith('8vb') ? 'below' : dis ? 'above' : undefined;
  const base = clef.replace(/(8vb|8va|15ma)$/, '');
  if (base === 'perc') return { [`${prefix}shape`]: 'perc', [`${prefix}line`]: 3 };
  if (base === 'tab') return { [`${prefix}shape`]: 'TAB', [`${prefix}line`]: 5 };
  const shape = base[0] ?? 'G';
  const line = base.length > 1 ? Number(base.slice(1)) : shape === 'F' ? 4 : shape === 'C' ? 3 : 2;
  return { [`${prefix}shape`]: shape, [`${prefix}line`]: line, [`${prefix}dis`]: dis, [`${prefix}dis.place`]: place };
}

const keySig = (fifths: number): string => (fifths === 0 ? '0' : `${Math.abs(fifths)}${fifths > 0 ? 's' : 'f'}`);

function writtenKey(key: KeyPoint | null, part: Part): number {
  const f = key?.fifths ?? 0;
  if (part.drums) return 0;
  return part.tr ? normalFifths(f + fifthsShift(part.tr[0], part.tr[1])) : f;
}

/** Beats (in the meter's unit) from the bar's start, 1-based, as MEI counts them. */
const tstamp = (bar: Bar, tick: number): number => {
  const unit = (PPQ * 4) / bar.meter.den;
  return Math.round((1 + (tick - bar.start) / unit) * 1000) / 1000;
};

export function toMEI(doc: ScoreDoc, opts: MeiOptions = {}): string {
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(doc.bars.length, opts.to ?? doc.bars.length);
  const first = doc.bars[from];
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">');
  out.push('<meiHead><fileDesc><titleStmt>');
  if (opts.credits !== false) {
    out.push(`<title>${esc(doc.title)}</title>`);
    if (doc.credits.subtitle) out.push(`<title type="subordinate">${esc(doc.credits.subtitle)}</title>`);
    if (opts.heading) out.push(`<title type="subordinate">${esc(opts.heading)}</title>`);
    // (the page head Verovio draws reads these)
    if (doc.credits.composer) out.push(`<composer>${esc(doc.credits.composer)}</composer>`);
    if (doc.credits.lyricist) out.push(`<lyricist>${esc(doc.credits.lyricist)}</lyricist>`);
    if (doc.credits.arranger) out.push(`<arranger>${esc(doc.credits.arranger)}</arranger>`);
  } else out.push('<title/>');
  out.push('</titleStmt><pubStmt/></fileDesc></meiHead>');
  out.push('<music><body><mdiv><score>');
  if (!first) {
    out.push('</score></mdiv></body></music></mei>');
    return out.join('\n');
  }
  // the score's setup where the window starts
  out.push(`<scoreDef${attrs({ 'meter.count': first.meter.num, 'meter.unit': first.meter.den })}>`);
  out.push('<staffGrp>');
  const named = opts.labels !== false;
  for (const part of doc.parts) {
    const all = part.tab ? [...part.staves, part.tab] : part.staves;
    const defs = all.map((s) => staffDef(s, part, first, named && all.length === 1));
    if (all.length > 1) {
      const label = named
        ? `<label>${esc(part.name)}</label>${part.abbr ? `<labelAbbr>${esc(part.abbr)}</labelAbbr>` : ''}`
        : '';
      // a grand staff braced; a staff and its tab bracketed
      const symbol = part.staves.length > 1 ? 'brace' : 'bracket';
      out.push(`<staffGrp${attrs({ symbol, 'bar.thru': 'true' })}>${label}${defs.join('')}</staffGrp>`);
    } else out.push(defs.join(''));
  }
  out.push('</staffGrp></scoreDef>');
  out.push('<section>');
  let endingLeft = 0;
  for (let b = from; b < to; b++) {
    const bar = doc.bars[b] as Bar;
    // a new system or page starts with this bar
    if (b > from && bar.break) out.push(bar.break === 'page' ? '<pb/>' : '<sb/>');
    const rests = opts.multiRest ? restRun(doc, b, to) : 1;
    if (rests > 1) {
      out.push(multiRest(doc, bar, rests, (doc.bars[b + rests - 1] as Bar).right === 'final'));
      b += rests - 1;
      continue;
    }
    // changes of meter and key between bars
    if (b > from && (bar.showMeter || bar.showKey)) {
      const meter = bar.showMeter ? { 'meter.count': bar.meter.num, 'meter.unit': bar.meter.den } : {};
      out.push(`<scoreDef${attrs(meter)}>`);
      if (bar.showKey) {
        out.push('<staffGrp>');
        for (const part of doc.parts) {
          for (const s of part.staves) {
            if (!s.tab) out.push(`<staffDef${attrs({ n: s.n, 'key.sig': keySig(writtenKey(bar.key, part)) })}/>`);
          }
        }
        out.push('</staffGrp>');
      }
      out.push('</scoreDef>');
    }
    if (bar.ending && endingLeft === 0) {
      out.push(`<ending${attrs({ n: bar.ending.passes.join(','), label: bar.ending.label })}>`);
      endingLeft = bar.ending.bars;
    }
    out.push(measure(doc, bar));
    if (endingLeft > 0) {
      endingLeft--;
      if (endingLeft === 0 || b === to - 1) {
        out.push('</ending>');
        endingLeft = 0;
      }
    }
  }
  out.push('</section>');
  out.push('</score></mdiv></body></music></mei>');
  return out.join('\n');
}

/** Whether a bar is only rests in every part, with nothing else written in it or at its lines. */
function empty(doc: ScoreDoc, bar: Bar): boolean {
  if (bar.showMeter || bar.showKey || bar.ending || bar.times) return false;
  if (bar.left !== 'single' || (bar.right !== 'single' && bar.right !== 'final')) return false;
  if (bar.tempos.length || bar.chords.length || bar.jumps.length || bar.controls.length) return false;
  return doc.parts.every((p) =>
    p.staves.every((s) => {
      const voices = s.bars[bar.index]?.voices ?? [];
      return voices.every((v) => v.events.every((e) => e.kind === 'rest' && e.full));
    }),
  );
}

/** How many bars of rest start at bar `b` (before `to`), when there are two or more; else 1. */
function restRun(doc: ScoreDoc, b: number, to: number): number {
  let n = 0;
  while (b + n < to && empty(doc, doc.bars[b + n] as Bar)) {
    // (a final bar line or a new system ends a run there)
    const bar = doc.bars[b + n] as Bar;
    n++;
    if (bar.right === 'final' || doc.bars[b + n]?.break) break;
  }
  return n > 1 ? n : 1;
}

/** Bars of rest as one: their count over a long rest. */
function multiRest(doc: ScoreDoc, bar: Bar, n: number, last: boolean): string {
  const staves = doc.parts
    .flatMap((p) => (p.tab ? [...p.staves, p.tab] : p.staves))
    .map((s) => `<staff${attrs({ n: s.n })}><layer n="1"><multiRest${attrs({ num: n })}/></layer></staff>`);
  return `<measure${attrs({ 'xml:id': `b${bar.index}`, n: bar.number, right: last ? 'end' : undefined })}>${staves.join('')}</measure>`;
}

const COURSE = ['c', 'c', 'd', 'd', 'e', 'f', 'f', 'g', 'g', 'a', 'a', 'b'];

function staffDef(staff: Staff, part: Part, bar: Bar, named: boolean): string {
  const clef = clefAt(staff.clefs, bar.start);
  const label = named
    ? `<label>${esc(part.name)}</label>${part.abbr ? `<labelAbbr>${esc(part.abbr)}</labelAbbr>` : ''}`
    : '';
  if (staff.tab) {
    // a tab staff: a line a string, the open strings named (sounding pitch; a capo raises them)
    const { tuning, capo } = staff.tab;
    const courses = tuning
      .map((p, i) => {
        const q = Math.round(p) + capo;
        const pc = ((q % 12) + 12) % 12;
        return `<course${attrs({ n: i + 1, pname: COURSE[pc], accid: [1, 3, 6, 8, 10].includes(pc) ? 's' : undefined, oct: Math.floor(q / 12) - 1 })}/>`;
      })
      .join('');
    const a = { n: staff.n, lines: tuning.length, notationtype: 'tab.guitar', ...clefAttrs('tab') };
    return `<staffDef${attrs(a)}>${label}<tuning>${courses}</tuning></staffDef>`;
  }
  const a: Record<string, string | number | undefined> = {
    n: staff.n,
    lines: clef === 'tab' ? 6 : 5,
    'key.sig': keySig(writtenKey(bar.key, part)),
    ...clefAttrs(clef),
  };
  return `<staffDef${attrs(a)}>${label}</staffDef>`;
}

function measure(doc: ScoreDoc, bar: Bar): string {
  const full = (bar.meter.num * PPQ * 4) / bar.meter.den;
  const right =
    bar.right === 'end'
      ? 'rptend'
      : bar.right === 'start-end'
        ? 'rptboth'
        : bar.right === 'double'
          ? 'dbl'
          : bar.right === 'final'
            ? 'end'
            : undefined;
  const out: string[] = [];
  out.push(
    `<measure${attrs({
      'xml:id': `b${bar.index}`,
      n: bar.number,
      metcon: bar.length !== full ? 'false' : undefined,
      left: bar.left === 'start' ? 'rptstart' : undefined,
      right,
    })}>`,
  );
  for (const part of doc.parts) {
    for (const staff of part.tab ? [...part.staves, part.tab] : part.staves) {
      const sb = staff.bars[bar.index];
      // the tab under a staff: its notes again, as frets only (the staff above has their rhythm)
      const mode: Mode = staff === part.tab ? 'frets' : staff.tab ? 'tab' : 'notes';
      out.push(`<staff${attrs({ n: staff.n })}>`);
      for (const voice of sb?.voices ?? []) {
        out.push(`<layer${attrs({ n: voice.n })}>`);
        const clefsHere = staff.tab
          ? []
          : staff.clefs.filter(([t]) => t > bar.start - 1 && t < bar.start + bar.length && t !== staff.clefs[0]?.[0]);
        out.push(layer(voice.events, voice.n === 1 ? clefsHere : [], mode, staff.clefs));
        out.push('</layer>');
      }
      out.push('</staff>');
    }
  }
  // what's written over the bar
  const top = doc.parts[0]?.staves[0]?.n ?? 1;
  for (const t of bar.tempos) {
    const text = [t.text, t.mm ? `♩ = ${Math.round(t.bpm)}` : ''].filter(Boolean).join(' ');
    if (!text) continue;
    out.push(
      `<tempo${attrs({ staff: top, tstamp: tstamp(bar, t.tick), place: 'above', mm: t.mm ? Math.round(t.bpm) : undefined, 'mm.unit': t.mm ? 4 : undefined })}>${esc(text)}</tempo>`,
    );
  }
  for (const c of bar.chords)
    out.push(`<harm${attrs({ staff: top, tstamp: tstamp(bar, c.tick), place: 'above' })}>${esc(c.symbol)}</harm>`);
  for (const j of bar.jumps) {
    if (j.k === 'segno' || j.k === 'coda') {
      out.push(`<repeatMark${attrs({ staff: top, tstamp: tstamp(bar, j.at), func: j.k, place: 'above' })}/>`);
    } else {
      const at = Math.min(tstamp(bar, j.at), tstamp(bar, bar.start + bar.length) - 0.001);
      out.push(
        `<dir${attrs({ staff: top, tstamp: at, place: 'above' })}><rend fontstyle="italic">${esc(j.text)}</rend></dir>`,
      );
    }
  }
  if (bar.times)
    out.push(
      `<dir${attrs({ staff: top, tstamp: tstamp(bar, bar.start + bar.length) - 0.001, place: 'above' })}>×${bar.times}</dir>`,
    );
  for (const c of bar.controls) out.push(control(doc, bar, c));
  out.push('</measure>');
  return out.join('\n');
}

/** How a staff's events are written: notes; tab (frets with their rhythm); frets alone, under a staff. */
type Mode = 'notes' | 'tab' | 'frets';

/**
 * How many octaves an octave clef's notes sound from where they're written: Verovio places a note by
 * the octave it sounds in (the clef's 8 moves it on the staff), the score keeps the written one.
 */
const clefOctaves = (clef: string) => (/8vb$/.test(clef) ? -1 : /8va$/.test(clef) ? 1 : /15ma$/.test(clef) ? 2 : 0);

function layer(
  events: ScoreEvent[],
  clefs: [number, string][],
  mode: Mode = 'notes',
  staffClefs: [number, string][] = [],
): string {
  if (mode === 'frets') return events.map(frets).join('');
  const out: string[] = [];
  let tuplet: number | null = null;
  let beamId: number | null = null;
  const pendingClefs = clefs.slice();
  for (const e of events) {
    const tup = e.tuplet?.id ?? null;
    const bm = e.beam ?? null;
    // close what this event isn't part of: the beam first (it sits inside a tuplet)
    if (beamId !== null && bm !== beamId) {
      out.push('</beam>');
      beamId = null;
    }
    if (tuplet !== null && tup !== tuplet) {
      if (beamId !== null) {
        out.push('</beam>');
        beamId = null;
      }
      out.push('</tuplet>');
      tuplet = null;
    }
    while (pendingClefs.length && (pendingClefs[0] as [number, string])[0] <= e.tick) {
      const [, clef] = pendingClefs.shift() as [number, string];
      out.push(`<clef${attrs(clefAttrs(clef, ''))}/>`);
    }
    if (tup !== null && tuplet === null && e.tuplet) {
      out.push(`<tuplet${attrs({ num: e.tuplet.ratio.num, numbase: e.tuplet.ratio.numbase, 'num.format': 'count' })}>`);
      tuplet = tup;
    }
    if (bm !== null && beamId === null) {
      out.push('<beam>');
      beamId = bm;
    }
    out.push(
      e.kind === 'rest' ? rest(e) : mode === 'tab' ? tabGroup(e) : chord(e, clefOctaves(clefAt(staffClefs, e.tick))),
    );
  }
  if (beamId !== null) out.push('</beam>');
  if (tuplet !== null) out.push('</tuplet>');
  return out.join('');
}

const dur = (value: number): string => (value === 0.5 ? 'breve' : String(value));

function rest(e: Extract<ScoreEvent, { kind: 'rest' }>): string {
  if (e.full) return `<mRest${attrs({ 'xml:id': e.id })}/>`;
  return `<rest${attrs({ 'xml:id': e.id, dur: dur(e.value), dots: e.dots || undefined })}/>`;
}

function chord(e: ChordEvent, octaves = 0): string {
  const artic = e.artic
    .map((a) => ARTIC[a])
    .filter(Boolean)
    .join(' ');
  const trem = e.artic.find((a) => /^trem[1-4]$/.test(a));
  const shared = {
    dur: dur(e.value),
    dots: e.dots || undefined,
    grace: e.grace === 'a' ? 'unacc' : e.grace === 'p' ? 'acc' : undefined,
    'stem.mod': trem ? `${trem.slice(4)}slash` : e.grace === 'a' ? '1slash' : undefined,
    'stem.dir': e.stem,
    artic: artic || undefined,
  };
  const verses = (e.lyrics ?? [])
    .map((text, i) => {
      if (!text) return '';
      const joins = text.endsWith('-');
      const holds = text.endsWith('_');
      const syl = text.replace(/[-_]$/, '');
      return `<verse${attrs({ n: i + 1 })}><syl${attrs({ con: joins ? 'd' : holds ? 'u' : undefined, wordpos: joins ? 'i' : undefined })}>${esc(syl)}</syl></verse>`;
    })
    .join('');
  if (e.heads.length === 1) {
    const h = e.heads[0] as Head;
    return `<note${attrs({ 'xml:id': h.id, ...noteAttrs(h, octaves), ...shared })}>${verses}</note>`;
  }
  const heads = e.heads.map((h) => `<note${attrs({ 'xml:id': h.id, ...noteAttrs(h, octaves) })}/>`).join('');
  return `<chord${attrs({ 'xml:id': e.id, ...shared })}>${heads}${verses}</chord>`;
}

/** A note's string and fret, for a tab staff. */
const fretAttrs = (h: Head) => ({ 'tab.course': h.tab?.[0], 'tab.fret': h.tab?.[1] });

/** The notes that start here, with a string and fret (a tied note isn't played again). */
const struck = (e: ChordEvent) => e.heads.filter((h) => h.tab && h.tie !== 'm' && h.tie !== 't');

/** Under a staff: the frets where notes are played (no rhythm: the staff has it), space elsewhere. */
function frets(e: ScoreEvent): string {
  const shared = { dur: dur(e.value), dots: e.dots || undefined };
  if (e.kind === 'rest') return e.full ? '<mSpace/>' : `<space${attrs(shared)}/>`;
  const heads = struck(e);
  if (!heads.length) return `<space${attrs(shared)}/>`;
  const notes = heads.map((h) => `<note${attrs({ 'xml:id': h.id, ...fretAttrs(h) })}/>`).join('');
  return `<tabGrp${attrs({ 'xml:id': e.id, ...shared })}>${notes}</tabGrp>`;
}

/** Tab on its own: the frets, with the rhythm drawn above them. */
function tabGroup(e: ChordEvent): string {
  const heads = struck(e);
  const shared = { 'xml:id': e.id, dur: dur(e.value), dots: e.dots || undefined };
  if (!heads.length) return `<space${attrs({ dur: dur(e.value), dots: e.dots || undefined })}/>`;
  const notes = heads.map((h) => `<note${attrs({ 'xml:id': h.id, ...fretAttrs(h) })}/>`).join('');
  return `<tabGrp${attrs(shared)}><tabDurSym/>${notes}</tabGrp>`;
}

function noteAttrs(h: Head, octaves = 0): Record<string, string | number | undefined> {
  return {
    pname: letterOf(h.step).toLowerCase(),
    oct: h.octave + octaves,
    accid: h.accid !== undefined ? ACCID[String(h.accid)] : undefined,
    'accid.ges': h.accid === undefined && h.alter !== 0 ? ACCID_GES[String(h.alter)] : undefined,
    tie: h.tie,
    'head.shape': h.head ? HEADS[h.head] : undefined,
  };
}

/** A chord's id from a head's (a single note is drawn as the note, so markings point at it). */
function anchor(doc: ScoreDoc, id: string): string {
  for (const part of doc.parts) {
    for (const s of part.staves) {
      for (const b of s.bars) {
        for (const v of b.voices) {
          for (const e of v.events) {
            if (e.id === id) return e.kind === 'chord' && e.heads.length === 1 ? (e.heads[0] as Head).id : e.id;
          }
        }
      }
    }
  }
  return id;
}

function control(doc: ScoreDoc, bar: Bar, c: Control): string {
  const ref = (id: string) => `#${anchor(doc, id)}`;
  switch (c.kind) {
    case 'dyn':
      return `<dynam${attrs({ staff: c.staff, tstamp: tstamp(bar, c.tick) })}>${esc(c.value)}</dynam>`;
    case 'hairpin': {
      const endBar = doc.bars[barIndexAt(doc.bars, c.end - 1)] as Bar;
      const measures = endBar.index - bar.index;
      return `<hairpin${attrs({ form: c.form, staff: c.staff, tstamp: tstamp(bar, c.tick), tstamp2: `${measures}m+${tstamp(endBar, c.end)}` })}/>`;
    }
    case 'slur':
    case 'gliss':
      return `<${c.kind}${attrs({ staff: c.staff, startid: ref(c.start), endid: ref(c.end) })}/>`;
    case 'words':
      return `<dir${attrs({ staff: c.staff, tstamp: tstamp(bar, c.tick), place: c.place })}>${c.place === 'below' ? `<rend fontstyle="italic">${esc(c.text)}</rend>` : esc(c.text)}</dir>`;
    case 'octave':
      return `<octave${attrs({ staff: c.staff, startid: ref(c.start), endid: ref(c.end), dis: c.dis, 'dis.place': c.place })}/>`;
    case 'breath':
    case 'caesura':
      return `<${c.kind}${attrs({ staff: c.staff, tstamp: tstamp(bar, c.tick) })}/>`;
    case 'fermata':
    case 'trill':
    case 'turn':
      return `<${c.kind}${attrs({ staff: c.staff, startid: ref(c.start) })}/>`;
    case 'mordent':
      return `<mordent${attrs({ staff: c.staff, startid: ref(c.start), form: c.form })}/>`;
    case 'arpeg':
      return `<arpeg${attrs({ staff: c.staff, plist: ref(c.start), startid: ref(c.start) })}/>`;
    case 'pedal':
      return `<pedal${attrs({ staff: c.staff, tstamp: tstamp(bar, c.tick), dir: c.dir })}/>`;
  }
}
