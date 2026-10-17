/**
 * Audio regions on screen and under the pointer: their waveforms drawn as the song plays them
 * (offset, stretch, gain, fades), and the arithmetic of trimming, stretching and fading them, shared
 * by the tracks area and the Audio Editor.
 */
import { type AudioClip, type Project, type Region, secondsToTick, tickToSeconds } from '@holo/session';
import { engine } from '../audio/engine.ts';
import { audioFiles } from '../audio/files.ts';

export interface WaveView {
  tickToX(tick: number): number;
  xToTick(x: number): number;
}

export interface WaveStyle {
  /** The ticks to draw: the region's own, or wider to show the rest of the recording. */
  from: number;
  to: number;
  y: number;
  h: number;
  color: string;
  /** Inside the region the gain and fades shape it; outside it's drawn as recorded. */
  shaped: boolean;
  canvasWidth: number;
}

const seconds = (project: Project, from: number, to: number) =>
  tickToSeconds(project.tempo, to) - tickToSeconds(project.tempo, from);

/** Draws a clip's waveform; false while its peaks are still on their way. */
export function drawClipWave(
  ctx: CanvasRenderingContext2D,
  project: Project,
  region: Pick<Region, 'start' | 'length'>,
  clip: AudioClip,
  view: WaveView,
  style: WaveStyle,
): boolean {
  const peaks = audioFiles.peaks.get(clip.file);
  if (!peaks) {
    audioFiles.ensurePeaks(project.id, clip.file, engine.ctx ?? undefined);
    return false;
  }
  const tempo = project.tempo;
  const s0 = tickToSeconds(tempo, region.start);
  const total = seconds(project, region.start, region.start + region.length);
  const mid = style.y + style.h / 2;
  const half = Math.max(1, style.h / 2 - 2);
  const gain = style.shaped ? Math.min(4, 10 ** (clip.gain / 20)) : 1;
  const perPeak = peaks.rate / peaks.step;
  const from = Math.max(0, Math.floor(view.tickToX(style.from)));
  const to = Math.min(style.canvasWidth, Math.ceil(view.tickToX(style.to)));
  ctx.fillStyle = style.color;
  let sa = tickToSeconds(tempo, Math.max(0, view.xToTick(from))) - s0;
  for (let px = from; px < to; px++) {
    const sb = tickToSeconds(tempo, Math.max(0, view.xToTick(px + 1))) - s0;
    const i0 = Math.floor((clip.offset + sa / clip.stretch) * perPeak);
    const i1 = Math.max(i0 + 1, Math.ceil((clip.offset + sb / clip.stretch) * perPeak));
    if (i0 >= peaks.min.length) break;
    if (i1 > 0) {
      let lo = 0;
      let hi = 0;
      for (let i = Math.max(0, i0); i < i1 && i < peaks.min.length; i++) {
        const a = peaks.min[i] as number;
        const b = peaks.max[i] as number;
        if (a < lo) lo = a;
        if (b > hi) hi = b;
      }
      let g = gain;
      if (style.shaped) {
        if (clip.fadeIn > 0 && sa < clip.fadeIn) g *= Math.max(0, sa) / clip.fadeIn;
        if (clip.fadeOut > 0 && total - sa < clip.fadeOut) g *= Math.max(0, total - sa) / clip.fadeOut;
      }
      const top = mid - Math.min(1, hi * g) * half;
      const bottom = mid - Math.max(-1, lo * g) * half;
      ctx.fillRect(px, top, 1, Math.max(1, bottom - top));
    }
    sa = sb;
  }
  return true;
}

/** The fades' shaded corners and lines over a region drawn from x to x + w. */
export function drawFades(
  ctx: CanvasRenderingContext2D,
  project: Project,
  region: Pick<Region, 'start' | 'length'>,
  clip: AudioClip,
  view: WaveView,
  y: number,
  h: number,
): void {
  const x0 = view.tickToX(region.start);
  const x1 = view.tickToX(region.start + region.length);
  const total = seconds(project, region.start, region.start + region.length);
  const s0 = tickToSeconds(project.tempo, region.start);
  const at = (sec: number) => view.tickToX(secondsToTick(project.tempo, s0 + sec));
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.fillStyle = 'rgba(8,10,13,0.45)';
  ctx.lineWidth = 1;
  const corner = (xa: number, ya: number, xb: number, yb: number, xc: number, yc: number) => {
    ctx.beginPath();
    ctx.moveTo(xa, ya);
    ctx.lineTo(xb, yb);
    ctx.lineTo(xc, yc);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(xa, ya);
    ctx.lineTo(xb, yb);
    ctx.stroke();
  };
  if (clip.fadeIn > 0) corner(x0, y + h, at(clip.fadeIn), y, x0, y);
  if (clip.fadeOut > 0) corner(x1, y + h, at(total - clip.fadeOut), y, x1, y);
}

/** Where the whole recording lies on the timeline (for showing what a trim has hidden). */
export function fileSpan(project: Project, region: Pick<Region, 'start'>, clip: AudioClip): [number, number] {
  const file = project.files?.find((f) => f.id === clip.file);
  const s0 = tickToSeconds(project.tempo, region.start);
  const start = secondsToTick(project.tempo, Math.max(0, s0 - clip.offset * clip.stretch));
  const end = file
    ? secondsToTick(project.tempo, s0 + (file.seconds - clip.offset) * clip.stretch)
    : Number.POSITIVE_INFINITY;
  return [start, end];
}

/** The region's end moved: longer or shorter (never past the recording), or time-stretched. */
export function trimEnd(
  project: Project,
  region: Region,
  clip: AudioClip,
  length: number,
  stretch: boolean,
): { length: number; audio: AudioClip } {
  if (stretch) {
    const before = seconds(project, region.start, region.start + region.length);
    const ratio = seconds(project, region.start, region.start + Math.max(1, length)) / before;
    const s = Math.round(Math.max(0.25, Math.min(4, clip.stretch * ratio)) * 10000) / 10000;
    const sec = (before * s) / clip.stretch;
    const end = secondsToTick(project.tempo, tickToSeconds(project.tempo, region.start) + sec);
    return { length: Math.max(1, Math.round(end - region.start)), audio: { ...clip, stretch: s } };
  }
  const [, fileEnd] = fileSpan(project, region, clip);
  return { length: Math.max(1, Math.min(Math.round(length), Math.floor(fileEnd - region.start))), audio: clip };
}

/** The region's start moved: later, or earlier as far as the recording goes; the end stays. */
export function trimStart(
  project: Project,
  region: Region,
  clip: AudioClip,
  start: number,
): { start: number; length: number; audio: AudioClip } {
  const end = region.start + region.length;
  const [fileStart] = fileSpan(project, region, clip);
  const s = Math.round(Math.max(Math.ceil(fileStart), 0, Math.min(end - 1, start)));
  const offset = Math.max(0, clip.offset + seconds(project, region.start, s) / clip.stretch);
  return { start: s, length: end - s, audio: { ...clip, offset } };
}

/** A fade's corner dragged to a tick. */
export function fadeTo(
  project: Project,
  region: Region,
  clip: AudioClip,
  which: 'fadeIn' | 'fadeOut',
  tick: number,
): AudioClip {
  const total = seconds(project, region.start, region.start + region.length);
  const sec = seconds(project, region.start, tick);
  const ms = (v: number) => Math.round(v * 1000) / 1000;
  return which === 'fadeIn'
    ? { ...clip, fadeIn: ms(Math.max(0, Math.min(total - clip.fadeOut, sec))) }
    : { ...clip, fadeOut: ms(Math.max(0, Math.min(total - clip.fadeIn, total - sec))) };
}

/** A new stretch typed in: the start stays and the length follows. */
export function setStretch(project: Project, region: Region, clip: AudioClip, stretch: number): Region {
  const s = Math.round(Math.max(0.25, Math.min(4, stretch)) * 10000) / 10000;
  const sec = (seconds(project, region.start, region.start + region.length) * s) / clip.stretch;
  const end = secondsToTick(project.tempo, tickToSeconds(project.tempo, region.start) + sec);
  return { ...region, length: Math.max(1, Math.round(end - region.start)), audio: { ...clip, stretch: s } };
}
