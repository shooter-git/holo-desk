/**
 * Prism's window. Its six knobs come first, big: they're the sound. Under them the four sources as
 * tiles around the morph pad: each tile draws its source (a cycle of its waveform over its
 * oscillators' spread, its partials at their place, its recording), lit by how much the morph point
 * hears it; the point is dragged on the pad. One level down, behind four tabs: a source's settings,
 * the modulators drawn (an LFO's shape, an envelope's stages, a drawn shape, the steps), the
 * matrix as rows with their depths, and the filters, voice and effects.
 *
 * Every canvas is drawn when what it shows changes (the patch, the pointer over it), never on a
 * timer. Nothing here runs on the audio thread: a change reaches the engine once a frame, as a
 * knob's does.
 */
import {
  ampSpread,
  builtInPartials,
  builtInRecording,
  builtInWave,
  customWave,
  type Mips,
  type PrismPatch,
  pitchSpread,
  prismPatch,
  TABLE,
} from '@holo/engine';
import {
  type Instrument,
  macroValue,
  type Op,
  type ParamDef,
  PER_FX,
  PRISM_AMP_SPREADS,
  PRISM_EFFECTS,
  PRISM_ENVS,
  PRISM_FILTERS,
  PRISM_FX,
  PRISM_FX_PARAMS,
  PRISM_KINDS,
  PRISM_LFO_MODES,
  PRISM_LFO_SHAPES,
  PRISM_LFOS,
  PRISM_LINKS,
  PRISM_LOOPS,
  PRISM_MACRO_IDS,
  PRISM_MOD_SOURCES,
  PRISM_MOD_TARGETS,
  PRISM_PAN_SPREADS,
  PRISM_PARTIAL_SETS,
  PRISM_PITCH_SPREADS,
  PRISM_SAMPLES,
  PRISM_SEQS,
  PRISM_SHAPE_LOOPS,
  PRISM_SHAPES,
  PRISM_SOURCES,
  PRISM_WAVES,
  prismKey,
  prismTargetName,
  SRC_ENV,
  SRC_LFO,
  SRC_SEQ,
  SRC_SHAPE,
  SYNTH_MACROS,
  SYNTH_NOTES,
  TGT_FX,
  type Track,
} from '@holo/session';
import { ChevronDown, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { beginGesture, endGesture, gestureChange, updateTrack } from '../app/actions.ts';
import { isPhone, useLayout } from '../app/layout.ts';
import { store } from '../app/store.ts';
import { instrumentManifest } from '../audio/pack-files.ts';
import { startDrag, TAP } from './controls.tsx';
import { alpha, prepare, roundRect } from './frame.ts';
import { openMenuAt } from './menu.tsx';
import {
  envPoints,
  freeSlot,
  hitOverview,
  type LinkRow,
  lfoPoints,
  linkRows,
  MOD_COLORS,
  type OverviewLayout,
  overviewLayout,
  padWeights,
  SOURCE_COLORS,
  shapePoints,
  sourceSummary,
} from './prism-view.ts';
import { Floating, Setting, useViewport } from './window.tsx';

type SynthInstrument = Extract<Instrument, { type: 'synth' }>;
type SamplerInstrument = Extract<Instrument, { type: 'sampler' }>;
type Page = 'source' | 'mods' | 'matrix' | 'more';
type Family = 'lfo' | 'env' | 'shape' | 'seq';

const LCD = '#07090b';
const TEXT = '#dfe6ee';
const TEXT_2 = '#a9b1be';
const TEXT_3 = '#6d7584';
const LABEL_FONT = '600 10px Inter Variable, system-ui, sans-serif';
const SMALL_FONT = '500 9.5px Inter Variable, system-ui, sans-serif';
const WIDTH = 640;

/** A pack instrument's patch, for one that plays through Prism. */
export interface PrismPack {
  synth: string;
  params: Record<string, number>;
  zones: number;
}

// ---- what the window remembers between openings (a convenience) -----------------------------------------

const REMEMBER = 'holo.prism-window';
function remembered(): Page | null {
  try {
    const v = localStorage.getItem(REMEMBER);
    return v === 'source' || v === 'mods' || v === 'matrix' || v === 'more' ? v : null;
  } catch {
    return null;
  }
}
function remember(page: Page | null): void {
  try {
    if (page) localStorage.setItem(REMEMBER, page);
    else localStorage.removeItem(REMEMBER);
  } catch {
    // (private browsing: it opens closed next time)
  }
}

// ---- writing the patch -----------------------------------------------------------------------------------

function inRange(key: string, v: number): number {
  const k = prismKey(key);
  const x = k ? Math.min(k.max, Math.max(k.min, v)) : Math.min(1, Math.max(0, v));
  return Math.round(x * 1e5) / 1e5;
}

/** The patch's keys changed on a track's sound, live (part of a gesture): read fresh, so a fast drag loses nothing. */
function write(trackId: string, changes: Record<string, number>): void {
  const t = store.get().project?.tracks.find((x) => x.id === trackId);
  const inst = t?.instrument;
  if (inst?.type !== 'synth' && inst?.type !== 'sampler') return;
  const params = { ...inst.params };
  for (const [k, v] of Object.entries(changes)) params[k] = inRange(k, v);
  gestureChange([{ op: 'updateTrack', track: trackId, patch: { instrument: { ...inst, params } } } satisfies Op]);
}

interface Writer {
  begin: (what: string) => void;
  live: (changes: Record<string, number>) => void;
  end: () => void;
  once: (what: string, changes: Record<string, number>) => void;
}

function writerFor(track: Track, name: string): Writer {
  const label = (what: string) => `${name}: ${what}`;
  return {
    begin: (what) => beginGesture(label(what)),
    live: (changes) => write(track.id, changes),
    end: endGesture,
    once: (what, changes) => {
      beginGesture(label(what));
      write(track.id, changes);
      endGesture();
    },
  };
}

// ---- reading the patch -------------------------------------------------------------------------------------

/** A patch's value at a key. */
function valueAt(p: PrismPatch, key: string): number {
  const k = prismKey(key);
  if (!k) return 0;
  const field = (o: unknown) => Number((o as Record<string, number>)[k.field] ?? 0);
  switch (k.part) {
    case 'src':
      return field(p.src[k.index]);
    case 'flt':
      return k.index < 0 ? p.serial : field(p.flt[k.index]);
    case 'xy':
      return field(p.xy);
    case 'amp':
      return field(p.amp);
    case 'voice':
      return field(p.voice);
    case 'lfo':
      return field(p.lfo[k.index]);
    case 'env':
      return field(p.env[k.index]);
    case 'shape':
    case 'curve': {
      const s = (k.part === 'shape' ? p.shape : p.curve)[k.index] as unknown as Record<string, number | Float64Array>;
      const v = s[k.field];
      return typeof v === 'number' ? v : Number(v?.[k.sub] ?? 0);
    }
    case 'seq': {
      const s = p.seq[k.index];
      if (!s) return 0;
      if (k.sub < 0) return field(s);
      return Number((k.field === 'v' ? s.v : s.t)[k.sub] ?? 0);
    }
    case 'ctl':
      return p.ctl[k.index] ?? 0;
    case 'mod':
      return field(p.mod[k.index]);
    case 'fx':
      return Number(p.fx[k.index]?.[k.field] ?? 0);
    default:
      return 0;
  }
}

// ---- a setting as a knob, a choice or a switch ------------------------------------------------------------------

interface Field {
  key: string;
  name: string;
  unit?: string;
  scale?: 'lin' | 'log';
  /** The knob shows the value times this (a pan of ±1 as ±100). */
  k?: number;
  options?: readonly string[];
  min?: number;
  max?: number;
  step?: number;
}

function defOf(f: Field, base: number): ParamDef {
  const key = prismKey(f.key);
  const k = f.k ?? 1;
  const lo = f.min ?? (key ? key.min * k : 0);
  const hi = f.max ?? (key ? key.max * k : 1);
  return {
    id: f.key,
    name: f.name,
    min: Math.min(lo, hi),
    max: Math.max(lo, hi),
    default: base * k,
    unit: f.unit,
    scale: f.scale,
    step: f.step,
    options: f.options ? [...f.options] : undefined,
  };
}

function Settings({
  fields,
  p,
  base,
  w,
  color,
}: {
  fields: Field[];
  p: PrismPatch;
  base: PrismPatch;
  w: Writer;
  color?: string;
}) {
  return (
    <div className="face prism-face">
      {fields.map((f) => {
        const k = f.k ?? 1;
        return (
          <Setting
            key={f.key}
            def={defOf(f, valueAt(base, f.key))}
            value={valueAt(p, f.key) * k}
            size={40}
            color={color}
            onBegin={() => w.begin(f.name)}
            onEnd={w.end}
            onChange={(v) => w.live({ [f.key]: v / k })}
          />
        );
      })}
    </div>
  );
}

function Choice({
  name,
  options,
  value,
  onPick,
}: {
  name: string;
  options: readonly string[];
  value: number;
  onPick: (i: number) => void;
}) {
  const at = Math.round(value);
  // (names too long for a knob's width take two)
  const wide = options.some((o) => o.length > 8);
  return (
    <div className={`knob choice${wide ? ' wide' : ''}`}>
      <button
        type="button"
        className="btn choice-menu"
        aria-haspopup="menu"
        aria-label={`${name}: ${options[at] ?? at}`}
        onClick={(e) =>
          openMenuAt(
            e.currentTarget,
            options.map((label, i) => ({
              label,
              checked: i === at,
              focus: i === at,
              onSelect: () => i !== at && onPick(i),
            })),
          )
        }
      >
        <span className="grow">{options[at] ?? at}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      <span className="knob-label">{name}</span>
    </div>
  );
}

function Switch({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={`btn${on ? ' on' : ''}`} aria-pressed={on} onClick={onToggle}>
      {label}
    </button>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="prism-section">
      <div className="prism-section-head">
        <span className="label">{title}</span>
        {aside}
      </div>
      {children}
    </section>
  );
}

// ---- the waveforms and recordings drawn (made once, kept) ---------------------------------------------------------

const customs = new Map<string, Mips>();
function waveTable(p: PrismPatch, s: number): Float32Array {
  const sp = p.src[s];
  if (sp && sp.custom > 0) {
    const m = p.waves[sp.custom - 1];
    const pts: number[] = [];
    for (let i = 0; m?.has(i); i++) pts.push(m.get(i) as number);
    if (pts.length >= 4) {
      const key = pts.join(',');
      let mips = customs.get(key);
      if (!mips) {
        mips = customWave(pts);
        customs.set(key, mips);
      }
      return mips[2] as Float32Array;
    }
  }
  // (a few octaves down the band limits: the look of the wave without its finest ripple)
  return builtInWave(sp?.wave ?? 2)[2] as Float32Array;
}

const overviews = new Map<number, Float32Array>();
/** A built-in recording's outline: its peak in each of 240 columns. */
function recordingOutline(i: number): Float32Array {
  let o = overviews.get(i);
  if (!o) {
    const rec = builtInRecording(i);
    const x = rec.left;
    const n = 240;
    o = new Float32Array(n);
    let top = 0;
    for (let c = 0; c < n; c++) {
      let m = 0;
      const a = Math.floor((c * x.length) / n);
      const b = Math.floor(((c + 1) * x.length) / n);
      for (let j = a; j < b; j += 4) m = Math.max(m, Math.abs(x[j] as number));
      o[c] = m;
      top = Math.max(top, m);
    }
    if (top > 0) for (let c = 0; c < n; c++) o[c] = (o[c] as number) / top;
    overviews.set(i, o);
  }
  return o;
}

/** A built-in partial set's levels and ratios at a share of its length. */
function partialsAt(set: number, at: number): { ratio: number; amp: number }[] {
  const s = builtInPartials(set);
  const t = at * s.length;
  return s.partials.map((part) => {
    const n = part.t.length;
    let i = 0;
    while (i < n - 2 && (part.t[i + 1] as number) <= t) i++;
    const t0 = part.t[i] as number;
    const t1 = (part.t[i + 1] ?? t0) as number;
    const u = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
    const amp = (part.amp[i] as number) + (((part.amp[i + 1] ?? part.amp[i]) as number) - (part.amp[i] as number)) * u;
    return { ratio: part.ratio[i] as number, amp };
  });
}

// ---- the overview: four tiles around the morph pad ----------------------------------------------------------------

function drawOverview(ctx: CanvasRenderingContext2D, L: OverviewLayout, p: PrismPatch, sel: number, media: number) {
  ctx.clearRect(0, 0, L.w, L.h);
  const weights = p.xy.on ? padWeights(p.xy.x, p.xy.y, p.xy.power >= 0.5) : [1, 1, 1, 1];
  const maxW = Math.max(...weights, 1e-6);
  for (let s = 0; s < PRISM_SOURCES; s++) {
    const t = L.tiles[s] as OverviewLayout['tiles'][number];
    const sp = p.src[s];
    const on = !!sp?.on;
    const color = SOURCE_COLORS[s] as string;
    const lit = on ? 0.35 + 0.65 * ((weights[s] as number) / maxW) : 0;
    roundRect(ctx, t.x + 0.5, t.y + 0.5, t.w - 1, t.h - 1, 7);
    const g = ctx.createLinearGradient(t.x, t.y, t.x, t.y + t.h);
    g.addColorStop(0, alpha(color, 0.05 + 0.13 * lit));
    g.addColorStop(1, alpha(color, 0.02 + 0.05 * lit));
    ctx.fillStyle = LCD;
    ctx.fill();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = s === sel ? color : alpha(color, on ? 0.25 + 0.4 * lit : 0.15);
    ctx.lineWidth = s === sel ? 1.5 : 1;
    ctx.stroke();
    ctx.font = LABEL_FONT;
    ctx.textBaseline = 'top';
    ctx.fillStyle = on ? color : TEXT_3;
    ctx.fillText(`${s + 1}`, t.x + 8, t.y + 7);
    ctx.fillStyle = on ? TEXT : TEXT_3;
    ctx.font = SMALL_FONT;
    const summary = sourceSummary(p, s, media);
    ctx.fillText(summary.length > 34 ? `${summary.slice(0, 33)}…` : summary, t.x + 22, t.y + 7.5);
    if (!on || !sp) continue;
    // its level, along the right edge
    const lv = Math.min(1, sp.level / 2);
    ctx.fillStyle = alpha(color, 0.8);
    ctx.fillRect(t.x + t.w - 6, t.y + t.h - 6 - (t.h - 26) * lv, 2, (t.h - 26) * lv);
    const box = { x: t.x + 10, y: t.y + 24, w: t.w - 24, h: t.h - 32 };
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    ctx.strokeStyle = alpha(color, 0.35 + 0.6 * lit);
    ctx.fillStyle = alpha(color, 0.18 + 0.4 * lit);
    ctx.lineWidth = 1.4;
    if (sp.kind === 0) drawOscillators(ctx, box, p, s);
    else if (sp.kind === 1) drawPartials(ctx, box, p, s);
    else drawRecording(ctx, box, p, s);
    ctx.restore();
  }
  drawPad(ctx, L, p, weights);
}

type Box = { x: number; y: number; w: number; h: number };

/** A cycle of the waveform over the top two thirds, the oscillators' spread as bars along the bottom. */
function drawOscillators(ctx: CanvasRenderingContext2D, b: Box, p: PrismPatch, s: number) {
  const sp = p.src[s] as PrismPatch['src'][number];
  const t = waveTable(p, s);
  const wh = b.h * 0.62;
  const mid = b.y + wh / 2;
  let peak = 0;
  for (let i = 0; i < TABLE; i += 8) peak = Math.max(peak, Math.abs(t[i] as number));
  const k = peak > 0 ? (wh / 2 - 2) / peak : 0;
  ctx.beginPath();
  for (let i = 0; i <= 96; i++) {
    const x = b.x + (i / 96) * b.w * 0.55;
    const v = t[Math.floor((i / 96) * (TABLE - 1))] as number;
    if (i) ctx.lineTo(x, mid - v * k);
    else ctx.moveTo(x, mid - v * k);
  }
  ctx.stroke();
  // the spread: each oscillator a bar, where its frequency sits (octaves above the note), as loud as it is
  const n = Math.min(64, Math.ceil(sp.count));
  const bx = b.x + b.w * 0.6;
  const bw = b.w * 0.4;
  const by = b.y + b.h;
  const bh = b.h - 4;
  for (let i = 0; i < n; i++) {
    const ratio =
      pitchSpread(sp.pitcha, i, sp.detune) * (1 - sp.pitch) + pitchSpread(sp.pitchb, i, sp.detune) * sp.pitch;
    let amp = ampSpread(sp.ampa, i) * (1 - sp.amp) + ampSpread(sp.ampb, i) * sp.amp;
    if (i === n - 1 && sp.count < n) amp *= sp.count - (n - 1);
    const x = bx + Math.min(1, Math.max(0, Math.log2(Math.max(ratio, 0.25)) / 6 + 0.04)) * bw;
    ctx.fillRect(x - 1, by - bh * Math.min(1, amp), 2, bh * Math.min(1, amp));
  }
}

/** How loud a built-in partial set is over its length (240 points, its loudest 1), and when it's loudest. */
const outlines = new Map<number, { level: Float32Array; peak: number }>();
function partialOutline(set: number): { level: Float32Array; peak: number } {
  let o = outlines.get(set);
  if (!o) {
    const n = 240;
    const level = new Float32Array(n);
    let top = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const v = partialsAt(set, i / (n - 1)).reduce((sum, x) => sum + x.amp, 0);
      level[i] = v;
      if (v > top) {
        top = v;
        peak = i / (n - 1);
      }
    }
    if (top > 0) for (let i = 0; i < n; i++) level[i] = (level[i] as number) / top;
    o = { level, peak };
    outlines.set(set, o);
  }
  return o;
}

/** Partials: how loud the sound is along its length (faint), and its partials as bars where it plays from. */
function drawPartials(ctx: CanvasRenderingContext2D, b: Box, p: PrismPatch, s: number) {
  const sp = p.src[s] as PrismPatch['src'][number];
  if (sp.data === 0) {
    drawPackNote(ctx, b);
    return;
  }
  const { level, peak } = partialOutline(sp.data - 1);
  const fill = ctx.fillStyle;
  ctx.fillStyle = alpha(TEXT, 0.07);
  ctx.beginPath();
  ctx.moveTo(b.x, b.y + b.h);
  for (let i = 0; i < level.length; i++)
    ctx.lineTo(b.x + (i / (level.length - 1)) * b.w, b.y + b.h - (level[i] as number) * b.h);
  ctx.lineTo(b.x + b.w, b.y + b.h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = fill;
  // (where it starts, or, starting silent, its loudest moment)
  const at = (level[Math.round(sp.pos * (level.length - 1))] as number) > 0.05 ? sp.pos : peak;
  const parts = partialsAt(sp.data - 1, at).slice(0, Math.ceil(sp.partials));
  const top = Math.max(...parts.map((x) => x.amp), 1e-6);
  for (const part of parts) {
    // levels in decibels over 60 dB, frequencies in octaves over six
    const x = b.x + Math.min(1, Math.max(0, Math.log2(Math.max(part.ratio, 0.25) * 2) / 6)) * b.w;
    const db = 20 * Math.log10(Math.max(part.amp / top, 1e-6));
    const h = Math.max(0, 1 + db / 60) * (b.h - 2);
    ctx.fillRect(x - 1, b.y + b.h - h, 2, h);
  }
}

function drawRecording(ctx: CanvasRenderingContext2D, b: Box, p: PrismPatch, s: number) {
  const sp = p.src[s] as PrismPatch['src'][number];
  if (sp.data === 0) {
    drawPackNote(ctx, b);
    return;
  }
  const o = recordingOutline(sp.data - 1);
  const mid = b.y + b.h / 2;
  ctx.beginPath();
  for (let c = 0; c < o.length; c++) {
    const x = b.x + (c / (o.length - 1)) * b.w;
    const y = mid - (o[c] as number) * (b.h / 2 - 1);
    if (c) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  for (let c = o.length - 1; c >= 0; c--)
    ctx.lineTo(b.x + (c / (o.length - 1)) * b.w, mid + (o[c] as number) * (b.h / 2 - 1));
  ctx.closePath();
  ctx.fill();
  // where it starts, and for grains how long one lasts
  const x = b.x + sp.pos * b.w;
  ctx.fillStyle = TEXT;
  ctx.fillRect(x, b.y, 1, b.h);
  if (sp.kind === 3) {
    const len = builtInRecording(sp.data - 1).left.length / 48000;
    ctx.fillStyle = alpha(TEXT, 0.18);
    ctx.fillRect(x, b.y, Math.max(2, (sp.size / len) * b.w), b.h);
  }
}

function drawPackNote(ctx: CanvasRenderingContext2D, b: Box) {
  ctx.fillStyle = TEXT_3;
  ctx.font = SMALL_FONT;
  ctx.textBaseline = 'middle';
  ctx.fillText("the pack instrument's own data", b.x, b.y + b.h / 2);
}

function drawPad(ctx: CanvasRenderingContext2D, L: OverviewLayout, p: PrismPatch, weights: number[]) {
  const { x, y, s } = L.pad;
  roundRect(ctx, x + 0.5, y + 0.5, s - 1, s - 1, 9);
  ctx.fillStyle = LCD;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // a fine grid, and each corner glowing by how much it's heard
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo(x + (s * i) / 4, y + 6);
    ctx.lineTo(x + (s * i) / 4, y + s - 6);
    ctx.moveTo(x + 6, y + (s * i) / 4);
    ctx.lineTo(x + s - 6, y + (s * i) / 4);
    ctx.stroke();
  }
  const corners: [number, number][] = [
    [x, y],
    [x + s, y],
    [x, y + s],
    [x + s, y + s],
  ];
  const on = p.xy.on >= 0.5;
  corners.forEach(([cx, cy], i) => {
    if (!p.src[i]?.on) return;
    const r = s * (0.18 + 0.5 * (on ? (weights[i] as number) : 0.25));
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, alpha(SOURCE_COLORS[i] as string, 0.5));
    g.addColorStop(1, alpha(SOURCE_COLORS[i] as string, 0));
    ctx.save();
    roundRect(ctx, x + 1, y + 1, s - 2, s - 2, 9);
    ctx.clip();
    ctx.fillStyle = g;
    ctx.fillRect(x, y, s, s);
    ctx.restore();
    ctx.fillStyle = SOURCE_COLORS[i] as string;
    ctx.font = LABEL_FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = i % 2 ? 'right' : 'left';
    ctx.fillText(`${i + 1}`, cx + (i % 2 ? -8 : 8), cy + (i < 2 ? 10 : -10));
    ctx.textAlign = 'left';
  });
  if (!on) {
    ctx.fillStyle = TEXT_3;
    ctx.font = SMALL_FONT;
    ctx.textAlign = 'center';
    ctx.fillText('every source at its own level', x + s / 2, y + s / 2);
    ctx.textAlign = 'left';
    return;
  }
  const px = x + p.xy.x * s;
  const py = y + p.xy.y * s;
  const glow = ctx.createRadialGradient(px, py, 0, px, py, 16);
  glow.addColorStop(0, 'rgba(255,255,255,0.55)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(px - 16, py - 16, 32, 32);
  ctx.beginPath();
  ctx.arc(px, py, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

function Overview({
  p,
  width,
  sel,
  media,
  w,
  onSource,
}: {
  p: PrismPatch;
  width: number;
  sel: number;
  media: number;
  w: Writer;
  onSource: (s: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const L = useMemo(() => overviewLayout(width), [width]);
  useLayoutEffect(() => {
    const ctx = prepare(ref.current, L.w, L.h, false);
    if (ctx) drawOverview(ctx, L, p, sel, media);
  }, [L, p, sel, media]);
  const at = (e: { clientX: number; clientY: number; currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect();
    return hitOverview(L, e.clientX - r.left, e.clientY - r.top);
  };
  const xy = p.xy.on >= 0.5;
  return (
    <canvas
      ref={ref}
      className="prism-overview"
      role="img"
      aria-label={`The four sources around the morph pad. ${[0, 1, 2, 3].map((s) => `Source ${s + 1}: ${sourceSummary(p, s, media)}`).join('. ')}.`}
      style={{ display: 'block', width: L.w, height: L.h, touchAction: 'none' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const hit = at(e);
        if (!hit) return;
        if ('tile' in hit) {
          onSource(hit.tile);
          return;
        }
        if (!xy) return;
        const r = e.currentTarget.getBoundingClientRect();
        const move = (cx: number, cy: number) => {
          const nx = Math.min(1, Math.max(0, (cx - r.left - L.pad.x) / L.pad.s));
          const ny = Math.min(1, Math.max(0, (cy - r.top - L.pad.y) / L.pad.s));
          w.live({ 'xy:x': nx, 'xy:y': ny });
        };
        w.begin('Morph');
        move(e.clientX, e.clientY);
        let x = e.clientX;
        let y = e.clientY;
        startDrag(e, {
          onMove: (dx, dy, ev) => {
            const fine = ev.shiftKey ? 0.25 : 1;
            x += dx * fine;
            y += dy * fine;
            move(x, y);
          },
          onEnd: () => w.end(),
        });
      }}
    />
  );
}

// ---- the window ---------------------------------------------------------------------------------------------------

export function PrismWindow({
  track,
  inst,
  pack,
}: {
  track: Track;
  inst: SynthInstrument | SamplerInstrument;
  pack?: PrismPack;
}) {
  const layout = useLayout();
  const phone = isPhone(layout);
  const vp = useViewport();
  const [page, setPage] = useState<Page | null>(remembered);
  const [sel, setSel] = useState(0);
  const params = inst.params;
  const preset = pack ? pack.synth : inst.type === 'synth' ? inst.preset : '';
  const start = useMemo(() => (pack ? { 'patch:blank': 1, ...pack.params } : undefined), [pack]);
  const patch = useMemo(() => prismPatch(preset, { ...start, ...params }), [preset, start, params]);
  const blank = (params?.['patch:blank'] ?? 0) >= 0.5;
  const base = useMemo(
    () => prismPatch(preset, start ?? (blank ? { 'patch:blank': 1 } : undefined)),
    [preset, start, blank],
  );
  const title = pack ? (inst.type === 'sampler' ? inst.name : preset) : preset;
  const w = useMemo(() => writerFor(track, title), [track, title]);
  const defs: ParamDef[] = pack
    ? PRISM_MACRO_IDS.map((id, i) => ({ id, name: `Macro ${i + 1}`, min: 0, max: 1, default: 0.5 }))
    : (SYNTH_MACROS[preset] ?? []);
  const width = phone ? vp.w : Math.min(WIDTH, vp.w - 16);
  const inner = width - 28;
  const close = () => store.set({ synth: null });
  const open = (next: Page | null) => {
    setPage(next);
    remember(next);
  };
  const reset = () => {
    if (inst.type === 'synth') updateTrack(track.id, { instrument: { type: 'synth', preset } }, 'Reset');
    else updateTrack(track.id, { instrument: { type: 'sampler', pack: inst.pack, name: inst.name } }, 'Reset');
  };
  const media = pack?.zones ?? 0;
  return (
    <Floating
      key={track.id}
      width={width}
      phone={phone}
      className="prism-window"
      label={title}
      onClose={close}
      header={
        <>
          <span className="name">{title}</span>
          <span className="muted">{track.name}</span>
          <button
            type="button"
            className="btn ghost icon"
            title="Back to the sound's own settings"
            aria-label="Back to the sound's own settings"
            disabled={!inst.params}
            onClick={reset}
          >
            <RotateCcw />
          </button>
          <button type="button" className="btn ghost icon" title="Close" aria-label="Close" onClick={close}>
            <X />
          </button>
        </>
      }
    >
      <div className="prism-macros">
        {defs.map((d) => (
          <Setting
            key={d.id}
            def={d}
            value={pack ? (params?.[d.id] ?? 0.5) : macroValue(preset, params, d.id)}
            size={phone ? 50 : 56}
            onBegin={() => w.begin(d.name)}
            onEnd={w.end}
            onChange={(v) => w.live({ [d.id]: v })}
          />
        ))}
      </div>
      <div className="display prism-display">
        <Overview
          p={patch}
          width={inner - 2}
          sel={page === 'source' ? sel : -1}
          media={media}
          w={w}
          onSource={(s) => {
            setSel(s);
            open('source');
          }}
        />
      </div>
      <div className="prism-tabs">
        <div className="seg" role="tablist" aria-label="The patch">
          {(
            [
              ['source', `Source ${sel + 1}`],
              ['mods', 'Modulators'],
              ['matrix', 'Matrix'],
              ['more', 'Filters · Effects'],
            ] as const
          ).map(([id, name]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={page === id}
              className={`btn${page === id ? ' on' : ''}`}
              title={page === id ? 'Close the page' : undefined}
              onClick={() => open(page === id ? null : id)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      {page === 'source' && <SourcePage p={patch} base={base} s={sel} onSource={setSel} w={w} media={media} />}
      {page === 'mods' && <ModsPage p={patch} base={base} w={w} width={inner} />}
      {page === 'matrix' && <MatrixPage p={patch} w={w} width={inner} />}
      {page === 'more' && <MorePage p={patch} base={base} w={w} />}
      {!page && (
        <div className="muted plugin-note">
          {pack ? 'A whole patch from a pack, with its own partials and samples.' : SYNTH_NOTES[preset]}
        </div>
      )}
    </Floating>
  );
}

// ---- a source --------------------------------------------------------------------------------------------------

function SourcePage({
  p,
  base,
  s,
  onSource,
  w,
  media,
}: {
  p: PrismPatch;
  base: PrismPatch;
  s: number;
  onSource: (s: number) => void;
  w: Writer;
  media: number;
}) {
  const sp = p.src[s] as PrismPatch['src'][number];
  const n = s + 1;
  const key = (f: string) => `s${n}:${f}`;
  const color = SOURCE_COLORS[s];
  const on = sp.on >= 0.5;
  const common: Field[] = [
    { key: key('level'), name: 'Level', min: 0, max: 4 },
    { key: key('pan'), name: 'Pan', k: 100 },
    { key: key('coarse'), name: 'Coarse', unit: 'st', step: 1 },
    { key: key('fine'), name: 'Fine', unit: 'ct' },
  ];
  const byKind: Field[][] = [
    [
      { key: key('count'), name: 'Oscillators', step: 1, min: 1, max: 64 },
      { key: key('detune'), name: 'Detune', unit: 'ct' },
      { key: key('amp'), name: 'Amp spread', k: 100, unit: '%' },
      { key: key('pitch'), name: 'Pitch spread', k: 100, unit: '%' },
      { key: key('panmix'), name: 'Pan spread', k: 100, unit: '%' },
      { key: key('width'), name: 'Width', k: 100, unit: '%' },
      { key: key('sym'), name: 'Symmetry', k: 100, unit: '%' },
    ],
    [
      { key: key('pos'), name: 'Position', k: 100, unit: '%' },
      { key: key('speed'), name: 'Speed', unit: '×' },
      { key: key('partials'), name: 'Partials', step: 1, min: 1, max: 128 },
      { key: key('amp'), name: 'Amp spread', k: 100, unit: '%' },
    ],
    [{ key: key('pos'), name: 'Start', k: 100, unit: '%' }],
    [
      { key: key('pos'), name: 'Position', k: 100, unit: '%' },
      { key: key('speed'), name: 'Speed', unit: '×' },
      { key: key('size'), name: 'Grain', unit: 's', scale: 'log' },
      { key: key('density'), name: 'Density', step: 1 },
      { key: key('jitter'), name: 'Jitter', k: 100, unit: '%' },
      { key: key('spray'), name: 'Spray', k: 100, unit: '%' },
    ],
  ];
  const dataNames =
    sp.kind === 1 ? ['From the pack', ...PRISM_PARTIAL_SETS] : sp.kind >= 2 ? ['From the pack', ...PRISM_SAMPLES] : [];
  return (
    <div className="prism-page">
      <div className="prism-sources" role="tablist" aria-label="Sources">
        {[0, 1, 2, 3].map((i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === s}
            className={`prism-source${i === s ? ' on' : ''}${p.src[i]?.on ? '' : ' off'}`}
            style={{ '--src': SOURCE_COLORS[i] } as CSSProperties}
            onClick={() => onSource(i)}
          >
            <span className="prism-source-n">{i + 1}</span>
            <span className="prism-source-what">{sourceSummary(p, i, media)}</span>
          </button>
        ))}
      </div>
      <Section
        title={`Source ${n}`}
        aside={
          <div className="prism-switches">
            <Switch
              label={on ? 'On' : 'Off'}
              on={on}
              onToggle={() => w.once(on ? 'off' : 'on', { [key('on')]: on ? 0 : 1 })}
            />
            {on && (
              <Switch
                label="Stereo"
                on={sp.stereo >= 0.5}
                onToggle={() => w.once('stereo', { [key('stereo')]: sp.stereo >= 0.5 ? 0 : 1 })}
              />
            )}
          </div>
        }
      >
        {on && (
          <div className="face prism-face">
            <Choice
              name="Kind"
              options={PRISM_KINDS}
              value={sp.kind}
              onPick={(i) => w.once('kind', { [key('kind')]: i })}
            />
            {sp.kind === 0 && (
              <Choice
                name="Wave"
                options={PRISM_WAVES}
                value={sp.wave}
                onPick={(i) => w.once('wave', { [key('wave')]: i, [key('custom')]: 0 })}
              />
            )}
            {sp.kind >= 1 && (
              <Choice
                name="Data"
                options={dataNames}
                value={sp.data}
                onPick={(i) => w.once('data', { [key('data')]: i })}
              />
            )}
            {sp.kind >= 1 && (
              <Choice
                name="Loop"
                options={PRISM_LOOPS}
                value={sp.loop}
                onPick={(i) => w.once('loop', { [key('loop')]: i })}
              />
            )}
          </div>
        )}
        {on && <Settings fields={[...common, ...(byKind[sp.kind] ?? [])]} p={p} base={base} w={w} color={color} />}
      </Section>
      {on && sp.kind <= 1 && (
        <Section title="Spreads">
          <div className="face prism-face">
            <Choice
              name="Amp A"
              options={PRISM_AMP_SPREADS}
              value={sp.ampa}
              onPick={(i) => w.once('spread', { [key('ampa')]: i })}
            />
            <Choice
              name="Amp B"
              options={PRISM_AMP_SPREADS}
              value={sp.ampb}
              onPick={(i) => w.once('spread', { [key('ampb')]: i })}
            />
            {sp.kind === 0 && (
              <>
                <Choice
                  name="Pitch A"
                  options={PRISM_PITCH_SPREADS}
                  value={sp.pitcha}
                  onPick={(i) => w.once('spread', { [key('pitcha')]: i })}
                />
                <Choice
                  name="Pitch B"
                  options={PRISM_PITCH_SPREADS}
                  value={sp.pitchb}
                  onPick={(i) => w.once('spread', { [key('pitchb')]: i })}
                />
              </>
            )}
            <Choice
              name="Pan A"
              options={PRISM_PAN_SPREADS}
              value={sp.pana}
              onPick={(i) => w.once('spread', { [key('pana')]: i })}
            />
            <Choice
              name="Pan B"
              options={PRISM_PAN_SPREADS}
              value={sp.panb}
              onPick={(i) => w.once('spread', { [key('panb')]: i })}
            />
          </div>
        </Section>
      )}
      {on && (
        <Section title="Its filter">
          <div className="face prism-face">
            <Choice
              name="Type"
              options={['None', ...PRISM_FILTERS]}
              value={sp.ftype}
              onPick={(i) => w.once('filter', { [key('ftype')]: i })}
            />
          </div>
          {sp.ftype > 0 && (
            <Settings
              fields={[
                { key: key('cutoff'), name: 'Cutoff', unit: 'Hz', scale: 'log' },
                { key: key('res'), name: 'Resonance', k: 100, unit: '%' },
                { key: key('route'), name: 'To filter 2', k: 100, unit: '%' },
              ]}
              p={p}
              base={base}
              w={w}
              color={color}
            />
          )}
        </Section>
      )}
    </div>
  );
}

// ---- the modulators ---------------------------------------------------------------------------------------------

const FAMILIES: { id: Family; name: string; count: number; first: number; color: string }[] = [
  { id: 'lfo', name: 'LFOs', count: PRISM_LFOS, first: SRC_LFO, color: MOD_COLORS.lfo },
  { id: 'env', name: 'Envelopes', count: PRISM_ENVS, first: SRC_ENV, color: MOD_COLORS.env },
  { id: 'shape', name: 'Shapes', count: PRISM_SHAPES, first: SRC_SHAPE, color: MOD_COLORS.shape },
  { id: 'seq', name: 'Steps', count: PRISM_SEQS, first: SRC_SEQ, color: MOD_COLORS.seq },
];

/** Which matrix sources the links use (lit in the chooser). */
function usedSources(p: PrismPatch): Set<number> {
  const out = new Set<number>();
  for (const m of p.mod) {
    if (m.src > 0) out.add(m.src);
    if (m.via > 0) out.add(m.via);
  }
  return out;
}

function drawMod(
  ctx: CanvasRenderingContext2D,
  wd: number,
  ht: number,
  p: PrismPatch,
  fam: Family,
  i: number,
  color: string,
) {
  ctx.clearRect(0, 0, wd, ht);
  roundRect(ctx, 0.5, 0.5, wd - 1, ht - 1, 8);
  ctx.fillStyle = LCD;
  ctx.fill();
  const pad = 12;
  // (a line of words along the top, the drawing under it)
  const top = 26;
  const W = wd - pad * 2;
  const H = ht - top - pad;
  ctx.save();
  ctx.translate(0, top - pad);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let k = 1; k < 4; k++) {
    ctx.beginPath();
    ctx.moveTo(pad, pad + (H * k) / 4);
    ctx.lineTo(pad + W, pad + (H * k) / 4);
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  const fill = (pts: [number, number][]) => {
    ctx.beginPath();
    pts.forEach(([x, y], k) => {
      if (k) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.lineTo(pts[pts.length - 1]?.[0] ?? 0, pad + H);
    ctx.lineTo(pts[0]?.[0] ?? 0, pad + H);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, pad, 0, pad + H);
    g.addColorStop(0, alpha(color, 0.28));
    g.addColorStop(1, alpha(color, 0.02));
    ctx.fillStyle = g;
    ctx.fill();
  };
  ctx.font = SMALL_FONT;
  ctx.fillStyle = TEXT_2;
  ctx.textBaseline = 'top';
  if (fam === 'lfo') {
    const l = p.lfo[i] as PrismPatch['lfo'][number];
    const m = l.custom > 0 ? p.lshapes[l.custom - 1] : null;
    const pts: number[] = [];
    for (let k = 0; m?.has(k); k++) pts.push(m.get(k) as number);
    const ys = lfoPoints(l.shape, pts.length >= 2 ? pts : null, 2, 240);
    const bip = l.bipolar >= 0.5;
    const pp = ys.map((v, k): [number, number] => [
      pad + (k / (ys.length - 1)) * W,
      bip ? pad + H / 2 - (v * H) / 2 : pad + H - ((v + 1) / 2) * H,
    ]);
    fill(pp);
    const rate = l.sync >= 0.5 ? `a cycle every ${beatsName(l.beats)}` : `${l.rate.toFixed(l.rate < 1 ? 2 : 1)} Hz`;
    ctx.fillText(`${rate} · ${PRISM_LFO_MODES[l.mode] ?? ''}${bip ? ' · either way' : ''}`, pad, pad - top + 7);
  } else if (fam === 'env') {
    const e = p.env[i] as PrismPatch['env'][number];
    const held = Math.max(0.15, (e.a + e.h + e.d + e.r) * 0.35);
    const pts = envPoints(e, held);
    const total = pts[pts.length - 1]?.[0] || 1;
    fill(pts.map(([t, v]): [number, number] => [pad + (t / total) * W, pad + H - v * H]));
    ctx.fillText(
      `A ${secs(e.a)} · H ${secs(e.h)} · D ${secs(e.d)} · S ${Math.round(e.s * 100)}% · R ${secs(e.r)}`,
      pad,
      pad - top + 7,
    );
  } else if (fam === 'shape') {
    const s = p.shape[i] as PrismPatch['shape'][number];
    const total = Math.max(1e-3, s.x[s.n - 1] ?? 1);
    if (s.loop > 0) {
      const a = pad + ((s.x[Math.round(s.ls)] ?? 0) / total) * W;
      const b = pad + ((s.x[Math.round(s.le)] ?? total) / total) * W;
      ctx.fillStyle = alpha(color, 0.08);
      ctx.fillRect(a, pad, b - a, H);
      ctx.fillStyle = TEXT_2;
    }
    const pts = shapePoints(s.x, s.y, s.c, s.n).map(([x, y]): [number, number] => [
      pad + (x / total) * W,
      pad + H - y * H,
    ]);
    fill(pts);
    ctx.fillStyle = '#ffffff';
    for (let k = 0; k < s.n; k++) {
      ctx.beginPath();
      ctx.arc(pad + ((s.x[k] as number) / total) * W, pad + H - (s.y[k] as number) * H, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = TEXT_2;
    ctx.fillText(
      `${s.n} points · ${PRISM_SHAPE_LOOPS[s.loop] ?? ''}${s.sync ? ' · quarter notes' : ' · seconds'}`,
      pad,
      pad - top + 7,
    );
  } else {
    const q = p.seq[i] as PrismPatch['seq'][number];
    const n = Math.max(1, Math.round(q.steps));
    const bw = W / n;
    for (let k = 0; k < n; k++) {
      const v = q.v[k] as number;
      const tied = (q.t[k] as number) >= 0.5;
      ctx.fillStyle = alpha(color, 0.25 + 0.6 * v);
      roundRect(ctx, pad + k * bw + 1.5, pad + H - v * H, (tied ? bw : bw - 3) + 0.01, v * H, 2);
      ctx.fill();
    }
    ctx.fillStyle = TEXT_2;
    ctx.fillText(`${n} steps, each a ${beatsName(q.beats)}`, pad, pad - top + 7);
  }
  ctx.restore();
}

const secs = (t: number) => (t >= 1 ? `${t.toFixed(t >= 10 ? 0 : 1)} s` : `${Math.round(t * 1000)} ms`);

/** Quarter notes in musical words (a quarter, an eighth, two bars). */
function beatsName(b: number): string {
  const names: [number, string][] = [
    [16, '4 bars'],
    [8, '2 bars'],
    [4, 'bar'],
    [3, 'dotted half note'],
    [2, 'half note'],
    [1.5, 'dotted quarter note'],
    [1, 'quarter note'],
    [2 / 3, 'quarter-note triplet'],
    [0.75, 'dotted eighth note'],
    [0.5, 'eighth note'],
    [1 / 3, 'eighth-note triplet'],
    [0.25, 'sixteenth note'],
    [1 / 6, 'sixteenth-note triplet'],
    [0.125, 'thirty-second note'],
  ];
  for (const [v, n] of names) if (Math.abs(v - b) < 1e-3) return n;
  return `${+b.toFixed(3)} quarter notes`;
}

function ModView({
  p,
  w,
  fam,
  i,
  width,
  color,
}: {
  p: PrismPatch;
  w: Writer;
  fam: Family;
  i: number;
  width: number;
  color: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const h = 140;
  useLayoutEffect(() => {
    const ctx = prepare(ref.current, width, h, false);
    if (ctx) drawMod(ctx, width, h, p, fam, i, color);
  }, [p, fam, i, width, color]);
  const pad = 12;
  /** Steps: a press or a drag sets each step's value where the pointer is. Shapes: a point is dragged. */
  const press = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const b = e.currentTarget.getBoundingClientRect();
    // (as drawn: a line of words along the top, the drawing under it)
    const r = { left: b.left, top: b.top + 26 - pad };
    const W = width - pad * 2;
    const H = h - 26 - pad;
    if (fam === 'seq') {
      const q = p.seq[i] as PrismPatch['seq'][number];
      const n = Math.max(1, Math.round(q.steps));
      const set = (cx: number, cy: number) => {
        const k = Math.floor(((cx - r.left - pad) / W) * n);
        if (k < 0 || k >= n) return;
        const v = Math.min(1, Math.max(0, 1 - (cy - r.top - pad) / H));
        w.live({ [`seq${i + 1}:v${k}`]: v });
      };
      w.begin('steps');
      set(e.clientX, e.clientY);
      let x = e.clientX;
      let y = e.clientY;
      startDrag(e, {
        onMove: (dx, dy) => {
          x += dx;
          y += dy;
          set(x, y);
        },
        onEnd: () => w.end(),
      });
    } else if (fam === 'shape') {
      const s = p.shape[i] as PrismPatch['shape'][number];
      const total = Math.max(1e-3, s.x[s.n - 1] ?? 1);
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      let k = -1;
      for (let j = 0; j < s.n; j++) {
        const dx = pad + ((s.x[j] as number) / total) * W - px;
        const dy = pad + H - (s.y[j] as number) * H - py;
        if (dx * dx + dy * dy < 100) k = j;
      }
      if (k < 0) return;
      let x = s.x[k] as number as number;
      let y = s.y[k] as number;
      const lo = k > 0 ? (s.x[k - 1] as number) : 0;
      const hi = k < s.n - 1 ? (s.x[k + 1] as number) : 64;
      let moved = 0;
      startDrag(e, {
        onMove: (dx, dy) => {
          moved += Math.abs(dx) + Math.abs(dy);
          if (moved < TAP) return;
          if (moved - Math.abs(dx) - Math.abs(dy) < TAP) w.begin('shape point');
          if (k > 0) x = Math.min(hi, Math.max(lo, x + (dx / W) * total));
          y = Math.min(1, Math.max(0, y - dy / H));
          w.live({ [`shape${i + 1}:x${k}`]: x, [`shape${i + 1}:y${k}`]: y });
        },
        onEnd: () => {
          if (moved >= TAP) w.end();
        },
      });
    }
  };
  return (
    <canvas
      ref={ref}
      className="prism-mod"
      role="img"
      aria-label={`${fam} ${i + 1}`}
      style={{
        display: 'block',
        width,
        height: h,
        touchAction: 'none',
        cursor: fam === 'seq' || fam === 'shape' ? 'pointer' : 'default',
      }}
      onPointerDown={press}
    />
  );
}

function ModsPage({ p, base, w, width }: { p: PrismPatch; base: PrismPatch; w: Writer; width: number }) {
  const [fam, setFam] = useState<Family>('lfo');
  const [idx, setIdx] = useState<Record<Family, number>>({ lfo: 0, env: 0, shape: 0, seq: 0 });
  const used = usedSources(p);
  const F = FAMILIES.find((f) => f.id === fam) as (typeof FAMILIES)[number];
  const i = Math.min(F.count - 1, idx[fam]);
  const n = i + 1;
  const fields: Record<Family, Field[]> = {
    lfo: [
      (p.lfo[i]?.sync ?? 0) >= 0.5
        ? { key: `lfo${n}:beats`, name: 'Quarter notes', scale: 'log' }
        : { key: `lfo${n}:rate`, name: 'Rate', unit: 'Hz', scale: 'log' },
      { key: `lfo${n}:delay`, name: 'Delay', unit: 's' },
      { key: `lfo${n}:fade`, name: 'Fade in', unit: 's' },
      { key: `lfo${n}:phase`, name: 'Phase', k: 360, unit: '°' },
    ],
    env: [
      { key: `env${n}:a`, name: 'Attack', unit: 's', scale: 'log', min: 0.001 },
      { key: `env${n}:h`, name: 'Hold', unit: 's' },
      { key: `env${n}:d`, name: 'Decay', unit: 's', scale: 'log', min: 0.001 },
      { key: `env${n}:s`, name: 'Sustain', k: 100, unit: '%' },
      { key: `env${n}:r`, name: 'Release', unit: 's', scale: 'log', min: 0.001 },
      { key: `env${n}:ac`, name: 'Attack curve' },
      { key: `env${n}:dc`, name: 'Decay curve' },
      { key: `env${n}:rc`, name: 'Release curve' },
    ],
    shape: [],
    seq: [
      { key: `seq${n}:steps`, name: 'Steps', step: 1 },
      { key: `seq${n}:beats`, name: 'Step', scale: 'log' },
      { key: `seq${n}:swing`, name: 'Swing', k: 100, unit: '%' },
      { key: `seq${n}:attack`, name: 'Rise', k: 100, unit: '%' },
      { key: `seq${n}:gate`, name: 'Hold', k: 100, unit: '%' },
      { key: `seq${n}:release`, name: 'Fall', k: 100, unit: '%' },
    ],
  };
  const l = p.lfo[i];
  const s = p.shape[i];
  return (
    <div className="prism-page">
      <div className="prism-tabs inner">
        <div className="seg" role="tablist" aria-label="Modulators">
          {FAMILIES.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={fam === f.id}
              className={`btn${fam === f.id ? ' on' : ''}`}
              onClick={() => setFam(f.id)}
            >
              {f.name}
            </button>
          ))}
        </div>
      </div>
      <div className="prism-picks" role="tablist" aria-label={F.name}>
        {Array.from({ length: F.count }, (_, k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={k === i}
            className={`prism-pick${k === i ? ' on' : ''}${used.has(F.first + k) ? ' used' : ''}`}
            style={{ '--mod': F.color } as CSSProperties}
            title={used.has(F.first + k) ? 'In the matrix' : 'Not in the matrix'}
            onClick={() => setIdx({ ...idx, [fam]: k })}
          >
            {k + 1}
          </button>
        ))}
      </div>
      <div className="display prism-mod-display">
        <ModView p={p} w={w} fam={fam} i={i} width={width - 2} color={F.color} />
      </div>
      {fam === 'lfo' && l && (
        <div className="face prism-face">
          <Choice
            name="Shape"
            options={PRISM_LFO_SHAPES}
            value={l.shape}
            onPick={(k) => w.once('LFO shape', { [`lfo${n}:shape`]: k, [`lfo${n}:custom`]: 0 })}
          />
          <Choice
            name="Runs"
            options={PRISM_LFO_MODES}
            value={l.mode}
            onPick={(k) => w.once('LFO runs', { [`lfo${n}:mode`]: k })}
          />
          <div className="prism-switches">
            <Switch
              label="Sync"
              on={l.sync >= 0.5}
              onToggle={() => w.once('LFO sync', { [`lfo${n}:sync`]: l.sync >= 0.5 ? 0 : 1 })}
            />
            <Switch
              label="Either way"
              on={l.bipolar >= 0.5}
              onToggle={() => w.once('LFO either way', { [`lfo${n}:bipolar`]: l.bipolar >= 0.5 ? 0 : 1 })}
            />
          </div>
        </div>
      )}
      {fam === 'shape' && s && (
        <div className="face prism-face">
          <Choice
            name="Loop"
            options={PRISM_SHAPE_LOOPS}
            value={s.loop}
            onPick={(k) => w.once('shape loop', { [`shape${n}:loop`]: k })}
          />
          <div className="prism-switches">
            <Switch
              label="Sync"
              on={s.sync >= 0.5}
              onToggle={() => w.once('shape sync', { [`shape${n}:sync`]: s.sync >= 0.5 ? 0 : 1 })}
            />
          </div>
        </div>
      )}
      {fields[fam].length > 0 && <Settings fields={fields[fam]} p={p} base={base} w={w} color={F.color} />}
    </div>
  );
}

// ---- the matrix ------------------------------------------------------------------------------------------------

const ROW = 26;

function drawLinks(ctx: CanvasRenderingContext2D, wd: number, rows: LinkRow[], sel: number, hover: number) {
  const ht = Math.max(1, rows.length) * ROW + 8;
  ctx.clearRect(0, 0, wd, ht);
  roundRect(ctx, 0.5, 0.5, wd - 1, ht - 1, 8);
  ctx.fillStyle = LCD;
  ctx.fill();
  const barX = Math.round(wd * 0.58);
  const barW = Math.round(wd * 0.26);
  ctx.textBaseline = 'middle';
  if (!rows.length) {
    ctx.fillStyle = TEXT_3;
    ctx.font = SMALL_FONT;
    ctx.fillText('Nothing moves anything: add a link below.', 12, ROW / 2 + 4);
    return;
  }
  rows.forEach((r, k) => {
    const y = 4 + k * ROW;
    if (k === sel || k === hover) {
      ctx.fillStyle = k === sel ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.035)';
      ctx.fillRect(2, y, wd - 4, ROW);
    }
    ctx.fillStyle = r.color;
    roundRect(ctx, 10, y + 8, 10, 10, 3);
    ctx.fill();
    ctx.font = LABEL_FONT;
    ctx.fillStyle = TEXT;
    const text = `${r.srcName}  →  ${r.dstName}${r.via ? '  ·  depth moved' : ''}`;
    ctx.fillText(text.length > 52 ? `${text.slice(0, 51)}…` : text, 28, y + ROW / 2);
    // the depth: a bar from the middle, either way
    const mid = barX + barW / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(barX, y + ROW / 2 - 2, barW, 4);
    ctx.fillStyle = r.color;
    const len = (barW / 2) * Math.max(-1, Math.min(1, r.depth));
    ctx.fillRect(Math.min(mid, mid + len), y + ROW / 2 - 3, Math.abs(len), 6);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(mid - 0.5, y + 6, 1, ROW - 12);
    ctx.font = SMALL_FONT;
    ctx.fillStyle = TEXT_2;
    ctx.fillText(r.amount, barX + barW + 10, y + ROW / 2);
  });
}

function MatrixPage({ p, w, width }: { p: PrismPatch; w: Writer; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const rows = useMemo(() => linkRows(p), [p]);
  const [sel, setSel] = useState(0);
  const [hover, setHover] = useState(-1);
  const h = Math.max(1, rows.length) * ROW + 8;
  useLayoutEffect(() => {
    const ctx = prepare(ref.current, width, h, false);
    if (ctx) drawLinks(ctx, width, rows, sel, hover);
  }, [rows, sel, hover, width, h]);
  const row = (e: { clientY: number; currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect();
    const k = Math.floor((e.clientY - r.top - 4) / ROW);
    return k >= 0 && k < rows.length ? k : -1;
  };
  const cur = rows[Math.min(sel, rows.length - 1)];
  const types = p.fx.map((f) => Math.round(f.type ?? 0));
  const slotKey = (slot: number, f: string) => `mod${slot + 1}:${f}`;
  const targetMenu = (e: ReactMouseEvent<HTMLButtonElement>, pick: (t: number) => void) =>
    openMenuAt(
      e.currentTarget,
      PRISM_MOD_TARGETS.map((_, t) => ({ label: prismTargetName(t, types), onSelect: () => pick(t) })).filter(
        (_, t) => t < TGT_FX || (types[Math.floor((t - TGT_FX) / PER_FX)] ?? 0) > 0,
      ),
    );
  const sourceMenu = (e: ReactMouseEvent<HTMLButtonElement>, pick: (s: number) => void, none = false) =>
    openMenuAt(
      e.currentTarget,
      PRISM_MOD_SOURCES.map((label, s) => ({ label, onSelect: () => pick(s) })).filter((_, s) => none || s > 0),
    );
  return (
    <div className="prism-page">
      <div className="display prism-links">
        <canvas
          ref={ref}
          aria-label={`The matrix: ${rows.map((r) => `${r.srcName} to ${r.dstName}, ${r.amount}`).join('; ')}`}
          style={{ display: 'block', width, height: h, touchAction: 'none' }}
          onPointerMove={(e) => {
            if (!e.buttons) setHover(row(e));
          }}
          onPointerLeave={() => setHover(-1)}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            const k = row(e);
            if (k < 0) return;
            setSel(k);
            const r = rows[k] as LinkRow;
            const rect = e.currentTarget.getBoundingClientRect();
            const barX = rect.left + Math.round(width * 0.58);
            const barW = Math.round(width * 0.26);
            if (e.clientX < barX - 8 || e.clientX > barX + barW + 8) return;
            // the depth, dragged along its bar (Shift: finely)
            let d = r.depth;
            let started = false;
            startDrag(e, {
              onMove: (dx, _dy, ev) => {
                if (!started) {
                  started = true;
                  w.begin('link depth');
                }
                d = Math.min(1, Math.max(-1, d + (dx / (barW / 2)) * (ev.shiftKey ? 0.1 : 1)));
                w.live({ [slotKey(r.slot, 'depth')]: d });
              },
              onEnd: () => {
                if (started) w.end();
              },
            });
          }}
          onDoubleClick={(e) => {
            const k = row(e);
            const r = rows[k];
            if (r) w.once('link depth', { [slotKey(r.slot, 'depth')]: 0 });
          }}
        />
      </div>
      {cur && (
        <Section title={`Link ${cur.slot + 1}`}>
          <div className="prism-link-edit">
            <button
              type="button"
              className="btn choice-menu"
              onClick={(e) => sourceMenu(e, (s) => w.once('link source', { [slotKey(cur.slot, 'src')]: s }))}
            >
              <span className="grow">{cur.srcName}</span>
              <ChevronDown size={12} aria-hidden="true" />
            </button>
            <span className="muted">moves</span>
            <button
              type="button"
              className="btn choice-menu"
              onClick={(e) => targetMenu(e, (t) => w.once('link target', { [slotKey(cur.slot, 'dst')]: t }))}
            >
              <span className="grow">{cur.dstName}</span>
              <ChevronDown size={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn ghost icon"
              title="Take the link out"
              aria-label="Take the link out"
              onClick={() => w.once('link out', { [slotKey(cur.slot, 'src')]: 0, [slotKey(cur.slot, 'depth')]: 0 })}
            >
              <Trash2 />
            </button>
          </div>
          <div className="face prism-face">
            <Setting
              def={{ id: 'depth', name: 'Depth', min: -100, max: 100, default: 0, unit: '%' }}
              value={cur.depth * 100}
              size={40}
              onBegin={() => w.begin('link depth')}
              onEnd={w.end}
              onChange={(v) => w.live({ [slotKey(cur.slot, 'depth')]: v / 100 })}
            />
            <Choice
              name="Curve"
              options={['None', ...Array.from({ length: 8 }, (_, k) => `Curve ${k + 1}`)]}
              value={p.mod[cur.slot]?.curve ?? 0}
              onPick={(k) => w.once('link curve', { [slotKey(cur.slot, 'curve')]: k })}
            />
            <Choice
              name="Depth moved by"
              options={PRISM_MOD_SOURCES}
              value={p.mod[cur.slot]?.via ?? 0}
              onPick={(k) => w.once('link via', { [slotKey(cur.slot, 'via')]: k })}
            />
            {(p.mod[cur.slot]?.via ?? 0) > 0 && (
              <Setting
                def={{ id: 'viadepth', name: 'By', min: -100, max: 100, default: 0, unit: '%' }}
                value={(p.mod[cur.slot]?.viadepth ?? 0) * 100}
                size={40}
                onBegin={() => w.begin('link via depth')}
                onEnd={w.end}
                onChange={(v) => w.live({ [slotKey(cur.slot, 'viadepth')]: v / 100 })}
              />
            )}
          </div>
        </Section>
      )}
      <div className="prism-add">
        <button
          type="button"
          className="btn"
          disabled={freeSlot(p) < 0}
          title={freeSlot(p) < 0 ? `All ${PRISM_LINKS} links are in use` : undefined}
          onClick={(e) =>
            sourceMenu(e, (s) => {
              const slot = freeSlot(p);
              if (slot < 0) return;
              w.once('link', { [slotKey(slot, 'src')]: s, [slotKey(slot, 'dst')]: 0, [slotKey(slot, 'depth')]: 0.25 });
              setSel(rows.length);
            })
          }
        >
          <Plus size={14} /> Add a link
        </button>
      </div>
    </div>
  );
}

// ---- filters, voice and effects ------------------------------------------------------------------------------------

/** The unit each effect setting shows. */
const FX_UNITS: Record<string, string> = {
  lowcut: 'Hz',
  highcut: 'Hz',
  low: 'Hz',
  high: 'Hz',
  rate: 'Hz',
  time: 's',
  timer: 's',
  release: 's',
  decay: 's',
  predelay: 's',
  delay: 'ms',
  depth: 'ms',
};

function MorePage({ p, base, w }: { p: PrismPatch; base: PrismPatch; w: Writer }) {
  return (
    <div className="prism-page">
      {[0, 1].map((f) => {
        const fp = p.flt[f] as PrismPatch['flt'][number];
        const n = f + 1;
        const on = fp.on >= 0.5;
        return (
          <Section
            key={f}
            title={`Filter ${n}`}
            aside={
              <Switch
                label={on ? 'On' : 'Off'}
                on={on}
                onToggle={() => w.once(`filter ${n}`, { [`f${n}:on`]: on ? 0 : 1 })}
              />
            }
          >
            {on && (
              <>
                <div className="face prism-face">
                  <Choice
                    name="Type"
                    options={PRISM_FILTERS}
                    value={fp.type}
                    onPick={(k) => w.once(`filter ${n} type`, { [`f${n}:type`]: k })}
                  />
                </div>
                <Settings
                  fields={[
                    { key: `f${n}:cutoff`, name: 'Cutoff', unit: 'Hz', scale: 'log' },
                    { key: `f${n}:res`, name: 'Resonance', k: 100, unit: '%' },
                    { key: `f${n}:drive`, name: 'Drive', k: 100, unit: '%' },
                    ...(f === 1 ? [{ key: 'f:serial', name: 'From filter 1', k: 100, unit: '%' }] : []),
                  ]}
                  p={p}
                  base={base}
                  w={w}
                />
              </>
            )}
          </Section>
        );
      })}
      <Section
        title="Voice"
        aside={
          <div className="prism-switches">
            <Switch
              label="Mono"
              on={p.voice.mono >= 0.5}
              onToggle={() => w.once('mono', { 'voice:mono': p.voice.mono >= 0.5 ? 0 : 1 })}
            />
            {p.voice.mono >= 0.5 && (
              <Switch
                label="Legato"
                on={p.voice.legato >= 0.5}
                onToggle={() => w.once('legato', { 'voice:legato': p.voice.legato >= 0.5 ? 0 : 1 })}
              />
            )}
            <Switch
              label="Morph"
              on={p.xy.on >= 0.5}
              onToggle={() => w.once('morph', { 'xy:on': p.xy.on >= 0.5 ? 0 : 1 })}
            />
          </div>
        }
      >
        <Settings
          fields={[
            { key: 'amp:level', name: 'Level' },
            { key: 'amp:pan', name: 'Pan', k: 100 },
            { key: 'amp:volume', name: 'Volume', unit: 'dB' },
            { key: 'voice:glide', name: 'Glide', unit: 's' },
            { key: 'voice:poly', name: 'Notes', step: 1 },
            { key: 'voice:transpose', name: 'Transpose', unit: 'st', step: 1 },
          ]}
          p={p}
          base={base}
          w={w}
        />
      </Section>
      {Array.from({ length: PRISM_FX }, (_, k) => {
        const fx = p.fx[k] ?? { type: 0 };
        const type = Math.round(fx.type ?? 0);
        const n = k + 1;
        const defs = PRISM_FX_PARAMS[type] ?? [];
        return (
          <Section
            key={k}
            title={`Effect ${n}`}
            aside={
              <Choice
                name=""
                options={PRISM_EFFECTS}
                value={type}
                onPick={(t) => w.once(`effect ${n}`, { [`fx${n}:type`]: t })}
              />
            }
          >
            {type > 0 && (
              <Settings
                fields={[
                  { key: `fx${n}:mix`, name: 'Mix', k: 100, unit: '%' },
                  ...defs
                    .filter((d) => d.id !== 'sync')
                    .map(
                      (d): Field => ({
                        key: `fx${n}:${d.id}`,
                        name: d.name,
                        min: d.min,
                        max: d.max,
                        scale: d.log ? 'log' : 'lin',
                        unit: FX_UNITS[d.id],
                      }),
                    ),
                ]}
                p={p}
                base={base}
                w={w}
              />
            )}
          </Section>
        );
      })}
    </div>
  );
}

/** A pack instrument that plays through Prism: its map fetched (its patch, how many zones it brings), then its window. */
export function PrismPackWindow({ track, inst }: { track: Track; inst: SamplerInstrument }) {
  const [pack, setPack] = useState<PrismPack | null>(null);
  useEffect(() => {
    let live = true;
    instrumentManifest(inst.pack, inst.name)
      .then((m) => {
        if (live && m.synth) setPack({ synth: m.synth, params: m.params ?? {}, zones: m.zones.length });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [inst.pack, inst.name]);
  return pack ? <PrismWindow track={track} inst={inst} pack={pack} /> : null;
}
