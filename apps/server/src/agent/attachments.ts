/**
 * What a device attaches to a request: an image (a screenshot, a photo of a page), a recording, a MIDI
 * or MusicXML file (plain or compressed, .mxl), a text. Each is kept for a week in the data folder
 * (`agent/attachments/<id>/`), belongs to the device that sent it and the song it was sent for. Only
 * that device can attach it to a request; a job reads its own request's attachments and those of
 * earlier requests on its conversation (the song's thread, which may carry other allowed devices'
 * requests). What a file says it is must be what it is: its first bytes are checked, text must be
 * UTF-8, and MusicXML UTF-8 or UTF-16. A file goes to disk as it arrives, cut off at its type's limit
 * (a recording can be long).
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { readMxl } from '@holo/score';

export const ATTACHMENT_ID = /^att_[0-9a-f]{12}$/;

/** At most this big (a recording at most MAX_AUDIO), and text at most this. */
export const MAX_ATTACHMENT = 25 * 1024 * 1024;
export const MAX_AUDIO = 200 * 1024 * 1024;
export const MAX_TEXT = 100 * 1024;
/** What's read of a recording to check its type: its first bytes. */
export const HEAD = 64 * 1024;
/** What the browser measured of one, at most this much JSON. */
export const MAX_META = 64 * 1024;
/** Kept this long. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export const ATTACHMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/aiff',
  'audio/mpeg',
  'audio/ogg',
  'audio/mp4',
  'audio/midi',
  'application/vnd.recordare.musicxml+xml',
  // compressed MusicXML (.mxl): a zip holding the score
  'application/vnd.recordare.musicxml',
  'text/plain',
] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

/** A recording (not a MIDI file). */
export const isAudio = (type: string): boolean => type.startsWith('audio/') && type !== 'audio/midi';
/** A MusicXML score, plain or compressed. */
export const isScore = (type: string): boolean => type.startsWith('application/vnd.recordare.musicxml');

/** The most a file of a type may be. */
export const maxSize = (type: AttachmentType): number =>
  type === 'text/plain' ? MAX_TEXT : isAudio(type) ? MAX_AUDIO : MAX_ATTACHMENT;

/** What's said of a file over its type's limit. */
export function tooBigText(type: AttachmentType): string {
  if (type === 'text/plain') return `A text is ${MAX_TEXT / 1024} KB at most`;
  return `${isAudio(type) ? 'A recording' : 'A file'} is ${maxSize(type) / (1024 * 1024)} MB at most`;
}

export interface AttachmentRecord {
  id: string;
  /** The device that sent it, and the song it was sent for. */
  device: string;
  project: string;
  name: string;
  type: AttachmentType;
  size: number;
  created: number;
  /** What the browser measured of it (tempo, key, notes, frames…), as it sent it. */
  meta: unknown;
}

const ascii = (data: Buffer, at: number, text: string) =>
  data.subarray(at, at + text.length).toString('latin1') === text;

/** UTF-8 text with no NULs, or null. */
function utf8(data: Buffer): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return text.includes('\u0000') ? null : text;
  } catch {
    return null;
  }
}

/**
 * MusicXML's text: UTF-8 (with or without its mark), or UTF-16 (with its mark, or without one when it
 * starts as XML does); null when it's none of these.
 */
export function musicXmlText(data: Buffer): string | null {
  const strict = (encoding: string, bytes: Buffer) => {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  };
  let text: string | null;
  if (data[0] === 0xff && data[1] === 0xfe) text = strict('utf-16le', data.subarray(2));
  else if (data[0] === 0xfe && data[1] === 0xff) text = strict('utf-16be', data.subarray(2));
  else if (data[0] === 0x3c && data[1] === 0x00) text = strict('utf-16le', data);
  else if (data[0] === 0x00 && data[1] === 0x3c) text = strict('utf-16be', data);
  else return utf8(data)?.replace(/^﻿/, '') ?? null;
  return text === null || text.includes('\u0000') ? null : text;
}

/** Whether text is a MusicXML score: XML, with a score as its root. */
const isScoreText = (text: string) => text.trimStart().startsWith('<') && /<score-(partwise|timewise)[\s>]/.test(text);

/** The names of a zip's files, from its central directory (null: it isn't a zip). */
export function zipNames(data: Buffer): string[] | null {
  if (data.length < 22 || data.readUInt32LE(0) !== 0x04034b50) return null;
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const count = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let k = 0; k < count; k++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50) return null;
    const nameLength = data.readUInt16LE(at + 28);
    names.push(data.subarray(at + 46, at + 46 + nameLength).toString('utf8'));
    at += 46 + nameLength + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
  }
  return names;
}

/** A score attachment as MusicXML text (an .mxl's score unzipped); throws when it holds none. */
export async function scoreText(type: AttachmentType, data: Buffer): Promise<string> {
  const text = type === 'application/vnd.recordare.musicxml' ? await readMxl(data) : musicXmlText(data);
  if (text === null || !isScoreText(text)) throw new Error('That isn’t a MusicXML score');
  return text;
}

/**
 * Why a file isn't the type it says (null: it is). A recording's first bytes (HEAD) are enough;
 * anything else is read whole.
 */
export function sniff(type: AttachmentType, data: Buffer): string | null {
  const wrong = `That isn't ${type === 'text/plain' ? 'UTF-8 text' : `a ${type} file`}`;
  if (!data.length) return 'The file is empty';
  switch (type) {
    case 'image/png':
      return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? null : wrong;
    case 'image/jpeg':
      return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff ? null : wrong;
    case 'image/webp':
      return ascii(data, 0, 'RIFF') && ascii(data, 8, 'WEBP') ? null : wrong;
    case 'audio/wav':
    case 'audio/x-wav':
      return (ascii(data, 0, 'RIFF') || ascii(data, 0, 'RF64')) && ascii(data, 8, 'WAVE') ? null : wrong;
    case 'audio/flac':
      return ascii(data, 0, 'fLaC') ? null : wrong;
    case 'audio/aiff':
      return ascii(data, 0, 'FORM') && (ascii(data, 8, 'AIFF') || ascii(data, 8, 'AIFC')) ? null : wrong;
    case 'audio/mpeg':
      // an ID3 tag, or a frame's sync bits
      return ascii(data, 0, 'ID3') || (data[0] === 0xff && ((data[1] ?? 0) & 0xe0) === 0xe0) ? null : wrong;
    case 'audio/ogg':
      return ascii(data, 0, 'OggS') ? null : wrong;
    case 'audio/mp4':
      return ascii(data, 4, 'ftyp') ? null : wrong;
    case 'audio/midi':
      return ascii(data, 0, 'MThd') ? null : wrong;
    case 'text/plain': {
      if (data.length > MAX_TEXT) return `A text is ${MAX_TEXT / 1024} KB at most`;
      return utf8(data) === null ? wrong : null;
    }
    case 'application/vnd.recordare.musicxml+xml': {
      // XML, and a score: what MusicXML's root is called
      const text = musicXmlText(data);
      return text !== null && isScoreText(text) ? null : wrong;
    }
    case 'application/vnd.recordare.musicxml': {
      // a zip with a score in it: the container that says which, or an XML file outside META-INF
      const names = zipNames(data);
      const score = names?.some(
        (n) => n === 'META-INF/container.xml' || (!n.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(n)),
      );
      return score ? null : wrong;
    }
  }
}

/** A few words of what the browser measured, for the prompt: its simple values, and how many of its lists. */
export function metaSummary(meta: unknown): string {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    if (!/^[\w-]{1,30}$/.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) parts.push(`${key} ${Math.round(value * 100) / 100}`);
    else if (typeof value === 'boolean') parts.push(`${key} ${value ? 'yes' : 'no'}`);
    else if (typeof value === 'string' && value.trim())
      parts.push(`${key} ${value.replace(/\s+/g, ' ').trim().slice(0, 40)}`);
    else if (Array.isArray(value)) parts.push(`${key}: ${value.length}`);
    if (parts.length >= 8) break;
  }
  return parts.join(', ').slice(0, 240);
}

export class Attachments {
  private readonly dir: string;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(dir: string, now: () => number = () => Date.now()) {
    this.dir = dir;
    this.now = now;
  }

  /** Clear out what's a week old now, and every hour from now on. */
  start(): void {
    this.sweep();
    this.timer = setInterval(() => this.sweep(), HOUR);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private folder(id: string): string {
    return join(this.dir, id);
  }

  /** A new attachment's folder, made private: its id. */
  private make(): string {
    const id = `att_${randomBytes(6).toString('hex')}`;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.folder(id), { mode: 0o700 });
    return id;
  }

  /** Keep a file a device sent for a song (its type checked already). */
  add(device: string, project: string, name: string, type: AttachmentType, data: Buffer): AttachmentRecord {
    const id = this.make();
    writeFileSync(join(this.folder(id), 'data'), data, { mode: 0o600 });
    return this.keep(id, device, project, name, type, data.length);
  }

  /**
   * A file as it arrives, written to disk piece by piece, at most `max` bytes: its id and size. It
   * isn't an attachment yet: `keep` makes it one once its type is checked, `discard` lets it go. Past
   * `max` the rest isn't read, what came is removed, and the answer is null.
   */
  async receive(body: AsyncIterable<Uint8Array | string>, max: number): Promise<{ id: string; size: number } | null> {
    const id = this.make();
    const fd = openSync(join(this.folder(id), 'data'), 'wx', 0o600);
    let size = 0;
    let open = true;
    const close = () => {
      if (open) closeSync(fd);
      open = false;
    };
    try {
      for await (const chunk of body) {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        size += bytes.length;
        if (size > max) {
          close();
          this.discard(id);
          return null;
        }
        writeSync(fd, bytes);
      }
      close();
      return { id, size };
    } catch (err) {
      close();
      this.discard(id);
      throw err;
    }
  }

  /** The first `bytes` of a received file (all of it when unsaid). */
  head(id: string, bytes = Number.POSITIVE_INFINITY): Buffer {
    const path = join(this.folder(id), 'data');
    if (!Number.isFinite(bytes)) return readFileSync(path);
    const out = Buffer.alloc(Math.min(bytes, statSync(path).size));
    const fd = openSync(path, 'r');
    try {
      readSync(fd, out, 0, out.length, 0);
    } finally {
      closeSync(fd);
    }
    return out;
  }

  /** A received file kept: the device's, for the song. */
  keep(
    id: string,
    device: string,
    project: string,
    name: string,
    type: AttachmentType,
    size: number,
  ): AttachmentRecord {
    const record: AttachmentRecord = { id, device, project, name, type, size, created: this.now(), meta: null };
    this.write(record);
    return record;
  }

  /** A received file let go (its type wasn't what it said). */
  discard(id: string): void {
    if (ATTACHMENT_ID.test(id)) rmSync(this.folder(id), { recursive: true, force: true });
  }

  private write(record: AttachmentRecord): void {
    const file = join(this.folder(record.id), 'info.json');
    writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  get(id: string): AttachmentRecord | null {
    if (!ATTACHMENT_ID.test(id)) return null;
    try {
      const record = JSON.parse(readFileSync(join(this.folder(id), 'info.json'), 'utf8')) as AttachmentRecord;
      return record.id === id && this.now() - record.created < KEEP_MS ? record : null;
    } catch {
      return null;
    }
  }

  data(id: string): Buffer | null {
    if (!this.get(id)) return null;
    try {
      return readFileSync(join(this.folder(id), 'data'));
    } catch {
      return null;
    }
  }

  /** Where a kept attachment's file is on disk (null: no such attachment, or it's gone). */
  file(id: string): string | null {
    if (!this.get(id)) return null;
    const path = join(this.folder(id), 'data');
    return existsSync(path) ? path : null;
  }

  setMeta(id: string, meta: unknown): void {
    const record = this.get(id);
    if (record) this.write({ ...record, meta });
  }

  /** Remove what's a week old (and anything there that isn't an attachment's). How many went. */
  sweep(): number {
    if (!existsSync(this.dir)) return 0;
    let removed = 0;
    for (const name of readdirSync(this.dir)) {
      const path = join(this.dir, name);
      let old = true;
      if (ATTACHMENT_ID.test(name)) {
        try {
          const record = JSON.parse(readFileSync(join(path, 'info.json'), 'utf8')) as AttachmentRecord;
          old = this.now() - record.created >= KEEP_MS;
        } catch {
          // half written, or damaged: by the folder's age
          old = this.now() - statSync(path).mtimeMs >= HOUR;
        }
      }
      if (old) {
        rmSync(path, { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }
}
