/**
 * A thread of a split render (render.ts, playSplit), on Node's worker_threads: an engine that plays
 * its share of the song's strips, as a render-ahead worker does, with a render's own settings. Those
 * are an engine's as it's made: every strip played through (none rests) and no fades at the
 * transport, so what the engines play together is one engine's render to the byte. (The studio's
 * and HO[LO] Engine's threads rest strips and fade, and start playing as they're made: for live
 * playing, not this.)
 *
 * It holds the song it's posted until `renderGo`, so all of it is taken in before the first block.
 * `renderEnd`: it stops, and says what went wrong in its engine, if anything did.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { AheadLink, AheadWorker } from './ahead.ts';
import { EngineCore } from './core.ts';
import type { AheadSpec, ToWorklet } from './protocol.ts';

const { sr, ahead } = workerData as { sr: number; ahead: AheadSpec };
const port = parentPort;
let wrong: string | null = null;
const core = new EngineCore(sr, (msg) => {
  if (msg.type !== 'error') return;
  wrong ??= msg.message;
  port?.postMessage({ type: 'renderError', message: msg.message });
});
core.receive({ type: 'init', ring: null, meters: null, transport: null, ahead });
// (it times its strips as it plays them, for the next render's layout: timing changes nothing it plays)
core.clock = () => performance.now();
const runner = new AheadWorker(
  core,
  new AheadLink(ahead.control, ahead.data, ahead.edges),
  ahead.self,
  () => performance.now(),
  () => new Promise<void>((done) => setImmediate(done)),
);
let going = false;
port?.on('message', (msg: ToWorklet | { type: 'renderGo' | 'renderEnd' }) => {
  if (msg.type === 'renderGo') {
    if (going) return;
    going = true;
    runner.run().catch((err: unknown) => {
      wrong ??= err instanceof Error ? err.message : String(err);
      port?.postMessage({ type: 'renderError', message: wrong });
    });
  } else if (msg.type === 'renderEnd') {
    runner.stop();
    port?.postMessage({ type: 'renderEnded', error: wrong });
  } else if (!going) runner.receive(msg as ToWorklet);
});
