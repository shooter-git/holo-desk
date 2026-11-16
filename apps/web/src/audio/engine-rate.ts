/**
 * The rate the engine plays at on a sound device running at `device` Hz: the device's own up to
 * 48 kHz (or up to the song's rate, when the song asks for more), and no higher. A device set to 96
 * or 192 kHz would have the engine play two or four times as many blocks a second, each as dear as
 * ever, for a song made at 48: the browser brings the sound to the device's rate instead. A rate
 * `chosen` (Settings › Audio) is the rate, whatever the device runs at.
 */
export function engineRate(device: number, song?: number, chosen?: number | null): number {
  if (chosen) return chosen;
  const most = Math.max(48000, song ?? 0);
  return device > most ? most : device;
}

/**
 * The rate chosen in Settings › Audio: Automatic, or one of its own. The browser brings the sound to
 * the device's rate when it's another.
 */
export type RateChoice = 'auto' | 44100 | 48000;

/**
 * What a choice asks the engine for (null: what engineRate makes of the device's own). Automatic is
 * 44.1 kHz on a touch device, a phone or a tablet: most instruments' samples were recorded at 44.1,
 * and at the engine's own rate they're taken straight from their files, where at another the decoder
 * brings each to it and leaves the browser a copy of every file to clear away. On a phone that was
 * enough for its browser to close the page. Elsewhere Automatic is the device's own rate, as it was.
 */
export function chosenRate(choice: RateChoice, touch: boolean): number | null {
  // (anything but the two rates, as a device remembered from another build, is Automatic)
  if (choice === 44100 || choice === 48000) return choice;
  return touch ? 44100 : null;
}
