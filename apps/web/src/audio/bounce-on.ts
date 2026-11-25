/**
 * Where a device's bounces are made (Settings › Audio, kept on the device). A studio renders its own
 * bounce in the page, every instrument's samples loaded there as floats: fine on a computer, more
 * than a phone's browser holds for a big song. The host has the same engine and the same files, and
 * makes the same file.
 */

/** Automatic: the host on a phone or a tablet, this device elsewhere. */
export type BounceOn = 'auto' | 'device' | 'host';

/** Whether a bounce is asked of the host (anything but the three choices counts as Automatic). */
export function bouncesOnHost(choice: unknown, touch: boolean): boolean {
  if (choice === 'host') return true;
  if (choice === 'device') return false;
  return touch;
}
