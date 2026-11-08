/**
 * The archives sample libraries are published as, unpacked: 7z (held in memory, as FreePats' are
 * small), ZIP (ZIP64 too, a file at a time from disk) and tar, bare or compressed with gzip, bzip2 or
 * xz (streamed, so one of many gigabytes is never held whole). Only the files asked for are kept.
 */
import { createReadStream, readFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { fileSource } from './bytes.ts';
import { Bzip2Reader } from './bzip2.ts';
import { SevenZip } from './sevenzip.ts';
import { TarReader } from './tar.ts';
import { XzReader } from './xz.ts';
import { fileAccess, ZipFile } from './zip.ts';

export type ArchiveFormat = '7z' | 'zip' | 'tar' | 'tar.gz' | 'tar.bz2' | 'tar.xz';

const FORMATS: [RegExp, ArchiveFormat][] = [
  [/\.7z$/i, '7z'],
  [/\.zip$/i, 'zip'],
  [/\.(tar\.gz|tgz)$/i, 'tar.gz'],
  [/\.(tar\.bz2|tbz2?)$/i, 'tar.bz2'],
  [/\.(tar\.xz|txz)$/i, 'tar.xz'],
  [/\.tar$/i, 'tar'],
];

/** An archive's format: as its source says, else from its address's ending. */
export function archiveFormat(url: string, format?: ArchiveFormat): ArchiveFormat {
  if (format) return format;
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  const hit = FORMATS.find(([re]) => re.test(path));
  if (!hit)
    throw new Error(`${url}: not an archive this reads (7z, zip, tar, tar.gz, tar.bz2, tar.xz); name its format`);
  return hit[1];
}

/** The extension an archive is kept in a cache by. */
export function archiveExtension(format: ArchiveFormat): string {
  return `.${format}`;
}

/** Let other work run between pieces of a long unpacking. */
const breathe = () => new Promise<void>((ok) => setImmediate(ok));

/** A compressed file's contents, a piece at a time. */
async function* decompressed(path: string, format: ArchiveFormat): AsyncGenerator<Uint8Array> {
  if (format === 'tar') {
    for await (const chunk of createReadStream(path)) yield chunk as Uint8Array;
    return;
  }
  if (format === 'tar.gz') {
    for await (const chunk of createReadStream(path).pipe(createGunzip())) yield chunk as Uint8Array;
    return;
  }
  const source = fileSource(path);
  try {
    const reader = format === 'tar.bz2' ? new Bzip2Reader(source) : new XzReader(source);
    for (let piece = reader.next(); piece; piece = reader.next()) {
      yield piece;
      await breathe();
    }
  } finally {
    source.close();
  }
}

/**
 * Every wanted file in an archive on disk, each handed to `each` as it's read (in the archive's
 * order). Throws if one isn't there.
 */
export async function unpack(
  path: string,
  format: ArchiveFormat,
  want: Set<string>,
  each: (name: string, data: Uint8Array) => void | Promise<void>,
): Promise<void> {
  const found = new Set<string>();
  const take = async (name: string, data: Uint8Array) => {
    if (found.has(name)) throw new Error(`${name} is in the archive twice`);
    found.add(name);
    await each(name, data);
  };
  if (format === '7z') {
    const archive = new SevenZip(new Uint8Array(readFileSync(path)));
    for (const name of archive.names()) if (want.has(name)) await take(name, archive.read(name));
  } else if (format === 'zip') {
    const zip = new ZipFile(fileAccess(path));
    try {
      for (const name of zip.names()) {
        if (!want.has(name)) continue;
        await take(name, zip.read(name));
        await breathe();
      }
    } finally {
      zip.close();
    }
  } else {
    const tar = new TarReader((name) => want.has(name));
    for await (const piece of decompressed(path, format)) for (const e of tar.push(piece)) await take(e.name, e.data);
    tar.end();
  }
  const missing = [...want].filter((n) => !found.has(n));
  if (missing.length) throw new Error(`${missing.length} file(s) aren't in the archive, e.g. ${missing[0]}`);
}

/** Every file's name in an archive on disk (what a recipe looks through). */
export async function archiveNames(path: string, format: ArchiveFormat): Promise<string[]> {
  if (format === '7z') return new SevenZip(new Uint8Array(readFileSync(path))).names();
  if (format === 'zip') {
    const zip = new ZipFile(fileAccess(path));
    try {
      return zip.names();
    } finally {
      zip.close();
    }
  }
  const names: string[] = [];
  const tar = new TarReader((name) => {
    names.push(name);
    return false;
  });
  for await (const piece of decompressed(path, format)) tar.push(piece);
  tar.end();
  return names;
}
