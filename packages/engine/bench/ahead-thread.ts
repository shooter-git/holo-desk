/**
 * A worker that renders ahead, as a Node thread (worker_threads): what the studio's ahead workers
 * do in the browser, for the scale test and the tests. It takes the same messages the audio thread
 * does, and `{ type: 'aheadQuit' }` to finish.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { AheadLink, AheadWorker } from '../src/ahead.ts';
import { EngineCore } from '../src/core.ts';
import type { AheadSpec, ToWorklet } from '../src/protocol.ts';

const { sr, ahead } = workerData as { sr: number; ahead: AheadSpec };
const port = parentPort;
const core = new EngineCore(sr, (msg) => {
  if (msg.type === 'error') port?.postMessage(msg);
});
core.receive({ type: 'init', ring: null, meters: null, transport: null, ahead });
core.clock = () => performance.now();
const pause = () => new Promise<void>((done) => setImmediate(done));
const runner = new AheadWorker(
  core,
  new AheadLink(ahead.control, ahead.data, ahead.edges),
  ahead.self,
  () => performance.now(),
  pause,
);
port?.on('message', (msg: ToWorklet | { type: 'aheadQuit' }) => {
  if (msg.type === 'aheadQuit') runner.stop();
  else runner.receive(msg);
});
void runner.run().then(() => process.exit(0));
