/**
 * The studio's meters, for the agent (`agent-meters`, docs/agent.md): while the song plays, every
 * channel's meter (the master, the tracks, the buses) is read from the engine twenty times a second
 * and kept (meter-watch.ts): the loudest of the last seconds asked for (`seconds`, 8 unless it says,
 * up to 30) and since play started, its gain reduction, and whether it clipped. When play started
 * less than that long ago, the answer waits until it has played that long (or stops), so it never
 * judges the song by its first second; after play stops, it's what the last play showed. Loaded by
 * live.ts.
 */
import { engine } from '../audio/engine.ts';
import { registerAgentRequest } from './agent-studio.ts';
import { MeterWatch, metersSeconds } from './meter-watch.ts';
import { store } from './store.ts';

const EVERY_MS = 50;

const watch = new MeterWatch();
let timer: ReturnType<typeof setInterval> | null = null;

const ids = (): string[] => {
  const p = store.get().project;
  return p ? ['master', ...p.tracks.map((t) => t.id), ...p.buses.map((b) => b.id)] : [];
};

function read(): void {
  if (!engine.started) return;
  watch.sample(ids(), (id) => engine.meter(id), performance.now());
}

store.subscribe(() => {
  const playing = store.get().playing;
  if (playing && !timer) {
    watch.start(performance.now());
    timer = setInterval(read, EVERY_MS);
  } else if (!playing && timer) {
    clearInterval(timer);
    timer = null;
    watch.stop(performance.now());
  }
});

registerAgentRequest('agent-meters', async (msg, ack) => {
  const want = metersSeconds(msg.seconds) * 1000;
  // playing for less than that: watch on until it has played that long, or stops
  await watch.until(
    want,
    () => performance.now(),
    (ms) => new Promise((r) => setTimeout(r, ms)),
  );
  ack(true, { ...watch.report(performance.now(), ids(), want) });
});
