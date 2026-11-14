/**
 * A setting's value, typed: what a knob's field starts with, and what its text comes to. A knob
 * turns to a value near the one wanted; some are wanted exactly (a filter at 2.5 kHz, a ratio of 4,
 * a delay of 375 ms).
 */
import type { ParamDef } from '@holo/session';

/** The value as the field shows it to be typed over: the plain number, in the setting's own unit. */
export function entryText(p: ParamDef, value: number): string {
  if (p.options) return p.options[Math.round(value)] ?? String(value);
  if (p.offAtMin && value <= p.min) return 'Off';
  return String(Number(value.toPrecision(4)));
}

/**
 * The value a typed text asks for, within the setting's range and on its steps, or null when the
 * text isn't one. A number alone is in the setting's unit; a frequency takes "2.5k", a time in
 * seconds takes "250 ms" and one in milliseconds "1.5 s", a pan takes "L20", "R 15" and "C", a
 * choice its name (or the start of it), and what goes off at its lowest takes "off".
 */
export function parseParam(p: ParamDef, text: string): number | null {
  const t = text.trim().toLowerCase().replace(',', '.');
  if (!t) return null;
  const fit = (v: number): number | null => {
    if (!Number.isFinite(v)) return null;
    const stepped = p.step ? Math.round(v / p.step) * p.step : v;
    return Math.min(p.max, Math.max(p.min, stepped));
  };
  if (p.options) {
    const names = p.options.map((o) => o.toLowerCase());
    const exact = names.indexOf(t);
    if (exact >= 0) return exact;
    const starts = names.findIndex((o) => o.startsWith(t));
    return starts >= 0 ? starts : null;
  }
  if (p.offAtMin && t === 'off') return p.min;
  if (p.unit === 'LR') {
    if (t === 'c' || t === 'center' || t === 'centre') return fit(0);
    const side = /^([lr])\s*(\d*\.?\d+)$/.exec(t);
    if (side) return fit((side[1] === 'l' ? -1 : 1) * Number(side[2]));
  }
  const m = /^([+-]?\d*\.?\d+)\s*([a-zµ%:]*)/.exec(t);
  if (!m) return null;
  let v = Number(m[1]);
  const unit = m[2] ?? '';
  if (p.unit === 'Hz' && unit.startsWith('k')) v *= 1000;
  else if (p.unit === 's' && unit === 'ms') v /= 1000;
  else if (p.unit === 'ms' && unit === 's') v *= 1000;
  return fit(v);
}
