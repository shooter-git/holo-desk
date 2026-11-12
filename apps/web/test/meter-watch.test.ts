import { describe, expect, it } from 'vitest';
import { type MeterReading, MeterWatch } from '../src/app/meter-watch.ts';

const db = (v: number) => Math.round(20 * Math.log10(v) * 10) / 10;

describe('the meters kept for the agent while the song plays', () => {
  it('keeps the loudest of the last seconds and since play started, gain reduction, and clips', () => {
    const w = new MeterWatch(3000);
    const levels: Record<string, MeterReading> = { master: [0.5, 0.4, 0], trk_a: [0.25, 0.25, -2], trk_b: [0, 0, 0] };
    const read = (id: string) => levels[id] ?? [0, 0, 0];
    // nothing kept before play starts
    w.sample(['master'], read, 0);
    expect(w.report(0)).toEqual({ playing: false, seconds: 0, channels: [] });

    w.start(1000);
    w.sample(['master', 'trk_a', 'trk_b'], read, 1000);
    levels.master = [1.2, 0.9, 0];
    levels.trk_a = [0.1, 0.1, -6];
    w.sample(['master', 'trk_a', 'trk_b'], read, 1500);
    levels.master = [0.25, 0.25, 0];
    levels.trk_a = [0.1, 0.1, -1];
    w.sample(['master', 'trk_a', 'trk_b'], read, 5000);
    const r = w.report(5000, ['trk_b', 'trk_a']);
    expect(r).toEqual({
      playing: true,
      seconds: 4,
      channels: [
        // the last 3 s hold only the quiet reading; the loudest since play started is the clip
        { id: 'master', peak: [db(0.25), db(0.25)], max: [db(1.2), db(0.9)], gr: null, grMax: null, clipped: true },
        { id: 'trk_a', peak: [db(0.1), db(0.1)], max: [db(0.25), db(0.25)], gr: -1, grMax: -6, clipped: false },
      ],
    });

    // stopped: what the last play showed, kept to be asked about
    w.stop(6000);
    expect(w.report(9000)).toMatchObject({ playing: false, seconds: 5 });
    w.sample(['master'], () => [0.9, 0.9, 0], 9500);
    expect(w.report(9000).channels[0]?.max).toEqual([db(1.2), db(0.9)]);
    // played again: from nothing
    w.start(10_000);
    expect(w.report(10_000)).toEqual({ playing: true, seconds: 0, channels: [] });
  });
});
