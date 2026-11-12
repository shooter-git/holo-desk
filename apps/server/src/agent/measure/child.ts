/**
 * The measuring child: a process of its own (runner.ts forks it, at the lowest priority), so a long
 * render or a take's analysis never holds up the server. It runs one measurement at a time, as it's
 * asked, and says how far it has got; it leaves when the server lets go of it.
 *
 * In: `{type: 'run', id, input}`. Out: `{type: 'progress', id, fraction, stage}`, then
 * `{type: 'done', id, result}` or `{type: 'failed', id, error}`.
 */
import { setPriority } from 'node:os';
import { type ChildInput, runTask } from './tasks.ts';

try {
  setPriority(19);
} catch {
  // (the runner set it already, where it may)
}

const send = (msg: Record<string, unknown>) => {
  if (process.connected) process.send?.(msg);
};

process.on('message', (raw) => {
  const msg = raw as { type?: string; id?: string; input?: ChildInput };
  if (msg.type !== 'run' || typeof msg.id !== 'string' || !msg.input) return;
  const id = msg.id;
  let last = 0;
  runTask(msg.input, (fraction, stage) => {
    // a few times a second at most
    const now = Date.now();
    if (now - last < 200 && fraction < 1) return;
    last = now;
    send({ type: 'progress', id, fraction: Math.max(0, Math.min(1, fraction)), stage: stage.slice(0, 120) });
  }).then(
    (result) => send({ type: 'done', id, result }),
    (err: unknown) => send({ type: 'failed', id, error: err instanceof Error ? err.message : String(err) }),
  );
});

process.on('disconnect', () => process.exit(0));
