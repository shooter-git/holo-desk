/**
 * The six-operator FM synth's window. Its six knobs come first, big: they're the sound. Under them
 * the operator matrix: the six operators on a diagonal, each link a wire along its source's row and
 * down its target's column with its amount where they cross, each operator's feedback a ring around
 * it, and the output and the filter's input as two columns at the side. Amounts are dragged up and
 * down where they show. One level down, behind three tabs, the rest of the patch: an operator's
 * settings and its envelope as a curve to drag, the filter and the LFO, and voice, unison and the
 * chorus/delay.
 *
 * Every canvas is drawn when what it shows changes (the patch, the pointer over it), never on a
 * timer. Nothing here runs on the audio thread: a change reaches the engine once a frame, as a
 * knob's does.
 */
import { type Fm6Patch, fm6Patch } from '@holo/engine';
import {
  FM6_ENV_POINTS,
  FM6_LFO_WAVES,
  FM6_OPS,
  FM6_WAVES,
  fm6Key,
  type Instrument,
  macroValue,
  type Op,
  type ParamDef,
  SYNTH_MACROS,
  SYNTH_NOTES,
  type Track,
} from '@holo/session';
import { ChevronDown, RotateCcw, X } from 'lucide-react';
import { type CSSProperties, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { beginGesture, endGesture, gestureChange, updateTrack } from '../app/actions.ts';
import { isPhone, useLayout } from '../app/layout.ts';
import { store } from '../app/store.ts';
import { engine } from '../audio/engine.ts';
import { startDrag, TAP } from './controls.tsx';
import {
  along,
  amountToUnit,
  type Cell,
  COL_FILTER,
  COL_OUT,
  COLS,
  cellAt,
  cellCenter,
  cellKey,
  cellMax,
  cellName,
  type EnvLayout,
  type EnvShape,
  envBipolar,
  envLayout,
  envPath,
  envY,
  FILTER_COLOR,
  filterResponse,
  formatAmount,
  hitCell,
  insertPoint,
  levelAt,
  type MatrixLayout,
  matrixLayout,
  OP_COLORS,
  PITCH_COLOR,
  ROW_FILTER,
  ROWS,
  removePoint,
  segWidth,
  timeOf,
  unitToAmount,
} from './fm6-view.ts';
import { alpha, prepare, roundRect } from './frame.ts';
import { openMenuAt } from './menu.tsx';
import { Floating, Setting, useViewport } from './window.tsx';

type SynthInstrument = Extract<Instrument, { type: 'synth' }>;
type Page = 'op' | 'filter' | 'voice';

const LCD = '#07090b';
const LCD_TEXT = '#a6ecff';
const DIM = '#4f7d8c';
const TEXT_2 = '#a9b1be';
const TEXT_3 = '#6d7584';
const LABEL_FONT = '600 9.5px Inter Variable, system-ui, sans-serif';
const MONO_FONT = '500 9.5px JetBrains Mono Variable, ui-monospace, monospace';

/** The window's width on a desktop. */
const WIDTH = 600;

// ---- what the window remembers between openings (a convenience: it opens as it was left) ----------

const REMEMBER = 'holo.fm6-window';
function remembered(): Page | null {
  try {
    const v = localStorage.getItem(REMEMBER);
    return v === 'op' || v === 'filter' || v === 'voice' ? v : null;
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

// ---- writing the patch ---------------------------------------------------------------------------------

/** A patch key's value kept in its range. */
function inRange(key: string, v: number): number {
  const k = fm6Key(key);
  if (!k) return v;
  const x = Math.min(k.max, Math.max(k.min, v));
  return Math.round(x * 1e5) / 1e5;
}

/** The patch's keys changed on a track's sound, live (part of a gesture): read fresh, so a fast drag loses nothing. */
function write(trackId: string, changes: Record<string, number>): void {
  const t = store.get().project?.tracks.find((x) => x.id === trackId);
  const inst = t?.instrument;
  if (inst?.type !== 'synth') return;
  const params = { ...inst.params };
  for (const [k, v] of Object.entries(changes)) params[k] = inRange(k, v);
  gestureChange([{ op: 'updateTrack', track: trackId, patch: { instrument: { ...inst, params } } } satisfies Op]);
}

/** A change that is one step of its own (a click, a menu). */
function writeOnce(trackId: string, label: string, changes: Record<string, number>): void {
  beginGesture(label);
  write(trackId, changes);
  endGesture();
}

interface Writer {
  label: (what: string) => string;
  begin: (what: string) => void;
  live: (changes: Record<string, number>) => void;
  end: () => void;
  once: (what: string, changes: Record<string, number>) => void;
}

function writerFor(track: Track, preset: string): Writer {
  const label = (what: string) => `${preset}: ${what}`;
  return {
    label,
    begin: (what) => beginGesture(label(what)),
    live: (changes) => write(track.id, changes),
    end: endGesture,
    once: (what, changes) => writeOnce(track.id, label(what), changes),
  };
}

// ---- a setting of the patch as a knob ---------------------------------------------------------------------

interface Field {
  key: string;
  name: string;
  unit?: string;
  scale?: 'lin' | 'log';
  /** The knob shows the value times this (a pan of ±1 as ±100). */
  k?: number;
  step?: number;
  options?: string[];
  /** Its range, where the knob's should be narrower than the key's (a log knob can't reach 0). */
  min?: number;
  max?: number;
}

function defOf(f: Field, value: number): ParamDef {
  const key = fm6Key(f.key);
  const k = f.k ?? 1;
  const lo = f.min ?? (key ? key.min * k : 0);
  const hi = f.max ?? (key ? key.max * k : 1);
  return {
    id: f.key,
    name: f.name,
    min: Math.min(lo, hi),
    max: Math.max(lo, hi),
    default: value * k,
    unit: f.unit,
    scale: f.scale,
    step: f.step,
    options: f.options,
  };
}

/** A patch setting: its knob shows the patch's value, and double-clicked goes back to the preset's. */
function PatchSetting({
  f,
  value,
  base,
  w,
  color,
  size = 40,
}: {
  f: Field;
  value: number;
  base: number;
  w: Writer;
  color?: string;
  size?: number;
}) {
  const k = f.k ?? 1;
  return (
    <Setting
      def={defOf(f, base)}
      value={value * k}
      size={size}
      color={color}
      onBegin={() => w.begin(f.name)}
      onEnd={w.end}
      onChange={(v) => w.live({ [f.key]: v / k })}
    />
  );
}

/** A patch's value at a key, read from the resolved patch. */
function valueAt(p: Fm6Patch, key: string): number {
  const k = fm6Key(key);
  if (!k) return 0;
  switch (k.part) {
    case 'op':
      return Number((p.ops[k.index] as unknown as Record<string, number>)[k.field] ?? 0);
    case 'mod':
      return p.mod[k.index * FM6_OPS + k.sub] ?? 0;
    case 'env': {
      const e = p.env[k.index] as unknown as Record<string, number | number[]>;
      const v = e[k.field];
      return Array.isArray(v) ? (v[k.sub] ?? 0) : Number(v ?? 0);
    }
    case 'patch':
    case 'wave':
      return 0;
    default: {
      const part = (p as unknown as Record<string, Record<string, number | number[]>>)[k.part];
      const v = part?.[k.field];
      return Array.isArray(v) ? (v[k.sub] ?? 0) : Number(v ?? 0);
    }
  }
}

function Settings({
  fields,
  p,
  base,
  w,
  color,
}: {
  fields: Field[];
  p: Fm6Patch;
  base: Fm6Patch;
  w: Writer;
  color?: string;
}) {
  return (
    <div className="face fm6-face">
      {fields.map((f) => (
        <PatchSetting key={f.key} f={f} value={valueAt(p, f.key)} base={valueAt(base, f.key)} w={w} color={color} />
      ))}
    </div>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="fm6-section">
      <div className="fm6-section-head">
        <span className="label">{title}</span>
        {aside}
      </div>
      {children}
    </section>
  );
}

// ---- the window --------------------------------------------------------------------------------------------

export function Fm6Window({ track, inst }: { track: Track; inst: SynthInstrument }) {
  const layout = useLayout();
  const phone = isPhone(layout);
  const vp = useViewport();
  const [page, setPage] = useState<Page | null>(remembered);
  const [sel, setSel] = useState(0);
  const params = inst.params;
  const patch = useMemo(() => fm6Patch(inst.preset, params), [inst.preset, params]);
  // the preset as it comes, for each setting's double-click (a whole patch's own blank start, for one that has it)
  const blank = (params?.['patch:blank'] ?? 0) >= 0.5;
  const base = useMemo(() => fm6Patch(inst.preset, blank ? { 'patch:blank': 1 } : undefined), [inst.preset, blank]);
  const w = useMemo(() => writerFor(track, inst.preset), [track, inst.preset]);
  const defs = SYNTH_MACROS[inst.preset] ?? [];
  const width = phone ? vp.w : Math.min(WIDTH, vp.w - 16);
  const inner = width - 28;
  const close = () => store.set({ synth: null });
  const open = (next: Page | null) => {
    setPage(next);
    remember(next);
  };
  return (
    <Floating
      key={track.id}
      width={width}
      phone={phone}
      className="fm6-window"
      label={inst.preset}
      onClose={close}
      header={
        <>
          <span className="name">{inst.preset}</span>
          <span className="muted">{track.name}</span>
          <button
            type="button"
            className="btn ghost icon"
            title="Back to the preset's settings"
            aria-label="Back to the preset's settings"
            disabled={!inst.params}
            onClick={() => updateTrack(track.id, { instrument: { type: 'synth', preset: inst.preset } }, 'Reset')}
          >
            <RotateCcw />
          </button>
          <button type="button" className="btn ghost icon" title="Close" aria-label="Close" onClick={close}>
            <X />
          </button>
        </>
      }
    >
      <div className="fm6-macros">
        {defs.map((d) => (
          <Setting
            key={d.id}
            def={d}
            value={macroValue(inst.preset, params, d.id)}
            size={phone ? 50 : 56}
            onBegin={() => beginGesture(`${inst.preset}: ${d.name}`)}
            onEnd={endGesture}
            onChange={(v) => w.live({ [d.id]: v })}
          />
        ))}
      </div>
      <div className="display fm6-display">
        <MatrixView
          p={patch}
          width={inner - 2}
          sel={page === 'op' ? sel : -1}
          w={w}
          compact={phone}
          onSelect={(op) => {
            setSel(op);
            open('op');
          }}
          onFilter={() => open('filter')}
        />
      </div>
      <div className="fm6-tabs">
        <div className="seg" role="tablist" aria-label="The patch">
          {(
            [
              ['op', `Operator ${sel + 1}`],
              ['filter', 'Filter · LFO'],
              ['voice', 'Voice · Chorus'],
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
      {page === 'op' && <OperatorPage p={patch} base={base} op={sel} onOp={setSel} w={w} width={inner} />}
      {page === 'filter' && <FilterPage p={patch} base={base} w={w} width={inner} />}
      {page === 'voice' && <VoicePage p={patch} base={base} w={w} width={inner} />}
      {!page && <div className="muted plugin-note">{SYNTH_NOTES[inst.preset]}</div>}
    </Floating>
  );
}

// ---- the matrix ---------------------------------------------------------------------------------------------

function cellValue(p: Fm6Patch, c: Cell): number {
  switch (c.kind) {
    case 'node':
      return p.mod[c.op * FM6_OPS + c.op] ?? 0;
    case 'mod':
      return p.mod[c.from * FM6_OPS + c.to] ?? 0;
    case 'out':
      return p.ops[c.op]?.out ?? 0;
    case 'send':
      return p.ops[c.op]?.filter ?? 0;
    case 'filterOut':
      return p.flt.out;
    default:
      return 0;
  }
}

const opOn = (p: Fm6Patch, i: number) => (p.ops[i]?.on ?? 0) >= 0.5;
/** Something goes into the filter, or it swings something. */
function filterUsed(p: Fm6Patch): boolean {
  for (let i = 0; i < FM6_OPS; i++) if (opOn(p, i) && (p.ops[i]?.filter ?? 0) !== 0) return true;
  return false;
}
/** An operator is heard: directly, or through the filter. */
const heard = (p: Fm6Patch, i: number) =>
  opOn(p, i) && ((p.ops[i]?.out ?? 0) !== 0 || ((p.ops[i]?.filter ?? 0) !== 0 && p.flt.out !== 0));

const ratioText = (o: Fm6Patch['ops'][number]) =>
  o.fixed >= 0.5
    ? `${o.hz >= 1000 ? `${(o.hz / 1000).toFixed(1)}k` : Math.round(o.hz)}Hz`
    : `×${formatAmount(o.ratio)}`;

/** An arc of a ring, from the top-left round to `u` (0–1) of the way, as a knob's. */
function arcOf(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, u: number): void {
  const a0 = (-225 * Math.PI) / 180;
  ctx.beginPath();
  ctx.arc(x, y, r, a0, a0 + u * 1.5 * Math.PI);
}

function drawMatrix(
  ctx: CanvasRenderingContext2D,
  L: MatrixLayout,
  p: Fm6Patch,
  hover: [number, number] | null,
  sel: number,
  focus: [number, number] | null,
  compact: boolean,
): void {
  const { cw, ch } = L;
  const size = Math.min(cw, ch);
  const at = (r: number, c: number) => cellCenter(L, r, c);
  ctx.fillStyle = LCD;
  ctx.fillRect(0, 0, L.w, L.h);
  const right = L.x0 + COLS * cw;
  const bottom = L.y0 + ROWS * ch;
  // the outputs apart from the operators, the filter's row apart from theirs
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  const xd = Math.round(L.x0 + COL_OUT * cw) + 0.5;
  const yd = Math.round(L.y0 + ROW_FILTER * ch) + 0.5;
  ctx.moveTo(xd, L.y0 - 4);
  ctx.lineTo(xd, bottom + 2);
  ctx.moveTo(L.x0, yd);
  ctx.lineTo(right, yd);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = LABEL_FONT;
  ctx.textAlign = 'center';
  ctx.fillStyle = DIM;
  ctx.fillText('Out', at(0, COL_OUT)[0], 12);
  ctx.fillText('Filter', at(0, COL_FILTER)[0], 12);
  const fUsed = filterUsed(p);
  // an empty place is a dot
  ctx.fillStyle = 'rgba(255,255,255,0.13)';
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const cell = cellAt(r, c);
      if (cell.kind === 'node' || cell.kind === 'filter' || cellValue(p, cell) !== 0) continue;
      const [x, y] = at(r, c);
      ctx.beginPath();
      ctx.arc(x, y, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  // the wires: along the source's row to where the amount is, then down (or up) the target's column
  const wire = (from: [number, number], via: [number, number], to: [number, number], color: string, u: number) => {
    ctx.strokeStyle = alpha(color, 0.18 + 0.55 * u);
    ctx.lineWidth = 1 + 2.5 * u;
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.lineTo(via[0], via[1]);
    ctx.lineTo(to[0], to[1]);
    ctx.stroke();
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const fNode = at(ROW_FILTER, COL_FILTER);
  for (let s = 0; s <= FM6_OPS; s++)
    for (let t = 0; t < FM6_OPS; t++) {
      if (s === t) continue;
      const a = p.mod[s * FM6_OPS + t] ?? 0;
      if (a === 0) continue;
      const live = (s === FM6_OPS ? fUsed : opOn(p, s)) && opOn(p, t);
      const color = live ? (s === FM6_OPS ? FILTER_COLOR : (OP_COLORS[s] as string)) : TEXT_3;
      const src = s === FM6_OPS ? fNode : at(s, s);
      wire(src, at(s === FM6_OPS ? ROW_FILTER : s, t), at(t, t), color, live ? amountToUnit(a, 32) : 0);
    }
  // what's heard runs down the output's column, and what's sent down the filter's to it
  let firstOut = -1;
  for (let i = 0; i < FM6_OPS; i++) {
    const o = p.ops[i];
    if (!o || !opOn(p, i)) continue;
    if (o.out !== 0) {
      wire(at(i, i), at(i, COL_OUT), at(i, COL_OUT), OP_COLORS[i] as string, amountToUnit(o.out, 4));
      if (firstOut < 0) firstOut = i;
    }
    if (o.filter !== 0) wire(at(i, i), at(i, COL_FILTER), fNode, OP_COLORS[i] as string, amountToUnit(o.filter, 4));
  }
  if (p.flt.out !== 0 && fUsed) {
    wire(fNode, at(ROW_FILTER, COL_OUT), at(ROW_FILTER, COL_OUT), FILTER_COLOR, amountToUnit(p.flt.out, 4));
    if (firstOut < 0) firstOut = ROW_FILTER;
  }
  if (firstOut >= 0) {
    const [x, y] = at(firstOut, COL_OUT);
    ctx.strokeStyle = 'rgba(166,236,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, bottom + 6);
    ctx.stroke();
    // an arrowhead: the sound leaves here
    ctx.fillStyle = 'rgba(166,236,255,0.5)';
    ctx.beginPath();
    ctx.moveTo(x - 4, bottom + 4);
    ctx.lineTo(x + 4, bottom + 4);
    ctx.lineTo(x, bottom + 9);
    ctx.fill();
  }
  // the amounts, each a ring that fills as it grows
  const ring = size * 0.34;
  ctx.font = MONO_FONT;
  ctx.textBaseline = 'middle';
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const cell = cellAt(r, c);
      if (cell.kind === 'node' || cell.kind === 'filter') continue;
      const v = cellValue(p, cell);
      if (v === 0) continue;
      const [x, y] = at(r, c);
      const src = cell.kind === 'mod' ? cell.from : cell.kind === 'filterOut' ? FM6_OPS : cell.op;
      const live =
        cell.kind === 'mod'
          ? (src === FM6_OPS ? fUsed : opOn(p, src)) && opOn(p, cell.to)
          : src === FM6_OPS
            ? fUsed
            : opOn(p, src);
      const color = live ? (src === FM6_OPS ? FILTER_COLOR : (OP_COLORS[src] as string)) : TEXT_3;
      ctx.fillStyle = LCD;
      ctx.beginPath();
      ctx.arc(x, y, ring + 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#1b2028';
      arcOf(ctx, x, y, ring, 1);
      ctx.stroke();
      ctx.strokeStyle = color;
      arcOf(ctx, x, y, ring, Math.max(0.04, amountToUnit(v, cellMax(cell))));
      ctx.stroke();
      if (!compact || Math.abs(v) < 10) {
        ctx.fillStyle = live ? LCD_TEXT : TEXT_3;
        ctx.fillText(shortAmount(v), x, y + 0.5);
      }
    }
  // the operators
  const rn = size * 0.4;
  for (let i = 0; i < FM6_OPS; i++) {
    const [x, y] = at(i, i);
    const o = p.ops[i];
    if (!o) continue;
    const on = opOn(p, i);
    const color = OP_COLORS[i] as string;
    const fb = p.mod[i * FM6_OPS + i] ?? 0;
    if (fb !== 0 && on) {
      ctx.strokeStyle = alpha(color, 0.9);
      ctx.lineWidth = 2;
      arcOf(ctx, x, y, rn + 4, Math.max(0.04, amountToUnit(fb, 32)));
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(x, y, rn, 0, Math.PI * 2);
    if (!on) {
      ctx.fillStyle = LCD;
      ctx.fill();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = TEXT_3;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (heard(p, i)) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.fillStyle = alpha(color, 0.16);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    ctx.fillStyle = !on ? TEXT_3 : heard(p, i) ? '#07090b' : color;
    ctx.font = `700 ${compact ? 11 : 12.5}px Inter Variable, system-ui, sans-serif`;
    ctx.fillText(String(i + 1), x, compact ? y + 0.5 : y - 3.5);
    if (!compact) {
      ctx.font = '600 8.5px Inter Variable, system-ui, sans-serif';
      ctx.fillText(ratioText(o), x, y + 7.5);
    }
    if (i === sel) {
      ctx.strokeStyle = 'rgba(228,232,239,0.75)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, rn + 8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  // the filter
  {
    const [x, y] = fNode;
    const s = rn * 1.7;
    roundRect(ctx, x - s / 2, y - s / 2, s, s, 5);
    if (fUsed) {
      ctx.fillStyle = alpha(FILTER_COLOR, p.flt.out !== 0 ? 0.85 : 0.2);
      ctx.fill();
    } else {
      ctx.fillStyle = LCD;
      ctx.fill();
      ctx.setLineDash([2, 3]);
    }
    ctx.strokeStyle = fUsed ? FILTER_COLOR : TEXT_3;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = !fUsed ? TEXT_3 : p.flt.out !== 0 ? '#07090b' : FILTER_COLOR;
    ctx.font = `700 ${compact ? 11 : 12}px Inter Variable, system-ui, sans-serif`;
    ctx.fillText('F', x, y + 0.5);
  }
  // where the pointer is, and the keyboard's place
  const mark = (rc: [number, number], color: string, dash: boolean) => {
    const [x, y] = at(rc[0], rc[1]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    if (dash) ctx.setLineDash([3, 3]);
    roundRect(ctx, x - cw / 2 + 2, y - ch / 2 + 2, cw - 4, ch - 4, 6);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  if (focus) mark(focus, 'rgba(92,184,255,0.9)', false);
  if (hover && (!focus || hover[0] !== focus[0] || hover[1] !== focus[1])) mark(hover, 'rgba(255,255,255,0.28)', true);
  // the readout
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = LABEL_FONT;
  const shown = hover ?? focus;
  let text = compact
    ? 'Drag amounts · tap to connect or open'
    : 'Drag an amount up or down · click a dot to connect · click an operator to open it';
  if (shown) {
    const cell = cellAt(shown[0], shown[1]);
    const v = cellValue(p, cell);
    if (cell.kind === 'filter') text = 'Filter: click to open its page';
    else if (cell.kind === 'node') {
      const o = p.ops[cell.op];
      text = `Operator ${cell.op + 1}${o && !opOn(p, cell.op) ? ' (off)' : ''} · ${o ? ratioText(o) : ''} · feedback ${formatAmount(v)}`;
    } else text = v === 0 ? `${cellName(cell)}: click to connect` : `${cellName(cell)}: ${formatAmount(v)}`;
  }
  ctx.fillStyle = shown ? LCD_TEXT : DIM;
  ctx.fillText(text, L.x0 + 2, L.h - 5, L.w - L.x0 - 4);
  ctx.textAlign = 'start';
}

/** An amount short enough for its ring. */
function shortAmount(v: number): string {
  const m = Math.abs(v);
  if (m >= 9.95) return String(Math.round(v));
  if (m >= 1) return v.toFixed(1);
  return v.toFixed(2).replace(/^(-?)0\./, '$1.');
}

function MatrixView({
  p,
  width,
  sel,
  w,
  compact,
  onSelect,
  onFilter,
}: {
  p: Fm6Patch;
  width: number;
  sel: number;
  w: Writer;
  compact: boolean;
  onSelect: (op: number) => void;
  onFilter: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const L = useMemo(() => matrixLayout(width), [width]);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [focus, setFocus] = useState<[number, number] | null>(null);
  const [cursor, setCursor] = useState<[number, number]>([0, 0]);
  useLayoutEffect(() => {
    const ctx = prepare(ref.current, L.w, L.h, true);
    if (ctx) drawMatrix(ctx, L, p, hover, sel, focus, compact);
  }, [L, p, hover, sel, focus, compact]);
  const same = (a: [number, number] | null, b: [number, number] | null) =>
    a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);
  const where = (e: { clientX: number; clientY: number; currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect();
    return hitCell(L, e.clientX - r.left, e.clientY - r.top);
  };
  /** A press without a drag: an operator opens, the filter's page opens, a dot is connected at 1. */
  const tap = (cell: Cell) => {
    if (cell.kind === 'node') onSelect(cell.op);
    else if (cell.kind === 'filter') onFilter();
    else {
      const key = cellKey(cell);
      if (key && cellValue(p, cell) === 0) w.once(`${cellName(cell)} on`, { [key]: 1 });
    }
  };
  const clear = (cell: Cell) => {
    const key = cellKey(cell);
    if (key && cellValue(p, cell) !== 0) w.once(`${cellName(cell)} off`, { [key]: 0 });
  };
  const nudge = (cell: Cell, by: number) => {
    const key = cellKey(cell);
    if (!key) return;
    const v = cellValue(p, cell);
    const max = cellMax(cell);
    const sign = v < 0 ? -1 : 1;
    w.once(cellName(cell), { [key]: sign * unitToAmount(amountToUnit(v, max) + by, max) });
  };
  const describe = (rc: [number, number]) => {
    const cell = cellAt(rc[0], rc[1]);
    return `${cellName(cell)}: ${formatAmount(cellValue(p, cell))}`;
  };
  return (
    <canvas
      ref={ref}
      className="fm6-matrix"
      tabIndex={0}
      aria-label={`Operator matrix. ${describe(cursor)}. Arrows move, plus and minus change it, Enter opens or connects, Delete clears.`}
      style={{ display: 'block', width: L.w, height: L.h, touchAction: 'none' }}
      // (a ring for the keyboard's place: not for a click)
      onFocus={(e) => e.currentTarget.matches(':focus-visible') && setFocus(cursor)}
      onBlur={() => setFocus(null)}
      onPointerMove={(e) => {
        if (e.buttons) return;
        const h = where(e);
        if (!same(h, hover)) setHover(h);
      }}
      onPointerLeave={() => setHover(null)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const rc = where(e);
        if (!rc) return;
        setCursor(rc);
        const cell = cellAt(rc[0], rc[1]);
        const key = cellKey(cell);
        const v0 = cellValue(p, cell);
        const max = cellMax(cell);
        const sign = v0 < 0 ? -1 : 1;
        let u = amountToUnit(v0, max);
        let travel = 0;
        let started = false;
        startDrag(e, {
          onMove: (dx, dy, ev) => {
            if (!key) return;
            travel += Math.abs(dx) + Math.abs(dy);
            if (!started) {
              if (travel < TAP) return;
              started = true;
              w.begin(cellName(cell));
            }
            u = Math.min(1, Math.max(0, u + (dx - dy) * (ev.shiftKey ? 0.0012 : 0.005)));
            w.live({ [key]: sign * unitToAmount(u, max) });
          },
          onEnd: (canceled) => {
            if (started) w.end();
            else if (!canceled) tap(cell);
          },
        });
      }}
      onDoubleClick={(e) => {
        const rc = where(e);
        if (rc) clear(cellAt(rc[0], rc[1]));
      }}
      onKeyDown={(e) => {
        const [r, c] = cursor;
        let next: [number, number] | null = null;
        if (e.key === 'ArrowLeft') next = [r, Math.max(0, c - 1)];
        else if (e.key === 'ArrowRight') next = [r, Math.min(COLS - 1, c + 1)];
        else if (e.key === 'ArrowUp') next = [Math.max(0, r - 1), c];
        else if (e.key === 'ArrowDown') next = [Math.min(ROWS - 1, r + 1), c];
        const cell = cellAt(r, c);
        if (next) {
          e.preventDefault();
          setCursor(next);
          setFocus(next);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          tap(cell);
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          clear(cell);
        } else if (e.key === '+' || e.key === '=' || e.key === '-') {
          e.preventDefault();
          nudge(cell, (e.key === '-' ? -1 : 1) * (e.shiftKey ? 0.01 : 0.04));
        }
      }}
    />
  );
}

// ---- envelopes ---------------------------------------------------------------------------------------------

const ENV_PREFIX = ['env1', 'env2', 'env3', 'env4', 'env5', 'env6', 'envf', 'envp'];

function shapeOf(p: Fm6Patch, i: number): EnvShape {
  const e = p.env[i] as Fm6Patch['env'][number];
  const n = Math.min(FM6_ENV_POINTS, Math.max(1, Math.round(e.n)));
  const sus = Math.min(n - 1, Math.round(e.sus));
  return { n, start: e.start, t: e.t, l: e.l, c: e.c, sus, loop: Math.min(sus, Math.round(e.loop)) };
}

const secs = (t: number) =>
  t < 0.1 ? `${Math.round(t * 1000)} ms` : t < 10 ? `${t.toFixed(2)} s` : `${t.toFixed(1)} s`;

interface EnvGrab {
  kind: 'point' | 'curve';
  k: number;
}

function drawEnvelope(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  e: EnvShape,
  L: EnvLayout,
  color: string,
  hot: EnvGrab | null,
  note: string,
): void {
  ctx.fillStyle = LCD;
  ctx.fillRect(0, 0, width, height);
  // levels: the top, the middle and nothing (and the bottom when it goes below)
  ctx.lineWidth = 1;
  for (const v of L.bottom < 0 ? [1, 0, -1] : [1, 0.5, 0]) {
    ctx.strokeStyle = v === 0 ? 'rgba(92,184,255,0.18)' : 'rgba(255,255,255,0.05)';
    const y = Math.round(envY(L, v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  // held while the key is down, or round again from the loop point
  if (L.held) {
    const [x0, x1] = L.held;
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    ctx.fillRect(x0, 0, x1 - x0, height);
    ctx.font = LABEL_FONT;
    ctx.fillStyle = DIM;
    ctx.textAlign = 'center';
    ctx.fillText(e.loop >= 0 && e.loop < e.sus ? 'looped' : 'held', (x0 + x1) / 2, 26);
    ctx.textAlign = 'left';
    ctx.fillText('key up', x1 + 4, 26);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x1) + 0.5, 4);
    ctx.lineTo(Math.round(x1) + 0.5, height - 4);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (e.loop >= 0 && e.loop < e.sus) {
    const xa = (L.points[e.loop] as [number, number])[0];
    const xb = (L.points[e.sus] as [number, number])[0];
    ctx.strokeStyle = alpha(color, 0.6);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(xa, 9);
    ctx.lineTo(xa, 5);
    ctx.lineTo(xb, 5);
    ctx.lineTo(xb, 9);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(xa - 3, 7);
    ctx.lineTo(xa, 10);
    ctx.lineTo(xa + 3, 7);
    ctx.stroke();
  }
  // the curve, with its glow and the level under it
  const path = envPath(e, L);
  const zero = envY(L, 0);
  ctx.beginPath();
  for (const [i, [x, y]] of path.entries()) {
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.lineJoin = 'round';
  ctx.strokeStyle = alpha(color, 0.18);
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  const last = path[path.length - 1] as [number, number];
  ctx.lineTo(last[0], zero);
  ctx.lineTo(L.start[0], zero);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, L.top, 0, zero);
  g.addColorStop(0, alpha(color, 0.28));
  g.addColorStop(1, alpha(color, 0.03));
  ctx.fillStyle = g;
  ctx.fill();
  // the bends, then the points (the sustain point filled)
  let prev = L.start;
  let level = e.start;
  for (let k = 0; k < L.points.length; k++) {
    const q = L.points[k] as [number, number];
    const mid = curveHandle(e, L, k, prev, level);
    const on = hot?.kind === 'curve' && hot.k === k;
    ctx.fillStyle = on ? color : alpha(color, 0.45);
    ctx.beginPath();
    ctx.arc(mid[0], mid[1], on ? 3.5 : 2.2, 0, Math.PI * 2);
    ctx.fill();
    prev = L.held && k === e.sus ? [L.held[1], q[1]] : q;
    level = e.l[k] as number;
  }
  L.points.forEach(([x, y], k) => {
    const on = hot?.kind === 'point' && hot.k === k;
    ctx.beginPath();
    ctx.arc(x, y, on ? 6 : 4.5, 0, Math.PI * 2);
    ctx.fillStyle = k === e.sus ? color : LCD;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.stroke();
  });
  if (note) {
    ctx.font = MONO_FONT;
    ctx.textAlign = 'right';
    ctx.fillStyle = LCD_TEXT;
    ctx.fillText(note, width - 8, 14);
    ctx.textAlign = 'start';
  }
}

/** Where a stretch's bend handle sits: on the curve, halfway along in time. */
function curveHandle(e: EnvShape, L: EnvLayout, k: number, from: [number, number], level: number): [number, number] {
  const q = L.points[k] as [number, number];
  return [(from[0] + q[0]) / 2, envY(L, along(level, e.l[k] as number, e.c[k] as number, 0.5))];
}

/** The point or bend under a press (points first), or null. */
function grabAt(e: EnvShape, L: EnvLayout, x: number, y: number): EnvGrab | null {
  let best: EnvGrab | null = null;
  let dist = 13;
  L.points.forEach(([px, py], k) => {
    const d = Math.hypot(px - x, py - y);
    if (d < dist) {
      dist = d;
      best = { kind: 'point', k };
    }
  });
  if (best) return best;
  dist = 11;
  let prev = L.start;
  let level = e.start;
  for (let k = 0; k < L.points.length; k++) {
    const [mx, my] = curveHandle(e, L, k, prev, level);
    const d = Math.hypot(mx - x, my - y);
    if (d < dist) {
      dist = d;
      best = { kind: 'curve', k };
    }
    const q = L.points[k] as [number, number];
    prev = L.held && k === e.sus ? [L.held[1], q[1]] : q;
    level = e.l[k] as number;
  }
  return best;
}

/** The stretch a point in the drawing is over: the one ending at the first point to its right. */
function stretchAt(L: EnvLayout, x: number): number {
  for (let k = 0; k < L.points.length; k++) if (x <= (L.points[k] as [number, number])[0]) return k;
  return L.points.length;
}

function EnvelopeView({
  p,
  index,
  width,
  height,
  color,
  name,
  w,
}: {
  p: Fm6Patch;
  index: number;
  width: number;
  height: number;
  color: string;
  name: string;
  w: Writer;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const e = shapeOf(p, index);
  const prefix = ENV_PREFIX[index] as string;
  const bipolar = envBipolar(e) || index === 7;
  // a drag keeps the scale it began with, so the point stays under the pointer
  const [scale, setScale] = useState<number | null>(null);
  const L = envLayout(e, width, height, bipolar, scale ?? undefined);
  const [hot, setHot] = useState<EnvGrab | null>(null);
  const note = hot
    ? hot.kind === 'point'
      ? `${hot.k + 1}: ${secs(e.t[hot.k] as number)} · ${(e.l[hot.k] as number).toFixed(2)}`
      : `bend ${(e.c[hot.k] as number).toFixed(2)}`
    : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: e, L and note follow from these
  useLayoutEffect(() => {
    const ctx = prepare(ref.current, width, height, true);
    if (ctx) drawEnvelope(ctx, width, height, e, L, color, hot, note);
  }, [p, index, width, height, color, hot, scale]);
  const local = (ev: { clientX: number; clientY: number; currentTarget: Element }) => {
    const r = ev.currentTarget.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top] as const;
  };
  return (
    <canvas
      ref={ref}
      className="fm6-env"
      aria-label={`${name}: ${e.n} points${e.sus >= 0 ? `, held at point ${e.sus + 1}` : ''}. Drag a point for its time and level, a small dot to bend a stretch; double-click to add or take out a point.`}
      style={{ display: 'block', width, height, touchAction: 'none', cursor: hot ? 'grab' : 'default' }}
      onPointerMove={(ev) => {
        if (ev.buttons) return;
        const [x, y] = local(ev);
        const g = grabAt(e, L, x, y);
        if (g?.kind !== hot?.kind || g?.k !== hot?.k) setHot(g);
      }}
      onPointerLeave={() => {
        if (scale === null) setHot(null);
      }}
      onPointerDown={(ev) => {
        if (ev.button !== 0) return;
        const [x, y] = local(ev);
        const g = grabAt(e, L, x, y);
        if (!g) return;
        const k = g.k;
        const px = L.px;
        const w0 = segWidth(e.t[k] as number);
        const y0 = (L.points[k] as [number, number])[1];
        const c0 = e.c[k] as number;
        const from = k === 0 ? e.start : (e.l[k - 1] as number);
        const rising = (e.l[k] as number) >= from;
        let dx = 0;
        let dy = 0;
        let started = false;
        setHot(g);
        startDrag(ev, {
          onMove: (mx, my, pe) => {
            const fine = pe.shiftKey ? 0.25 : 1;
            dx += mx * fine;
            dy += my * fine;
            if (!started) {
              if (Math.abs(dx) + Math.abs(dy) < TAP / 2) return;
              started = true;
              setScale(px);
              w.begin(`${name} ${g.kind === 'point' ? `point ${k + 1}` : 'bend'}`);
            }
            if (g.kind === 'point') {
              const t = timeOf(w0 + dx / px);
              const lv = levelAt(L, y0 + dy);
              w.live({
                [`${prefix}:t${k}`]: Math.round(Math.min(600, t) * 1e4) / 1e4,
                [`${prefix}:l${k}`]: Math.round(lv * 1000) / 1000,
              });
            } else {
              const c = Math.min(1, Math.max(-1, c0 - (dy / 80) * (rising ? 1 : -1)));
              w.live({ [`${prefix}:c${k}`]: Math.round(c * 1000) / 1000 });
            }
          },
          onEnd: () => {
            if (started) w.end();
            setScale(null);
          },
        });
      }}
      onDoubleClick={(ev) => {
        const [x, y] = local(ev);
        const g = grabAt(e, L, x, y);
        if (g?.kind === 'point') {
          const out = removePoint(e, g.k, prefix);
          if (out) w.once(`${name}: take out point ${g.k + 1}`, out);
          return;
        }
        const k = stretchAt(L, x);
        const out = insertPoint(e, k - 1, prefix);
        if (out) w.once(`${name}: add a point`, out);
      }}
    />
  );
}

/** An envelope with its sustain and loop points and its key and velocity scaling under it. */
function Envelope({
  p,
  base,
  index,
  width,
  color,
  name,
  w,
  more,
}: {
  p: Fm6Patch;
  base: Fm6Patch;
  index: number;
  width: number;
  color: string;
  name: string;
  w: Writer;
  more?: Field[];
}) {
  const e = shapeOf(p, index);
  const prefix = ENV_PREFIX[index] as string;
  const points = Array.from({ length: e.n }, (_, k) => String(k + 1));
  const fields: Field[] = [
    ...(more ?? []),
    { key: `${prefix}:kt`, name: 'Key → time', k: 100, unit: '%' },
    { key: `${prefix}:vt`, name: 'Velocity → time', k: 100, unit: '%' },
  ];
  // a point to hold at, or to loop from back to it: each menu's first entry is "None" (-1)
  const holds = [
    { key: `${prefix}:sus`, name: 'Hold at point', options: ['None', ...points], value: e.sus + 1 },
    {
      key: `${prefix}:loop`,
      name: 'Loop from point',
      options: ['None', ...points.slice(0, Math.max(0, e.sus))],
      value: e.loop >= 0 && e.loop < e.sus ? e.loop + 1 : 0,
    },
  ];
  return (
    <div className="fm6-envelope">
      <div className="display fm6-display">
        <EnvelopeView p={p} index={index} width={width - 2} height={132} color={color} name={name} w={w} />
      </div>
      <div className="face fm6-face">
        {holds.map((h) => (
          <Choice
            key={h.key}
            name={h.name}
            options={h.options}
            value={h.value}
            onPick={(i) => w.once(`${name}: ${h.name.toLowerCase()} ${h.options[i]}`, { [h.key]: i - 1 })}
          />
        ))}
        {fields.map((f) => (
          <PatchSetting key={f.key} f={f} value={valueAt(p, f.key)} base={valueAt(base, f.key)} w={w} color={color} />
        ))}
      </div>
    </div>
  );
}

/** One of a few names, as a button that opens a menu of them (as a window's setting of names does). */
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
  return (
    <div className="knob choice">
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

/** An envelope's shape in a few pixels, for a button. */
function EnvThumb({ p, index, color }: { p: Fm6Patch; index: number; color: string }) {
  const e = shapeOf(p, index);
  const L = envLayout(e, 44, 18, envBipolar(e), undefined, 2);
  const d = envPath(e, L, 6)
    .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join('');
  return (
    <svg width={44} height={18} viewBox="0 0 44 18" aria-hidden="true" className="fm6-thumb">
      <path d={d} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  );
}

// ---- the pages -------------------------------------------------------------------------------------------------

function OperatorPage({
  p,
  base,
  op,
  onOp,
  w,
  width,
}: {
  p: Fm6Patch;
  base: Fm6Patch;
  op: number;
  onOp: (op: number) => void;
  w: Writer;
  width: number;
}) {
  const o = p.ops[op] as Fm6Patch['ops'][number];
  const n = op + 1;
  const color = OP_COLORS[op] as string;
  const on = o.on >= 0.5;
  const own = o.custom > 0;
  const waveNames = [...FM6_WAVES, ...(own ? [`Own wave ${o.custom}`] : [])];
  const fixed = o.fixed >= 0.5;
  const fields: Field[] = [
    fixed
      ? { key: `op${n}:hz`, name: 'Frequency', unit: 'Hz', scale: 'log', min: 1, max: 20000 }
      : { key: `op${n}:ratio`, name: 'Ratio', unit: '×', scale: 'log', min: 0.05, max: 64 },
    { key: `op${n}:offset`, name: 'Offset', unit: 'Hz' },
    { key: `op${n}:level`, name: 'Level', unit: '×' },
    { key: `op${n}:vel`, name: 'Velocity', k: 100, unit: '%' },
    { key: `op${n}:out`, name: 'Out', unit: '×' },
    { key: `op${n}:filter`, name: 'To filter', unit: '×' },
    { key: `op${n}:pan`, name: 'Pan', k: 100, unit: 'LR' },
    { key: `op${n}:phase`, name: 'Phase', k: 360, unit: '°' },
  ];
  return (
    <div className="fm6-page">
      <div className="fm6-ops" role="tablist" aria-label="Operators">
        {Array.from({ length: FM6_OPS }, (_, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === op}
            className={`fm6-op${i === op ? ' on' : ''}${opOn(p, i) ? '' : ' off'}`}
            style={{ '--op': OP_COLORS[i] } as CSSProperties}
            onClick={() => onOp(i)}
            title={`Operator ${i + 1}`}
          >
            <span className="fm6-op-n">{i + 1}</span>
            <EnvThumb p={p} index={i} color={opOn(p, i) ? (OP_COLORS[i] as string) : TEXT_3} />
          </button>
        ))}
      </div>
      <Section
        title={`Operator ${n}`}
        aside={
          <div className="fm6-switches">
            <button
              type="button"
              className={`btn${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => w.once(`Operator ${n} ${on ? 'off' : 'on'}`, { [`op${n}:on`]: on ? 0 : 1 })}
            >
              {on ? 'On' : 'Off'}
            </button>
            <div className="seg">
              <button
                type="button"
                className={`btn${fixed ? '' : ' on'}`}
                onClick={() => fixed && w.once(`Operator ${n} ratio`, { [`op${n}:fixed`]: 0 })}
              >
                Ratio
              </button>
              <button
                type="button"
                className={`btn${fixed ? ' on' : ''}`}
                onClick={() => !fixed && w.once(`Operator ${n} fixed`, { [`op${n}:fixed`]: 1 })}
              >
                Fixed
              </button>
            </div>
          </div>
        }
      >
        <div className="face fm6-face">
          <Choice
            name="Wave"
            options={waveNames}
            value={own ? waveNames.length - 1 : o.wave}
            onPick={(i) => {
              if (own && i === waveNames.length - 1) return;
              w.once(`Operator ${n} wave`, { [`op${n}:wave`]: i, [`op${n}:custom`]: 0 });
            }}
          />
          {fields.map((f) => (
            <PatchSetting key={f.key} f={f} value={valueAt(p, f.key)} base={valueAt(base, f.key)} w={w} color={color} />
          ))}
          <Choice
            name="Start at"
            options={['Phase', 'Random']}
            value={o.free >= 0.5 ? 1 : 0}
            onPick={(i) => w.once(`Operator ${n} start`, { [`op${n}:free`]: i })}
          />
        </div>
      </Section>
      <Section title={`Operator ${n} envelope`}>
        <Envelope p={p} base={base} index={op} width={width} color={color} name={`Operator ${n} envelope`} w={w} />
      </Section>
    </div>
  );
}

const FREQS = Array.from({ length: 160 }, (_, i) => 20 * 1000 ** (i / 159));

function drawFilter(ctx: CanvasRenderingContext2D, width: number, height: number, p: Fm6Patch, sr: number): void {
  const used = filterUsed(p);
  // (unheard, it still shows its shape: at its output level once it has one)
  const db = filterResponse({ ...p.flt, out: p.flt.out || 1 }, FREQS, sr);
  const top = 18;
  const range = 60;
  const x = (f: number) => (Math.log(f / 20) / Math.log(1000)) * width;
  const y = (d: number) => ((top - Math.max(top - range, Math.min(top, d))) / range) * (height - 8) + 4;
  ctx.fillStyle = LCD;
  ctx.fillRect(0, 0, width, height);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    ctx.beginPath();
    ctx.moveTo(Math.round(x(f)) + 0.5, 0);
    ctx.lineTo(Math.round(x(f)) + 0.5, height);
    ctx.stroke();
  }
  for (const d of [12, 0, -12, -24, -36]) {
    ctx.strokeStyle = d === 0 ? 'rgba(165,139,255,0.25)' : 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y(d)) + 0.5);
    ctx.lineTo(width, Math.round(y(d)) + 0.5);
    ctx.stroke();
  }
  ctx.fillStyle = DIM;
  ctx.font = LABEL_FONT;
  for (const [f, label] of [
    [100, '100'],
    [1000, '1k'],
    [10000, '10k'],
  ] as const)
    ctx.fillText(label, x(f) + 3, height - 5);
  const color = used ? FILTER_COLOR : TEXT_3;
  ctx.beginPath();
  db.forEach((d, i) => {
    const px = (i / (FREQS.length - 1)) * width;
    if (i) ctx.lineTo(px, y(d));
    else ctx.moveTo(px, y(d));
  });
  ctx.lineJoin = 'round';
  ctx.strokeStyle = alpha(color, 0.2);
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, alpha(color, 0.25));
  g.addColorStop(1, alpha(color, 0.02));
  ctx.fillStyle = g;
  ctx.fill();
  if (!used) {
    ctx.fillStyle = TEXT_2;
    ctx.textAlign = 'center';
    ctx.fillText('Nothing goes into the filter: send an operator to it in the matrix', width / 2, 16, width - 16);
    ctx.textAlign = 'start';
  }
}

function FilterCurve({ p, width }: { p: Fm6Patch; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const h = 104;
  // (drawn again only when the patch changes)
  useLayoutEffect(() => {
    const ctx = prepare(ref.current, width, h, true);
    if (ctx) drawFilter(ctx, width, h, p, engine.sampleRate || 48000);
  }, [width, p]);
  return (
    <canvas ref={ref} role="img" aria-label="The filter's response" style={{ display: 'block', width, height: h }} />
  );
}

function FilterPage({ p, base, w, width }: { p: Fm6Patch; base: Fm6Patch; w: Writer; width: number }) {
  const filter: Field[] = [
    { key: 'flt:cutoff', name: 'Cutoff', unit: 'Hz', scale: 'log' },
    { key: 'flt:res1', name: 'Resonance', k: 100, unit: '%' },
    { key: 'flt:mode1', name: 'Low · Band · High' },
    { key: 'flt:spread', name: 'Second, above', unit: 'st' },
    { key: 'flt:res2', name: 'Its resonance', k: 100, unit: '%' },
    { key: 'flt:mode2', name: 'Its type' },
    { key: 'flt:serial', name: 'In a row', k: 100, unit: '%' },
    { key: 'flt:mix', name: 'Mix 1 → 2', k: 100, unit: '%' },
    { key: 'flt:key', name: 'Key track', k: 100, unit: '%' },
    { key: 'flt:vel', name: 'Velocity', k: 100, unit: '%' },
    { key: 'flt:out', name: 'Out', unit: '×' },
    { key: 'flt:pan', name: 'Pan', k: 100, unit: 'LR' },
  ];
  const lfo: Field[] = [
    { key: 'lfo:rate', name: 'Rate', unit: 'Hz', scale: 'log' },
    { key: 'lfo:pitch', name: 'Vibrato', unit: 'st' },
    { key: 'lfo:wheel', name: 'Mod wheel', unit: 'st' },
    { key: 'lfo:cutoff', name: 'Cutoff', unit: 'st' },
    { key: 'lfo:amp', name: 'Tremolo', k: 100, unit: '%' },
    { key: 'lfo:fade', name: 'Fade in', unit: 's' },
    { key: 'lfo:velrate', name: 'Velocity → rate', unit: 'st' },
    { key: 'lfo:phase', name: 'Phase', k: 360, unit: '°' },
  ];
  return (
    <div className="fm6-page">
      <Section title="Filter">
        <div className="display fm6-display">
          <FilterCurve p={p} width={width - 2} />
        </div>
        <Settings fields={filter} p={p} base={base} w={w} color={FILTER_COLOR} />
      </Section>
      <Section title="Filter envelope">
        <Envelope
          p={p}
          base={base}
          index={6}
          width={width}
          color={FILTER_COLOR}
          name="Filter envelope"
          w={w}
          more={[{ key: 'flt:env', name: 'Amount', unit: 'st' }]}
        />
      </Section>
      <Section title="LFO">
        <div className="face fm6-face">
          <Choice
            name="Shape"
            options={FM6_LFO_WAVES}
            value={p.lfo.wave}
            onPick={(i) => w.once('LFO shape', { 'lfo:wave': i })}
          />
          {lfo.map((f) => (
            <PatchSetting key={f.key} f={f} value={valueAt(p, f.key)} base={valueAt(base, f.key)} w={w} />
          ))}
        </div>
      </Section>
    </div>
  );
}

function VoicePage({ p, base, w, width }: { p: Fm6Patch; base: Fm6Patch; w: Writer; width: number }) {
  const voice: Field[] = [
    { key: 'uni:voices', name: 'Unison', step: 1 },
    { key: 'uni:detune', name: 'Detune', unit: '¢' },
    { key: 'uni:pan', name: 'Width', k: 100, unit: '%' },
    { key: 'voice:drift', name: 'Drift', unit: '¢' },
    { key: 'voice:level', name: 'Level', unit: '×' },
    { key: 'voice:transpose', name: 'Transpose', unit: 'st', step: 1 },
    { key: 'voice:tune', name: 'Tune', unit: '¢' },
    { key: 'voice:poly', name: 'Voices', step: 1 },
  ];
  const fx: Field[] = [
    { key: 'fx:dry', name: 'Dry', unit: '×' },
    { key: 'fx:wet', name: 'Wet', unit: '×' },
    { key: 'fx:time', name: 'Time', unit: 's', scale: 'log' },
    { key: 'fx:spread', name: 'Spread', k: 100, unit: '%' },
    { key: 'fx:depth', name: 'Depth', k: 1000, unit: 'ms' },
    { key: 'fx:rate', name: 'Rate', unit: 'Hz', scale: 'log' },
    { key: 'fx:feedback', name: 'Feedback', k: 100, unit: '%' },
    { key: 'fx:lowcut', name: 'Low cut', unit: 'Hz', scale: 'log' },
    { key: 'fx:highcut', name: 'High cut', unit: 'Hz', scale: 'log' },
  ];
  return (
    <div className="fm6-page">
      <Section title="Voice and unison">
        <Settings fields={voice} p={p} base={base} w={w} />
      </Section>
      <Section title="Pitch envelope">
        <Envelope
          p={p}
          base={base}
          index={7}
          width={width}
          color={PITCH_COLOR}
          name="Pitch envelope"
          w={w}
          more={[{ key: 'pitch:env', name: 'Amount', unit: 'st' }]}
        />
      </Section>
      <Section title="Chorus and delay">
        <Settings fields={fx} p={p} base={base} w={w} />
      </Section>
    </div>
  );
}
