/** Knobs, faders and meters: the hands-on parts of the mixer and the plugins. */
import { formatParam, fromUnit, type ParamDef, toUnit } from '@holo/session';
import { type PointerEvent as ReactPointerEvent, useRef } from 'react';
import { engine } from '../audio/engine.ts';
import { prepare, useFrame } from './frame.ts';

// ---- the fader law: about 0 dB at 84% of the travel, +6 dB at the top ----

export const faderToDb = (p: number): number => (p <= 0.0005 ? -144 : 20 * Math.log10(2 * p ** 4));
export const dbToFader = (db: number): number => (db <= -144 ? 0 : (10 ** (db / 20) / 2) ** 0.25);
export const formatDb = (db: number): string => (db <= -144 ? '-∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`);

interface DragOptions {
  onStart?: () => void;
  onMove: (dx: number, dy: number, e: PointerEvent) => void;
  onEnd?: () => void;
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
    opts.onEnd?.();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

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
}

export function Knob({
  def,
  value,
  onChange,
  onBegin,
  onEnd,
  size = 42,
  color = '#5cb8ff',
  label,
  compact,
}: KnobProps) {
  const unit = useRef(toUnit(def, value));
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
  return (
    <div
      className="knob"
      title={`${label ?? def.name}: ${formatParam(def, value)} (double-click resets, Shift for fine)`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        unit.current = toUnit(def, value);
        startDrag(e, {
          onStart: onBegin,
          onMove: (dx, dy, ev) => {
            const speed = ev.shiftKey ? 0.0015 : 0.006;
            unit.current = Math.min(1, Math.max(0, unit.current + (dx - dy) * speed));
            onChange(fromUnit(def, unit.current));
          },
          onEnd,
        });
      }}
      onDoubleClick={() => {
        onBegin?.();
        onChange(def.default);
        onEnd?.();
      }}
      onWheel={(e) => {
        onChange(
          fromUnit(
            def,
            Math.min(1, Math.max(0, u - Math.sign(e.deltaY) * (def.step ? 1 / (def.max - def.min) : 0.02))),
          ),
        );
      }}
    >
      <svg width={size} height={size} role="img" aria-label={label ?? def.name}>
        <defs>
          <radialGradient id="knob-cap" cx="40%" cy="30%" r="80%">
            <stop offset="0%" stopColor="#4a515c" />
            <stop offset="100%" stopColor="#1c1f24" />
          </radialGradient>
        </defs>
        <path d={arc(a0, a0 + 270)} stroke="#0b0d10" strokeWidth="3.5" fill="none" strokeLinecap="round" />
        {Math.abs(a - zero) > 0.5 && (
          <path
            d={a > zero ? arc(zero, a) : arc(a, zero)}
            stroke={color}
            strokeWidth="3.5"
            fill="none"
            strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 3px ${color})` }}
          />
        )}
        <circle cx={c} cy={c} r={r - 5} fill="url(#knob-cap)" stroke="#000" strokeWidth="1" />
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
      {!compact && <span className="knob-value">{formatParam(def, value)}</span>}
      {!compact && <span className="knob-label">{label ?? def.name}</span>}
    </div>
  );
}

const PAN: ParamDef = { id: 'pan', name: 'Pan', min: -64, max: 63, default: 0, step: 1 };

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
  return (
    <div className="vstack" style={{ alignItems: 'center', gap: 2 }}>
      <Knob
        def={PAN}
        value={Math.round(value * 64)}
        onChange={(v) => onChange(Math.max(-1, Math.min(1, v / 64)))}
        onBegin={onBegin}
        onEnd={onEnd}
        size={34}
        compact
        label="Pan"
      />
      <span className="knob-value mono" style={{ fontSize: 10 }}>
        {Math.round(value * 64) === 0
          ? 'C'
          : `${Math.round(value * 64) < 0 ? 'L' : 'R'}${Math.abs(Math.round(value * 64))}`}
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
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#07090b';
    ctx.fillRect(0, 0, width, height);
    const bw = (width - 3) / 2;
    const grad = ctx.createLinearGradient(0, height, 0, 0);
    grad.addColorStop(0, '#1f9d5b');
    grad.addColorStop(0.62, '#3ddc84');
    grad.addColorStop(0.8, '#e2d54a');
    grad.addColorStop(0.9, '#f59a3d');
    grad.addColorStop(0.95, '#ff4f5e');
    [l, r].forEach((g, i) => {
      const x = 1 + i * (bw + 1);
      const ph = meterPos(g) * height;
      ctx.fillStyle = '#13171b';
      ctx.fillRect(x, 0, bw, height);
      ctx.fillStyle = grad;
      ctx.fillRect(x, height - ph, bw, ph);
      const hp = meterPos(i ? h.r : h.l) * height;
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
  return <canvas ref={canvas} style={{ width, height, borderRadius: 3, display: 'block' }} />;
}

// ---- fader ----

interface FaderProps {
  db: number;
  onChange: (db: number) => void;
  onBegin?: () => void;
  onEnd?: () => void;
  height: number;
}

const SCALE = [6, 0, -6, -12, -24, -48];

export function Fader({ db, onChange, onBegin, onEnd, height }: FaderProps) {
  const pos = dbToFader(db);
  const travel = height - 26;
  const p = useRef(pos);
  return (
    <div
      style={{ position: 'relative', width: 30, height, touchAction: 'none', cursor: 'ns-resize' }}
      title={`${formatDb(db)} dB (double-click: 0 dB)`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
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
        onBegin?.();
        onChange(0);
        onEnd?.();
      }}
    >
      {/* the slot */}
      <div
        style={{
          position: 'absolute',
          left: 13,
          top: 13,
          bottom: 13,
          width: 4,
          borderRadius: 2,
          background: '#07090b',
          boxShadow: 'inset 0 1px 2px #000, 0 1px 0 rgba(255,255,255,0.05)',
        }}
      />
      {SCALE.map((d) => (
        <div
          key={d}
          style={{
            position: 'absolute',
            left: 0,
            top: 13 + (1 - dbToFader(d)) * travel - 0.5,
            width: d === 0 ? 30 : 8,
            height: 1,
            background: d === 0 ? 'rgba(92,184,255,0.35)' : '#3a414c',
          }}
        />
      ))}
      {/* the cap */}
      <div
        style={{
          position: 'absolute',
          left: 3,
          top: (1 - pos) * travel + 3,
          width: 24,
          height: 20,
          borderRadius: 4,
          background: 'linear-gradient(180deg, #5b636f 0%, #3a414b 45%, #2b3037 55%, #474e59 100%)',
          border: '1px solid #000',
          boxShadow: '0 3px 6px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.18)',
        }}
      >
        <div style={{ position: 'absolute', left: 3, right: 3, top: 9, height: 1, background: '#e8edf3' }} />
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
