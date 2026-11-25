/** A render thread that stops by itself as soon as it's told to play (render-split.test.ts). */
import { parentPort } from 'node:worker_threads';

parentPort?.on('message', (msg: { type?: string }) => {
  if (msg.type === 'renderGo') process.exit(3);
});
