/**
 * Audio regions on screen and under the pointer: their waveforms drawn as the song plays them
 * (offset, stretch, gain, fades). The arithmetic of trimming, stretching and fading them is
 * @holo/session's (audio-region.ts), shared by the tracks area, the Audio Editor and the agent.
 */
import { type AudioClip, PPQ, type Project, type Region, secondsToTick, tickToSeconds } from '@holo/session';
import { engine } from '../audio/engine.ts';
import { audioFiles } from '../audio/files.ts';

export { fadeTo, fileSpan, setStretch, trimEnd, trimStart } from '@holo/session';

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
  // one tempo: seconds are a straight line of ticks, so skip the tempo-map walk per pixel
  const single = tempo.length === 1 ? 60 / ((tempo[0]?.bpm ?? 120) * PPQ) : 0;
  const at = (px: number) => {
    const tick = Math.max(0, view.xToTick(px));
    return (single ? tick * single : tickToSeconds(tempo, tick)) - s0;
  };
  ctx.fillStyle = style.color;
  let sa = at(from);
  for (let px = from; px < to; px++) {
    const sb = at(px + 1);
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
