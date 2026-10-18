/**
 * Automation lanes in the tracks area (Logic's A view): each track shows one setting's line over its
 * regions. Values sit on the lane the way their controls move: volume and sends on the fader's law,
 * plugin frequencies and times on a log scale, everything else straight.
 */
import {
  type AutomationTarget,
  automationTargets,
  type Channel,
  findLane,
  fromUnit,
  type Project,
  pluginDef,
  type Track,
  toUnit,
} from '@holo/session';
import { dbToFader, faderToDb } from './controls.tsx';
import type { Viewport } from './view.ts';

export interface LanePreview {
  track: string;
  param: string;
  points: [number, number][];
}

function paramDef(target: AutomationTarget, channel: Channel) {
  if (!target.param.startsWith('fx:')) return null;
  const [, id, param] = target.param.split(':');
  const plugin = channel.inserts.find((p) => p.id === id);
  return plugin ? (pluginDef(plugin.type)?.params.find((p) => p.id === param) ?? null) : null;
}

const fader = (p: string) => p === 'volume' || p.startsWith('send:');

/** A value as a height on the lane, 0 (bottom) to 1 (top). */
export function norm(channel: Channel, t: AutomationTarget, v: number): number {
  if (fader(t.param)) return dbToFader(v);
  const def = paramDef(t, channel);
  if (def) return toUnit(def, v);
  return (v - t.min) / (t.max - t.min || 1);
}

/** A height on the lane back to a value. */
export function denorm(channel: Channel, t: AutomationTarget, u: number): number {
  const x = Math.min(1, Math.max(0, u));
  if (fader(t.param)) return Math.max(t.min, Math.round(faderToDb(x) * 10) / 10);
  const def = paramDef(t, channel);
  if (def) return fromUnit(def, x);
  const v = t.min + x * (t.max - t.min);
  return t.stepped ? Math.round(v) : Math.round(v * 1000) / 1000;
}

export function targetOf(project: Project, track: Track, param: string): AutomationTarget {
  const all = automationTargets(project, track.channel);
  return all.find((t) => t.param === param) ?? (all[0] as AutomationTarget);
}

export function formatValue(t: AutomationTarget, v: number): string {
  if (t.param === 'mute') return v >= 0.5 ? 'muted' : 'on';
  if (t.param === 'pan') {
    const p = Math.round(v * 64);
    return p === 0 ? 'C' : `${p < 0 ? 'L' : 'R'}${Math.abs(p)}`;
  }
  if (t.unit === 'dB') return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
  if (t.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${Math.round(v)} Hz`;
  return `${Math.round(v * 100) / 100}${t.unit ? ` ${t.unit}` : ''}`;
}

export interface LaneGeometry {
  top: number;
  height: number;
}

export const laneGeometry = (index: number, trackHeight: number, scrollY: number): LaneGeometry => ({
  top: index * trackHeight - scrollY + 6,
  height: trackHeight - 14,
});

/** Draw every track's chosen lane over the regions. */
export function drawLanes(
  ctx: CanvasRenderingContext2D,
  project: Project,
  view: Viewport,
  trackHeight: number,
  w: number,
  h: number,
  params: Record<string, string>,
  preview: LanePreview | null,
): void {
  project.tracks.forEach((track, i) => {
    const g = laneGeometry(i, trackHeight, view.y);
    if (g.top + g.height < 0 || g.top > h) return;
    // the regions recede so the line reads
    ctx.fillStyle = 'rgba(9, 11, 14, 0.55)';
    ctx.fillRect(0, g.top - 4, w, trackHeight - 3);
    const t = targetOf(project, track, params[track.id] ?? 'volume');
    const lane = findLane(track.channel, t.param);
    const points =
      preview && preview.track === track.id && preview.param === t.param ? preview.points : (lane?.points ?? []);
    const y = (v: number) => g.top + (1 - norm(track.channel, t, v)) * g.height;
    const off = lane?.mode === 'off';
    ctx.lineWidth = 2;
    if (!points.length) {
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
      ctx.beginPath();
      ctx.moveTo(0, y(t.value));
      ctx.lineTo(w, y(t.value));
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    ctx.beginPath();
    let lastY = y((points[0] as [number, number])[1]);
    let lastX = 0;
    let lastV = (points[0] as [number, number])[1];
    const smooth = lane?.curve === 'smooth' && !t.stepped;
    ctx.moveTo(0, lastY);
    points.forEach(([tick, v], k) => {
      const x = view.tickToX(tick);
      const ny = y(v);
      if (t.stepped) ctx.lineTo(x, lastY);
      else if (smooth && k > 0 && x - lastX > 2) {
        // the cosine ease the engine plays, a few pixels at a time
        for (let px = lastX + 2; px < x; px += 2) {
          const u = 0.5 - 0.5 * Math.cos((Math.PI * (px - lastX)) / (x - lastX));
          ctx.lineTo(px, y(lastV + (v - lastV) * u));
        }
      }
      ctx.lineTo(x, ny);
      lastY = ny;
      lastX = x;
      lastV = v;
    });
    ctx.lineTo(w, lastY);
    // a soft wide stroke under the line stands in for a glow, without a blur pass per lane
    if (!off) {
      ctx.strokeStyle = 'rgba(255, 209, 102, 0.25)';
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    ctx.strokeStyle = off ? 'rgba(160,170,180,0.6)' : '#ffd166';
    ctx.lineWidth = 2;
    ctx.stroke();
    for (const [tick, v] of points) {
      const x = view.tickToX(tick);
      if (x < -6 || x > w + 6) continue;
      ctx.fillStyle = '#0b0d10';
      ctx.beginPath();
      ctx.arc(x, y(v), 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = off ? '#a0aab4' : '#ffd166';
      ctx.beginPath();
      ctx.arc(x, y(v), 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

/** The point under a pointer on a lane, if any (index into the lane's points). */
export function pointAt(
  points: [number, number][],
  x: number,
  y: number,
  view: Viewport,
  toY: (v: number) => number,
  radius: number,
): number {
  let best = -1;
  let dist = radius;
  points.forEach(([tick, v], i) => {
    const d = Math.hypot(view.tickToX(tick) - x, toY(v) - y);
    if (d <= dist) {
      dist = d;
      best = i;
    }
  });
  return best;
}
