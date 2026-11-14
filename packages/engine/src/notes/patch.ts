/**
 * A patch's sound (plan.ts): the frames `a` to `b` of a region's recording (at the engine's rate,
 * stretched) as its note edits make them, rendered from that recording and the notes around it. The
 * same recording and spec give the same samples, wherever it runs.
 *
 * This first renderer changes nothing: a patch is the recording's own frames. It proves the way a
 * patch is planned, keyed, rendered and played in place (bit for bit what the recording would have
 * played) before any edit changes the sound.
 */
import type { PatchSpec } from './plan.ts';

/** A patch's channels, from the recording's (`base`): `b − a` frames, fewer where the recording ends first. */
export function renderNotePatch(base: readonly Float32Array[], _sr: number, spec: PatchSpec): Float32Array[] {
  return base.map((c) => c.slice(Math.min(spec.a, c.length), Math.min(spec.b, c.length)));
}

/** A region's recording with its patches played in place: what it sounds like edited (to measure, and to test). */
export function assembleClip(
  base: readonly Float32Array[],
  patches: readonly { spec: Pick<PatchSpec, 'a'>; channels: readonly Float32Array[] }[],
): Float32Array[] {
  const out = base.map((c) => c.slice());
  for (const p of patches) {
    out.forEach((c, ch) => {
      const from = p.channels[ch] ?? p.channels[0];
      if (from) c.set(from.subarray(0, Math.max(0, Math.min(from.length, c.length - p.spec.a))), p.spec.a);
    });
  }
  return out;
}
