/// <reference lib="webworker" />
/**
 * Finding a recording's notes off the page's thread. Its bytes come from the device's cache (else the
 * server), decoded as every renderer decodes them, at the file's own rate, so the studio and the host
 * find the same notes; then its notes and the curves they're drawn with, heard once (notes/detect.ts).
 */
import { decodeWav } from '@holo/engine';
import { notesAndCurves } from '@holo/engine/notes';
import type { AudioNote } from '@holo/session';
import type { NoteCurve, NotesReply, NotesRequest } from './notes.ts';

const AUDIO = 'holo-audio-v1';

/** A recording's notes and its curve, as the studio shows them: the one place its note-finding is chosen. */
function findNotes(channels: Float32Array[], rate: number): { notes: AudioNote[]; curve: NoteCurve } {
  const { notes, curves } = notesAndCurves(channels, rate);
  const count = curves.midi.length;
  return {
    notes: notes.n,
    curve: {
      t: Float64Array.from({ length: count }, (_, k) => curves.t0 + k * curves.step),
      midi: Float64Array.from(curves.midi),
      power: Float64Array.from(curves.power),
    },
  };
}

async function bytesOf(url: string): Promise<Uint8Array> {
  const cache = await caches.open(AUDIO).catch(() => null);
  let res = cache ? await cache.match(url) : undefined;
  if (!res) {
    res = await fetch(url);
    if (!res.ok)
      throw new Error(
        res.status === 404 ? 'The recording is missing' : `The recording couldn’t be fetched (${res.status})`,
      );
    if (cache) await cache.put(url, res.clone()).catch(() => undefined);
  }
  return new Uint8Array(await res.arrayBuffer());
}

self.onmessage = async (e: MessageEvent<NotesRequest>) => {
  const { id, project, file } = e.data;
  let reply: NotesReply;
  const transfer: ArrayBuffer[] = [];
  try {
    const decoded = decodeWav(await bytesOf(`/api/projects/${project}/files/${file}`));
    const { notes, curve } = findNotes(decoded.channels, decoded.rate);
    reply = { id, notes, curve };
    transfer.push(curve.t.buffer as ArrayBuffer, curve.midi.buffer as ArrayBuffer, curve.power.buffer as ArrayBuffer);
  } catch (err) {
    reply = { id, error: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(reply, transfer);
};
