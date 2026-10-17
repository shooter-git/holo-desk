/// <reference lib="webworker" />
/** Time-stretching off the page's thread: the screen and live MIDI never wait for it. */
import { stretchAudio } from '@holo/engine';

interface Job {
  id: number;
  channels: Float32Array[];
  ratio: number;
  sr: number;
}

self.onmessage = (e: MessageEvent<Job>) => {
  const { id, channels, ratio, sr } = e.data;
  const out = stretchAudio(channels, ratio, sr);
  (self as unknown as Worker).postMessage(
    { id, channels: out },
    out.map((c) => c.buffer as ArrayBuffer),
  );
};
