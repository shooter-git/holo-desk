/**
 * A key written short, for the display on a phone on its side. Here in the studio rather than in the
 * session package: what's in the session package is part of what HO[LO] Engine plays, so a change
 * there would ask for a new Engine download, and this only shows a key.
 */
import { parseKey } from '@holo/session';

/**
 * A key's text as a chord chart writes it, for a display with little room: "D major" as "D", "F#
 * minor" as "F#m", "A lydian" as "A lyd". The tonic keeps the text's spelling; a text that names no
 * key comes back as it is.
 */
export function keyShort(text: string): string {
  const k = parseKey(text);
  const tonic = /^\s*([A-Ga-g][#b♯♭]*)/.exec(text)?.[1];
  if (!k || !tonic) return text;
  const name = tonic.charAt(0).toUpperCase() + tonic.slice(1);
  return name + (k.mode === 'major' ? '' : k.mode === 'minor' ? 'm' : ` ${k.mode.slice(0, 3)}`);
}
