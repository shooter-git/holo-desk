/**
 * How many of the song's sounds are still on their way once the audio has started: instruments
 * whose samples are loading, recordings being decoded, halls being made. On a phone the first start
 * of a big song takes a while (its samples come over the network, its halls are made on the phone),
 * and the transport says so, and Play waits for them, rather than playing half the song.
 */
import { useSyncExternalStore } from 'react';
import { engine } from './engine.ts';
import { library } from './samples.ts';

/** Sounds still to come (0: all in). */
export function soundsComing(): number {
  return library.pending + engine.pending;
}

export function onSoundsComing(fn: () => void): () => void {
  const a = library.subscribe(fn);
  const b = engine.onPending(fn);
  return () => {
    a();
    b();
  };
}

export function useSoundsComing(): number {
  return useSyncExternalStore(onSoundsComing, soundsComing);
}
