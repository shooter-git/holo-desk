/** What an HO[LO] Engine of a given version can do (an older one on a computer plays this studio's songs). */

/** The first HO[LO] Engine with the metronome's sounds: one before it plays the beep whatever is chosen. */
const CLICK_SOUNDS_SINCE = [0, 6, 2];

/** Whether an HO[LO] Engine of this version ("0.6.1") plays the metronome's sounds; one that says none doesn't. */
export function playsClickSounds(version: string): boolean {
  const v = version.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < CLICK_SOUNDS_SINCE.length; i++) {
    const a = v[i] ?? 0;
    const b = CLICK_SOUNDS_SINCE[i] as number;
    if (a !== b) return a > b;
  }
  return true;
}
