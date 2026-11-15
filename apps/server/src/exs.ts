/**
 * Logic's sampler instruments (.exs: EXS24's, which Logic's Sampler still reads and writes). The format
 * isn't published; this reads the layout its files have, as other samplers and converters do: a run of
 * chunks, each an 84-byte header (its kind, the size of its data, its id, a magic word saying which byte
 * comes first, its name) followed by its data. Zones map samples to keys and velocities, groups gather
 * zones (a release trigger, a controller choosing between them, a level), and samples name their files.
 * Envelopes, filters and modulation (the parameters chunk) aren't read.
 */
import { readFileSync } from 'node:fs';

/** A zone: one sample on a range of keys and velocities. */
export interface ExsZone {
  name: string;
  /** The key the sample sounds at its own pitch. */
  key: number;
  /** Tuning: semitones and cents it's moved by as it plays. */
  coarse: number;
  fine: number;
  /** dB, and pan (-64 to 63). */
  volume: number;
  pan: number;
  keyLo: number;
  keyHi: number;
  velLo: number;
  velHi: number;
  /** Whether its velocity range applies (else every velocity plays it). */
  velocityOn: boolean;
  /** Plays to its end whatever the key does. */
  oneShot: boolean;
  /** Follows the key it's played on (else every key plays it as recorded). */
  pitch: boolean;
  reverse: boolean;
  /** Frames: where it starts and ends in its file, and its loop. */
  start: number;
  end: number;
  loopOn: boolean;
  loopStart: number;
  loopEnd: number;
  /** Its group and sample, by their order in the file (-1: none). */
  group: number;
  sample: number;
}

/** What chooses whether a group plays: nothing, a key switch, another group, a controller… */
export interface ExsSelect {
  /** 0 none, 1 note, 2 group, 3 controller, 4 pitch bend, 5 MIDI channel, 6 articulation, 7 tempo. */
  type: number;
  /** The controller (or note) it listens to, and the range of values it plays in. */
  number: number;
  lo: number;
  hi: number;
}

export interface ExsGroup {
  name: string;
  /** dB and pan, added to its zones'. */
  volume: number;
  pan: number;
  /** Voices of one exclusive group cut each other off (0: none). */
  exclusive: number;
  velLo: number;
  velHi: number;
  /** Its zones play when a key is let go. */
  release: boolean;
  select: ExsSelect;
}

export interface ExsSample {
  name: string;
  /** Its file's name, and the folder it was in where the instrument was made (any machine's path). */
  file: string;
  folder: string;
  frames: number;
  rate: number;
  channels: number;
}

export interface ExsProgram {
  name: string;
  zones: ExsZone[];
  groups: ExsGroup[];
  samples: ExsSample[];
}

const HEADER = 84;
const KIND = { instrument: 0, zone: 1, group: 2, sample: 3, params: 4 } as const;

/** A C string from a fixed-size field. */
function text(b: Buffer, at: number, length: number): string {
  if (at >= b.length) return '';
  const field = b.subarray(at, Math.min(b.length, at + length));
  const end = field.indexOf(0);
  return field.toString('latin1', 0, end < 0 ? field.length : end).trim();
}

const signed = (v: number) => (v > 127 ? v - 256 : v);

/** An .exs file's zones, groups and samples. Throws when the file isn't one. */
export function readExs(path: string): ExsProgram {
  return parseExs(readFileSync(path));
}

export function parseExs(b: Buffer): ExsProgram {
  if (b.length < HEADER) throw new Error('Not an EXS instrument (too short)');
  const magic = b.toString('latin1', 16, 20);
  if (!['TBOS', 'JBOS', 'SOBT', 'SOBJ'].includes(magic)) throw new Error('Not an EXS instrument');
  const little = magic === 'TBOS' || magic === 'JBOS';
  const u32 = (at: number) => (little ? b.readUInt32LE(at) : b.readUInt32BE(at));
  const i32 = (at: number) => (little ? b.readInt32LE(at) : b.readInt32BE(at));
  const u8 = (at: number, end: number) => (at < end ? (b[at] as number) : 0);

  const program: ExsProgram = { name: text(b, 20, 64), zones: [], groups: [], samples: [] };
  for (let at = 0; at + HEADER <= b.length; ) {
    const sig = u32(at);
    const size = u32(at + 4);
    const name = text(b, at + 20, 64);
    const d = at + HEADER;
    const end = Math.min(b.length, d + size);
    const kind = (sig >>> 24) & 0x0f;
    const has = (bytes: number) => end - d >= bytes;
    if (kind === KIND.zone && has(96)) {
      const opts = u8(d, end);
      program.zones.push({
        name,
        oneShot: (opts & 0x01) !== 0,
        pitch: (opts & 0x02) === 0,
        reverse: (opts & 0x04) !== 0,
        velocityOn: (opts & 0x08) !== 0,
        key: u8(d + 1, end),
        fine: signed(u8(d + 2, end)),
        pan: signed(u8(d + 3, end)),
        volume: signed(u8(d + 4, end)),
        keyLo: u8(d + 6, end),
        keyHi: u8(d + 7, end),
        velLo: u8(d + 9, end),
        velHi: u8(d + 10, end),
        start: u32(d + 12),
        end: u32(d + 16),
        loopStart: u32(d + 20),
        loopEnd: u32(d + 24),
        loopOn: (u8(d + 33, end) & 0x01) !== 0,
        coarse: signed(u8(d + 80, end)),
        group: i32(d + 88),
        sample: i32(d + 92),
      });
    } else if (kind === KIND.group && has(8)) {
      program.groups.push({
        name,
        volume: signed(u8(d, end)),
        pan: signed(u8(d + 1, end)),
        exclusive: u8(d + 4, end),
        velLo: u8(d + 5, end),
        velHi: has(7) ? u8(d + 6, end) : 127,
        release: u8(d + 73, end) === 1,
        select: has(88)
          ? { type: u8(d + 84, end), number: u8(d + 85, end), lo: u8(d + 86, end), hi: u8(d + 87, end) }
          : { type: 0, number: 0, lo: 0, hi: 127 },
      });
    } else if (kind === KIND.sample && has(20)) {
      program.samples.push({
        name,
        file: text(b, d + 336, 256) || name,
        folder: text(b, d + 80, 256),
        frames: u32(d + 4),
        rate: u32(d + 8),
        channels: u32(d + 16),
      });
    }
    at = d + size;
  }
  if (!program.zones.length && !program.samples.length) throw new Error('An EXS instrument without zones or samples');
  return program;
}
