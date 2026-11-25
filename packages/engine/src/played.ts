/**
 * The samples a song can sound. A render loads an instrument's zones to play it, and a big sampled
 * instrument is thousands of them, gigabytes decoded: nearly all of a bounce's time and memory,
 * for a song that plays a few dozen keys. So a render loads only the zones its song can reach, and
 * what it renders is the same to the byte as with every zone loaded.
 *
 * That holds because of how the sampler chooses (sampler.ts, ZoneSet): its zones are in sets (those
 * a note strikes, each part of its release samples, the pedal's two), and a note takes, from a set,
 * the zones that score lowest for it: `kd * 1000 + vd`, semitones outside the zone's keys, then
 * velocity outside its range. Only zones at exactly the lowest score are ever looked at (tied ones
 * take turns). So more zones than needed change nothing, and a zone that can't score lowest for
 * anything the song plays can be left out.
 *
 * Where a song's keys can't be told from its notes (a MIDI effect plays keys of its own, a plugin
 * plays a kit from the audio), or a pack is of a kind this doesn't reason about, the answer is the
 * whole instrument, as it always was.
 */
import type { Project } from '@holo/session';
import { instrumentSpec, songKits } from './compile.ts';
import { isPlanned } from './parts.ts';
import type { SampleZone } from './protocol.ts';

/** Keys past this aren't reasoned about (a note far outside any keyboard): the instrument is loaded whole. */
const KEY_BOUND = 1e6;
/**
 * A velocity, or a zone's velocity edge, is within this of every other: under the 1000 a semitone
 * weighs in the sampler's score, so a zone a whole semitone further from a key never beats a nearer
 * one. Outside it, the instrument is loaded whole.
 */
const VELOCITY_BOUND = 999;

const within = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && v >= lo && v <= hi;

/**
 * The keys each sampled instrument of a song can be sent, by "pack/name": the song as it plays
 * (`performed`), as a render has it. `null`: its keys can't be told beforehand, load it whole.
 *
 * Every sampler on a track, its instrument's and its articulations', is given all of the track's
 * notes (a note whose articulation has no sampler goes to the track's own). A track with a MIDI
 * effect that isn't bypassed plays keys of its own; so does a plugin's kit (a Drum Replacer's).
 */
export function playedKeys(project: Project): Map<string, number[] | null> {
  const out = new Map<string, Set<number> | null>();
  for (const t of project.tracks) {
    const names: string[] = [];
    for (const i of [t.instrument, ...t.articulations.map((a) => a.instrument)]) {
      const spec = instrumentSpec(i);
      if (spec.kind === 'sampler') names.push(spec.key);
    }
    if (!names.length) continue;
    // (a planned part's notes play as its plans, on its own samples: only its controllers reach these,
    // unless a MIDI effect makes notes of its own, as the Session Drummer does from none)
    const effects = t.midiFx.some((p) => !p.bypass);
    let keys: Set<number> | null = new Set<number>();
    if (effects) keys = null;
    else if (!isPlanned(t)) {
      scan: for (const r of t.regions) {
        for (const n of r.notes) {
          const key = Math.fround(n.p);
          if (!within(key, -KEY_BOUND, KEY_BOUND) || !within(n.v, 0, VELOCITY_BOUND)) {
            keys = null;
            break scan;
          }
          keys.add(key);
        }
      }
    }
    for (const name of names) {
      const had = out.get(name);
      if (had === null) continue;
      if (keys === null) out.set(name, null);
      else if (had) for (const k of keys) had.add(k);
      else out.set(name, new Set(keys));
    }
  }
  for (const kit of songKits(project)) out.set(kit, null);
  return new Map([...out].map(([name, keys]) => [name, keys && [...keys]]));
}

/** What of a zone decides when it sounds, as the sampler has it. */
export type PlayedZone = Pick<SampleZone, 'lo' | 'hi' | 'lovel' | 'hivel' | 'trigger' | 'part' | 'mic'>;

/** How far a key is outside a zone's keys, in semitones: the sampler's own reckoning (ZoneSet.score). */
const outside = (z: PlayedZone, key: number): number => (key < z.lo ? z.lo - key : key > z.hi ? key - z.hi : 0);

/**
 * The zones of an instrument a song playing `keys` can sound: their indexes, to be kept in the
 * instrument's order. `null`: all of them (a zone this doesn't reason about). `zones` as the sampler
 * will have them, and `mics` the ids of the instrument's microphones.
 *
 * - The pedal's sounds are kept whole (the pedal sounds whatever is played).
 * - Struck zones: for each key, every zone less than a semitone further from it than the nearest:
 *   each velocity layer and round robin of the keys that play it, and both neighbours of a key
 *   between two.
 * - Each part of the release samples: the same, and for key -1 too (the pedal's own sound is a
 *   voice of that key, and all-notes-off lets it go through them).
 * - A set with zones on the instrument's microphones keeps one of them, or is kept whole: with and
 *   without microphones the sampler counts its round robins differently.
 */
export function playedZones(
  zones: readonly PlayedZone[],
  mics: readonly string[],
  keys: readonly number[],
): Set<number> | null {
  for (const z of zones) {
    if (!within(z.lo, -KEY_BOUND, KEY_BOUND) || !within(z.hi, -KEY_BOUND, KEY_BOUND)) return null;
    if (!within(z.lovel, 0, VELOCITY_BOUND) || !within(z.hivel, 0, VELOCITY_BOUND)) return null;
  }
  for (const k of keys) if (!within(k, -KEY_BOUND, KEY_BOUND)) return null;
  // the sampler's sets (its constructor): struck, each release part, the pedal down and up
  const triggered = zones.some((z) => z.trigger !== undefined);
  const struck: number[] = [];
  const releases = new Map<number, number[]>();
  const out = new Set<number>();
  zones.forEach((z, i) => {
    if (z.trigger === 'pedalDown' || z.trigger === 'pedalUp') out.add(i);
    else if (z.trigger === 'release') {
      const part = z.part ?? 0;
      releases.set(part, [...(releases.get(part) ?? []), i]);
    } else if (!triggered || z.trigger === undefined) struck.push(i);
  });
  const miked = (i: number) => {
    const mic = (zones[i] as PlayedZone).mic;
    return mic !== undefined && mics.includes(mic);
  };
  const keep = (set: number[], played: readonly number[]) => {
    const kept: number[] = [];
    const taken = new Set<number>();
    for (const key of played) {
      let nearest = Number.POSITIVE_INFINITY;
      for (const i of set) nearest = Math.min(nearest, outside(zones[i] as PlayedZone, key));
      for (const i of set) {
        if (taken.has(i) || !(outside(zones[i] as PlayedZone, key) < nearest + 1)) continue;
        taken.add(i);
        kept.push(i);
      }
    }
    for (const i of set.some(miked) && !kept.some(miked) ? set : kept) out.add(i);
  };
  keep(struck, keys);
  const released = [...keys, -1];
  for (const set of releases.values()) keep(set, released);
  return out;
}
