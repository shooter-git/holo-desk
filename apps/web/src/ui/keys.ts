/**
 * The keyboard down the left of a pitch grid, and the grid's semitone lanes: the Piano Roll's, shared
 * with the Audio Editor's Notes view so the two read the same.
 */
import { type MiddleC, noteName } from '@holo/session';
import { alpha } from './frame.ts';

const BLACK = new Set([1, 3, 6, 8, 10]);
export const isBlack = (p: number) => BLACK.has(((p % 12) + 12) % 12);

export interface KeysStyle {
  /** The keyboard's size, CSS pixels. */
  width: number;
  height: number;
  /** How tall a semitone is. */
  keyHeight: number;
  /** The top of a pitch's key. */
  yOf: (pitch: number) => number;
  /** The colour a lit key takes (the track's). */
  color: string;
  /** Keys lit (being played). */
  lit?: ReadonlySet<number>;
  middleC: MiddleC;
}

/** The keyboard, its C keys named. */
export function drawKeys(kctx: CanvasRenderingContext2D, s: KeysStyle): void {
  const { width: kw, height: h, keyHeight, yOf, color } = s;
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
    const lit = s.lit?.has(pitch) ?? false;
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
      kctx.fillText(noteName(pitch, s.middleC), kw - 22, y + keyHeight / 2);
    }
  }
  kctx.fillStyle = '#0b0d10';
  kctx.fillRect(kw - 1, 0, 1, h);
}

/** The grid's lanes, a row per semitone (the black keys' darker), with a line under each C and each F. */
export function drawLanes(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  keyHeight: number,
  yOf: (pitch: number) => number,
): void {
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
}
