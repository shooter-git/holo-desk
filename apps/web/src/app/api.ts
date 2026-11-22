/** The server's API, as the studio uses it. */
import type { Project } from '@holo/session';

export interface ProjectRow {
  id: string;
  title: string;
  revision: number;
  created: string;
  modified: string;
  creation: string | null;
  piece: string | null;
  /** Who the song is by and the album it's on; null when not said. */
  artist: string | null;
  album: string | null;
}

export interface CreationPiece {
  piece: string;
  title: string;
  modified: string;
  tracks: number;
  edited: number;
  project: string | null;
}

/**
 * An experience's pinned engine (what its own build makes its songs with), and how it stands to the
 * studio's: the same, older (`holo update-engine` there), newer (the studio is behind) or different.
 */
export interface CreationEngine {
  label: string;
  commit: string | null;
  date: string | null;
  node: string;
  relation: 'same' | 'older' | 'newer' | 'different';
  studio: string;
  studioDate: string | null;
}

export interface Creation {
  name: string;
  title: string;
  exportHelp: string | null;
  renderHelp: string | null;
  /** It says how to render a piece itself (and so can be heard as it plays it). */
  canRender: boolean;
  /** An experience (a project set up with `holo init`) builds its songs with a pinned engine. */
  engine: CreationEngine | null;
  pieces: CreationPiece[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

/**
 * How long a save may take before it's given up and made again: a while for the host to answer, and
 * as long again as sending the song takes at a slow phone network's pace (a big song takes longer).
 */
export const SAVE_MS = 30_000;
const SAVE_BYTES_PER_S = 20_000;
export const saveWithin = (bytes: number) => SAVE_MS + (bytes / SAVE_BYTES_PER_S) * 1000;

/**
 * For each song, how many of its saves in a row ran out of time: each one after is given twice as
 * long as the last (a network slower than that pace still gets there in the end, while a page frozen
 * with a save on its way still lets it go the first time). An answer from the host starts it again.
 */
const saveTimeouts = new Map<string, number>();
/** (the longest a timer can wait) */
const LONGEST_MS = 2 ** 31 - 1;

/** How long a request that's given up only when nothing comes waits for the next of what it's sent. */
export const IDLE_MS = 15_000;

/**
 * A request's answer as text, given up (`AbortError`) once nothing of it has come for `idleMs`: the
 * answer, then each piece of it as it arrives, starts the wait again. A big song on a slow network takes
 * as long as it takes, while a page frozen mid-way, or a network gone, is given up.
 */
export async function patiently(
  path: string,
  init: RequestInit,
  idleMs: number,
): Promise<{ res: Response; text: string }> {
  const stop = new AbortController();
  // (whatever the browser does with the request once it's given up, waiting on it ends then)
  const given = new Promise<never>((_ok, fail) =>
    stop.signal.addEventListener('abort', () => fail(new DOMException('Nothing came', 'AbortError'))),
  );
  given.catch(() => undefined);
  let timer = setTimeout(() => stop.abort(), idleMs);
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stop.abort(), idleMs);
  };
  init.signal?.addEventListener('abort', () => stop.abort());
  try {
    const res = await Promise.race([fetch(path, { ...init, signal: stop.signal }), given]);
    alive();
    const reader = res.body?.getReader();
    if (!reader) return { res, text: await Promise.race([res.text(), given]) };
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), given]);
      if (done) break;
      text += decoder.decode(value, { stream: true });
      alive();
    }
    return { res, text: text + decoder.decode() };
  } finally {
    clearTimeout(timer);
  }
}

async function call<T>(path: string, init?: RequestInit, idleMs?: number): Promise<T> {
  const asked: RequestInit = {
    ...init,
    headers:
      init?.body && typeof init.body === 'string'
        ? { 'content-type': 'application/json', ...init.headers }
        : init?.headers,
  };
  const { res, text } = idleMs
    ? await patiently(path, asked, idleMs)
    : await fetch(path, asked).then(async (r) => ({ res: r, text: await r.text() }));
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    throw new ApiError(message, res.status, body);
  }
  return body as T;
}

export const api = {
  projects: () => call<ProjectRow[]>('/api/projects'),
  project: (id: string) => call<Project>(`/api/projects/${id}`),
  /**
   * A song as one of its kept revisions had it (a version a reply plays or keeps). Given up only when
   * nothing of it comes for a while (`patiently`).
   */
  revision: (id: string, revision: number) =>
    call<Project>(`/api/projects/${id}/history/${revision}`, undefined, IDLE_MS),
  create: (title: string) => call<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ title }) }),
  createFrom: (doc: Project) => call<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ doc }) }),
  /**
   * Save a song on the revision it was made on. Given up after `saveWithin` its size (a page frozen
   * with it on its way, as a phone's is in the background), so it can be made again: one that got
   * there anyway is then found to be the song as it is (actions.ts). Each try after one that ran out
   * of time is given twice as long (`saveTimeouts`).
   */
  save: (doc: Project, baseRevision: number) => {
    const body = JSON.stringify({ doc, baseRevision });
    const stop = new AbortController();
    const late = saveTimeouts.get(doc.id) ?? 0;
    let ranOut = false;
    const timer = setTimeout(
      () => {
        ranOut = true;
        stop.abort();
      },
      Math.min(LONGEST_MS, saveWithin(body.length) * 2 ** Math.min(late, 30)),
    );
    return call<{ revision: number; modified: string }>(`/api/projects/${doc.id}`, {
      method: 'PUT',
      body,
      signal: stop.signal,
    })
      .then(
        (r) => {
          saveTimeouts.delete(doc.id);
          return r;
        },
        (err: unknown) => {
          // (an answer, a refusal too, means the song got there: the next is given the usual time)
          if (ranOut) saveTimeouts.set(doc.id, late + 1);
          else if (err instanceof ApiError) saveTimeouts.delete(doc.id);
          throw err;
        },
      )
      .finally(() => clearTimeout(timer));
  },
  remove: (id: string) => call<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  /** Set a song's artist or album (null clears one; one left out stays). */
  setDetails: (id: string, details: { artist?: string | null; album?: string | null }) =>
    call<{ ok: boolean; artist: string | null; album: string | null }>(`/api/projects/${id}/details`, {
      method: 'PUT',
      body: JSON.stringify(details),
    }),
  importMidi: (file: File) =>
    call<Project>(`/api/import/midi?title=${encodeURIComponent(file.name.replace(/\.midi?$/i, ''))}`, {
      method: 'POST',
      body: file,
      headers: { 'content-type': 'audio/midi' },
    }),
  importScore: (file: File) =>
    call<Project>(`/api/import/score?title=${encodeURIComponent(file.name.replace(/\.(musicxml|xml|mxl)$/i, ''))}`, {
      method: 'POST',
      body: file,
      headers: { 'content-type': 'application/vnd.recordare.musicxml+xml' },
    }),
  creations: () => call<Creation[]>('/api/creations'),
  openPiece: (creation: string, piece: string, mode: 'new' | 'replace' = 'replace') =>
    call<Project>(`/api/creations/${creation}/pieces/${piece}/open`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  newSongFor: (creation: string, title: string) =>
    call<{ project: Project; path: string }>(`/api/creations/${creation}/songs`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  send: (id: string) =>
    call<{
      ok: boolean;
      path: string;
      edited: string[];
      /** The packs the experience pins now (added, let go, and those it can't), in a line. */
      note?: string;
      packs?: { added: string[]; dropped: string[]; missing: { id: string; why: string }[] };
    }>(`/api/projects/${id}/send`, { method: 'POST' }),
  settings: () => call<{ middleC: 'C3' | 'C4' }>('/api/settings'),
  saveSettings: (s: { middleC: 'C3' | 'C4' }) =>
    call<{ middleC: 'C3' | 'C4' }>('/api/settings', { method: 'PUT', body: JSON.stringify(s) }),
};
