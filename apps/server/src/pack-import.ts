/**
 * Bringing your own sample packs in: an SFZ instrument (or a folder of them), a folder of WAV files
 * named by note, a drum kit's folder (a folder for each piece, its microphones in folders of their own
 * or named in its files), or a ZIP of any of them. The result is a HO[LO] pack of your own, its id
 * starting with mine-: the files hard-linked (else copied) under the data folder, and a holo-pack.json
 * describing every sample's key, velocity, pitch, level, loop and microphone, and what sets it off (a key
 * struck or let go, the sustain pedal going down or coming up).
 */
import {
  closeSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { type DecodedInput, decodeInput, loudness, onset, peakDb, spreadLayers } from '@holo/music';
import { MIC_OFF, type SampleMic } from '@holo/session';
import type { Pack, PackInstrument, Zone } from './packs.ts';

const AUDIO = new Set(['.wav', '.flac', '.ogg', '.mp3']);
/** The files a kit's hits are measured from (decoded here); others play, placed by their names alone. */
const DECODABLE = new Set(['.wav', '.flac']);

// ---- audio file headers ----

export interface AudioInfo {
  rate: number;
  frames: number;
  channels: number;
}

function readHead(path: string, bytes: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(bytes);
    return head.subarray(0, readSync(fd, head, 0, head.length, 0));
  } finally {
    closeSync(fd);
  }
}

/** Sample rate and length from a WAV or FLAC header (other formats: their length is found when loaded). */
export function audioInfo(path: string): AudioInfo {
  const b = readHead(path, 64 * 1024);
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
}

/** An AIFF header's sample rate: an 80-bit extended float. */
function extended80(b: Buffer, at: number): number {
  const exp = ((b.readUInt8(at) & 0x7f) << 8) | b.readUInt8(at + 1);
  const mantissa = b.readUInt32BE(at + 2) * 2 ** 32 + b.readUInt32BE(at + 6);
  if (!exp && !mantissa) return 0;
  return (b.readUInt8(at) & 0x80 ? -1 : 1) * mantissa * 2 ** (exp - 16383 - 63);
}

/** What an audio file's header says (format, bits, channels, rate, length): for the BFD inventory. */
export function describeAudio(path: string): string {
  const b = readHead(path, 64 * 1024);
  const tag = (at: number) => b.toString('latin1', at, at + 4);
  const length = (frames: number, rate: number) => (rate ? `${(frames / rate).toFixed(2)} s` : '?');
  if (b.length >= 12 && (tag(0) === 'RIFF' || tag(0) === 'RF64') && tag(8) === 'WAVE') {
    const chunks: string[] = [];
    let at = 12;
    let fmt = '';
    let block = 0;
    let rate = 0;
    while (at + 8 <= b.length) {
      const id = tag(at);
      const size = b.readUInt32LE(at + 4);
      chunks.push(id.trim());
      if (id === 'fmt ' && at + 24 <= b.length) {
        const format = b.readUInt16LE(at + 8);
        const channels = b.readUInt16LE(at + 10);
        rate = b.readUInt32LE(at + 12);
        block = b.readUInt16LE(at + 20);
        const bits = b.readUInt16LE(at + 22);
        const kind =
          format === 1 ? 'PCM' : format === 3 ? 'float' : format === 0xfffe ? 'extensible' : `format ${format}`;
        fmt = `${tag(0)} WAV ${kind}, ${bits}-bit, ${channels} channel(s), ${rate} Hz`;
      } else if (id === 'data') {
        const frames = block ? Math.floor(Math.min(size, statSync(path).size - at - 8) / block) : 0;
        return `${fmt || `${tag(0)} WAV`}, ${length(frames, rate)} (chunks: ${chunks.join(' ')})`;
      }
      at += 8 + size + (size & 1);
    }
    return `${fmt || `${tag(0)} WAV`} (chunks: ${chunks.join(' ')}; no data chunk in its first 64 KB)`;
  }
  if (b.length >= 12 && tag(0) === 'FORM' && (tag(8) === 'AIFF' || tag(8) === 'AIFC')) {
    let at = 12;
    while (at + 8 <= b.length) {
      const id = tag(at);
      const size = b.readUInt32BE(at + 4);
      if (id === 'COMM' && at + 26 <= b.length) {
        const channels = b.readUInt16BE(at + 8);
        const frames = b.readUInt32BE(at + 10);
        const bits = b.readUInt16BE(at + 14);
        const rate = extended80(b, at + 16);
        const compression = tag(8) === 'AIFC' && at + 30 <= b.length ? ` (${tag(at + 26)})` : '';
        return `${tag(8)}${compression}, ${bits}-bit, ${channels} channel(s), ${rate} Hz, ${length(frames, rate)}`;
      }
      at += 8 + size + (size & 1);
    }
    return `${tag(8)} without a COMM chunk in its first 64 KB`;
  }
  if (tag(0) === 'fLaC') {
    const i = audioInfo(path);
    return `FLAC, ${i.channels} channel(s), ${i.rate} Hz, ${length(i.frames, i.rate)}`;
  }
  return 'not a WAV, AIFF or FLAC header';
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

/**
 * An SFZ file's text as a player reads it: comments gone, each #include read in where it stands (its
 * path from the .sfz file's folder, in included files too), and each $variable replaced by its #define
 * at that point. A later #define changes only what follows it: multi-file kits define $RR or $MIC again
 * before each include of the same region list.
 */
function preprocessSfz(text: string, base: string, defines: Map<string, string>, depth = 0): string {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // the longest name defined ("$MIC_$ART" is $MIC and an underscore, then $ART)
  const put = (s: string) =>
    s.replace(/\$\w+/g, (m) => {
      for (let n = m.length; n > 1; n--) {
        const v = defines.get(m.slice(0, n));
        if (v !== undefined) return v + m.slice(n);
      }
      return m;
    });
  return src.replace(/#define\s+(\$\w+)\s+(\S+)|#include\s+"([^"]+)"|\$\w+/g, (m, name, value, inc) => {
    if (name) {
      defines.set(name as string, put(value as string));
      return '';
    }
    if (inc) {
      const p = join(base, put(inc as string).replace(/\\/g, '/'));
      if (depth > 16 || !existsSync(p) || !statSync(p).isFile()) return '';
      return preprocessSfz(readFileSync(p, 'utf8'), base, defines, depth + 1);
    }
    return put(m);
  });
}

function parseSfzText(file: string): { header: string; ops: Opcodes }[] {
  const src = preprocessSfz(readFileSync(file, 'utf8'), dirname(file), new Map());
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

/**
 * Every region with the headers above it applied, the control header's settings (labels, defaults), and
 * each region's group: the header block it's under (each <global>, <master> or <group> starts one).
 */
function sfzRegions(file: string): { regions: Opcodes[]; control: Opcodes; groupOf: number[] } {
  const blocks = parseSfzText(file);
  let control: Opcodes = {};
  let global: Opcodes = {};
  let master: Opcodes = {};
  let group: Opcodes = {};
  let block = 0;
  const regions: Opcodes[] = [];
  const groupOf: number[] = [];
  for (const b of blocks) {
    switch (b.header) {
      case 'control':
        control = { ...control, ...b.ops };
        break;
      case 'global':
        global = b.ops;
        master = {};
        group = {};
        block++;
        break;
      case 'master':
        master = b.ops;
        group = {};
        block++;
        break;
      case 'group':
        group = b.ops;
        block++;
        break;
      case 'region':
        regions.push({ ...control, ...global, ...master, ...group, ...b.ops });
        groupOf.push(block);
        break;
    }
  }
  return { regions, control, groupOf };
}

const num = (v: string | undefined, d: number) => (v === undefined || Number.isNaN(Number(v)) ? d : Number(v));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/** Opcodes by which a controller sets a region's level: in percent of its amplitude, or in dB. */
const LEVEL_CC = /^(amplitude_oncc|amplitude_cc|gain_cc|gain_oncc|volume_oncc)(\d+)$/;

/** The controllers that set a region's level (a multi-microphone kit's faders), and how much each moves it. */
function levelCcs(ops: Opcodes): Map<number, { db: boolean; depth: number }> {
  const out = new Map<number, { db: boolean; depth: number }>();
  for (const [k, v] of Object.entries(ops)) {
    const m = LEVEL_CC.exec(k);
    if (!m || !num(v, 0)) continue;
    out.set(Number(m[2]), { db: !(m[1] ?? '').startsWith('amplitude'), depth: num(v, 0) });
  }
  return out;
}

/** What players start a controller at (volume, pan and expression have their MIDI defaults). */
const CC_START: Record<number, number> = { 7: 100 / 127, 10: 64 / 127, 11: 1 };

/** A controller's value (0 to 1) before anything moves it: set_hdccN or set_ccN, else null. */
function ccDefault(ops: Opcodes, control: Opcodes, cc: number): number | null {
  const hd = ops[`set_hdcc${cc}`] ?? control[`set_hdcc${cc}`];
  if (hd !== undefined) return clamp(num(hd, 0), 0, 1);
  const v = ops[`set_cc${cc}`] ?? control[`set_cc${cc}`];
  if (v !== undefined) return clamp(num(v, 0) / 127, 0, 1);
  return null;
}

/** What sets a region off: a key struck or let go, or the sustain pedal going down or coming up. */
type RegionTrigger = 'attack' | 'release' | 'pedalDown' | 'pedalUp';

const ON_CC = /^on_(lo|hi)(hd)?cc(\d+)$/;

/**
 * What sets a region off, or null for what HO[LO] doesn't play (a legato or first-note region, or one a
 * controller other than the sustain pedal sets off). A region the pedal's controller (CC 64) sets off
 * as it moves into a range (on_locc64, on_hicc64) is the pedal's own sound: going down into its upper
 * half, coming up into its lower half.
 */
function regionTrigger(ops: Opcodes): RegionTrigger | null {
  const on = Object.keys(ops).filter((k) => ON_CC.test(k));
  if (on.length) {
    let lo = 0;
    let hi = 1;
    for (const k of on) {
      const [, side, hd, cc] = ON_CC.exec(k) as RegExpExecArray;
      if (cc !== '64') return null;
      const v = hd ? num(ops[k], 0) : num(ops[k], 0) / 127;
      if (side === 'lo') lo = v;
      else hi = v;
    }
    if (lo >= 0.5 - 1e-9) return 'pedalDown';
    if (hi < 0.5 - 1e-9) return 'pedalUp';
    return null;
  }
  const t = ops.trigger ?? 'attack';
  if (t === 'attack') return 'attack';
  if (t === 'release' || t === 'release_key') return 'release';
  return null;
}

/**
 * Whether a region plays with the controllers where they start, and the key switch its SFZ starts on: a
 * hi-hat's pedal positions, say, are regions on one key that each need the pedal's controller in a
 * range. A microphone's own fader (a controller setting its level) doesn't count: its microphone is
 * there at whatever level. A region a controller sets off as it moves (on_locc) plays only then (the
 * pedal's own sounds are read by regionTrigger, and checked here without those opcodes).
 */
function playsAtStart(ops: Opcodes, control: Opcodes, faders: Map<number, unknown>): boolean {
  if (Object.keys(ops).some((k) => ON_CC.test(k))) return false;
  const sw = noteNumber(ops.sw_default ?? control.sw_default ?? '');
  if (sw !== null) {
    const last = ops.sw_last !== undefined ? noteNumber(ops.sw_last) : null;
    const lo = noteNumber(ops.sw_lolast ?? '') ?? last;
    const hi = noteNumber(ops.sw_hilast ?? '') ?? last;
    if ((lo !== null && sw < lo) || (hi !== null && sw > hi)) return false;
  }
  for (const [k, v] of Object.entries(ops)) {
    const m = /^(lo|hi)(hd)?cc(\d+)$/.exec(k);
    if (!m) continue;
    const cc = Number(m[3]);
    if (faders.has(cc)) continue;
    const at = ccDefault(ops, control, cc) ?? CC_START[cc] ?? 0;
    const bound = m[2] ? num(v, 0) : num(v, 0) / 127;
    if (m[1] === 'lo' ? at < bound - 1e-9 : at > bound + 1e-9) return false;
  }
  return true;
}

/**
 * Release samples a player sounds together (a damper's thud and a key's knock, both on the key let go)
 * as parts of their own: the engine sounds one of each part, its zone nearest the key let go, and a
 * part's tied zones take turns. A family of release samples (an SFZ group, an EXS group) stays in one
 * part, so a part covers the keys its families do; families that overlap (one microphone, the same
 * round robin, keys and velocities in common) can't share one.
 */
export function numberReleaseParts(zones: Zone[], familyOf: (zone: Zone, index: number) => number | string): void {
  const families = new Map<string, Zone[]>();
  zones.forEach((z, i) => {
    if (z.trigger !== 'release') return;
    const k = String(familyOf(z, i));
    families.set(k, [...(families.get(k) ?? []), z]);
  });
  const clash = (a: Zone, b: Zone) =>
    (a.mic ?? '') === (b.mic ?? '') &&
    a.rr === b.rr &&
    a.lo <= b.hi &&
    b.lo <= a.hi &&
    a.lovel <= b.hivel &&
    b.lovel <= a.hivel;
  const parts: Zone[][] = [];
  for (const family of families.values()) {
    let p = parts.findIndex((part) => !family.some((z) => part.some((o) => clash(z, o))));
    if (p < 0) {
      p = parts.length;
      parts.push([]);
    }
    (parts[p] as Zone[]).push(...family);
    for (const z of family) {
      if (p) z.part = p;
      else delete z.part;
    }
  }
}

/** An SFZ instrument as a HO[LO] instrument; its samples are listed so they can be copied. */
export function instrumentFromSfz(file: string): { inst: PackInstrument; files: string[] } {
  const { regions, control, groupOf } = sfzRegions(file);
  interface Found {
    zone: Zone;
    ops: Opcodes;
    /** The SFZ group it's under (a family of release samples stays in one part). */
    family: number;
    faders: Map<number, { db: boolean; depth: number }>;
    take: [number, number];
    group: number;
    offBy: number;
  }
  const found: Found[] = [];
  const files = new Set<string>();
  let release = 0.3;
  let attack = 0.002;
  let oneShot = false;
  let pitched = true;
  for (const [index, ops] of regions.entries()) {
    const trigger = regionTrigger(ops);
    if (!trigger || !ops.sample) continue;
    const faders = levelCcs(ops);
    const pedal = trigger === 'pedalDown' || trigger === 'pedalUp';
    const atStart = pedal ? Object.fromEntries(Object.entries(ops).filter(([k]) => !ON_CC.test(k))) : ops;
    if (!playsAtStart(atStart, control, faders)) continue;
    const samplePath = normalize(
      join(dirname(file), (ops.default_path ?? '').replace(/\\/g, '/'), ops.sample.replace(/\\/g, '/')),
    );
    if (!existsSync(samplePath) || !AUDIO.has(extname(samplePath).toLowerCase())) continue;
    files.add(samplePath);
    const key = ops.key !== undefined ? noteNumber(ops.key) : null;
    // the pedal's own sound is on no key: it plays whatever is held
    const lo = pedal ? 0 : (noteNumber(ops.lokey ?? '') ?? key ?? 0);
    const hi = pedal ? 127 : (noteNumber(ops.hikey ?? '') ?? key ?? 127);
    const center = noteNumber(ops.pitch_keycenter ?? '') ?? key ?? (lo === hi ? lo : 60);
    const untracked = ops.pitch_keytrack === '0';
    const info = audioInfo(samplePath);
    const loopMode = ops.loop_mode ?? ops.loopmode;
    if (trigger === 'attack') {
      // how the instrument plays is its struck notes': a key's release noise doesn't make it a drum
      if (untracked) pitched = false;
      if (loopMode === 'one_shot') oneShot = true;
      release = Math.max(release, num(ops.ampeg_release, 0));
      attack = Math.max(attack, Math.min(0.05, num(ops.ampeg_attack, 0)));
    }
    const looped = loopMode === 'loop_continuous' || loopMode === 'loop_sustain';
    const pan = clamp(num(ops.pan, 0) / 100, -1, 1);
    const zone: Zone = {
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
      rr: 1,
      ...(trigger !== 'attack' ? { trigger } : {}),
      // a release sample quietens the longer its note was held (dB a second)
      ...(trigger === 'release' && ops.rt_decay !== undefined ? { decay: num(ops.rt_decay, 0) } : {}),
      ...(pan ? { pan } : {}),
    };
    const base = {
      ops,
      family: groupOf[index] ?? 0,
      faders,
      // its turn: seq_position, then where it sits in the random range (lorand/hirand)
      take: [num(ops.seq_position, 1), num(ops.lorand, 0)] as [number, number],
      group: Math.trunc(num(ops.group, 0)),
      offBy: Math.trunc(num(ops.off_by, 0)),
    };
    // a release noise that doesn't follow the key (a key coming back up): each key plays it as it is
    if (trigger === 'release' && untracked && lo !== hi) {
      for (let k = lo; k <= hi; k++) found.push({ ...base, zone: { ...zone, root: k, lo: k, hi: k } });
    } else found.push({ ...base, zone });
  }

  // microphones: a region whose level controllers set is one microphone's, each set of controllers
  // one microphone (a controller on every region is the instrument's own volume, not a microphone)
  // (read from the struck notes: a pedal's own sound in a block of its own needn't have the volume's)
  const struck = found.filter((f) => !f.zone.trigger);
  const basis = struck.length ? struck : found;
  const common = [...(basis[0]?.faders.keys() ?? [])].filter((cc) => basis.every((f) => f.faders.has(cc)));
  const micKey = (f: Found) =>
    [...f.faders.keys()]
      .filter((cc) => !common.includes(cc))
      .sort((a, b) => a - b)
      .join(',');
  const keys = [...new Set(found.map(micKey))].filter(Boolean);
  const micId = new Map<string, string>();
  const mics: SampleMic[] = [];
  if (keys.length >= 2) {
    // named by their controllers' labels, the controller fewest regions share first ("Kick In (Direct)")
    const uses = new Map<number, number>();
    for (const f of found) for (const cc of f.faders.keys()) uses.set(cc, (uses.get(cc) ?? 0) + 1);
    const label = (cc: number) => (control[`label_cc${cc}`] ?? '').trim() || `CC ${cc}`;
    for (const key of keys) {
      const ccs = key
        .split(',')
        .map(Number)
        .sort((a, b) => (uses.get(a) ?? 0) - (uses.get(b) ?? 0) || a - b);
      const [first = 'Microphone', ...more] = ccs.map(label);
      const name = more.length ? `${first} (${more.join(', ')})` : first;
      let id = slug(name);
      for (let n = 2; mics.some((m) => m.id === id); n++) id = `${slug(name)}-${n}`;
      micId.set(key, id);
      // its level where the SFZ starts its faders (one it leaves unset starts at full)
      const one = found.find((f) => micKey(f) === key) as Found;
      let level = 0;
      for (const cc of ccs) {
        const how = one.faders.get(cc) ?? { db: false, depth: 100 };
        const v = ccDefault(one.ops, control, cc) ?? 1;
        level += how.db ? v * how.depth : 20 * Math.log10(Math.max(1e-6, (v * how.depth) / 100));
      }
      level = round(clamp(level, MIC_OFF, 12), 1);
      mics.push({ id, name, ...(level ? { level } : {}) });
    }
  }

  // round robins: on each key and velocity range, every distinct turn (seq_position, lorand) in order,
  // numbered alike on every microphone so a hit's microphones play the same take (a key's release and
  // pedal samples take turns among their own)
  const slot = (z: Zone) => `${z.trigger ?? ''}:${z.lo}:${z.hi}:${z.lovel}:${z.hivel}`;
  const turns = new Map<string, [number, number][]>();
  for (const f of found) {
    const list = turns.get(slot(f.zone)) ?? [];
    if (!list.some(([s, r]) => s === f.take[0] && r === f.take[1])) list.push(f.take);
    turns.set(slot(f.zone), list);
  }
  for (const list of turns.values()) list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const f of found)
    f.zone.rr = (turns.get(slot(f.zone)) ?? []).findIndex(([s, r]) => s === f.take[0] && r === f.take[1]) + 1;

  // choke groups: the zones one hit sounds share a group (an SFZ gives each microphone's regions a
  // group of their own), numbered from 1; off_by keeps pointing at whatever group it named
  const up = new Map<number, number>();
  const find = (g: number): number => {
    const p = up.get(g);
    if (p === undefined || p === g) return g;
    const r = find(p);
    up.set(g, r);
    return r;
  };
  const hits = new Map<string, Found[]>();
  for (const f of found) {
    const k = `${slot(f.zone)}|${f.zone.rr}`;
    hits.set(k, [...(hits.get(k) ?? []), f]);
  }
  for (const hit of hits.values()) {
    const gs = hit.map((f) => f.group).filter((g) => g !== 0);
    for (const g of gs.slice(1)) {
      const a = find(gs[0] as number);
      const b = find(g);
      if (a !== b) up.set(Math.max(a, b), Math.min(a, b));
    }
  }
  const groups = [...new Set(found.filter((f) => f.group !== 0).map((f) => find(f.group)))].sort((a, b) => a - b);
  const groupNo = new Map(groups.map((g, i) => [g, i + 1]));
  for (const hit of hits.values()) {
    const g = hit.find((f) => f.group !== 0)?.group;
    const off = hit.find((f) => f.offBy !== 0 && groupNo.has(find(f.offBy)))?.offBy;
    // a hit's microphones at one level (the SFZ's own differences between them averaged)
    const gain = mics.length ? round(hit.reduce((s, f) => s + f.zone.gain, 0) / hit.length, 2) : null;
    for (const f of hit) {
      if (g !== undefined) f.zone.group = groupNo.get(find(g)) as number;
      if (off !== undefined) f.zone.offBy = groupNo.get(find(off)) as number;
      if (gain !== null) f.zone.gain = gain;
      const id = micId.get(micKey(f));
      if (id) f.zone.mic = id;
    }
  }

  const zones = found.map((f) => f.zone);
  numberReleaseParts(zones, (_, i) => (found[i] as Found).family);
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
      velocityRange: zones.some((z) => !z.trigger && z.lovel > 1) ? 12 : 20,
      ...(mics.length ? { mics } : {}),
      zones,
    },
    files: [...files],
  };
}

// ---- the words in sample names ----

/**
 * A name's words: split at spaces and _ - . ( ) [ ] + , &, and between a lower-case letter and a
 * capital ("KickIn", "SnareTop").
 */
function words(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.()[\]+,&]+/)
    .filter(Boolean);
}

const LAYER = /^(v|vl|vel|velo|velocity|layer|lyr|dyn)(\d+)$/;
const RR = /^(rr|rnd|alt|take|tk|var|seq|hit)(\d+)$/;
const NOTE = /^[a-g][#b]?-?\d$/i;
const DYN: Record<string, number> = {
  ppp: 1,
  pp: 2,
  p: 3,
  mp: 4,
  mf: 5,
  f: 6,
  ff: 7,
  fff: 8,
  ghost: 1,
  soft: 3,
  light: 3,
  medium: 5,
  med: 5,
  hard: 7,
  loud: 7,
  accent: 8,
};

/** Drum pieces by the words that name them, in the order a name with two is read ("ride bell", "crash ride"). */
const PIECES: [RegExp, string][] = [
  [/^(hat|hats|hihat|hihats|hh|chh|ohh|phh|hhc|hho|hhp)$/, 'hat'],
  [/^rides?$/, 'ride'],
  [/^(china|chinas|chinese)$/, 'china'],
  [/^splash(es)?$/, 'splash'],
  [/^crash(es)?$/, 'crash'],
  [/^stacks?$/, 'stack'],
  [/^(cymbal|cymbals|cym|cyms)$/, 'cymbal'],
  [/^(kick|kicks|kik|kck|bd|bassdrum|kickdrum)$/, 'kick'],
  [/^(snare|snares|snr|sn|sd)$/, 'snare'],
  [/^(tom|toms|tomtom|floortom|racktom)$/, 'tom'],
  [/^cowbells?$/, 'cowbell'],
  [/^(tamb|tambo|tambourine)$/, 'tambourine'],
  [/^(clap|claps|handclap)$/, 'clap'],
  [/^(shaker|shakers|maraca|maracas)$/, 'shaker'],
  [/^claves?$/, 'claves'],
  [/^(block|woodblock)$/, 'block'],
  [/^congas?$/, 'conga'],
  [/^bongos?$/, 'bongo'],
  [/^triangle$/, 'triangle'],
  [/^gongs?$/, 'gong'],
];

/** The kind of drum piece some words name, or null. */
function pieceKind(ws: readonly string[]): string | null {
  for (const [re, kind] of PIECES) if (ws.some((w) => re.test(w))) return kind;
  if (ws.includes('bass') && ws.includes('drum')) return 'kick';
  if (ws.includes('floor') || ws.includes('rack')) return 'tom';
  return null;
}

/** Folders of a family of pieces, whose files name the piece ("Toms/Tom 1_v1.wav"). */
const CATEGORIES = new Set(['toms', 'cymbals', 'cyms', 'hats', 'hihats', 'kicks', 'snares', 'crashes', 'rides']);

/** Words that say which stroke or part of a piece (they make a piece of their own, not a microphone). */
const STROKES = new Set(
  (
    'closed clsd cls tight tip shank pedal foot ped chick chik stomp open opn half semi loose quarter rim ' +
    'rimshot rimclick side sidestick stick cross xstick crossstick edge bell bow center centre ctr choke ' +
    'choked mute muted flam roll buzz drag swirl brush brushes mallet mallets rod rods hot hand hands press ' +
    'sizzle hi high mid middle low lo floor rack off on'
  ).split(' '),
);

/** Microphone words: each the microphone it names (direct and close are one). */
const MIC_WORDS: Record<string, string> = {
  close: 'close',
  direct: 'close',
  dir: 'close',
  di: 'close',
  top: 'top',
  bottom: 'bottom',
  bot: 'bottom',
  btm: 'bottom',
  in: 'in',
  out: 'out',
  sub: 'sub',
  subkick: 'sub',
  oh: 'overheads',
  ohs: 'overheads',
  overhead: 'overheads',
  overheads: 'overheads',
  room: 'room',
  rooms: 'room',
  amb: 'ambient',
  ambient: 'ambient',
  ambience: 'ambient',
  far: 'far',
  near: 'near',
};
/** The microphones, in the order a mixer lays them out (close ones first, the room last). */
const MIC_ORDER = ['close', 'top', 'bottom', 'in', 'out', 'sub', 'overheads', 'room', 'near', 'far', 'ambient'];
/** Microphones that hear the whole kit (named alone; a close one is named with its drum when it has one). */
const KIT_MICS = new Set(['overheads', 'room', 'near', 'far', 'ambient']);
const SIDES: Record<string, -1 | 1> = { l: -1, left: -1, r: 1, right: 1 };
/** Words a microphone folder may have besides the microphone ("OH L", "Room Mono", "Close Mics"). */
const MIC_EXTRA = new Set(['mic', 'mics', 'mono', 'stereo', 'pair', 'l', 'r', 'left', 'right']);

/** Whether a folder's words name a microphone ("OH", "Room Far", "Overheads L"). */
function isMicName(ws: readonly string[]): boolean {
  return (
    ws.some((w) => MIC_WORDS[w] !== undefined) &&
    ws.every((w) => MIC_WORDS[w] !== undefined || MIC_EXTRA.has(w) || /^\d+$/.test(w))
  );
}

// ---- folders of samples named by note ----

interface Named {
  note: number | null;
  layer: number;
  rr: number;
  /** Its other words, lower case (numbers among them as they stand). */
  rest: string[];
}

function parseName(file: string): Named {
  let note: number | null = null;
  let layer = 0;
  let rr = 1;
  const rest: string[] = [];
  for (const t of words(basename(file, extname(file)))) {
    const lower = t.toLowerCase();
    const l = LAYER.exec(lower);
    const r = RR.exec(lower);
    if (note === null && NOTE.test(t)) note = noteNumber(t);
    else if (l) layer = Number(l[2]);
    else if (r) rr = Number(r[2]);
    else if (DYN[lower] !== undefined) layer = DYN[lower] ?? 0;
    else rest.push(lower);
  }
  return { note, layer, rr, rest };
}

/**
 * Notes named by bare number ("Keys 060.wav"): read so only when the folder's files differ in that one
 * number and nothing else, the folder isn't a drum's (a kit's numbers are its velocities and takes),
 * and the numbers aren't a count (01, 02, 03… are takes). Returns each file's note, or null.
 */
function numberedNotes(dir: string, parsed: readonly Named[]): number[] | null {
  const first = parsed[0];
  if (!first || parsed.length < 2 || parsed.some((p) => p.note !== null)) return null;
  if (pieceKind(words(basename(dir)).map((w) => w.toLowerCase())) || parsed.some((p) => pieceKind(p.rest))) return null;
  const n = first.rest.length;
  if (parsed.some((p) => p.rest.length !== n)) return null;
  for (let at = 0; at < n; at++) {
    if (!parsed.every((p) => /^\d{2,3}$/.test(p.rest[at] ?? '') && Number(p.rest[at]) <= 127)) continue;
    if (!parsed.every((p) => p.rest.every((t, i) => i === at || t === first.rest[i]))) continue;
    const values = [...new Set(parsed.map((p) => Number(p.rest[at])))].sort((a, b) => a - b);
    const lowest = values[0] ?? 0;
    if (values.length < 2 || (lowest <= 1 && values.every((v, i) => v === lowest + i))) continue;
    return parsed.map((p) => Number(p.rest[at]));
  }
  return null;
}

/** One instrument from a folder of samples: pitched if the files are named by note, else a kit. */
export function instrumentFromFolder(
  dir: string,
  files: string[],
  opts: { log?: (line: string) => void } = {},
): PackInstrument {
  const named = files.map(parseName);
  const numbered = numberedNotes(dir, named);
  const parsed = files.map((f, i) => {
    const p = named[i] as Named;
    return { file: f, ...p, note: p.note ?? numbered?.[i] ?? null, info: audioInfo(f) };
  });
  const pitched = parsed.filter((p) => p.note !== null).length >= Math.max(2, parsed.length * 0.6);
  if (!pitched) return instrumentFromKit(dir, files, { layout: 'flat', ...opts });
  const zones: Zone[] = [];
  const layers = [...new Set(parsed.map((p) => p.layer))].sort((a, b) => a - b);
  const vel = (l: number) => evenVelocities(layers.indexOf(l), layers.length);
  for (const l of layers) {
    const here = parsed.filter((p) => p.layer === l && p.note !== null).sort((a, b) => (a.note ?? 0) - (b.note ?? 0));
    const notes = [...new Set(here.map((p) => p.note as number))];
    for (const p of here) {
      const i = notes.indexOf(p.note as number);
      const prev = notes[i - 1];
      const next = notes[i + 1];
      const [lovel, hivel] = vel(l);
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
  const name = basename(dir);
  return {
    name: slug(name),
    title: name.replace(/[_-]+/g, ' ').trim(),
    category: 'Imported',
    pitched: true,
    release: 0.4,
    attack: 0.002,
    oneShot: false,
    velocityRange: zones.some((z) => z.lovel > 1) ? 12 : 20,
    zones,
  };
}

/** Layer i of n spread evenly over velocities 1 to 127 (for layers that can't be measured). */
function evenVelocities(i: number, n: number): [number, number] {
  if (n <= 1) return [1, 127];
  return [i === 0 ? 1 : Math.floor((i * 126) / n) + 1, i === n - 1 ? 127 : Math.floor(((i + 1) * 126) / n)];
}

// ---- drum kits ----

/** A microphone a sample was recorded with: its id, its name, and its side when it's one of a pair. */
interface MicName {
  id: string;
  name: string;
  pan: number;
}

/** One sample of a kit, read from its folders and its name. */
interface KitSample {
  file: string;
  /** Its piece: the key it's grouped by, its name on its pad, and the words that say what it is. */
  piece: string;
  title: string;
  words: string[];
  /** Whether a folder named the piece (then its name's other words may name its microphone). */
  pieceFolder: boolean;
  /** The microphone words in its folders and its name, and the side when it's one of a pair. */
  micParts: MicName[];
  side: number;
  /** Its name's words that are none of a piece's, a microphone's, a layer's or a take's (lower case). */
  others: string[];
  /** Its name's words that say which hit of its piece it is (layer, take, numbers, others), lower case. */
  hitWords: string[];
}

const title = (s: string) => s.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A microphone's part of a name: a known word as that microphone, any other as it stands. */
function micPart(word: string): MicName {
  const known = MIC_WORDS[word.toLowerCase()];
  return known ? { id: known, name: capital(known), pan: 0 } : { id: slug(word), name: word, pan: 0 };
}

/**
 * What a kit's sample is, from its folders under the kit and its name. A folder naming a drum is its
 * piece (the deepest one: "Toms/Tom 1"), with any stroke the name adds ("Hi-Hat/HH_Open_v1"); else the
 * name's own words are ("Kick_OH_v1" is the kick). Microphone folders and words are its microphone.
 */
function kitSample(root: string, file: string, layout: KitLayout): KitSample {
  const segs = relative(root, dirname(file))
    .split(sep)
    .filter((s) => s && s !== '.');
  let pieceSegs: string[] = [];
  let folderKind: string | null = null;
  let category = false;
  const micParts: MicName[] = [];
  let side = 0;
  segs.forEach((seg, i) => {
    const ws = words(seg).map((w) => w.toLowerCase());
    const kind = pieceKind(ws);
    if (kind) {
      pieceSegs = [seg];
      folderKind = kind;
      category = kind === 'cymbal' || ws.some((w) => CATEGORIES.has(w));
    } else if (ws.length && ws.every((w) => STROKES.has(w))) {
      pieceSegs.push(seg);
    } else if (isMicName(ws)) {
      for (const w of ws) {
        if (SIDES[w] !== undefined) side = SIDES[w] ?? 0;
        else if (!MIC_EXTRA.has(w)) micParts.push(micPart(w));
      }
    } else if (i === 0 && layout === 'pieces' && !pieceSegs.length) {
      pieceSegs = [seg];
    } else {
      // any other folder below a piece is a microphone of its own ("SM57", "Trash")
      micParts.push({ id: slug(seg), name: title(seg), pan: 0 });
    }
  });

  const tokens = words(basename(file, extname(file)));
  const hasMic = micParts.length > 0 || tokens.some((t) => MIC_WORDS[t.toLowerCase()] !== undefined);
  // the name's words that name a piece, in order (and their lower-case words), and its strokes
  const nameParts: string[] = [];
  const nameWords: string[] = [];
  const strokes: string[] = [];
  const others: string[] = [];
  const hitWords: string[] = [];
  let numbered = false;
  let afterTom = false;
  for (const t of tokens) {
    const lower = t.toLowerCase();
    const glued = /^([a-z]+?)(\d+)$/.exec(lower);
    const gluedKind = glued ? pieceKind([glued[1] as string]) : null;
    // a tom's own number ("Tom 1", unpadded: "Tom 01" is a take)
    const tomNumber = afterTom && /^[1-9]\d?$/.test(lower);
    if (MIC_WORDS[lower] !== undefined) micParts.push(micPart(lower));
    else if (hasMic && SIDES[lower] !== undefined) side = SIDES[lower] ?? 0;
    else if (LAYER.test(lower) || RR.test(lower) || DYN[lower] !== undefined) hitWords.push(lower);
    else if (/^\d+$/.test(lower) && !tomNumber) hitWords.push(lower);
    else if (glued && gluedKind) {
      // "Tom1", "Crash18": the piece and its number
      nameParts.push(`${t.slice(0, (glued[1] as string).length)} ${glued[2]}`);
      nameWords.push(glued[1] as string, glued[2] as string);
      numbered = true;
    } else if (tomNumber || pieceKind([lower])) {
      nameParts.push(t);
      nameWords.push(lower);
      numbered ||= tomNumber;
    } else if (STROKES.has(lower)) {
      nameParts.push(t);
      nameWords.push(lower);
      strokes.push(lower);
    } else {
      nameParts.push(t);
      nameWords.push(lower);
      others.push(lower);
      hitWords.push(lower);
    }
    afterTom = pieceKind([lower]) === 'tom' || lower === 'floor' || lower === 'rack';
  }
  // the folder names the piece, unless it's a family's folder and the name says which ("Cymbals/Crash_v1",
  // "Toms/Tom1_v1"), or the name numbers one of its kind ("Tom/Tom 2_v1"), or the folder names no drum
  const nameKind = pieceKind(nameWords);
  const byFolder =
    pieceSegs.length > 0 && !(nameKind && (folderKind === null || category || (nameKind === folderKind && numbered)));
  let pieceTitle: string;
  let ws: string[];
  if (byFolder) {
    const folderWords = pieceSegs.flatMap((s) => words(s).map((w) => w.toLowerCase()));
    const extra = strokes.filter((w) => !folderWords.includes(w));
    pieceTitle = [...pieceSegs.map(title), ...extra.map(capital)].join(' ');
    ws = [...folderWords, ...extra];
  } else {
    pieceTitle = nameParts.join(' ');
    ws = nameWords;
  }
  if (!pieceTitle) {
    // nothing in the name says what it is: the folder it's in does ("Snare/01.wav")
    pieceTitle = title(basename(dirname(file)));
    ws = words(pieceTitle).map((w) => w.toLowerCase());
  }
  return {
    file,
    piece: ws.join(' '),
    title: pieceTitle,
    words: ws,
    pieceFolder: byFolder,
    micParts,
    side,
    others,
    hitWords,
  };
}

/** One hit of a piece: its file on each microphone, what its name says of it, and how it measures. */
interface Hit {
  key: string;
  files: Map<string, string>;
  layer: number | null;
  take: number | null;
  numbers: number[];
  measured: Measured | null;
  layerId: number;
  rr: number;
}

interface Measured {
  /** Its microphones summed as they're heard at their starting levels: loudness and peak (dB), from its onset. */
  level: number;
  peak: number;
  /** The frame its samples start from (just before the onset), at `rate`. */
  start: number;
  rate: number;
}

interface Piece {
  key: string;
  title: string;
  words: string[];
  kind: string | null;
  hits: Hit[];
  /** Its layers, soft to loud as named (measured ones are placed by their loudness). */
  layers: number[];
  measured: boolean;
  keys: number[];
}

type KitLayout = 'pieces' | 'mics' | 'flat';

/** Takes of one velocity closer than this (dB) are round robins of one layer, when nothing names them. */
const TAKE_DB = 1.5;

/** A mono microphone's gains into left and right at a pan (-1 to 1): constant power, unity in the center. */
function panGains(pan: number): [number, number] {
  const theta = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  return [Math.cos(theta) * Math.SQRT2, Math.sin(theta) * Math.SQRT2];
}

function decodeFile(path: string): DecodedInput | null {
  if (!DECODABLE.has(extname(path).toLowerCase())) return null;
  try {
    return decodeInput(new Uint8Array(readFileSync(path)));
  } catch {
    return null;
  }
}

/** A hit measured as it sounds: its microphones summed, each at 0 dB and its pan. */
function measureHit(files: Map<string, string>, pans: Map<string, number>): Measured | null {
  const decoded: [DecodedInput, number][] = [];
  for (const [mic, file] of files) {
    const d = decodeFile(file);
    if (!d?.channels.length) return null;
    decoded.push([d, pans.get(mic) ?? 0]);
  }
  const first = decoded[0]?.[0];
  if (!first) return null;
  const length = Math.max(...decoded.map(([d]) => d.channels[0]?.length ?? 0));
  const l = new Float64Array(length);
  const r = new Float64Array(length);
  for (const [d, pan] of decoded) {
    const a = d.channels[0] as Float32Array;
    const b = d.channels[1];
    const [gl, gr] = b ? [1, 1] : panGains(pan);
    for (let i = 0; i < a.length; i++) {
      l[i] = (l[i] as number) + (a[i] as number) * gl;
      r[i] = (r[i] as number) + ((b ?? a)[i] as number) * gr;
    }
  }
  const ch = [l, r];
  const at = onset(ch, 40);
  const level = loudness(ch, first.rate, at, 0.4);
  // silence (or as good as) can't be placed by its loudness
  if (!(level > -100)) return null;
  return { level, peak: peakDb(ch), start: Math.max(0, at - Math.round(0.0015 * first.rate)), rate: first.rate };
}

/** A tom's place from high to low: words first (high, mid, low, floor), then its number (an index, or inches). */
function tomOrder(ws: readonly string[]): [number, number] {
  const tier = ws.some((w) => w === 'floor')
    ? 3
    : ws.some((w) => w === 'low' || w === 'lo')
      ? 2
      : ws.some((w) => w === 'mid' || w === 'middle')
        ? 1
        : ws.some((w) => w === 'hi' || w === 'high' || w === 'rack')
          ? 0
          : 1;
  const n = ws.map(Number).find((x) => Number.isFinite(x) && x > 0);
  return [tier, n ?? 0];
}

/** The General MIDI keys a piece wants, the first free one taken (a second crash goes to 57). */
function wantedKeys(kind: string | null, ws: readonly string[]): number[] {
  const has = (...w: string[]) => w.some((x) => ws.includes(x));
  switch (kind) {
    case 'kick':
      return [36, 35];
    case 'snare':
      if (has('rim', 'rimshot')) return [40];
      if (has('side', 'sidestick', 'stick', 'cross', 'xstick', 'crossstick', 'rimclick')) return [37];
      if (has('edge')) return [39];
      if (has('flam', 'roll', 'buzz', 'drag', 'swirl', 'off', 'brush', 'brushes', 'choke', 'mute', 'muted')) return [];
      return [38];
    case 'hat':
      if (has('pedal', 'foot', 'ped', 'chick', 'chik', 'stomp', 'phh', 'hhp')) return [44];
      if (has('half', 'semi', 'quarter')) return [26];
      if (has('loose')) return [22];
      if (has('open', 'opn', 'ohh', 'hho')) return [46];
      if (has('bell', 'splash', 'sizzle', 'choke')) return [];
      return [42];
    case 'ride':
      if (has('bell')) return [53];
      if (has('edge', 'crash')) return [59];
      return [51, 59];
    case 'crash':
    case 'cymbal':
      return has('bell', 'choke', 'choked', 'mute', 'muted') ? [] : [49, 57];
    case 'china':
      return [52];
    case 'splash':
      return [55];
    case 'cowbell':
      return [56];
    case 'tambourine':
      return [54];
    case 'clap':
      return [39];
    case 'shaker':
      return [70, 82];
    case 'claves':
      return [75];
    case 'block':
      return [76, 77];
    case 'conga':
      return [63, 64, 62];
    case 'bongo':
      return [60, 61];
    case 'triangle':
      return [81, 80];
    default:
      return [];
  }
}

/** The order pieces claim their keys in (the kit's core first). */
const KIND_ORDER = ['kick', 'snare', 'hat', 'crash', 'ride', 'china', 'splash', 'cymbal'];
/** General MIDI's toms, high to low. */
const TOM_KEYS = [50, 48, 47, 45, 43, 41];
/** The studio's drum pads for General MIDI, in rows of four, the top row first (apps/web/src/ui/pads.ts). */
const GM_PADS = [49, 51, 46, 42, 50, 47, 45, 43, 39, 37, 38, 36, 56, 54, 70, 75];
/** Hi-hat strokes the closed hat (and the pedal) cuts off. */
const HAT_OPEN = new Set(['open', 'opn', 'ohh', 'hho', 'half', 'semi', 'quarter', 'loose']);

/**
 * A drum kit from a folder: the samples grouped into pieces (by the piece folders, else by their names
 * without their velocity, take and microphone words), each piece on its General MIDI key with its
 * velocity layers placed by their measured loudness and its takes as round robins. Where the samples
 * are on several microphones (folders, or microphone words in their names), each hit's microphones
 * sound together, each at a level of its own.
 *
 * Its levels follow HO[LO] Packs' kits (tools/kit.mjs): one velocity range for the kit (28 to 44 dB,
 * as wide as its kick, snare and toms need), the snare at -19 dB loudness at velocity 127 and peaking
 * at -2 dB at most, no piece over full scale, and otherwise each piece as loud as it was recorded.
 */
export function instrumentFromKit(
  root: string,
  files: string[],
  opts: { layout?: KitLayout; log?: (line: string) => void } = {},
): PackInstrument {
  const layout = opts.layout ?? 'pieces';
  const samples = files.map((f) => kitSample(root, f, layout));

  // pieces, and in a piece folder the name's other words that differ between its files: microphones
  const byPiece = new Map<string, KitSample[]>();
  for (const s of samples) byPiece.set(s.piece, [...(byPiece.get(s.piece) ?? []), s]);
  const micOf = new Map<KitSample, MicName | null>();
  for (const list of byPiece.values()) {
    const every = (w: string) => list.every((s) => s.others.includes(w));
    for (const s of list) {
      const parts = [...s.micParts];
      if (s.pieceFolder)
        for (const w of s.others) if (w.length > 1 && !/^\d+$/.test(w) && !every(w)) parts.push(micPart(w));
      const unique = parts.filter((p, i) => parts.findIndex((q) => q.id === p.id) === i);
      if (!unique.length) {
        micOf.set(s, null);
        continue;
      }
      const sideId = s.side < 0 ? '-l' : s.side > 0 ? '-r' : '';
      const sideName = s.side < 0 ? ' L' : s.side > 0 ? ' R' : '';
      micOf.set(s, {
        id: unique.map((p) => p.id).join('-') + sideId,
        name: capital(unique.map((p, i) => (i ? p.name.toLowerCase() : p.name)).join(' ')) + sideName,
        pan: s.side,
      });
    }
  }

  // the hits: a piece's samples whose names are the same but for their microphone words
  const mics = new Map<string, MicName>();
  const pieces: Piece[] = [];
  for (const [key, list] of byPiece) {
    const hits = new Map<string, Hit>();
    for (const s of list) {
      const mic = micOf.get(s) ?? null;
      const micWords = new Set(s.pieceFolder ? (mic?.id.split('-') ?? []) : []);
      const hw = s.hitWords.filter((w) => !micWords.has(w));
      const k = hw.join(' ');
      let hit = hits.get(k);
      if (!hit) {
        let layer: number | null = null;
        let take: number | null = null;
        const numbers: number[] = [];
        for (const w of hw) {
          const l = LAYER.exec(w);
          const r = RR.exec(w);
          if (l) layer = Number(l[2]);
          else if (r) take = Number(r[2]);
          else if (DYN[w] !== undefined) layer = DYN[w] ?? null;
          else if (/^\d+$/.test(w)) numbers.push(Number(w));
        }
        hit = { key: k, files: new Map(), layer, take, numbers, measured: null, layerId: 0, rr: 1 };
        hits.set(k, hit);
      }
      const id = mic?.id ?? '';
      if (mic) mics.set(mic.id, mic);
      if (!hit.files.has(id)) hit.files.set(id, s.file);
    }
    const first = list[0] as KitSample;
    pieces.push({
      key,
      title: first.title,
      words: first.words,
      kind: pieceKind(first.words),
      hits: [...hits.values()].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true })),
      layers: [],
      measured: false,
      keys: [],
    });
  }
  pieces.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));

  // measure every hit (each hit's microphones summed, decoded one hit at a time)
  const pans = new Map([...mics.values()].map((m) => [m.id, m.pan]));
  for (const p of pieces) {
    for (const h of p.hits) h.measured = measureHit(h.files, pans);
    p.measured = p.hits.every((h) => h.measured);
    opts.log?.(`${p.title}: ${p.hits.length} hit(s)${p.measured ? ' measured' : ', placed by their names'}`);
  }

  // layers and takes: as the names say (a bare number is the take beside a named layer, the layer
  // beside a named take, and of two numbers the first is the layer), else hits of one loudness are
  // takes of one layer
  const place = (h: Hit, layer: number, take: number) => {
    h.layerId = layer;
    h.rr = take;
  };
  for (const p of pieces) {
    const hs = p.hits;
    if (hs.some((h) => h.layer !== null)) {
      for (const h of hs) place(h, h.layer ?? 0, h.take ?? h.numbers[0] ?? 0);
    } else if (hs.some((h) => h.take !== null)) {
      for (const h of hs) place(h, h.numbers[0] ?? 0, h.take ?? 0);
    } else if (hs.every((h) => h.numbers.length >= 2)) {
      for (const h of hs) place(h, h.numbers[0] ?? 0, h.numbers[1] ?? 0);
    } else if (p.measured) {
      const sorted = [...hs].sort((a, b) => (a.measured?.level ?? 0) - (b.measured?.level ?? 0));
      let layer = 0;
      let from = sorted[0]?.measured?.level ?? 0;
      for (const h of sorted) {
        const level = h.measured?.level ?? 0;
        if (level - from > TAKE_DB) {
          layer++;
          from = level;
        }
        place(h, layer, h.numbers[0] ?? 0);
      }
    } else {
      hs.forEach((h, i) => {
        place(h, h.numbers[0] ?? i, 0);
      });
    }
    p.layers = [...new Set(hs.map((h) => h.layerId))].sort((a, b) => a - b);
    // round robins numbered from 1 in each layer, in the order their names give
    for (const l of p.layers) {
      const takes = hs
        .filter((h) => h.layerId === l)
        .sort((a, b) => a.rr - b.rr || a.key.localeCompare(b.key, undefined, { numeric: true }));
      takes.forEach((h, i) => {
        h.rr = i + 1;
      });
    }
  }

  // the kit's levels (as HO[LO] Packs' tools/kit.mjs sets them)
  const levelsOf = (p: Piece) =>
    p.layers.map((l) => {
      const of = p.hits.filter((h) => h.layerId === l);
      return of.reduce((s, h) => s + (h.measured?.level ?? 0), 0) / of.length;
    });
  const measured = pieces.filter((p) => p.measured);
  const mainSnare = (p: Piece) => p.kind === 'snare' && wantedKeys('snare', p.words)[0] === 38;
  const leads = measured.filter((p) => p.kind === 'kick' || p.kind === 'tom' || mainSnare(p));
  const needs = (leads.length ? leads : measured).map((p) => spreadLayers(levelsOf(p)).need);
  const range = measured.length ? round(Math.min(44, Math.max(28, ...needs)), 1) : 0;
  const target = new Map<Piece, number>();
  let offset = 0;
  if (measured.length) {
    const refs = new Map(measured.map((p) => [p, spreadLayers(levelsOf(p), { range }).ref]));
    // the snare sets the kit's level (else the kick, else the first piece), the rest keep their balance to it
    const anchor =
      measured.find(mainSnare) ??
      measured.find((p) => p.kind === 'snare') ??
      measured.find((p) => p.kind === 'kick') ??
      (measured[0] as Piece);
    const master = -19 - (refs.get(anchor) as number);
    const peakAtTop = (p: Piece, t: number) => {
      const spread = spreadLayers(levelsOf(p), { range, target: t });
      let peak = Number.NEGATIVE_INFINITY;
      p.layers.forEach((l, j) => {
        const v = spread.layers[j];
        if (v?.hivel !== 127 || v.unreachable) return;
        for (const h of p.hits) if (h.layerId === l) peak = Math.max(peak, (h.measured?.peak ?? 0) + v.gain);
      });
      return peak;
    };
    // headroom: the kit comes down until its snare peaks at -2 dB at full velocity, and a piece that
    // would still peak over full scale comes down alone
    const shift = Math.min(0, -2 - peakAtTop(anchor, (refs.get(anchor) as number) + master));
    for (const p of measured) {
      const t = (refs.get(p) as number) + master + shift;
      target.set(p, t + Math.min(0, -peakAtTop(p, t)));
    }
    offset = master + shift;
  }

  // keys: the General MIDI key each piece's words want, toms spread over the six tom keys high to low
  const used = new Set<number>();
  const toms = pieces
    .filter((p) => p.kind === 'tom')
    .sort((a, b) => {
      const [ta, na] = tomOrder(a.words);
      const [tb, nb] = tomOrder(b.words);
      // a number of 6 or more is its size in inches (bigger is lower), a smaller one its place (1 is highest)
      return ta - tb || na - nb;
    });
  TOM_KEYS.forEach((k, j) => {
    // fewer toms than keys: each takes its share, high to low; six or more: one each, the rest below
    const p = toms.length >= TOM_KEYS.length ? toms[j] : toms[Math.floor((j * toms.length) / TOM_KEYS.length)];
    if (p) {
      p.keys.push(k);
      used.add(k);
    }
  });
  const rank = (p: Piece) => {
    const i = KIND_ORDER.indexOf(p.kind ?? '');
    return i < 0 ? KIND_ORDER.length : i;
  };
  for (const p of [...pieces].sort((a, b) => rank(a) - rank(b))) {
    if (p.keys.length) continue;
    const k = wantedKeys(p.kind, p.words).find((x) => !used.has(x));
    if (k !== undefined) {
      p.keys.push(k);
      used.add(k);
    }
  }
  // the rest from C1 up
  let spare = 36;
  for (const p of pieces) {
    if (p.keys.length) continue;
    while (used.has(spare)) spare++;
    p.keys.push(spare);
    used.add(spare);
  }

  // the zones: every key of a piece, every reachable layer, every take, every microphone
  const multi = mics.size >= 2;
  const zones: Zone[] = [];
  for (const p of pieces) {
    const t = target.get(p);
    const spread = t !== undefined ? spreadLayers(levelsOf(p), { range, target: t }) : null;
    const hat = p.kind === 'hat';
    const choked = hat && p.words.some((w) => HAT_OPEN.has(w));
    p.layers.forEach((l, j) => {
      const v = spread?.layers[j];
      if (v?.unreachable) return;
      const [lovel, hivel] = v ? [v.lovel, v.hivel] : evenVelocities(j, p.layers.length);
      // a piece that can't be measured (OGG, MP3) at its recorded level in the middle of the velocities,
      // as a measured piece of one layer is, moved with the kit
      const gain = round(v ? v.gain : offset + range / 2, 2);
      for (const h of p.hits) {
        if (h.layerId !== l) continue;
        for (const [mic, file] of h.files) {
          const info = audioInfo(file);
          const start = h.measured ? Math.round((h.measured.start * info.rate) / h.measured.rate) : 0;
          for (const key of p.keys)
            zones.push({
              file,
              root: key,
              lo: key,
              hi: key,
              lovel,
              hivel,
              gain,
              start: Math.min(start, Math.max(0, info.frames - 1)),
              end: info.frames,
              loopStart: 0,
              loopEnd: 0,
              rate: info.rate,
              rr: h.rr,
              ...(hat ? { group: 1 } : {}),
              ...(choked ? { offBy: 1 } : {}),
              ...(multi && mic ? { mic } : {}),
            });
        }
      }
    });
  }
  const micRank = (id: string) => {
    const i = MIC_ORDER.indexOf(id.split('-')[0] ?? '');
    return i < 0 ? MIC_ORDER.length : i;
  };
  zones.sort((a, b) => a.lo - b.lo || a.lovel - b.lovel || a.rr - b.rr || micRank(a.mic ?? '') - micRank(b.mic ?? ''));

  // the microphones, close ones first; one only a single kind of drum has is named with it ("Kick In")
  const kinds = (id: string) => new Set(pieces.filter((p) => p.hits.some((h) => h.files.has(id))).map((p) => p.kind));
  const KIND_TITLE: Record<string, string> = { kick: 'Kick', snare: 'Snare', hat: 'Hi-hat', tom: 'Tom' };
  const micList: SampleMic[] = multi
    ? [...mics.values()]
        .sort((a, b) => micRank(a.id) - micRank(b.id) || a.id.localeCompare(b.id))
        .map((m) => {
          const only = [...kinds(m.id)];
          const drum = only.length === 1 && !KIT_MICS.has(m.id.split('-')[0] ?? '') ? KIND_TITLE[only[0] ?? ''] : '';
          const name = drum && !m.name.toLowerCase().startsWith(drum.toLowerCase()) ? `${drum} ${m.name}` : m.name;
          return { id: m.id, name, ...(m.pan ? { pan: m.pan } : {}) };
        })
    : [];

  // the pads: every piece once, laid out as the studio lays out General MIDI's, the rest below
  const padRank = (key: number) => {
    const i = GM_PADS.indexOf(key);
    return i < 0 ? GM_PADS.length + 127 - key : i;
  };
  const pads = pieces
    .map((p) => ({ key: p.keys[0] as number, name: p.title || `Key ${p.keys[0]}` }))
    .sort((a, b) => padRank(a.key) - padRank(b.key));

  const name = basename(root);
  return {
    name: slug(name),
    title: name.replace(/[_-]+/g, ' ').trim(),
    category: 'Imported Kits',
    pitched: false,
    release: 0.08,
    attack: 0,
    oneShot: true,
    velocityRange: range || (zones.some((z) => z.lovel > 1) ? 12 : 20),
    // as the pinned kits play: a drum struck a fourth time lets its oldest ring go (a hit counts once,
    // on however many microphones), and a choke or that fade takes 35 ms
    polyphony: 96,
    notePolyphony: 3,
    offTime: 0.035,
    pads,
    ...(micList.length ? { mics: micList } : {}),
    zones,
  };
}

// ---- ZIP files ----

/**
 * Unpack a ZIP (stored or deflated entries, ZIP64 too) into a folder, refusing any path that would
 * escape it. It's read at offsets through a file descriptor, so an archive of many gigabytes is never
 * in memory; a deflated entry is inflated whole (a sample is never near that big), a stored one copied
 * a megabyte at a time.
 */
export function extractZip(zipPath: string, dest: string): void {
  const fd = openSync(zipPath, 'r');
  try {
    const size = fstatSync(fd).size;
    const read = (at: number, length: number): Buffer => {
      const b = Buffer.alloc(length);
      let got = 0;
      while (got < length) {
        const n = readSync(fd, b, got, length - got, at + got);
        if (!n) throw new Error('Damaged ZIP file');
        got += n;
      }
      return b;
    };
    // the end record: in the last 22 bytes and its comment (up to 64 KB)
    const tailLength = Math.min(size, 22 + 65535);
    const tail = read(size - tailLength, tailLength);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error('Not a ZIP file');
    let count = tail.readUInt16LE(end + 10);
    let cdSize = tail.readUInt32LE(end + 12);
    let cdAt = tail.readUInt32LE(end + 16);
    // ZIP64: a locator just before the end record points to the 64-bit end record
    const locator = size - tailLength + end - 20;
    if (locator >= 0 && read(locator, 4).readUInt32LE(0) === 0x07064b50) {
      const record = read(Number(read(locator + 8, 8).readBigUInt64LE(0)), 56);
      if (record.readUInt32LE(0) !== 0x06064b50) throw new Error('Damaged ZIP file');
      count = Number(record.readBigUInt64LE(32));
      cdSize = Number(record.readBigUInt64LE(40));
      cdAt = Number(record.readBigUInt64LE(48));
    }
    const cd = read(cdAt, cdSize);
    const root = resolve(dest);
    let at = 0;
    for (let n = 0; n < count; n++) {
      if (at + 46 > cd.length || cd.readUInt32LE(at) !== 0x02014b50) throw new Error('Damaged ZIP file');
      const flags = cd.readUInt16LE(at + 8);
      const method = cd.readUInt16LE(at + 10);
      let compressed = cd.readUInt32LE(at + 20);
      let length = cd.readUInt32LE(at + 24);
      const nameLen = cd.readUInt16LE(at + 28);
      const extraLen = cd.readUInt16LE(at + 30);
      const commentLen = cd.readUInt16LE(at + 32);
      let local = cd.readUInt32LE(at + 42);
      const name = cd.toString('utf8', at + 46, at + 46 + nameLen);
      // ZIP64's extra field: the 64-bit size, compressed size and offset, each whose 32-bit field is full
      for (let x = at + 46 + nameLen; x + 4 <= at + 46 + nameLen + extraLen; ) {
        const id = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let p = x + 4;
          const next = () => {
            if (p + 8 > x + 4 + len) throw new Error('Damaged ZIP file');
            const v = Number(cd.readBigUInt64LE(p));
            p += 8;
            return v;
          };
          if (length === 0xffffffff) length = next();
          if (compressed === 0xffffffff) compressed = next();
          if (local === 0xffffffff) local = next();
        }
        x += 4 + len;
      }
      at += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/') || name.startsWith('__MACOSX')) continue;
      const out = resolve(root, name.replace(/\\/g, '/'));
      if (!out.startsWith(root + sep)) throw new Error(`Refusing ${name}: it points outside the pack`);
      if (flags & 1) throw new Error(`${name} is encrypted: unpack the ZIP yourself and import the folder`);
      const head = read(local, 30);
      if (head.readUInt32LE(0) !== 0x04034b50) throw new Error('Damaged ZIP file');
      const data = local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      mkdirSync(dirname(out), { recursive: true });
      if (method === 0) {
        const to = openSync(out, 'w');
        try {
          for (let done = 0; done < compressed; ) {
            const chunk = read(data + done, Math.min(1 << 20, compressed - done));
            writeSync(to, chunk);
            done += chunk.length;
          }
        } finally {
          closeSync(to);
        }
      } else if (method === 8) {
        const body = inflateRawSync(read(data, compressed));
        if (body.length !== length) throw new Error(`Damaged ZIP file (${name})`);
        writeFileSync(out, body);
      } else throw new Error(`${name} uses a ZIP compression this importer doesn't read (method ${method})`);
    }
  } finally {
    closeSync(fd);
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

/** Your own packs' ids start with this: no pack HO[LO] pins does, so installing those never overwrites yours. */
export const PRIVATE_PREFIX = 'mine-';

/** A pack id of your own: "mine-" and the name's slug (never "mine-mine-"). */
export function privateId(name: string): string {
  const s = slug(name);
  return s.startsWith(PRIVATE_PREFIX) ? s : `${PRIVATE_PREFIX}${s}`;
}

/** What the command line says after it imports a pack of your own. */
export const PRIVATE_AUDIO_NOTE =
  'Your own packs stay in your data folder. But bouncing or recording one into a song makes ordinary ' +
  "audio files, and sending that song back to an experience puts its audio in the experience's " +
  'repository (the <piece>.audio/ folder beside its session).';

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
 * The kits in a folder: each folder with a folder for two drum pieces or more (Kick, Snare, Hi-Hat
 * Closed…), or with a folder for two microphones or more and the pieces named in its files (OH/Kick_v1,
 * Room/Kick_v1). A folder is one kit with everything under it.
 */
function kitRoots(source: string, files: readonly string[]): { dir: string; layout: KitLayout }[] {
  const subs = new Map<string, Set<string>>();
  for (const f of files) {
    for (let d = dirname(f); d.startsWith(source + sep); d = dirname(d)) {
      const up = dirname(d);
      const s = subs.get(up) ?? new Set<string>();
      s.add(basename(d));
      subs.set(up, s);
    }
  }
  const roots: { dir: string; layout: KitLayout }[] = [];
  for (const dir of [...subs.keys()].sort((a, b) => a.length - b.length)) {
    if (roots.some((r) => dir.startsWith(r.dir + sep))) continue;
    const names = [...(subs.get(dir) ?? [])].map((n) => words(n).map((w) => w.toLowerCase()));
    if (names.filter((ws) => pieceKind(ws) !== null).length >= 2) {
      roots.push({ dir, layout: 'pieces' });
    } else if (names.filter(isMicName).length >= 2) {
      const under = files.filter((f) => f.startsWith(dir + sep)).map(parseName);
      const notes = under.filter((p) => p.note !== null).length;
      if (notes < under.length / 2 && under.some((p) => pieceKind(p.rest))) roots.push({ dir, layout: 'mics' });
    }
  }
  return roots;
}

/** Put a sample in the pack: hard-linked (no second copy on disk), else copied (another disk, or no links there). */
function placeSample(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  try {
    linkSync(src, dest);
  } catch {
    copyFileSync(src, dest);
  }
}

/**
 * Make a pack from a folder (already unpacked): SFZ files become instruments; kit folders become one
 * drum kit each; other folders of samples without SFZ become instruments too. Its id starts with
 * mine-. Files are hard-linked (else copied) into `packsDir/<id>/samples`.
 */
export function importFolder(
  source: string,
  packsDir: string,
  opts: { id?: string; name?: string; license?: string; log?: (line: string) => void },
): Pack {
  const name = opts.name ?? basename(source).replace(/\.(zip)$/i, '');
  const base = privateId(opts.id ?? name);
  let id = base;
  for (let n = 2; existsSync(join(packsDir, id)); n++) id = `${base}-${n}`;
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
  // samples no SFZ mentions: a kit for each kit folder, then one instrument for each other folder
  const loose = all.filter((f) => AUDIO.has(extname(f).toLowerCase()) && !used.has(f));
  const inKit = new Set<string>();
  for (const { dir, layout } of kitRoots(source, loose)) {
    const files = loose.filter((f) => f.startsWith(dir + sep));
    for (const f of files) inKit.add(f);
    opts.log?.(`${basename(dir)}: a drum kit of ${files.length} samples`);
    instruments.push(instrumentFromKit(dir, files, { layout, ...(opts.log ? { log: opts.log } : {}) }));
  }
  const byDir = new Map<string, string[]>();
  for (const f of loose) {
    if (inKit.has(f)) continue;
    const d = dirname(f);
    byDir.set(d, [...(byDir.get(d) ?? []), f]);
  }
  for (const [dir, files] of byDir)
    instruments.push(instrumentFromFolder(dir, files, opts.log ? { log: opts.log } : {}));
  if (!instruments.length) throw new Error('No SFZ instruments or audio files (WAV, FLAC, OGG) were found');
  // unique names, and the files put into the pack with paths relative to its samples folder
  const names = new Set<string>();
  const target = join(packsDir, id, 'samples');
  const outside = new Map<string, string>();
  for (const inst of instruments) {
    let n = inst.name;
    while (names.has(n)) n = `${n}-2`;
    names.add(n);
    inst.name = n;
    for (const z of inst.zones) {
      let rel = relative(source, z.file).split(sep).join('/');
      // a sample an SFZ found outside the folder goes in a folder of its own, never above the pack
      if (rel.startsWith('../') || rel === '..' || /^([a-z]:)?\//i.test(rel)) {
        rel = outside.get(z.file) ?? `outside/${outside.size + 1}-${basename(z.file)}`;
        outside.set(z.file, rel);
      }
      const dest = join(target, rel);
      if (!existsSync(dest)) placeSample(z.file, dest);
      z.file = rel;
    }
  }
  const pack: Pack = {
    id,
    name,
    license: opts.license ?? 'Imported (check its own license)',
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

// ---- BFD ----

export const BFD_LICENSE = 'Your own license (BFD)';

export interface BfdImport {
  /** Where the inventory of the folder was written. */
  inventory: string;
  /** The pack made, when the folder holds plain WAV or FLAC samples in a folder for each piece. */
  pack: Pack | null;
  /** Why no pack was made. */
  reason?: string;
}

const bytesText = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${bytes} B`;

/**
 * What's in a folder, for mapping a library whose own format HO[LO] doesn't read yet: its files by
 * extension, its folders to four levels, its sample files' names, the first 16 bytes of its other
 * files, and what a few audio files' headers say.
 */
export function inventory(root: string, files: readonly string[] = walk(root)): string {
  const lines: string[] = [];
  const all = files.map((f) => ({
    path: f,
    rel: relative(root, f).split(sep).join('/'),
    bytes: statSync(f).size,
    ext: extname(f).toLowerCase() || '(none)',
  }));
  const total = all.reduce((s, f) => s + f.bytes, 0);
  lines.push(`HO[LO] Desk: what's in ${basename(root)}, for mapping its files (${new Date().toISOString()})`);
  lines.push(`${all.length} files, ${bytesText(total)}`);

  lines.push('', 'By extension:');
  const exts = new Map<string, { n: number; bytes: number }>();
  for (const f of all) {
    const e = exts.get(f.ext) ?? { n: 0, bytes: 0 };
    e.n++;
    e.bytes += f.bytes;
    exts.set(f.ext, e);
  }
  for (const [ext, e] of [...exts].sort((a, b) => b[1].n - a[1].n))
    lines.push(`  ${ext.padEnd(12)} ${String(e.n).padStart(7)} files  ${bytesText(e.bytes).padStart(10)}`);

  lines.push('', 'Folders, to four levels (files and size with everything below):');
  const dirs = new Map<string, { n: number; bytes: number }>();
  for (const f of all) {
    const parts = f.rel.split('/').slice(0, -1);
    for (let i = 0; i <= Math.min(parts.length, 4); i++) {
      const d = parts.slice(0, i).join('/');
      const e = dirs.get(d) ?? { n: 0, bytes: 0 };
      e.n++;
      e.bytes += f.bytes;
      dirs.set(d, e);
    }
  }
  const dirList = [...dirs].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [d, e] of dirList.slice(0, 400)) {
    const depth = d ? d.split('/').length : 0;
    const label = `${'  '.repeat(depth)}${d ? `${d.split('/').pop()}/` : './'}`;
    lines.push(`  ${label.padEnd(56)} ${String(e.n).padStart(7)} files  ${bytesText(e.bytes).padStart(10)}`);
  }
  if (dirList.length > 400) lines.push(`  … and ${dirList.length - 400} more folders`);

  // the sample files' names: the audio files', else those of the kind of file that takes the most room
  const audioExts = new Set(['.wav', '.flac', '.aif', '.aiff', '.ogg', '.mp3']);
  let named = all.filter((f) => audioExts.has(f.ext));
  if (!named.length) {
    const biggest = [...exts].sort((a, b) => b[1].bytes - a[1].bytes)[0]?.[0];
    named = all.filter((f) => f.ext === biggest);
  }
  lines.push('', 'Sample file names (up to 12 a folder, 150 folders):');
  const byFolder = new Map<string, string[]>();
  for (const f of named) {
    const d = dirname(f.rel);
    byFolder.set(d, [...(byFolder.get(d) ?? []), basename(f.rel)]);
  }
  for (const [d, list] of [...byFolder].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 150)) {
    lines.push(`  ${d}/ (${list.length})`);
    for (const n of list.sort().slice(0, 12)) lines.push(`    ${n}`);
    if (list.length > 12) lines.push(`    … and ${list.length - 12} more`);
  }
  if (!byFolder.size) lines.push('  (none)');

  lines.push('', 'Other files, their first 16 bytes (up to 6 of each kind):');
  const seen = new Map<string, number>();
  for (const f of all) {
    if (audioExts.has(f.ext) || (seen.get(f.ext) ?? 0) >= 6) continue;
    seen.set(f.ext, (seen.get(f.ext) ?? 0) + 1);
    const head = readHead(f.path, 16);
    const hex = [...head].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const text = [...head].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`  ${f.rel}  (${bytesText(f.bytes)})`, `    ${hex.padEnd(47)}  ${text}`);
  }
  if (!seen.size) lines.push('  (none)');

  lines.push('', 'Audio headers (a WAV, AIFF or FLAC file from each of up to 10 folders):');
  const sampled = new Set<string>();
  for (const f of all) {
    if (!['.wav', '.aif', '.aiff', '.flac'].includes(f.ext) || sampled.has(dirname(f.rel)) || sampled.size >= 10)
      continue;
    sampled.add(dirname(f.rel));
    let what: string;
    try {
      what = describeAudio(f.path);
    } catch (err) {
      what = `unreadable (${err instanceof Error ? err.message : String(err)})`;
    }
    lines.push(`  ${f.rel}: ${what}`);
  }
  if (!sampled.size) lines.push('  (none)');
  return `${lines.join('\n')}\n`;
}

/**
 * BFD (a drum library of your own) from its own folder: an inventory of what's there goes into the data
 * folder (bfd-inventory.txt) whatever happens. If its samples are plain WAV or FLAC files in a folder
 * for each piece, they're imported as a multi-microphone kit of your own (mine-bfd-…). Its own sample
 * format isn't mapped yet: the inventory is what the mapping will be written from.
 */
export function importBfd(
  folder: string,
  dataDir: string,
  opts: { name?: string; log?: (line: string) => void } = {},
): BfdImport {
  const source = resolve(folder);
  if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error(`${folder} isn't a folder`);
  const all = walk(source);
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'bfd-inventory.txt');
  writeFileSync(path, inventory(source, all));
  const plain = all.filter((f) => DECODABLE.has(extname(f).toLowerCase()));
  if (!kitRoots(source, plain).length)
    return {
      inventory: path,
      pack: null,
      reason:
        `BFD's own sample format isn't mapped yet: ${basename(source)} has no plain WAV or FLAC samples ` +
        `in a folder for each drum. Share ${path} (what's in the folder, no audio) and the mapping can be ` +
        'written from the real files.',
    };
  const name = opts.name ?? basename(source);
  const s = slug(name);
  const pack = importFolder(source, join(dataDir, 'packs'), {
    name,
    id: s.startsWith('bfd') ? s : `bfd-${s}`,
    license: BFD_LICENSE,
    ...(opts.log ? { log: opts.log } : {}),
  });
  return { inventory: path, pack };
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
