/**
 * Recorded takes on their way to the song. A take is kept on this device the moment it's recorded,
 * before anything is sent: the server not answering, the network gone or the tab closed mid-upload
 * leaves it here, to be sent again (and placed where it was played) the next time the song is open
 * and the server answers. It's forgotten here once it's with the song.
 */
import type { AudioFile } from '@holo/session';
import { CACHE } from './files.ts';

/** Where a take goes once its file is with the song: its track, and the regions that play it. */
export interface TakePlan {
  project: string;
  track: string;
  /** The take's name ("Vocal #03"); its file is that with .wav. */
  name: string;
  rate: number;
  channels: number;
  seconds: number;
  /** In ticks of the song as written; `offset` is seconds into the file. */
  regions: { from: number; length: number; name: string; offset: number }[];
}

export interface KeptTake extends TakePlan {
  id: string;
  /** When it was recorded (ms since 1970). */
  kept: number;
  /** Its file, once the server has it (what's left is to place it in the song). */
  file?: AudioFile;
}

/** The part of the browser's Cache this needs (a test hands in its own). */
export interface Shelf {
  put(key: string, value: Response): Promise<void>;
  match(key: string): Promise<Response | undefined>;
  keys(): Promise<readonly { url: string }[]>;
  delete(key: string): Promise<boolean>;
}

const SHELF = 'holo-takes-v1';
const HEADER = 'x-holo-take';
const keyOf = (id: string) => `/takes/${id}`;
const idOf = (url: string) => /\/takes\/([\w-]+)$/.exec(url)?.[1] ?? null;

async function browserShelf(): Promise<Shelf | null> {
  if (!('caches' in globalThis)) return null;
  try {
    return (await caches.open(SHELF)) as unknown as Shelf;
  } catch {
    return null;
  }
}

const about = (take: KeptTake) => ({ [HEADER]: encodeURIComponent(JSON.stringify(take)), 'content-type': 'audio/wav' });

function read(res: Response): KeptTake | null {
  try {
    const take = JSON.parse(decodeURIComponent(res.headers.get(HEADER) ?? '')) as KeptTake;
    return take && typeof take.id === 'string' && typeof take.project === 'string' && Array.isArray(take.regions)
      ? take
      : null;
  } catch {
    return null;
  }
}

export class Takes {
  private readonly open: () => Promise<Shelf | null>;
  constructor(open: () => Promise<Shelf | null> = browserShelf) {
    this.open = open;
  }

  /** Keep a take's sound and where it goes. Null when this device has nowhere to keep it. */
  async keep(plan: TakePlan, wav: Blob, now = Date.now()): Promise<KeptTake | null> {
    const shelf = await this.open();
    if (!shelf) return null;
    const take: KeptTake = { ...plan, id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, kept: now };
    try {
      await shelf.put(keyOf(take.id), new Response(wav, { headers: about(take) }));
      return take;
    } catch {
      // (no room, or storage refused)
      return null;
    }
  }

  /** The takes kept here, oldest first (a song's, when one is named). */
  async list(project?: string): Promise<KeptTake[]> {
    const shelf = await this.open();
    if (!shelf) return [];
    const out: KeptTake[] = [];
    for (const key of await shelf.keys()) {
      const id = idOf(key.url);
      const res = id ? await shelf.match(keyOf(id)) : undefined;
      const take = res ? read(res) : null;
      if (take && (!project || take.project === project)) out.push(take);
    }
    return out.sort((a, b) => a.kept - b.kept);
  }

  /** A kept take's sound. */
  async wav(id: string): Promise<Blob | null> {
    const res = await (await this.open())?.match(keyOf(id));
    return res ? res.blob() : null;
  }

  /** The server has its file now: what's left is to place it. */
  async sent(take: KeptTake, file: AudioFile): Promise<KeptTake> {
    const shelf = await this.open();
    const next = { ...take, file };
    const res = await shelf?.match(keyOf(take.id));
    if (shelf && res) await shelf.put(keyOf(take.id), new Response(await res.blob(), { headers: about(next) }));
    return next;
  }

  /** It's with the song: forgotten here. */
  async forget(id: string): Promise<void> {
    await (await this.open())?.delete(keyOf(id)).catch(() => false);
  }
}

export const takes = new Takes();

/** An upload that failed: the server's answer (`status`), or null when there was none. */
export class UploadError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
  /** Worth trying again as it is: the server away or overrun, not the server saying no. */
  get passing(): boolean {
    return this.status === null || this.status >= 500 || this.status === 408 || this.status === 429;
  }
}

/**
 * A take's WAV sent to the song's files. Its bytes go into the device's cache of the song's audio
 * too, so the engine never fetches back what was recorded here.
 */
export async function uploadTake(take: TakePlan, wav: Blob): Promise<AudioFile> {
  const name = `${take.name}.wav`;
  let res: Response;
  try {
    res = await fetch(`/api/projects/${take.project}/files?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-holo-audio' },
      body: wav,
    });
  } catch {
    throw new UploadError('the server didn’t answer', null);
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok || !body.id) throw new UploadError(body.error ?? 'the server refused it', res.status);
  try {
    const cache = await caches.open(CACHE);
    await cache.put(`/api/projects/${take.project}/files/${body.id}`, new Response(wav));
  } catch {
    // fetched again when needed
  }
  return { id: body.id, name, seconds: take.seconds, rate: take.rate, channels: take.channels };
}
