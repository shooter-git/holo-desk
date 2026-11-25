/**
 * A recording held small: 16-bit frames in place of floats, half the memory. A phone's browser allows
 * a page a gigabyte or two, and a song's long takes, decoded, are the most of what it holds.
 *
 * The frames are fitted to the take: its loudest frame decides what one step is worth, always a
 * power of two (over 32768), so the engine plays them exactly as the floats they stand for, and a
 * take whose frames were 16-bit to begin with loses nothing. Any other is rounded to the nearest
 * step, with no dither: it's the copy a phone or a tablet listens to. A bounce reads the files.
 */

/** Steps either side of nothing in a 16-bit frame. */
const FULL = 32768;
/** The powers of two a step may be worth, over FULL: from a take a millionth of full scale to one 32768 times it. */
const LOWEST = -24;
const HIGHEST = 15;
/** Frames gone through before the page is given a moment (a long take is tens of millions). */
const AT_ONCE = 1 << 20;

/**
 * What one 16-bit step is worth for frames between `lo` and `hi` (their lowest and highest values):
 * the smallest power of two, over 32768, at which both fit (-32768 to 32767 steps). Silence is at
 * full scale. Frames past the largest (32768 times full scale) are clipped.
 */
export function scaleFor(lo: number, hi: number): number {
  const fits = (k: number) => hi <= 2 ** k * ((FULL - 1) / FULL) && -lo <= 2 ** k;
  if (!(hi > 0 || lo < 0)) return 1 / FULL;
  let k = LOWEST;
  while (k < HIGHEST && !fits(k)) k++;
  return 2 ** k / FULL;
}

/** A moment for the page between two stretches of work, also where timers are held back (a hidden tab). */
const moment = (): Promise<void> =>
  new Promise((done) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      done();
    };
    channel.port2.postMessage(0);
  });

export interface Compact {
  channels: Int16Array[];
  /** What one step is worth: a frame times this is the float it stands for. */
  scale: number;
}

/**
 * Channels of floats as 16-bit frames (in shared memory when `shared`: every engine reads the one
 * copy), all at one scale. A frame that isn't a number is silence. The floats are only read, a
 * stretch at a time, so a long take doesn't hold the page up.
 */
export async function compactChannels(channels: readonly Float32Array[], shared: boolean): Promise<Compact> {
  let lo = 0;
  let hi = 0;
  for (const data of channels) {
    for (let from = 0; from < data.length; from += AT_ONCE) {
      const to = Math.min(data.length, from + AT_ONCE);
      for (let i = from; i < to; i++) {
        const v = data[i] as number;
        // (NaN is neither; the infinities are left out below)
        if (v < lo) lo = v;
        else if (v > hi) hi = v;
      }
      if (to < data.length) await moment();
    }
  }
  if (lo === Number.NEGATIVE_INFINITY || hi === Number.POSITIVE_INFINITY) [lo, hi] = finiteRange(channels);
  const scale = scaleFor(lo, hi);
  const steps = 1 / scale;
  const out: Int16Array[] = [];
  for (const data of channels) {
    const frames = shared ? new Int16Array(new SharedArrayBuffer(data.length * 2)) : new Int16Array(data.length);
    for (let from = 0; from < data.length; from += AT_ONCE) {
      const to = Math.min(data.length, from + AT_ONCE);
      for (let i = from; i < to; i++) {
        const v = data[i] as number;
        const step = Number.isFinite(v) ? Math.round(v * steps) : 0;
        frames[i] = step > FULL - 1 ? FULL - 1 : step < -FULL ? -FULL : step;
      }
      if (to < data.length) await moment();
    }
    out.push(frames);
  }
  return { channels: out, scale };
}

/** The lowest and highest of the frames that are numbers (a take with an infinity in it: rare enough to go through again). */
function finiteRange(channels: readonly Float32Array[]): [number, number] {
  let lo = 0;
  let hi = 0;
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) {
      const v = data[i] as number;
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      else if (v > hi) hi = v;
    }
  }
  return [lo, hi];
}

/**
 * Whether a clip's audio is held as 16-bit on this device. On a phone or a tablet (`touch`), and
 * only a plain recording's:
 * - not while HO[LO] Engine plays (`remote`): one built before this would play the steps as they are;
 * - not a plugin's data in the song's files (`pluginData`: a drift curve is read as the numbers it holds);
 * - not a recording with note edits, or one whose notes are being edited (`patchBase`): its patches
 *   are rendered from its floats, and join them to the sample.
 */
export function compactClip(o: { touch: boolean; remote: boolean; pluginData: boolean; patchBase: boolean }): boolean {
  return o.touch && !o.remote && !o.pluginData && !o.patchBase;
}
