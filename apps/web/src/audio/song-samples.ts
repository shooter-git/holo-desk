/**
 * Which of an instrument's samples a song plays. A multi-sampled instrument holds hundreds of
 * samples (a grand piano's every key at many velocities), and a song often plays a few dozen of them:
 * on a phone, whose browser allows a page far less memory than a computer's, the studio loads those
 * first, and the rest only when they're played.
 */
import { songKits, type ZoneManifest } from '@holo/engine';
import { type Project, performed } from '@holo/session';

/**
 * The keys each sampled instrument plays in a song, by "pack/name" (what a Performance instrument's
 * live notes play on counts too). `null` for one the song plays in ways its notes don't spell out
 * (through a MIDI effect, as a plugin's kit): it's loaded whole.
 */
export function songKeys(project: Project): Map<string, Set<number> | null> {
  const out = new Map<string, Set<number> | null>();
  for (const t of performed(project).tracks) {
    const names: string[] = [];
    for (const i of [t.instrument, ...t.articulations.map((a) => a.instrument)])
      if (i.type === 'sampler' || i.type === 'performance') names.push(`${i.pack}/${i.name}`);
    if (!names.length) continue;
    // (an arpeggiator or a harmonizer plays keys of its own)
    const effects = t.midiFx.some((p) => !p.bypass);
    const keys = new Set<number>();
    if (!effects)
      for (const r of t.regions)
        for (const n of r.notes) {
          keys.add(Math.floor(n.p));
          keys.add(Math.ceil(n.p));
        }
    for (const name of names) {
      const had = out.get(name);
      if (had === null) continue;
      if (effects) out.set(name, null);
      else if (had) for (const k of keys) had.add(k);
      else out.set(name, new Set(keys));
    }
  }
  for (const kit of songKits(project)) out.set(kit, null);
  return out;
}

/** Keys either side of each played key whose samples come too (a note bent or nudged lands on them). */
const MARGIN = 1;

/**
 * The zones of an instrument that play these keys: each key's own (every velocity, round robin,
 * microphone and release sample), and those a key or two either side; a key outside every zone takes
 * the nearest zones instead, as the sampler would.
 */
export function zonesForKeys(zones: readonly Pick<ZoneManifest, 'lo' | 'hi'>[], keys: Iterable<number>): Set<number> {
  const out = new Set<number>();
  const distance = (z: Pick<ZoneManifest, 'lo' | 'hi'>, k: number) => (k < z.lo ? z.lo - k : k > z.hi ? k - z.hi : 0);
  for (const k of keys) {
    let nearest = Number.POSITIVE_INFINITY;
    for (const z of zones) nearest = Math.min(nearest, distance(z, k));
    const reach = Math.max(MARGIN, nearest);
    zones.forEach((z, i) => {
      if (distance(z, k) <= reach) out.add(i);
    });
  }
  return out;
}
