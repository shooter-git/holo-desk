/**
 * Bringing your own sample packs in: an SFZ instrument (or a folder of them), a folder of WAV files
 * named by note, or a ZIP of either. The result is a HO[LO] pack: the files copied under the data
 * folder and a holo-pack.json describing every sample's key, velocity, pitch, level and loop.
 */
import {
  closeSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { Pack, PackInstrument, Zone } from './packs.ts';

const AUDIO = new Set(['.wav', '.flac', '.ogg', '.mp3']);

// ---- audio file headers ----

export interface AudioInfo {
  rate: number;
  frames: number;
  channels: number;
}

/** Sample rate and length from a WAV or FLAC header (other formats: their length is found when loaded). */
export function audioInfo(path: string): AudioInfo {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(64 * 1024);
    const n = readSync(fd, head, 0, head.length, 0);
    const b = head.subarray(0, n);
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') {
      let at = 12;
      let rate = 44100;
      let block = 4;
      let channels = 2;
      while (at + 8 <= b.length) {
        const id = b.toString('ascii', at, at + 4);
        const size = b.readUInt32LE(at + 4);
        if (id === 'fmt ') {
          channels = b.readUInt16LE(at + 10) || 2;
          rate = b.readUInt32LE(at + 12);
          block = b.readUInt16LE(at + 20) || 4;
        } else if (id === 'data') {
          const dataSize = Math.min(size, statSync(path).size - at - 8);
          return { rate, frames: Math.floor(dataSize / block), channels };
        }
        at += 8 + size + (size & 1);
      }
      return { rate, frames: 0, channels };
    }
    if (b.toString('ascii', 0, 4) === 'fLaC') {
      // STREAMINFO: sample rate (20 bits) and total samples (36 bits)
      const s = 8;
      const rate = (b.readUInt8(s + 10) << 12) | (b.readUInt8(s + 11) << 4) | (b.readUInt8(s + 12) >> 4);
      const hi = b.readUInt8(s + 13) & 0x0f;
      const frames = hi * 2 ** 32 + b.readUInt32BE(s + 14);
      const channels = ((b.readUInt8(s + 12) >> 1) & 7) + 1;
      return { rate, frames, channels };
    }
    return { rate: 44100, frames: 0, channels: 2 };
  } finally {
    closeSync(fd);
  }
}

// ---- note names ----

const PC: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** "c4", "C#4", "db3", "60": MIDI note numbers (SFZ and most packs: middle C is c4 = 60). */
export function noteNumber(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^([a-g])([#b]?)(-?\d)$/.exec(t);
  if (!m) return null;
  const [, l = 'c', acc, oct = '4'] = m;
  return (Number(oct) + 1) * 12 + (PC[l] ?? 0) + (acc === '#' ? 1 : acc === 'b' ? -1 : 0);
}

// ---- SFZ ----

type Opcodes = Record<string, string>;

function parseSfzText(
  text: string,
  file: string,
  defines = new Map<string, string>(),
): { header: string; ops: Opcodes }[] {
  let src = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // #define $NAME value, #include "file"
  src = src.replace(/#define\s+(\$\w+)\s+(\S+)/g, (_m, k: string, v: string) => {
    defines.set(k, v);
    return '';
  });
  src = src.replace(/#include\s+"([^"]+)"/g, (_m, inc: string) => {
    const p = join(dirname(file), inc.replace(/\\/g, '/'));
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  });
  for (const [k, v] of defines) src = src.split(k).join(v);
  const out: { header: string; ops: Opcodes }[] = [];
  const re = /<(\w+)>|([\w.]+)=([\s\S]*?)(?=\s+[\w.]+=|\s*<|\s*$)/g;
  let current: { header: string; ops: Opcodes } | null = null;
  for (const m of src.matchAll(re)) {
    if (m[1]) {
      current = { header: m[1].toLowerCase(), ops: {} };
      out.push(current);
    } else if (current && m[2]) {
      current.ops[m[2].toLowerCase()] = (m[3] ?? '').trim();
    }
  }
  return out;
}

interface SfzRegion {
  ops: Opcodes;
}

function sfzRegions(file: string): SfzRegion[] {
  const blocks = parseSfzText(readFileSync(file, 'utf8'), file);
  let control: Opcodes = {};
  let global: Opcodes = {};
  let master: Opcodes = {};
  let group: Opcodes = {};
  const regions: SfzRegion[] = [];
  for (const b of blocks) {
    switch (b.header) {
      case 'control':
        control = { ...control, ...b.ops };
        break;
      case 'global':
        global = b.ops;
        master = {};
        group = {};
        break;
      case 'master':
        master = b.ops;
        group = {};
        break;
      case 'group':
        group = b.ops;
        break;
      case 'region':
        regions.push({ ops: { ...control, ...global, ...master, ...group, ...b.ops } });
        break;
    }
  }
  return regions;
}

const num = (v: string | undefined, d: number) => (v === undefined || Number.isNaN(Number(v)) ? d : Number(v));

/** An SFZ instrument as a HO[LO] instrument; its samples are listed so they can be copied. */
export function instrumentFromSfz(file: string): { inst: PackInstrument; files: string[] } {
  const zones: Zone[] = [];
  const files = new Set<string>();
  let release = 0.3;
  let attack = 0.002;
  let oneShot = false;
  let pitched = true;
  for (const { ops } of sfzRegions(file)) {
    if ((ops.trigger ?? 'attack') !== 'attack' || !ops.sample) continue;
    const samplePath = normalize(
      join(dirname(file), (ops.default_path ?? '').replace(/\\/g, '/'), ops.sample.replace(/\\/g, '/')),
    );
    if (!existsSync(samplePath) || !AUDIO.has(extname(samplePath).toLowerCase())) continue;
    files.add(samplePath);
    const key = ops.key !== undefined ? noteNumber(ops.key) : null;
    const lo = noteNumber(ops.lokey ?? '') ?? key ?? 0;
    const hi = noteNumber(ops.hikey ?? '') ?? key ?? 127;
    const center = noteNumber(ops.pitch_keycenter ?? '') ?? key ?? (lo === hi ? lo : 60);
    if (ops.pitch_keytrack === '0') pitched = false;
    const info = audioInfo(samplePath);
    const loopMode = ops.loop_mode ?? ops.loopmode;
    if (loopMode === 'one_shot') oneShot = true;
    release = Math.max(release, num(ops.ampeg_release, 0));
    attack = Math.max(attack, Math.min(0.05, num(ops.ampeg_attack, 0)));
    const looped = loopMode === 'loop_continuous' || loopMode === 'loop_sustain';
    zones.push({
      file: samplePath,
      root: center - num(ops.transpose, 0) - num(ops.tune, 0) / 100,
      lo,
      hi,
      lovel: num(ops.lovel, 1),
      hivel: num(ops.hivel, 127),
      gain: num(ops.volume, 0),
      start: num(ops.offset, 0),
      end: num(ops.end, info.frames),
      loopStart: looped ? num(ops.loop_start ?? ops.loopstart, 0) : 0,
      loopEnd: looped ? num(ops.loop_end ?? ops.loopend, 0) : 0,
      rate: info.rate,
      rr: num(ops.seq_position, 1),
    });
  }
  const name = basename(file, extname(file));
  return {
    inst: {
      name: slug(name),
      title: name.replace(/[_-]+/g, ' ').trim(),
      category: 'Imported',
      pitched,
      release: Math.min(8, release || 0.3),
      attack,
      oneShot,
      velocityRange: zones.some((z) => z.lovel > 1) ? 12 : 20,
      zones,
    },
    files: [...files],
  };
}

// ---- folders of samples named by note ----

const GM_WORDS: [RegExp, number][] = [
  [/kick|bd|bass ?drum/i, 36],
  [/rim|side ?stick|xstick/i, 37],
  [/snare|sd/i, 38],
  [/clap/i, 39],
  [/open.?h(i|at)|oh\b/i, 46],
  [/pedal/i, 44],
  [/h(i|at)|hh|chh/i, 42],
  [/floor|low ?tom/i, 41],
  [/mid ?tom/i, 47],
  [/tom/i, 48],
  [/crash/i, 49],
  [/ride/i, 51],
  [/tamb/i, 54],
  [/cowbell/i, 56],
  [/shak|maraca/i, 70],
  [/conga/i, 63],
  [/bongo/i, 60],
];

const DYN: Record<string, number> = { ppp: 1, pp: 2, p: 3, mp: 4, mf: 5, f: 6, ff: 7, fff: 8 };

function parseName(file: string): { note: number | null; layer: number; rr: number } {
  const stem = basename(file, extname(file));
  const tokens = stem.split(/[\s_\-.()[\]]+/).filter(Boolean);
  let note: number | null = null;
  let layer = 0;
  let rr = 1;
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if (note === null && /^[a-g][#b]?-?\d$/i.test(t)) note = noteNumber(t);
    else if (/^(v|vl|vel|layer)\d+$/i.test(t)) layer = Number(lower.replace(/\D/g, ''));
    else if (/^rr\d+$/i.test(t)) rr = Number(lower.slice(2));
    else if (DYN[lower] !== undefined) layer = DYN[lower] ?? 0;
  }
  if (note === null) {
    const m = /(?:^|[^\d])(\d{2,3})(?:[^\d]|$)/.exec(stem);
    if (m && Number(m[1]) <= 127) note = Number(m[1]);
  }
  return { note, layer, rr };
}

/** One instrument from a folder of samples: pitched if the files are named by note, else a kit. */
export function instrumentFromFolder(dir: string, files: string[]): PackInstrument {
  const parsed = files.map((f) => ({ file: f, ...parseName(f), info: audioInfo(f) }));
  const pitched = parsed.filter((p) => p.note !== null).length >= Math.max(2, parsed.length * 0.6);
  const zones: Zone[] = [];
  if (pitched) {
    const layers = [...new Set(parsed.map((p) => p.layer))].sort((a, b) => a - b);
    const vel = (l: number) => {
      const i = layers.indexOf(l);
      const n = layers.length;
      if (n === 1) return [1, 127];
      return [i === 0 ? 1 : Math.floor((i * 126) / n) + 1, i === n - 1 ? 127 : Math.floor(((i + 1) * 126) / n)];
    };
    for (const l of layers) {
      const here = parsed.filter((p) => p.layer === l && p.note !== null).sort((a, b) => (a.note ?? 0) - (b.note ?? 0));
      const notes = [...new Set(here.map((p) => p.note as number))];
      for (const p of here) {
        const i = notes.indexOf(p.note as number);
        const prev = notes[i - 1];
        const next = notes[i + 1];
        const [lovel = 1, hivel = 127] = vel(l);
        zones.push({
          file: p.file,
          root: p.note as number,
          lo: prev === undefined ? 0 : Math.floor((prev + (p.note as number)) / 2) + 1,
          hi: next === undefined ? 127 : Math.floor(((p.note as number) + next) / 2),
          lovel,
          hivel,
          gain: 0,
          start: 0,
          end: p.info.frames,
          loopStart: 0,
          loopEnd: 0,
          rate: p.info.rate,
          rr: p.rr,
        });
      }
    }
  } else {
    // a kit: each sound on the General MIDI key its name suggests, the rest from C1 up
    const used = new Set<number>();
    let next = 36;
    for (const p of parsed.sort((a, b) => a.file.localeCompare(b.file))) {
      const stem = basename(p.file, extname(p.file));
      let key = GM_WORDS.find(([re, k]) => re.test(stem) && !used.has(k))?.[1];
      while (key === undefined || used.has(key)) {
        key = next++;
        if (!used.has(key)) break;
      }
      used.add(key);
      zones.push({
        file: p.file,
        root: key,
        lo: key,
        hi: key,
        lovel: 1,
        hivel: 127,
        gain: 0,
        start: 0,
        end: p.info.frames,
        loopStart: 0,
        loopEnd: 0,
        rate: p.info.rate,
        rr: 1,
      });
    }
  }
  const name = basename(dir);
  return {
    name: slug(name),
    title: name.replace(/[_-]+/g, ' ').trim(),
    category: pitched ? 'Imported' : 'Imported Kits',
    pitched: true, // a kit's zones sit one per key at their own root, so no sound is shifted
    release: pitched ? 0.4 : 0.6,
    attack: 0.002,
    oneShot: !pitched,
    velocityRange: zones.some((z) => z.lovel > 1) ? 12 : 20,
    zones,
  };
}

// ---- ZIP files ----

/** Unpack a ZIP (stored or deflated entries) into a folder, refusing any path that would escape it. */
export function extractZip(zipPath: string, dest: string): void {
  const buf = readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const root = resolve(dest);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('Damaged ZIP file');
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.startsWith('__MACOSX')) continue;
    const out = resolve(root, name);
    if (!out.startsWith(root + sep)) throw new Error(`Refusing ${name}: it points outside the pack`);
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + compressed);
    mkdirSync(dirname(out), { recursive: true });
    if (method === 0) writeFileSync(out, data);
    else if (method === 8) writeFileSync(out, inflateRawSync(data));
    else throw new Error(`${name} uses a ZIP compression this importer doesn't read (method ${method})`);
  }
}

// ---- the whole import ----

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 48) || 'pack'
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === '__MACOSX') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/**
 * Make a pack from a folder (already unpacked): SFZ files become instruments; folders of samples
 * without SFZ become instruments too. Files are copied into `packsDir/<id>/samples`.
 */
export function importFolder(
  source: string,
  packsDir: string,
  opts: { id?: string; name?: string; license?: string },
): Pack {
  const name = opts.name ?? basename(source).replace(/\.(zip)$/i, '');
  let id = slug(opts.id ?? name);
  while (existsSync(join(packsDir, id))) id = `${id}-2`;
  const all = walk(source);
  const sfz = all.filter((f) => extname(f).toLowerCase() === '.sfz');
  const instruments: PackInstrument[] = [];
  const used = new Set<string>();
  for (const f of sfz) {
    const { inst, files } = instrumentFromSfz(f);
    if (!inst.zones.length) continue;
    for (const x of files) used.add(x);
    instruments.push(inst);
  }
  // samples no SFZ mentions: one instrument per folder
  const loose = all.filter((f) => AUDIO.has(extname(f).toLowerCase()) && !used.has(f));
  const byDir = new Map<string, string[]>();
  for (const f of loose) {
    const d = dirname(f);
    byDir.set(d, [...(byDir.get(d) ?? []), f]);
  }
  for (const [dir, files] of byDir) instruments.push(instrumentFromFolder(dir, files));
  if (!instruments.length) throw new Error('No SFZ instruments or audio files (WAV, FLAC, OGG) were found');
  // unique names, and the files copied into the pack with paths relative to its samples folder
  const names = new Set<string>();
  const target = join(packsDir, id, 'samples');
  for (const inst of instruments) {
    let n = inst.name;
    while (names.has(n)) n = `${n}-2`;
    names.add(n);
    inst.name = n;
    for (const z of inst.zones) {
      const rel = relative(source, z.file).split(sep).join('/');
      const dest = join(target, rel);
      if (!existsSync(dest)) {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(z.file, dest);
      }
      z.file = rel;
    }
  }
  const pack: Pack = {
    id,
    name,
    license: opts.license ?? 'Imported (check its own licence)',
    credit: `Imported from ${basename(source)}.`,
    source: { kind: 'imported', from: basename(source) },
    root: 'samples',
    instruments,
  };
  writeFileSync(
    join(packsDir, id, 'holo-pack.json'),
    `${JSON.stringify({ format: 'holo-pack', version: 1, ...pack }, null, 1)}\n`,
  );
  return pack;
}

/** Save an upload stream to a file. */
export function saveStream(stream: NodeJS.ReadableStream, path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  return new Promise((ok, fail) => {
    const out = createWriteStream(path);
    stream.pipe(out);
    out.on('finish', () => ok());
    out.on('error', fail);
    stream.on('error', fail);
  });
}
