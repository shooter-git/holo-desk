/**
 * The channel strips' layout, wherever they stand in a row (the mixer, the Inspector). The strips
 * share one grid, so every strip's pan, fader, buttons and name sit on the same lines; the fader keeps
 * a share of the height whatever a strip holds, and the slots above it take what's left and scroll.
 * The row tells its style how tall it is, and whether it is too short for all of that at once.
 */

/**
 * A plugin's name on a strip's slot, where there's room for about nine letters: the names that don't
 * fit go by the word a mixer would use. The whole name is the slot's tip and the plugin window's title.
 */
const SLOT_NAMES: Record<string, string> = {
  eq: 'EQ',
  peq: 'Param EQ',
  compressor: 'Comp',
  gate: 'Gate',
  softener: 'Softener',
  reverb: 'Reverb',
  space: 'Space',
  resonance: 'Reson.',
  delay: 'Delay',
  wow: 'Wow',
  rotary: 'Rotary',
  width: 'Width',
  tape: 'Tape',
  saturator: 'Saturate',
  replacer: 'Replacer',
  pitch: 'Pitch',
  arpeggiator: 'Arp',
  harmonizer: 'Harmony',
  scale: 'Scale',
  velocity: 'Velocity',
  drummer: 'Drummer',
};

export function slotName(type: string, name: string): string {
  return SLOT_NAMES[type] ?? name;
}

/**
 * A row of strips, as a ref: its height goes to its style (--strips-h, which the fader's share is
 * worked out from), and under the height its style names (--strips-short) it is marked data-short.
 * A short row holds the strips' feet (fader, buttons, name) as one screen and the rest above it:
 * it opens on the faders.
 */
export function stripRows(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return;
  let short = false;
  const measure = () => {
    const h = el.clientHeight;
    if (!h) return;
    el.style.setProperty('--strips-h', `${h}px`);
    const limit = Number.parseFloat(getComputedStyle(el).getPropertyValue('--strips-short')) || 360;
    const now = h < limit;
    el.toggleAttribute('data-short', now);
    if (now && !short) el.scrollTop = el.scrollHeight;
    short = now;
  };
  const watch = new ResizeObserver(measure);
  watch.observe(el);
  measure();
  return () => watch.disconnect();
}
