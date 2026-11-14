/**
 * The Audio Editor's Notes view: the notes of the region's recording on the song's timeline and the
 * Piano Roll's keys and lanes. Each note is a capsule at its pitch from its start to its end, as thick
 * as it's loud, with its pitch every 5 ms drawn through it as its edits make it sound (and as it was
 * sung, faintly, where they change it). The region's own span is lit and the rest of its recording
 * dim, as in the waveform. Time scrolls and zooms with the waveform's view, so switching between the
 * two keeps the place; the lanes scroll and zoom on their own.
 *
 * Notes are edited with the bar's tools (note-tools.ts): a drag shows its result as it goes and makes
 * one undo step when it's let go, through the session's note edits (NOTE_EDITS), never by hand. The
 * first edit of a region keeps the notes found in its recording in the song (those it plays and the
 * two nearest past either end, as a split keeps them), with that edit made, in the same step; looking
 * alone never changes the song. The notes selected are numbered as the region keeps them (or will),
 * and the studio tells the agent which they are (live.ts). A region's edits can be switched off and on,
 * to hear the recording as it was (A/B). While an edit's sound is being rendered, its stretch is
 * striped and the bar says so.
 */
import { DETECT_V, editedPitch, isEdited, regionPatches } from '@holo/engine';
import {
  ATTACK_S,
  type AudioClip,
  type AudioNote,
  fileSpan,
  type MiddleC,
  type NoteArgs,
  type NoteEditContext,
  type AudioNotes as NoteList,
  noteEdit,
  noteName,
  PITCH_SNAPS,
  type PitchSnap,
  type Project,
  pruneNotes,
  type Region,
  roundTime,
  scaleAt,
  type Track,
  ticksPerBar,
  ticksPerBeat,
} from '@holo/session';
import {
  Ellipsis,
  MicVocal,
  MousePointer2,
  MoveHorizontal,
  MoveVertical,
  Route,
  Scissors,
  Spline,
  Volume2,
  Waves,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import { apply, findRegion, locate } from '../app/actions.ts';
import { isPhone, useLayout } from '../app/layout.ts';
import { store, useApp } from '../app/store.ts';
import { engine } from '../audio/engine.ts';
import { type FoundNotes, type NoteCurve, type NotesState, recordingNotes } from '../audio/notes.ts';
import { audioView, fitAudioView, NoRecordings, useAudioRegion } from './AudioEditor.tsx';
import { alpha, prepare, roundRect, useFrame, useSize } from './frame.ts';
import {
  capture,
  edgeScroll,
  type Gesture,
  type GestureOptions,
  isMenuPress,
  Pinch,
  screenDpr,
  useWheel,
} from './gesture.ts';
import { drawKeys, drawLanes } from './keys.ts';
import { type MenuEntry, openMenu, openMenuAt } from './menu.tsx';
import {
  capsule,
  capsuleHalf,
  curveRuns,
  fileToTicks,
  firstAt,
  fitPitches,
  laneTop,
  levelThickness,
  maxPitchScroll,
  type PitchView,
  pitchAtY,
  pitchY,
  restingPitch,
  shownPitch,
  thinPoints,
  tickToFile,
  zoomPitch,
} from './note-lanes.ts';
import {
  AMOUNT_TOOLS,
  type AmountTool,
  AXIS_LOCK_PX,
  amountGroups,
  amountOf,
  attackAfterDrag,
  dragSeconds,
  hitBoundary,
  hitNote,
  isAmountTool,
  keyShiftArgs,
  lockAxis,
  missedSpan,
  NOTE_TOOLS,
  type NoteBox,
  type NoteHit,
  type NoteTool,
  noteBoxes,
  notesInRect,
  notesTouch,
  noteTool,
  PITCH_SNAP_NAMES,
  shiftArgs,
  snapPitchTarget,
  snapTick,
} from './note-tools.ts';
import { drawRuler } from './ruler.ts';
import { UndoRedo } from './UndoRedo.tsx';
import { DOUBLE_TAP_MS, gridStep, TouchPan, WHEEL_ZOOM, ZOOM } from './view.ts';

/**
 * How tall the lanes' semitones are, kept while the studio is open, and the region they were last
 * placed for: for now (`placed`), then round its notes once they're known (`fitted`). Their scroll is
 * the time view's own `y`, so a finger moves both at once.
 */
const lanes = { keyHeight: 14, placed: '', fitted: '' };

/** The lanes as they're shown, in a view `h` pixels tall (kept within their scroll). */
function pitchView(h: number): PitchView {
  return { keyHeight: lanes.keyHeight, y: Math.min(audioView.y, maxPitchScroll(lanes.keyHeight, h)) };
}

function setPitchView(v: PitchView): void {
  lanes.keyHeight = v.keyHeight;
  audioView.y = v.y;
  audioView.emit();
}

const onNotesFound = (fn: () => void) => recordingNotes.subscribe(fn);

/** What's known of a recording's notes, kept current (and found the first time it's asked for). */
function useFound(project: string | undefined, file: string | undefined): NotesState | null {
  return useSyncExternalStore(onNotesFound, () => (project && file ? recordingNotes.of(project, file) : null));
}

/** The notes a region shows: its own (as edited) when it has them, else those found in its recording. */
function notesShown(clip: AudioClip, state: NotesState | null): readonly AudioNote[] | null {
  if (clip.notes) return clip.notes.n;
  return state?.state === 'found' ? state.found.notes : null;
}

/** Each recording's notes as a region keeps them with its first edit, worked out once for its window. */
const regionFound = new WeakMap<readonly AudioNote[], { window: string; notes: NoteList }>();

/**
 * The notes found in a region's recording as the region keeps them with its first edit: those it
 * plays and the two nearest past either end (pruneNotes, as a split keeps them, and as the agent and
 * `holo notes` keep them, so all three number them alike); null while they're still being found.
 */
function foundNotes(project: Project, region: Region, clip: AudioClip, state: NotesState | null): NoteList | null {
  if (state?.state !== 'found') return null;
  const found = state.found.notes;
  const window = fileWindow(project, region, clip);
  const kept = regionFound.get(found);
  if (kept?.window === window.join()) return kept.notes;
  const notes = pruneNotes({ mode: 'mono', v: DETECT_V, n: found }, window);
  regionFound.set(found, { window: window.join(), notes });
  return notes;
}

/**
 * The notes a region's edits start from: its own (with its edits on: an edit is made to be heard),
 * else those found in its recording as its first edit keeps them; null while they're still being found.
 */
function editableNotes(project: Project, region: Region, clip: AudioClip, state: NotesState | null): NoteList | null {
  const own = clip.notes;
  if (own) {
    if (!own.off) return own;
    const { off: _off, ...on } = own;
    return on;
  }
  return foundNotes(project, region, clip, state);
}

const NO_NOTES: readonly number[] = [];

/** The notes selected in a region (none when the selection is another region's). */
function selectedIn(region: string): readonly number[] {
  const s = store.get().selectedAudioNotes;
  return s?.region === region ? s.notes : NO_NOTES;
}

/** A region's notes selected (none: nothing selected). */
function setSelected(region: string, notes: readonly number[]): void {
  store.set({ selectedAudioNotes: notes.length ? { region, notes: [...notes] } : null });
}

/** What a note edit needs to know beyond the notes: the song and the region they're in (for the key's scale). */
function editContext(project: Project, region: Region, clip: AudioClip, notes: NoteList, middleC: MiddleC) {
  const ctx: NoteEditContext = {
    project,
    region: { start: region.start, audio: { offset: clip.offset, stretch: clip.stretch, notes } },
    middleC,
  };
  return ctx;
}

/** A note edit by its name in NOTE_EDITS: the notes as edited, or as they were when it doesn't apply. */
function runEdit(
  name: string,
  notes: NoteList,
  indices: readonly number[],
  args: NoteArgs,
  ctx: NoteEditContext,
): NoteList {
  return noteEdit(name)?.apply(notes, indices, args, ctx) ?? notes;
}

const onPatches = (fn: () => void) => engine.onPatches(fn);
const patchVersion = () => engine.patchVersion;

/** Where a region's note edits are in being heard: rendered from its recording, or still on their way. */
interface PatchStatus {
  /** Its patches the engines play, and those still rendering (the recording plays there as it was). */
  ready: number;
  pending: number;
  /** The edited notes in those still rendering. */
  notes: number;
  /** Where those are, in seconds of its recording as the region plays it. */
  spans: [number, number][];
}

function patchStatus(clip: AudioClip): PatchStatus {
  const out: PatchStatus = { ready: 0, pending: 0, notes: 0, spans: [] };
  const notes = clip.notes;
  if (!notes || notes.off) return out;
  const sr = engine.sampleRate;
  const scale = clip.stretch * sr;
  const counted = new Set<number>();
  for (const job of regionPatches(clip, sr)) {
    const state = engine.patchState(job.key);
    if (state === 'ready') out.ready++;
    if (state !== 'pending') continue;
    out.pending++;
    out.spans.push([job.spec.a / scale, job.spec.b / scale]);
    notes.n.forEach((n, i) => {
      if (isEdited(n) && n.t * scale < job.spec.b && (n.t + n.d) * scale > job.spec.a) counted.add(i);
    });
  }
  out.notes = Math.max(counted.size, out.pending);
  return out;
}

/** The seconds of its recording a region plays, [from, to). */
function fileWindow(project: Project, region: Region, clip: AudioClip): [number, number] {
  return [clip.offset, tickToFile(project.tempo, region.start, clip, region.start + region.length)];
}

/** What the bar says of the notes: how many the region plays (and how many are selected), or what's keeping them. */
function notesStatus(
  project: Project,
  region: Region,
  clip: AudioClip,
  state: NotesState | null,
  selected: number,
): string {
  const notes = notesShown(clip, state);
  if (!notes) {
    if (state?.state === 'failed') return 'Notes couldn’t be found';
    return 'Finding notes…';
  }
  const [a, b] = fileWindow(project, region, clip);
  const count = notes.filter((n) => n.t + n.d > a && n.t < b).length;
  const text = count === 1 ? '1 note' : `${count} notes`;
  return selected ? `${text}, ${selected} selected` : text;
}

/** A note's name for its menu: its pitch now ("E4 +18 cents"), or what it is when it has none. */
function noteHeading(n: AudioNote, middleC: MiddleC): string {
  if (n.p === null) return 'No pitch (a breath or a consonant)';
  const pitch = n.to ?? n.p;
  const cents = Math.round((pitch - Math.round(pitch)) * 100);
  return `${noteName(Math.round(pitch), middleC)}${cents ? ` ${cents > 0 ? '+' : '−'}${Math.abs(cents)} cents` : ''}`;
}

/** What a drag has made so far: shown in place of the region's notes until it's let go. */
interface Preview {
  /** The region's notes as the drag leaves them. */
  notes?: NoteList;
  /** A marquee, from where it was pressed (a tick and a pitch, so it stays put as the view scrolls) to the pointer. */
  marquee?: { tick: number; pitch: number; x: number; y: number };
  /** What the drag comes to, in words, by the pointer ("F#4", "Vibrato 140%"). */
  readout?: { text: string; x: number; y: number };
}

export function AudioNotes() {
  const { project, track, region } = useAudioRegion();
  const layout = useLayout();
  const phone = isPhone(layout);
  const middleC = useApp((s) => s.middleC);
  const tool = useApp((s) => s.noteTool);
  const snap = useApp((s) => s.pitchSnap);
  const selection = useApp((s) => s.selectedAudioNotes);
  const selected = selection && selection.region === region?.id ? selection.notes : NO_NOTES;
  const keysWidth = phone ? 44 : 66;
  const clip = region?.audio;
  const state = useFound(project?.id, clip?.file);
  const patches = useSyncExternalStore(onPatches, patchVersion);

  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const keysBox = useRef<HTMLDivElement>(null);
  const rulerBox = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const keysCanvas = useRef<HTMLCanvasElement>(null);
  const rulerCanvas = useRef<HTMLCanvasElement>(null);
  const size = useSize(box);
  const rulerSize = useSize(rulerBox);
  const dirty = useRef(true);
  const gesture = useRef<Gesture | null>(null);
  const preview = useRef<Preview | null>(null);
  /** The notes as last drawn (the region's own span): the mouse's cursor is chosen by what it's over. */
  const drawn = useRef<{ boxes: NoteBox[]; notes: readonly AudioNote[] }>({ boxes: [], notes: [] });
  /** The last press: a second on the same note (or boundary) soon after is a double-click. */
  const lastTap = useRef({ at: 0, key: '' });
  /** The menu a long press opens, for what it was pressed on. */
  const menuAt = useRef<((ev: PointerEvent) => void) | null>(null);
  const pinch = useRef(new Pinch());
  /** Which way a pinch zooms, from how its fingers first spread: time across, pitch up and down. */
  const pinchAxis = useRef<'x' | 'y' | null>(null);
  const lastOverlay = useRef({ x: -1, w: 0, h: 0, rec: false, dpr: 0 });
  const lastDpr = useRef(screenDpr());

  // everything the picture reads: a change to any of it redraws
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list is what drawing reads, not what the effect touches
  useEffect(() => {
    dirty.current = true;
  }, [project, track, region, state, size, rulerSize, keysWidth, middleC, patches, tool, snap, selected]);
  useEffect(() => audioView.subscribe(() => (dirty.current = true)), []);
  // the region shown has its edits rendered first
  useEffect(() => {
    engine.focusPatches(region?.id ?? null);
    return () => engine.focusPatches(null);
  }, [region?.id]);
  useEffect(() => () => gesture.current?.abort(), []);
  // a selection past the notes (an undo took some away) keeps only those still there
  const count =
    clip?.notes?.n.length ??
    (project && region && clip ? (foundNotes(project, region, clip, state)?.n.length ?? 0) : 0);
  useEffect(() => {
    if (region && selected.some((i) => i >= count))
      setSelected(
        region.id,
        selected.filter((i) => i < count),
      );
  }, [region, selected, count]);

  // a region opens: its whole recording in view, as the waveform shows it
  // biome-ignore lint/correctness/useExhaustiveDependencies: refits when the region changes, not on every edit
  useLayoutEffect(() => {
    if (project && region) fitAudioView(project, region, size.w);
  }, [region?.id, size.w > 0]);

  /** How far the lanes scroll down (their zoom is kept outside React). */
  const maxY = () => maxPitchScroll(lanes.keyHeight, size.h);

  /** The lanes placed for the region: round its notes once they're known, round the octave above middle C till then. */
  const placeLanes = (p: Project, r: Region, c: AudioClip) => {
    if (!size.h || lanes.fitted === r.id) return;
    const notes = notesShown(c, state);
    if (!notes) {
      if (lanes.placed === r.id) return;
      lanes.placed = r.id;
      setPitchView(fitPitches(60, 72, size.h, phone ? 12 : 8));
      return;
    }
    lanes.placed = r.id;
    lanes.fitted = r.id;
    const [a, b] = fileWindow(p, r, c);
    const pitched = (list: readonly AudioNote[]) =>
      list.map((n) => (c.notes?.off ? n.p : shownPitch(n))).filter((x): x is number => x !== null);
    let pitches = pitched(notes.filter((n) => n.t + n.d > a && n.t < b));
    if (!pitches.length) pitches = pitched(notes);
    if (!pitches.length) pitches = [60, 72];
    setPitchView(fitPitches(Math.min(...pitches), Math.max(...pitches), size.h, phone ? 12 : 8));
  };

  /** The picture as it is now; `pending` (the stripes) only for drawing. */
  const sceneOf = (p: Project, pending = false): Scene | null => {
    if (!track || !region || !clip) return null;
    const s = store.get();
    return {
      project: p,
      track,
      region,
      clip,
      state,
      pending: pending ? patchStatus(clip).spans : [],
      view: pitchView(size.h),
      w: size.w,
      h: size.h,
      preview: preview.current,
      selected: new Set(selectedIn(region.id)),
      tool: s.noteTool,
      touch: phone,
    };
  };

  useFrame(() => {
    const p = store.get().project;
    if (!p) return;
    if (region && clip) placeLanes(p, region, clip);
    // a drag resting at an edge scrolls the view under it
    const g = gesture.current;
    if (g?.edgeScroll && g.moved && box.current) {
      const { dx, dy } = edgeScroll(g.last, box.current.getBoundingClientRect(), g.edgeScroll);
      if (dx || dy) {
        audioView.scrollBy(dx, dy, maxY());
        g.replay();
      }
    }
    const dpr = screenDpr();
    if (dpr !== lastDpr.current) {
      lastDpr.current = dpr;
      dirty.current = true;
    }
    if (dirty.current) {
      dirty.current = false;
      const v = pitchView(size.h);
      const kctx = prepare(keysCanvas.current, keysWidth, size.h);
      if (kctx) {
        drawKeys(kctx, {
          width: keysWidth,
          height: size.h,
          keyHeight: v.keyHeight,
          yOf: (pitch) => laneTop(pitch, v.keyHeight, v.y),
          color: track?.color ?? '#5cb8ff',
          middleC,
        });
      }
      const ctx = prepare(canvas.current, size.w, size.h);
      const scene = sceneOf(p, true);
      if (ctx && scene) {
        draw(ctx, scene);
        drawn.current = { boxes: sceneBoxes(scene), notes: placed(scene, true).notes ?? [] };
      }
      const rctx = prepare(rulerCanvas.current, rulerSize.w, rulerSize.h);
      if (rctx) drawRuler(rctx, p, audioView, rulerSize.w, rulerSize.h);
    }
    // the playhead, on its own layer, redrawn only when it has moved a pixel
    const x = Math.round(audioView.tickToX(Math.max(0, engine.positionTick()))) + 0.5;
    const rec = store.get().recording;
    const last = lastOverlay.current;
    if (x !== last.x || size.w !== last.w || size.h !== last.h || rec !== last.rec || dpr !== last.dpr) {
      lastOverlay.current = { x, w: size.w, h: size.h, rec, dpr };
      const octx = prepare(overlay.current, size.w, size.h);
      if (octx) {
        octx.clearRect(0, 0, size.w, size.h);
        if (x >= 0 && x <= size.w) {
          octx.fillStyle = rec ? '#ff4f5e' : '#ffffff';
          octx.fillRect(x - 0.5, 0, 1.5, size.h);
        }
      }
    }
  });

  const zoomLanes = (factor: number, at: number) => setPitchView(zoomPitch(pitchView(size.h), factor, at, size.h));

  const onWheel = (e: WheelEvent, dx: number, dy: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    if (e.ctrlKey || e.metaKey)
      audioView.zoomAt(Math.exp(-dy * WHEEL_ZOOM), Math.max(0, e.clientX - rect.left), ...ZOOM.audio);
    else if (e.altKey) zoomLanes(Math.exp(-dy * WHEEL_ZOOM), e.clientY - rect.top);
    else if (e.shiftKey) audioView.scrollBy(dy || dx, 0, maxY());
    else audioView.scrollBy(dx, dy, maxY());
  };
  useWheel(box, onWheel);
  useWheel(keysBox, onWheel);
  useWheel(rulerBox, onWheel);

  if (!project || !track) return <div className="audio-ed empty">Select a track.</div>;
  if (!region || !clip) return <NoRecordings track={track} />;

  const m = project.meter[0] ?? { tick: 0, num: 4, den: 4 };
  /** The grid's step, as the lines are drawn at this zoom. */
  const gridTicks = () => gridStep(audioView.pxPerTick, 14, ticksPerBeat(m), ticksPerBar(m));
  const snapTo = (tick: number, free: boolean) => snapTick(tick, gridTicks(), free);

  /** The notes as drawn now, for finding the one under a pointer (what's drawn is what's hit). */
  const boxesNow = (): NoteBox[] => {
    const p = store.get().project;
    const s = p && sceneOf(p);
    return s ? sceneBoxes(s) : [];
  };

  /** The region, its track and its recording as the song has them now (a menu chosen later than it was opened). */
  const current = () => {
    const p = store.get().project;
    const found = p && findRegion(p, region.id);
    return found?.region.audio
      ? { project: p, track: found.track, region: found.region, clip: found.region.audio }
      : null;
  };

  /**
   * Notes edited, made the region's in one undo step (its first edit keeps the notes found with it),
   * and the selection set when given; nothing when they come to what they were.
   */
  const commit = (next: NoteList, base: NoteList, label: string, select?: number[]) => {
    if (select) setSelected(region.id, select);
    const now = current();
    if (next === base || !now) return;
    apply(
      [
        {
          op: 'updateRegion',
          track: now.track.id,
          region: now.region.id,
          patch: { audio: { ...now.clip, notes: next } },
        },
      ],
      label,
    );
  };

  const clearPreview = () => {
    if (!preview.current) return;
    preview.current = null;
    dirty.current = true;
  };

  /**
   * Start a gesture: the one under way at a time, aborted by a second finger or a long press (which
   * opens the menu for the spot), its preview cleared whichever way it ends.
   */
  const start = (e: ReactPointerEvent, o: GestureOptions): Gesture => {
    gesture.current?.abort();
    const menu = menuAt.current;
    const g = capture(e, {
      ...o,
      onUp: (ev, gg) => {
        gesture.current = null;
        o.onUp?.(ev, gg);
        clearPreview();
      },
      onAbort: () => {
        gesture.current = null;
        clearPreview();
        o.onAbort?.();
      },
      onLongPress: menu ? (ev) => menu(ev) : undefined,
    });
    gesture.current = g;
    return g;
  };

  /** The second of the recording as recorded at a place across the view (through the notes' moves). */
  const recordedAt = (base: NoteList, x: number) =>
    tickToFile(
      project.tempo,
      region.start,
      { offset: clip.offset, stretch: clip.stretch, notes: base },
      audioView.xToTick(x),
    );

  /** A drag's result shown as it goes, with its readout by the pointer. */
  const show = (notes: NoteList, text: string, ev: PointerEvent, rect: DOMRect) => {
    preview.current = {
      notes,
      readout: text ? { text, x: ev.clientX - rect.left, y: ev.clientY - rect.top } : undefined,
    };
    dirty.current = true;
  };

  /** Each note's pitch snapped (to a semitone, or the key's scale where it plays): set-pitch, note by note. */
  const snapped = (base: NoteList, group: readonly number[], ctx: NoteEditContext): NoteList => {
    const ticks = fileToTicks(project.tempo, region.start, { offset: clip.offset, stretch: clip.stretch, notes: base });
    let next = base;
    for (const i of group) {
      const n = base.n[i];
      if (!n) continue;
      const scale = snap === 'scale' ? scaleAt(project, ticks(n.t + (n.u ?? 0))) : null;
      const pitch = snapPitchTarget(n, snap, scale);
      if (pitch !== null) next = runEdit('set-pitch', next, [i], { pitch }, ctx);
    }
    return next;
  };

  const selectAll = () =>
    setSelected(
      region.id,
      boxesNow().map((b) => b.i),
    );

  /** The menu for a note (and the selection it's in), or for the space between notes. */
  const openNotesMenu = (clientX: number, clientY: number, x: number, hit: NoteHit | null) => {
    const base = editableNotes(project, region, clip, state);
    if (!base) return;
    const ctx = editContext(project, region, clip, base, middleC);
    const run = (name: string, idx: readonly number[], args: NoteArgs = {}) => runEdit(name, base, idx, args, ctx);
    const entry = (label: string, next: NoteList, undo: string, hint?: string, select?: number[]): MenuEntry => ({
      label,
      hint,
      disabled: next === base,
      onSelect: () => commit(next, base, undo, select),
    });
    if (hit) {
      const sel = selectedIn(region.id);
      const group = sel.includes(hit.i) ? sel : [hit.i];
      if (!sel.includes(hit.i)) setSelected(region.id, group);
      const n = base.n[hit.i] as AudioNote;
      const muted = group.every((i) => base.n[i]?.m);
      const many = group.length > 1;
      openMenu(clientX, clientY, [
        { heading: many ? `${group.length} notes` : noteHeading(n, middleC) },
        muted
          ? entry('Unmute', run('unmute', group), 'Unmute Notes', 'M')
          : entry('Mute', run('mute', group), 'Mute Notes', 'M'),
        entry('Snap pitch', snapped(base, group, ctx), 'Note Pitch', 'Double-click'),
        entry('Octave fix: up', run('octave', group, { direction: 'up' }), 'Octave Fix'),
        entry('Octave fix: down', run('octave', group, { direction: 'down' }), 'Octave Fix'),
        'sep',
        entry('Split here', run('split', [hit.i], { at: recordedAt(base, x) - n.t }), 'Split Note', undefined, [
          hit.i,
          hit.i + 1,
        ]),
        entry('Join with next', run('join', [hit.i]), 'Join Notes', undefined, [hit.i]),
        'sep',
        entry('Reset edits', run('reset', group, { what: 'all' }), 'Reset Notes', 'Delete'),
        entry(
          many ? 'Remove notes' : 'Remove note',
          run('remove', group),
          many ? 'Remove Notes' : 'Remove Note',
          '',
          [],
        ),
      ]);
      return;
    }
    const found = state?.state === 'found' ? state.found : null;
    const span = missedSpan(base.n, found?.curve ?? null, recordedAt(base, x));
    const added = span
      ? run('add', [], { start: span.t, length: span.d, pitch: span.p === null ? undefined : span.p })
      : base;
    const at = span ? added.n.findIndex((k) => k.t === roundTime(span.t)) : -1;
    openMenu(clientX, clientY, [
      entry(
        span?.p === null ? 'Add a note here (no pitch)' : 'Add a note here',
        added,
        'Add Note',
        undefined,
        at >= 0 ? [at] : [],
      ),
      { label: 'Select all', hint: 'Ctrl A', onSelect: selectAll },
      'sep',
      {
        label: 'Find notes again…',
        disabled: !clip.notes,
        onSelect: () =>
          openMenu(clientX, clientY, [
            { heading: 'Find this region’s notes again?' },
            { label: 'Find them again: their edits go', onSelect: findAgain },
            { label: 'Keep them', onSelect: () => undefined },
          ]),
      },
    ]);
  };

  /** The region's notes found in its recording again, as they're found now: its edits go (one step to undo). */
  const findAgain = () => {
    const now = current();
    if (!now?.clip.notes) return;
    const { notes: _notes, ...plain } = now.clip;
    apply(
      [{ op: 'updateRegion', track: now.track.id, region: now.region.id, patch: { audio: plain } }],
      'Find Notes Again',
    );
    setSelected(region.id, []);
  };

  /** A finger scrolling the notes, as a phone scrolls a page; a tap (`tap`) moves the playhead there and selects nothing. */
  const panDrag = (e: ReactPointerEvent<HTMLDivElement>, tap: boolean) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pan = new TouchPan(audioView, 'xy', maxY, e);
    start(e, {
      onMove: (ev) => pan.move(ev),
      onUp: (ev, g) => {
        pan.end(ev.timeStamp);
        if (g.moved || !tap) return;
        setSelected(region.id, []);
        locate(snapTo(audioView.xToTick(ev.clientX - rect.left), false));
      },
    });
  };

  /** A press on the space between notes: a marquee (a finger scrolls), a click moves the playhead and selects nothing. */
  const pressSpace = (e: ReactPointerEvent<HTMLDivElement>, base: NoteList | null, caught: boolean) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.pointerType === 'touch') {
      panDrag(e, !caught);
      return;
    }
    const v0 = pitchView(size.h);
    const tick0 = audioView.xToTick(e.clientX - rect.left);
    const pitch0 = pitchAtY(e.clientY - rect.top, v0.keyHeight, v0.y);
    const adding = e.shiftKey;
    let lx = e.clientX;
    let ly = e.clientY;
    start(e, {
      edgeScroll: base ? 'xy' : undefined,
      onMove: (ev, g) => {
        if (!base) {
          // nothing to select yet: the drag scrolls
          audioView.scrollBy(lx - ev.clientX, ly - ev.clientY, maxY());
          lx = ev.clientX;
          ly = ev.clientY;
          return;
        }
        if (!g.moved) return;
        preview.current = {
          marquee: { tick: tick0, pitch: pitch0, x: ev.clientX - rect.left, y: ev.clientY - rect.top },
        };
        dirty.current = true;
      },
      onUp: (ev, g) => {
        const mq = preview.current?.marquee;
        if (!g.moved) {
          if (caught) return;
          setSelected(region.id, []);
          locate(snapTo(audioView.xToTick(ev.clientX - rect.left), true));
          return;
        }
        if (!mq) return;
        const v = pitchView(size.h);
        const picked = notesInRect(
          boxesNow(),
          audioView.tickToX(mq.tick),
          pitchY(mq.pitch, v.keyHeight, v.y),
          mq.x,
          mq.y,
        );
        const sel = adding ? [...new Set([...selectedIn(region.id), ...picked])].sort((a, b) => a - b) : picked;
        setSelected(region.id, sel);
      },
    });
  };

  /**
   * A note dragged: up and down for its pitch (snapped as chosen; Alt: free), across to move it in time
   * (onto the grid; Ctrl or ⌘: free), the way it goes first chosen once it's gone far enough (`axis`
   * fixes it). The notes selected go with it. `tap`: what a press let go without moving does.
   */
  const dragNote = (
    e: ReactPointerEvent<HTMLDivElement>,
    base: NoteList,
    group: readonly number[],
    i: number,
    fixed: 'x' | 'y' | null,
    tap: () => void,
  ) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ctx = editContext(project, region, clip, base, middleC);
    const placed = { offset: clip.offset, stretch: clip.stretch, notes: base };
    const v0 = pitchView(size.h);
    const pitch0 = pitchAtY(e.clientY - rect.top, v0.keyHeight, v0.y);
    const tick0 = audioView.xToTick(e.clientX - rect.left);
    const [x0, y0] = [e.clientX, e.clientY];
    const lock = Math.max(AXIS_LOCK_PX, e.pointerType === 'touch' ? 10 : 0);
    const note = base.n[i] as AudioNote;
    const toTick = fileToTicks(project.tempo, region.start, placed, true);
    const toSeconds = (tick: number) => tickToFile(project.tempo, region.start, placed, tick, true);
    let axis = fixed;
    let label = 'Note Pitch';
    start(e, {
      edgeScroll: 'xy',
      onMove: (ev, g) => {
        if (!g.moved) return;
        axis ??= lockAxis(ev.clientX - x0, ev.clientY - y0, lock);
        if (!axis) return;
        if (axis === 'y') {
          const v = pitchView(size.h);
          const semitones = pitchAtY(ev.clientY - rect.top, v.keyHeight, v.y) - pitch0;
          const next = runEdit('shift', base, group, shiftArgs(semitones, snap, ev.altKey), ctx);
          const n = next.n[i] as AudioNote;
          label = 'Note Pitch';
          show(next, n.p === null ? '' : noteName(n.to ?? n.p, middleC), ev, rect);
          return;
        }
        const beat = (note.ts ?? note.t) + (note.u ?? 0);
        const dTick = audioView.xToTick(ev.clientX - rect.left) - tick0;
        const seconds = dragSeconds(beat, dTick, gridTicks(), ev.ctrlKey || ev.metaKey, toTick, toSeconds);
        const next = runEdit('move', base, group, { seconds }, ctx);
        const n = next.n[i] as AudioNote;
        const ms = Math.round(((n.ts ?? n.t) - (note.ts ?? note.t)) * 1000);
        label = 'Note Time';
        show(next, `${ms > 0 ? '+' : ''}${ms} ms`, ev, rect);
      },
      onUp: (_ev, g) => {
        const next = preview.current?.notes;
        if (!g.moved || !next) tap();
        else commit(next, base, label);
      },
    });
  };

  /** A note's start or end dragged: it stretches or squeezes (onto the grid; Ctrl or ⌘: free). */
  const dragEdge = (
    e: ReactPointerEvent<HTMLDivElement>,
    base: NoteList,
    i: number,
    edge: 'start' | 'end',
    tap: () => void,
  ) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ctx = editContext(project, region, clip, base, middleC);
    const placed = { offset: clip.offset, stretch: clip.stretch, notes: base };
    const tick0 = audioView.xToTick(e.clientX - rect.left);
    const n = base.n[i] as AudioNote;
    const from = edge === 'start' ? (n.ts ?? n.t) : (n.te ?? n.t + n.d);
    const toTick = fileToTicks(project.tempo, region.start, placed, true);
    const toSeconds = (tick: number) => tickToFile(project.tempo, region.start, placed, tick, true);
    start(e, {
      edgeScroll: 'x',
      onMove: (ev, g) => {
        if (!g.moved) return;
        const dTick = audioView.xToTick(ev.clientX - rect.left) - tick0;
        const seconds = dragSeconds(from, dTick, gridTicks(), ev.ctrlKey || ev.metaKey, toTick, toSeconds);
        const next = runEdit('resize', base, [i], { edge, seconds }, ctx);
        const k = next.n[i] as AudioNote;
        show(next, `${Math.round(((k.te ?? k.t + k.d) - (k.ts ?? k.t)) * 1000)} ms`, ev, rect);
      },
      onUp: (_ev, g) => {
        const next = preview.current?.notes;
        if (g.moved && next) commit(next, base, 'Note Length');
        else if (!g.moved) tap();
      },
    });
  };

  /** A note's attack handle dragged across: its attack played slower (to the right) or quicker. */
  const dragAttack = (e: ReactPointerEvent<HTMLDivElement>, base: NoteList, i: number, tap: () => void) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ctx = editContext(project, region, clip, base, middleC);
    const placed = { offset: clip.offset, stretch: clip.stretch, notes: base };
    const tick0 = audioView.xToTick(e.clientX - rect.left);
    const n = base.n[i] as AudioNote;
    start(e, {
      onMove: (ev, g) => {
        if (!g.moved) return;
        const tick = audioView.xToTick(ev.clientX - rect.left);
        const seconds =
          tickToFile(project.tempo, region.start, placed, tick, true) -
          tickToFile(project.tempo, region.start, placed, tick0, true);
        const at = attackAfterDrag(n, seconds);
        const next = runEdit('attack', base, [i], { length: Math.round(at * 100) }, ctx);
        show(next, `Attack ${Math.round((next.n[i]?.at ?? 1) * 100)}%`, ev, rect);
      },
      onUp: (_ev, g) => {
        const next = preview.current?.notes;
        if (g.moved && next) commit(next, base, 'Note Attack');
        else if (!g.moved) tap();
      },
    });
  };

  /** An amount (vibrato, drift, transition, formant, gain) dragged up or down, each note's from its own. */
  const dragAmount = (
    e: ReactPointerEvent<HTMLDivElement>,
    base: NoteList,
    group: readonly number[],
    i: number,
    def: AmountTool,
    tap: () => void,
  ) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ctx = editContext(project, region, clip, base, middleC);
    const y0 = e.clientY;
    start(e, {
      onMove: (ev, g) => {
        if (!g.moved) return;
        let next = base;
        for (const [v, idx] of amountGroups(def, base.n, group, ev.clientY - y0))
          next = runEdit(def.edit, next, idx, { [def.arg]: def.toArg(v) }, ctx);
        show(next, def.text(amountOf(def, next.n[i] as AudioNote)), ev, rect);
      },
      onUp: (_ev, g) => {
        const next = preview.current?.notes;
        if (!g.moved || !next) tap();
        else commit(next, base, def.label);
      },
    });
  };

  /** A click on a note with the Split tool: it's cut where it was clicked. */
  const pressSplit = (e: ReactPointerEvent<HTMLDivElement>, base: NoteList, i: number) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ctx = editContext(project, region, clip, base, middleC);
    start(e, {
      onUp: (ev, g) => {
        if (g.moved) return;
        const n = base.n[i] as AudioNote;
        const at = recordedAt(base, ev.clientX - rect.left) - n.t;
        commit(runEdit('split', base, [i], { at }, ctx), base, 'Split Note', [i, i + 1]);
      },
    });
  };

  /** Where two notes meet, dragged across with the Split tool: the boundary between them moves. */
  const dragBoundary = (e: ReactPointerEvent<HTMLDivElement>, base: NoteList, i: number, tap: () => void) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ctx = editContext(project, region, clip, base, middleC);
    const next0 = base.n[i + 1] as AudioNote;
    start(e, {
      edgeScroll: 'x',
      onMove: (ev, g) => {
        if (!g.moved) return;
        const seconds = recordedAt(base, ev.clientX - rect.left) - next0.t;
        show(runEdit('boundary', base, [i], { seconds }, ctx), '', ev, rect);
      },
      onUp: (_ev, g) => {
        const next = preview.current?.notes;
        if (g.moved && next) commit(next, base, 'Note Boundary');
        else if (!g.moved) tap();
      },
    });
  };

  /** A double-click on a note: its pitch snapped (Pointer, Pitch), or the tool's edit put back. */
  const doubleClick = (base: NoteList, group: readonly number[]) => {
    const ctx = editContext(project, region, clip, base, middleC);
    if (tool === 'pointer' || tool === 'pitch') commit(snapped(base, group, ctx), base, 'Note Pitch');
    else if (isAmountTool(tool)) {
      const def = AMOUNT_TOOLS[tool];
      commit(runEdit('reset', base, group, { what: def.reset }, ctx), base, `Reset ${noteTool(tool).name}`);
    } else if (tool === 'time') commit(runEdit('reset', base, group, { what: 'time' }, ctx), base, 'Reset Note Time');
  };

  /** A press on the notes: what it does depends on the tool and what's under it (note-tools.ts). */
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    root.current?.focus({ preventScroll: true });
    store.set({ selectedRegions: [region.id] });
    gesture.current?.abort();
    const touch = e.pointerType === 'touch';
    // a finger landing while the view still coasts from a flick catches it, and isn't a tap
    const caught = audioView.stopFling();
    menuAt.current = null;
    if (caught && touch) {
      lastTap.current = { at: 0, key: '' };
      panDrag(e, false);
      return;
    }
    const base = editableNotes(project, region, clip, state);
    const boxes = base ? boxesNow() : [];
    const keyHeight = pitchView(size.h).keyHeight;
    const boundary = base && tool === 'split' ? hitBoundary(boxes, base.n, x, y, { touch, keyHeight }) : null;
    const edges = tool === 'pointer' || tool === 'time';
    const hit =
      base && boundary === null ? hitNote(boxes, x, y, { touch, keyHeight, edges, attack: tool === 'time' }) : null;
    // a double-click: a second press on the same note, or the same boundary (the Split tool cuts at each click)
    const now = performance.now();
    const key = boundary !== null ? `b${boundary}` : hit && tool !== 'split' ? `n${hit.i}` : '';
    const double = key !== '' && key === lastTap.current.key && now - lastTap.current.at < DOUBLE_TAP_MS;
    lastTap.current = { at: double ? 0 : now, key };
    menuAt.current = (ev) => {
      const r = box.current?.getBoundingClientRect();
      openNotesMenu(ev.clientX, ev.clientY, ev.clientX - (r?.left ?? 0), hit);
    };
    if (isMenuPress(e)) {
      menuAt.current(e.nativeEvent);
      return;
    }
    if (!base) {
      pressSpace(e, null, caught);
      return;
    }
    if (boundary !== null) {
      // a double-click joins the two notes (once it's let go without moving)
      const ctx = editContext(project, region, clip, base, middleC);
      const join = () => commit(runEdit('join', base, [boundary], {}, ctx), base, 'Join Notes', [boundary]);
      dragBoundary(e, base, boundary, double ? join : () => undefined);
      return;
    }
    if (!hit) {
      pressSpace(e, base, caught);
      return;
    }
    // the selection: Shift adds or takes away; a note already selected drags the selection with it
    const sel = selectedIn(region.id);
    let group: readonly number[];
    if (e.shiftKey) {
      group = sel.includes(hit.i) ? sel.filter((i) => i !== hit.i) : [...sel, hit.i].sort((a, b) => a - b);
      setSelected(region.id, group);
      if (!group.includes(hit.i)) return;
    } else if (sel.includes(hit.i)) group = sel;
    else {
      group = [hit.i];
      setSelected(region.id, group);
    }
    // let go without moving: a double-click's edit, or a click on one of several selected selects it alone
    const alone = !e.shiftKey && sel.includes(hit.i) && sel.length > 1;
    const tap = () => {
      if (double) doubleClick(base, group);
      else if (alone) setSelected(region.id, [hit.i]);
    };
    if (tool === 'split') pressSplit(e, base, hit.i);
    else if (isAmountTool(tool)) dragAmount(e, base, group, hit.i, AMOUNT_TOOLS[tool], tap);
    else if (hit.part === 'start' || hit.part === 'end') dragEdge(e, base, hit.i, hit.part, tap);
    else if (hit.part === 'attack') dragAttack(e, base, hit.i, tap);
    else dragNote(e, base, group, hit.i, tool === 'pitch' ? 'y' : tool === 'time' ? 'x' : null, tap);
  };

  /** The mouse's cursor, by the tool and what it's over. */
  const cursorFor = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || gesture.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const keyHeight = pitchView(size.h).keyHeight;
    const { boxes, notes } = drawn.current;
    let cursor = 'default';
    if (tool === 'split' && hitBoundary(boxes, notes, x, y, { touch: false, keyHeight }) !== null)
      cursor = 'col-resize';
    else {
      const edges = tool === 'pointer' || tool === 'time';
      const hit = hitNote(boxes, x, y, { touch: false, keyHeight, edges, attack: tool === 'time' });
      if (hit) {
        if (hit.part === 'start' || hit.part === 'end' || hit.part === 'attack') cursor = 'ew-resize';
        else if (tool === 'split') cursor = 'text';
        else if (tool === 'time') cursor = 'ew-resize';
        else if (tool === 'pointer') cursor = 'grab';
        else cursor = 'ns-resize';
      }
    }
    e.currentTarget.style.cursor = cursor;
  };

  /** Keys while the view has the keyboard: the selection's pitch, mute, edits put back, all selected. */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const sel = selectedIn(region.id);
    const base = editableNotes(project, region, clip, state);
    const ctx = base && editContext(project, region, clip, base, middleC);
    let handled = true;
    if (key === 'Escape') {
      if (gesture.current) gesture.current.abort();
      else if (sel.length) setSelected(region.id, []);
      else handled = false;
    } else if (ctrl && !e.altKey && key === 'a') selectAll();
    else if (ctrl || e.altKey) handled = false;
    else if (key === 'Delete' || key === 'Backspace') {
      // (never the region itself, as Delete is elsewhere: here it's the notes' edits)
      if (base && ctx && sel.length) commit(runEdit('reset', base, sel, { what: 'all' }, ctx), base, 'Reset Notes');
    } else if (!base || !ctx || !sel.length) handled = false;
    else if (key === 'ArrowUp' || key === 'ArrowDown') {
      const dir = key === 'ArrowUp' ? 1 : -1;
      commit(runEdit('shift', base, sel, keyShiftArgs(dir, e.shiftKey, snap), ctx), base, 'Note Pitch');
    } else if (key === 'm') {
      const muted = sel.every((i) => base.n[i]?.m);
      commit(runEdit(muted ? 'unmute' : 'mute', base, sel, {}, ctx), base, muted ? 'Unmute Notes' : 'Mute Notes');
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  /** A press on the keys: a drag scrolls the lanes up and down. */
  const onKeysDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    gesture.current?.abort();
    const pan = new TouchPan(audioView, 'y', maxY, e);
    gesture.current = capture(e, {
      threshold: 0,
      onMove: (ev) => pan.move(ev),
      onUp: (ev) => {
        gesture.current = null;
        if (e.pointerType === 'touch') pan.end(ev.timeStamp);
      },
      onAbort: () => {
        gesture.current = null;
      },
    });
  };

  return (
    <div
      className="audio-notes"
      ref={root}
      role="application"
      aria-label="The recording’s notes"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the view takes the keyboard for its notes once pressed (arrows, M, Delete)
      tabIndex={0}
      onKeyDown={onKeyDown}
      style={{ ['--keys' as string]: `${keysWidth}px` }}
    >
      <div className="corner" />
      <div
        className="cell ruler-cell"
        ref={rulerBox}
        title="Click or drag to move the playhead"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const playheadAt = (px: number) => locate(snapTo(audioView.xToTick(px), false));
          playheadAt(e.clientX - rect.left);
          gesture.current?.abort();
          gesture.current = capture(e, {
            threshold: 0,
            onMove: (ev) => playheadAt(ev.clientX - rect.left),
            onUp: () => {
              gesture.current = null;
            },
            onAbort: () => {
              gesture.current = null;
            },
          });
        }}
      >
        <canvas ref={rulerCanvas} />
      </div>
      <div className="cell keys-cell" ref={keysBox} onPointerDown={onKeysDown}>
        <canvas ref={keysCanvas} />
      </div>
      <div
        className="cell"
        ref={box}
        onPointerDown={(e) => {
          // a second finger turns whatever the first was doing into a pinch
          if (pinch.current.down(e)) {
            gesture.current?.abort();
            return;
          }
          if (pinch.current.active) return;
          onDown(e);
        }}
        onPointerMove={(e) => {
          const z = pinch.current.move(e);
          if (!z) {
            cursorFor(e);
            return;
          }
          const rect = e.currentTarget.getBoundingClientRect();
          pinchAxis.current ??= z.dx >= z.dy ? 'x' : 'y';
          if (pinchAxis.current === 'x') audioView.zoomAt(z.factor, z.x - rect.left, ...ZOOM.audio);
          else zoomLanes(z.factor, z.y - rect.top);
        }}
        onPointerUp={(e) => {
          if (pinch.current.up(e)) {
            pinchAxis.current = null;
            lastTap.current = { at: 0, key: '' };
          }
        }}
        onPointerCancel={(e) => {
          if (pinch.current.up(e)) pinchAxis.current = null;
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <canvas ref={canvas} />
        <canvas ref={overlay} style={{ pointerEvents: 'none' }} />
      </div>
    </div>
  );
}

// ---- drawing ----

interface Scene {
  project: Project;
  track: Track;
  region: Region;
  clip: AudioClip;
  state: NotesState | null;
  /** The stretches whose edits are still being rendered (seconds of the recording as the region plays it). */
  pending: [number, number][];
  view: PitchView;
  w: number;
  h: number;
  /** What a drag has made so far. */
  preview: Preview | null;
  selected: ReadonlySet<number>;
  tool: NoteTool;
  /** A phone's: its handles drawn larger, for a finger. */
  touch: boolean;
}

/**
 * The notes a scene draws and where: as a drag leaves them, as the region keeps them (edited, or not
 * while they're off), or as found: in the region's own span (`lit`) as its first edit will keep them
 * (so they're numbered as that keeps them), and beyond it all its recording's.
 */
interface Placed {
  notes: readonly AudioNote[] | null;
  edited: boolean;
  /** Where a second of the recording as recorded is drawn across (through the notes' moves). */
  xOf: (seconds: number) => number;
}

function placed(s: Scene, lit: boolean): Placed {
  const dragged = s.preview?.notes;
  const notes = dragged
    ? dragged.n
    : s.clip.notes || !lit
      ? notesShown(s.clip, s.state)
      : (foundNotes(s.project, s.region, s.clip, s.state)?.n ?? null);
  const edited = !!dragged || (!!s.clip.notes && !s.clip.notes.off);
  // (the session plays notes whose edits are off without their moves)
  const ticks = fileToTicks(s.project.tempo, s.region.start, {
    offset: s.clip.offset,
    stretch: s.clip.stretch,
    notes: dragged ?? s.clip.notes,
  });
  return { notes, edited, xOf: (sec) => audioView.tickToX(ticks(sec)) };
}

/** The notes a scene draws within its region's span, for finding the one under a pointer. */
function sceneBoxes(s: Scene): NoteBox[] {
  const at = placed(s, true);
  if (!at.notes) return [];
  const kh = s.view.keyHeight;
  return noteBoxes(at.notes, {
    xOf: at.xOf,
    yOf: (p) => pitchY(p, kh, s.view.y),
    pitchOf: (n) => (at.edited ? shownPitch(n) : n.p),
    keyHeight: kh,
    from: audioView.tickToX(s.region.start),
    to: audioView.tickToX(s.region.start + s.region.length),
  });
}

/** Each list of notes' pitch as its edits make it sound (editedPitch: what the renderer plays), worked out once per list. */
const editedCurves = new WeakMap<readonly AudioNote[], { curve: NoteCurve; pitch: Float64Array }>();

function editedCurve(notes: readonly AudioNote[], curve: NoteCurve): Float64Array {
  const kept = editedCurves.get(notes);
  if (kept && kept.curve === curve) return kept.pitch;
  const pitch = editedPitch(notes, curve);
  editedCurves.set(notes, { curve, pitch });
  return pitch;
}

/** What a pass of the notes is drawn in: the region's own span lit, the rest of the recording dim. */
interface Ink {
  fill: string;
  edge: string;
  curve: string;
  /** The pitch as sung, where the edits change it. */
  sung: string;
  rest: string;
  /** Whether notes are picked out when selected, and their handles drawn (the region's own span). */
  lit: boolean;
}

function draw(ctx: CanvasRenderingContext2D, s: Scene): void {
  const { project, track, region, clip, view, w, h } = s;
  const m = project.meter[0] ?? { tick: 0, num: 4, den: 4 };
  const beat = ticksPerBeat(m);
  const bar = ticksPerBar(m);
  ctx.fillStyle = '#101216';
  ctx.fillRect(0, 0, w, h);
  drawLanes(ctx, w, h, view.keyHeight, (pitch) => laneTop(pitch, view.keyHeight, view.y));
  const step = gridStep(audioView.pxPerTick, 14, beat, bar);
  for (let t = Math.floor(audioView.x / step) * step; t < audioView.xToTick(w); t += step) {
    const x = Math.round(audioView.tickToX(t)) + 0.5;
    ctx.fillStyle = t % bar === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.03)';
    ctx.fillRect(x, 0, 1, h);
  }

  // outside the region dimmed, and outside the recording more so
  const x0 = audioView.tickToX(region.start);
  const x1 = audioView.tickToX(region.start + region.length);
  const [fa, fb] = fileSpan(project, region, clip);
  const xa = Math.max(0, audioView.tickToX(fa));
  const xb = Number.isFinite(fb) ? Math.min(w, audioView.tickToX(fb)) : w;
  ctx.fillStyle = 'rgba(11,13,16,0.42)';
  ctx.fillRect(0, 0, Math.max(0, x0), h);
  ctx.fillRect(x1, 0, Math.max(0, w - x1), h);
  ctx.fillRect(0, 0, xa, h);
  ctx.fillRect(xb, 0, Math.max(0, w - xb), h);
  ctx.fillStyle = alpha(track.color, 0.07);
  ctx.fillRect(x0, 0, x1 - x0, h);
  drawPending(ctx, s);

  const notes = notesShown(clip, s.state);
  const found = s.state?.state === 'found' ? s.state.found : null;
  if (notes) {
    // the pitch curve stands back while the view is zoomed out (where it's a vibrato's zigzag a few
    // pixels wide), and comes forward as a second of it takes more room
    const ticks = fileToTicks(project.tempo, region.start, clip);
    const perSecond = Math.abs(audioView.tickToX(ticks(clip.offset + 1)) - audioView.tickToX(ticks(clip.offset)));
    const shown = Math.max(0.4, Math.min(0.85, perSecond / 120));
    const dim: Ink = {
      fill: 'rgba(160,170,184,0.14)',
      edge: 'rgba(160,170,184,0.34)',
      curve: `rgba(242,245,248,${(shown * 0.4).toFixed(2)})`,
      sung: `rgba(242,245,248,${(shown * 0.15).toFixed(2)})`,
      rest: 'rgba(125,135,150,0.3)',
      lit: false,
    };
    const lit: Ink = {
      fill: alpha(track.color, 0.5),
      edge: track.color,
      curve: `rgba(246,248,251,${shown.toFixed(2)})`,
      sung: `rgba(246,248,251,${(shown * 0.32).toFixed(2)})`,
      rest: 'rgba(125,135,150,0.75)',
      lit: true,
    };
    // the whole recording dim, then the region's span over it, lit
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, Math.max(0, x0), h);
    ctx.rect(x1, 0, Math.max(0, w - x1), h);
    ctx.clip();
    drawNotes(ctx, s, placed(s, false), found, dim);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, x1 - x0, h);
    ctx.clip();
    drawNotes(ctx, s, placed(s, true), found, lit);
    ctx.restore();
  }

  // the region's edges
  ctx.fillStyle = track.color;
  ctx.fillRect(x0 - 1, 0, 2, h);
  ctx.fillRect(x1 - 1, 0, 2, h);

  const mq = s.preview?.marquee;
  if (mq) {
    const mx = audioView.tickToX(mq.tick);
    const my = pitchY(mq.pitch, view.keyHeight, view.y);
    const rx = Math.min(mx, mq.x);
    const ry = Math.min(my, mq.y);
    ctx.fillStyle = 'rgba(92,184,255,0.1)';
    ctx.strokeStyle = 'rgba(92,184,255,0.8)';
    ctx.lineWidth = 1;
    ctx.fillRect(rx, ry, Math.abs(mq.x - mx), Math.abs(mq.y - my));
    ctx.strokeRect(rx + 0.5, ry + 0.5, Math.abs(mq.x - mx), Math.abs(mq.y - my));
  }
  const readout = s.preview?.readout;
  if (readout) drawLabel(ctx, readout.text, readout.x + 14, readout.y - 22, w, h);

  const status =
    s.state?.state === 'failed' && !clip.notes
      ? `Notes couldn’t be found: ${s.state.error}`
      : !notes
        ? 'Finding notes…'
        : !notes.length
          ? 'No notes were found in this recording'
          : null;
  if (status) {
    ctx.font = '600 12px Inter Variable, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(status).width;
    const tx = Math.max(12, Math.min(x0 + 12, w - tw - 12));
    ctx.fillStyle = 'rgba(16,18,22,0.85)';
    roundRect(ctx, tx - 8, h / 2 - 13, tw + 16, 26, 6);
    ctx.fill();
    ctx.fillStyle = '#a9b1be';
    ctx.fillText(status, tx, h / 2);
  }
}

/** A small label (a drag's readout), kept within the view. */
function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, w: number, h: number): void {
  ctx.font = '600 11px Inter Variable, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  const lx = Math.max(4, Math.min(x, w - tw - 16));
  const ly = Math.max(4, Math.min(y, h - 24));
  ctx.fillStyle = 'rgba(16,18,22,0.92)';
  roundRect(ctx, lx, ly, tw + 12, 20, 5);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#e4e8ef';
  ctx.fillText(text, lx + 6, ly + 10.5);
}

/** Where edits are still being rendered: faint stripes, top to bottom, under the notes. */
function drawPending(ctx: CanvasRenderingContext2D, s: Scene): void {
  const { project, region, clip, w, h } = s;
  if (!s.pending.length) return;
  // (the spans are as the region plays its recording, past its notes' moves)
  const ticks = fileToTicks(project.tempo, region.start, clip, true);
  for (const [a, b] of s.pending) {
    // (the stripes keep to where the stretch starts, wherever it's scrolled to)
    const start = audioView.tickToX(ticks(a));
    const xa = Math.max(0, start);
    const xb = Math.min(w, audioView.tickToX(ticks(b)));
    if (xb <= xa) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(xa, 0, xb - xa, h);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    ctx.fillRect(xa, 0, xb - xa, h);
    ctx.beginPath();
    for (let x = start - h + Math.floor((xa - start) / 10) * 10; x < xb; x += 10) {
      ctx.moveTo(x, h);
      ctx.lineTo(x + h, 0);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * The notes in one ink: each a capsule as thick as it's loud (no thicker than its lane, nor than a
 * share of its length), its pitch curve through it as its edits make it sound, and as it was sung,
 * faintly, where they change it. Selected notes are filled with the track's colour; a moved formant
 * is a small bar inside the note, up for brighter. The tools' handles are drawn on the lit notes.
 */
function drawNotes(ctx: CanvasRenderingContext2D, s: Scene, at: Placed, found: FoundNotes | null, ink: Ink): void {
  const { track, view, w, h } = s;
  const notes = at.notes;
  if (!notes) return;
  const { edited, xOf } = at;
  const kh = view.keyHeight;
  const thick = Math.max(4, kh * 0.95);
  const thin = Math.max(2, kh * 0.2);
  const curve = found?.curve ?? null;
  const loudest = found?.loudest ?? 0;
  const heard = edited && curve ? editedCurve(notes, curve) : null;
  const handles = ink.lit && (s.tool === 'pointer' || s.tool === 'time');
  const grip = s.touch ? 4 : 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  /** Each note's middle as drawn, for the Split tool's boundaries. */
  const ys: number[] = new Array(notes.length).fill(Number.NaN);
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i] as AudioNote;
    const nx0 = xOf(n.t);
    const nx1 = xOf(n.t + n.d);
    if (nx1 < -2 || nx0 > w + 2) continue;
    const picked = ink.lit && s.selected.has(i);
    const pitch = edited ? shownPitch(n) : n.p;
    if (pitch === null) {
      // no pitch: a thin bar where the line was, or is going
      const rest = restingPitch(notes, i);
      const cy = rest === null ? h / 2 : pitchY(rest, kh, view.y);
      ys[i] = cy;
      roundRect(ctx, nx0, cy - 1.5, Math.max(2, nx1 - nx0), 3, 1.5);
      ctx.fillStyle = picked ? '#ffffff' : ink.rest;
      ctx.fill();
      continue;
    }
    const cy = pitchY(pitch, kh, view.y);
    ys[i] = cy;
    // (its curve may slide a few semitones off it, at its ends)
    const reach = thick + 5 * kh;
    if (cy < -reach || cy > h + reach) continue;
    const i0 = curve ? firstAt(curve.t, n.t) : 0;
    const i1 = curve ? firstAt(curve.t, n.t + n.d) : 0;
    // its outline: thick where it's loud (thinner when its level is turned down), rounded at its ends
    const cap = capsuleHalf(kh, nx1 - nx0);
    let xs: number[] = [nx0, nx1];
    let halves: number[] = [thick * 0.3, thick * 0.3];
    if (curve && i1 > i0) {
      const gain = edited && n.g ? 10 ** (n.g / 10) : 1;
      const px: number[] = [];
      const pw: number[] = [];
      for (let k = i0; k < i1; k++) {
        px.push(xOf(curve.t[k] as number));
        pw.push((curve.power[k] as number) * gain);
      }
      const thinned = thinPoints(px, pw, 2);
      xs = thinned.x;
      halves = thinned.value.map((p) => levelThickness(p, loudest, thin, thick) / 2);
    }
    const o = capsule(
      xs,
      halves.map((half) => Math.min(half, cap)),
      nx0,
      nx1,
    );
    ctx.beginPath();
    ctx.moveTo(o.x[0] as number, cy);
    for (let k = 0; k < o.x.length; k++) ctx.lineTo(o.x[k] as number, cy - (o.half[k] as number));
    for (let k = o.x.length - 1; k >= 0; k--) ctx.lineTo(o.x[k] as number, cy + (o.half[k] as number));
    ctx.closePath();
    const muted = edited && (n.m || n.off);
    if (picked) {
      ctx.fillStyle = alpha(track.color, muted ? 0.22 : 0.9);
      ctx.fill();
    } else if (!muted) {
      ctx.fillStyle = ink.fill;
      ctx.fill();
    }
    ctx.strokeStyle = picked ? '#ffffff' : ink.edge;
    ctx.lineWidth = picked ? 1.5 : 1;
    ctx.stroke();
    // its formant moved: a bar across its middle, raised for brighter, lowered for darker
    if (edited && n.fo && nx1 - nx0 > 6) {
      const fy = cy - Math.max(-1, Math.min(1, n.fo / 12)) * Math.max(1, cap - 1.5);
      const bw = Math.max(3, (nx1 - nx0) * 0.4);
      ctx.fillStyle = picked ? 'rgba(10,12,16,0.85)' : 'rgba(255,255,255,0.85)';
      ctx.fillRect((nx0 + nx1) / 2 - bw / 2, fy - 1, bw, 2);
    }
    // its pitch every 5 ms, through it: as sung (faint) where the edits change it, then as heard
    if (curve && i1 > i0) {
      const runs = (values: ArrayLike<number>) => {
        ctx.beginPath();
        for (const run of curveRuns(values, i0, i1, (k) => xOf(curve.t[k] as number), 1.5)) {
          ctx.moveTo(run.x[0] as number, pitchY(run.p[0] as number, kh, view.y));
          for (let k = 1; k < run.x.length; k++) ctx.lineTo(run.x[k] as number, pitchY(run.p[k] as number, kh, view.y));
        }
        ctx.stroke();
      };
      let changed = false;
      if (heard)
        for (let k = i0; k < i1 && !changed; k++)
          changed = Math.abs((heard[k] as number) - (curve.midi[k] as number)) > 0.005;
      ctx.lineWidth = 1;
      if (changed) {
        ctx.strokeStyle = picked ? 'rgba(10,12,16,0.3)' : ink.sung;
        runs(curve.midi);
      }
      ctx.strokeStyle = picked ? 'rgba(10,12,16,0.8)' : ink.curve;
      runs(changed && heard ? heard : curve.midi);
    }
    // the tools' handles: a selected note's ends (to stretch it), each note's attack (the Time tool)
    if (handles && picked && nx1 - nx0 > 4 * grip) {
      const hh = Math.max(3, Math.min(cap + 2, kh * 0.6));
      ctx.fillStyle = '#ffffff';
      roundRect(ctx, nx0 + 1, cy - hh, grip, hh * 2, grip / 2);
      ctx.fill();
      roundRect(ctx, nx1 - 1 - grip, cy - hh, grip, hh * 2, grip / 2);
      ctx.fill();
    }
    if (ink.lit && s.tool === 'time') {
      const u = n.u ?? 0;
      const a = Math.min(ATTACK_S, n.d / 3);
      if (u + a < n.d - 0.001) {
        const ax = xOf(n.t + u + a);
        ctx.fillStyle = picked ? '#ffffff' : 'rgba(255,255,255,0.6)';
        ctx.fillRect(ax - 0.75, cy - cap - 4, 1.5, 2 * cap + 8);
      }
    }
  }
  // the Split tool: where notes that touch meet, each a boundary to drag (or double-click to join),
  // marked across both notes' ends (and the gap between them when they're a step or so apart)
  if (ink.lit && s.tool === 'split') {
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    const reach = Math.max(3, kh * 0.5);
    for (let i = 0; i + 1 < notes.length; i++) {
      if (!notesTouch(notes[i], notes[i + 1])) continue;
      const a = ys[i] as number;
      const b = ys[i + 1] as number;
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      const bx = xOf((notes[i + 1] as AudioNote).t);
      if (bx < -2 || bx > w + 2) continue;
      if (Math.abs(a - b) <= 3 * kh) ctx.fillRect(bx - 0.75, Math.min(a, b) - reach, 1.5, Math.abs(a - b) + 2 * reach);
      else for (const y of [a, b]) ctx.fillRect(bx - 0.75, y - reach, 1.5, 2 * reach);
    }
  }
}

/** The region's note edits off (the recording as it was) or on again: one step to undo. */
function toggleEdits(track: Track, region: Region, clip: AudioClip): void {
  const notes = clip.notes;
  if (!notes) return;
  const { off, ...on } = notes;
  apply(
    [
      {
        op: 'updateRegion',
        track: track.id,
        region: region.id,
        patch: { audio: { ...clip, notes: off ? on : { ...notes, off: true } } },
      },
    ],
    off ? 'Note Edits On' : 'Note Edits Off',
  );
}

const TOOL_ICONS: Record<NoteTool, typeof MousePointer2> = {
  pointer: MousePointer2,
  pitch: MoveVertical,
  vibrato: Waves,
  drift: Spline,
  transition: Route,
  formant: MicVocal,
  gain: Volume2,
  time: MoveHorizontal,
  split: Scissors,
};

/** A tool's button in the bar's group. */
function ToolButton({ id, on }: { id: NoteTool; on: boolean }) {
  const def = noteTool(id);
  const Icon = TOOL_ICONS[id];
  return (
    <button
      type="button"
      className={`btn icon${on ? ' on' : ''}`}
      title={def.help}
      aria-label={def.name}
      aria-pressed={on}
      onClick={() => store.set({ noteTool: id })}
    >
      <Icon />
    </button>
  );
}

/**
 * The tools: each a button, and where a pitch dragged lands. A phone has the Pointer, the Pitch tool
 * (or the one chosen) and the rest, with the snap, in a menu.
 */
function NoteTools({ phone }: { phone: boolean }) {
  const tool = useApp((s) => s.noteTool);
  const snap = useApp((s) => s.pitchSnap);
  const setSnap = (v: PitchSnap) => store.set({ pitchSnap: v });
  if (phone) {
    const second: NoteTool = tool === 'pointer' ? 'pitch' : tool;
    return (
      <div className="seg">
        <ToolButton id="pointer" on={tool === 'pointer'} />
        <ToolButton id={second} on={tool === second} />
        <button
          type="button"
          className="btn icon"
          title="More tools, and where a dragged pitch lands"
          aria-label="More tools"
          onClick={(e) =>
            openMenuAt(e.currentTarget, [
              { heading: 'Tool' },
              ...NOTE_TOOLS.map(
                (t): MenuEntry => ({
                  label: t.name,
                  checked: t.id === tool,
                  onSelect: () => store.set({ noteTool: t.id }),
                }),
              ),
              'sep',
              { heading: 'Pitch snap' },
              ...PITCH_SNAPS.map(
                (v): MenuEntry => ({ label: PITCH_SNAP_NAMES[v], checked: v === snap, onSelect: () => setSnap(v) }),
              ),
            ])
          }
        >
          <Ellipsis />
        </button>
      </div>
    );
  }
  return (
    <>
      <div className="seg">
        {NOTE_TOOLS.map((t) => (
          <ToolButton key={t.id} id={t.id} on={t.id === tool} />
        ))}
      </div>
      <select
        className="select"
        value={snap}
        title="Where a dragged pitch lands: anywhere, on a semitone, or on a note of the song’s key (Alt: anywhere)"
        aria-label="Pitch snap"
        onChange={(e) => setSnap(e.target.value as PitchSnap)}
      >
        {PITCH_SNAPS.map((v) => (
          <option key={v} value={v}>
            {PITCH_SNAP_NAMES[v]}
          </option>
        ))}
      </select>
    </>
  );
}

export function AudioNotesBar() {
  const { project, track, region } = useAudioRegion();
  const phone = isPhone(useLayout());
  const clip = region?.audio;
  const state = useFound(project?.id, clip?.file);
  const selected = useApp((s) =>
    s.selectedAudioNotes && s.selectedAudioNotes.region === region?.id ? s.selectedAudioNotes.notes.length : 0,
  );
  useSyncExternalStore(onPatches, patchVersion);
  const patches = clip ? patchStatus(clip) : null;
  return (
    <>
      {!phone && <span className="title">Audio Editor</span>}
      {!phone && (
        <span className="muted" style={{ whiteSpace: 'nowrap' }}>
          {track?.name ?? ''}
        </span>
      )}
      {project && region && clip && <NoteTools phone={phone} />}
      {project && region && clip && (
        <span
          className="muted"
          style={{ whiteSpace: 'nowrap' }}
          data-patches={patches ? `${patches.ready}/${patches.pending}` : '0/0'}
        >
          {/* (a phone's bar has room for a few words: how many notes, or that edits are rendering) */}
          {phone && patches?.pending ? 'Rendering…' : notesStatus(project, region, clip, state, phone ? 0 : selected)}
          {!phone && patches?.pending
            ? ` · Rendering ${patches.notes === 1 ? '1 note' : `${patches.notes} notes`}…`
            : ''}
        </span>
      )}
      {track && region && clip?.notes && (
        <button
          type="button"
          className={`btn${clip.notes.off ? ' on' : ''}`}
          title={
            clip.notes.off
              ? 'Hearing the recording as it was: click to hear the note edits again'
              : 'Hear the recording as it was, without the note edits'
          }
          onClick={() => toggleEdits(track, region, clip)}
        >
          A/B
        </button>
      )}
      <span className="grow" />
      {/* a phone has undo and redo in its control bar or side rail, and zooms with two fingers (across
          for time, up and down for pitch): its bar keeps its room for the tools */}
      {!phone && <UndoRedo group="seg" />}
      {!phone && (
        <button
          type="button"
          className="btn ghost icon"
          title="Zoom out"
          onClick={() => audioView.zoomAt(0.7, 0, ...ZOOM.audio)}
        >
          <ZoomOut />
        </button>
      )}
      {!phone && (
        <button
          type="button"
          className="btn ghost icon"
          title="Zoom in"
          onClick={() => audioView.zoomAt(1.4, 0, ...ZOOM.audio)}
        >
          <ZoomIn />
        </button>
      )}
    </>
  );
}
