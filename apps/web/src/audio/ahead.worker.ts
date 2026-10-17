/// <reference lib="webworker" />
/**
 * A worker that plays its share of the song ahead of the playhead (@holo/engine's ahead.ts): the
 * whole engine, the same messages as the audio thread, and its own strips to play, handed over
 * through shared memory.
 */
import { AheadLink, type AheadSpec, AheadWorker, EngineCore, type ToWorklet } from '@holo/engine';

type Message = ToWorklet | { type: 'aheadStart'; sr: number; ahead: AheadSpec } | { type: 'aheadQuit' };

/** A turn of the event loop, without the clamping a timer has (so messages arrive). */
const turn = new MessageChannel();
let waiting: (() => void)[] = [];
turn.port1.onmessage = () => {
  const due = waiting;
  waiting = [];
  for (const done of due) done();
};
const pause = () =>
  new Promise<void>((done) => {
    waiting.push(done);
    turn.port2.postMessage(0);
  });

let runner: AheadWorker | null = null;

self.onmessage = (e: MessageEvent<Message>) => {
  const msg = e.data;
  if (msg.type === 'aheadStart') {
    const core = new EngineCore(msg.sr, (m) => {
      if (m.type === 'error') postMessage(m);
    });
    core.receive({ type: 'init', ring: null, meters: null, transport: null, ahead: msg.ahead });
    core.clock = () => performance.now();
    const { control, data, edges, self: index } = msg.ahead;
    runner = new AheadWorker(core, new AheadLink(control, data, edges), index, () => performance.now(), pause);
    void runner.run();
  } else if (msg.type === 'aheadQuit') runner?.stop();
  else runner?.receive(msg);
};
