/**
 * The process a bounce on the host is rendered in (host-bounce.ts forks one per bounce, at the lowest
 * priority). It renders the song as the studio's own bounce does (apps/web/src/audio/render.worker.ts):
 * the same engine and the same options, its samples and recordings read from the data folder, the
 * result a 24-bit WAV. So the file is the one that studio would have made.
 *
 * In: `{type: 'run', id, input}`. Out: `{type: 'progress', id, line}`, then `{type: 'done', id,
 * seconds}` (the file written where it was told to) or `{type: 'failed', id, error}`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { setPriority } from 'node:os';
import { dirname } from 'node:path';
import { encodeWav, renderSession } from '@holo/engine';
import { dataFolderSource } from '@holo/engine/node';
import type { Project } from '@holo/session';

interface Input {
  dataDir: string;
  project: Project;
  /** The stretch of the song, ticks. */
  from: number;
  to: number;
  /** How long it rings on after, seconds. */
  tail: number;
  /** Where the file is written. */
  part: string;
}

try {
  setPriority(19);
} catch {
  // (the server set it already, where it may)
}
try {
  // should the host run out of memory, this is what the system stops, not the server
  writeFileSync('/proc/self/oom_score_adj', '900');
} catch {
  // (no such thing here: not Linux, or not allowed)
}

const parent = process.ppid;
const send = (msg: Record<string, unknown>) => {
  if (process.connected) process.send?.(msg);
};

async function bounce(input: Input, line: (text: string) => void): Promise<number> {
  const { project } = input;
  const out = await renderSession(project, dataFolderSource(input.dataDir, project.id), {
    sampleRate: project.sampleRate ?? 48000,
    from: input.from,
    to: input.to,
    tail: input.tail,
    onProgress: line,
  });
  if (out.errors.length) throw new Error(`The engine stopped: ${out.errors[0]}`);
  const wav = encodeWav(out.channels, out.sampleRate, 'pcm24');
  mkdirSync(dirname(input.part), { recursive: true });
  writeFileSync(input.part, wav);
  return (out.channels[0]?.length ?? 0) / out.sampleRate;
}

process.on('message', (raw) => {
  const msg = raw as { type?: string; id?: string; input?: Input };
  if (msg.type !== 'run' || typeof msg.id !== 'string' || !msg.input) return;
  const id = msg.id;
  let last = 0;
  bounce(msg.input, (text) => {
    // (the render doesn't stop to listen: a server that went without stopping it is noticed here)
    if (process.ppid !== parent) process.exit(1);
    const now = Date.now();
    if (now - last < 200) return;
    last = now;
    send({ type: 'progress', id, line: text.slice(0, 120) });
  }).then(
    (seconds) => send({ type: 'done', id, seconds }),
    (err: unknown) => send({ type: 'failed', id, error: err instanceof Error ? err.message : String(err) }),
  );
});

process.on('disconnect', () => process.exit(0));
