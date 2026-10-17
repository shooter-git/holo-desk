/**
 * An experience's holo.creation.json: the creation manifest HO[LO] already reads (its name, title
 * and sessions folder), with the engine it builds its music with and how.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineIdentity } from './identity.ts';

/** The engine an experience carries, as its manifest records it. */
export interface PinnedEngine extends EngineIdentity {
  /** The Node.js version its music builds with (exactly), so a rebuild is the same on any computer. */
  node: string;
  /** The pinned renderer, relative to the experience's root. */
  file: string;
  /** sha256 of that file. */
  sha256: string;
  /** The pinned sample libraries' maps and checksums, relative to the root. */
  packs: string;
  /** sha256 of that file. */
  packsSha256: string;
}

export interface BuildSettings {
  /** Where the built songs go, relative to the root. */
  out: string;
  /** "wav": 32-bit float, exactly the engine's numbers; "wav24": 24-bit PCM. */
  format: 'wav' | 'wav24';
  /** Frames a second; each song's own rate (48000 when it has none) unless set. */
  rate?: number;
  /** Seconds after a song's end for its reverb and ringing notes (a loop has its own tail). */
  tail: number;
}

export interface ExperienceManifest {
  format: 'holo-creation';
  version: 1;
  name: string;
  title: string;
  /** Folder of the songs (<piece>.holo.json), relative to the root. */
  sessions: string;
  exportHelp?: string;
  renderHelp?: string;
  render?: { command: string[]; env?: Record<string, string>; output: string };
  engine?: PinnedEngine;
  build?: BuildSettings;
}

export const MANIFEST = 'holo.creation.json';

export const DEFAULT_BUILD: BuildSettings = { out: 'music/build', format: 'wav', tail: 4 };

export function readManifest(root: string): ExperienceManifest {
  const file = join(root, MANIFEST);
  if (!existsSync(file)) throw new Error(`No ${MANIFEST} in ${root}: set the project up with \`holo init\``);
  const m = JSON.parse(readFileSync(file, 'utf8')) as ExperienceManifest;
  if (m.format !== 'holo-creation') throw new Error(`${file} isn't a HO[LO] creation manifest`);
  return m;
}

export function writeManifest(root: string, m: ExperienceManifest): void {
  writeFileSync(join(root, MANIFEST), `${JSON.stringify(m, null, 2)}\n`);
}

/** A creation's name: lower case, digits, - and _ (what the studio accepts). */
export const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A name from a title: "Night Window" → "night-window". */
export function slug(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
      .replace(/-+$/, '') || 'song'
  );
}

/** A title from a name: "night-window" → "Night Window". */
export function titleOf(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(' ');
}
