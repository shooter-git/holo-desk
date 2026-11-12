/**
 * Where a take through its effects is rendered (tasks.ts; routes.ts plans it, so this stays free of
 * the engine, which only the measuring child loads).
 */
import type { Track } from '@holo/session';

/** Where a take through its effects is rendered: its regions' bars (`region`'s alone), within `from`–`to`. */
export function takeSpan(
  track: Track,
  o: { region?: string; from?: number; to?: number },
): { from: number; to: number } {
  const regions = track.regions.filter((r) => r.audio && !r.muted && (!o.region || r.id === o.region));
  if (!regions.length)
    throw new Error(o.region ? 'That region plays no recording' : `${track.name} plays no recording to measure`);
  const from = Math.max(o.from ?? 0, Math.min(...regions.map((r) => r.start)));
  const to = Math.min(o.to ?? Number.POSITIVE_INFINITY, Math.max(...regions.map((r) => r.start + r.length)));
  if (to <= from) throw new Error(`${track.name} plays nothing of its take there`);
  return { from, to };
}
