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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers:
      init?.body && typeof init.body === 'string'
        ? { 'content-type': 'application/json', ...init.headers }
        : init?.headers,
  });
  const text = await res.text();
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
  create: (title: string) => call<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ title }) }),
  createFrom: (doc: Project) => call<Project>('/api/projects', { method: 'POST', body: JSON.stringify({ doc }) }),
  save: (doc: Project, baseRevision: number) =>
    call<{ revision: number; modified: string }>(`/api/projects/${doc.id}`, {
      method: 'PUT',
      body: JSON.stringify({ doc, baseRevision }),
    }),
  remove: (id: string) => call<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
  importMidi: (file: File) =>
    call<Project>(`/api/import/midi?title=${encodeURIComponent(file.name.replace(/\.midi?$/i, ''))}`, {
      method: 'POST',
      body: file,
      headers: { 'content-type': 'audio/midi' },
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
    call<{ ok: boolean; path: string; edited: string[] }>(`/api/projects/${id}/send`, { method: 'POST' }),
  settings: () => call<{ middleC: 'C3' | 'C4' }>('/api/settings'),
  saveSettings: (s: { middleC: 'C3' | 'C4' }) =>
    call<{ middleC: 'C3' | 'C4' }>('/api/settings', { method: 'PUT', body: JSON.stringify(s) }),
};
