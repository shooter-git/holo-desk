/** Measuring a recording off the main thread: its length, its loudest point, a tempo, and its notes when it's one line. */
import { type AudioMeasure, measure } from './pitch.ts';

export interface PitchRequest {
  id: number;
  samples: Float32Array;
  sampleRate: number;
}

export interface PitchReply {
  id: number;
  measure: AudioMeasure;
}

self.onmessage = (e: MessageEvent<PitchRequest>) => {
  const { id, samples, sampleRate } = e.data;
  const reply: PitchReply = { id, measure: measure(samples, sampleRate) };
  (self as unknown as Worker).postMessage(reply);
};
