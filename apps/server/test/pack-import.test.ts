import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractZip, importFolder, instrumentFromSfz, noteNumber } from '../src/pack-import.ts';

const work = mkdtempSync(join(tmpdir(), 'holo-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

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

describe('pack import', () => {
  it('reads note names as SFZ does (middle C is c4 = 60)', () => {
    expect(noteNumber('c4')).toBe(60);
    expect(noteNumber('F#3')).toBe(54);
    expect(noteNumber('db5')).toBe(73);
    expect(noteNumber('61')).toBe(61);
    expect(noteNumber('h2')).toBeNull();
  });

  it('maps an SFZ instrument: keys, centre, tuning, loop mode', () => {
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
});
