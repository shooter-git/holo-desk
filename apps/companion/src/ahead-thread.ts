/**
 * A thread that renders ahead (ahead.ts). It plays the engine through once at start (warmup.ts), so
 * its first notes are as quick as the rest, then waits for a studio: `aheadStart` gives it a fresh
 * engine (the whole song comes after it, the same messages as the render thread's) and its place
 * among the others, `aheadStop` lets the engine go when the studio does.
 */
import { type MessagePort, parentPort } from 'node:worker_threads';
import { AheadLink, AheadWorker, EngineCore, type ToWorklet } from '@holo/engine';
import type { ToAheadThread } from './ahead.ts';
import { warmUp } from './warmup.ts';

const port = parentPort as MessagePort;
const pause = () => new Promise<void>((done) => setImmediate(done));
warmUp(300);

let runner: AheadWorker | null = null;
port.on('message', (msg: ToAheadThread | ToWorklet) => {
  if (msg.type === 'aheadStart') {
    runner?.stop();
    const { sr, ahead } = msg;
    const core = new EngineCore(sr, (m) => {
      if (m.type === 'error') port.postMessage(m);
    });
    core.receive({ type: 'init', ring: null, meters: null, transport: null, ahead });
    core.clock = () => performance.now();
    const link = new AheadLink(ahead.control, ahead.data, ahead.edges);
    runner = new AheadWorker(core, link, ahead.self, () => performance.now(), pause);
    void runner.run();
  } else if (msg.type === 'aheadStop') {
    runner?.stop();
    runner = null;
  } else runner?.receive(msg);
});
