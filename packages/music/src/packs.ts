/**
 * The sample libraries an engine is pinned with: each library's instrument maps (as HO[LO] plays
 * them), where its files come from (a git commit, a recipe over published downloads, an archive, or a
 * folder you have) and every file's sha256. Samples are never committed into an experience: its build
 * fetches what its songs play and checks each file against these.
 */
import { type InstrumentManifest, songImpulses } from '@holo/engine';
import type { Instrument, Project } from '@holo/session';

/** A git repository at one commit (GitHub's are fetched file by file, others with git). */
export interface GitSource {
  kind: 'git';
  url: string;
  branch?: string;
  commit: string;
}

/**
 * Files cut out of published downloads: each note from its run, untouched but for a short fade at
 * each end, written as 32-bit float WAV.
 */
export interface CutSource {
  kind: 'cut';
  note?: string;
  /** Prefix of every download's address. */
  base: string;
  /** Each download (path after base) and its sha256. */
  downloads: Record<string, string>;
  /** Frames a second of the downloads and of the files cut from them. */
  rate: number;
  /** Frames faded in and out at each end. */
  fade: number;
  /** Each file: [download, first frame, frames]. */
  cuts: Record<string, [string, number, number]>;
}

/**
 * Files taken out of a published archive (a 7z): each entry decoded from FLAC and written as the PCM
 * WAV ffmpeg writes (its fmt, an INFO list naming the software, then the samples).
 */
export interface ArchiveSource {
  kind: 'archive';
  note?: string;
  /** The archive's address. */
  url: string;
  /** The archive's sha256. */
  sha256: string;
  /** The ISFT tag of the WAVs (the software that first wrote them); none for a bare WAV. */
  software?: string;
  /** Each file: its entry in the archive. */
  entries: Record<string, string>;
}

/** Files only you have: a build takes them from a folder you name (--from), checked all the same. */
export interface LocalSource {
  kind: 'local';
  note?: string;
}

export type PackSource = GitSource | CutSource | ArchiveSource | LocalSource;

export type PackInstrument = Omit<InstrumentManifest, 'pack'> & { title?: string; category?: string };

export interface PackManifest {
  format: 'holo-pack';
  version: 1;
  id: string;
  name: string;
  license: string;
  credit: string;
  source: PackSource;
  root?: string;
  instruments: PackInstrument[];
  impulses?: { name: string; title?: string; file: string }[];
}

export interface PinnedPack extends Omit<PackManifest, 'format' | 'version'> {
  /** sha256 of every file, by its path under the pack's root. */
  files: Record<string, string>;
}

export interface PinnedPacks {
  format: 'holo-packs';
  version: 1;
  packs: PinnedPack[];
}

/** Every file a pack's maps name. */
export function packPaths(pack: Pick<PackManifest, 'instruments' | 'impulses'>): string[] {
  const out = new Set<string>();
  for (const i of pack.instruments) {
    for (const z of i.zones) out.add(z.file);
    for (const f of i.performance?.files ?? []) out.add(f);
  }
  for (const r of pack.impulses ?? []) out.add(r.file);
  return [...out].sort();
}

/** `sha256sum` lines ("<hex>  <path>") as a map. */
export function parseChecksums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trimEnd());
    if (m) out[m[2] as string] = m[1] as string;
  }
  return out;
}

export function formatChecksums(files: Record<string, string>): string {
  return Object.keys(files)
    .sort()
    .map((p) => `${files[p]}  ${p}\n`)
    .join('');
}

/** The pinned libraries as one file: one library to a line, so a new engine's changes read well. */
export function formatPinnedPacks(packs: PinnedPack[]): string {
  const sorted = [...packs].sort((a, b) => a.id.localeCompare(b.id));
  return `{"format":"holo-packs","version":1,"packs":[\n${sorted.map((p) => JSON.stringify(p)).join(',\n')}\n]}\n`;
}

export function parsePinnedPacks(text: string): PinnedPacks {
  const doc = JSON.parse(text) as PinnedPacks;
  if (doc.format !== 'holo-packs' || !Array.isArray(doc.packs)) throw new Error('Not a pinned packs file');
  return doc;
}

/** A pack's instruments, impulses and checksums as one pinned entry. */
export function pinPack(manifest: PackManifest, checksums: Record<string, string>): PinnedPack {
  const { format: _f, version: _v, ...rest } = manifest;
  const files: Record<string, string> = {};
  const missing: string[] = [];
  for (const p of packPaths(manifest)) {
    const sha = checksums[p];
    if (sha) files[p] = sha;
    else missing.push(p);
  }
  if (missing.length) throw new Error(`${manifest.id}: no checksum for ${missing.length} file(s), e.g. ${missing[0]}`);
  return { ...rest, files };
}

/** The pack instruments a song plays (its tracks' and their articulations'). */
export function songInstruments(project: Project): { pack: string; name: string }[] {
  const seen = new Map<string, { pack: string; name: string }>();
  const add = (i: Instrument) => {
    if (i.type === 'sampler' || i.type === 'performance')
      seen.set(`${i.pack}/${i.name}`, { pack: i.pack, name: i.name });
  };
  for (const t of project.tracks) {
    add(t.instrument);
    for (const a of t.articulations) add(a.instrument);
  }
  return [...seen.values()];
}

/** Impulse responses from packs a song's Space Designers and Shimmers play (as the engine asks for them). */
export function songImpulseFiles(project: Project): { pack: string; name: string }[] {
  const out: { pack: string; name: string }[] = [];
  for (const { source } of songImpulses(project, 48000)) if (source.kind === 'file') out.push(source);
  return out;
}

export interface NeededFile {
  pack: PinnedPack;
  path: string;
  sha256: string;
}

/**
 * Every sample file a song can play: each pack instrument's zones and performance files, and its
 * spaces' responses. (A Performance part loads only the files its notes reach; fetching all of an
 * instrument's is a little more than it needs, and the next song may want the rest.)
 */
export function songFiles(project: Project, packs: PinnedPacks): { files: NeededFile[]; problems: string[] } {
  const files = new Map<string, NeededFile>();
  const problems: string[] = [];
  const byId = new Map(packs.packs.map((p) => [p.id, p]));
  const want = (pack: PinnedPack, path: string) => {
    const sha256 = pack.files[path];
    if (!sha256) problems.push(`${pack.id}: ${path} has no checksum in the pinned libraries`);
    else files.set(sha256, { pack, path, sha256 });
  };
  for (const { pack: id, name } of songInstruments(project)) {
    const pack = byId.get(id);
    if (!pack) {
      problems.push(
        `${id}/${name}: "${id}" isn't one of the sample libraries this engine pins (${[...byId.keys()].join(', ')})`,
      );
      continue;
    }
    const inst = pack.instruments.find((i) => i.name === name);
    if (!inst) {
      problems.push(`${id}/${name}: ${pack.name} has no instrument "${name}"`);
      continue;
    }
    for (const z of inst.zones) want(pack, z.file);
    for (const f of inst.performance?.files ?? []) want(pack, f);
  }
  for (const { pack: id, name } of songImpulseFiles(project)) {
    const pack = byId.get(id);
    const ir = pack?.impulses?.find((r) => r.name === name);
    if (!pack || !ir) problems.push(`the space ${id}/${name} isn't in the pinned libraries`);
    else want(pack, ir.file);
  }
  return { files: [...files.values()], problems };
}
