/**
 * The Audio Editor's Notes view: the notes of the region's recording on the song's timeline and the
 * Piano Roll's keys and lanes. Each note is a capsule at its pitch from its start to its end, as thick
 * as it's loud, with its pitch every 5 ms drawn through it. The region's own span is lit and the rest
 * of its recording dim, as in the waveform. Time scrolls and zooms with the waveform's view, so
 * switching between the two keeps the place; the lanes scroll and zoom on their own. Only to look at,
 * for now: nothing here changes the song.
 */
import {
  type AudioClip,
  type AudioNote,
  fileSpan,
  type Project,
  type Region,
  type Track,
  ticksPerBar,
  ticksPerBeat,
  type Warp,
  warpAt,
  warpOf,
} from '@holo/session';
import { ZoomIn, ZoomOut } from 'lucide-react';
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import { locate } from '../app/actions.ts';
import { isPhone, useLayout } from '../app/layout.ts';
import { store, useApp } from '../app/store.ts';
import { engine } from '../audio/engine.ts';
import { type FoundNotes, type NotesState, recordingNotes } from '../audio/notes.ts';
import { audioView, fitAudioView, NoRecordings, useAudioRegion } from './AudioEditor.tsx';
import { alpha, prepare, roundRect, useFrame, useSize } from './frame.ts';
import { capture, type Gesture, Pinch, screenDpr, useWheel } from './gesture.ts';
import { drawKeys, drawLanes } from './keys.ts';
import {
  capsule,
  curveRuns,
  fileToTicks,
  firstAt,
  fitPitches,
  laneTop,
  levelThickness,
  maxPitchScroll,
  type PitchView,
  pitchY,
  restingPitch,
  shownPitch,
  thinPoints,
  tickToFile,
  zoomPitch,
} from './note-lanes.ts';
import { drawRuler } from './ruler.ts';
import { UndoRedo } from './UndoRedo.tsx';
import { gridStep, TouchPan, WHEEL_ZOOM, ZOOM } from './view.ts';

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

/** The seconds of its recording a region plays, [from, to). */
function fileWindow(project: Project, region: Region, clip: AudioClip): [number, number] {
  return [clip.offset, tickToFile(project.tempo, region.start, clip, region.start + region.length)];
}

/** What the bar says of the notes: how many the region plays, or what's keeping them. */
function notesStatus(project: Project, region: Region, clip: AudioClip, state: NotesState | null): string {
  const notes = notesShown(clip, state);
  if (!notes) {
    if (state?.state === 'failed') return 'Notes couldn’t be found';
    return 'Finding notes…';
  }
  const [a, b] = fileWindow(project, region, clip);
  const count = notes.filter((n) => n.t + n.d > a && n.t < b).length;
  return count === 1 ? '1 note' : `${count} notes`;
}

export function AudioNotes() {
  const { project, track, region } = useAudioRegion();
  const layout = useLayout();
  const phone = isPhone(layout);
  const middleC = useApp((s) => s.middleC);
  const keysWidth = phone ? 44 : 66;
  const clip = region?.audio;
  const state = useFound(project?.id, clip?.file);

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
  const pinch = useRef(new Pinch());
  /** Which way a pinch zooms, from how its fingers first spread: time across, pitch up and down. */
  const pinchAxis = useRef<'x' | 'y' | null>(null);
  const lastOverlay = useRef({ x: -1, w: 0, h: 0, rec: false, dpr: 0 });
  const lastDpr = useRef(screenDpr());

  // everything the picture reads: a change to any of it redraws
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list is what drawing reads, not what the effect touches
  useEffect(() => {
    dirty.current = true;
  }, [project, track, region, state, size, rulerSize, keysWidth, middleC]);
  useEffect(() => audioView.subscribe(() => (dirty.current = true)), []);
  useEffect(() => () => gesture.current?.abort(), []);

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

  useFrame(() => {
    const p = store.get().project;
    if (!p) return;
    if (region && clip) placeLanes(p, region, clip);
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
      if (ctx && track && region && clip) {
        draw(ctx, {
          project: p,
          track,
          region,
          clip,
          state,
          view: v,
          w: size.w,
          h: size.h,
        });
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
  const snapTo = (tick: number, free: boolean) => {
    if (free) return Math.round(tick);
    const step = gridStep(audioView.pxPerTick, 14, ticksPerBeat(m), ticksPerBar(m));
    return Math.round(tick / step) * step;
  };

  /** A press on the notes: a drag (a finger's flick too) scrolls them, a tap moves the playhead there. */
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    store.set({ selectedRegions: [region.id] });
    gesture.current?.abort();
    const touch = e.pointerType === 'touch';
    // a finger landing while the view still coasts from a flick catches it, and isn't a tap
    const caught = audioView.stopFling();
    const pan = touch ? new TouchPan(audioView, 'xy', maxY, e) : null;
    let lx = e.clientX;
    let ly = e.clientY;
    gesture.current = capture(e, {
      onMove: (ev) => {
        if (pan) pan.move(ev);
        else {
          audioView.scrollBy(lx - ev.clientX, ly - ev.clientY, maxY());
          lx = ev.clientX;
          ly = ev.clientY;
        }
      },
      onUp: (ev, g) => {
        gesture.current = null;
        pan?.end(ev.timeStamp);
        if (!g.moved && !caught) locate(snapTo(audioView.xToTick(ev.clientX - rect.left), true));
      },
      onAbort: () => {
        gesture.current = null;
      },
    });
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
    <div className="audio-notes" style={{ ['--keys' as string]: `${keysWidth}px` }}>
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
          if (!z) return;
          const rect = e.currentTarget.getBoundingClientRect();
          pinchAxis.current ??= z.dx >= z.dy ? 'x' : 'y';
          if (pinchAxis.current === 'x') audioView.zoomAt(z.factor, z.x - rect.left, ...ZOOM.audio);
          else zoomLanes(z.factor, z.y - rect.top);
        }}
        onPointerUp={(e) => {
          if (pinch.current.up(e)) pinchAxis.current = null;
        }}
        onPointerCancel={(e) => {
          if (pinch.current.up(e)) pinchAxis.current = null;
        }}
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
  view: PitchView;
  w: number;
  h: number;
}

/** What a pass of the notes is drawn in: the region's own span lit, the rest of the recording dim. */
interface Ink {
  fill: string;
  edge: string;
  curve: string;
  rest: string;
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

  const notes = notesShown(clip, s.state);
  const found = s.state?.state === 'found' ? s.state.found : null;
  if (notes) {
    const edited = !!clip.notes && !clip.notes.off;
    const warp = edited && clip.notes ? warpOf(clip.notes) : null;
    // the pitch curve stands back while the view is zoomed out (where it's a vibrato's zigzag a few
    // pixels wide), and comes forward as a second of it takes more room
    const ticks = fileToTicks(project.tempo, region.start, clip);
    const perSecond = Math.abs(audioView.tickToX(ticks(clip.offset + 1)) - audioView.tickToX(ticks(clip.offset)));
    const shown = Math.max(0.4, Math.min(0.85, perSecond / 120));
    const dim: Ink = {
      fill: 'rgba(160,170,184,0.14)',
      edge: 'rgba(160,170,184,0.34)',
      curve: `rgba(242,245,248,${(shown * 0.4).toFixed(2)})`,
      rest: 'rgba(125,135,150,0.3)',
    };
    const lit: Ink = {
      fill: alpha(track.color, 0.5),
      edge: track.color,
      curve: `rgba(246,248,251,${shown.toFixed(2)})`,
      rest: 'rgba(125,135,150,0.75)',
    };
    // the whole recording dim, then the region's span over it, lit
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, Math.max(0, x0), h);
    ctx.rect(x1, 0, Math.max(0, w - x1), h);
    ctx.clip();
    drawNotes(ctx, s, notes, edited, warp, found, dim);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, x1 - x0, h);
    ctx.clip();
    drawNotes(ctx, s, notes, edited, warp, found, lit);
    ctx.restore();
  }

  // the region's edges
  ctx.fillStyle = track.color;
  ctx.fillRect(x0 - 1, 0, 2, h);
  ctx.fillRect(x1 - 1, 0, 2, h);

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

/** The notes in one ink: each a capsule as thick as it's loud, its pitch curve through it. */
function drawNotes(
  ctx: CanvasRenderingContext2D,
  s: Scene,
  notes: readonly AudioNote[],
  edited: boolean,
  warp: Warp | null,
  found: FoundNotes | null,
  ink: Ink,
): void {
  const { project, region, clip, view, w, h } = s;
  const kh = view.keyHeight;
  const ticks = fileToTicks(project.tempo, region.start, clip);
  // where a time in the file as recorded is drawn: moved by the notes' time edits, then onto the timeline
  const moved = warp && warp.src.length > 1 ? warp : null;
  const xOf = (sec: number) => audioView.tickToX(ticks(moved ? warpAt(moved, sec) : sec));
  const thick = Math.max(4, kh * 0.95);
  const thin = Math.max(2, kh * 0.2);
  const curve = found?.curve ?? null;
  const loudest = found?.loudest ?? 0;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i] as AudioNote;
    const nx0 = xOf(n.t);
    const nx1 = xOf(n.t + n.d);
    if (nx1 < -2 || nx0 > w + 2) continue;
    const pitch = edited ? shownPitch(n) : n.p;
    if (pitch === null) {
      // no pitch: a thin bar where the line was, or is going
      const rest = restingPitch(notes, i);
      const cy = rest === null ? h / 2 : pitchY(rest, kh, view.y);
      roundRect(ctx, nx0, cy - 1.5, Math.max(2, nx1 - nx0), 3, 1.5);
      ctx.fillStyle = ink.rest;
      ctx.fill();
      continue;
    }
    const cy = pitchY(pitch, kh, view.y);
    // (its curve may slide a few semitones off it, at its ends)
    const reach = thick + 5 * kh;
    if (cy < -reach || cy > h + reach) continue;
    const shift = pitch - (n.p as number);
    const i0 = curve ? firstAt(curve.t, n.t) : 0;
    const i1 = curve ? firstAt(curve.t, n.t + n.d) : 0;
    // its outline: thick where it's loud (thinner when its level is turned down), rounded at its ends
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
    const o = capsule(xs, halves, nx0, nx1);
    ctx.beginPath();
    ctx.moveTo(o.x[0] as number, cy);
    for (let k = 0; k < o.x.length; k++) ctx.lineTo(o.x[k] as number, cy - (o.half[k] as number));
    for (let k = o.x.length - 1; k >= 0; k--) ctx.lineTo(o.x[k] as number, cy + (o.half[k] as number));
    ctx.closePath();
    const muted = edited && (n.m || n.off);
    if (!muted) {
      ctx.fillStyle = ink.fill;
      ctx.fill();
    }
    ctx.strokeStyle = ink.edge;
    ctx.lineWidth = 1;
    ctx.stroke();
    // its pitch, every 5 ms, through it (moved with it)
    if (curve && i1 > i0) {
      ctx.beginPath();
      for (const run of curveRuns(curve.midi, i0, i1, (k) => xOf(curve.t[k] as number), 1.5)) {
        ctx.moveTo(run.x[0] as number, pitchY((run.p[0] as number) + shift, kh, view.y));
        for (let k = 1; k < run.x.length; k++)
          ctx.lineTo(run.x[k] as number, pitchY((run.p[k] as number) + shift, kh, view.y));
      }
      ctx.strokeStyle = ink.curve;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

export function AudioNotesBar() {
  const { project, track, region } = useAudioRegion();
  const phone = isPhone(useLayout());
  const clip = region?.audio;
  const state = useFound(project?.id, clip?.file);
  return (
    <>
      {!phone && <span className="title">Audio Editor</span>}
      <span className="muted" style={{ whiteSpace: 'nowrap' }}>
        {track?.name ?? ''}
      </span>
      {project && region && clip && (
        <span className="muted" style={{ whiteSpace: 'nowrap' }}>
          {notesStatus(project, region, clip, state)}
        </span>
      )}
      <span className="grow" />
      {/* a phone has them in its control bar or side rail, on the same screen */}
      {!phone && <UndoRedo group="seg" />}
      <button
        type="button"
        className="btn ghost icon"
        title="Zoom out"
        onClick={() => audioView.zoomAt(0.7, 0, ...ZOOM.audio)}
      >
        <ZoomOut />
      </button>
      <button
        type="button"
        className="btn ghost icon"
        title="Zoom in"
        onClick={() => audioView.zoomAt(1.4, 0, ...ZOOM.audio)}
      >
        <ZoomIn />
      </button>
    </>
  );
}
