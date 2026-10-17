/**
 * The render thread: a loop that renders whenever the sound device asks and takes the studio's
 * messages in between. It never goes back to an event loop, so nothing else runs here to hold a
 * block up; messages arrive through a port read in place, and a doorbell wakes it while no device
 * is open.
 */
import { type MessagePort, receiveMessageOnPort, workerData } from 'node:worker_threads';
import { loadNative } from './native.ts';
import { Renderer, type ToRenderer } from './renderer.ts';
import { warmUp } from './warmup.ts';

export interface RenderData {
  addon: string;
  port: MessagePort;
  /** Rung (incremented and notified) by the main thread after each message it posts. */
  doorbell: SharedArrayBuffer;
  nullAudio: boolean;
  shared: boolean;
}

const data = workerData as RenderData;
const { port } = data;
const native = loadNative(data.addon);
const log = (line: string) => port.postMessage({ type: 'log', line });
const priority = native.boost();
const renderer = new Renderer(native, (msg, transfer) => port.postMessage(msg, transfer ?? []), {
  nullAudio: data.nullAudio,
  shared: data.shared,
  log,
});
// before anyone listens: every instrument and plugin played once, so none is slow the first time
const warm = warmUp(300);
log(`Render thread ready (${priority}; the engine warmed up in ${(warm / 1000).toFixed(1)} s)`);

const bell = new Int32Array(data.doorbell);
let rung = Atomics.load(bell, 0);
for (;;) {
  if (renderer.open) renderer.tick(4);
  else Atomics.wait(bell, 0, rung, 1000);
  rung = Atomics.load(bell, 0);
  for (let m = receiveMessageOnPort(port); m; m = receiveMessageOnPort(port)) {
    try {
      renderer.receive(m.message as ToRenderer);
    } catch (err) {
      log(`A message failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
    // the device comes first: what it's waiting for before the next message
    if (renderer.open) renderer.tick(0);
  }
}
