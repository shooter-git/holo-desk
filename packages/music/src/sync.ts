/**
 * An experience's packs.json holds the packs its songs play, no more. When a song comes in playing a
 * pack it doesn't hold yet (the studio's Send, a new song, "Hear it as…"), that pack is added as the
 * experience's own engine knows it: the map its catalog names, fetched from the packs repository at
 * the commit the engine was pinned with and checked against that catalog. A pack newer than the
 * engine (not in its catalog) needs `holo update-engine`; an imported pack isn't pinned at all.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Project, parseProject } from '@holo/session';
import { listSongs } from './build.ts';
import { sha256 } from './fetch.ts';
import { type ExperienceManifest, readManifest, writeManifest } from './manifest.ts';
import { PackMaps } from './pack-lock.ts';
import { formatPinnedPacks, type PinnedPack, parsePinnedPacks, songPacks, withRequired } from './packs.ts';

/** Why a pack a song plays isn't pinned. */
export type Unpinned =
  /** newer than the engine: `holo update-engine` */
  | 'newer'
  /** a pack of your own (imported): never pinned */
  | 'imported'
  /** its map couldn't be fetched (no network): Send again later */
  | 'unreachable'
  /** the engine was pinned before packs could be added: `holo update-engine` */
  | 'older-engine';

export interface PackChange {
  added: string[];
  dropped: string[];
  missing: { id: string; why: Unpinned; error?: string }[];
}

/** The packs an experience's songs play (and the songs given), by id. */
export function experiencePacks(sessions: string, extra: Project[] = []): string[] {
  const ids = new Set<string>();
  for (const s of listSongs({ sessions })) {
    try {
      for (const id of songPacks(parseProject(JSON.parse(readFileSync(s.file, 'utf8'))))) ids.add(id);
    } catch {
      // a song that doesn't parse says so when it's built
    }
  }
  for (const p of extra) for (const id of songPacks(p)) ids.add(id);
  return [...ids].sort();
}

export interface SyncOptions {
  /** Where packs' maps are kept (HO[LO]'s data folder's pack-maps), shared with the studio. */
  mapsDir: string | null;
  /** The packs the studio pins (its lock), to tell a pack newer than the engine from an imported one. */
  studioPacks?: Record<string, string>;
  /** Songs not in the sessions folder yet (the studio's own copy of one, for "Hear it as…"). */
  extra?: Project[];
  /** Only add: keep the packs no song plays (while a song is played that isn't sent yet). */
  addOnly?: boolean;
  fetch?: ConstructorParameters<typeof PackMaps>[2];
}

/** Bring an experience's packs.json to the packs its songs play (and the packs those require). */
export async function syncPinnedPacks(root: string, opts: SyncOptions): Promise<PackChange> {
  const change: PackChange = { added: [], dropped: [], missing: [] };
  const manifest = readManifest(root);
  const engine = manifest.engine;
  if (!engine) return change;
  const file = resolve(root, engine.packs);
  const pinned = existsSync(file) ? parsePinnedPacks(readFileSync(file, 'utf8')).packs : [];
  const have = new Map(pinned.map((p) => [p.id, p]));
  const played = experiencePacks(resolve(root, manifest.sessions), opts.extra);
  const { catalog, packsAt } = engine;
  if (!catalog || !packsAt) {
    // an engine from before packs could be added: it pins what it pins
    for (const id of played.filter((x) => !have.has(x)))
      change.missing.push({ id, why: opts.studioPacks?.[id] ? 'older-engine' : 'imported' });
    return change;
  }
  const maps = new PackMaps(
    { format: 'holo-packs-lock', version: 1, repo: packsAt.repo, commit: packsAt.commit, packs: catalog },
    opts.mapsDir,
    ...(opts.fetch ? [opts.fetch] : []),
  );
  // and the packs those require (one whose instruments play another's files brings it)
  const needed = await withRequired(played, async (id) => {
    const map = have.get(id) ?? (catalog[id] ? await maps.get(id).catch(() => null) : null);
    return map?.requires;
  });
  const wanted = needed.filter((id) => !have.has(id));
  const next: PinnedPack[] = pinned.filter((p) => opts.addOnly || needed.includes(p.id));
  for (const p of pinned) if (!next.includes(p)) change.dropped.push(p.id);
  for (const id of wanted) {
    if (!catalog[id]) {
      change.missing.push({ id, why: opts.studioPacks?.[id] ? 'newer' : 'imported' });
      continue;
    }
    try {
      next.push(await maps.get(id));
      change.added.push(id);
    } catch (err) {
      change.missing.push({ id, why: 'unreachable', error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!change.added.length && !change.dropped.length) return change;
  const text = formatPinnedPacks(next);
  writeFileSync(`${file}.part`, text);
  renameSync(`${file}.part`, file);
  const updated: ExperienceManifest = {
    ...manifest,
    engine: { ...engine, packsSha256: sha256(Buffer.from(text)), pinned: next.map((p) => p.id).sort() },
  };
  writeManifest(root, updated);
  return change;
}

/** What a change says, in a line (empty when there's nothing to say). */
export function describePackChange(title: string, c: PackChange, names: (id: string) => string = (id) => id): string {
  const parts: string[] = [];
  if (c.added.length) parts.push(`pins ${c.added.map(names).join(', ')} now`);
  if (c.dropped.length) parts.push(`no longer pins ${c.dropped.map(names).join(', ')} (no song plays it)`);
  const by = (why: Unpinned) => c.missing.filter((m) => m.why === why).map((m) => names(m.id));
  const newer = [...by('newer'), ...by('older-engine')];
  if (newer.length)
    parts.push(
      `can't play ${newer.join(', ')} with its engine: holo update-engine in the project moves it to the studio's`,
    );
  const away = by('unreachable');
  if (away.length) parts.push(`couldn't fetch ${away.join(', ')}'s map (no network?): send it again later`);
  const own = by('imported');
  if (own.length)
    parts.push(
      `${own.join(', ')} ${own.length === 1 ? 'is a pack' : 'are packs'} of your own, which its build can't fetch`,
    );
  return parts.length ? `${title} ${parts.join('; ')}.` : '';
}
