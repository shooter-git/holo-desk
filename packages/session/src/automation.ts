/**
 * Automation: how a channel's settings move through the song. One lane per setting, a line through
 * its points. The engine, the screen, the command line and the AI share these helpers, so a lane
 * means the same thing everywhere.
 */
import { pluginDef } from './plugins.ts';
import type { AutomationLane, Channel, Project } from './types.ts';

export interface AutomationTarget {
  param: string;
  name: string;
  min: number;
  max: number;
  unit: string;
  /** Mute and plugin choices step; everything else moves smoothly. */
  stepped: boolean;
  /** The value the setting has without automation. */
  value: number;
}

/** Every setting of a channel that can be automated, with its range. */
export function automationTargets(project: Project, channel: Channel): AutomationTarget[] {
  const out: AutomationTarget[] = [
    { param: 'volume', name: 'Volume', min: -60, max: 6, unit: 'dB', stepped: false, value: channel.volume },
    { param: 'pan', name: 'Pan', min: -1, max: 1, unit: '', stepped: false, value: channel.pan },
    { param: 'mute', name: 'Mute', min: 0, max: 1, unit: '', stepped: true, value: channel.mute ? 1 : 0 },
  ];
  if (channel.stage)
    out.push({
      param: 'distance',
      name: 'Distance',
      min: 0,
      max: 1,
      unit: '',
      stepped: false,
      value: channel.stage.distance,
    });
  for (const s of channel.sends) {
    const bus = project.buses.find((b) => b.id === s.bus);
    out.push({
      param: `send:${s.bus}`,
      name: `Send to ${bus?.name ?? 'bus'}`,
      min: -60,
      max: 6,
      unit: 'dB',
      stepped: false,
      value: s.level,
    });
  }
  for (const p of channel.inserts) {
    const def = pluginDef(p.type);
    if (!def) continue;
    for (const d of def.params) {
      out.push({
        param: `fx:${p.id}:${d.id}`,
        name: `${def.name}: ${d.name}`,
        min: d.min,
        max: d.max,
        unit: d.unit ?? '',
        stepped: !!d.options || !!d.step,
        value: p.params[d.id] ?? d.default,
      });
    }
  }
  return out;
}

/**
 * A lane's value at a tick: linear between points (or eased, for a smooth lane: a cosine), held
 * outside them, stepped if asked.
 */
export function automationAt(
  lane: Pick<AutomationLane, 'points' | 'curve'>,
  tick: number,
  stepped = false,
): number | null {
  const pts = lane.points;
  if (!pts.length) return null;
  const first = pts[0] as [number, number];
  if (tick <= first[0]) return first[1];
  for (let i = 1; i < pts.length; i++) {
    const [t1, v1] = pts[i] as [number, number];
    if (tick < t1) {
      const [t0, v0] = pts[i - 1] as [number, number];
      if (stepped || t1 === t0) return v0;
      let u = (tick - t0) / (t1 - t0);
      if (lane.curve === 'smooth') u = 0.5 - 0.5 * Math.cos(Math.PI * u);
      return v0 + (v1 - v0) * u;
    }
  }
  return (pts[pts.length - 1] as [number, number])[1];
}

export function findLane(channel: Channel, param: string): AutomationLane | undefined {
  return channel.automation?.find((a) => a.param === param);
}
