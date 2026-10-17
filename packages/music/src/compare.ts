/** How far two renders of a song are apart: what `holo update-engine` reports for each song. */

export interface Distance {
  /** Every sample the same, and the same length. */
  identical: boolean;
  /** Frames in each. */
  frames: [number, number];
  /** The largest difference between them (dBFS), -Infinity when there is none. */
  peakDb: number;
  /** The difference's level against the first's (dB): how far under the song it lies. */
  relativeDb: number;
  /** The first frame they differ at, or -1. */
  firstFrame: number;
}

const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : Number.NEGATIVE_INFINITY);

export function distance(a: Float32Array[], b: Float32Array[]): Distance {
  const fa = a[0]?.length ?? 0;
  const fb = b[0]?.length ?? 0;
  const n = Math.min(fa, fb);
  let peak = 0;
  let diff2 = 0;
  let own2 = 0;
  let first = -1;
  const channels = Math.max(a.length, b.length);
  for (let c = 0; c < channels; c++) {
    const x = a[c] ?? a[0] ?? new Float32Array(0);
    const y = b[c] ?? b[0] ?? new Float32Array(0);
    for (let i = 0; i < Math.max(fa, fb); i++) {
      const u = i < fa ? (x[i] as number) : 0;
      const v = i < fb ? (y[i] as number) : 0;
      const d = Math.abs(u - v);
      if (d > 0 && (first < 0 || i < first)) first = i;
      if (d > peak) peak = d;
      diff2 += d * d;
      own2 += u * u;
    }
  }
  const identical = fa === fb && a.length === b.length && peak === 0;
  return {
    identical,
    frames: [fa, fb],
    peakDb: db(peak),
    relativeDb:
      own2 > 0 ? 10 * Math.log10(diff2 / own2) : diff2 > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
    firstFrame: identical ? -1 : first < 0 ? n : first,
  };
}

export function describeDistance(d: Distance, rate: number): string {
  if (d.identical) return 'identical, sample for sample';
  const parts: string[] = [];
  if (d.frames[0] !== d.frames[1]) {
    const s = (d.frames[1] - d.frames[0]) / rate;
    parts.push(`${s > 0 ? 'longer' : 'shorter'} by ${Math.abs(s).toFixed(3)} s`);
  }
  if (Number.isFinite(d.peakDb))
    parts.push(
      `differs from ${(d.firstFrame / rate).toFixed(3)} s by at most ${d.peakDb.toFixed(1)} dBFS, ` +
        `${Number.isFinite(d.relativeDb) ? `${(-d.relativeDb).toFixed(1)} dB under the song` : 'where it was silent'}`,
    );
  return parts.join('; ');
}
