/**
 * Drawing helpers: one animation loop for everything that moves (meters, the playhead), and a
 * hook that keeps a canvas sharp at the screen's pixel density as its box resizes.
 */
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';

type Frame = (now: number) => void;
const frames = new Set<Frame>();
let running = false;

function loop(now: number): void {
  for (const f of frames) f(now);
  if (frames.size) requestAnimationFrame(loop);
  else running = false;
}

/** Call `fn` every animation frame while the component is mounted. */
export function useFrame(fn: Frame): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const f: Frame = (now) => ref.current(now);
    frames.add(f);
    if (!running) {
      running = true;
      requestAnimationFrame(loop);
    }
    return () => {
      frames.delete(f);
    };
  }, []);
}

export interface Size {
  w: number;
  h: number;
}

/** Track an element's size (it may appear later than the component: it's checked every render). */
export function useSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const observed = useRef<HTMLElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === observed.current) return;
    observer.current?.disconnect();
    observed.current = el;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
    measure();
  });
  useEffect(() => () => observer.current?.disconnect(), []);
  return size;
}

/** Size a canvas for the screen's pixel density and return its 2D context, scaled to CSS pixels. */
export function prepare(canvas: HTMLCanvasElement | null, w: number, h: number): CanvasRenderingContext2D | null {
  if (!canvas || w <= 0 || h <= 0) return null;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** A CSS colour with a new alpha. Works for #rgb and #rrggbb. */
export function alpha(hex: string, a: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const n = Number.parseInt(h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function mix(hex: string, toward: string, t: number): string {
  const parse = (x: string) => {
    let h = x.replace('#', '');
    if (h.length === 3) h = h.replace(/./g, (c) => c + c);
    const n = Number.parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
  };
  const a = parse(hex);
  const b = parse(toward);
  const c = a.map((v, i) => Math.round(v + ((b[i] as number) - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** Logic-style velocity colours: soft notes cool, hard notes hot. */
export function velocityColor(v: number): string {
  const stops: [number, string][] = [
    [0, '#6d5bd0'],
    [40, '#4b8df0'],
    [70, '#3ccf9a'],
    [95, '#d6d84a'],
    [112, '#f59a3d'],
    [127, '#f2504d'],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [v1, c1] = stops[i] as [number, string];
    const [v0, c0] = stops[i - 1] as [number, string];
    if (v <= v1) return mix(c0, c1, (v - v0) / (v1 - v0));
  }
  return '#f2504d';
}
