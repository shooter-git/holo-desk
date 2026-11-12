/**
 * An attachment brought into the job's song, for the agent's `import` tool (its operations then put it
 * in place, through the studio, as one undo step with the rest of the job's):
 *
 * - a recording becomes one of the song's audio files (`data/audio/<song>/aud_<id>.wav`), kept as WAV
 *   as every renderer reads it: a WAV the engine's reader reads is copied as it is; FLAC and AIFF are
 *   made WAV here; anything else (MP3, Ogg, M4A, a WAV the engine can't read) goes to the requester's
 *   studio, which fetches the bytes (`GET /api/agent/attachments/:id/data`), decodes them and uploads
 *   them as WAV (`agent-import-audio`). The answer is the file, as the song lists it (an AudioFile).
 * - a MIDI or MusicXML file (plain, UTF-16 or .mxl) is read into a song of its own, for the tool to
 *   merge (`mergeOps`).
 *
 * A call takes at most about 40 s (a harness cuts a tool call at 60): a studio still converting by then
 * is answered "not done", and the same call again waits on for the same conversion. What a job brought
 * in is remembered for the job, so asking again for the same attachment gives the same file.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { readMusicXml } from '@holo/score';
import { type AudioFile, newId, type Project, projectFromMidi, readMidi } from '@holo/session';
import { convertToWav, readableWav } from '../../audio-files.ts';
import { type Answer, NO_ANSWER } from '../../live.ts';
import { type AttachmentRecord, isAudio, isScore, scoreText } from '../attachments.ts';
import { isObj } from '../check.ts';
import type { JobRouteKit } from '../job-routes/index.ts';
import { type AgentJob, Refusal } from '../jobs.ts';

/** How long a call waits before it answers "not done", and how long the studio may take in all. */
export const BUDGET_MS = 40_000;
export const STUDIO_MS = 10 * 60_000;
/** What a job brought in is remembered this long. */
const REMEMBER_MS = 30 * 60_000;
/** What's read of a WAV to know whether the engine reads it. */
const WAV_HEAD = 1024 * 1024;

/** What `POST …/import` answers. */
export type ImportAnswer =
  | { done: true; kind: 'audio'; how: 'copied' | 'converted' | 'studio'; file: AudioFile }
  | { done: true; kind: 'notes'; format: 'midi' | 'musicxml'; name: string; song: Project; warnings: string[] }
  | { done: false; line: string };

export type ImporterKit = Pick<JobRouteKit, 'jobs' | 'live' | 'attachments' | 'dataDir'>;

const AUDIO_ID = /^aud_[a-z0-9]+$/;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class Importer {
  private readonly kit: ImporterKit;
  private readonly budgetMs: number;
  /** By job and attachment: a recording on its way, or brought in. */
  private readonly audio = new Map<string, Promise<ImportAnswer>>();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(kit: ImporterKit, budgetMs = BUDGET_MS) {
    this.kit = kit;
    this.budgetMs = budgetMs;
  }

  close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.audio.clear();
  }

  /** An attachment the job may read, for its song, brought in. */
  async import(job: AgentJob, id: string): Promise<ImportAnswer> {
    const { attachments, jobs } = this.kit;
    const a = attachments.get(id);
    const path = a ? attachments.file(id) : null;
    if (!a || !path) throw new Refusal(404, 'No such attachment');
    if (a.project !== job.view.project || !jobs.mayRead(job, id))
      throw new Refusal(403, 'That attachment isn’t this request’s');
    if (isAudio(a.type)) return this.recording(job, a, path);
    const title = a.name.replace(/\.[^.]+$/, '') || 'Imported';
    if (a.type === 'audio/midi') {
      let song: Project;
      try {
        song = projectFromMidi(readMidi(new Uint8Array(attachments.head(id))), title);
      } catch (err) {
        throw new Refusal(400, `${a.name} isn’t a MIDI file HO[LO] can read (${message(err)})`);
      }
      return { done: true, kind: 'notes', format: 'midi', name: a.name, song, warnings: [] };
    }
    if (isScore(a.type)) {
      try {
        const read = readMusicXml(await scoreText(a.type, attachments.head(id)), title);
        return {
          done: true,
          kind: 'notes',
          format: 'musicxml',
          name: a.name,
          song: read.project,
          warnings: read.warnings,
        };
      } catch (err) {
        throw new Refusal(400, `${a.name} isn’t a score HO[LO] can read (${message(err)})`);
      }
    }
    throw new Refusal(
      415,
      `${a.name} is ${a.type.startsWith('image/') ? 'a picture' : 'a text'}: a recording, a MIDI file or a MusicXML score can be imported`,
    );
  }

  /** A recording as one of the song's files: copied, made WAV here, or by the studio. */
  private async recording(job: AgentJob, a: AttachmentRecord, path: string): Promise<ImportAnswer> {
    const key = `${job.view.id}:${a.id}`;
    let work = this.audio.get(key);
    if (!work) {
      work = this.bring(job, a, path);
      this.audio.set(key, work);
      // remembered for the job (asked again, the same file); a failure is tried afresh
      work.then(
        () => {
          const t = setTimeout(() => {
            this.audio.delete(key);
            this.timers.delete(t);
          }, REMEMBER_MS);
          t.unref?.();
          this.timers.add(t);
        },
        () => this.audio.delete(key),
      );
    }
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((ok) => {
      timer = setTimeout(() => ok(null), this.budgetMs);
    });
    try {
      const done = await Promise.race([work, late]);
      return done ?? { done: false, line: `The studio is still converting ${a.name}` };
    } finally {
      clearTimeout(timer);
    }
  }

  private async bring(job: AgentJob, a: AttachmentRecord, path: string): Promise<ImportAnswer> {
    const dir = join(this.kit.dataDir, 'audio', job.view.project.replace(/[^\w-]/g, ''));
    mkdirSync(dir, { recursive: true });
    const file = (id: string, info: { seconds: number; rate: number; channels: number }): AudioFile => ({
      id,
      name: a.name,
      seconds: info.seconds,
      rate: info.rate,
      channels: info.channels,
    });
    if (a.type === 'audio/wav' || a.type === 'audio/x-wav') {
      const info = readableWav(this.kit.attachments.head(a.id, WAV_HEAD), a.size);
      if (info) {
        const id = newId('aud');
        // (under a hidden name until it's whole: a file is found by its id, whatever follows it)
        const part = join(dir, `.${id}.wav.part`);
        copyFileSync(path, part);
        renameSync(part, join(dir, `${id}.wav`));
        return { done: true, kind: 'audio', how: 'copied', file: file(id, info) };
      }
    }
    if (a.type === 'audio/flac' || a.type === 'audio/aiff') {
      const id = newId('aud');
      try {
        return {
          done: true,
          kind: 'audio',
          how: 'converted',
          file: file(id, convertToWav(path, join(dir, `${id}.wav`))),
        };
      } catch {
        // one the reader here doesn't take (a compressed AIFF): the studio's browser may
      }
    }
    return this.viaStudio(job, a, dir);
  }

  /** The requester's studio fetches the bytes, decodes them and uploads them as WAV. */
  private async viaStudio(job: AgentJob, a: AttachmentRecord, dir: string): Promise<ImportAnswer> {
    const studio = this.kit.jobs.studio(job);
    if (!studio) throw new Refusal(403, 'The song isn’t open in the studio that asked');
    const answer = await this.kit.live.request(
      studio,
      { type: 'agent-import-audio', project: job.view.project, attachment: a.id, name: a.name },
      STUDIO_MS,
    );
    return { done: true, kind: 'audio', how: 'studio', file: studioFile(answer, a, dir) };
  }
}

/** The file the studio says it uploaded, checked: one of the song's, with its length and format. */
export function studioFile(answer: Answer, a: Pick<AttachmentRecord, 'name'>, dir: string): AudioFile {
  if (!answer.ok)
    throw new Refusal(
      answer.error === NO_ANSWER ? 504 : 409,
      answer.error === NO_ANSWER
        ? `The studio didn’t finish converting ${a.name}`
        : (answer.error ?? `The studio couldn’t import ${a.name}`),
    );
  const f = answer.file;
  const positive = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max;
  if (
    !isObj(f) ||
    typeof f.id !== 'string' ||
    !AUDIO_ID.test(f.id) ||
    !positive(f.seconds, 24 * 3600) ||
    !positive(f.rate, 768_000) ||
    !positive(f.channels, 64) ||
    !Number.isInteger(f.rate) ||
    !Number.isInteger(f.channels)
  )
    throw new Refusal(502, `The studio’s answer about ${a.name} wasn’t a file`);
  const id = f.id;
  if (!existsSync(dir) || !readdirSync(dir).some((name) => name.startsWith(`${id}.`)))
    throw new Refusal(502, `The studio said it kept ${a.name}, but the song has no such file`);
  return { id, name: a.name, seconds: f.seconds as number, rate: f.rate as number, channels: f.channels as number };
}
