/** Knobs, faders and meters: the hands-on parts of the mixer and the plugins. */
import { formatParam, fromUnit, type ParamDef, toUnit } from '@holo/session';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
} from 'react';
import { engine } from '../audio/engine.ts';
import { prepare, useFrame } from './frame.ts';

// ---- the fader law: about 0 dB at 84% of the travel, +6 dB at the top ----

export const faderToDb = (p: number): number => (p <= 0.0005 ? -144 : 20 * Math.log10(2 * p ** 4));
export const dbToFader = (db: number): number => (db <= -144 ? 0 : (10 ** (db / 20) / 2) ** 0.25);
export const formatDb = (db: number): string => (db <= -144 ? '-∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`);

interface DragOptions {
  onStart?: () => void;
  onMove: (dx: number, dy: number, e: PointerEvent) => void;
  /** Always called, so a gesture ends even when the browser took the pointer for a scroll (`cancelled`). */
  onEnd?: (cancelled: boolean) => void;
}

/** Pointer drag with capture: works with a mouse, a pen and a finger. */
export function startDrag(e: ReactPointerEvent, opts: DragOptions): void {
  const el = e.currentTarget as HTMLElement;
  const id = e.pointerId;
  el.setPointerCapture(id);
  let lastX = e.clientX;
  let lastY = e.clientY;
  opts.onStart?.();
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    opts.onMove(ev.clientX - lastX, ev.clientY - lastY, ev);
    lastX = ev.clientX;
    lastY = ev.clientY;
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    opts.onEnd?.(ev.type === 'pointercancel');
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

/** How far a drag has come from where it began: under this it was a tap. */
export const TAP = 4;

// ---- keys and the wheel: one gesture per burst ----

/**
 * Keys and wheel ticks arrive one at a time; a run of them is one gesture (one undo step, one
 * save): it begins with the first and ends when they stop for a moment.
 */
function useBurst(onBegin?: () => void, onEnd?: () => void, idle = 300) {
  const latest = useRef({ onBegin, onEnd });
  latest.current = { onBegin, onEnd };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    latest.current.onEnd?.();
  }, []);
  useEffect(() => flush, [flush]);
  return useMemo(
    () => ({
      flush,
      tick(change: () => void) {
        if (timer.current === null) latest.current.onBegin?.();
        else clearTimeout(timer.current);
        change();
        timer.current = setTimeout(flush, idle);
      },
    }),
    [flush, idle],
  );
}

/** React's onWheel is passive, so the page would scroll under the control: listen ourselves. */
function useWheel(ref: RefObject<HTMLElement | null>, onWheel: (e: WheelEvent) => void): void {
  const latest = useRef(onWheel);
  latest.current = onWheel;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      e.preventDefault();
      latest.current(e);
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  }, [ref]);
}

/** The keys a slider answers: the arrows step (Shift ten steps, Alt a tenth where it's continuous), Home and End go to the ends. */
function keyStep(e: ReactKeyboardEvent, fine: boolean): number | 'home' | 'end' | null {
  let dir = 0;
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight') dir = 1;
  else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') dir = -1;
  else if (e.key === 'Home') return 'home';
  else if (e.key === 'End') return 'end';
  else return null;
  return dir * (e.shiftKey ? 10 : e.altKey && fine ? 0.1 : 1);
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// ---- knob ----

interface KnobProps {
  def: ParamDef;
  value: number;
  onChange: (v: number) => void;
  onBegin?: () => void;
  onEnd?: () => void;
  size?: number;
  color?: string;
  label?: string;
  compact?: boolean;
  /** Snap a drag to the default while it is within this much of it (a pan's centre). */
  detent?: number;
}

export function Knob({
  def,
  value,
  onChange,
  onBegin,
  onEnd,
  size = 42,
  color = 'var(--accent)',
  label,
  compact,
  detent,
}: KnobProps) {
  const root = useRef<HTMLDivElement>(null);
  const unit = useRef(toUnit(def, value));
  // every knob draws its own cap, so each gradient needs an id of its own
  const reactId = useId();
  const capId = `knob-cap-${reactId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const burst = useBurst(onBegin, onEnd);
  const u = toUnit(def, value);
  const a0 = -135;
  const a = a0 + u * 270;
  const r = size / 2 - 4;
  const c = size / 2;
  const rad = (deg: number) => ((deg - 90) * Math.PI) / 180;
  const arc = (from: number, to: number) => {
    const large = to - from > 180 ? 1 : 0;
    return `M ${c + r * Math.cos(rad(from))} ${c + r * Math.sin(rad(from))} A ${r} ${r} 0 ${large} 1 ${c + r * Math.cos(rad(to))} ${c + r * Math.sin(rad(to))}`;
  };
  const bipolar = def.min < 0 && def.max > 0 && !def.options;
  const zero = bipolar ? a0 + toUnit(def, 0) * 270 : a0;
  const name = label ?? def.name;
  const text = formatParam(def, value);
  // one step: the parameter's own, or a hundredth of the travel
  const continuous = !def.step || def.scale === 'log';
  const stepUnit = continuous ? 0.01 : (def.step as number) / (def.max - def.min);
  const nudge = (steps: number) => onChange(fromUnit(def, clamp01(u + steps * stepUnit)));
  useWheel(root, (e) => {
    const fine = e.shiftKey && continuous ? 0.25 : 1;
    burst.tick(() => nudge(-Math.sign(e.deltaY) * (continuous ? 2 : 1) * fine));
  });
  const lit = Math.abs(a - zero) > 0.5 ? (a > zero ? arc(zero, a) : arc(a, zero)) : null;
  return (
    <div
      ref={root}
      className="knob"
      role="slider"
      tabIndex={0}
      aria-label={name}
      aria-valuemin={def.min}
      aria-valuemax={def.max}
      aria-valuenow={value}
      aria-valuetext={text}
      title={`${name}: ${text} (double-click resets, Shift for fine)`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        burst.flush();
        unit.current = toUnit(def, value);
        startDrag(e, {
          onStart: onBegin,
          onMove: (dx, dy, ev) => {
            const speed = ev.shiftKey ? 0.0015 : 0.006;
            unit.current = clamp01(unit.current + (dx - dy) * speed);
            let v = fromUnit(def, unit.current);
            if (detent !== undefined && Math.abs(v - def.default) <= detent) v = def.default;
            onChange(v);
          },
          onEnd,
        });
      }}
      onDoubleClick={() => {
        burst.flush();
        onBegin?.();
        onChange(def.default);
        onEnd?.();
      }}
      onKeyDown={(e) => {
        const k = keyStep(e, continuous);
        if (k === null) return;
        e.preventDefault();
        burst.tick(() => {
          if (k === 'home') onChange(def.min);
          else if (k === 'end') onChange(def.max);
          else nudge(k);
        });
      }}
    >
      <svg width={size} height={size} aria-hidden="true">
        <defs>
          <radialGradient id={capId} cx="40%" cy="30%" r="80%">
            <stop offset="0%" stopColor="#4a515c" />
            <stop offset="100%" stopColor="#1c1f24" />
          </radialGradient>
        </defs>
        <path d={arc(a0, a0 + 270)} stroke="#0b0d10" strokeWidth="3.5" fill="none" strokeLinecap="round" />
        {lit && (
          <>
            {/* a wider, fainter stroke under the arc is its glow: a filter would be repainted on every move */}
            <path d={lit} strokeWidth="7" fill="none" strokeLinecap="round" style={{ stroke: color, opacity: 0.3 }} />
            <path d={lit} strokeWidth="3.5" fill="none" strokeLinecap="round" style={{ stroke: color }} />
          </>
        )}
        <circle cx={c} cy={c} r={r - 5} fill={`url(#${capId})`} stroke="#000" strokeWidth="1" />
        <line
          x1={c + (r - 12) * Math.cos(rad(a)) * 0.3}
          y1={c + (r - 12) * Math.sin(rad(a)) * 0.3}
          x2={c + (r - 7) * Math.cos(rad(a))}
          y2={c + (r - 7) * Math.sin(rad(a))}
          stroke="#e8edf3"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      {!compact && <span className="knob-value">{text}</span>}
      {!compact && <span className="knob-label">{name}</span>}
    </div>
  );
}

/** Pan, as the mixer counts it: 64 steps each side of the centre, with a detent there (as HO[LO] Remote has). */
const PAN: ParamDef = { id: 'pan', name: 'Pan', min: -64, max: 64, default: 0, step: 1, unit: 'LR' };

export function PanKnob({
  value,
  onChange,
  onBegin,
  onEnd,
}: {
  value: number;
  onChange: (v: number) => void;
  onBegin?: () => void;
  onEnd?: () => void;
}) {
  const steps = Math.round(value * 64);
  return (
    <div className="pan-knob">
      <Knob
        def={PAN}
        value={steps}
        onChange={(v) => onChange(Math.max(-1, Math.min(1, v / 64)))}
        onBegin={onBegin}
        onEnd={onEnd}
        size={34}
        compact
        detent={2}
        label="Pan"
      />
      <span className="knob-value mono pan-readout">
        {steps === 0 ? 'C' : `${steps < 0 ? 'L' : 'R'}${Math.abs(steps)}`}
      </span>
    </div>
  );
}

// ---- meter ----

const METER_MIN = -60;
const meterPos = (g: number) => {
  const db = g > 1e-6 ? 20 * Math.log10(g) : -120;
  return Math.max(0, Math.min(1, (db - METER_MIN) / (6 - METER_MIN)));
};

/** A stereo peak meter, drawn every frame from the audio thread's shared numbers. */
export function Meter({ id, width = 14, height }: { id: string; width?: number; height: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const hold = useRef({ l: 0, r: 0, t: 0 });
  // what the last frame drew, to the half pixel: a quiet meter is not repainted
  const drawn = useRef({ w: 0, h: 0, l: -1, r: -1, hl: -1, hr: -1, over: -1 });
  const grad = useRef<{ h: number; fill: CanvasGradient } | null>(null);
  useFrame((now) => {
    const ctx = prepare(canvas.current, width, height);
    if (!ctx) return;
    const [l, r] = engine.meter(id);
    const h = hold.current;
    if (l > h.l || r > h.r || now - h.t > 1500) {
      h.l = Math.max(l, now - h.t > 1500 ? 0 : h.l);
      h.r = Math.max(r, now - h.t > 1500 ? 0 : h.r);
      h.t = now;
    }
    const px = (g: number) => Math.round(meterPos(g) * height * 2) / 2;
    const pl = px(l);
    const pr = px(r);
    const phl = px(h.l);
    const phr = px(h.r);
    const over = (h.l > 1 ? 1 : 0) + (h.r > 1 ? 2 : 0);
    const d = drawn.current;
    if (d.w === width && d.h === height && d.l === pl && d.r === pr && d.hl === phl && d.hr === phr && d.over === over)
      return;
    drawn.current = { w: width, h: height, l: pl, r: pr, hl: phl, hr: phr, over };
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#07090b';
    ctx.fillRect(0, 0, width, height);
    const bw = (width - 3) / 2;
    if (grad.current?.h !== height) {
      const fill = ctx.createLinearGradient(0, height, 0, 0);
      fill.addColorStop(0, '#1f9d5b');
      fill.addColorStop(0.62, '#3ddc84');
      fill.addColorStop(0.8, '#e2d54a');
      fill.addColorStop(0.9, '#f59a3d');
      fill.addColorStop(0.95, '#ff4f5e');
      grad.current = { h: height, fill };
    }
    const fill = grad.current.fill;
    [pl, pr].forEach((ph, i) => {
      const x = 1 + i * (bw + 1);
      ctx.fillStyle = '#13171b';
      ctx.fillRect(x, 0, bw, height);
      ctx.fillStyle = fill;
      ctx.fillRect(x, height - ph, bw, ph);
      const hp = i ? phr : phl;
      if (hp > 1) {
        ctx.fillStyle = (i ? h.r : h.l) > 1 ? '#ff4f5e' : '#e8edf3';
        ctx.fillRect(x, height - hp, bw, 1.5);
      }
    });
    // segment lines every 6 dB
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    for (let db = 0; db >= METER_MIN; db -= 6) {
      const y = height - ((db - METER_MIN) / (6 - METER_MIN)) * height;
      ctx.fillRect(0, y, width, 1);
    }
  });
  return <canvas ref={canvas} className="meter-canvas" style={{ width, height }} />;
}

// ---- fader ----

interface FaderProps {
  db: number;
  onChange: (db: number) => void;
  onBegin?: () => void;
  onEnd?: () => void;
  height: number;
  label?: string;
}

const SCALE = [6, 0, -6, -12, -24, -48];

export function Fader({ db, onChange, onBegin, onEnd, height, label = 'Volume' }: FaderProps) {
  const root = useRef<HTMLDivElement>(null);
  const pos = dbToFader(db);
  const travel = height - 26;
  const p = useRef(pos);
  const burst = useBurst(onBegin, onEnd);
  const step = (by: number) => onChange(Math.max(-144, Math.min(6, Math.round((db + by) * 10) / 10)));
  useWheel(root, (e) => burst.tick(() => step(-Math.sign(e.deltaY) * (e.shiftKey ? 0.1 : 1))));
  return (
    <div
      ref={root}
      className="fader"
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={-144}
      aria-valuemax={6}
      aria-valuenow={Math.round(db * 10) / 10}
      aria-valuetext={`${formatDb(db)} dB`}
      style={{ height }}
      title={`${formatDb(db)} dB (double-click: 0 dB)`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        burst.flush();
        p.current = dbToFader(db);
        startDrag(e, {
          onStart: onBegin,
          onMove: (_dx, dy, ev) => {
            p.current = Math.max(0, Math.min(1, p.current - dy / travel / (ev.shiftKey ? 6 : 1)));
            const v = faderToDb(p.current);
            onChange(v > -0.25 && v < 0.25 ? 0 : Math.round(v * 10) / 10);
          },
          onEnd,
        });
      }}
      onDoubleClick={() => {
        burst.flush();
        onBegin?.();
        onChange(0);
        onEnd?.();
      }}
      onKeyDown={(e) => {
        const k = keyStep(e, true);
        if (k === null) return;
        e.preventDefault();
        burst.tick(() => {
          if (k === 'home') onChange(-144);
          else if (k === 'end') onChange(6);
          else step(k);
        });
      }}
    >
      <div className="fader-slot" />
      {SCALE.map((d) => (
        <div
          key={d}
          className={`fader-tick${d === 0 ? ' zero' : ''}`}
          style={{ top: 13 + (1 - dbToFader(d)) * travel - 0.5 }}
        />
      ))}
      <div className="fader-cap" style={{ top: (1 - pos) * travel + 3 }}>
        <div className="fader-cap-line" />
      </div>
    </div>
  );
}

/**
 * The name as it's set: HO heavy, [LO] with its lights out (the letters dimmed, thin brackets in the
 * studio's blue), and Desk beside it in a lighter weight wherever the whole name fits.
 */
export function Wordmark({ desk = false }: { desk?: boolean }) {
  return (
    <span className="wordmark" role="img" aria-label={desk ? 'HO[LO] Desk' : 'HO[LO]'}>
      <span className="ho">HO</span>
      <span className="br">[</span>
      <span className="lo">LO</span>
      <span className="br">]</span>
      {desk && <span className="desk">Desk</span>}
    </span>
  );
}
