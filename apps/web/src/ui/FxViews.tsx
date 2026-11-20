/**
 * The displays of the dynamics, Studio EQ, Dual Delay and the two room reverbs' windows, and the
 * Presets button. Each draws on a canvas when its settings change and not otherwise; the only thing
 * that moves is a dynamics window's meter, written to two elements' transforms once a frame while the
 * window is open, and only when its reading changes.
 */
import {
  compressorCurve,
  compShape,
  delayTaps,
  hallDecay,
  reduction,
  roomDecay,
  roomPlan,
  roomReflections,
  studioEqResponse,
} from '@holo/engine';
import { type Op, type Plugin, paramValue, pluginDef, presetNamed, presetParams, STUDIO_EQ_BELLS } from '@holo/session';
import { ChevronDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { apply, beginGesture, endGesture, gestureChange } from '../app/actions.ts';
import { engine } from '../audio/engine.ts';
import { startDrag } from './controls.tsx';
import { prepare, useFrame } from './frame.ts';
import { openMenuAt } from './menu.tsx';

const LCD = '#07090b';
const GRID = 'rgba(255,255,255,0.06)';
const LABEL = '#4f7d8c';
const FONT = '600 9.5px Inter Variable, system-ui, sans-serif';

/** A curve stroked with its glow: wider, fainter strokes under it (a blur would be worked out again on every move). */
function glowStroke(ctx: CanvasRenderingContext2D, rgb: string, width = 2): void {
  ctx.lineJoin = 'round';
  ctx.strokeStyle = `rgba(${rgb},0.14)`;
  ctx.lineWidth = width + 7;
  ctx.stroke();
  ctx.strokeStyle = `rgba(${rgb},0.22)`;
  ctx.lineWidth = width + 3;
  ctx.stroke();
  ctx.strokeStyle = `rgb(${rgb})`;
  ctx.lineWidth = width;
  ctx.stroke();
}

// ---- presets ----

/** The window's Presets button: the preset the settings are (or "Presets"), and a menu of them. */
export function PresetButton({ target, plugin }: { target: string; plugin: Plugin }) {
  const def = pluginDef(plugin.type);
  const presets = def?.presets;
  if (!def || !presets?.length) return null;
  const now = presetNamed(plugin.type, plugin.params);
  return (
    <button
      type="button"
      className="btn choice-menu preset-btn"
      aria-haspopup="menu"
      title="Presets"
      onClick={(e) =>
        openMenuAt(
          e.currentTarget,
          presets.map((p) => ({
            label: p.name,
            checked: p.name === now,
            focus: p.name === now,
            onSelect: () => {
              const params = presetParams(plugin.type, p.name, plugin.params);
              if (params)
                apply([{ op: 'updatePlugin', target, plugin: plugin.id, patch: { params } }], `${def.name}: ${p.name}`);
            },
          })),
        )
      }
    >
      <span className="grow">{now ?? 'Presets'}</span>
      <ChevronDown size={12} aria-hidden="true" />
    </button>
  );
}

// ---- dynamics: the transfer curve and the meter ----

const DYN_H = 168;

/** Input levels the curve is drawn through, and the steady output and reduction at each (dB). */
interface Transfer {
  lo: number;
  hi: number;
  inputs: Float64Array;
  outputs: Float64Array;
  /** The reduction the meter reads at each input (the gain stage's, not make-up's). */
  reductions: Float64Array;
  /** Where the threshold (or the ceiling) is drawn. */
  mark: number;
}

/** Where `d` dB of reduction is, down the meter's scale (the history beside it shares it). */
const grY = (size: number, d: number) => 19 + ((size - 38) * Math.min(24, d)) / 24;

/** The reduction history's background over a strip of it: the display's black and the scale's lines. */
function grBack(ctx: CanvasRenderingContext2D, size: number, x: number, w: number): void {
  ctx.fillStyle = LCD;
  ctx.fillRect(x, 0, w, size);
  ctx.fillStyle = GRID;
  for (const d of [0, 6, 12, 18, 24]) ctx.fillRect(x, Math.round(grY(size, d)), w, 1);
}

function over(x: number, w: number): number {
  if (w <= 0) return x > 0 ? x : 0;
  if (x <= -w / 2) return 0;
  if (x >= w / 2) return x;
  return (x + w / 2) ** 2 / (2 * w);
}

function transfer(type: string, params: Record<string, number>): Transfer {
  const lo = type === 'limiter' ? -30 : -60;
  const hi = 6;
  const n = 133;
  const inputs = new Float64Array(n).map((_, i) => lo + ((hi - lo) * i) / (n - 1));
  const outputs = new Float64Array(n);
  const reductions = new Float64Array(n);
  const v = (id: string) => paramValue(type, params, id);
  let mark = 0;
  if (type === 'charcomp') {
    outputs.set(compressorCurve(params, inputs));
    const s = compShape(params);
    inputs.forEach((x, i) => {
      reductions[i] = reduction(s, x);
    });
    mark = s.threshold;
  } else if (type === 'compressor') {
    const t = v('threshold');
    const k = v('knee');
    const slope = 1 - 1 / v('ratio');
    const mix = v('mix') / 100;
    inputs.forEach((x, i) => {
      const gr = over(x - t, k) * slope;
      reductions[i] = gr;
      const wet = 10 ** ((x - gr + v('makeup')) / 20);
      outputs[i] = 20 * Math.log10((1 - mix) * 10 ** (x / 20) + mix * wet);
    });
    mark = t;
  } else {
    const c = v('ceiling');
    inputs.forEach((x, i) => {
      const a = x + v('gain');
      const gr = v('knee') > 0 ? over(a - c, v('knee')) : Math.max(0, a - c);
      reductions[i] = gr;
      outputs[i] = a - gr;
    });
    mark = c;
  }
  return { lo, hi, inputs, outputs, reductions, mark };
}

/**
 * A dynamics plugin's transfer curve (output against input, steady levels) with its threshold, and
 * beside it the gain-reduction meter. A dot rides the curve where the reduction now puts the input.
 */
export function DynamicsView({ target, plugin, width }: { target: string; plugin: Plugin; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dot = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const size = Math.min(DYN_H, width - 70);
  const tf = useMemo(() => transfer(plugin.type, plugin.params), [plugin.type, plugin.params]);
  const tfRef = useRef(tf);
  tfRef.current = tf;
  useLayoutEffect(() => {
    const ctx = prepare(ref.current, size, size, true);
    if (!ctx) return;
    const { lo, hi, inputs, outputs, mark } = tf;
    const px = (db: number) => ((db - lo) / (hi - lo)) * size;
    const py = (db: number) => size - ((db - lo) / (hi - lo)) * size;
    ctx.fillStyle = LCD;
    ctx.fillRect(0, 0, size, size);
    ctx.lineWidth = 1;
    ctx.strokeStyle = GRID;
    for (let d = Math.ceil(lo / 12) * 12; d <= hi; d += 12) {
      ctx.beginPath();
      ctx.moveTo(Math.round(px(d)) + 0.5, 0);
      ctx.lineTo(Math.round(px(d)) + 0.5, size);
      ctx.moveTo(0, Math.round(py(d)) + 0.5);
      ctx.lineTo(size, Math.round(py(d)) + 0.5);
      ctx.stroke();
    }
    // unity, dashed: where nothing is done
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.moveTo(px(lo), py(lo));
    ctx.lineTo(px(hi), py(hi));
    ctx.stroke();
    ctx.setLineDash([]);
    // the threshold (or the ceiling)
    ctx.strokeStyle = 'rgba(255,190,92,0.35)';
    ctx.beginPath();
    ctx.moveTo(Math.round(px(mark)) + 0.5, 0);
    ctx.lineTo(Math.round(px(mark)) + 0.5, size);
    ctx.stroke();
    ctx.fillStyle = LABEL;
    ctx.font = FONT;
    ctx.fillText(`${Math.round(mark * 10) / 10} dB`, Math.min(size - 46, px(mark) + 4), 12);
    ctx.fillText('in', size - 14, size - 4);
    ctx.fillText('out', 4, 12);
    ctx.beginPath();
    inputs.forEach((xi, i) => {
      const yy = py(Math.max(lo, Math.min(hi, outputs[i] as number)));
      if (i === 0) ctx.moveTo(px(xi), yy);
      else ctx.lineTo(px(xi), yy);
    });
    glowStroke(ctx, '166,236,255');
    ctx.lineTo(size, size);
    ctx.lineTo(0, size);
    const g = ctx.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, 'rgba(92,184,255,0.22)');
    g.addColorStop(1, 'rgba(92,184,255,0.02)');
    ctx.fillStyle = g;
    ctx.fill();
  }, [tf, size]);
  // the reduction's last few seconds, scrolling (where there's room beside the meter)
  const histW = Math.floor(width - size - 106);
  const hist = useRef<HTMLCanvasElement>(null);
  const histAt = useRef({ last: 0, carry: 0, idle: 0 });
  useLayoutEffect(() => {
    if (histW < 60) return;
    const ctx = prepare(hist.current, histW, size, true);
    if (!ctx) return;
    grBack(ctx, size, 0, histW);
    histAt.current.idle = histW;
  }, [histW, size]);
  // this plugin's own reduction, not the channel's deepest
  useEffect(() => engine.watchPlugin(target, plugin.id), [target, plugin.id]);
  const shown = useRef(Number.NaN);
  useFrame((now) => {
    const raw = engine.pluginGr(target);
    const c = hist.current;
    if (c && histW >= 60) {
      // 50 px a second, moved by whole pixels; nothing drawn once what's on it has scrolled away quiet
      const at = histAt.current;
      const dt = at.last ? Math.min(250, now - at.last) : 16;
      at.last = now;
      at.carry += dt * 0.05;
      const step = Math.floor(at.carry);
      if (step > 0) {
        at.carry -= step;
        const red = -raw;
        at.idle = red < 0.05 ? at.idle + step : 0;
        const ctx = c.getContext('2d');
        if (ctx && at.idle <= histW + step) {
          const dpr = c.width / histW;
          const px = Math.round(step * dpr);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(c, px, 0, c.width - px, c.height, 0, 0, c.width - px, c.height);
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          grBack(ctx, size, histW - step, step);
          if (red >= 0.05) {
            const y = grY(size, red);
            const top = grY(size, 0);
            ctx.fillStyle = 'rgba(255,122,92,0.45)';
            ctx.fillRect(histW - step, top, step, y - top);
            ctx.fillStyle = '#ffc66b';
            ctx.fillRect(histW - step, y - 1, step, 2);
          }
        }
      }
    }
    const gr = Math.round(raw * 10) / 10;
    if (gr === shown.current) return;
    shown.current = gr;
    if (bar.current) bar.current.style.transform = `scaleY(${Math.min(1, -gr / 24)})`;
    if (text.current) text.current.textContent = gr.toFixed(1);
    const d = dot.current;
    if (!d) return;
    const t = tfRef.current;
    // the input the reduction belongs to on the curve (the reductions only grow with the input)
    let i = 0;
    while (i < t.reductions.length - 1 && (t.reductions[i] as number) < -gr) i++;
    if (gr > -0.05 || i === 0) {
      d.style.opacity = '0';
      return;
    }
    const xi = t.inputs[i] as number;
    const yi = Math.max(t.lo, Math.min(t.hi, t.outputs[i] as number));
    d.style.opacity = '1';
    d.style.transform = `translate(${((xi - t.lo) / (t.hi - t.lo)) * size - 4}px, ${size - ((yi - t.lo) / (t.hi - t.lo)) * size - 4}px)`;
  });
  return (
    <div className="dyn">
      <div className="dyn-curve" style={{ width: size, height: size }}>
        <canvas ref={ref} style={{ display: 'block', width: size, height: size }} />
        <div ref={dot} className="dyn-dot" style={{ opacity: 0 }} />
      </div>
      <div className="dyn-meter">
        <span className="label dyn-label">GR</span>
        <div className="dyn-track" style={{ height: size - 38 }}>
          <div ref={bar} className="dyn-bar" />
        </div>
        <span ref={text} className="mono dyn-value">
          0.0
        </span>
      </div>
      <div className="dyn-scale" style={{ height: size }}>
        {[0, 6, 12, 18, 24].map((d) => (
          <span key={d} style={{ top: 19 + ((size - 38) * d) / 24 }}>
            {d === 0 ? '0' : `−${d}`}
          </span>
        ))}
      </div>
      {histW >= 60 && (
        <canvas ref={hist} className="dyn-history" style={{ display: 'block', width: histW, height: size }} />
      )}
    </div>
  );
}

// ---- Studio EQ ----

export const EQ_H = 170;
const eqX = (f: number, width: number) => (Math.log(f / 20) / Math.log(1000)) * width;
const eqY = (db: number) => EQ_H / 2 - (db / 24) * (EQ_H / 2 - 10);
const EQ_FREQS = new Float64Array(240).map((_, i) => 20 * 1000 ** (i / 239));

/** Studio EQ's bands as its window shows them, low to high, each in its own color. */
export const STUDIO_BANDS: { key: string; name: string; short: string; color: string; cut?: boolean }[] = [
  { key: 'lc', name: 'Low Cut', short: 'LC', color: '#ff7a7a', cut: true },
  { key: 'ls', name: 'Low Shelf', short: 'LS', color: '#ffaa5c' },
  ...Array.from({ length: STUDIO_EQ_BELLS }, (_, i) => ({
    key: `p${i + 1}`,
    name: `Bell ${i + 1}`,
    short: String(i + 1),
    color: ['#ffd75e', '#7ee08a', '#4fd6c0', '#5cb8ff'][i] as string,
  })),
  { key: 'hs', name: 'High Shelf', short: 'HS', color: '#a58bff' },
  { key: 'hc', name: 'High Cut', short: 'HC', color: '#ff8cc6', cut: true },
];

/** Every band off but one (each band's own curve, drawn faintly under the whole). */
function only(params: Record<string, number>, key: string): Record<string, number> {
  const out: Record<string, number> = { ...params, output: 0 };
  for (const b of STUDIO_BANDS) out[`${b.key}On`] = b.key === key ? paramValue('studioeq', params, `${key}On`) : 0;
  return out;
}

function eqHandles(params: Record<string, number>, width: number) {
  return STUDIO_BANDS.map((b, i) => {
    const on = paramValue('studioeq', params, `${b.key}On`) >= 0.5;
    const f = paramValue('studioeq', params, `${b.key}Freq`);
    const g = b.cut ? 0 : paramValue('studioeq', params, `${b.key}Gain`);
    return { band: i, x: eqX(f, width), y: eqY(Math.max(-24, Math.min(24, g))), on };
  });
}

/** Studio EQ's curve: the whole, each band's own faintly in its color, and a handle on each band to drag. */
export function StudioEqView({
  target,
  plugin,
  width,
  sr,
}: {
  target: string;
  plugin: Plugin;
  width: number;
  sr: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const params = plugin.params;
  const h = EQ_H;
  useLayoutEffect(() => {
    const ctx = prepare(ref.current, width, h, true);
    if (!ctx) return;
    const x = (f: number) => eqX(f, width);
    ctx.fillStyle = LCD;
    ctx.fillRect(0, 0, width, h);
    ctx.lineWidth = 1;
    ctx.strokeStyle = GRID;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x(f)) + 0.5, 0);
      ctx.lineTo(Math.round(x(f)) + 0.5, h);
      ctx.stroke();
    }
    for (const d of [-12, 0, 12]) {
      ctx.strokeStyle = d === 0 ? 'rgba(92,184,255,0.25)' : GRID;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(eqY(d)) + 0.5);
      ctx.lineTo(width, Math.round(eqY(d)) + 0.5);
      ctx.stroke();
    }
    ctx.fillStyle = LABEL;
    ctx.font = FONT;
    for (const [f, label] of [
      [100, '100'],
      [1000, '1k'],
      [10000, '10k'],
    ] as const)
      ctx.fillText(label, x(f) + 3, h - 4);
    ctx.fillText('+12', 4, eqY(12) - 3);
    ctx.fillText('−12', 4, eqY(-12) - 3);
    const line = (resp: Float64Array) => {
      ctx.beginPath();
      resp.forEach((db, i) => {
        const px = (i / (resp.length - 1)) * width;
        const py = eqY(Math.max(-30, Math.min(30, db)));
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
    };
    // each band's own part, faint, in its color
    for (const b of STUDIO_BANDS) {
      if (paramValue('studioeq', params, `${b.key}On`) < 0.5) continue;
      if (!b.cut && Math.abs(paramValue('studioeq', params, `${b.key}Gain`)) <= 0.01) continue;
      line(studioEqResponse(only(params, b.key), EQ_FREQS, sr));
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const resp = studioEqResponse(params, EQ_FREQS, sr);
    line(resp);
    glowStroke(ctx, '166,236,255');
    ctx.lineTo(width, h / 2);
    ctx.lineTo(0, h / 2);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(92,184,255,0.3)');
    g.addColorStop(0.5, 'rgba(92,184,255,0.05)');
    g.addColorStop(1, 'rgba(92,184,255,0.3)');
    ctx.fillStyle = g;
    ctx.fill();
    for (const hd of eqHandles(params, width)) {
      const b = STUDIO_BANDS[hd.band];
      if (!b) continue;
      ctx.globalAlpha = hd.on ? 1 : 0.3;
      ctx.beginPath();
      ctx.arc(hd.x, hd.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = b.color;
      ctx.fill();
      ctx.strokeStyle = LCD;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = LCD;
      ctx.font = `700 ${b.short.length > 1 ? 7.5 : 9.5}px Inter Variable, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(b.short, hd.x, hd.y + 3.2);
      ctx.textAlign = 'start';
      ctx.globalAlpha = 1;
    }
  }, [params, width, sr]);
  return (
    <canvas
      ref={ref}
      style={{ display: 'block', width, height: h, cursor: 'pointer', touchAction: 'none' }}
      onPointerDown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        let best: ReturnType<typeof eqHandles>[number] | null = null;
        let dist = 16;
        for (const hd of eqHandles(params, width)) {
          const d = Math.hypot(hd.x - px, hd.y - py);
          if (d < dist) {
            best = hd;
            dist = d;
          }
        }
        if (!best) return;
        const band = STUDIO_BANDS[best.band];
        if (!band) return;
        let bx = best.x;
        let by = best.y;
        startDrag(e, {
          onStart: () => {
            beginGesture(`Studio EQ: ${band.name}`);
            // a band dragged is a band heard
            if (paramValue('studioeq', params, `${band.key}On`) < 0.5)
              gestureChange([
                { op: 'updatePlugin', target, plugin: plugin.id, patch: { params: { [`${band.key}On`]: 1 } } },
              ]);
          },
          onMove: (dx, dy) => {
            bx = Math.max(0, Math.min(width, bx + dx));
            by = Math.max(10, Math.min(h - 10, by + dy));
            const freq = Math.round(20 * 1000 ** (bx / width) * 10) / 10;
            const next: Record<string, number> = { [`${band.key}Freq`]: freq };
            if (!band.cut) next[`${band.key}Gain`] = Math.round(((h / 2 - by) / (h / 2 - 10)) * 240) / 10;
            gestureChange([{ op: 'updatePlugin', target, plugin: plugin.id, patch: { params: next } } satisfies Op]);
          },
          onEnd: endGesture,
        });
      }}
    />
  );
}

// ---- Dual Delay ----

const TAP_H = 140;

/** Dual Delay's echoes of a click: the left side's above the line, the right's below, a phase-flipped one in amber; beats behind. */
export function DelayView({ params, width, bpm }: { params: Record<string, number>; width: number; bpm: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const beat = 60 / Math.max(20, bpm);
  useLayoutEffect(() => {
    const ctx = prepare(ref.current, width, TAP_H, true);
    if (!ctx) return;
    const taps = delayTaps(params, beat, 4, 48);
    const last = taps.reduce((m, t) => Math.max(m, t.time), 0);
    const span = Math.min(4, Math.max(1, last * 1.08));
    const mid = TAP_H / 2;
    const x = (t: number) => 18 + (t / span) * (width - 26);
    ctx.fillStyle = LCD;
    ctx.fillRect(0, 0, width, TAP_H);
    ctx.lineWidth = 1;
    ctx.font = FONT;
    for (let k = 0, t = 0; t <= span; k++, t = k * beat) {
      ctx.strokeStyle = k % 4 === 0 ? 'rgba(255,255,255,0.1)' : GRID;
      ctx.beginPath();
      ctx.moveTo(Math.round(x(t)) + 0.5, 0);
      ctx.lineTo(Math.round(x(t)) + 0.5, TAP_H);
      ctx.stroke();
      if (k % 4 === 0 && k > 0) {
        ctx.fillStyle = LABEL;
        ctx.fillText(String(k / 4 + 1), x(t) + 3, TAP_H - 4);
      }
    }
    ctx.strokeStyle = 'rgba(92,184,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(width, mid + 0.5);
    ctx.stroke();
    ctx.fillStyle = LABEL;
    ctx.fillText('L', 4, 13);
    ctx.fillText('R', 4, TAP_H - 6);
    // the click itself, at the start
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(x(0) - 1, mid - (mid - 8), 2, 2 * (mid - 8));
    const room = mid - 10;
    for (const t of taps) {
      const db = 20 * Math.log10(Math.abs(t.gain));
      const len = Math.max(2, ((db + 48) / 48) * room);
      const up = t.side === 0;
      const px = x(t.time);
      const rgb = t.gain < 0 ? '255,170,92' : '120,214,255';
      const alpha = 1 - 0.55 * t.dark;
      const g = ctx.createLinearGradient(0, mid, 0, up ? mid - len : mid + len);
      g.addColorStop(0, `rgba(${rgb},${0.15 * alpha})`);
      g.addColorStop(1, `rgba(${rgb},${alpha})`);
      ctx.fillStyle = g;
      ctx.fillRect(px - 2, up ? mid - len : mid, 4, len);
      ctx.fillStyle = `rgba(${rgb},${alpha})`;
      ctx.beginPath();
      ctx.arc(px, up ? mid - len : mid + len, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [params, width, beat]);
  return <canvas ref={ref} style={{ display: 'block', width, height: TAP_H }} />;
}

// ---- the reverbs ----

const REV_H = 150;
/** The decay bands drawn (Hz) and their colors: lows, middle, highs. */
const REV_BANDS = [150, 1000, 8000];
const REV_COLORS = ['255,176,92', '120,214,255', '214,236,255'];
const EAR_COLORS = ['166,236,255', '126,224,138'];

/** Room Reverb's floor plan, small, in the corner of its early panel: the walls, the sound and the two ears. */
function drawPlan(ctx: CanvasRenderingContext2D, params: Record<string, number>, cx: number, cy: number, r: number) {
  const plan = roomPlan(params);
  const reach = Math.max(...plan.corners.map((c) => Math.hypot(c.x, c.y)));
  const k = r / reach;
  ctx.beginPath();
  plan.corners.forEach((c, i) => {
    if (i === 0) ctx.moveTo(cx + c.x * k, cy - c.y * k);
    else ctx.lineTo(cx + c.x * k, cy - c.y * k);
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(120,214,255,0.06)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(166,236,255,0.55)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  const dot = (x: number, y: number, rgb: string, size: number) => {
    ctx.beginPath();
    ctx.arc(cx + x * k, cy - y * k, size, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${rgb})`;
    ctx.fill();
  };
  dot(plan.source.x, plan.source.y, '255,176,92', 2.6);
  plan.ears.forEach((e, i) => {
    dot(e.x, e.y, EAR_COLORS[i] as string, 2);
  });
}

/**
 * A reverb's decay. Room Reverb's window opens with its early reflections close up (left ear above the
 * line, right below, each by its level) beside the floor plan that makes them; then, for either
 * reverb, how the lows, the middle and the highs fall away, each a slope to −60 dB in its own time.
 */
export function ReverbView({ type, params, width }: { type: string; params: Record<string, number>; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ctx = prepare(ref.current, width, REV_H, true);
    if (!ctx) return;
    const v = (id: string) => paramValue(type, params, id);
    const rt = type === 'roomreverb' ? roomDecay(params, REV_BANDS) : hallDecay(params, REV_BANDS);
    const pre = v('predelay') / 1000;
    const room = type === 'roomreverb';
    const split = room && width >= 300 ? Math.round(width * 0.36) : 0;
    ctx.fillStyle = LCD;
    ctx.fillRect(0, 0, width, REV_H);
    ctx.font = FONT;
    ctx.lineWidth = 1;
    const top = 14;
    const bottom = REV_H - 16;
    if (room) {
      // the early reflections, close up
      const { left, right } = roomReflections(params);
      const end = Math.max(...left.map((r) => r.time), ...right.map((r) => r.time), 0.01);
      const w = split || width;
      const span = (pre + end) * 1.1 + 0.002;
      const ex = (t: number) => 8 + (t / span) * (w - 16);
      const mid = (top + bottom) / 2;
      const step = span > 0.25 ? 0.1 : span > 0.1 ? 0.05 : span > 0.04 ? 0.02 : 0.01;
      for (let t = step; t < span; t += step) {
        ctx.strokeStyle = GRID;
        ctx.beginPath();
        ctx.moveTo(Math.round(ex(t)) + 0.5, 0);
        ctx.lineTo(Math.round(ex(t)) + 0.5, REV_H);
        ctx.stroke();
        ctx.fillStyle = LABEL;
        ctx.fillText(`${Math.round(t * 1000)}ms`, ex(t) + 3, REV_H - 4);
      }
      ctx.strokeStyle = 'rgba(92,184,255,0.25)';
      ctx.beginPath();
      ctx.moveTo(0, mid + 0.5);
      ctx.lineTo(w, mid + 0.5);
      ctx.stroke();
      const loudest = Math.max(...left.map((r) => r.gain), ...right.map((r) => r.gain), 1e-6);
      const room2 = mid - top;
      [left, right].forEach((list, side) => {
        const rgb = EAR_COLORS[side] as string;
        for (const r of list) {
          const len = Math.max(2, ((20 * Math.log10(r.gain / loudest) + 30) / 30) * room2);
          const px = ex(pre + r.time);
          const g = ctx.createLinearGradient(0, mid, 0, side ? mid + len : mid - len);
          g.addColorStop(0, `rgba(${rgb},0.15)`);
          g.addColorStop(1, `rgba(${rgb},0.95)`);
          ctx.fillStyle = g;
          ctx.fillRect(px - 1, side ? mid : mid - len, 2, len);
        }
      });
      ctx.fillStyle = LABEL;
      ctx.fillText('Early', 8, top);
      // (the floor plan: in the tail panel's empty corner above its slopes, or here when there is no room for both)
      if (!split) drawPlan(ctx, params, w - 26, top + 14, 18);
      if (split) {
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(split, 0, 1, REV_H);
      }
      if (!split) return;
    }
    // the tail
    const x0 = split ? split + 1 : 0;
    const longest = Math.max(...rt);
    const span = Math.min(20, Math.max(0.6, pre + longest * 1.05));
    const x = (t: number) => x0 + 8 + (t / span) * (width - x0 - 16);
    const y = (db: number) => top + 6 + (-db / 60) * (bottom - top - 6);
    ctx.strokeStyle = GRID;
    for (const d of [-20, -40, -60]) {
      ctx.beginPath();
      ctx.moveTo(x0, Math.round(y(d)) + 0.5);
      ctx.lineTo(width, Math.round(y(d)) + 0.5);
      ctx.stroke();
    }
    const step = span > 8 ? 2 : span > 3 ? 1 : span > 1.2 ? 0.5 : 0.1;
    for (let t = step; t < span; t += step) {
      ctx.strokeStyle = GRID;
      ctx.beginPath();
      ctx.moveTo(Math.round(x(t)) + 0.5, 0);
      ctx.lineTo(Math.round(x(t)) + 0.5, REV_H);
      ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.fillText(`${Math.round(t * 10) / 10}s`, x(t) + 3, REV_H - 4);
    }
    // longest drawn first, so the shorter ones sit on top
    const order = [0, 1, 2].sort((a, b) => (rt[b] as number) - (rt[a] as number));
    const start = room ? pre + 0.012 : pre + 0.03;
    for (const k of order) {
      const r = rt[k] as number;
      const rgb = REV_COLORS[k] as string;
      const knee = Math.min(0.06, r / 4);
      ctx.beginPath();
      ctx.moveTo(x(start), y(-60));
      ctx.lineTo(x(start), y(-8));
      // a bloom over its first tens of milliseconds, then a straight fall in decibels
      ctx.quadraticCurveTo(x(start + knee / 2), y(-1), x(start + knee), y(-3 - (60 * knee) / r));
      ctx.lineTo(x(start + r), y(-60));
      ctx.closePath();
      const g = ctx.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, `rgba(${rgb},0.3)`);
      g.addColorStop(1, `rgba(${rgb},0.02)`);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x(start + knee), y(-3 - (60 * knee) / r));
      ctx.lineTo(x(start + r), y(-60));
      ctx.strokeStyle = `rgba(${rgb},0.9)`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    const names = ['Low', 'Mid', 'High'];
    let lx = width - 8;
    ctx.textAlign = 'right';
    for (let k = 2; k >= 0; k--) {
      const label = `${names[k]} ${(rt[k] as number).toFixed(1)}s`;
      ctx.fillStyle = `rgba(${REV_COLORS[k]},0.9)`;
      ctx.fillText(label, lx, top);
      lx -= ctx.measureText(label).width + 10;
    }
    ctx.textAlign = 'start';
    if (split) drawPlan(ctx, params, width - 30, top + 40, 19);
  }, [params, width, type]);
  return <canvas ref={ref} style={{ display: 'block', width, height: REV_H }} />;
}
