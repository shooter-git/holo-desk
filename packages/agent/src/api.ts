/**
 * What the agent's tools can reach: the job-scoped endpoints `/api/agent/jobs/:job/*` (docs/agent.md),
 * and nothing else. The server checks the job token on each call, that the job is running, and that
 * its song is the one the requester has open.
 */
import { readFileSync } from 'node:fs';
import type { Scan, ScanSystem, SystemState } from '@holo/score';
import { type AudioFile, applyOps, describeProject, type Op, type Project, type SampleMic } from '@holo/session';

/** What the requester's studio shows: the playhead, the selection, the cycle and the view. */
export interface StudioState {
  /** The playhead, in ticks. */
  playhead?: number;
  playing?: boolean;
  recording?: boolean;
  bpm?: number;
  /** The editor in front ("arrange", "piano roll", "score", "mixer"…). */
  view?: string;
  selection?: { track?: string | null; regions?: string[]; notes?: number; from?: number; to?: number };
  cycle?: { on: boolean; start: number; end: number };
  /** The scan open in the Scan window, if one is. */
  scan?: string | null;
  /** Who the song is by, its album and its creation, in words (the library keeps them beside the song). */
  about?: string[];
  [key: string]: unknown;
}

/** A note the user played on a MIDI device (or sang, through pitch tracking). */
export interface PlayedNote {
  /** Song tick when played (null when the song wasn't playing). */
  tick: number | null;
  /** ms from the start of what's returned: a listen's start (its first part), or the stretch asked for. */
  time: number;
  pitch: number;
  velocity: number;
  /** Length in ms (null if still held). */
  length: number | null;
  port: string;
}

export interface PackInstrument {
  name: string;
  title: string;
  category: string;
  zones?: number;
  size?: number;
  kit?: boolean;
  mics?: SampleMic[];
}

/** A palette's ready-made sound, as a pack lists it (PackSound in @holo/session). */
export interface PackSoundInfo {
  name: string;
  family: string;
  note?: string;
  coming?: boolean;
  [key: string]: unknown;
}

/** An installed pack, as `GET /api/packs` lists it. */
export interface PackSummary {
  id: string;
  name: string;
  license?: string;
  credit?: string;
  bytes?: number;
  instruments: PackInstrument[];
  description?: string;
  requires?: string[];
  sounds?: PackSoundInfo[];
}

/** A pack HO[LO] can install, as `GET /api/packs/available` lists it. */
export interface AvailablePack {
  id: string;
  name: string;
  license?: string;
  credit?: string;
  bytes?: number | null;
  files?: number;
  instruments: { name: string; title: string; category: string }[];
  description?: string;
  requires?: string[];
  sounds?: PackSoundInfo[];
  installed: boolean;
  current?: boolean;
}

export interface PacksAvailable {
  packs: AvailablePack[];
  offline?: boolean;
  error?: string;
}

/** An instrument's knobs and microphones (the parts of its map the tools need). */
export interface InstrumentInfo {
  pads?: unknown[];
  pitched?: boolean;
  mics?: SampleMic[];
  [key: string]: unknown;
}

/** An attachment, as `GET …/attachments/:id` gives it. */
export interface Attachment {
  name: string;
  /** One of the types HO[LO] takes (apps/server/src/agent/attachments.ts). */
  type: string;
  /** Its size in bytes. */
  size?: number;
  /**
   * What the studio measured of it: a picture's {width, height}; a recording's {seconds, peak, bpm,
   * monophonic, notes?: [start s, length s, MIDI pitch, velocity][]}; a MIDI file's {ppq, bpm, meter,
   * tracks, notes: [tick, length, pitch, velocity, track][]} (null: nothing).
   */
  meta: unknown;
  /** base64: the file itself, for pictures (as the studio drew them: at most 2048 px), text, and MusicXML up to 1 MB. */
  data?: string;
}

export type PermissionKind = 'install-pack' | 'send-creation' | 'bounce' | 'render' | 'screen' | 'photo' | 'microphone';

/** One part of a listen (docs/agent.md: POST …/listen). */
export interface ListenPart {
  /** The notes this part hands out, their times in ms from the start of the whole listen: parts concatenate. */
  notes: PlayedNote[];
  /** The listen is over (quiet, Done, the last part, the job ending); not: ask for the next part soon. */
  done: boolean;
  /** Which part of its listen this was: 1 began a listen (the last one ended, or waited too long for this). */
  part: number;
  /** Notes heard but held over to a later part (a key was down as this one ended). */
  pending: number;
}

export interface Image {
  mime: string;
  /** base64 */
  data: string;
}

// Each area's types, and its parts of JobApi, httpJobApi, FakeJobApiOptions and fakeJobApi, go in its own
// labelled block, so the areas added side by side keep their lines apart.

// ---- measure ----

/** What `measure` measures (docs/agent.md, "Measuring"). */
export type MeasureWhat = 'take' | 'mix' | 'tracks' | 'plugin' | 'meters' | 'file';

/** POST …/measure: ids and ticks (the tool turns names and positions into these). */
export interface MeasureBody {
  what: MeasureWhat;
  /** A track's id (take, tracks); a track's, a bus's or "master" (plugin). */
  track?: string;
  region?: string;
  plugin?: string;
  from?: number;
  to?: number;
  /** take: "key", "none" or a reference track's id; tracks: a second track's id. */
  against?: string;
  /** take: the grid, in ticks. */
  grid?: number;
  source?: 'render' | 'bounce';
  attachment?: string;
  /** meters: how many seconds of play they cover (8 by default, up to 30); the studio waits until it has watched that much. */
  seconds?: number;
}

/** A measured note of a take (docs/agent.md): ticks (null off the timeline), seconds, MIDI pitches, cents, ms, dB. */
export interface TakeNoteMeasure {
  tick: number | null;
  end: number | null;
  at: number;
  length: number;
  pitch: number;
  target: number;
  cents: number;
  inKey?: boolean;
  ref?: number | null;
  drift: number;
  vibrato: [number, number] | null;
  grid: number | null;
  attack: boolean;
  db: number;
  peak: number;
  region: string | null;
}

export interface TakeMeasure {
  kind: 'take';
  track: string | null;
  name: string;
  regions: string[];
  seconds: number;
  against: { kind: 'key'; keys: string[] } | { kind: 'track'; track: string } | { kind: 'none' };
  grid: number;
  notes: TakeNoteMeasure[];
  phrases: {
    tick: number | null;
    end: number | null;
    at: number;
    length: number;
    notes: number;
    db: number;
    peak: number;
  }[];
  summary: {
    notes: number;
    meanAbs: number;
    bias: number;
    within10: number;
    within25: number;
    sharp: number;
    flat: number;
    timing: { mean: number; spread: number; late: number; early: number } | null;
    vibrato: { notes: number; rate: number; depth: number } | null;
    drifting: number;
  };
}

/** Loudness (LUFS, LU), peaks (dBTP, dBFS) and samples at full scale; null where silent. */
export interface LoudnessMeasure {
  seconds: number;
  integrated: number | null;
  momentaryMax: number | null;
  shortTermMax: number | null;
  range: number | null;
  truePeak: number | null;
  samplePeak: number | null;
  over: number;
  overRuns: number;
}

export interface MixMeasure {
  kind: 'mix';
  source: 'render' | 'bounce' | 'file';
  name?: string;
  /** A bounce: when it was made, and whether the song changed after. */
  made?: string;
  stale?: boolean;
  tick: number | null;
  end: number | null;
  loudness: LoudnessMeasure;
  sections: {
    name: string | null;
    tick: number | null;
    end: number | null;
    at: number;
    length: number;
    lufs: number | null;
    shortTermMax: number | null;
  }[];
  /** Octave bands 31.5 Hz to 16 kHz (dB). */
  octaves: (number | null)[];
  tilt: number | null;
  errors: string[];
}

export interface TracksMeasure {
  kind: 'tracks';
  tick: number;
  end: number;
  tracks: {
    id: string;
    name: string;
    output: string;
    muted: boolean;
    silent: boolean;
    lufs: number | null;
    peak: number | null;
    truePeak: number | null;
    octaves: (number | null)[];
    /** Third-octave bands 25 Hz to 20 kHz (dB), for one track. */
    thirds?: (number | null)[];
    source?: { lufs: number | null; peak: number | null } | null;
  }[];
  masking: { a: string; b: string; bands: { hz: number; overlap: number; diff: number }[] } | null;
  errors: string[];
}

export interface PluginMeasure {
  kind: 'plugin';
  channel: string;
  plugin: { id: string; type: string; name: string; bypass: boolean };
  method: 'response' | 'signal';
  response?: {
    thirds: (number | null)[];
    latency: number;
    decay?: number | null;
    predelay?: number | null;
    echoes?: [number, number][];
  };
  signal?: {
    tick: number;
    end: number;
    in: { lufs: number | null; peak: number | null };
    out: { lufs: number | null; peak: number | null };
    octavesIn: (number | null)[];
    octavesOut: (number | null)[];
    gr: { active: number; median: number; p90: number; max: number } | null;
  };
  errors: string[];
}

export interface MetersMeasure {
  kind: 'meters';
  playing: boolean;
  /** Seconds of play watched, and the seconds `peak` and `gr` cover (the last of play). */
  seconds: number;
  covered: number;
  channels: {
    id: string;
    peak: [number | null, number | null];
    max: [number | null, number | null];
    gr: number | null;
    grMax: number | null;
    clipped: boolean;
  }[];
}

export type MeasureResult = TakeMeasure | MixMeasure | TracksMeasure | PluginMeasure | MetersMeasure;

/** A measurement's answer: its result, or (not done within 40 s) how far it has got and about how many seconds are left. */
export type MeasureAnswer =
  | { done: true; task: string; result: MeasureResult; cached?: boolean }
  | { done: false; task: string; progress: number; eta: number | null; stage: string };

/** A measuring call waits up to 40 s on the server: the client gives it 50 (a harness cuts a call at 60). */
const MEASURE_TIMEOUT_MS = 50_000;

// ---- import ----

/**
 * What `POST …/import` brings in of an attachment: a recording as one of the song's audio files (kept
 * as WAV), or a MIDI or MusicXML file as a song of its own, to merge; or not done yet (the studio is
 * still converting it: the same call again waits on).
 */
export type ImportAnswer =
  | { done: true; kind: 'audio'; how: 'copied' | 'converted' | 'studio'; file: AudioFile }
  | { done: true; kind: 'notes'; format: 'midi' | 'musicxml'; name: string; song: Project; warnings: string[] }
  | { done: false; line: string };

// ---- details ----

/** Who a song is by and its album, as the library keeps them beside the song (null: none). */
export interface SongDetails {
  artist: string | null;
  album: string | null;
}

export interface JobApi {
  /** GET …/song: the song, as the studio last saved or sent it. */
  song(): Promise<Project>;
  /** GET …/describe: the song as text (describeProject). */
  describe(): Promise<{ text: string }>;
  /** GET …/state */
  state(): Promise<StudioState>;
  /** POST …/ops: one batch of changes for the requester's studio, merged into the job's undo step. */
  ops(ops: Op[], label: string, batch: string): Promise<{ ok: boolean; revision?: number }>;
  /** POST …/transport; `bar` is a bar number. */
  transport(body: { action: 'play' | 'stop' | 'locate'; bar?: number }): Promise<{ ok: boolean }>;
  /** POST …/audition: MIDI events [delay ms, status, data1, data2] played now, not recorded. */
  audition(body: { track?: string; events: [number, number, number, number][] }): Promise<{ ok: boolean }>;
  /**
   * POST …/listen: one part of a listen to what the user plays (at most 45 s: a harness cuts a tool call
   * at 60 s), until quiet, Done, or maxMs. `last`: the listen ends with this part.
   */
  listen(body: { maxMs: number; quietMs: number; last?: boolean }): Promise<ListenPart>;
  /** GET …/played?seconds=: what was just played (at most 60 s back). */
  played(seconds: number): Promise<{ notes: PlayedNote[] }>;
  /** POST …/compare: the song before the job, then as it is now, over bars `from` to `to` (bar numbers, `to` not played). */
  compare(body: { from: number; to: number }): Promise<{ ok: boolean }>;
  /** GET …/packs */
  packs(): Promise<PackSummary[]>;
  /** GET …/packs/available */
  packsAvailable(): Promise<PacksAvailable>;
  /** GET …/instruments/:pack/:name */
  instrument(pack: string, name: string): Promise<InstrumentInfo>;
  /** GET …/scans/:id */
  scan(id: string): Promise<Scan>;
  /** GET …/scans/:id/strip/:page/:system: a system's strip, as an image. */
  scanStrip(id: string, page: number, system: number): Promise<Image>;
  /** PATCH …/scans/:id/systems/:page/:system */
  scanSystem(
    id: string,
    page: number,
    system: number,
    body: { state?: SystemState; written?: [number, number]; flags?: string[] },
  ): Promise<ScanSystem>;
  /** GET …/attachments/:id */
  attachment(id: string): Promise<Attachment>;
  /** POST …/progress: a line (≤ 200 characters) under the bar while the agent works. */
  progress(line: string): Promise<{ ok: boolean }>;
  /** POST …/permission: the job waits for the user's click when the turn ends. */
  permission(body: { kind: PermissionKind; detail: string; pack?: string }): Promise<{ ok: boolean }>;
  /** POST …/handoff: a brief (≤ 4000 characters) for the user's own harness. */
  handoff(brief: string): Promise<{ ok: boolean }>;
  /** POST …/finish: the undo step's label (≤ 80) and the reply under the bar (≤ 600). */
  finish(label: string, reply: string): Promise<{ ok: boolean }>;

  // ---- measure ----
  /** POST …/measure: waits up to 40 s; not done, the same body again joins it (or GET …/measure/:task). */
  measure(body: MeasureBody): Promise<MeasureAnswer>;
  /** GET …/measure/:task: a measurement under way, waited for up to 40 s. */
  measureTask(task: string): Promise<MeasureAnswer>;

  // ---- import ----
  /** POST …/import: an attachment brought into the song's files (a recording) or read as a song (MIDI, MusicXML). */
  importAttachment(attachment: string): Promise<ImportAnswer>;

  // ---- details ----
  /**
   * PUT …/details: who the song is by and its album (each one given is set, null clears it). Outside
   * undo; refused (400) for a creation's song.
   */
  details(body: { artist?: string | null; album?: string | null }): Promise<{ ok: boolean } & SongDetails>;
}

/** An answer from HO[LO] that wasn't OK: its own `error` message, and the status. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** How long a call may take before it's given up: the studio has 60 s to apply ops; a part of a listen up to 45 s. */
const TIMEOUT_MS = 30_000;
const OPS_TIMEOUT_MS = 75_000;
const LISTEN_MAX_MS = 45_000;

/**
 * The job API over HTTP. The token is read once from its file (it's never in argv or the
 * environment) and only ever sent in the Authorization header.
 */
export function httpJobApi(base: string, job: string, tokenFile: string): JobApi {
  const token = readFileSync(tokenFile, 'utf8').trim();
  if (!token) throw new Error(`The job token file ${tokenFile} is empty`);
  const root = `${base.replace(/\/$/, '')}/api/agent/jobs/${encodeURIComponent(job)}`;

  async function request(method: string, path: string, body?: unknown, timeout = TIMEOUT_MS): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${root}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
        throw new ApiError(504, `HO[LO] didn't answer within ${Math.round(timeout / 1000)} s`);
      throw new ApiError(503, `HO[LO] isn't answering at ${base}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // plain text
      }
      if (res.status === 403 && !message) message = 'This job has ended, or its song is no longer open';
      throw new ApiError(res.status, message || `${res.status} ${res.statusText}`);
    }
    return res;
  }

  async function json<T>(method: string, path: string, body?: unknown, timeout?: number): Promise<T> {
    const res = await request(method, path, body, timeout);
    return (await res.json()) as T;
  }

  const seg = encodeURIComponent;
  return {
    song: () => json('GET', '/song'),
    describe: () => json('GET', '/describe'),
    state: () => json('GET', '/state'),
    ops: (ops, label, batch) => json('POST', '/ops', { ops, label, batch }, OPS_TIMEOUT_MS),
    transport: (body) => json('POST', '/transport', body),
    audition: (body) => json('POST', '/audition', body),
    listen: (body) => json('POST', '/listen', body, Math.min(LISTEN_MAX_MS, body.maxMs) + 10_000),
    played: (seconds) => json('GET', `/played?seconds=${seconds}`),
    compare: (body) => json('POST', '/compare', body),
    packs: () => json('GET', '/packs'),
    packsAvailable: () => json('GET', '/packs/available'),
    instrument: (pack, name) => json('GET', `/instruments/${seg(pack)}/${seg(name)}`),
    scan: (id) => json('GET', `/scans/${seg(id)}`),
    async scanStrip(id, page, system) {
      const res = await request('GET', `/scans/${seg(id)}/strip/${page}/${system}`);
      const mime = (res.headers.get('content-type') ?? 'image/png').split(';')[0]?.trim() || 'image/png';
      return { mime, data: Buffer.from(await res.arrayBuffer()).toString('base64') };
    },
    scanSystem: (id, page, system, body) => json('PATCH', `/scans/${seg(id)}/systems/${page}/${system}`, body),
    attachment: (id) => json('GET', `/attachments/${seg(id)}`),
    progress: (line) => json('POST', '/progress', { line: line.slice(0, 200) }),
    permission: (body) => json('POST', '/permission', body),
    handoff: (brief) => json('POST', '/handoff', { brief }),
    finish: (label, reply) => json('POST', '/finish', { label, reply }),

    // ---- measure ----
    measure: (body) => json('POST', '/measure', body, MEASURE_TIMEOUT_MS),
    measureTask: (task) => json('GET', `/measure/${seg(task)}`, undefined, MEASURE_TIMEOUT_MS),

    // ---- import ----
    // (the server takes at most about 40 s, then says it isn't done; a harness cuts a call at 60)
    importAttachment: (attachment) => json('POST', '/import', { attachment }, 50_000),

    // ---- details ----
    details: (body) => json('PUT', '/details', body),
  };
}

// ---- a stand-in for tests ----

export interface FakeJobApiOptions {
  state?: StudioState;
  packs?: PackSummary[];
  available?: PacksAvailable;
  instruments?: Record<string, InstrumentInfo>;
  scans?: Record<string, Scan>;
  strips?: Record<string, Image>;
  played?: PlayedNote[];
  /** What listening hears: each part, in turn (the last given again once they run out). */
  heard?: PlayedNote[] | ListenPart[];
  attachments?: Record<string, Attachment>;

  // ---- measure ----
  /** What measuring answers, by what's measured: one answer, or several in turn (the last again once they run out). */
  measured?: Partial<Record<MeasureWhat, MeasureAnswer | MeasureAnswer[]>>;

  // ---- import ----
  /** What importing each attachment brings: an answer, or one a call at a time (the last given again). */
  imports?: Record<string, ImportAnswer | ImportAnswer[]>;

  // ---- details ----
  /** Who the song is by and its album at first; `refuse`: the 400 a creation's song gets. */
  details?: Partial<SongDetails> & { refuse?: string };
}

/** Every call the fake took, in order. */
export interface FakeCall {
  method: keyof JobApi;
  args: unknown[];
}

export interface FakeJobApi extends JobApi {
  /** The song as the studio has it: ops apply to it, as the studio would. */
  project: Project;
  calls: FakeCall[];
  /** The `ops` calls alone. */
  batches: { ops: Op[]; label: string; batch: string }[];
}

/**
 * A JobApi over a song in memory: ops apply to it (so a tool's next read sees them), and every call
 * is recorded for the test to look at.
 */
export function fakeJobApi(project: Project, options: FakeJobApiOptions = {}): FakeJobApi {
  const calls: FakeCall[] = [];
  const batches: FakeJobApi['batches'] = [];
  const log = (method: keyof JobApi, ...args: unknown[]) => calls.push({ method, args });
  const missing = (what: string): never => {
    throw new ApiError(404, `No such ${what}`);
  };
  const fake: FakeJobApi = {
    project,
    calls,
    batches,
    async song() {
      log('song');
      return structuredClone(fake.project);
    },
    async describe() {
      log('describe');
      return { text: describeProject(fake.project) };
    },
    async state() {
      log('state');
      return options.state ?? { playhead: 0, playing: false, view: 'arrange', cycle: fake.project.cycle };
    },
    async ops(ops, label, batch) {
      log('ops', ops, label, batch);
      batches.push({ ops, label, batch });
      fake.project = { ...applyOps(fake.project, ops), revision: fake.project.revision + 1 };
      return { ok: true, revision: fake.project.revision };
    },
    async transport(body) {
      log('transport', body);
      return { ok: true };
    },
    async audition(body) {
      log('audition', body);
      return { ok: true };
    },
    async listen(body) {
      log('listen', body);
      const heard = options.heard ?? [];
      // notes alone: a listen of one part
      if (!heard.length || 'pitch' in (heard[0] as object))
        return { notes: heard as PlayedNote[], done: true, part: 1, pending: 0 };
      const parts = heard as ListenPart[];
      const i = calls.filter((c) => c.method === 'listen').length - 1;
      return parts[Math.min(i, parts.length - 1)] as ListenPart;
    },
    async played(seconds) {
      log('played', seconds);
      return { notes: options.played ?? [] };
    },
    async compare(body) {
      log('compare', body);
      return { ok: true };
    },
    async packs() {
      log('packs');
      return options.packs ?? [];
    },
    async packsAvailable() {
      log('packsAvailable');
      return options.available ?? { packs: [] };
    },
    async instrument(pack, name) {
      log('instrument', pack, name);
      return options.instruments?.[`${pack}/${name}`] ?? missing('instrument');
    },
    async scan(id) {
      log('scan', id);
      return options.scans?.[id] ?? missing('scan');
    },
    async scanStrip(id, page, system) {
      log('scanStrip', id, page, system);
      return options.strips?.[`${id}/${page}/${system}`] ?? missing('strip');
    },
    async scanSystem(id, page, system, body) {
      log('scanSystem', id, page, system, body);
      const found = options.scans?.[id]?.pages.find((p) => p.n === page)?.systems.find((s) => s.k === system);
      return found ? { ...found, ...body } : missing('system');
    },
    async attachment(id) {
      log('attachment', id);
      return options.attachments?.[id] ?? missing('attachment');
    },
    async progress(line) {
      log('progress', line);
      return { ok: true };
    },
    async permission(body) {
      log('permission', body);
      return { ok: true };
    },
    async handoff(brief) {
      log('handoff', brief);
      return { ok: true };
    },
    async finish(label, reply) {
      log('finish', label, reply);
      return { ok: true };
    },

    // ---- measure ----
    async measure(body) {
      log('measure', body);
      const given = options.measured?.[body.what];
      if (!given) throw new ApiError(404, `Nothing to measure (${body.what})`);
      if (!Array.isArray(given)) return given;
      const i = calls.filter((c) => c.method === 'measure' && (c.args[0] as MeasureBody).what === body.what).length - 1;
      return given[Math.min(i, given.length - 1)] as MeasureAnswer;
    },
    async measureTask(task) {
      log('measureTask', task);
      for (const given of Object.values(options.measured ?? {})) {
        const found = (Array.isArray(given) ? given : [given]).find((a) => a.task === task && a.done);
        if (found) return found;
      }
      return missing('measurement');
    },

    // ---- import ----
    async importAttachment(attachment) {
      log('importAttachment', attachment);
      const given = options.imports?.[attachment];
      if (!given) return missing('attachment');
      if (!Array.isArray(given)) return given;
      const i = calls.filter((c) => c.method === 'importAttachment' && c.args[0] === attachment).length - 1;
      return given[Math.min(i, given.length - 1)] as ImportAnswer;
    },

    // ---- details ----
    async details(body) {
      log('details', body);
      // (kept in the options, as the library keeps them beside the song)
      options.details ??= {};
      const about = options.details;
      if (about.refuse) throw new ApiError(400, about.refuse);
      for (const field of ['artist', 'album'] as const)
        if (body[field] !== undefined) about[field] = body[field] ?? null;
      return { ok: true, artist: about.artist ?? null, album: about.album ?? null };
    },
  };
  return fake;
}
