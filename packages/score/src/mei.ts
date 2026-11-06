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
    const resp: string[] = [];
    if (doc.credits.composer) resp.push(`<persName role="composer">${esc(doc.credits.composer)}</persName>`);
    if (doc.credits.lyricist) resp.push(`<persName role="lyricist">${esc(doc.credits.lyricist)}</persName>`);
    if (doc.credits.arranger) resp.push(`<persName role="arranger">${esc(doc.credits.arranger)}</persName>`);
    if (resp.length) out.push(`<respStmt>${resp.join('')}</respStmt>`);
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
  for (const part of doc.parts) {
    const defs = part.staves.map((s) => staffDef(s, part, first));
    if (part.staves.length > 1) {
      out.push(
        `<staffGrp${attrs({ symbol: 'brace', 'bar.thru': 'true' })}><label>${esc(part.name)}</label>${part.abbr ? `<labelAbbr>${esc(part.abbr)}</labelAbbr>` : ''}${defs.join('')}</staffGrp>`,
      );
    } else out.push(defs.join(''));
  }
  out.push('</staffGrp></scoreDef>');
  out.push('<section>');
  let endingLeft = 0;
  for (let b = from; b < to; b++) {
    const bar = doc.bars[b] as Bar;
    // changes of meter and key between bars
    if (b > from && (bar.showMeter || bar.showKey)) {
      const meter = bar.showMeter ? { 'meter.count': bar.meter.num, 'meter.unit': bar.meter.den } : {};
      out.push(`<scoreDef${attrs(meter)}>`);
      if (bar.showKey) {
        out.push('<staffGrp>');
        for (const part of doc.parts) {
          for (const s of part.staves)
            out.push(`<staffDef${attrs({ n: s.n, 'key.sig': keySig(writtenKey(bar.key, part)) })}/>`);
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
    if (bar.break === 'page' && b < to - 1) out.push('<pb/>');
    else if (bar.break === 'system' && b < to - 1) out.push('<sb/>');
  }
  out.push('</section>');
  out.push('</score></mdiv></body></music></mei>');
  return out.join('\n');
}

function staffDef(staff: Staff, part: Part, bar: Bar): string {
  const clef = clefAt(staff.clefs, bar.start);
  const a: Record<string, string | number | undefined> = {
    n: staff.n,
    lines: clef === 'tab' ? 6 : 5,
    'key.sig': keySig(writtenKey(bar.key, part)),
    ...clefAttrs(clef),
  };
  const label =
    part.staves.length === 1
      ? `<label>${esc(part.name)}</label>${part.abbr ? `<labelAbbr>${esc(part.abbr)}</labelAbbr>` : ''}`
      : '';
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
    for (const staff of part.staves) {
      const sb = staff.bars[bar.index];
      out.push(`<staff${attrs({ n: staff.n })}>`);
      for (const voice of sb?.voices ?? []) {
        out.push(`<layer${attrs({ n: voice.n })}>`);
        const clefsHere = staff.clefs.filter(
          ([t]) => t > bar.start - 1 && t < bar.start + bar.length && t !== staff.clefs[0]?.[0],
        );
        out.push(layer(voice.events, voice.n === 1 ? clefsHere : []));
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

function layer(events: ScoreEvent[], clefs: [number, string][]): string {
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
    out.push(e.kind === 'rest' ? rest(e) : chord(e));
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

function chord(e: ChordEvent): string {
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
    return `<note${attrs({ 'xml:id': h.id, ...noteAttrs(h), ...shared })}>${verses}</note>`;
  }
  const heads = e.heads.map((h) => `<note${attrs({ 'xml:id': h.id, ...noteAttrs(h) })}/>`).join('');
  return `<chord${attrs({ 'xml:id': e.id, ...shared })}>${heads}${verses}</chord>`;
}

function noteAttrs(h: Head): Record<string, string | number | undefined> {
  return {
    pname: letterOf(h.step).toLowerCase(),
    oct: h.octave,
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
