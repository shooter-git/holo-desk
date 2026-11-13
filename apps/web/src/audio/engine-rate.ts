/**
 * The rate the engine plays at on a sound device running at `device` Hz: the device's own up to
 * 48 kHz (or up to the song's rate, when the song asks for more), and no higher. A device set to 96
 * or 192 kHz would have the engine play two or four times as many blocks a second, each as dear as
 * ever, for a song made at 48: the browser brings the sound to the device's rate instead.
 */
export function engineRate(device: number, song?: number): number {
  const most = Math.max(48000, song ?? 0);
  return device > most ? most : device;
}
