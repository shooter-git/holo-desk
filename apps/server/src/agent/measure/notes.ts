/**
 * A recording's notes, for the agent's `audio_notes` and `holo notes` (tasks.ts runs them in the
 * measuring child): found as the studio's Notes view finds them, and what a take sounds like with its
 * notes edited.
 *
 * - **Found the same way.** The recording is decoded as every renderer decodes it (`decodeWav`, at its
 *   own rate) and its notes found with the studio's own call (`notesAndCurves`), so the host and the
 *   studio find the same notes in the same file. Beside them: each note's drift and vibrato as sung,
 *   from the same pitch curve, measured as a take's are (its held part: a straight line through it
 *   and what swings around that line), and what kind of recording it looks like.
 * - **What plays.** A region whose notes are edited plays its recording with its patches in place
 *   (`renderNotePatch`, `assembleClip`): the recording at the song's rate, stretched as the region
 *   stretches it, as a bounce plays it. Measuring a take reads that, so a note tuned is measured where
 *   it now sings.
 */
import {
  assembleClip,
  classifyRecording,
  decodeWav,
  loadClipAudio,
  type NoteCurves,
  notesAndCurves,
  type RenderSource,
  regionPatches,
  renderNotePatch,
} from '@holo/engine';
import type { AudioClip, AudioNote, AudioNotes, AudioNotesMode, Project, Track } from '@holo/session';

/** A note's drift (cents a straight line through its held part moves) and vibrato ([Hz, ±cents]), as sung. */
export interface NoteShape {
  drift: number;
  vibrato: [number, number] | null;
}

export interface FoundNotes {
  notes: AudioNotes;
  /** Each note's shape, by its index (null for a note with no pitch). */
  shapes: (NoteShape | null)[];
  /** What kind of recording it looks like: notes are found as one line's for now, a chord's strongest. */
  looks: AudioNotesMode;
}

/** A note's attack after its beat, and its release before its end (s; a quarter and a tenth of its voice at most), as a take's notes are measured. */
const ATTACK_S = 0.06;
const RELEASE_S = 0.03;
/** A note held this long (s) or more has a drift; a vibrato is 3 to 9 swings a second, 8 cents deep or more. */
const DRIFT_MIN_S = 0.25;
const VIBRATO_HZ = [3, 9] as const;
const VIBRATO_MIN = 8;

/** To a tenth (and 0, never −0). */
const r1 = (v: number) => Math.round(v * 10) / 10 || 0;

/** The vibrato in what swings around a note's line (cents, every `step` s): rate and depth, or null. */
function vibratoOf(residual: readonly number[], step: number): [number, number] | null {
  const fs = 1 / step;
  const minLag = Math.round(fs / VIBRATO_HZ[1]);
  const maxLag = Math.round(fs / VIBRATO_HZ[0]);
  const n = residual.length;
  if (n < Math.max(0.3 * fs, 2 * minLag)) return null;
  const ac = (lag: number): number => {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let k = 0; k + lag < n; k++) {
      const u = residual[k] as number;
      const v = residual[k + lag] as number;
      xy += u * v;
      xx += u * u;
      yy += v * v;
    }
    return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0;
  };
  const top = Math.min(maxLag, Math.floor(n * 0.7));
  let best = -1;
  let bestLag = 0;
  for (let lag = minLag; lag <= top; lag++) {
    const v = ac(lag);
    if (v > best) {
      best = v;
      bestLag = lag;
    }
  }
  if (best < 0.4 || bestLag <= minLag || bestLag >= top) return null;
  const p = ac(bestLag - 1);
  const q = ac(bestLag + 1);
  const den = p - 2 * best + q;
  const lag = bestLag + (den < 0 ? (p - q) / (2 * den) : 0);
  const depth = Math.SQRT2 * Math.sqrt(residual.reduce((s, v) => s + v * v, 0) / n);
  return depth < VIBRATO_MIN ? null : [r1(fs / lag), r1(depth)];
}

/** A note's drift and vibrato from the pitch curve: over its held part, after its beat (null with no pitch, or nothing voiced). */
export function shapeOf(n: AudioNote, curves: NoteCurves): NoteShape | null {
  if (n.p === null || !curves.midi.length) return null;
  const beat = n.t + (n.u ?? 0);
  const stop = n.t + n.d;
  const voice = Math.max(0, stop - beat);
  const from = beat + Math.min(ATTACK_S, voice * 0.25);
  const to = stop - Math.min(RELEASE_S, voice * 0.1);
  const at = (k: number) => curves.t0 + k * curves.step;
  const a = Math.max(0, Math.floor((beat - curves.t0) / curves.step));
  const b = Math.min(curves.midi.length, Math.ceil((stop - curves.t0) / curves.step) + 1);
  const pick = (lo: number, hi: number) => {
    const ht: number[] = [];
    const hp: number[] = [];
    for (let k = a; k < b; k++) {
      const p = curves.midi[k] as number;
      if (at(k) >= lo && at(k) <= hi && !Number.isNaN(p)) {
        ht.push(at(k));
        hp.push(p);
      }
    }
    return { ht, hp };
  };
  let held = pick(from, to);
  if (held.hp.length < 3) held = pick(beat, stop);
  const { ht, hp } = held;
  if (!hp.length) return null;
  // a straight line through it (least squares), and what swings around it
  const tm = ht.reduce((s, t) => s + t, 0) / ht.length;
  const pm = hp.reduce((s, p) => s + p, 0) / hp.length;
  let sxy = 0;
  let sxx = 0;
  for (let k = 0; k < ht.length; k++) {
    sxy += ((ht[k] as number) - tm) * ((hp[k] as number) - pm);
    sxx += ((ht[k] as number) - tm) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const span = (ht[ht.length - 1] as number) - (ht[0] as number);
  const residual = hp.map((p, k) => (p - (pm + slope * ((ht[k] as number) - tm))) * 100);
  return { drift: span >= DRIFT_MIN_S ? r1(slope * span * 100) : 0, vibrato: vibratoOf(residual, curves.step) };
}

/** A recording's notes as the studio finds them (its WAV bytes, as the song keeps them), with their shapes. */
export function findNotes(wav: Uint8Array): FoundNotes & { seconds: number } {
  const d = decodeWav(wav);
  const { notes, curves } = notesAndCurves(d.channels, d.rate);
  return {
    notes,
    shapes: notes.n.map((n) => shapeOf(n, curves)),
    looks: classifyRecording(d.channels, d.rate).mode,
    seconds: Math.round(((d.channels[0]?.length ?? 0) / d.rate) * 1000) / 1000,
  };
}

/** A region's recording as it plays with its note edits (at `sr`, stretched), or null when none is edited. */
export async function editedClip(source: RenderSource, clip: AudioClip, sr: number): Promise<Float32Array[] | null> {
  const jobs = regionPatches(clip, sr);
  if (!jobs.length) return null;
  const base = await loadClipAudio(source, clip, sr);
  return assembleClip(
    base,
    jobs.map((job) => ({ spec: job.spec, channels: renderNotePatch(base, sr, job.spec) })),
  );
}

/** What stands for an edited region's recording while a take is measured. */
const EDITED = 'edited:';

/**
 * A take's track as it plays, for measuring: each region whose notes are edited (`region`'s alone,
 * when given) reads its recording with its patches in place, as a recording of its own at the song's
 * rate that needs no stretch (`decode` finds it); the rest read their files as they are.
 */
export async function playedTake(
  project: Project,
  track: Track,
  source: RenderSource & { decodeAudio(file: string): { rate: number; channels: Float32Array[] } | null },
  region?: string,
): Promise<{
  project: Project;
  track: Track;
  decode: (file: string) => { rate: number; channels: Float32Array[] } | null;
}> {
  const sr = project.sampleRate ?? 48000;
  const edited = new Map<string, Float32Array[]>();
  const regions = await Promise.all(
    track.regions.map(async (r) => {
      const clip = r.audio;
      if (!clip?.notes || r.muted || (region && r.id !== region)) return r;
      const channels = await editedClip(source, clip, sr);
      if (!channels) return r;
      edited.set(r.id, channels);
      const audio: AudioClip = {
        file: `${EDITED}${r.id}`,
        offset: clip.offset * clip.stretch,
        gain: clip.gain,
        fadeIn: clip.fadeIn,
        fadeOut: clip.fadeOut,
        stretch: 1,
      };
      return { ...r, audio };
    }),
  );
  if (!edited.size) return { project, track, decode: (file) => source.decodeAudio(file) };
  const played = { ...track, regions };
  return {
    project: { ...project, tracks: project.tracks.map((t) => (t.id === track.id ? played : t)) },
    track: played,
    decode: (file) => {
      const channels = file.startsWith(EDITED) ? edited.get(file.slice(EDITED.length)) : undefined;
      return channels ? { rate: sr, channels } : source.decodeAudio(file);
    },
  };
}
