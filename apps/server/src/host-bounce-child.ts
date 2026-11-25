/**
 * The process a bounce on the host is rendered in (host-bounce.ts forks one per bounce, at the lowest
 * priority). It renders the song as the studio's own bounce does (apps/web/src/audio/render.worker.ts):
 * the same engine and the same options, its samples and recordings read from the data folder, the
 * result a 24-bit WAV. So the file is the one that studio would have made. On a host with cores to
 * spare the render is split over threads of this process (`threads`): the same file to the byte.
 *
 * In: `{type: 'run', id, input}`. Out: `{type: 'progress', id, line}`, then `{type: 'done', id,
 * seconds}` (the file written where it was told to) or `{type: 'failed', id, error}`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { availableParallelism, setPriority } from 'node:os';
import { dirname, join } from 'node:path';
import { encodeWav, type RenderCosts, type RenderSplit, renderSession } from '@holo/engine';
import { dataFolderSource, renderThreads, renderWorkersFor } from '@holo/engine/node';
import type { Project } from '@holo/session';
import { threadsAllowed } from './host-bounce.ts';

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

const read = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * A bounce on the host's other cores (the engine's render.ts, RenderOptions.split): the same file,
 * sooner. The threads share the song's strips out by what each cost the last time the song was
 * bounced here, kept beside its bounces; a song bounced for the first time goes by guesses, brought
 * to this host's speed by what its last bounce of any song found. Null: one engine (a host with
 * fewer than three cores to itself, or told to).
 */
function threads(dataDir: string, song: string): RenderSplit | null {
  const workers = renderWorkersFor(availableParallelism(), threadsAllowed());
  if (workers < 2) return null;
  // (a folder of their own: a song's folder holds its bounces and nothing else)
  const kept = join(dataDir, 'bounces', '.render');
  const all = join(kept, 'host.json');
  const own = join(kept, `${song.replace(/[^\w-]/g, '')}.json`);
  const costs = (read(own) ?? read(all)) as Partial<RenderCosts> | null;
  const keep = (path: string, what: unknown) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.part`, JSON.stringify(what));
      renameSync(`${path}.part`, path);
    } catch {
      // (nowhere to keep it: the next bounce goes by guesses)
    }
  };
  return {
    ...renderThreads(workers),
    costs:
      costs?.scale && typeof costs.scale.tracks === 'number' && typeof costs.scale.buses === 'number'
        ? { scale: costs.scale, strips: costs.strips && typeof costs.strips === 'object' ? costs.strips : {} }
        : null,
    learned(found) {
      keep(own, found);
      keep(all, { scale: found.scale, strips: {} });
    },
  };
}

async function bounce(input: Input, line: (text: string) => void): Promise<number> {
  const { project } = input;
  const split = threads(input.dataDir, project.id);
  const out = await renderSession(project, dataFolderSource(input.dataDir, project.id), {
    sampleRate: project.sampleRate ?? 48000,
    from: input.from,
    to: input.to,
    tail: input.tail,
    ...(split ? { split } : {}),
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
