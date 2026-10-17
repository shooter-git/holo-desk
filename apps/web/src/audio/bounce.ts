/**
 * Bouncing: the song rendered to a WAV file by the same engine that plays it live, with the same
 * samples, instruments, plugins, automation and mix, as fast as the computer allows. It runs the
 * shared renderer (@holo/engine) in a worker, so a bounce is exactly what a headless render of the
 * same song gives.
 */
import { type Project, tickToSeconds } from '@holo/session';
import RenderWorker from './render.worker.ts?worker';

export interface BounceOptions {
  /** Ticks. */
  from: number;
  to: number;
  /** Seconds after the end for reverb and ringing notes. */
  tail: number;
  sampleRate?: number;
  format?: 'pcm24' | 'float32';
  onProgress?: (text: string) => void;
}

export function bounce(project: Project, opts: BounceOptions): Promise<{ wav: Blob; seconds: number }> {
  const worker = new RenderWorker();
  return new Promise((resolve, reject) => {
    worker.onmessage = (
      e: MessageEvent<
        | { type: 'progress'; text: string }
        | { type: 'done'; wav: Uint8Array; seconds: number; errors: string[] }
        | { type: 'failed'; message: string }
      >,
    ) => {
      const m = e.data;
      if (m.type === 'progress') opts.onProgress?.(m.text);
      else {
        worker.terminate();
        if (m.type === 'failed') reject(new Error(m.message));
        else if (m.errors.length) reject(new Error(`The engine stopped: ${m.errors[0]}`));
        else resolve({ wav: new Blob([m.wav as BlobPart], { type: 'audio/wav' }), seconds: m.seconds });
      }
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(new Error(err.message));
    };
    worker.postMessage({
      project,
      sampleRate: opts.sampleRate ?? project.sampleRate ?? 48000,
      from: opts.from,
      to: opts.to,
      tail: opts.tail,
      format: opts.format ?? 'pcm24',
    });
  });
}

/** The range a bounce covers: the cycle when it's on (as in Logic), else the whole song. */
export function bounceRange(project: Project, end: number): { from: number; to: number; seconds: number } {
  const from = project.cycle.on ? project.cycle.start : 0;
  const to = project.cycle.on ? project.cycle.end : end;
  return { from, to, seconds: tickToSeconds(project.tempo, to) - tickToSeconds(project.tempo, from) };
}
