import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
  decodeInput,
  formatChecksums,
  loudness,
  onset,
  type PackLock,
  type PackManifest,
  PackMaps,
  packSha256,
  pcmWav,
  peakDb,
  pinPack,
  sha256,
} from '@holo/music';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { BFD_LICENSE, extractZip, importBfd, importFolder, instrumentFromSfz, noteNumber } from '../src/pack-import.ts';
import { installedPack, installPack, packFiles, useShippedMaps } from '../src/pack-install.ts';
import type { PackInstrument, Zone } from '../src/packs.ts';

const work = mkdtempSync(join(tmpdir(), 'holo-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
afterEach(() => useShippedMaps(undefined));

/** A tiny 16-bit mono WAV. */
function wav(path: string, frames = 4410, rate = 44100): void {
  const data = Buffer.alloc(frames * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.concat([head, data]));
}

const RATE = 22050;
/** Frames of silence before each hit (an importer starts its zones just before the onset). */
const PREROLL = 200;

/** A string's 32-bit hash: each file's noise its own, the same on every run (its path in the test's folder). */
function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A drum hit: a burst of noise at `amplitude` dying away, written as a 16-bit mono WAV. */
function hit(path: string, amplitude: number, seconds = 0.4): void {
  let s = seedOf(path.slice(work.length));
  const random = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const frames = Math.round(seconds * RATE);
  const out = new Int32Array(PREROLL + frames);
  for (let i = 0; i < frames; i++)
    out[PREROLL + i] = Math.round((random() * 2 - 1) * amplitude * Math.exp(-i / (0.08 * RATE)) * 32767);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, pcmWav({ rate: RATE, bits: 16, channels: [out] }));
}

/** The zones of one key, by their slot (velocities and round robin): what one hit sounds together. */
function slots(zones: Zone[], key: number): Map<string, Zone[]> {
  const out = new Map<string, Zone[]>();
  for (const z of zones.filter((x) => x.lo === key)) {
    const k = `${z.lovel}-${z.hivel}:${z.rr}`;
    out.set(k, [...(out.get(k) ?? []), z]);
  }
  return out;
}

/** A hit's microphones summed (mono, in the center) and measured as the importer measures them. */
function measure(files: string[]): { level: number; peak: number } {
  const decoded = files.map((f) => decodeInput(new Uint8Array(readFileSync(f))));
  const length = Math.max(...decoded.map((d) => d.channels[0]?.length ?? 0));
  const sum = new Float64Array(length);
  for (const d of decoded) {
    const a = d.channels[0] as Float32Array;
    for (let i = 0; i < a.length; i++) sum[i] = (sum[i] as number) + (a[i] as number);
  }
  const ch = [sum, sum];
  return { level: loudness(ch, RATE, onset(ch, 40), 0.4), peak: peakDb(ch) };
}

describe('pack import', () => {
  it('reads note names as SFZ does (middle C is c4 = 60)', () => {
    expect(noteNumber('c4')).toBe(60);
    expect(noteNumber('F#3')).toBe(54);
    expect(noteNumber('db5')).toBe(73);
    expect(noteNumber('61')).toBe(61);
    expect(noteNumber('h2')).toBeNull();
  });

  it('maps an SFZ instrument: keys, center, tuning, loop mode', () => {
    const dir = join(work, 'sfz');
    wav(join(dir, 'samples', 'a.wav'));
    wav(join(dir, 'samples', 'b.wav'), 8820, 48000);
    writeFileSync(
      join(dir, 'Bells.sfz'),
      `// comment
<control> default_path=samples/
<group> loop_mode=one_shot ampeg_release=1.2
<region> sample=a.wav lokey=c4 hikey=e4 pitch_keycenter=d4
<region> sample=b.wav key=g4 tune=-50 lovel=64`,
    );
    const { inst, files } = instrumentFromSfz(join(dir, 'Bells.sfz'));
    expect(files).toHaveLength(2);
    expect(inst.oneShot).toBe(true);
    expect(inst.release).toBe(1.2);
    expect(inst.zones.map((z) => [z.lo, z.hi, z.root, z.lovel, z.rate, z.end])).toEqual([
      [60, 64, 62, 1, 44100, 4410],
      [67, 67, 67.5, 64, 48000, 8820],
    ]);
  });

  it('turns a folder of unnamed hits into a kit on General MIDI keys', () => {
    const dir = join(work, 'kit-src', 'My Kit');
    for (const n of ['Kick', 'Snare', 'Closed Hat', 'Thing']) wav(join(dir, `${n}.wav`));
    const pack = importFolder(join(work, 'kit-src'), join(work, 'packs'), { name: 'Kit Pack' });
    const kit = pack.instruments[0];
    expect(kit?.category).toBe('Imported Kits');
    expect(Object.fromEntries(kit?.zones.map((z) => [z.file, z.root]) ?? [])).toMatchObject({
      'My Kit/Kick.wav': 36,
      'My Kit/Snare.wav': 38,
      'My Kit/Closed Hat.wav': 42,
    });
    // its pads are named by its files, laid out as the studio's General MIDI pads are
    expect(kit?.pads).toEqual([
      { key: 42, name: 'Closed Hat' },
      { key: 37, name: 'Thing' },
      { key: 38, name: 'Snare' },
      { key: 36, name: 'Kick' },
    ]);
    // one microphone (or none): no microphones of its own
    expect(kit?.mics).toBeUndefined();
    expect(kit?.zones.some((z) => z.mic)).toBe(false);
  });

  it('refuses a ZIP entry that points outside its folder', () => {
    // a stored (uncompressed) zip holding "../escape.txt"
    const name = Buffer.from('../escape.txt');
    const body = Buffer.from('x');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    const cdStart = local.length + name.length + body.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(cdStart, 16);
    const zip = join(work, 'evil.zip');
    writeFileSync(zip, Buffer.concat([local, name, body, central, name, end]));
    expect(() => extractZip(zip, join(work, 'out'))).toThrow(/outside the pack/);
  });

  it('unpacks a ZIP64 archive: its 64-bit end record, sizes and offsets', () => {
    // two entries, stored and deflated, every size and offset in ZIP64's extra field
    const entries = [
      { name: 'kit/a.txt', body: Buffer.from('stored, as it is'), method: 0 },
      { name: 'kit/deep/b.txt', body: Buffer.from('deflated '.repeat(50)), method: 8 },
    ];
    const parts: Buffer[] = [];
    const centrals: Buffer[] = [];
    let at = 0;
    for (const e of entries) {
      const name = Buffer.from(e.name);
      const data = e.method === 8 ? deflateRawSync(e.body) : e.body;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(45, 4);
      local.writeUInt16LE(e.method, 8);
      local.writeUInt32LE(0xffffffff, 18);
      local.writeUInt32LE(0xffffffff, 22);
      local.writeUInt16LE(name.length, 26);
      const offset = at;
      parts.push(local, name, data);
      at += local.length + name.length + data.length;
      const extra = Buffer.alloc(28);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(e.body.length), 4);
      extra.writeBigUInt64LE(BigInt(data.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(45, 4);
      central.writeUInt16LE(45, 6);
      central.writeUInt16LE(e.method, 10);
      central.writeUInt32LE(0xffffffff, 20);
      central.writeUInt32LE(0xffffffff, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt16LE(extra.length, 30);
      central.writeUInt32LE(0xffffffff, 42);
      centrals.push(central, name, extra);
    }
    const cd = Buffer.concat(centrals);
    const cdAt = at;
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(cd.length), 40);
    record.writeBigUInt64LE(BigInt(cdAt), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(cdAt + cd.length), 8);
    locator.writeUInt32LE(1, 16);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0xffff, 8);
    end.writeUInt16LE(0xffff, 10);
    end.writeUInt32LE(0xffffffff, 12);
    end.writeUInt32LE(0xffffffff, 16);
    const zip = join(work, 'big.zip');
    writeFileSync(zip, Buffer.concat([...parts, cd, record, locator, end]));
    const out = join(work, 'zip64-out');
    extractZip(zip, out);
    for (const e of entries) expect(readFileSync(join(out, e.name)).equals(e.body)).toBe(true);
  });

  it('gives your own packs a mine- id, and hard-links their samples into the pack', () => {
    const src = join(work, 'own-src', 'Shakers');
    for (const n of ['Shaker 1', 'Shaker 2']) hit(join(src, `${n}.wav`), 0.3);
    const packsDir = join(work, 'own-packs');
    const a = importFolder(join(work, 'own-src'), packsDir, { name: 'My Shakers' });
    expect(a.id).toBe('mine-my-shakers');
    expect(a.source).toEqual({ kind: 'imported', from: 'own-src' });
    // never mine-mine-, and a second import beside the first
    expect(importFolder(join(work, 'own-src'), packsDir, { id: 'mine-shakers' }).id).toBe('mine-shakers');
    expect(importFolder(join(work, 'own-src'), packsDir, { id: 'Mine Shakers' }).id).toBe('mine-shakers-2');
    // the same file on disk, not a second copy
    const placed = join(packsDir, a.id, 'samples', 'Shakers', 'Shaker 1.wav');
    expect(statSync(placed).ino).toBe(statSync(join(src, 'Shaker 1.wav')).ino);
  });

  it("won't install a pinned pack over one of your own", async () => {
    const packsDir = join(work, 'install-packs');
    await expect(installPack(packsDir, 'mine-drums')).rejects.toThrow(/of your own/);
    // a pinned "rock-kit", and an imported pack that took that folder before ids started with mine-
    const zone = (file: string, key: number) => ({
      file,
      root: key,
      lo: key,
      hi: key,
      lovel: 1,
      hivel: 127,
      gain: 0,
      start: 0,
      end: 100,
      loopStart: 0,
      loopEnd: 0,
      rate: 48000,
    });
    const rock = {
      format: 'holo-pack',
      version: 1,
      id: 'rock-kit',
      name: 'Rock Kit',
      license: 'CC0-1.0',
      credit: 'for the tests',
      source: { kind: 'mix', note: 'made for the tests' },
      root: 'samples',
      instruments: [{ name: 'kit', title: 'Rock Kit', category: 'Drums', zones: [zone('kick/kick_v1.wav', 36)] }],
    } as unknown as PackManifest;
    const sums = Object.fromEntries(packFiles(rock as never).map((f) => [f, sha256(Buffer.from(''))]));
    const files = new Map([
      ['packs/rock-kit/pack.json', `${JSON.stringify(rock, null, 1)}\n`],
      ['packs/rock-kit/files.sha256', formatChecksums(sums)],
    ]);
    const commit = 'c'.repeat(40);
    const lock: PackLock = {
      format: 'holo-packs-lock',
      version: 1,
      repo: 'test/packs',
      commit,
      packs: { 'rock-kit': packSha256(pinPack(rock, sums)) },
    };
    useShippedMaps(
      new PackMaps(lock, null, async (url: string) => {
        const text = files.get(url.replace(`https://raw.githubusercontent.com/test/packs/${commit}/`, ''));
        return { ok: text !== undefined, status: text === undefined ? 404 : 200, text: async () => text ?? '' };
      }),
    );
    const mine = { id: 'rock-kit', name: 'My rock kit', source: { kind: 'imported', from: 'x' }, instruments: [] };
    mkdirSync(join(packsDir, 'rock-kit'), { recursive: true });
    writeFileSync(join(packsDir, 'rock-kit', 'holo-pack.json'), JSON.stringify(mine));
    const from = join(work, 'install-from');
    mkdirSync(from, { recursive: true });
    await expect(installPack(packsDir, 'rock-kit', { from })).rejects.toThrow(/of your own/);
    expect(installedPack(packsDir, 'rock-kit')?.name).toBe('My rock kit');
  });

  it('reads numbers in names as notes only where nothing else can be meant', () => {
    const src = join(work, 'numbers');
    // a drum's numbered takes, and a count: not notes
    for (const n of ['01', '02', '03', '04', '05']) hit(join(src, 'Snare', `Snare ${n}.wav`), 0.04 * Number(n));
    for (const n of ['01', '02', '03']) hit(join(src, 'Pad', `Pad ${n}.wav`), 0.2);
    // files that differ only in a number in a melodic instrument's folder: notes
    for (const n of ['060', '064', '067']) wav(join(src, 'Keys', `Keys ${n}.wav`));
    const pack = importFolder(src, join(work, 'number-packs'), { name: 'Numbers' });
    const by = (name: string) => pack.instruments.find((i) => i.title === name) as PackInstrument;
    const snare = by('Snare');
    expect(snare.pads).toEqual([{ key: 38, name: 'Snare' }]);
    expect(new Set(snare.zones.map((z) => z.root))).toEqual(new Set([38]));
    // its five takes at five levels: five layers, the loudest at the top
    expect(snare.zones.find((z) => z.hivel === 127)?.file).toBe('Snare/Snare 05.wav');
    expect(snare.zones.find((z) => z.lovel === 1)?.file).toBe('Snare/Snare 01.wav');
    // takes of one level are round robins of one layer
    const pad = by('Pad');
    expect(pad.zones.map((z) => [z.lo, z.lovel, z.hivel, z.rr])).toEqual([
      [36, 1, 127, 1],
      [36, 1, 127, 2],
      [36, 1, 127, 3],
    ]);
    const keys = by('Keys');
    expect(keys.zones.map((z) => z.root)).toEqual([60, 64, 67]);
  });

  it('builds a multi-microphone kit: each hit on every microphone, layers by loudness, the snare at -19 dB', () => {
    const kit = join(work, 'mm-src', 'Studio Kit');
    // layer 1 is the loudest, 2 the softest: their velocities come from their loudness, not their names
    const layer: Record<number, number> = { 1: 0.6, 2: 0.05, 3: 0.2 };
    const mic: Record<string, number> = { Close: 1, Top: 1, OH: 0.35, Room: 0.2 };
    for (const v of [1, 2, 3])
      for (const rr of [1, 2]) {
        const a = (layer[v] as number) * (rr === 2 ? 0.97 : 1);
        for (const m of ['Close', 'OH', 'Room']) {
          // microphones in folders of their own
          hit(join(kit, 'Kick', m, `Kick_v${v}_rr${rr}.wav`), a * (mic[m] as number));
          hit(join(kit, 'Tom 1', m, `Tom_v${v}_rr${rr}.wav`), a * 0.8 * (mic[m] as number));
        }
        // microphones named in the files
        for (const m of ['Top', 'OH', 'Room'])
          hit(join(kit, 'Snare', `Snare_${m}_v${v}_rr${rr}.wav`), a * 0.9 * (mic[m] as number));
      }
    const pack = importFolder(join(work, 'mm-src'), join(work, 'mm-packs'), { name: 'Studio' });
    const inst = pack.instruments[0] as PackInstrument;
    expect(pack.instruments).toHaveLength(1);
    expect(inst.mics).toEqual([
      { id: 'close', name: 'Close' },
      { id: 'top', name: 'Snare Top' },
      { id: 'overheads', name: 'Overheads' },
      { id: 'room', name: 'Room' },
    ]);
    expect(inst.pads).toEqual([
      { key: 50, name: 'Tom 1' },
      { key: 38, name: 'Snare' },
      { key: 36, name: 'Kick' },
    ]);
    expect(inst.velocityRange).toBeGreaterThanOrEqual(28);
    expect(inst.velocityRange).toBeLessThanOrEqual(44);
    // one tom: all six of General MIDI's tom keys play it
    expect([...new Set(inst.zones.filter((z) => z.file.startsWith('Studio Kit/Tom 1/')).map((z) => z.lo))]).toEqual([
      41, 43, 45, 47, 48, 50,
    ]);
    const root = join(work, 'mm-packs', pack.id, 'samples');
    for (const [key, mics] of [
      [36, ['close', 'overheads', 'room']],
      [38, ['top', 'overheads', 'room']],
      [50, ['close', 'overheads', 'room']],
    ] as const) {
      const hits = slots(inst.zones, key);
      // three layers, two takes each
      expect(hits.size).toBe(6);
      for (const zones of hits.values()) {
        // every microphone once, sharing everything but the file and the microphone
        expect(zones.map((z) => z.mic)).toEqual(mics);
        const [first] = zones as [Zone];
        for (const z of zones)
          expect([z.lo, z.hi, z.lovel, z.hivel, z.rr, z.gain, z.group, z.offBy, z.start]).toEqual([
            first.lo,
            first.hi,
            first.lovel,
            first.hivel,
            first.rr,
            first.gain,
            first.group,
            first.offBy,
            first.start,
          ]);
        // each starts just before its hit (1.5 ms before its first sample within 40 dB of its peak)
        expect(first.start).toBeGreaterThanOrEqual(PREROLL - Math.round(0.0015 * RATE));
        expect(first.start).toBeLessThan(PREROLL);
        expect(
          new Set(
            zones.map((z) =>
              z.file
                .match(/_v(\d)_rr(\d)/)
                ?.slice(1)
                .join(':'),
            ),
          ).size,
        ).toBe(1);
      }
      // the softest velocities play the softest layer (v2), the hardest the loudest (v1)
      const at = (vel: number) => inst.zones.find((z) => z.lo === key && z.lovel <= vel && vel <= z.hivel);
      expect(at(1)?.file).toMatch(/_v2_/);
      expect(at(64)?.file).toMatch(/_v3_/);
      expect(at(127)?.file).toMatch(/_v1_/);
      // no piece over full scale at velocity 127
      for (const z of inst.zones.filter((x) => x.lo === key && x.hivel === 127 && x.mic === mics[0])) {
        const all = inst.zones.filter((x) => x.lo === key && x.hivel === 127 && x.rr === z.rr);
        expect(measure(all.map((x) => join(root, x.file))).peak + z.gain).toBeLessThanOrEqual(0.01);
      }
    }
    // the snare at velocity 127: -19 dB loudness, unless that would peak over -2 dB
    const top = inst.zones.filter((z) => z.lo === 38 && z.hivel === 127);
    const takes = [...new Set(top.map((z) => z.rr))].map((rr) =>
      measure(top.filter((z) => z.rr === rr).map((z) => join(root, z.file))),
    );
    const gain = top[0]?.gain ?? 0;
    const level = takes.reduce((s, t) => s + t.level, 0) / takes.length + gain;
    const peak = Math.max(...takes.map((t) => t.peak)) + gain;
    expect(peak).toBeLessThanOrEqual(-1.99);
    expect(Math.abs(level + 19) < 0.05 || Math.abs(peak + 2) < 0.05).toBe(true);
  });

  it('puts the hi-hat on its keys, the closed and pedal hats choking the open ones', () => {
    const kit = join(work, 'hat-src', 'Hats');
    // a stray word in a name ("hh" in the kick's) doesn't move a sample out of its piece's folder
    for (const piece of ['Hi-Hat Closed', 'Hi-Hat Open', 'Hi-Hat Pedal', 'Hi-Hat Half', 'Hi-Hat Loose', 'Kick'])
      for (const v of [1, 2]) hit(join(kit, piece, `hh_v${v}.wav`), 0.2 * v);
    const inst = importFolder(join(work, 'hat-src'), join(work, 'hat-packs'), { name: 'Hats' })
      .instruments[0] as PackInstrument;
    const keyOf = (piece: string) => inst.zones.find((z) => z.file.startsWith(`Hats/${piece}/`))?.lo;
    expect(keyOf('Hi-Hat Closed')).toBe(42);
    expect(keyOf('Hi-Hat Pedal')).toBe(44);
    expect(keyOf('Hi-Hat Open')).toBe(46);
    expect(keyOf('Hi-Hat Half')).toBe(26);
    expect(keyOf('Hi-Hat Loose')).toBe(22);
    for (const z of inst.zones) {
      const hat = z.file.startsWith('Hats/Hi-Hat');
      const open = /^Hats\/Hi-Hat (Open|Half|Loose)\//.test(z.file);
      expect([z.group, z.offBy]).toEqual([hat ? 1 : undefined, open ? 1 : undefined]);
    }
    expect(inst.pads?.map((p) => p.name)).toEqual([
      'Hi-Hat Open',
      'Hi-Hat Closed',
      'Kick',
      'Hi-Hat Pedal',
      'Hi-Hat Half',
      'Hi-Hat Loose',
    ]);
  });

  it("reads an SFZ kit's microphones (label_cc), choke groups and random round robins", () => {
    const dir = join(work, 'sfz-mics');
    for (const f of ['hh_cl_a', 'hh_cl_b', 'hh_oh_a', 'hh_oh_b', 'ho_cl', 'ho_oh', 'a', 'b'])
      wav(join(dir, `${f}.wav`));
    writeFileSync(
      join(dir, 'Hats.sfz'),
      `<control> label_cc20=Close label_cc21=Overheads set_cc20=127 set_cc21=64
<global> amplitude_oncc7=100
<group> key=42 group=5 amplitude_oncc20=100
<region> sample=hh_cl_a.wav lorand=0 hirand=0.5
<region> sample=hh_cl_b.wav lorand=0.5 hirand=1
<group> key=42 group=6 amplitude_oncc21=100
<region> sample=hh_oh_b.wav lorand=0.5 hirand=1
<region> sample=hh_oh_a.wav lorand=0 hirand=0.5
<group> key=46 group=7 off_by=5 amplitude_oncc20=100
<region> sample=ho_cl.wav
<group> key=46 group=8 off_by=6 amplitude_oncc21=100
<region> sample=ho_oh.wav
<group> key=44 locc4=100 amplitude_oncc20=100
<region> sample=hh_cl_a.wav`,
    );
    const { inst } = instrumentFromSfz(join(dir, 'Hats.sfz'));
    // a controller on every region (CC 7) is the instrument's volume, not a microphone
    expect(inst.mics).toEqual([
      { id: 'close', name: 'Close' },
      { id: 'overheads', name: 'Overheads', level: -6 },
    ]);
    const z = (f: string) => inst.zones.find((x) => x.file.endsWith(`${f}.wav`) && x.lo !== 44) as Zone;
    // one hit's microphones sound together, each take matched on both
    expect([z('hh_cl_a'), z('hh_oh_a'), z('hh_cl_b'), z('hh_oh_b')].map((x) => [x.mic, x.rr, x.group])).toEqual([
      ['close', 1, 1],
      ['overheads', 1, 1],
      ['close', 2, 1],
      ['overheads', 2, 1],
    ]);
    // the open hat: its own group, choked by the closed hat's (each microphone's SFZ group made one)
    expect([z('ho_cl'), z('ho_oh')].map((x) => [x.mic, x.group, x.offBy])).toEqual([
      ['close', 2, 1],
      ['overheads', 2, 1],
    ]);
    // a region that plays only with the pedal's controller moved isn't played where it starts
    expect(inst.zones.some((x) => x.lo === 44)).toBe(false);

    // a later #define changes only what follows it
    writeFileSync(
      join(dir, 'Seq.sfz'),
      `#define $N a
<region> sample=$N.wav key=60 seq_position=1
#define $N b
<region> sample=$N.wav key=60 seq_position=2`,
    );
    const seq = instrumentFromSfz(join(dir, 'Seq.sfz')).inst;
    expect(seq.mics).toBeUndefined();
    expect(seq.zones.map((x) => [x.file.slice(-5), x.rr])).toEqual([
      ['a.wav', 1],
      ['b.wav', 2],
    ]);
  });

  it('import-bfd writes its inventory to the data folder, and stops at a layout it does not know', () => {
    const dataDir = join(work, 'bfd-data');
    const discs = join(work, 'BFD Discs');
    mkdirSync(join(discs, 'Data'), { recursive: true });
    writeFileSync(join(discs, 'Data', 'kick.bfd'), Buffer.concat([Buffer.from('BFDK'), Buffer.alloc(64, 7)]));
    writeFileSync(join(discs, 'Data', 'snare.bfd'), Buffer.concat([Buffer.from('BFDK'), Buffer.alloc(64, 9)]));
    writeFileSync(join(discs, 'kits.xml'), '<kits/>');
    hit(join(discs, 'Demo', 'groove.wav'), 0.3);
    const r = importBfd(discs, dataDir);
    expect(r.pack).toBeNull();
    expect(r.reason).toMatch(/BFD's own sample format isn't mapped yet/);
    expect(r.reason).toContain(r.inventory);
    expect(r.inventory).toBe(join(dataDir, 'bfd-inventory.txt'));
    const repo = loadConfig().repoDir;
    expect(r.inventory.startsWith(repo)).toBe(false);
    expect(existsSync(join(repo, 'bfd-inventory.txt'))).toBe(false);
    const text = readFileSync(r.inventory, 'utf8');
    expect(text).toMatch(/\.bfd\s+2 files/);
    expect(text).toContain('Data/kick.bfd');
    expect(text).toContain('42 46 44 4b 07 07');
    expect(text).toMatch(/Demo\/groove\.wav: RIFF WAV PCM, 16-bit, 1 channel\(s\), 22050 Hz/);
    expect(existsSync(join(dataDir, 'packs'))).toBe(false);
  });

  it('import-bfd imports plain WAV files in a folder for each piece as a kit of your own', () => {
    const dataDir = join(work, 'bfd-data-2');
    const discs = join(work, 'BFD Plain');
    for (const piece of ['Kick', 'Snare'])
      for (const m of ['Direct', 'OH', 'Amb'])
        hit(join(discs, piece, m, `${piece} v1.wav`), m === 'Direct' ? 0.5 : 0.2);
    const r = importBfd(discs, dataDir, { name: 'Studio' });
    expect(r.pack?.id).toBe('mine-bfd-studio');
    expect(r.pack?.license).toBe(BFD_LICENSE);
    expect(r.pack?.source).toEqual({ kind: 'imported', from: 'BFD Plain' });
    expect(r.pack?.instruments[0]?.mics?.map((m) => m.id)).toEqual(['close', 'overheads', 'ambient']);
    expect(existsSync(join(dataDir, 'packs', 'mine-bfd-studio', 'holo-pack.json'))).toBe(true);
    expect(existsSync(r.inventory)).toBe(true);
  });
});
