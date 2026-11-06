/**
 * MusicXML in: a score from MuseScore, Sibelius, Finale, Dorico or a scanner, read into a song. Each
 * part is a track (its staves, clefs and transposition in its score settings), its notes what they
 * sound (ties joined, a transposing part brought to concert pitch), with how they're written kept as
 * hints; dynamics, hairpins, slurs and words are marks, and the markings set velocities and lengths.
 */
import {
  type ChordMark,
  type FormMark,
  type KeyMode,
  type KeyPoint,
  type Mark,
  type MeterPoint,
  type Note,
  type NoteNotation,
  newProject,
  newRegion,
  newTrack,
  PPQ,
  type Project,
  type ScoreSettings,
  type TempoPoint,
  type Track,
} from '@holo/session';
import { gateFor, isDynamic, levelAt, slurredAt, velocityFor } from '../bake.ts';
import { transposeSpelling } from '../spell.ts';
import { child, children, numberOf, parseXml, textOf, type XmlNode } from './xml.ts';

export interface ImportResult {
  project: Project;
  warnings: string[];
}

const STEPS = 'CDEFGAB';
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const MODES = new Set<KeyMode>(['major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian']);

const ARTIC: Record<string, string> = {
  staccato: 'stacc',
  staccatissimo: 'staccis',
  spiccato: 'staccis',
  tenuto: 'ten',
  accent: 'acc',
  'strong-accent': 'marc',
  'detached-legato': 'ten',
  'breath-mark': 'breath',
  caesura: 'caesura',
};
const ORNAMENT: Record<string, string> = {
  'trill-mark': 'tr',
  mordent: 'pmord',
  'inverted-mordent': 'mord',
  turn: 'turn',
  'inverted-turn': 'turn',
};
const TECHNICAL: Record<string, string> = {
  'up-bow': 'up',
  'down-bow': 'down',
  harmonic: 'harm',
  'open-string': 'open',
  open: 'open',
  stopped: 'stop',
  'snap-pizzicato': 'snap',
};
const HEADS: Record<string, string> = {
  x: 'x',
  cross: 'x',
  diamond: 'diamond',
  slash: 'slash',
  triangle: 'triangle',
  'circle-x': 'circle-x',
  square: 'square',
};

const CLEF_NAMES: Record<string, string> = { G2: 'G', F4: 'F', C1: 'C1', C2: 'C2', C3: 'C3', C4: 'C4', C5: 'C5' };

/** A MusicXML clef as HO[LO] names it. */
function clefName(sign: string, line: number, octave: number): string {
  if (sign === 'percussion') return 'perc';
  if (sign === 'TAB') return 'tab';
  const base = CLEF_NAMES[`${sign}${line}`] ?? (sign === 'F' ? 'F' : sign === 'C' ? `C${line || 3}` : 'G');
  if (octave === -1) return `${base}8vb`;
  if (octave === 1) return `${base}8va`;
  if (octave === 2) return `${base}15ma`;
  return base;
}

/** Time-wise MusicXML regrouped part-wise (the same score, measured the other way). */
function partwise(root: XmlNode): XmlNode {
  if (root.name === 'score-partwise') return root;
  if (root.name !== 'score-timewise') throw new Error('Not MusicXML: the file has no score in it');
  const parts = new Map<string, XmlNode>();
  for (const m of children(root, 'measure')) {
    for (const p of children(m, 'part')) {
      const id = p.attrs.id ?? '';
      let part = parts.get(id);
      if (!part) {
        part = { name: 'part', attrs: { id }, children: [], text: '' };
        parts.set(id, part);
      }
      part.children.push({ name: 'measure', attrs: m.attrs, children: p.children, text: '' });
    }
  }
  return {
    ...root,
    name: 'score-partwise',
    children: [...root.children.filter((c) => c.name !== 'measure'), ...parts.values()],
  };
}

interface PartInfo {
  name: string;
  abbr: string;
  program: number;
  channel: number;
  /** score-instrument id → its drum's pitch (midi-unpitched). */
  unpitched: Map<string, number>;
}

interface Building {
  note: Note;
  start: number;
  /** Written length so far (ties add to it). */
  len: number;
  staff: number;
  voice: string;
}

export function readMusicXml(source: string, fallbackTitle = 'Imported'): ImportResult {
  const warnings: string[] = [];
  const root = partwise(parseXml(source));
  const work = textOf(root, 'work/work-title');
  const movement = textOf(root, 'movement-title');
  const title = work || movement || fallbackTitle;
  const credits: ScoreSettings = {};
  if (work && movement && movement !== work) credits.subtitle = movement;
  for (const c of children(child(root, 'identification'), 'creator')) {
    const role = c.attrs.type;
    if (role === 'composer' || role === 'lyricist' || role === 'arranger') credits[role] = c.text.trim();
  }
  const rights = textOf(root, 'identification/rights');
  if (rights) credits.copyright = rights;

  // the parts' names and sounds
  const info = new Map<string, PartInfo>();
  for (const sp of children(child(root, 'part-list'), 'score-part')) {
    const unpitched = new Map<string, number>();
    for (const mi of children(sp, 'midi-instrument')) {
      const u = numberOf(mi, 'midi-unpitched', 0);
      if (u) unpitched.set(mi.attrs.id ?? '', u - 1);
    }
    info.set(sp.attrs.id ?? '', {
      name: textOf(sp, 'part-name') || textOf(sp, 'score-instrument/instrument-name') || 'Part',
      abbr: textOf(sp, 'part-abbreviation'),
      program: numberOf(sp, 'midi-instrument/midi-program', 1),
      channel: numberOf(sp, 'midi-instrument/midi-channel', 1),
      unpitched,
    });
  }

  const parts = children(root, 'part');
  if (!parts.length) throw new Error('The score has no parts');
  // the bars, as the first part has them: where each starts, its time, a pickup
  const meter: MeterPoint[] = [];
  const keys: KeyPoint[] = [];
  const tempo: TempoPoint[] = [];
  const form: FormMark[] = [];
  const chords: ChordMark[] = [];
  const breaks: [number, 'system' | 'page'][] = [];
  const starts: number[] = [];
  {
    let divisions = 1;
    let at = 0;
    let time = { num: 4, den: 4 };
    let lastMeter = '';
    const first = parts[0] as XmlNode;
    children(first, 'measure').forEach((m, i) => {
      let cursor = 0;
      let longest = 0;
      for (const e of m.children) {
        if (e.name === 'attributes') {
          divisions = numberOf(e, 'divisions', divisions);
          const t = child(e, 'time');
          if (t && textOf(t, 'beats'))
            time = {
              num: Number(
                textOf(t, 'beats')
                  .split('+')
                  .reduce((a, b) => a + Number(b), 0),
              ),
              den: numberOf(t, 'beat-type', 4),
            };
        } else if (e.name === 'note') {
          if (child(e, 'chord') || child(e, 'grace')) continue;
          cursor += numberOf(e, 'duration') * (PPQ / divisions);
        } else if (e.name === 'backup') cursor -= numberOf(e, 'duration') * (PPQ / divisions);
        else if (e.name === 'forward') cursor += numberOf(e, 'duration') * (PPQ / divisions);
        longest = Math.max(longest, cursor);
      }
      const full = (time.num * PPQ * 4) / time.den;
      const implicit = m.attrs.implicit === 'yes';
      let length = implicit || longest > full ? Math.round(longest) : full;
      if (length <= 0) length = full;
      if (i === 0 && length < full) {
        // a pickup: the first bar is a full bar on the timeline, the music at its end
        const offset = full - length;
        meter.push({ tick: 0, num: time.num, den: time.den, pickup: length });
        lastMeter = `${time.num}/${time.den}`;
        at = full;
        starts.push(offset);
        return;
      }
      const sig = `${time.num}/${time.den}`;
      if (sig !== lastMeter && (!implicit || i === 0)) {
        meter.push({ tick: at, num: time.num, den: time.den });
        lastMeter = sig;
      }
      starts.push(at);
      at += length;
    });
    starts.push(at);
    if (!meter.length) meter.push({ tick: 0, num: 4, den: 4 });
  }

  const tracks: Track[] = [];
  parts.forEach((part, pi) => {
    const pinfo = info.get(part.attrs.id ?? '') ?? {
      name: `Part ${pi + 1}`,
      abbr: '',
      program: 1,
      channel: 1,
      unpitched: new Map(),
    };
    let divisions = 1;
    let staves = 1;
    let chromatic = 0;
    let diatonic = 0;
    let octaveChange = 0;
    const clefs: [number, number, string][] = [];
    const notes: Building[] = [];
    const marks: Mark[] = [];
    const cc64: [number, number][] = [];
    const ties = new Map<string, Building>();
    const slurs = new Map<string, number>();
    const wedges = new Map<string, { t: number; k: 'cresc' | 'dim'; st: number }>();
    const shifts = new Map<number, number>();
    const drumPlaces = new Map<number, [number, string]>();
    let drums = false;
    let lastOnset = 0;
    let lastChord: Building[] = [];
    const firstPart = pi === 0;

    children(part, 'measure').forEach((m, mi) => {
      const start = starts[mi] ?? 0;
      let cursor = 0;
      const ticks = (d: number) => d * (PPQ / divisions);
      for (const e of m.children) {
        switch (e.name) {
          case 'attributes': {
            divisions = numberOf(e, 'divisions', divisions);
            staves = numberOf(e, 'staves', staves);
            // the transposition first: a transposing part's key is written, and comes before it
            const tr = child(e, 'transpose');
            if (tr) {
              chromatic = numberOf(tr, 'chromatic');
              diatonic = numberOf(tr, 'diatonic');
              octaveChange = numberOf(tr, 'octave-change');
            }
            const k = child(e, 'key');
            if (k && firstPart && textOf(k, 'fifths') !== '') {
              const mode = (textOf(k, 'mode') || 'major') as KeyMode;
              // a key in the first bar (a pickup's too) is the song's from its start
              const point: KeyPoint = {
                tick: mi === 0 && cursor === 0 ? 0 : start + cursor,
                fifths: numberOf(k, 'fifths'),
                mode: MODES.has(mode) ? mode : 'major',
              };
              // a transposing first part's key is written: bring it to concert
              point.fifths = concertFifths(point.fifths, chromatic, diatonic);
              if (keys.at(-1)?.fifths !== point.fifths || keys.at(-1)?.mode !== point.mode) keys.push(point);
            }
            for (const c of children(e, 'clef')) {
              const staff = Number(c.attrs.number ?? 1);
              const name = clefName(textOf(c, 'sign'), numberOf(c, 'line', 0), numberOf(c, 'clef-octave-change'));
              if (name === 'perc') drums = true;
              const tick = mi === 0 && cursor === 0 ? 0 : start + cursor;
              clefs.push([tick, staff, name]);
            }
            break;
          }
          case 'backup':
            cursor -= ticks(numberOf(e, 'duration'));
            break;
          case 'forward':
            cursor += ticks(numberOf(e, 'duration'));
            break;
          case 'direction':
            direction(e, start + cursor + ticks(numberOf(e, 'offset')), Number(textOf(e, 'staff') || 1), firstPart);
            break;
          case 'harmony':
            if (firstPart || !chords.some((c) => c.tick === start + cursor)) {
              const symbol = harmony(e);
              if (symbol) chords.push({ tick: start + cursor + ticks(numberOf(e, 'offset')), symbol });
            }
            break;
          case 'barline':
            if (firstPart) barline(e, start, starts[mi + 1] ?? start);
            break;
          case 'print':
            if (firstPart && mi > 0) {
              if (e.attrs['new-page'] === 'yes') breaks.push([start, 'page']);
              else if (e.attrs['new-system'] === 'yes') breaks.push([start, 'system']);
            }
            break;
          case 'sound':
            sound(e, start + cursor);
            break;
          case 'note': {
            const isChord = !!child(e, 'chord');
            const grace = child(e, 'grace');
            const len = grace ? 0 : ticks(numberOf(e, 'duration'));
            const onset = isChord ? lastOnset : start + cursor;
            if (!isChord && !grace) {
              lastOnset = onset;
              cursor += len;
            }
            if (child(e, 'rest')) {
              if (!isChord) lastChord = [];
              break;
            }
            const staff = Number(textOf(e, 'staff') || 1);
            const voice = textOf(e, 'voice') || '1';
            let pitch: number;
            let hints: NoteNotation = {};
            const p = child(e, 'pitch');
            if (p) {
              const written = {
                step: STEPS.indexOf(textOf(p, 'step')),
                alter: Math.round(numberOf(p, 'alter')),
                octave: numberOf(p, 'octave', 4),
              };
              const shifted = { ...written, octave: written.octave + (shifts.get(staff) ?? 0) + octaveChange };
              const concert = transposeSpelling(shifted, chromatic, diatonic);
              pitch = (concert.octave + 1) * 12 + (LETTER_PC[concert.step] as number) + concert.alter;
              if (concert.alter !== 0) hints.sp = [concert.step, concert.alter, pitch];
            } else {
              const u = child(e, 'unpitched');
              drums = true;
              const inst = child(e, 'instrument')?.attrs.id ?? '';
              const step = STEPS.indexOf(textOf(u, 'display-step') || 'C');
              const octave = numberOf(u, 'display-octave', 5);
              pitch = pinfo.unpitched.get(inst) ?? 38;
              const head = HEADS[textOf(e, 'notehead')] ?? 'normal';
              drumPlaces.set(pitch, [step + 7 * (octave - 4) - 6, head]);
            }
            if (staves > 1) hints.st = staff;
            const nt = child(e, 'notations');
            const art = [
              ...(child(nt, 'articulations')?.children.map((a) => ARTIC[a.name]) ?? []),
              ...(child(nt, 'ornaments')?.children.map((a) =>
                a.name === 'tremolo' ? `trem${Math.min(4, Math.max(1, Number(a.text) || 3))}` : ORNAMENT[a.name],
              ) ?? []),
              ...(child(nt, 'technical')?.children.map((a) => TECHNICAL[a.name]) ?? []),
              ...(child(nt, 'fermata') ? ['ferm'] : []),
              ...(child(nt, 'arpeggiate') ? ['arp'] : []),
            ].filter((a): a is string => !!a && a !== 'breath' && a !== 'caesura');
            if (art.length) hints.a = [...new Set(art)];
            for (const a of child(nt, 'articulations')?.children ?? []) {
              if (a.name === 'breath-mark' || a.name === 'caesura')
                marks.push({
                  t: onset + len,
                  k: a.name === 'caesura' ? 'caesura' : 'breath',
                  ...(staves > 1 ? { st: staff } : {}),
                });
            }
            const fing = textOf(nt, 'technical/fingering');
            if (fing) hints.fi = fing;
            // the string it's played on (tab): kept while the note keeps its pitch
            const string = Number(textOf(nt, 'technical/string'));
            if (string >= 1 && string <= 12 && !drums) hints.tb = [string, pitch];
            const head = HEADS[textOf(e, 'notehead')];
            if (head && head !== 'normal' && !drums) hints.hd = head;
            if (grace) hints.g = grace.attrs.slash === 'yes' ? 'a' : 'p';
            const tm = child(e, 'time-modification');
            if (tm) {
              const actual = numberOf(tm, 'actual-notes', 3);
              const normal = numberOf(tm, 'normal-notes', 2);
              if (!(actual === 3 && normal === 2) && !(actual === 2 && normal === 3)) hints.tu = [actual, normal];
            }
            // lyrics, by verse
            for (const ly of children(e, 'lyric')) {
              const v = Math.max(1, Number(ly.attrs.number) || 1) - 1;
              const syl = textOf(ly, 'syllabic');
              let text = textOf(ly, 'text');
              if (syl === 'begin' || syl === 'middle') text += '-';
              else if (child(ly, 'extend')) text += '_';
              const list = hints.ly?.slice() ?? [];
              while (list.length < v) list.push('');
              list[v] = text;
              hints.ly = list;
            }
            // slurs, by number
            for (const s of children(nt, 'slur')) {
              const num = s.attrs.number ?? '1';
              if (s.attrs.type === 'start') slurs.set(`${staff}.${num}`, onset);
              else if (s.attrs.type === 'stop') {
                const from = slurs.get(`${staff}.${num}`);
                if (from !== undefined && onset > from)
                  marks.push({ t: from, k: 'slur', e: onset, ...(staves > 1 ? { st: staff } : {}) });
                slurs.delete(`${staff}.${num}`);
              }
            }
            const tieStop = children(e, 'tie').some((t) => t.attrs.type === 'stop');
            const tieStart = children(e, 'tie').some((t) => t.attrs.type === 'start');
            const key = `${staff}.${voice}.${pitch}`;
            const held = ties.get(key);
            if (tieStop && held && Math.abs(held.start + held.len - onset) < 2) {
              held.len += len;
              if (!tieStart) ties.delete(key);
              if (isChord) lastChord.push(held);
              else lastChord = [held];
              break;
            }
            hints = Object.keys(hints).length ? hints : {};
            const b: Building = {
              note: {
                t: grace ? Math.max(0, onset - 90) : onset,
                d: grace ? 90 : len,
                p: pitch,
                v: 80,
                ...(Object.keys(hints).length ? { n: hints } : {}),
              },
              start: grace ? Math.max(0, onset - 90) : onset,
              len: grace ? 90 : len,
              staff,
              voice,
            };
            notes.push(b);
            if (tieStart) ties.set(key, b);
            if (isChord) lastChord.push(b);
            else lastChord = [b];
            break;
          }
        }
      }
    });

    function direction(e: XmlNode, at: number, staff: number, global: boolean) {
      const st = staves > 1 ? { st: staff } : {};
      const above = e.attrs.placement !== 'below';
      let words = '';
      let metronome: number | null = null;
      for (const dt of children(e, 'direction-type')) {
        for (const d of dt.children) {
          if (d.name === 'dynamics') {
            for (const x of d.children) {
              const v = x.name === 'other-dynamics' ? x.text.trim() : x.name;
              if (isDynamic(v)) marks.push({ t: at, k: 'dyn', v, ...st });
            }
          } else if (d.name === 'wedge') {
            const num = d.attrs.number ?? '1';
            if (d.attrs.type === 'crescendo' || d.attrs.type === 'diminuendo') {
              wedges.set(num, { t: at, k: d.attrs.type === 'crescendo' ? 'cresc' : 'dim', st: staff });
            } else if (d.attrs.type === 'stop') {
              const w = wedges.get(num);
              if (w && at > w.t) marks.push({ t: w.t, k: w.k, e: at, ...(staves > 1 ? { st: w.st } : {}) });
              wedges.delete(num);
            }
          } else if (d.name === 'words') words += (words ? ' ' : '') + d.text.trim();
          else if (d.name === 'metronome') {
            const unit = textOf(d, 'beat-unit');
            const per = numberOf(d, 'per-minute');
            const quarters = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25 }[unit] ?? 1;
            const dotted = child(d, 'beat-unit-dot') ? 1.5 : 1;
            if (per) metronome = per * quarters * dotted;
          } else if (d.name === 'pedal') {
            if (d.attrs.type === 'start') cc64.push([at, 127]);
            else if (d.attrs.type === 'stop') cc64.push([at, 0]);
            else if (d.attrs.type === 'change') cc64.push([at - 1, 0], [at, 127]);
          } else if (d.name === 'octave-shift') {
            const size = Number(d.attrs.size ?? 8);
            const octaves = size >= 15 ? 2 : 1;
            if (d.attrs.type === 'down' || d.attrs.type === 'up') {
              // "down": written lower than it sounds (8va)
              const sign = d.attrs.type === 'down' ? 1 : -1;
              shifts.set(staff, sign * octaves);
              marks.push({ t: at, k: 'oct', e: at, v: sign * (octaves === 2 ? 15 : 8), ...st });
            } else if (d.attrs.type === 'stop') {
              shifts.delete(staff);
              const open = [...marks]
                .reverse()
                .find((x) => x.k === 'oct' && x.e === x.t && (x.st ?? 1) === (staves > 1 ? staff : 1));
              if (open) open.e = at;
            }
          } else if (global && (d.name === 'segno' || d.name === 'coda')) form.push({ tick: at, k: d.name });
        }
      }
      const sound = child(e, 'sound');
      if (sound?.attrs.tempo && global) metronome = metronome ?? Number(sound.attrs.tempo);
      if (sound) jumps(sound, at, words);
      if (metronome && global) {
        tempo.push({
          tick: at,
          bpm: Math.round(metronome * 100) / 100,
          mm: true,
          ...(words && !isJump(words) ? { text: words } : {}),
        });
        words = '';
      } else if (words && global && /\b(rit|rall|accel|a tempo|tempo primo|allarg)/i.test(words)) {
        tempo.push({ tick: at, bpm: tempo.at(-1)?.bpm ?? 120, text: words });
        words = '';
      }
      if (words && !isJump(words)) marks.push({ t: at, k: above ? 'text' : 'expr', v: words, ...st });
    }

    function sound(e: XmlNode, at: number) {
      if (e.attrs.tempo && firstPart) tempo.push({ tick: at, bpm: Number(e.attrs.tempo), mm: true });
      jumps(e, at, '');
    }

    // a staff with more than one voice keeps them (the first a staff has is its voice 1)
    const voicesOn = new Map<number, string[]>();
    for (const b of notes) {
      const list = voicesOn.get(b.staff) ?? [];
      if (!list.includes(b.voice)) list.push(b.voice);
      voicesOn.set(b.staff, list);
    }
    for (const b of notes) {
      const list = (voicesOn.get(b.staff) ?? []).sort((x, y) => Number(x) - Number(y));
      if (list.length > 1) b.note.n = { ...b.note.n, vo: Math.min(4, list.indexOf(b.voice) + 1) };
    }
    const region = newRegion(0, Math.max(PPQ * 4, starts.at(-1) ?? 0), pinfo.name);
    // dynamics and articulations, as they sound
    const byStaff = new Map<number, Mark[]>();
    for (const m of marks) byStaff.set(m.st ?? 1, [...(byStaff.get(m.st ?? 1) ?? []), m]);
    for (const list of byStaff.values()) list.sort((a, b) => a.t - b.t);
    region.notes = notes.map((b) => {
      const staffMarks = byStaff.get(staves > 1 ? b.staff : 1) ?? [];
      const art = b.note.n?.a ?? [];
      const v = velocityFor(levelAt(staffMarks, b.start), art);
      const sounding = b.note.n?.g
        ? b.len
        : Math.max(1, Math.round(b.len * gateFor(art, slurredAt(staffMarks, b.start))));
      const n: NoteNotation = { ...b.note.n, dv: v };
      if (sounding !== b.len) n.w = [b.len, sounding];
      return { t: b.start, d: sounding, p: b.note.p, v, n };
    });
    region.notes.sort((a, b) => a.t - b.t || a.p - b.p);
    if (marks.length) region.marks = marks.sort((a, b) => a.t - b.t);
    if (cc64.length) region.cc = { '64': cc64.sort((a, b) => a[0] - b[0]) };
    const track = newTrack(
      pinfo.name,
      drums || pinfo.channel === 10 ? { type: 'synth', preset: 'Drum Synth' } : { type: 'synth', preset: 'Soft Keys' },
    );
    track.regions = [region];
    const score: Track['score'] = {};
    if (pinfo.abbr) score.abbr = pinfo.abbr;
    if (staves > 1) score.staves = staves;
    if (clefs.length) score.clefs = clefs;
    // written above sounding: the opposite of MusicXML's transpose (sounding from written); an octave
    // clef (a guitar's, a tenor's) says its octave itself
    const firstClef = clefs.find((c) => c[1] === 1)?.[2] ?? '';
    const clefOctave = firstClef.endsWith('8vb') ? -1 : firstClef.endsWith('8va') ? 1 : 0;
    const octaves = octaveChange - clefOctave;
    if (chromatic || diatonic || octaves) score.tr = [-(chromatic + 12 * octaves), -(diatonic + 7 * octaves)];
    if (drums && drumPlaces.size)
      score.drums = Object.fromEntries([...drumPlaces].map(([p, place]) => [String(p), place]));
    if (Object.keys(score).length) track.score = score;
    tracks.push(track);
  });

  function isJump(words: string) {
    return /\b(D\.?\s?C\.?|D\.?\s?S\.?|da capo|dal segno|fine|to coda)\b/i.test(words);
  }

  function jumps(e: XmlNode, at: number, words: string) {
    if (e.attrs.fine === 'yes' || /^fine$/i.test(words)) form.push({ tick: at, k: 'fine' });
    if (e.attrs.tocoda || /to coda/i.test(words)) form.push({ tick: at, k: 'toCoda' });
    if (
      e.attrs.dacapo === 'yes' ||
      e.attrs.dalsegno ||
      /\b(D\.?\s?C\.?|D\.?\s?S\.?|da capo|dal segno)\b/i.test(words)
    ) {
      const ds = !!e.attrs.dalsegno || /D\.?\s?S\.?|dal segno/i.test(words);
      const al = /al fine/i.test(words) ? 'fine' : /al coda/i.test(words) ? 'coda' : undefined;
      form.push({ tick: at, k: ds ? 'ds' : 'dc', ...(al ? { al } : {}) });
    }
  }

  function barline(e: XmlNode, start: number, end: number) {
    const right = e.attrs.location !== 'left';
    const repeat = child(e, 'repeat');
    if (repeat?.attrs.direction === 'forward') form.push({ tick: start, k: 'start' });
    if (repeat?.attrs.direction === 'backward') {
      const times = Number(repeat.attrs.times ?? 2);
      form.push({ tick: end, k: 'end', ...(times > 2 ? { times } : {}) });
    }
    const ending = child(e, 'ending');
    if (ending) {
      const passes = (ending.attrs.number ?? '1')
        .split(/[,\s]+/)
        .map(Number)
        .filter((x) => x > 0);
      if (ending.attrs.type === 'start') form.push({ tick: start, k: 'ending', e: end, passes });
      else if (right) {
        // the ending runs to this bar's end
        const open = [...form].reverse().find((f) => f.k === 'ending' && f.passes?.join() === passes.join());
        if (open) open.e = end;
      }
    }
  }

  const project = newProject(title);
  project.tracks = tracks;
  project.meter = meter;
  if (keys.length) project.keys = keys;
  project.key = null;
  if (tempo.length) {
    tempo.sort((a, b) => a.tick - b.tick);
    project.tempo = tempo[0]?.tick === 0 ? tempo : [{ tick: 0, bpm: tempo[0]?.bpm ?? 120 }, ...tempo];
  }
  if (form.length) project.form = form.sort((a, b) => a.tick - b.tick);
  if (chords.length) project.chords = chords.sort((a, b) => a.tick - b.tick);
  if (breaks.length) credits.breaks = breaks;
  if (Object.keys(credits).length) project.score = credits;
  if (keys[0]?.tick === 0) {
    const k = keys[0];
    project.key = `${keyName(k.fifths, k.mode)}`;
  }
  return { project, warnings };
}

/** A written key brought to concert pitch for a transposing part (a B♭ part's D major is C major). */
function concertFifths(fifths: number, chromatic: number, diatonic: number): number {
  if (!chromatic && !diatonic) return fifths;
  let f = fifths + 7 * chromatic - 12 * diatonic;
  while (f > 7) f -= 12;
  while (f < -7) f += 12;
  return f;
}

const MODE_OFFSET: Record<KeyMode, number> = {
  lydian: -1,
  major: 0,
  mixolydian: 1,
  dorian: 2,
  minor: 3,
  phrygian: 4,
  locrian: 5,
};
function keyName(fifths: number, mode: KeyMode): string {
  const i = fifths + MODE_OFFSET[mode];
  const letter = 'FCGDAEB'[(((i + 1) % 7) + 7) % 7] as string;
  const alter = Math.floor((i + 1) / 7);
  return `${letter}${alter > 0 ? '#'.repeat(alter) : 'b'.repeat(-alter)} ${mode}`;
}

const KINDS: Record<string, string> = {
  major: '',
  minor: 'm',
  augmented: 'aug',
  diminished: 'dim',
  dominant: '7',
  'major-seventh': 'maj7',
  'minor-seventh': 'm7',
  'diminished-seventh': 'dim7',
  'augmented-seventh': 'aug7',
  'half-diminished': 'm7b5',
  'major-minor': 'm(maj7)',
  'major-sixth': '6',
  'minor-sixth': 'm6',
  'dominant-ninth': '9',
  'major-ninth': 'maj9',
  'minor-ninth': 'm9',
  'dominant-11th': '11',
  'dominant-13th': '13',
  'suspended-second': 'sus2',
  'suspended-fourth': 'sus4',
  power: '5',
};

/** A chord symbol from MusicXML's harmony: its root, its kind (or the text it's shown with), its bass. */
function harmony(e: XmlNode): string {
  const step = textOf(e, 'root/root-step');
  if (!step) return '';
  const alter = numberOf(e, 'root/root-alter');
  const kind = child(e, 'kind');
  const suffix = kind?.attrs.text ?? KINDS[kind?.text.trim() ?? 'major'] ?? '';
  const bassStep = textOf(e, 'bass/bass-step');
  const bassAlter = numberOf(e, 'bass/bass-alter');
  const acc = (a: number) => (a > 0 ? '#'.repeat(a) : 'b'.repeat(-a));
  return `${step}${acc(alter)}${suffix}${bassStep ? `/${bassStep}${acc(bassAlter)}` : ''}`;
}
