/**
 * The studio's meters, for the agent (`agent-meters`, docs/agent.md): while the song plays, every
 * channel's meter (the master, the tracks, the buses) is read from the engine twenty times a second
 * and kept (meter-watch.ts): the loudest of the last three seconds and since play started, its gain
 * reduction, and whether it clipped. The agent's request is answered with what was kept; after play
 * stops, with what the last play showed. Loaded by live.ts.
 */
import { engine } from '../audio/engine.ts';
import { registerAgentRequest } from './agent-studio.ts';
import { MeterWatch } from './meter-watch.ts';
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

registerAgentRequest('agent-meters', (_msg, ack) => {
  ack(true, { ...watch.report(performance.now(), ids()) });
});
