/**
 * The Piano Roll: the keyboard down the left, the notes on a grid. Drag a note up or down to change
 * its pitch, sideways to move it, by its edges to change its length; the lane underneath sets each
 * note's velocity or draws any controller (mod wheel, expression, sustain, pitch bend, aftertouch,
 * any CC number).
 */
import {
  type CCPoint,
  DIVISIONS,
  type Note,
  newRegion,
  noteName,
  PPQ,
  type Project,
  quantize,
  type Region,
  type Track,
  ticksPerBar,
  ticksPerBeat,
  tickToBarBeat,
} from '@holo/session';
import { Eraser, MousePointer2, Pencil, ZoomIn, ZoomOut } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  apply,
  deleteNotes,
  ensureAudio,
  quantizeSelection,
  replaceNotes,
  transposeSelection,
} from '../app/actions.ts';
import { isPhone, useLayout } from '../app/layout.ts';
import { store, useApp } from '../app/store.ts';
import { engine } from '../audio/engine.ts';
import { midi } from '../audio/midi.ts';
import { alpha, prepare, roundRect, useFrame, useSize, velocityColor } from './frame.ts';
import { capture, edgeScroll, type Gesture, type GestureOptions, Pinch, screenDpr, useWheel } from './gesture.ts';
import { openMenu } from './menu.tsx';
import { DOUBLE_TAP_MS, gridStep, Viewport, WHEEL_ZOOM, ZOOM } from './view.ts';

export const rollView = new Viewport(store.get().pianoZoom);

/** The lanes: id, the short name the narrow picker shows, the full name (for undo). */
const LANES: [string, string, string][] = [
  ['velocity', 'Vel', 'Velocity'],
  ['1', 'Mod', 'Mod Wheel (CC 1)'],
  ['11', 'Expr', 'Expression (CC 11)'],
  ['64', 'Sust', 'Sustain (CC 64)'],
  ['7', 'Vol', 'Volume (CC 7)'],
  ['10', 'Pan', 'Pan (CC 10)'],
  ['pb', 'Bend', 'Pitch Bend'],
  ['at', 'AT', 'Aftertouch'],
  ['2', 'Breath', 'Breath (CC 2)'],
  ['74', 'Bright', 'Brightness (CC 74)'],
];

const BLACK = new Set([1, 3, 6, 8, 10]);
const isBlack = (p: number) => BLACK.has(((p % 12) + 12) % 12);

// the velocity colours are mixed once per velocity, not per note per frame
const velColors = new Map<number, string>();
function velColor(v: number): string {
  let c = velColors.get(v);
  if (!c) {
    c = velocityColor(v);
    velColors.set(v, c);
  }
  return c;
}

interface NoteRef {
  note: Note;
  region: Region;
  track: Track;
}

interface Preview {
  /** Notes being dragged, as they would be. */
  changed: Map<Note, Note>;
  /** A note being drawn. */
  drawing?: { start: number; length: number; pitch: number };
  marquee?: { x0: number; y0: number; x1: number; y1: number };
  /** Controller points being drawn. */
  points?: CCPoint[];
}

function lanePoints(regions: Region[], lane: string): { region: Region; at: number; value: number }[] {
  const out: { region: Region; at: number; value: number }[] = [];
  for (const r of regions) for (const [t, v] of r.cc[lane] ?? []) out.push({ region: r, at: r.start + t, value: v });
  return out.sort((a, b) => a.at - b.at);
}

const laneRange = (lane: string) => (lane === 'pb' ? { min: -8192, max: 8191 } : { min: 0, max: 127 });

const startOf = (r: NoteRef) => r.region.start + r.note.t;

/** Edge of a note a mouse grabs, and the wider one a finger does. */
const EDGE = 8;
const EDGE_TOUCH = 14;

export function PianoRoll() {
  const layout = useLayout();
  const phone = isPhone(layout);
  const project = useApp((s) => s.project);
  const trackId = useApp((s) => s.selectedTrack);
  const selectedRegionIds = useApp((s) => s.selectedRegions);
  const selectedNotes = useApp((s) => s.selectedNotes);
  const keyHeight = useApp((s) => (phone ? Math.max(18, s.keyHeight) : s.keyHeight));
  const tool = useApp((s) => s.tool);
  const grid = useApp((s) => s.grid);
  const lane = useApp((s) => s.lane);
  const middleC = useApp((s) => s.middleC);
  const follow = useApp((s) => s.follow);

  const track = project?.tracks.find((t) => t.id === trackId) ?? null;
  const notesBox = useRef<HTMLDivElement>(null);
  const keysBox = useRef<HTMLDivElement>(null);
  const laneBox = useRef<HTMLDivElement>(null);
  const keysCanvas = useRef<HTMLCanvasElement>(null);
  const notesCanvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const rulerCanvas = useRef<HTMLCanvasElement>(null);
  const laneCanvas = useRef<HTMLCanvasElement>(null);
  const rulerBox = useRef<HTMLDivElement>(null);
  const size = useSize(notesBox);
  const laneSize = useSize(laneBox);
  const rulerSize = useSize(rulerBox);
  const preview = useRef<Preview | null>(null);
  /** Everything redraws; the keys and the lane also on their own, for what touches only them. */
  const dirty = useRef(true);
  const keysDirty = useRef(false);
  const laneDirty = useRef(false);
  const held = useRef(new Set<number>());
  const lastLength = useRef(PPQ / 2);
  const lastVelocity = useRef(100);
  /** The lane's height: the layout's, until the splitter is dragged. */
  const [laneOverride, setLaneOverride] = useState<number | null>(null);
  const laneHeight = laneOverride ?? (layout === 'phone-landscape' ? 40 : phone ? 70 : 96);
  const keysWidth = phone ? 44 : 66;
  const selected = useMemo(() => new Set(selectedNotes), [selectedNotes]);
  const lastTap = useRef(0);
  const gesture = useRef<Gesture | null>(null);
  const menuAt = useRef<((ev: PointerEvent) => void) | null>(null);
  const pinch = useRef(new Pinch());
  const zoomTimer = useRef(0);
  const lastOverlay = useRef({ x: -1, w: 0, h: 0, rec: false, dpr: 0 });
  const lastDpr = useRef(screenDpr());
  const lastTick = useRef(Number.NaN);

  const gridTicks = DIVISIONS[grid] ?? PPQ / 4;
  const total = 128 * keyHeight;

  // the notes on screen: every region of the selected track, in order of where they start
  const refs = useMemo<NoteRef[]>(() => {
    if (!track) return [];
    const out = track.regions.flatMap((region) => region.notes.map((note) => ({ note, region, track })));
    return out.sort((a, b) => startOf(a) - startOf(b));
  }, [track]);
  // the longest note: how far left of the view a note may start and still reach into it
  const longest = useMemo(() => refs.reduce((m, r) => Math.max(m, r.note.d), 0), [refs]);
  const regions = track?.regions;
  const lanePts = useMemo(() => (regions && lane !== 'velocity' ? lanePoints(regions, lane) : []), [regions, lane]);

  // everything the surfaces read: a change to any of it redraws them all
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list is what drawing reads, not what the effect touches
  useEffect(() => {
    dirty.current = true;
  }, [
    project,
    track,
    selectedRegionIds,
    selected,
    keyHeight,
    gridTicks,
    lane,
    middleC,
    size,
    laneSize,
    rulerSize,
    keysWidth,
  ]);

  useEffect(() => rollView.subscribe(() => (dirty.current = true)), []);
  useEffect(() => () => gesture.current?.abort(), []);
  // a rotation resets the lane to the layout's height
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on a layout change, which it doesn't read
  useEffect(() => setLaneOverride(null), [layout]);

  // when a track opens (and only then): show it from the playhead, or its selected or first region,
  // centred on the notes in view
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the track changes, not on every edit
  useLayoutEffect(() => {
    if (!track || !size.h) return;
    const at = engine.positionTick();
    const first = track.regions.find((r) => selectedRegionIds.includes(r.id)) ?? track.regions[0];
    const from = at > 0 ? at : (first?.start ?? 0);
    rollView.x = Math.max(0, from - PPQ);
    const span = size.w / rollView.pxPerTick;
    const all = track.regions.flatMap((r) => r.notes.map((n) => ({ at: r.start + n.t, p: n.p })));
    const near = all.filter((n) => n.at >= rollView.x && n.at < rollView.x + span);
    const pitches = (near.length ? near : all).map((n) => n.p);
    const mid = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : 66;
    rollView.y = Math.max(0, Math.min(total - size.h, (127 - mid) * keyHeight - size.h / 2));
    rollView.emit();
  }, [track?.id, size.h > 0]);

  // keys lit by what's being played live
  useEffect(
    () =>
      midi.onEvent((e) => {
        const kind = e.status & 0xf0;
        if (kind === 0x90 && e.d2 > 0) held.current.add(e.d1);
        else if (kind === 0x80 || kind === 0x90) held.current.delete(e.d1);
        keysDirty.current = true;
      }),
    [],
  );

  const yOf = (p: number) => (127 - p) * keyHeight - rollView.y;
  const pitchAt = (y: number) => Math.max(0, Math.min(127, 127 - Math.floor((y + rollView.y) / keyHeight)));
  const maxY = Math.max(0, total - size.h);

  // ---- drawing ----

  const drawKeys = () => {
    const h = size.h;
    const kw = keysWidth;
    const kctx = prepare(keysCanvas.current, kw, h);
    if (!kctx) return;
    const color = track?.color ?? '#5cb8ff';
    kctx.fillStyle = '#0b0d10';
    kctx.fillRect(0, 0, kw, h);
    // the white keys' sheen runs sideways, so one gradient serves every key
    const white = kctx.createLinearGradient(0, 0, kw, 0);
    white.addColorStop(0, '#d9dde3');
    white.addColorStop(1, '#f1f3f6');
    const whiteLit = kctx.createLinearGradient(0, 0, kw, 0);
    whiteLit.addColorStop(0, color);
    whiteLit.addColorStop(1, alpha(color, 0.7));
    const blackW = Math.round(kw * 0.6);
    const font = `600 ${Math.min(11, keyHeight - 2)}px Inter Variable, system-ui, sans-serif`;
    kctx.font = font;
    kctx.textBaseline = 'middle';
    for (let pitch = 0; pitch < 128; pitch++) {
      const y = yOf(pitch);
      if (y > h || y + keyHeight < 0) continue;
      const lit = held.current.has(pitch);
      if (isBlack(pitch)) {
        kctx.fillStyle = lit ? color : '#1d2026';
        kctx.fillRect(0, y, blackW, keyHeight);
        kctx.fillStyle = lit ? alpha(color, 0.6) : '#e9ecf1';
        kctx.fillRect(blackW, y, kw - blackW, keyHeight);
      } else {
        kctx.fillStyle = lit ? whiteLit : white;
        kctx.fillRect(0, y, kw, keyHeight);
      }
      if (pitch % 12 === 0 || pitch % 12 === 5) {
        kctx.fillStyle = '#9aa1ab';
        kctx.fillRect(0, y + keyHeight - 0.5, kw, 1);
      }
      if (pitch % 12 === 0 && keyHeight >= 9) {
        kctx.fillStyle = '#3a414c';
        kctx.fillText(noteName(pitch, middleC), kw - 22, y + keyHeight / 2);
      }
    }
    kctx.fillStyle = '#0b0d10';
    kctx.fillRect(kw - 1, 0, 1, h);
  };

  /** The refs that can reach into the view, from the first that may to the first that can't. */
  const visibleRefs = (from: number, to: number): [number, number] => {
    let lo = 0;
    let hi = refs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (startOf(refs[mid] as NoteRef) < from - longest) lo = mid + 1;
      else hi = mid;
    }
    let end = lo;
    while (end < refs.length && startOf(refs[end] as NoteRef) <= to) end++;
    return [lo, end];
  };

  const drawNotes = (p: Project) => {
    const w = size.w;
    const h = size.h;
    const v = rollView;
    const m = p.meter[0] ?? { tick: 0, num: 4, den: 4 };
    const beat = ticksPerBeat(m);
    const bar = ticksPerBar(m);
    const pv = preview.current;

    const ctx = prepare(notesCanvas.current, w, h);
    if (ctx) {
      for (let pitch = 0; pitch < 128; pitch++) {
        const y = yOf(pitch);
        if (y > h || y + keyHeight < 0) continue;
        ctx.fillStyle = isBlack(pitch) ? '#121418' : '#181b20';
        ctx.fillRect(0, y, w, keyHeight);
        if (pitch % 12 === 0 || pitch % 12 === 5) {
          ctx.fillStyle = pitch % 12 === 0 ? '#2a2f37' : '#1f2329';
          ctx.fillRect(0, y + keyHeight - 1, w, 1);
        }
      }
      // regions: lighter where the track has one, the selected ones a touch more
      for (const r of track?.regions ?? []) {
        const x0 = v.tickToX(r.start);
        const x1 = v.tickToX(r.start + r.length);
        if (x1 < 0 || x0 > w) continue;
        ctx.fillStyle = selectedRegionIds.includes(r.id)
          ? alpha(track?.color ?? '#5cb8ff', 0.07)
          : 'rgba(255,255,255,0.025)';
        ctx.fillRect(x0, 0, x1 - x0, h);
        ctx.fillStyle = alpha(track?.color ?? '#5cb8ff', 0.5);
        ctx.fillRect(x0, 0, 1, h);
        ctx.fillRect(x1 - 1, 0, 1, h);
      }
      const step = Math.max(gridTicks, gridStep(v.pxPerTick, 9, beat, bar));
      for (let t = Math.floor(v.x / step) * step; t < v.xToTick(w); t += step) {
        const x = Math.round(v.tickToX(t)) + 0.5;
        ctx.fillStyle =
          t % bar === 0
            ? 'rgba(255,255,255,0.12)'
            : t % beat === 0
              ? 'rgba(255,255,255,0.055)'
              : 'rgba(255,255,255,0.025)';
        ctx.fillRect(x, 0, 1, h);
      }
      if (p.cycle.on) {
        ctx.fillStyle = 'rgba(246,196,83,0.045)';
        ctx.fillRect(v.tickToX(p.cycle.start), 0, (p.cycle.end - p.cycle.start) * v.pxPerTick, h);
      }

      // notes
      ctx.font = `600 ${Math.min(10.5, keyHeight - 3)}px Inter Variable, system-ui, sans-serif`;
      ctx.textBaseline = 'middle';
      const drawNote = (n: Note, region: Region, isSel: boolean, ghost = false) => {
        const x = v.tickToX(region.start + n.t);
        const nw = Math.max(3, n.d * v.pxPerTick - 1);
        const y = yOf(n.p) + 1;
        const nh = keyHeight - 2;
        if (x > w || x + nw < 0 || y > h || y + nh < 0) return;
        const c = velColor(n.v);
        ctx.globalAlpha = ghost ? 0.35 : 1;
        roundRect(ctx, x, y, nw, nh, Math.min(3, nh / 3));
        ctx.fillStyle = isSel ? '#ffffff' : c;
        ctx.fill();
        ctx.strokeStyle = isSel ? '#ffffff' : 'rgba(0,0,0,0.55)';
        ctx.lineWidth = isSel ? 1.25 : 1;
        ctx.stroke();
        // a lighter top edge gives the note its shape without a gradient per note
        if (!isSel && nh > 4) {
          ctx.fillStyle = 'rgba(255,255,255,0.22)';
          ctx.fillRect(x + 1, y + 1, Math.max(1, nw - 2), 1);
        }
        // the velocity, as a line inside the note (as Logic draws it)
        if (nw > 10 && nh > 6) {
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.fillRect(x + 2, y + nh / 2 - 0.5, Math.max(2, (nw - 4) * (n.v / 127)), 1);
        }
        if (nw > 34 && nh >= 10) {
          // dark text on bright notes, light text on dark (soft) ones
          ctx.fillStyle = isSel || n.v >= 64 ? 'rgba(8,10,12,0.85)' : 'rgba(235,241,255,0.92)';
          ctx.fillText(noteName(n.p, middleC), x + 4, y + nh / 2 + 0.5);
        }
        ctx.globalAlpha = 1;
      };
      // dragged notes may be anywhere, so a drag draws them all; otherwise only those in reach
      const [from, to] = pv?.changed.size ? [0, refs.length] : visibleRefs(v.x, v.xToTick(w));
      for (let i = from; i < to; i++) {
        const r = refs[i] as NoteRef;
        const changed = pv?.changed.get(r.note);
        if (changed) drawNote(r.note, r.region, false, true);
        drawNote(changed ?? r.note, r.region, selected.has(r.note) || !!changed);
      }
      if (pv?.drawing) {
        const d = pv.drawing;
        drawNote({ t: d.start, d: d.length, p: d.pitch, v: lastVelocity.current }, { start: 0 } as Region, true);
      }
      if (pv?.marquee) {
        const mq = pv.marquee;
        ctx.fillStyle = 'rgba(92,184,255,0.1)';
        ctx.strokeStyle = 'rgba(92,184,255,0.8)';
        ctx.fillRect(Math.min(mq.x0, mq.x1), Math.min(mq.y0, mq.y1), Math.abs(mq.x1 - mq.x0), Math.abs(mq.y1 - mq.y0));
        ctx.strokeRect(
          Math.min(mq.x0, mq.x1) + 0.5,
          Math.min(mq.y0, mq.y1) + 0.5,
          Math.abs(mq.x1 - mq.x0),
          Math.abs(mq.y1 - mq.y0),
        );
      }
    }

    // ruler
    const rctx = prepare(rulerCanvas.current, rulerSize.w, rulerSize.h);
    if (rctx) {
      rctx.fillStyle = '#1b1e23';
      rctx.fillRect(0, 0, rulerSize.w, rulerSize.h);
      rctx.font = '600 10.5px Inter Variable, system-ui, sans-serif';
      const step = gridStep(v.pxPerTick, 7, beat, bar);
      // labels on beats at the finest (a label between beats would repeat its beat's number)
      const labels = Math.max(beat, gridStep(v.pxPerTick, 40, beat, bar));
      for (let t = Math.floor(v.x / step) * step; t < v.xToTick(rulerSize.w); t += step) {
        const x = Math.round(v.tickToX(t)) + 0.5;
        const isBar = t % bar === 0;
        rctx.fillStyle = isBar ? '#7d8796' : '#454c57';
        rctx.fillRect(x, isBar ? rulerSize.h - 11 : rulerSize.h - 5, 1, isBar ? 11 : 5);
        if (t % labels === 0) {
          const bb = tickToBarBeat(p.meter, t);
          rctx.fillStyle = isBar ? '#c3cad4' : '#7d8796';
          rctx.fillText(isBar ? String(bb.bar) : `${bb.bar}.${bb.beat}`, x + 3, rulerSize.h - 4);
        }
      }
      rctx.fillStyle = '#0b0d10';
      rctx.fillRect(0, rulerSize.h - 1, rulerSize.w, 1);
    }
  };

  const drawLane = (p: Project) => {
    const v = rollView;
    const bar = ticksPerBar(p.meter[0] ?? { tick: 0, num: 4, den: 4 });
    const pv = preview.current;
    const lctx = prepare(laneCanvas.current, laneSize.w, laneSize.h);
    if (!lctx || !track) return;
    const lw = laneSize.w;
    const lh = laneSize.h;
    lctx.fillStyle = '#101215';
    lctx.fillRect(0, 0, lw, lh);
    lctx.fillStyle = 'rgba(255,255,255,0.04)';
    for (const f of [0.25, 0.5, 0.75]) lctx.fillRect(0, Math.round(lh * f) + 0.5, lw, 1);
    if (lane === 'velocity') {
      const [from, to] = pv?.changed.size ? [0, refs.length] : visibleRefs(v.x, v.xToTick(lw));
      for (let i = from; i < to; i++) {
        const r = refs[i] as NoteRef;
        const n = pv?.changed.get(r.note) ?? r.note;
        const x = v.tickToX(r.region.start + n.t);
        if (x < -4 || x > lw + 4) continue;
        const bh = (n.v / 127) * (lh - 6);
        const isSel = selected.has(r.note);
        lctx.fillStyle = isSel ? '#ffffff' : velColor(n.v);
        lctx.fillRect(x, lh - bh, 2, bh);
        lctx.beginPath();
        lctx.arc(x + 1, lh - bh, isSel ? 3.5 : 2.5, 0, Math.PI * 2);
        lctx.fill();
      }
    } else {
      const { min, max } = laneRange(lane);
      const pts = pv?.points ? pv.points.map(([at, value]) => ({ at, value })) : lanePts;
      const yv = (val: number) => lh - 3 - ((val - min) / (max - min)) * (lh - 6);
      lctx.strokeStyle = track.color;
      lctx.fillStyle = alpha(track.color, 0.22);
      lctx.lineWidth = 1.5;
      if (pts.length) {
        lctx.beginPath();
        const base = lane === 'pb' ? yv(0) : lh;
        lctx.moveTo(0, base);
        let lastY = base;
        for (const pt of pts) {
          const x = v.tickToX(pt.at);
          lctx.lineTo(x, lastY);
          lastY = yv(pt.value);
          lctx.lineTo(x, lastY);
        }
        lctx.lineTo(lw, lastY);
        lctx.lineTo(lw, base);
        lctx.closePath();
        lctx.fill();
        lctx.stroke();
        lctx.fillStyle = '#ffffff';
        for (const pt of pts) {
          const x = v.tickToX(pt.at);
          if (x < -4 || x > lw + 4) continue;
          lctx.beginPath();
          lctx.arc(x, yv(pt.value), 2.5, 0, Math.PI * 2);
          lctx.fill();
        }
      } else {
        lctx.fillStyle = '#4b525d';
        lctx.font = '500 11px Inter Variable, system-ui, sans-serif';
        lctx.fillText('Draw with the pencil to add controller points', 10, lh / 2);
      }
    }
    // grid in the lane
    lctx.fillStyle = 'rgba(255,255,255,0.07)';
    for (let t = Math.floor(v.x / bar) * bar; t < v.xToTick(lw); t += bar) {
      lctx.fillRect(Math.round(v.tickToX(t)) + 0.5, 0, 1, lh);
    }
  };

  // the zoom is kept for the next launch, once the wheel or the fingers settle
  const persistZoom = (soon = false) => {
    window.clearTimeout(zoomTimer.current);
    if (!soon) {
      store.set({ pianoZoom: rollView.zoom });
      return;
    }
    zoomTimer.current = window.setTimeout(() => store.set({ pianoZoom: rollView.zoom }), 200);
  };

  useFrame(() => {
    const s = store.get();
    const p = s.project;
    if (!p) return;
    const tick = engine.positionTick();
    const busy = !!gesture.current || pinch.current.active;
    if (follow && !busy) {
      // a jump (a locate, a cycle wrap) is shown wherever it lands; playback pages at the right edge
      if (!Number.isNaN(lastTick.current) && Math.abs(tick - lastTick.current) > PPQ / 2) rollView.reveal(tick, size.w);
      else if (s.playing) rollView.follow(tick, size.w);
    }
    lastTick.current = tick;
    // a drag resting at an edge scrolls the view under it
    const g = gesture.current;
    if (g?.edgeScroll && notesBox.current) {
      const { dx, dy } = edgeScroll(g.last, notesBox.current.getBoundingClientRect(), g.edgeScroll);
      if (dx || dy) {
        rollView.scrollBy(dx, dy, maxY);
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
      keysDirty.current = false;
      laneDirty.current = false;
      drawKeys();
      drawNotes(p);
      drawLane(p);
    } else {
      if (keysDirty.current) {
        keysDirty.current = false;
        drawKeys();
      }
      if (laneDirty.current) {
        laneDirty.current = false;
        drawLane(p);
      }
    }
    // the playhead, on its own layer, redrawn only when it has moved a pixel
    const x = Math.round(rollView.tickToX(Math.max(0, tick))) + 0.5;
    const rec = s.recording;
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

  const onWheel = (e: WheelEvent, dx: number, dy: number) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      rollView.zoomAt(Math.exp(-dy * WHEEL_ZOOM), e.clientX - rect.left, ...ZOOM.roll);
      persistZoom(true);
    } else if (e.altKey) {
      store.set({ keyHeight: Math.max(7, Math.min(32, keyHeight - Math.sign(dy))) });
    } else if (e.shiftKey) rollView.scrollBy(dy || dx, 0, maxY);
    else rollView.scrollBy(dx, dy, maxY);
  };
  useWheel(notesBox, onWheel);
  useWheel(keysBox, onWheel);
  useWheel(laneBox, onWheel);

  if (!project) return null;
  if (!track) {
    return (
      <div className="roll" style={{ display: 'grid', placeItems: 'center' }}>
        <span className="muted">Select a track to see its notes.</span>
      </div>
    );
  }

  // ---- editing ----

  const hitNote = (x: number, y: number, touch = false): { ref: NoteRef; edge: 'start' | 'end' | null } | null => {
    const tick = rollView.xToTick(x);
    const pitch = pitchAt(y);
    const edgeMax = touch ? EDGE_TOUCH : EDGE;
    for (let i = refs.length - 1; i >= 0; i--) {
      const r = refs[i] as NoteRef;
      const start = r.region.start + r.note.t;
      if (Math.round(r.note.p) !== pitch || tick < start || tick > start + r.note.d) continue;
      const x0 = rollView.tickToX(start);
      const x1 = rollView.tickToX(start + r.note.d);
      const edgePx = Math.min(edgeMax, (x1 - x0) / 3);
      return { ref: r, edge: x1 - x < edgePx ? 'end' : x - x0 < edgePx && x1 - x0 > 16 ? 'start' : null };
    }
    return null;
  };

  /**
   * Start a gesture on the roll: the one under way at a time, aborted by a second finger or a long
   * press (which opens the menu for the spot), its preview cleared whichever way it ends.
   */
  const start = (e: ReactPointerEvent, o: GestureOptions) => {
    gesture.current?.abort();
    const menu = menuAt.current;
    const g = capture(e, {
      ...o,
      onUp: (ev, gg) => {
        gesture.current = null;
        o.onUp?.(ev, gg);
      },
      onAbort: () => {
        gesture.current = null;
        preview.current = null;
        dirty.current = true;
        o.onAbort?.();
      },
      onLongPress: menu ? (ev) => menu(ev) : undefined,
    });
    gesture.current = g;
    return g;
  };

  const audition = (pitch: number, velocity = lastVelocity.current) => {
    void ensureAudio().then(() => engine.audition(track.id, pitch, velocity, 240));
  };

  /** The region a new note at `tick` goes into: the one there, or a new one covering the bar. */
  const regionFor = (tick: number): { region: Region; created: boolean } => {
    const inside = track.regions.find((r) => tick >= r.start && tick < r.start + r.length);
    if (inside) return { region: inside, created: false };
    const m = project.meter[0] ?? { tick: 0, num: 4, den: 4 };
    const bar = ticksPerBar(m);
    const start = Math.floor(tick / bar) * bar;
    return { region: newRegion(start, bar, ''), created: true };
  };

  /** The menu for a note (and the selection it belongs to): what the keyboard does, by name. */
  const noteMenu = (x: number, y: number, note: Note) => {
    const group = selected.has(note) ? selectedNotes : [note];
    if (!selected.has(note)) store.set({ selectedNotes: [note] });
    const velocity = (v: number) => replaceNotes(new Map(group.map((n) => [n, { ...n, v }])), 'Velocity');
    openMenu(x, y, [
      { label: 'Quantize', hint: 'Q', onSelect: quantizeSelection },
      { label: 'Up an octave', hint: 'Shift ↑', onSelect: () => transposeSelection(12) },
      { label: 'Down an octave', hint: 'Shift ↓', onSelect: () => transposeSelection(-12) },
      { label: 'Up a semitone', hint: '↑', onSelect: () => transposeSelection(1) },
      { label: 'Down a semitone', hint: '↓', onSelect: () => transposeSelection(-1) },
      'sep',
      { heading: 'Velocity' },
      { label: 'Soft', hint: '50', onSelect: () => velocity(50) },
      { label: 'Medium', hint: '90', onSelect: () => velocity(90) },
      { label: 'Hard', hint: '120', onSelect: () => velocity(120) },
      'sep',
      { label: group.length > 1 ? 'Delete notes' : 'Delete', hint: 'Delete', onSelect: () => deleteNotes(group) },
    ]);
  };

  const onNotesDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const touch = e.pointerType === 'touch';
    const now = performance.now();
    const doubleTap = now - lastTap.current < DOUBLE_TAP_MS;
    lastTap.current = now;
    menuAt.current = null;
    const h = hitNote(x, y, touch);
    if (e.button === 2) {
      if (h) noteMenu(e.clientX, e.clientY, h.ref.note);
      return;
    }
    if (h) {
      const { ref } = h;
      if (tool === 'eraser' || (doubleTap && touch)) {
        deleteNotes(selected.has(ref.note) ? [...selected] : [ref.note]);
        return;
      }
      let sel = selectedNotes;
      if (e.shiftKey) sel = selected.has(ref.note) ? sel.filter((n) => n !== ref.note) : [...sel, ref.note];
      else if (!selected.has(ref.note)) sel = [ref.note];
      store.set({ selectedNotes: sel });
      audition(ref.note.p, ref.note.v);
      lastVelocity.current = ref.note.v;
      lastLength.current = ref.note.d;
      menuAt.current = (ev) => noteMenu(ev.clientX, ev.clientY, ref.note);
      dragNotes(e, sel, h.edge, e.altKey);
      return;
    }
    const tick = rollView.xToTick(x);
    const pitch = pitchAt(y);
    if (tool === 'pencil' || doubleTap) {
      drawNoteAt(e, tick, pitch);
      return;
    }
    store.set({ selectedNotes: [] });
    if (touch) {
      let lx = e.clientX;
      let ly = e.clientY;
      start(e, {
        threshold: 0,
        onMove: (ev) => {
          rollView.scrollBy(lx - ev.clientX, ly - ev.clientY, maxY);
          lx = ev.clientX;
          ly = ev.clientY;
        },
      });
      return;
    }
    start(e, {
      edgeScroll: 'xy',
      onMove: (ev) => {
        preview.current = {
          changed: new Map(),
          marquee: { x0: x, y0: y, x1: ev.clientX - rect.left, y1: ev.clientY - rect.top },
        };
        dirty.current = true;
      },
      onUp: () => {
        const mq = preview.current?.marquee;
        preview.current = null;
        dirty.current = true;
        if (!mq) return;
        const t0 = rollView.xToTick(Math.min(mq.x0, mq.x1));
        const t1 = rollView.xToTick(Math.max(mq.x0, mq.x1));
        const p0 = pitchAt(Math.max(mq.y0, mq.y1));
        const p1 = pitchAt(Math.min(mq.y0, mq.y1));
        store.set({
          selectedNotes: refs
            .filter((r) => {
              const s = r.region.start + r.note.t;
              return s + r.note.d > t0 && s < t1 && r.note.p >= p0 && r.note.p <= p1;
            })
            .map((r) => r.note),
        });
      },
    });
  };

  const drawNoteAt = (e: ReactPointerEvent, tick: number, pitch: number) => {
    const start0 = Math.max(0, Math.floor(tick / gridTicks) * gridTicks);
    let length = lastLength.current;
    audition(pitch);
    preview.current = { changed: new Map(), drawing: { start: start0, length, pitch } };
    dirty.current = true;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    start(e, {
      edgeScroll: 'x',
      onMove: (ev) => {
        const t = rollView.xToTick(ev.clientX - rect.left);
        length = Math.max(gridTicks, quantize(t - start0, gridTicks));
        preview.current = { changed: new Map(), drawing: { start: start0, length, pitch } };
        dirty.current = true;
      },
      onUp: () => {
        preview.current = null;
        dirty.current = true;
        lastLength.current = length;
        const { region, created } = regionFor(start0);
        const note: Note = { t: start0 - region.start, d: length, p: pitch, v: lastVelocity.current };
        if (created) {
          const bar = region.length;
          region.length = Math.max(bar, Math.ceil((note.t + length) / bar) * bar);
          apply([{ op: 'addRegion', track: track.id, region: { ...region, notes: [note] } }], 'Add Note');
        } else {
          if (note.t + note.d > region.length) {
            apply(
              [
                {
                  op: 'updateRegion',
                  track: track.id,
                  region: region.id,
                  patch: { length: Math.ceil((note.t + note.d) / gridTicks) * gridTicks },
                },
                { op: 'addNotes', track: track.id, region: region.id, notes: [note] },
              ],
              'Add Note',
            );
          } else apply([{ op: 'addNotes', track: track.id, region: region.id, notes: [note] }], 'Add Note');
        }
        store.set({ selectedNotes: [note] });
      },
    });
  };

  const dragNotes = (e: ReactPointerEvent, notes: Note[], edge: 'start' | 'end' | null, copy: boolean) => {
    const startX = e.clientX;
    const startY = e.clientY;
    let lastPitchShift = 0;
    const byNote = new Map(refs.map((r) => [r.note, r]));
    start(e, {
      edgeScroll: 'xy',
      onMove: (ev, g) => {
        // a finger wobbles more than a mouse: the gesture's threshold tells a tap from a drag
        if (!g.moved) return;
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        const fine = ev.shiftKey;
        const dTick = fine ? Math.round(dx / rollView.pxPerTick) : quantize(dx / rollView.pxPerTick, gridTicks);
        const dPitch = edge ? 0 : -Math.round(dy / keyHeight);
        const changed = new Map<Note, Note>();
        for (const n of notes) {
          const r = byNote.get(n);
          if (!r) continue;
          if (edge === 'end') changed.set(n, { ...n, d: Math.max(fine ? 10 : gridTicks / 2, n.d + dTick) });
          else if (edge === 'start') {
            const t = Math.min(n.t + n.d - 10, Math.max(-r.region.start, n.t + dTick));
            changed.set(n, { ...n, t, d: n.d - (t - n.t) });
          } else {
            changed.set(n, {
              ...n,
              t: Math.max(-r.region.start, n.t + dTick),
              p: Math.max(0, Math.min(127, n.p + dPitch)),
            });
          }
        }
        if (dPitch !== lastPitchShift && notes[0]) {
          lastPitchShift = dPitch;
          audition((changed.get(notes[0]) ?? notes[0]).p);
        }
        preview.current = { changed };
        dirty.current = true;
      },
      onUp: (_ev, g) => {
        const changed = preview.current?.changed;
        preview.current = null;
        dirty.current = true;
        if (!g.moved || !changed?.size) return;
        // a wobble that settled back where it started is not an edit
        const same = [...changed].every(([o, n]) => o.t === n.t && o.d === n.d && o.p === n.p && o.v === n.v);
        if (same) return;
        // a note moved past its region's start goes before it: grow the region to keep it
        const ops = [];
        const growth = new Map<string, { region: Region; start: number; end: number }>();
        for (const [orig, next] of changed) {
          const r = byNote.get(orig);
          if (!r) continue;
          const g = growth.get(r.region.id) ?? {
            region: r.region,
            start: r.region.start,
            end: r.region.start + r.region.length,
          };
          g.start = Math.min(g.start, r.region.start + next.t);
          g.end = Math.max(g.end, r.region.start + next.t + next.d);
          growth.set(r.region.id, g);
        }
        if (copy) {
          for (const [, g] of growth) {
            const added = [...changed].filter(([o]) => byNote.get(o)?.region.id === g.region.id).map(([, n]) => n);
            ops.push({ op: 'addNotes' as const, track: track.id, region: g.region.id, notes: added });
          }
          apply(ops, 'Copy Notes');
          store.set({ selectedNotes: [...changed.values()] });
          return;
        }
        const needsGrow = [...growth.values()].some(
          (g) => g.start < g.region.start || g.end > g.region.start + g.region.length,
        );
        if (!needsGrow) {
          replaceNotes(changed, edge ? 'Note Length' : 'Move Notes');
          return;
        }
        for (const g of growth.values()) {
          const shift = g.region.start - g.start;
          const notesNext = g.region.notes.map((n) => {
            const c = changed.get(n) ?? n;
            return shift > 0 ? { ...c, t: c.t + shift } : c;
          });
          ops.push({
            op: 'updateRegion' as const,
            track: track.id,
            region: g.region.id,
            patch: { start: g.start, length: Math.ceil((g.end - g.start) / gridTicks) * gridTicks },
          });
          ops.push({ op: 'setNotes' as const, track: track.id, region: g.region.id, notes: notesNext });
        }
        apply(ops, 'Move Notes');
        store.set({ selectedNotes: [] });
      },
    });
  };

  // the keyboard: press to hear, slide for a glissando
  const onKeysDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    let pitch = pitchAt(e.clientY - rect.top);
    const vel = Math.round(40 + 87 * Math.min(1, (e.clientX - rect.left) / (keysWidth - 6)));
    void ensureAudio().then(() => engine.live(0x90, pitch, vel, track.id));
    held.current.add(pitch);
    keysDirty.current = true;
    const release = () => {
      engine.live(0x80, pitch, 0, track.id);
      held.current.delete(pitch);
      keysDirty.current = true;
    };
    capture(e, {
      threshold: 0,
      onMove: (ev) => {
        const p = pitchAt(ev.clientY - rect.top);
        if (p !== pitch) {
          engine.live(0x80, pitch, 0, track.id);
          held.current.delete(pitch);
          pitch = p;
          engine.live(0x90, pitch, vel, track.id);
          held.current.add(pitch);
          keysDirty.current = true;
        }
      },
      onUp: release,
      onAbort: release,
    });
  };

  // the controller lane
  const onLaneDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const lh = rect.height;
    menuAt.current = null;
    if (lane === 'velocity') {
      const pick = (x: number) => {
        let best: NoteRef | null = null;
        let dist = e.pointerType === 'touch' ? 14 : 8;
        for (const r of refs) {
          const d = Math.abs(rollView.tickToX(r.region.start + r.note.t) - x);
          if (d < dist) {
            dist = d;
            best = r;
          }
        }
        return best;
      };
      const first = pick(e.clientX - rect.left);
      const group = first && selected.has(first.note) ? selectedNotes : first ? [first.note] : [];
      const startY = e.clientY;
      const base = new Map(group.map((n) => [n, n.v]));
      const drawn = new Map<Note, Note>();
      start(e, {
        threshold: 0,
        onMove: (ev) => {
          const changed = new Map<Note, Note>();
          if (tool === 'pencil' || !first) {
            // drawing across bars sets each one it crosses
            const r = pick(ev.clientX - rect.left);
            if (r)
              drawn.set(r.note, {
                ...r.note,
                v: Math.round(Math.max(1, Math.min(127, ((lh - (ev.clientY - rect.top)) / (lh - 6)) * 127))),
              });
            for (const [k, v] of drawn) changed.set(k, v);
          } else {
            const dv = Math.round(((startY - ev.clientY) / (lh - 6)) * 127);
            for (const n of group) changed.set(n, { ...n, v: Math.max(1, Math.min(127, (base.get(n) ?? n.v) + dv)) });
          }
          preview.current = { changed };
          dirty.current = true;
        },
        onUp: () => {
          const changed = preview.current?.changed;
          preview.current = null;
          dirty.current = true;
          if (changed?.size) {
            replaceNotes(changed, 'Velocity', group.length > 0);
            const v = [...changed.values()][0]?.v;
            if (v) lastVelocity.current = v;
          }
        },
      });
      return;
    }
    // controller points: draw with any tool (the eraser clears what it crosses)
    const { min, max } = laneRange(lane);
    const valueAt = (y: number) => Math.round(min + Math.max(0, Math.min(1, (lh - 3 - y) / (lh - 6))) * (max - min));
    const existing = lanePts.map(({ at, value }): CCPoint => [at, value]);
    const step = Math.max(gridTicks / 2, PPQ / 16);
    const touched = new Map<number, number>();
    const visit = (ev: { clientX: number; clientY: number }) => {
      const at = Math.max(0, quantize(rollView.xToTick(ev.clientX - rect.left), step));
      touched.set(at, tool === 'eraser' ? Number.NaN : valueAt(ev.clientY - rect.top));
      const merged = existing.filter(([t]) => !touched.has(t));
      for (const [t, v] of touched) if (!Number.isNaN(v)) merged.push([t, v]);
      merged.sort((a, b) => a[0] - b[0]);
      preview.current = { changed: new Map(), points: merged };
      laneDirty.current = true;
    };
    visit(e);
    start(e, {
      threshold: 0,
      onMove: visit,
      onAbort: () => {
        laneDirty.current = true;
      },
      onUp: () => {
        const pts = preview.current?.points ?? existing;
        preview.current = null;
        laneDirty.current = true;
        // points go to the regions they fall in (a region is made for any that fall outside all)
        const ops = [];
        const byRegion = new Map<string, CCPoint[]>();
        const loose: CCPoint[] = [];
        for (const r of track.regions) byRegion.set(r.id, []);
        for (const [at, v] of pts) {
          const r = track.regions.find((x) => at >= x.start && at <= x.start + x.length);
          if (r) byRegion.get(r.id)?.push([at - r.start, v]);
          else loose.push([at, v]);
        }
        for (const r of track.regions) {
          const next = byRegion.get(r.id) ?? [];
          if (JSON.stringify(next) !== JSON.stringify(r.cc[lane] ?? []))
            ops.push({ op: 'setCC' as const, track: track.id, region: r.id, lane, points: next });
        }
        if (loose.length) {
          const first = loose[0] as CCPoint;
          const { region } = regionFor(first[0]);
          const last = loose[loose.length - 1] as CCPoint;
          region.length = Math.max(
            region.length,
            Math.ceil((last[0] - region.start + 1) / region.length) * region.length,
          );
          region.cc = { [lane]: loose.map(([at, v]): CCPoint => [at - region.start, v]) };
          ops.push({ op: 'addRegion' as const, track: track.id, region });
        }
        if (ops.length) apply(ops, LANES.find(([id]) => id === lane)?.[2] ?? 'Controller');
      },
    });
  };

  const cursorFor = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const h = hitNote(e.clientX - rect.left, e.clientY - rect.top);
    e.currentTarget.style.cursor = h?.edge ? 'ew-resize' : h ? 'grab' : tool === 'pencil' ? 'crosshair' : 'default';
  };

  return (
    <div className="roll" style={{ ['--lane' as string]: `${laneHeight}px`, ['--keys' as string]: `${keysWidth}px` }}>
      <div className="corner" />
      <div className="cell" ref={rulerBox} style={{ borderBottom: '1px solid var(--line)' }}>
        <canvas ref={rulerCanvas} />
      </div>
      <div
        className="cell"
        ref={keysBox}
        onPointerDown={onKeysDown}
        style={{ borderRight: '1px solid var(--line)', cursor: 'pointer' }}
      >
        <canvas ref={keysCanvas} />
      </div>
      <div
        className="cell"
        ref={notesBox}
        onPointerDown={(e) => {
          // a second finger turns whatever the first was doing into a pinch
          if (pinch.current.down(e)) {
            gesture.current?.abort();
            return;
          }
          if (pinch.current.active) return;
          onNotesDown(e);
        }}
        onPointerMove={(e) => {
          const z = pinch.current.move(e);
          if (z) {
            const rect = e.currentTarget.getBoundingClientRect();
            rollView.zoomAt(z.factor, z.x - rect.left, ...ZOOM.roll);
          } else cursorFor(e);
        }}
        onPointerUp={(e) => {
          if (pinch.current.up(e)) {
            lastTap.current = 0;
            persistZoom();
          }
        }}
        onPointerCancel={(e) => {
          if (pinch.current.up(e)) lastTap.current = 0;
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <canvas ref={notesCanvas} />
        <canvas ref={overlay} style={{ pointerEvents: 'none' }} />
      </div>
      <div
        className="splitter"
        style={{ gridColumn: '1 / -1' }}
        onPointerDown={(e) => {
          let h = laneHeight;
          let ly = e.clientY;
          capture(e, {
            threshold: 0,
            onMove: (ev) => {
              h = Math.max(40, Math.min(260, h - (ev.clientY - ly)));
              ly = ev.clientY;
              setLaneOverride(h);
            },
          });
        }}
      />
      <div className="lane-label">
        <select
          className="select"
          value={lane}
          aria-label="Controller lane"
          title={LANES.find(([id]) => id === lane)?.[2]}
          onChange={(e) => store.set({ lane: e.target.value })}
        >
          {LANES.map(([id, short, name]) => (
            <option key={id} value={id} title={name}>
              {short}
            </option>
          ))}
        </select>
      </div>
      <div
        className="cell"
        ref={laneBox}
        onPointerDown={onLaneDown}
        style={{ borderTop: '1px solid var(--line)', cursor: 'crosshair' }}
      >
        <canvas ref={laneCanvas} />
      </div>
    </div>
  );
}

/** The piano roll's own bar: tools, grid, quantize, transpose, velocity and zoom. */
export function PianoRollBar() {
  const tool = useApp((s) => s.tool);
  const grid = useApp((s) => s.grid);
  const selectedNotes = useApp((s) => s.selectedNotes);
  const trackName = useApp((s) => s.project?.tracks.find((t) => t.id === s.selectedTrack)?.name ?? '');
  const layout = useLayout();
  const phone = isPhone(layout);
  const vel = selectedNotes.length
    ? Math.round(selectedNotes.reduce((a, n) => a + n.v, 0) / selectedNotes.length)
    : null;
  const zoomBy = (factor: number) => {
    rollView.zoomAt(factor, 0, ...ZOOM.roll);
    store.set({ pianoZoom: rollView.zoom });
  };
  return (
    <>
      {!phone && <span className="title">Piano Roll</span>}
      <span className="muted" style={{ whiteSpace: 'nowrap' }}>
        {trackName}
      </span>
      <div className="seg">
        {(
          [
            ['pointer', <MousePointer2 key="p" />, 'Pointer: select, move, stretch'],
            ['pencil', <Pencil key="c" />, 'Pencil: draw notes and controllers'],
            ['eraser', <Eraser key="e" />, 'Eraser'],
          ] as const
        ).map(([t, icon, title]) => (
          <button
            key={t}
            type="button"
            className={`btn icon${tool === t ? ' on' : ''}`}
            title={title}
            onClick={() => store.set({ tool: t })}
          >
            {icon}
          </button>
        ))}
      </div>
      <select
        className="select"
        value={grid}
        title="Grid and note length"
        aria-label="Grid"
        onChange={(e) => store.set({ grid: e.target.value as keyof typeof DIVISIONS })}
      >
        {Object.keys(DIVISIONS).map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
      <button type="button" className="btn" title="Quantize the selection (Q)" onClick={quantizeSelection}>
        Q
      </button>
      {selectedNotes.length > 0 && (
        <>
          <span className="label">vel</span>
          <input
            type="range"
            min={1}
            max={127}
            value={vel ?? 100}
            aria-label="Velocity of the selected notes"
            style={{ width: phone ? 64 : 110, flex: 'none', accentColor: '#5cb8ff' }}
            onChange={(e) => {
              const v = Number(e.target.value);
              replaceNotes(new Map(selectedNotes.map((n) => [n, { ...n, v }])), 'Velocity');
            }}
          />
          <span className="mono" style={{ minWidth: 24 }}>
            {vel}
          </span>
        </>
      )}
      <span className="grow" />
      <button type="button" className="btn ghost icon" title="Zoom out" onClick={() => zoomBy(0.7)}>
        <ZoomOut />
      </button>
      <button type="button" className="btn ghost icon" title="Zoom in" onClick={() => zoomBy(1.4)}>
        <ZoomIn />
      </button>
    </>
  );
}
