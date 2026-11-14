/// <reference lib="webworker" />
/**
 * Finding a recording's notes off the page's thread. Its bytes come from the device's cache (else the
 * server), decoded as every renderer decodes them, at the file's own rate, so the studio and the host
 * find the same notes; mixed to one channel; then its pitch every 5 ms and its notes.
 */
import { decodeWav } from '@holo/engine';
import { fineTrack, lineNotes, monoOf } from '@holo/engine/analysis';
import { type AudioNote, roundPitch, roundTime } from '@holo/session';
import type { NotesReply, NotesRequest } from './notes.ts';

const AUDIO = 'holo-audio-v1';

/** The notes of one line, as the studio shows them: the one place its note-finding is chosen. */
function findNotes(samples: Float32Array, rate: number): AudioNote[] {
  return lineNotes(samples, rate).map((n) => ({
    t: roundTime(n.start),
    d: roundTime(n.end - n.start),
    p: roundPitch(n.pitch),
  }));
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
    const mono = monoOf(decoded.channels);
    const curve = fineTrack(mono, decoded.rate);
    reply = { id, notes: findNotes(mono, decoded.rate), curve };
    transfer.push(curve.t.buffer as ArrayBuffer, curve.midi.buffer as ArrayBuffer, curve.power.buffer as ArrayBuffer);
  } catch (err) {
    reply = { id, error: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(reply, transfer);
};
