/**
 * Time-stretching without changing pitch: WSOLA (waveform-similarity overlap-add). The audio is cut
 * into overlapping windows; each next window is taken from near where the stretch says it should come
 * from, at the offset whose shape best continues what was just written, so the waves line up and
 * nothing phases. Good for voices and instruments at ratios from about half to double.
 */
export function stretchAudio(channels: Float32Array[], ratio: number, sr: number): Float32Array[] {
  const first = channels[0];
  if (!first || Math.abs(ratio - 1) < 1e-4) return channels.map((c) => c.slice());
  const len = first.length;
  const N = 2 * Math.round(sr * 0.023); // ~46 ms windows
  const Hs = N / 2; // write hop
  const Ha = Hs / ratio; // read hop
  const tol = Math.round(sr * 0.01); // search ±10 ms
  const outLen = Math.ceil(len * ratio) + N;
  const out = channels.map(() => new Float32Array(outLen));
  const norm = new Float32Array(outLen);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  // the shape comparison runs on a mono copy, 4 times decimated, to stay quick
  const D = 4;
  const mono = new Float32Array(Math.ceil(len / D));
  for (let i = 0; i < mono.length; i++) {
    let s = 0;
    for (const c of channels) s += c[i * D] ?? 0;
    mono[i] = s;
  }
  const at = (i: number) => (i >= 0 && i < mono.length ? (mono[i] as number) : 0);

  let prev = 0; // where the last window was read from
  const frames = Math.floor((outLen - N) / Hs);
  for (let k = 0; k < frames; k++) {
    const target = Math.round(k * Ha);
    let best = target;
    if (k > 0) {
      // the natural continuation of the previous window, and the window near target that matches it best
      const cont = prev + Hs;
      let bestScore = Number.NEGATIVE_INFINITY;
      const span = Math.floor(N / 2 / D);
      for (let d = -tol; d <= tol; d += D) {
        const cand = target + d;
        if (cand < 0 || cand + N > len + N) continue;
        let score = 0;
        const a0 = Math.floor(cand / D);
        const b0 = Math.floor(cont / D);
        for (let j = 0; j < span; j++) score += at(a0 + j) * at(b0 + j);
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }
    }
    const w0 = k * Hs;
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c] as Float32Array;
      const dst = out[c] as Float32Array;
      for (let i = 0; i < N; i++) {
        const s = best + i;
        if (s >= 0 && s < len) dst[w0 + i] = (dst[w0 + i] as number) + (src[s] as number) * (win[i] as number);
      }
    }
    for (let i = 0; i < N; i++) norm[w0 + i] = (norm[w0 + i] as number) + (win[i] as number);
    prev = best;
  }
  const want = Math.round(len * ratio);
  return out.map((o) => {
    for (let i = 0; i < want; i++) {
      const n = norm[i] as number;
      if (n > 1e-3) o[i] = (o[i] as number) / n;
    }
    return o.slice(0, want);
  });
}
