/**
 * MusicXML out: the score as it's laid out (written pitches, values, ties, tuplets, voices, clefs,
 * keys and times, the marks, lyrics, chord symbols, repeats and jumps), for MuseScore, Sibelius,
 * Finale, Dorico, or another HO[LO]. Durations are in ticks (960 to a quarter), as the song keeps them.
 */
import { PPQ } from '@holo/session';
import type { Bar, ChordEvent, Control, Head, Part, ScoreDoc, ScoreEvent } from '../model.ts';
import { clefAt } from '../notate.ts';
import { fifthsShift, letterOf, normalFifths } from '../spell.ts';
import { esc } from './xml.ts';

const TYPE: Record<string, string> = {
  '0.5': 'breve',
  '1': 'whole',
  '2': 'half',
  '4': 'quarter',
  '8': 'eighth',
  '16': '16th',
  '32': '32nd',
  '64': '64th',
  '128': '128th',
};
const ACCIDENTAL: Record<string, string> = {
  '-2': 'flat-flat',
  '-1': 'flat',
  '0': 'natural',
  '1': 'sharp',
  '2': 'double-sharp',
};
const ARTIC: Record<string, string> = {
  stacc: 'staccato',
  staccis: 'staccatissimo',
  ten: 'tenuto',
  acc: 'accent',
  marc: 'strong-accent',
};
const ORNAMENT: Record<string, string> = { tr: 'trill-mark', mord: 'inverted-mordent', pmord: 'mordent', turn: 'turn' };
const TECHNICAL: Record<string, string> = {
  up: 'up-bow',
  down: 'down-bow',
  harm: 'harmonic',
  open: 'open-string',
  stop: 'stopped',
  snap: 'snap-pizzicato',
};
const HEAD: Record<string, string> = {
  x: 'x',
  'circle-x': 'circle-x',
  diamond: 'diamond',
  slash: 'slash',
  triangle: 'triangle',
  square: 'square',
};
const KINDS: [string, string][] = [
  ['m(maj7)', 'major-minor'],
  ['m7b5', 'half-diminished'],
  ['maj9', 'major-ninth'],
  ['maj7', 'major-seventh'],
  ['dim7', 'diminished-seventh'],
  ['aug7', 'augmented-seventh'],
  ['sus2', 'suspended-second'],
  ['sus4', 'suspended-fourth'],
  ['m9', 'minor-ninth'],
  ['m7', 'minor-seventh'],
  ['m6', 'minor-sixth'],
  ['dim', 'diminished'],
  ['aug', 'augmented'],
  ['13', 'dominant-13th'],
  ['11', 'dominant-11th'],
  ['9', 'dominant-ninth'],
  ['7', 'dominant'],
  ['6', 'major-sixth'],
  ['5', 'power'],
  ['m', 'minor'],
  ['', 'major'],
];

const clefXml = (clef: string, staff: number): string => {
  const base = clef.replace(/(8vb|8va|15ma)$/, '');
  const oct = clef.endsWith('8vb') ? -1 : clef.endsWith('8va') ? 1 : clef.endsWith('15ma') ? 2 : 0;
  const [sign, line] =
    base === 'perc'
      ? ['percussion', 0]
      : base === 'tab'
        ? ['TAB', 5]
        : base === 'F'
          ? ['F', 4]
          : base.startsWith('C')
            ? ['C', Number(base.slice(1)) || 3]
            : ['G', 2];
  return `<clef number="${staff}"><sign>${sign}</sign>${line ? `<line>${line}</line>` : ''}${oct ? `<clef-octave-change>${oct}</clef-octave-change>` : ''}</clef>`;
};

function writtenFifths(bar: Bar, part: Part): number {
  const f = bar.key?.fifths ?? 0;
  if (part.drums) return 0;
  return part.tr ? normalFifths(f + fifthsShift(part.tr[0], part.tr[1])) : f;
}

function harmonyXml(symbol: string, offset: number): string {
  const m = /^([A-G])([#b]*)(.*?)(?:\/([A-G])([#b]*))?$/.exec(symbol.trim());
  if (!m) return '';
  const alter = (a: string) => [...a].reduce((n, c) => n + (c === '#' ? 1 : -1), 0);
  const suffix = m[3] ?? '';
  const kind = KINDS.find(([s]) => s === suffix)?.[1] ?? 'other';
  const bass = m[4]
    ? `<bass><bass-step>${m[4]}</bass-step>${alter(m[5] ?? '') ? `<bass-alter>${alter(m[5] ?? '')}</bass-alter>` : ''}</bass>`
    : '';
  return `<harmony><root><root-step>${m[1]}</root-step>${alter(m[2] ?? '') ? `<root-alter>${alter(m[2] ?? '')}</root-alter>` : ''}</root><kind text="${esc(suffix)}">${kind}</kind>${bass}${offset ? `<offset>${offset}</offset>` : ''}</harmony>`;
}

/** The syllable's place in its word, from the hyphens HO[LO] keeps. */
function syllabic(text: string, before: string | undefined): [string, string, boolean] {
  const joins = text.endsWith('-');
  const holds = text.endsWith('_');
  const word = text.replace(/[-_]$/, '');
  const continued = !!before?.endsWith('-');
  const kind = joins ? (continued ? 'middle' : 'begin') : continued ? 'end' : 'single';
  return [kind, word, holds];
}

export function toMusicXml(doc: ScoreDoc): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  out.push(
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
  );
  out.push('<score-partwise version="4.0">');
  out.push(`<work><work-title>${esc(doc.title)}</work-title></work>`);
  if (doc.credits.subtitle) out.push(`<movement-title>${esc(doc.credits.subtitle)}</movement-title>`);
  out.push('<identification>');
  for (const role of ['composer', 'lyricist', 'arranger'] as const) {
    const who = doc.credits[role];
    if (who) out.push(`<creator type="${role}">${esc(who)}</creator>`);
  }
  if (doc.credits.copyright) out.push(`<rights>${esc(doc.credits.copyright)}</rights>`);
  out.push('<encoding><software>HO[LO] Desk</software></encoding></identification>');
  out.push('<part-list>');
  doc.parts.forEach((p, i) => {
    out.push(`<score-part id="P${i + 1}"><part-name>${esc(p.name)}</part-name>`);
    if (p.abbr) out.push(`<part-abbreviation>${esc(p.abbr)}</part-abbreviation>`);
    if (p.drums) {
      // a drum part: an instrument for each drum it plays, with its General MIDI note
      const pitches = drumPitches(p);
      for (const pitch of pitches) {
        out.push(
          `<score-instrument id="P${i + 1}-X${pitch}"><instrument-name>Drum ${pitch}</instrument-name></score-instrument>`,
        );
      }
      for (const pitch of pitches) {
        out.push(
          `<midi-instrument id="P${i + 1}-X${pitch}"><midi-channel>10</midi-channel><midi-unpitched>${pitch + 1}</midi-unpitched></midi-instrument>`,
        );
      }
    } else {
      out.push(
        `<score-instrument id="P${i + 1}-I1"><instrument-name>${esc(p.name)}</instrument-name></score-instrument>`,
      );
      out.push(
        `<midi-instrument id="P${i + 1}-I1"><midi-channel>${(i % 15) + 1 + (i % 15 >= 9 ? 1 : 0)}</midi-channel></midi-instrument>`,
      );
    }
    out.push('</score-part>');
  });
  out.push('</part-list>');
  doc.parts.forEach((part, pi) => {
    out.push(`<part id="P${pi + 1}">`);
    for (const bar of doc.bars) out.push(measure(doc, part, bar, pi === 0, part.drums ? `P${pi + 1}` : null));
    out.push('</part>');
  });
  out.push('</score-partwise>');
  return out.join('\n');
}

/** The drums a drum part plays. */
function drumPitches(part: Part): number[] {
  const set = new Set<number>();
  for (const s of part.staves) {
    for (const b of s.bars) {
      for (const v of b.voices)
        for (const e of v.events) if (e.kind === 'chord') for (const h of e.heads) set.add(Math.round(h.pitch));
    }
  }
  return [...set].sort((a, b) => a - b);
}

function measure(doc: ScoreDoc, part: Part, bar: Bar, first: boolean, drumPart: string | null): string {
  const out: string[] = [];
  const full = (bar.meter.num * PPQ * 4) / bar.meter.den;
  out.push(`<measure number="${bar.number}"${bar.length !== full ? ' implicit="yes"' : ''}>`);
  if (first && bar.break && bar.index > 0) out.push(`<print new-${bar.break}="yes"/>`);
  // the left bar line: a repeat's start, an ending's start
  if (bar.left === 'start' || bar.ending) {
    out.push('<barline location="left">');
    if (bar.left === 'start') out.push('<bar-style>heavy-light</bar-style>');
    if (bar.ending)
      out.push(
        `<ending number="${bar.ending.passes.join(',')}" type="start">${bar.ending.passes.join(', ')}.</ending>`,
      );
    if (bar.left === 'start') out.push('<repeat direction="forward"/>');
    out.push('</barline>');
  }
  // what's set at this bar: divisions first, then key, time, staves, clefs, transposition
  const attrs: string[] = [];
  if (bar.index === 0) attrs.push(`<divisions>${PPQ}</divisions>`);
  if ((bar.index === 0 && bar.key) || bar.showKey) {
    const mode = bar.key?.mode;
    attrs.push(
      `<key><fifths>${writtenFifths(bar, part)}</fifths>${mode === 'major' || mode === 'minor' ? `<mode>${mode}</mode>` : ''}</key>`,
    );
  }
  if (bar.index === 0 || bar.showMeter)
    attrs.push(`<time><beats>${bar.meter.num}</beats><beat-type>${bar.meter.den}</beat-type></time>`);
  if (bar.index === 0 && part.staves.length > 1) attrs.push(`<staves>${part.staves.length}</staves>`);
  for (const staff of part.staves) {
    if (bar.index === 0) attrs.push(clefXml(clefAt(staff.clefs, bar.start), staff.local));
    else
      for (const [t, clef] of staff.clefs.slice(1))
        if (t >= bar.start && t < bar.start + bar.length && t === bar.start) attrs.push(clefXml(clef, staff.local));
  }
  if (bar.index === 0) {
    // MusicXML's transposition is how it sounds from how it's written; the octave clefs too
    const clefOct = part.staves[0]?.clefs[0]?.[1].endsWith('8vb') ? -1 : 0;
    const chromatic = -(part.tr?.[0] ?? 0) + 12 * clefOct;
    const diatonic = -(part.tr?.[1] ?? 0) + 7 * clefOct;
    if (chromatic || diatonic) {
      const oct = Math.trunc(chromatic / 12);
      attrs.push(
        `<transpose><diatonic>${diatonic - 7 * oct}</diatonic><chromatic>${chromatic - 12 * oct}</chromatic>${oct ? `<octave-change>${oct}</octave-change>` : ''}</transpose>`,
      );
    }
  }
  if (attrs.length) out.push(`<attributes>${attrs.join('')}</attributes>`);
  if (first) {
    for (const t of bar.tempos) {
      const words = t.text ? `<direction-type><words>${esc(t.text)}</words></direction-type>` : '';
      const mm = t.mm
        ? `<direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(t.bpm)}</per-minute></metronome></direction-type>`
        : '';
      out.push(
        `<direction placement="above">${words}${mm}<offset>${Math.round(t.tick - bar.start)}</offset><sound tempo="${Math.round(t.bpm * 100) / 100}"/></direction>`,
      );
    }
    for (const j of bar.jumps) {
      const at = Math.max(0, Math.round(j.at - bar.start));
      if (j.k === 'segno' || j.k === 'coda')
        out.push(
          `<direction placement="above"><direction-type><${j.k}/></direction-type><offset>${at}</offset></direction>`,
        );
    }
  }
  // chord symbols at the bar's start, each offset to its beat
  if (first) for (const c of bar.chords) out.push(harmonyXml(c.symbol, Math.round(c.tick - bar.start)));
  const controls = doc.bars.flatMap((b) => b.controls);
  let pos = bar.start;
  part.staves.forEach((staff) => {
    const sb = staff.bars[bar.index];
    for (const voice of sb?.voices ?? []) {
      // back to the bar's start for each voice after the first
      if (pos > bar.start) out.push(`<backup><duration>${Math.round(pos - bar.start)}</duration></backup>`);
      pos = bar.start;
      const number = (staff.local - 1) * 4 + voice.n;
      for (const [k, e] of voice.events.entries()) {
        out.push(
          ...directionsAt(
            bar,
            e,
            controls.filter((c) => c.staff === staff.n),
            staff.local,
            part.staves.length > 1,
            voice.n === 1,
          ),
        );
        out.push(
          event(
            e,
            voice.events[k - 1],
            voice.events[k + 1],
            number,
            staff.local,
            part.staves.length > 1,
            controls,
            drumPart,
          ),
        );
        if (!(e.kind === 'chord' && e.grace)) pos = Math.max(pos, e.tick + e.dur);
      }
    }
  });
  if (pos < bar.start + bar.length && pos > bar.start)
    out.push(`<forward><duration>${Math.round(bar.start + bar.length - pos)}</duration></forward>`);
  // what's said at the bar's end: To Coda, D.S., Fine
  if (first) {
    for (const j of bar.jumps) {
      if (j.k === 'segno' || j.k === 'coda') continue;
      const sound =
        j.k === 'fine'
          ? ' fine="yes"'
          : j.k === 'dc'
            ? ' dacapo="yes"'
            : j.k === 'ds'
              ? ' dalsegno="segno"'
              : ' tocoda="coda"';
      out.push(
        `<direction placement="above"><direction-type><words>${esc(j.text)}</words></direction-type><sound${sound}/></direction>`,
      );
    }
  }
  // the right bar line
  const end = bar.ending && bar.ending.bars === 1;
  const repeat = bar.right === 'end' || bar.right === 'start-end';
  if (repeat || end || bar.right === 'final' || bar.right === 'double') {
    out.push('<barline location="right">');
    out.push(`<bar-style>${repeat || bar.right === 'final' ? 'light-heavy' : 'light-light'}</bar-style>`);
    if (end && bar.ending)
      out.push(`<ending number="${bar.ending.passes.join(',')}" type="${repeat ? 'stop' : 'discontinue'}"/>`);
    if (repeat) out.push(`<repeat direction="backward"${bar.times ? ` times="${bar.times}"` : ''}/>`);
    out.push('</barline>');
  }
  out.push('</measure>');
  return out.join('');
}

/** Dynamics, hairpins, words, octave lines and pedal that start (or end) at an event. */
function directionsAt(
  bar: Bar,
  e: ScoreEvent,
  controls: Control[],
  staff: number,
  many: boolean,
  voiceOne: boolean,
): string[] {
  if (!voiceOne || (e.kind === 'chord' && e.grace)) return [];
  const out: string[] = [];
  const st = many ? `<staff>${staff}</staff>` : '';
  const ids = e.kind === 'chord' ? [e.id, ...e.heads.map((h) => h.id)] : [e.id];
  for (const c of controls) {
    if (c.kind === 'dyn' && c.tick === e.tick) {
      out.push(
        `<direction placement="below"><direction-type><dynamics><${/^[a-z]+$/.test(c.value) ? c.value : 'mf'}/></dynamics></direction-type>${st}</direction>`,
      );
    } else if (c.kind === 'hairpin' && c.tick === e.tick) {
      out.push(
        `<direction placement="below"><direction-type><wedge type="${c.form === 'cres' ? 'crescendo' : 'diminuendo'}" number="1"/></direction-type>${st}</direction>`,
      );
    } else if (c.kind === 'hairpin' && c.end === e.tick && c.end <= bar.start + bar.length) {
      out.push(
        `<direction placement="below"><direction-type><wedge type="stop" number="1"/></direction-type>${st}</direction>`,
      );
    } else if (c.kind === 'words' && c.tick === e.tick) {
      out.push(
        `<direction placement="${c.place}"><direction-type><words${c.place === 'below' ? ' font-style="italic"' : ''}>${esc(c.text)}</words></direction-type>${st}</direction>`,
      );
    } else if (c.kind === 'octave' && ids.includes(c.start)) {
      out.push(
        `<direction placement="${c.place}"><direction-type><octave-shift type="${c.place === 'above' ? 'down' : 'up'}" size="${c.dis}"/></direction-type>${st}</direction>`,
      );
    } else if (c.kind === 'pedal' && c.tick === e.tick) {
      out.push(
        `<direction placement="below"><direction-type><pedal type="${c.dir === 'down' ? 'start' : 'stop'}" line="yes"/></direction-type>${st}</direction>`,
      );
    }
  }
  return out;
}

function event(
  e: ScoreEvent,
  prev: ScoreEvent | undefined,
  next: ScoreEvent | undefined,
  voice: number,
  staff: number,
  many: boolean,
  controls: Control[],
  drumPart: string | null,
): string {
  const st = many ? `<staff>${staff}</staff>` : '';
  const type = TYPE[String(e.value)] ?? 'quarter';
  const dots = '<dot/>'.repeat(e.dots);
  const tm = e.tuplet
    ? `<time-modification><actual-notes>${e.tuplet.ratio.num}</actual-notes><normal-notes>${e.tuplet.ratio.numbase}</normal-notes></time-modification>`
    : '';
  const tupletStart = e.tuplet && prev?.tuplet?.id !== e.tuplet.id;
  const tupletStop = e.tuplet && next?.tuplet?.id !== e.tuplet.id;
  const dur = Math.max(1, Math.round(e.dur));
  if (e.kind === 'rest') {
    const tup =
      tupletStart || tupletStop
        ? `<notations>${tupletStart ? '<tuplet type="start"/>' : ''}${tupletStop ? '<tuplet type="stop"/>' : ''}</notations>`
        : '';
    return `<note><rest${e.full ? ' measure="yes"' : ''}/><duration>${dur}</duration><voice>${voice}</voice>${e.full ? '' : `<type>${type}</type>${dots}`}${tm}${st}${tup}</note>`;
  }
  return e.heads
    .map((h, k) =>
      head(e, h, k, {
        type,
        dots,
        tm,
        dur,
        voice,
        st,
        tupletStart: !!tupletStart,
        tupletStop: !!tupletStop,
        controls,
        prev,
        drumPart,
      }),
    )
    .join('');
}

function head(
  e: ChordEvent,
  h: Head,
  k: number,
  o: {
    type: string;
    dots: string;
    tm: string;
    dur: number;
    voice: number;
    st: string;
    tupletStart: boolean;
    tupletStop: boolean;
    controls: Control[];
    prev: ScoreEvent | undefined;
    drumPart: string | null;
  },
): string {
  const parts: string[] = ['<note>'];
  if (e.grace) parts.push(`<grace${e.grace === 'a' ? ' slash="yes"' : ''}/>`);
  if (k > 0) parts.push('<chord/>');
  if (o.drumPart) {
    parts.push(
      `<unpitched><display-step>${letterOf(h.step)}</display-step><display-octave>${h.octave}</display-octave></unpitched>`,
    );
  } else {
    parts.push(
      `<pitch><step>${letterOf(h.step)}</step>${h.alter ? `<alter>${h.alter}</alter>` : ''}<octave>${h.octave}</octave></pitch>`,
    );
  }
  if (!e.grace) parts.push(`<duration>${o.dur}</duration>`);
  const startTie = h.tie === 'i' || h.tie === 'm';
  const stopTie = h.tie === 't' || h.tie === 'm';
  if (stopTie) parts.push('<tie type="stop"/>');
  if (startTie) parts.push('<tie type="start"/>');
  if (o.drumPart) parts.push(`<instrument id="${o.drumPart}-X${Math.round(h.pitch)}"/>`);
  parts.push(`<voice>${o.voice}</voice><type>${o.type}</type>${o.dots}`);
  if (h.accid !== undefined) parts.push(`<accidental>${ACCIDENTAL[String(h.accid)] ?? 'natural'}</accidental>`);
  parts.push(o.tm);
  if (e.stem) parts.push(`<stem>${e.stem}</stem>`);
  if (h.head && HEAD[h.head]) parts.push(`<notehead>${HEAD[h.head]}</notehead>`);
  parts.push(o.st);
  // what's marked on it (on the chord's first note only, as a score shows it once)
  const n: string[] = [];
  if (stopTie) n.push('<tied type="stop"/>');
  if (startTie) n.push('<tied type="start"/>');
  if (k === 0) {
    if (o.tupletStart) n.push('<tuplet type="start"/>');
    if (o.tupletStop) n.push('<tuplet type="stop"/>');
    const ids = [e.id, ...e.heads.map((x) => x.id)];
    for (const c of o.controls) {
      if (c.kind === 'slur' && ids.includes(c.start)) n.push('<slur type="start" number="1"/>');
      if (c.kind === 'slur' && ids.includes(c.end)) n.push('<slur type="stop" number="1"/>');
    }
    const artic = e.artic.map((a) => ARTIC[a]).filter(Boolean);
    if (artic.length) n.push(`<articulations>${artic.map((a) => `<${a}/>`).join('')}</articulations>`);
    if (e.artic.includes('ferm')) n.push('<fermata type="upright"/>');
    const orn = e.artic.map((a) => ORNAMENT[a]).filter(Boolean);
    const trem = e.artic.find((a) => /^trem[1-4]$/.test(a));
    if (orn.length || trem)
      n.push(
        `<ornaments>${orn.map((a) => `<${a}/>`).join('')}${trem ? `<tremolo type="single">${trem.slice(4)}</tremolo>` : ''}</ornaments>`,
      );
    const tech = e.artic.map((a) => TECHNICAL[a]).filter(Boolean);
    if (tech.length || e.fingering) {
      n.push(
        `<technical>${tech.map((a) => `<${a}/>`).join('')}${e.fingering ? `<fingering>${esc(e.fingering)}</fingering>` : ''}</technical>`,
      );
    }
    if (e.artic.includes('arp')) n.push('<arpeggiate/>');
  }
  if (n.length) parts.push(`<notations>${n.join('')}</notations>`);
  if (k === 0 && e.lyrics) {
    const before = o.prev?.kind === 'chord' ? o.prev.lyrics : undefined;
    e.lyrics.forEach((text, v) => {
      if (!text) return;
      const [kind, word, holds] = syllabic(text, before?.[v]);
      parts.push(
        `<lyric number="${v + 1}"><syllabic>${kind}</syllabic><text>${esc(word)}</text>${holds ? '<extend/>' : ''}</lyric>`,
      );
    });
  }
  parts.push('</note>');
  return parts.join('');
}
