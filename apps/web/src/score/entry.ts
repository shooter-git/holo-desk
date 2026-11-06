/**
 * Writing in the Score: a caret on a staff, and what each key, click, palette button or note played
 * on a MIDI keyboard does there. Letters enter notes in the key (F in D major is F♯) near the last
 * one, digits choose the value (MuseScore's: 5 a quarter, 4 an eighth…), and the caret moves on. Every
 * edit is one undo step, and the notes just written are selected, so ↑ ↓ move them and Delete takes
 * them away as anywhere else.
 */
import {
  addMark,
  addToChord,
  type Caret,
  enter,
  extend,
  type FormKind,
  fromWritten,
  letterPitch,
  locate,
  lyricLine,
  nextBeat,
  placesOf,
  quantizeToScore,
  respell,
  type ScoreDoc,
  type Spelling,
  setChordSymbol,
  setClef,
  setForm,
  setKey,
  setLyric,
  setMeter,
  setVoice,
  spellInKey,
  toggleArticulation,
  withTab,
  writtenKeyAt,
} from '@holo/score';
import { type Note, type Op, PPQ, type Project, type TrackScore } from '@holo/session';
import { apply, ensureAudio } from '../app/actions.ts';
import { store, toast } from '../app/store.ts';
import { engine } from '../audio/engine.ts';

const WHOLE = PPQ * 4;

export interface EntryState extends Caret {
  /** The value: 1 whole … 64; with its dots. */
  value: number;
  dots: number;
  /** Notes left in a triplet being entered (0: none). */
  triplet: number;
  /** The last note written, as written: the next letter goes near it. */
  near: Spelling | null;
  /** The chord just written: Shift+letter adds to it, a tie lengthens it. */
  last: Note[];
  /** Words being typed in: a note's syllable (and its verse), or the chord symbol at a tick. */
  text?: TextTarget | null;
}

export type TextTarget =
  | { kind: 'lyric'; note: Note; verse: number; n: number }
  | { kind: 'chord'; tick: number; n: number };

/** On a drum part, letters enter drums (with Shift, together with the one just written). */
export const DRUM_KEYS: Record<string, [number, string]> = {
  b: [36, 'Bass drum'],
  n: [38, 'Snare'],
  x: [37, 'Side stick'],
  h: [42, 'Hi-hat, closed'],
  o: [46, 'Hi-hat, open'],
  p: [44, 'Hi-hat, foot'],
  c: [49, 'Crash'],
  r: [51, 'Ride'],
  u: [50, 'High tom'],
  m: [47, 'Mid tom'],
  f: [43, 'Floor tom'],
};

export const lengthOf = (value: number, dots: number): number => (WHOLE / value) * (2 - 1 / 2 ** dots);

/** MuseScore's digits for the values. */
export const DIGIT_VALUES: Record<string, number> = { '1': 64, '2': 32, '3': 16, '4': 8, '5': 4, '6': 2, '7': 1 };

const LETTERS = 'cdefgab';

export class Entry {
  state: EntryState | null = null;
  private listeners = new Set<() => void>();
  private docFor: (p: Project) => ScoreDoc;

  constructor(docFor: (p: Project) => ScoreDoc) {
    this.docFor = docFor;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<EntryState> | null): void {
    this.state = patch === null ? null : ({ ...this.state, ...patch } as EntryState);
    for (const l of this.listeners) l();
  }

  private ctx(): { project: Project; doc: ScoreDoc; s: EntryState } | null {
    const project = store.get().project;
    if (!project || !this.state) return null;
    return { project, doc: this.docFor(project), s: this.state };
  }

  /** Start writing: on the selected track (or the first part), at the selected note or the playhead. */
  start(doc: ScoreDoc, track: string | null, tick: number): void {
    const part = doc.parts.find((p) => p.track === track) ?? doc.parts[0];
    if (!part) return;
    const first = doc.bars[0]?.start ?? 0;
    const beat = PPQ;
    this.set({
      track: part.track,
      staff: 1,
      voice: 1,
      tick: Math.max(first, Math.round(tick / beat) * beat),
      value: this.state?.value ?? 4,
      dots: this.state?.dots ?? 0,
      triplet: 0,
      near: null,
      last: [],
    });
  }

  stop(): void {
    this.set(null);
  }

  /** Put the caret somewhere (a click on a staff, a selected note). */
  place(caret: Caret, near?: Spelling | null): void {
    this.set({ ...caret, triplet: 0, last: [], ...(near !== undefined ? { near } : {}) });
  }

  /** How long the next note is, in ticks (a triplet's two thirds). */
  length(): number {
    const s = this.state;
    if (!s) return PPQ;
    const len = lengthOf(s.value, s.dots);
    return s.triplet > 0 ? (len * 2) / 3 : len;
  }

  setValue(value: number): void {
    this.set({ value, dots: 0 });
  }

  toggleDot(): void {
    if (this.state) this.set({ dots: this.state.dots ? 0 : 1 });
  }

  toggleTriplet(): void {
    if (this.state) this.set({ triplet: this.state.triplet ? 0 : 3 });
  }

  private advance(len: number, last: Note[], near: Spelling | null): void {
    const s = this.state;
    if (!s) return;
    this.set({
      tick: s.tick + len,
      last,
      near: near ?? s.near,
      triplet: s.triplet > 0 ? s.triplet - 1 : 0,
    });
  }

  private commit(ops: Op[], label: string, notes: Note[] = []): boolean {
    if (!ops.length) return false;
    if (!apply(ops, label)) return false;
    if (notes.length) store.set({ selectedNotes: notes, selectedTrack: this.state?.track ?? null });
    return true;
  }

  private audition(notes: Note[]): void {
    const track = this.state?.track;
    if (!track || !notes.length) return;
    void ensureAudio().then(() => {
      for (const n of notes) engine.audition(track, n.p, n.v, 280);
    });
  }

  /** A letter typed: a note in the key near the last one (with Shift, added to the chord just written). */
  letter(letter: string, chord: boolean): void {
    const c = this.ctx();
    if (!c) return;
    const step = LETTERS.indexOf(letter);
    if (step < 0) return;
    const near = chord && c.s.last.length ? c.s.near : c.s.near;
    const { written, pitch } = letterPitch(c.project, c.doc, c.s, step, near);
    if (chord && c.s.last.length) {
      // a chord is built upwards: the letter above its top note
      let w = written;
      const top = Math.max(...c.s.last.map((n) => n.p));
      while (fromWritten(c.doc, c.s, w).p <= top) w = { ...w, octave: w.octave + 1 };
      const r = addToChord(c.project, c.s.last, [fromWritten(c.doc, c.s, w)]);
      if (this.commit(r.ops, 'Score: chord', [...c.s.last, ...r.notes])) {
        this.set({ last: [...c.s.last, ...r.notes], near: w });
        this.audition(r.notes);
      }
      return;
    }
    const len = this.length();
    const r = enter(c.project, c.doc, c.s, [pitch], len);
    if (this.commit(r.ops, 'Score: note', r.notes)) {
      this.advance(len, r.notes, written);
      this.audition(r.notes);
    }
  }

  /** Notes played on a MIDI keyboard together: a chord at the caret. */
  pitches(ps: number[]): void {
    const c = this.ctx();
    if (!c || !ps.length) return;
    const len = this.length();
    const key = writtenKeyAt(c.project, c.doc, c.s.track, c.s.tick);
    const r = enter(
      c.project,
      c.doc,
      c.s,
      ps.map((p) => ({ p })),
      len,
    );
    if (this.commit(r.ops, 'Score: notes', r.notes)) {
      const part = c.doc.parts.find((p) => p.track === c.s.track);
      const top = Math.max(...ps) + (part?.tr?.[0] ?? 0);
      this.advance(len, r.notes, spellInKey(top, key, 'major'));
    }
  }

  /** A note written at a place on a staff (a click while writing). */
  noteAt(caret: Caret, written: Spelling): void {
    this.place(caret);
    const c = this.ctx();
    if (!c) return;
    const len = this.length();
    const r = enter(c.project, c.doc, caret, [fromWritten(c.doc, caret, written)], len);
    if (this.commit(r.ops, 'Score: note', r.notes)) {
      this.advance(len, r.notes, written);
      this.audition(r.notes);
    }
  }

  rest(): void {
    const c = this.ctx();
    if (!c) return;
    const len = this.length();
    const r = enter(c.project, c.doc, c.s, [], len);
    if (r.ops.length) this.commit(r.ops, 'Score: rest');
    this.advance(len, [], null);
  }

  /** Tie on: the chord just written lasts another value. */
  tie(): void {
    const c = this.ctx();
    if (!c?.s.last.length) return;
    const len = this.length();
    const r = extend(c.project, c.doc, c.s, c.s.last, len);
    if (this.commit(r.ops, 'Score: tie', r.notes)) this.advance(len, r.notes, null);
  }

  /** Move the caret a value back or on. */
  move(direction: number): void {
    const c = this.ctx();
    if (!c) return;
    const first = c.doc.bars[0]?.start ?? 0;
    this.set({ tick: Math.max(first, c.s.tick + direction * this.length()), last: [], triplet: 0 });
  }

  /** The notes edits apply to: the selection, else what was just written. */
  private targets(): Note[] {
    const sel = store.get().selectedNotes;
    return sel.length ? sel : (this.state?.last ?? []);
  }

  articulation(art: string): void {
    const c = this.ctx();
    const notes = this.targets();
    if (!c || !notes.length) {
      toast('Select notes (or write one) to mark them');
      return;
    }
    const r = toggleArticulation(c.project, c.doc, notes, art);
    this.commit(r.ops, 'Score: articulation', r.notes);
    if (c.s.last.length) this.set({ last: r.notes.filter((n) => c.s.last.some((l) => l.p === n.p)) });
  }

  /** Where the first target note starts (else the caret). */
  private startTick(project: Project, notes: Note[]): number {
    const ticks = notes.map((n) => {
      const at = locate(project, n);
      return at ? at.region.start + n.t : Number.POSITIVE_INFINITY;
    });
    const t = Math.min(...ticks);
    return Number.isFinite(t) ? t : (this.state?.tick ?? 0);
  }

  dynamic(value: string): void {
    const c = this.ctx();
    if (!c) return;
    const at = this.startTick(c.project, this.targets());
    this.commit(addMark(c.project, c.doc, c.s.track, c.s.staff, { t: at, k: 'dyn', v: value }).ops, `Score: ${value}`);
  }

  /** A hairpin or slur over the selected notes (from the first to the last). */
  span(kind: 'cresc' | 'dim' | 'slur'): void {
    const c = this.ctx();
    if (!c) return;
    const notes = this.targets();
    const ticks = notes
      .map((n) => {
        const at = locate(c.project, n);
        return at ? at.region.start + n.t : null;
      })
      .filter((t): t is number => t !== null);
    const from = Math.min(...ticks);
    let to = Math.max(...ticks);
    if (kind !== 'slur' && Number.isFinite(to)) {
      const lastNote = notes.find((n) => {
        const at = locate(c.project, n);
        return at && at.region.start + n.t === to;
      });
      to += lastNote?.d ?? 0;
    }
    if (!Number.isFinite(from) || (kind === 'slur' && to <= from)) {
      toast(kind === 'slur' ? 'Select two or more notes to slur' : 'Select the notes it spans');
      return;
    }
    this.commit(addMark(c.project, c.doc, c.s.track, c.s.staff, { t: from, k: kind, e: to }).ops, `Score: ${kind}`);
  }

  respell(): void {
    const c = this.ctx();
    const notes = this.targets();
    if (!c || !notes.length) return;
    const r = respell(c.project, c.doc, notes);
    this.commit(r.ops, 'Score: respell', r.notes);
  }

  voice(v: number): void {
    const c = this.ctx();
    if (!c) return;
    const sel = store.get().selectedNotes;
    if (sel.length) this.commit(setVoice(c.project, sel, v).ops, `Score: voice ${v}`);
    this.set({ voice: v, last: [] });
  }

  /** The bar the caret is in, for clef, key and time changes. */
  private barStart(doc: ScoreDoc): number {
    const t = this.state?.tick ?? 0;
    let start = doc.bars[0]?.start ?? 0;
    for (const b of doc.bars) if (b.start <= t) start = b.start;
    return start;
  }

  clef(clef: string): void {
    const c = this.ctx();
    if (c)
      this.commit(setClef(c.project, c.doc, c.s.track, c.s.staff, this.barStart(c.doc), clef), `Score: ${clef} clef`);
  }

  key(key: { fifths: number; mode: 'major' | 'minor' } | null): void {
    const c = this.ctx();
    if (c) this.commit(setKey(c.project, this.barStart(c.doc), key), 'Score: key');
  }

  time(num: number, den: number): void {
    const c = this.ctx();
    if (c) this.commit(setMeter(c.project, this.barStart(c.doc), num, den), `Score: ${num}/${den}`);
  }

  /** A repeat sign, an ending or a jump in the caret's bar (null: none there any more). */
  form(kind: FormKind | null, label: string): void {
    const c = this.ctx();
    if (!c) return;
    const start = this.barStart(c.doc);
    const bar = c.doc.bars.find((b) => b.start === start);
    if (!bar) return;
    if (!this.commit(setForm(c.project, start, start + bar.length, kind), `Score: ${label}`) && kind === null)
      toast('This bar has no repeats or jumps');
  }

  /** Played-in music written as it's shown. */
  tidy(): void {
    const c = this.ctx();
    if (!c) return;
    const r = quantizeToScore(c.project, c.doc, c.s.track);
    if (this.commit(r.ops, 'Score: tidy rhythms')) toast('The notes now start and end where the score shows them');
  }

  /** Whether the caret's part is a drum part. */
  private drums(): boolean {
    const c = this.ctx();
    return !!c?.doc.parts.find((p) => p.track === c.s.track)?.drums;
  }

  /** A drum written at the caret (Shift: with the one just written). */
  drum(pitch: number, together: boolean): void {
    const c = this.ctx();
    if (!c) return;
    if (together && c.s.last.length) {
      const r = addToChord(c.project, c.s.last, [{ p: pitch }]);
      if (this.commit(r.ops, 'Score: drum', [...c.s.last, ...r.notes])) this.set({ last: [...c.s.last, ...r.notes] });
      this.audition(r.notes);
      return;
    }
    const len = this.length();
    const r = enter(c.project, c.doc, c.s, [{ p: pitch }], len);
    if (this.commit(r.ops, 'Score: drum', r.notes)) {
      this.advance(len, r.notes, null);
      this.audition(r.notes);
    }
  }

  /** Tab for the caret's part: under its staff, on its own, or none. */
  tab(mode: 'under' | 'only' | 'off'): void {
    const c = this.ctx();
    const track = c?.project.tracks.find((t) => t.id === c.s.track);
    if (!c || !track) return;
    const score: TrackScore = withTab(track, mode);
    this.commit(
      [{ op: 'updateTrack', track: track.id, patch: { score } }],
      mode === 'off' ? 'Score: no tab' : 'Score: tab',
    );
  }

  /** Lyrics from the selected note (or the first at the caret): a syllable a note, Space to go on. */
  lyrics(verse = 1): void {
    const c = this.ctx();
    if (!c) return;
    const places = placesOf(c.doc);
    let note: Note | undefined = store.get().selectedNotes.find((n) => places.get(n)?.track === c.s.track);
    if (!note) {
      let best: [Note, number] | null = null;
      for (const [n, p] of places) {
        if (p.track !== c.s.track || p.staff !== c.s.staff || p.voice !== c.s.voice) continue;
        const at = locate(c.project, n);
        const t = at ? at.region.start + n.t : Number.POSITIVE_INFINITY;
        if (t >= c.s.tick && (!best || t < best[1])) best = [n, t];
      }
      note = best?.[0];
    }
    if (!note) {
      toast('Write the notes first: lyrics go on them, a syllable a note');
      return;
    }
    const line = lyricLine(c.doc, note);
    const top =
      line.find((n) => n === note) ??
      line.find(
        (n) => locate(c.project, n)?.region === locate(c.project, note as Note)?.region && n.t === (note as Note).t,
      ) ??
      note;
    store.set({ selectedNotes: [top], selectedTrack: c.s.track });
    this.set({ text: { kind: 'lyric', note: top, verse, n: (this.state?.text?.n ?? 0) + 1 } });
  }

  /** Chord symbols from the caret (or the selected note): Space goes on a beat. */
  chordSymbols(): void {
    const c = this.ctx();
    if (!c) return;
    const sel = store.get().selectedNotes[0];
    const at = sel ? locate(c.project, sel) : null;
    const tick = at && sel ? at.region.start + sel.t : c.s.tick;
    this.set({ text: { kind: 'chord', tick, n: (this.state?.text?.n ?? 0) + 1 } });
  }

  /** What's there now for the words being typed (a syllable, a chord symbol). */
  textNow(): string {
    const t = this.state?.text;
    const project = store.get().project;
    if (!t || !project) return '';
    if (t.kind === 'chord') return project.chords.find((x) => x.tick === t.tick)?.symbol ?? '';
    return t.note.n?.ly?.[t.verse - 1] ?? '';
  }

  /** The words typed in, written; then on to the next note or beat (`next`), or done. */
  commitText(value: string, next: boolean): void {
    const c = this.ctx();
    const t = c?.s.text;
    if (!c || !t) return;
    if (t.kind === 'chord') {
      if (value.trim() !== this.textNow()) this.commit(setChordSymbol(c.project, t.tick, value), 'Score: chord symbol');
      this.set({ text: next ? { ...t, tick: nextBeat(c.doc, t.tick), n: t.n + 1 } : null });
      return;
    }
    const line = lyricLine(c.doc, t.note);
    const after = line[line.indexOf(t.note) + 1];
    if (value.trim() !== this.textNow()) {
      const r = setLyric(c.project, t.note, t.verse, value);
      this.commit(r.ops, 'Score: lyric');
    }
    if (next && after) {
      store.set({ selectedNotes: [after] });
      this.set({ text: { ...t, note: after, n: t.n + 1 } });
    } else this.set({ text: null });
  }

  closeText(): void {
    if (this.state?.text) this.set({ text: null });
  }

  /** A key while writing: true when it was the Score's. */
  key_(e: KeyboardEvent): boolean {
    if (!this.state) return false;
    if (e.ctrlKey || e.metaKey) return false;
    const k = e.key;
    const lower = k.length === 1 ? k.toLowerCase() : k;
    // Musical Typing plays notes into the score itself (as a MIDI keyboard does)
    if (store.get().typing && /^[a-z;']$/.test(lower) && !'.0123456789'.includes(lower)) return false;
    if (e.shiftKey && !e.altKey && (lower === 'l' || lower === 'q')) {
      if (lower === 'l') this.lyrics();
      else this.chordSymbols();
      return true;
    }
    if (!e.altKey && /^[a-z]$/.test(lower) && this.drums()) {
      // (a drum part's letters are its drums; the others write nothing)
      const drum = DRUM_KEYS[lower];
      if (drum) {
        this.drum(drum[0], e.shiftKey);
        return true;
      }
      if (/^[a-g]$/.test(lower)) return true;
    }
    if (/^[a-g]$/.test(lower) && !e.altKey) {
      this.letter(lower, e.shiftKey);
      return true;
    }
    if (!e.shiftKey && !e.altKey && k in DIGIT_VALUES) {
      this.setValue(DIGIT_VALUES[k] as number);
      return true;
    }
    if (e.altKey && /^[1-4]$/.test(k)) {
      this.voice(Number(k));
      return true;
    }
    switch (k) {
      case '.':
        this.toggleDot();
        return true;
      case '0':
        this.rest();
        return true;
      case ';':
        this.toggleTriplet();
        return true;
      case 't':
      case 'T':
        this.tie();
        return true;
      case 'j':
      case 'J':
        this.respell();
        return true;
      case 's':
      case 'S':
        this.span('slur');
        return true;
      case 'ArrowLeft':
      case 'ArrowRight':
        this.move(k === 'ArrowLeft' ? -1 : 1);
        return true;
      case 'Escape':
        store.set({ scoreWrite: false });
        return true;
    }
    return false;
  }
}
