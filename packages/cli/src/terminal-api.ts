/**
 * The in-app agent's tools, run from the command line: a JobApi (@holo/agent) over the routes `holo`
 * has always used and a few of its own, so a `holo` command that does what one of the agent's tools
 * does runs that tool's own code, and says what it says. The agent itself never reaches any of this:
 * its tools reach HO[LO] only through the job routes (httpJobApi).
 *
 * - The song is read as saved (`GET /api/projects/:id`, as every `holo` command reads it), and its
 *   changes go to `POST /api/projects/:id/ops` with the command line's author: in the open studio
 *   they're one undo step, labelled "AI: …", as any `holo` change is.
 * - The playhead and the selection are the open studio's (`GET /api/live/state`), when it has the song.
 * - What was just played: `GET /api/live/played`. Measurements: `/api/projects/:id/measure` (the
 *   agent's measuring, for the command line).
 * - What the agent takes as an attachment, the command line takes as a file on this computer
 *   (`attach`): a MIDI or MusicXML file is read here, a recording is sent to HO[LO] (as `holo audio`
 *   sends one, or to be measured).
 *
 * What belongs to a request in the bar (permissions, a brief, finishing a turn, A/B against the song
 * before the request, a listen in parts, a scan's strip as a picture) has no route here: those answer
 * that the terminal has other ways (`holo listen`, `holo scan show`…).
 */
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import {
  ApiError,
  type Attachment,
  type ImportAnswer,
  type JobApi,
  type MeasureAnswer,
  type MeasureBody,
  type StudioState,
} from '@holo/agent';
import { readMusicXml, scoreFileText } from '@holo/score';
import { barToTick, type Project, projectFromMidi, readMidi } from '@holo/session';

export interface TerminalApiOptions {
  /** Where HO[LO] answers (HOLO_URL). */
  base: string;
  /** The song the tools work on. */
  song: string;
  /** Who the changes are by, as the studio labels them ("AI: …"). */
  author: string;
}

export interface TerminalApi extends JobApi {
  /** Where each change went (the open studio, or the saved song) and its revision. */
  readonly changes: { via: string; revision?: number }[];
  /** The last measuring call's answer, as HO[LO] gave it (`holo measure --json` prints it). */
  measured: MeasureAnswer | null;
  /** A file on this computer as the attachment id the tools take (import, measure, analyze_played). */
  attach(path: string): string;
}

/** What a file is, from its first bytes (its name when they don't say). */
export type FileKind = 'midi' | 'score' | 'recording' | 'browser-recording' | 'other';

export function fileKind(name: string, bytes: Uint8Array): FileKind {
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  const at8 = String.fromCharCode(...bytes.subarray(8, 12));
  if (tag === 'MThd') return 'midi';
  if ((tag === 'RIFF' || tag === 'RF64') && at8 === 'WAVE') return 'recording';
  if (tag === 'fLaC' || (tag === 'FORM' && (at8 === 'AIFF' || at8 === 'AIFC'))) return 'recording';
  if (tag === 'OggS' || tag.startsWith('ID3') || String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp')
    return 'browser-recording';
  if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) return 'browser-recording';
  if (tag.startsWith('PK')) return /\.mxl$/i.test(name) ? 'score' : 'other';
  const ext = extname(name).toLowerCase();
  if (ext === '.mid' || ext === '.midi') return 'midi';
  if (ext === '.musicxml' || ext === '.xml' || ext === '.mxl') return 'score';
  if (['.mp3', '.ogg', '.m4a', '.aac'].includes(ext)) return 'browser-recording';
  return 'other';
}

const TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.musicxml': 'application/vnd.recordare.musicxml+xml',
  '.xml': 'application/vnd.recordare.musicxml+xml',
  '.mxl': 'application/vnd.recordare.musicxml',
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Who a song is by and its album (and its creation), in a line or two, as the agent's prompt says them. */
export function aboutLines(
  row: { artist?: string | null; album?: string | null; creation?: string | null; piece?: string | null } | null,
): string[] {
  if (!row) return [];
  const lines: string[] = [];
  if (row.artist) lines.push(`By "${row.artist}"${row.album ? `, on the album "${row.album}"` : ', on no album'}.`);
  else if (row.album) lines.push(`On the album "${row.album}"; no artist is set.`);
  else lines.push('No artist or album is set for it.');
  if (row.creation)
    lines.push(`It belongs to the creation "${row.creation}"${row.piece ? ` (its piece "${row.piece}")` : ''}.`);
  return lines;
}

export function terminalApi(o: TerminalApiOptions): TerminalApi {
  const base = o.base.replace(/\/$/, '');
  const song = encodeURIComponent(o.song);
  const files = new Map<string, string>();
  const changes: { via: string; revision?: number }[] = [];

  async function request(method: string, path: string, body?: { json: unknown } | { bytes: Uint8Array; type: string }) {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        ...(body && 'json' in body
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body.json) }
          : body
            ? { headers: { 'content-type': body.type }, body: body.bytes }
            : {}),
      });
    } catch {
      throw new ApiError(
        503,
        `HO[LO] isn't answering at ${base}. Start it (pnpm dev, or pnpm up for Docker) or set HOLO_URL.`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let msg = text;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // plain text
      }
      throw new ApiError(res.status, msg || `${res.status} ${res.statusText}`);
    }
    return res;
  }
  const json = async <T>(method: string, path: string, body?: { json: unknown }) =>
    (await (await request(method, path, body)).json()) as T;

  /** A studio's answer passed on by the server ({ok:false, error} when it couldn't). */
  const studio = async (path: string, payload: unknown) => {
    const r = await json<{ ok?: boolean; error?: string }>('POST', path, { json: payload });
    if (r.ok === false) throw new ApiError(409, r.error ?? 'The studio couldn’t');
    return { ok: true };
  };

  const row = async () =>
    (
      await json<
        { id: string; artist?: string | null; album?: string | null; creation?: string | null; piece?: string | null }[]
      >('GET', '/api/projects')
    ).find((r) => r.id === o.song) ?? null;

  const fileOf = (id: string): string => {
    const path = files.get(id);
    if (!path) throw new ApiError(404, `No file ${id}`);
    return path;
  };

  const unsupported = (what: string, instead: string) => () =>
    Promise.reject(
      new ApiError(501, `${what} belongs to a request in the studio's bar; from the terminal, ${instead}`),
    );

  const impl: Partial<TerminalApi> & Pick<TerminalApi, 'changes' | 'attach'> = {
    changes,
    measured: null,
    attach(path) {
      const id = `att_${(files.size + 1).toString(16).padStart(12, '0')}`;
      files.set(id, path);
      return id;
    },

    song: () => json<Project>('GET', `/api/projects/${song}`),
    async describe() {
      const [text, about] = await Promise.all([
        (await request('GET', `/api/projects/${song}/describe`)).text(),
        row().then(aboutLines),
      ]);
      return { text: about.length ? `${about.join('\n')}\n${text}` : text };
    },
    async state() {
      const [live, about] = await Promise.all([
        json<{
          state: {
            project: string | null;
            tick: number;
            playing: boolean;
            recording: boolean;
            bpm: number;
            selection: StudioState['selection'];
            cycle: { on: boolean; start: number; end: number };
            middleC: string;
          } | null;
        }>('GET', '/api/live/state'),
        row().then(aboutLines),
      ]);
      const s = live.state;
      // the open studio's playhead and selection, when it has this song open
      if (!s || s.project !== o.song) return { about };
      return {
        playhead: s.tick,
        playing: s.playing,
        recording: s.recording,
        bpm: s.bpm,
        selection: s.selection,
        cycle: s.cycle,
        middleC: s.middleC,
        about,
      };
    },
    async ops(ops, label) {
      const r = await json<{ via: string; revision?: number }>('POST', `/api/projects/${song}/ops`, {
        json: { ops, author: o.author, label },
      });
      changes.push(r);
      return { ok: true, ...(r.revision !== undefined ? { revision: r.revision } : {}) };
    },
    async transport(body) {
      const at = body.bar !== undefined ? barToTick((await impl.song?.())?.meter ?? [], body.bar) : undefined;
      return studio('/api/live/transport', { action: body.action, ...(at !== undefined ? { at } : {}) });
    },
    audition: (body) => json('POST', '/api/live/midi', { json: { events: body.events, track: body.track ?? null } }),
    played: (seconds) => json('GET', `/api/live/played?seconds=${seconds}&project=${song}`),
    packs: () => json('GET', '/api/packs'),
    packsAvailable: () => json('GET', '/api/packs/available'),
    instrument: (pack, name) =>
      json('GET', `/api/packs/${encodeURIComponent(pack)}/instruments/${encodeURIComponent(name)}`),
    async scan(id) {
      const scan = await json<Awaited<ReturnType<JobApi['scan']>>>('GET', `/api/scans/${encodeURIComponent(id)}`);
      if (scan.project !== o.song) throw new ApiError(403, 'That scan is another song’s');
      return scan;
    },
    scanSystem: (id, page, system, body) =>
      json('PATCH', `/api/scans/${encodeURIComponent(id)}/systems/${page}/${system}`, { json: body }),
    async attachment(id): Promise<Attachment> {
      const path = fileOf(id);
      const bytes = readFileSync(path);
      return {
        name: basename(path),
        type: TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
        size: bytes.length,
        // (what the studio measures of a file dropped on the bar: nothing, from here)
        meta: null,
      };
    },
    progress: async () => ({ ok: true }),
    details: (body) => json('PUT', `/api/projects/${song}/details`, { json: body }),

    async measure(body: MeasureBody) {
      const { attachment, ...rest } = body;
      let ask: Record<string, unknown> = rest;
      if (attachment) {
        // a recording on this computer: sent first, then named by the id HO[LO] gives it
        const path = fileOf(attachment);
        const res = await request(
          'POST',
          `/api/projects/${song}/measure/files?name=${encodeURIComponent(basename(path))}`,
          {
            bytes: new Uint8Array(readFileSync(path)),
            type: 'application/x-holo-audio',
          },
        );
        ask = { ...rest, file: ((await res.json()) as { file: string }).file };
      }
      const answer = await json<MeasureAnswer>('POST', `/api/projects/${song}/measure`, { json: ask });
      impl.measured = answer;
      return answer;
    },
    async measureTask(task) {
      const answer = await json<MeasureAnswer>('GET', `/api/projects/${song}/measure/${encodeURIComponent(task)}`);
      impl.measured = answer;
      return answer;
    },

    async importAttachment(id): Promise<ImportAnswer> {
      const path = fileOf(id);
      const name = basename(path);
      const bytes = new Uint8Array(readFileSync(path));
      const title = name.replace(/\.[^.]+$/, '') || 'Imported';
      switch (fileKind(name, bytes)) {
        case 'midi': {
          let read: Project;
          try {
            read = projectFromMidi(readMidi(bytes), title);
          } catch (err) {
            throw new ApiError(400, `${name} isn’t a MIDI file HO[LO] can read (${message(err)})`);
          }
          return { done: true, kind: 'notes', format: 'midi', name, song: read, warnings: [] };
        }
        case 'score': {
          try {
            const read = readMusicXml(await scoreFileText(bytes), title);
            return { done: true, kind: 'notes', format: 'musicxml', name, song: read.project, warnings: read.warnings };
          } catch (err) {
            throw new ApiError(400, `${name} isn’t a score HO[LO] can read (${message(err)})`);
          }
        }
        case 'recording': {
          // one of the song's files, as `holo audio` sends it (FLAC and AIFF are kept as WAV)
          const res = await request('POST', `/api/projects/${song}/files?name=${encodeURIComponent(name)}`, {
            bytes,
            type: 'application/x-holo-audio',
          });
          const up = (await res.json()) as { id?: string; seconds?: number; rate?: number; channels?: number };
          if (!up.id || !up.seconds || !up.rate || !up.channels)
            throw new ApiError(400, `${name}: HO[LO] couldn't read how long it is`);
          return {
            done: true,
            kind: 'audio',
            how: extname(name).toLowerCase() === '.wav' ? 'copied' : 'converted',
            file: { id: up.id, name, seconds: up.seconds, rate: up.rate, channels: up.channels },
          };
        }
        case 'browser-recording':
          throw new ApiError(
            415,
            `${name}: only a browser decodes ${extname(name) || 'this kind of recording'}: drop it on the studio, or make it a WAV or FLAC first`,
          );
        default:
          throw new ApiError(415, `${name} isn't a recording (WAV, FLAC, AIFF), a MIDI file or a MusicXML score`);
      }
    },

    compare: unsupported('A/B against the song before the request', 'play the bars with holo play'),
    listen: unsupported('A listen in parts', 'holo listen --seconds N hears what is played'),
    scanStrip: unsupported('A scan’s strip as a picture', 'holo scan show saves the strips as files'),
    permission: unsupported('Asking the user', 'ask them yourself'),
    handoff: unsupported('A brief for the user’s harness', 'you are in a terminal already'),
    finish: unsupported('Finishing a turn', 'there is no turn to finish'),
  };

  // anything the agent's API offers that the terminal has no route for answers so, rather than failing
  return new Proxy(impl, {
    get(target, key, receiver) {
      if (key in target || typeof key !== 'string' || key === 'then') return Reflect.get(target, key, receiver);
      return unsupported(key, 'there is no route for it here');
    },
  }) as TerminalApi;
}
