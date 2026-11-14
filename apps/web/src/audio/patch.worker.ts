/// <reference lib="webworker" />
/**
 * Rendering note edits' patches off the page's thread (patches.ts): each from the recording it's a
 * part of, held here as it's given (in shared memory, the engines' own copy), with the function a
 * bounce renders them with.
 */
import { renderNotePatch, toShared } from '@holo/engine';
import type { FromPatchWorker, ToPatchWorker } from './patches.ts';

const recordings = new Map<string, Float32Array[]>();

self.onmessage = (e: MessageEvent<ToPatchWorker>) => {
  const msg = e.data;
  if (msg.type === 'recording') recordings.set(msg.key, msg.channels);
  else if (msg.type === 'forget') recordings.delete(msg.key);
  else {
    const { id, key } = msg;
    const post = (reply: FromPatchWorker, transfer: ArrayBuffer[] = []) =>
      (self as unknown as Worker).postMessage(reply, transfer);
    const base = recordings.get(msg.recording);
    if (!base) {
      post({ id, key, error: 'its recording isn’t here' });
      return;
    }
    try {
      const t0 = performance.now();
      const rendered = renderNotePatch(base, msg.sr, msg.spec);
      // in shared memory, every engine reads the one copy; else it's handed over whole
      const channels = msg.shared ? rendered.map(toShared) : rendered;
      const ms = performance.now() - t0;
      post({ id, key, channels, ms }, msg.shared ? [] : channels.map((c) => c.buffer as ArrayBuffer));
    } catch (err) {
      post({ id, key, error: err instanceof Error ? err.message : String(err) });
    }
  }
};
