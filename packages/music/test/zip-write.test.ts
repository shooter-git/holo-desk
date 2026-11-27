/** A ZIP written entry by entry, read back by the archive reader the packs use. */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fileAccess, ZipFile } from '../src/zip.ts';
import { ZipWriter } from '../src/zip-write.ts';

const dir = mkdtempSync(join(tmpdir(), 'holo-zip-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) & 0xff);

describe('writing a ZIP', () => {
  it('stores each file as it is, under its name, in the order given', () => {
    const path = join(dir, 'plain.zip');
    const zip = new ZipWriter(path);
    const files: [string, Uint8Array][] = [
      ['01 Piano.wav', bytes(5000, 1)],
      ['02 Señor Ångström ♭.wav', bytes(1, 2)],
      ['stems/03 Empty.wav', new Uint8Array(0)],
    ];
    for (const [name, data] of files) zip.add(name, data, new Date(2026, 10, 27, 9, 30, 44));
    expect(zip.count).toBe(3);
    zip.close();
    // closing twice is nothing; adding after it is refused
    zip.close();
    expect(() => zip.add('late.wav', bytes(4, 3))).toThrow(/closed/);
    const read = new ZipFile(fileAccess(path));
    expect(read.names()).toEqual(files.map(([name]) => name));
    for (const [name, data] of files) expect(Buffer.from(read.read(name)).equals(Buffer.from(data))).toBe(true);
    read.close();
    // stored: the archive is the files and their headers, nothing packed
    const total = files.reduce((n, [, d]) => n + d.length, 0);
    expect(statSync(path).size).toBeGreaterThan(total);
    expect(statSync(path).size).toBeLessThan(total + 600);
  });

  it('is read the same with the ZIP64 records an archive past 4 GB needs', () => {
    const path = join(dir, 'big.zip');
    const zip = new ZipWriter(path, { zip64: true });
    const files: [string, Uint8Array][] = Array.from({ length: 12 }, (_, i) => [`${i + 1}.wav`, bytes(300 + i, i)]);
    for (const [name, data] of files) zip.add(name, data);
    zip.close();
    const read = new ZipFile(fileAccess(path));
    expect(read.names()).toEqual(files.map(([name]) => name));
    for (const [name, data] of files) expect(Buffer.from(read.read(name)).equals(Buffer.from(data))).toBe(true);
    read.close();
  });

  it('refuses a file with no name, and an empty archive is still one', () => {
    const path = join(dir, 'none.zip');
    const zip = new ZipWriter(path);
    expect(() => zip.add('', bytes(3, 1))).toThrow(/name/);
    expect(() => zip.add('/', bytes(3, 1))).toThrow(/name/);
    zip.close();
    expect(new ZipFile(fileAccess(path)).names()).toEqual([]);
  });
});
