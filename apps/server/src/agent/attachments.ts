/**
 * What a device attaches to a request: an image (a screenshot, a photo of a page), a recording, a MIDI
 * or MusicXML file, a text. Each is kept for a week in the data folder (`agent/attachments/<id>/`),
 * belongs to the device that sent it and the song it was sent for, and is read only by that device's
 * requests on that song and their jobs. What a file says it is must be what it is: its first bytes are
 * checked, and text must be UTF-8.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ATTACHMENT_ID = /^att_[0-9a-f]{12}$/;

/** At most this big, and text at most this. */
export const MAX_ATTACHMENT = 25 * 1024 * 1024;
export const MAX_TEXT = 100 * 1024;
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
  'audio/mpeg',
  'audio/ogg',
  'audio/mp4',
  'audio/midi',
  'application/vnd.recordare.musicxml+xml',
  'text/plain',
] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

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

/** Why a file isn't the type it says (null: it is). */
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
      const text = utf8(data);
      if (text === null) return wrong;
      const head = text.replace(/^\uFEFF/, '').trimStart();
      // XML, and a score: what MusicXML's root is called
      return head.startsWith('<') && /<score-(partwise|timewise)[\s>]/.test(text) ? null : wrong;
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

  /** Keep a file a device sent for a song (its type checked already). */
  add(device: string, project: string, name: string, type: AttachmentType, data: Buffer): AttachmentRecord {
    const id = `att_${randomBytes(6).toString('hex')}`;
    const record: AttachmentRecord = {
      id,
      device,
      project,
      name,
      type,
      size: data.length,
      created: this.now(),
      meta: null,
    };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const folder = this.folder(id);
    mkdirSync(folder, { mode: 0o700 });
    writeFileSync(join(folder, 'data'), data, { mode: 0o600 });
    this.write(record);
    return record;
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
