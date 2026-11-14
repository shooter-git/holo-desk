/**
 * A patch's sound (plan.ts): the frames `a` to `b` of a region's recording (at the engine's rate,
 * stretched) as its note edits make them, rendered from that recording and the notes around it. The
 * same recording and spec give the same samples, wherever it runs.
 *
 * A line's notes (`mono`) are moved in pitch and level by pitch-synchronous overlap-add (psola.ts),
 * which copies the recording to the bit wherever nothing changes. The notes of chords and hits
 * (`poly`, `perc`) aren't rendered yet: their patches are the recording's own frames.
 */
import type { PatchSpec } from './plan.ts';
import { renderLinePatch } from './psola.ts';

/** A patch's channels, from the recording's (`base`): `b − a` frames, fewer where the recording ends first. */
export function renderNotePatch(base: readonly Float32Array[], sr: number, spec: PatchSpec): Float32Array[] {
  if (spec.mode === 'mono') return renderLinePatch(base, sr, spec);
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
