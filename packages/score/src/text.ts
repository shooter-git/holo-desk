/**
 * A score as text, bar by bar: what `holo score show` prints and `holo score write` reads, so the AI
 * fixes music in the same words it reads it in. Pitches are as written on the page (a B♭ clarinet's
 * part a tone up, a guitar's an octave up), and the parts list says so.
 *
 *     parts: P1 Piano (2 staves), P2 Clarinet in B♭ (written a major 2nd above sounding)
 *     bar 1  time 4/4  key D minor  tempo 96 "Andante"  |:
 *       P1 s1: mf ( d5:q.+acc e5:e f5:q ) a5:q
 *       P1 s2: [d3 a3]:w
 *       P2: R
 *       chords: Dm@1 A7@3
 *
 * Notes: letter, sharps (#) or flats (b), octave (c4 is middle C); values w h q e s t x (whole to
 * 64th) with dots; [c4 e4 g4]:q a chord; r:q a rest; R a whole-bar rest; a ~ ties into the next
 * (after the value, or after a pitch inside a chord); 3:2{…} a tuplet; +stacc +acc +ten +marc
 * +ferm +tr… articulations and ornaments; +grace / +appog a grace note before the next.
 * Marks before a note: a dynamic (mf), < or > to start a hairpin and ! to end one, ( and ) a slur,
 * "pizz." words above and _"dolce" below, 8va / 8vb / 15ma before and loco after an octave line. Lyrics: `lyrics P2 1: Hal- le- lu- jah`, * for none.
 */
import { keyText, PPQ } from '@holo/session';
import type { Bar, ChordEvent, Control, Head, Part, ScoreDoc, ScoreEvent, Staff } from './model.ts';
import { letterOf } from './spell.ts';

export const VALUE_LETTERS: Record<number, string> = {
  0.5: 'breve',
  1: 'w',
  2: 'h',
  4: 'q',
  8: 'e',
  16: 's',
  32: 't',
  64: 'x',
  128: 'y',
};

const INTERVALS: Record<string, string> = {
  '1,1': 'a minor 2nd',
  '2,1': 'a major 2nd',
  '3,2': 'a minor 3rd',
  '4,2': 'a major 3rd',
  '5,3': 'a 4th',
  '7,4': 'a 5th',
  '8,5': 'a minor 6th',
  '9,5': 'a major 6th',
  '12,7': 'an octave',
  '14,8': 'a major 9th',
  '21,12': 'an octave and a major 6th',
  '-12,-7': 'an octave below',
  '-24,-14': 'two octaves below',
};

export const partId = (i: number): string => `P${i + 1}`;

/** The parts line: ids, names, staves and transpositions. */
export function partsLine(doc: ScoreDoc): string {
  return `parts: ${doc.parts
    .map((p, i) => {
      const bits: string[] = [];
      if (p.staves.length > 1) bits.push(`${p.staves.length} staves`);
      if (p.drums) bits.push('drums');
      if (p.tr) {
        const iv = INTERVALS[`${p.tr[0]},${p.tr[1]}`] ?? `${p.tr[0]} semitones`;
        bits.push(p.tr[0] < 0 ? `written ${iv} sounding` : `written ${iv} above sounding`);
      }
      return `${partId(i)} ${p.name}${bits.length ? ` (${bits.join(', ')})` : ''}`;
    })
    .join(', ')}`;
}

export interface ShowOptions {
  /** Bars by index, [from, to). */
  from?: number;
  to?: number;
  /** Only these parts (by index); they keep their numbers. */
  parts?: number[];
}

export function scoreText(doc: ScoreDoc, opts: ShowOptions = {}): string {
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(doc.bars.length, opts.to ?? doc.bars.length);
  const lines = [`"${doc.title}"`, partsLine(doc)];
  for (let b = from; b < to; b++) lines.push(...barText(doc, doc.bars[b] as Bar, b === from, opts.parts));
  return lines.join('\n');
}

const pitchText = (h: Head): string =>
  `${letterOf(h.step).toLowerCase()}${h.alter > 0 ? '#'.repeat(h.alter) : 'b'.repeat(-h.alter)}${h.octave}`;

function valueText(e: ScoreEvent): string {
  return `${VALUE_LETTERS[e.value] ?? 'q'}${'.'.repeat(e.dots)}`;
}

const tiesOut = (h: Head) => h.tie === 'i' || h.tie === 'm';

function eventText(e: ScoreEvent): string {
  if (e.kind === 'rest') return e.full ? 'R' : `r:${valueText(e)}`;
  const arts = e.artic.map((a) => `+${a}`).join('');
  const grace = e.grace === 'a' ? '+grace' : e.grace === 'p' ? '+appog' : '';
  if (e.heads.length === 1) {
    const h = e.heads[0] as Head;
    return `${pitchText(h)}:${valueText(e)}${arts}${grace}${tiesOut(h) ? '~' : ''}`;
  }
  const allTie = e.heads.every(tiesOut);
  const inner = e.heads.map((h) => `${pitchText(h)}${!allTie && tiesOut(h) ? '~' : ''}`).join(' ');
  return `[${inner}]:${valueText(e)}${arts}${grace}${allTie ? '~' : ''}`;
}

function header(doc: ScoreDoc, bar: Bar, first: boolean): string {
  const bits = [`bar ${bar.number}`];
  if (bar.showMeter || first)
    bits.push(`time ${bar.meter.num}/${bar.meter.den}${bar.meter.groups ? ` (${bar.meter.groups.join('+')})` : ''}`);
  if ((bar.showKey || first) && bar.key) bits.push(`key ${keyText(bar.key)}`);
  if (bar.number === 0 && bar.index === 0) bits.push('pickup');
  for (const t of bar.tempos) {
    const beat = 1 + (t.tick - bar.start) / ((PPQ * 4) / bar.meter.den);
    const at = beat !== 1 ? `@${Math.round(beat * 1000) / 1000}` : '';
    bits.push(`tempo${t.mm || !t.text ? ` ${Math.round(t.bpm)}` : ''}${t.text ? ` "${t.text}"` : ''}${at}`);
  }
  if (bar.left === 'start') bits.push('|:');
  if (bar.ending) bits.push(`ending ${bar.ending.passes.join(',')}`);
  for (const j of bar.jumps)
    bits.push(j.k === 'segno' || j.k === 'coda' ? j.k : j.text.replace(/^To Coda$/, 'to coda'));
  if (bar.right === 'end' || bar.right === 'start-end') bits.push(`:|${bar.times ? `x${bar.times}` : ''}`);
  if (bar.right === 'start-end') bits.push('|:');
  if (bar.right === 'double') bits.push('||');
  if (bar.break) bits.push(`break ${bar.break}`);
  void doc;
  return bits.join('  ');
}

function barText(doc: ScoreDoc, bar: Bar, first: boolean, only?: number[]): string[] {
  const out = [header(doc, bar, first)];
  doc.parts.forEach((part, pi) => {
    if (only && !only.includes(pi)) return;
    for (const staff of part.staves) {
      const sb = staff.bars[bar.index];
      if (!sb) continue;
      // the clef in force at the first bar shown, then each change (on a later beat: @beat)
      if (first) {
        const clef = staff.clefs.filter(([t]) => t <= bar.start).at(-1)?.[1] ?? staff.clefs[0]?.[1];
        if (clef) out.push(`  clef ${partId(pi)} s${staff.local} ${clef}`);
      }
      for (const [t, clef] of staff.clefs.slice(1)) {
        if (t < bar.start || t >= bar.start + bar.length || (first && t === bar.start)) continue;
        const beat = 1 + (t - bar.start) / ((PPQ * 4) / bar.meter.den);
        out.push(
          `  clef ${partId(pi)} s${staff.local} ${clef}${beat !== 1 ? `@${Math.round(beat * 1000) / 1000}` : ''}`,
        );
      }
      const marks = doc.bars.flatMap((x) => x.controls).filter((c) => c.staff === staff.n);
      for (const voice of sb.voices) {
        const tokens: string[] = [];
        let tuplet: number | null = null;
        for (const e of voice.events) {
          const tup = e.tuplet?.id ?? null;
          if (tuplet !== null && tup !== tuplet) tokens.push('}');
          tokens.push(...marksBefore(marks, e, voice.n === 1));
          if (tup !== null && tup !== tuplet && e.tuplet)
            tokens.push(`${e.tuplet.ratio.num}:${e.tuplet.ratio.numbase}{`);
          tuplet = tup;
          tokens.push(eventText(e));
          tokens.push(...marksAfter(marks, e));
        }
        if (tuplet !== null) tokens.push('}');
        out.push(
          `  ${address(part, pi, staff, voice.n, sb.voices.length > 1)}: ${tokens.join(' ').replace(/\{ /g, '{').replace(/ \}/g, '}')}`,
        );
        const verses = Math.max(0, ...voice.events.map((e) => (e.kind === 'chord' ? (e.lyrics?.length ?? 0) : 0)));
        for (let v = 0; v < verses; v++) {
          const syl = voice.events
            .filter(
              (e): e is ChordEvent =>
                e.kind === 'chord' && !e.grace && !e.heads.every((h) => h.tie === 'm' || h.tie === 't'),
            )
            .map((e) => e.lyrics?.[v] || '*');
          out.push(`  lyrics ${address(part, pi, staff, voice.n, sb.voices.length > 1)} ${v + 1}: ${syl.join(' ')}`);
        }
      }
    }
  });
  if (bar.chords.length) {
    const unit = (PPQ * 4) / bar.meter.den;
    out.push(
      `  chords: ${bar.chords.map((c) => `${c.symbol}@${Math.round((1 + (c.tick - bar.start) / unit) * 1000) / 1000}`).join(' ')}`,
    );
  }
  return out;
}

/** "P1" for a one-staff part's first voice, "P1 s2" for a staff's first voice, "P1 s1 v2" otherwise. */
function address(part: Part, pi: number, staff: Staff, voice: number, many: boolean): string {
  const id = partId(pi);
  if (part.staves.length === 1 && voice === 1 && !many) return id;
  return `${id} s${staff.local}${voice > 1 || many ? ` v${voice}` : ''}`;
}

const DYN_FIRST = (c: Control, e: ScoreEvent) => 'tick' in c && c.tick === e.tick;

function marksBefore(marks: Control[], e: ScoreEvent, voiceOne: boolean): string[] {
  // a fixed order, whatever order the marks were made in: a hairpin's end, the dynamic, words, a
  // hairpin's start, an octave line, a slur
  const ends: string[] = [];
  const dyns: string[] = [];
  const words: string[] = [];
  const pins: string[] = [];
  const lines: string[] = [];
  const ids = e.kind === 'chord' ? [e.id, ...e.heads.map((h) => h.id)] : [e.id];
  for (const c of marks) {
    if (voiceOne && c.kind === 'hairpin' && c.end === e.tick) ends.push('!');
    if (voiceOne && c.kind === 'dyn' && DYN_FIRST(c, e)) dyns.push(c.value);
    if (voiceOne && c.kind === 'words' && c.tick === e.tick)
      words.push(c.place === 'above' ? `"${c.text}"` : `_"${c.text}"`);
    if (voiceOne && c.kind === 'hairpin' && c.tick === e.tick) pins.push(c.form === 'cres' ? '<' : '>');
    if (c.kind === 'octave' && ids.includes(c.start)) {
      lines.push(`${c.dis}${c.place === 'above' ? (c.dis === 8 ? 'va' : 'ma') : c.dis === 8 ? 'vb' : 'mb'}`);
    }
    if (c.kind === 'slur' && ids.includes(c.start)) lines.push('(');
  }
  return [...ends, ...dyns, ...words.sort(), ...pins, ...lines];
}

function marksAfter(marks: Control[], e: ScoreEvent): string[] {
  const ids = e.kind === 'chord' ? [e.id, ...e.heads.map((h) => h.id)] : [e.id];
  return marks
    .filter((c) => (c.kind === 'slur' || c.kind === 'octave') && ids.includes(c.end))
    .map((c) => (c.kind === 'slur' ? ')' : 'loco'));
}
