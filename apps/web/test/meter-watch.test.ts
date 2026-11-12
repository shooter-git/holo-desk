import { describe, expect, it } from 'vitest';
import { type MeterReading, MeterWatch, metersSeconds } from '../src/app/meter-watch.ts';

const db = (v: number) => Math.round(20 * Math.log10(v) * 10) / 10;

describe('the meters kept for the agent while the song plays', () => {
  it('keeps the loudest of the last seconds and since play started, gain reduction, and clips', () => {
    const w = new MeterWatch(3000);
    const levels: Record<string, MeterReading> = { master: [0.5, 0.4, 0], trk_a: [0.25, 0.25, -2], trk_b: [0, 0, 0] };
    const read = (id: string) => levels[id] ?? [0, 0, 0];
    // nothing kept before play starts
    w.sample(['master'], read, 0);
    expect(w.report(0)).toEqual({ playing: false, seconds: 0, covered: 0, channels: [] });

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
      covered: 3,
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
    expect(w.report(10_000)).toEqual({ playing: true, seconds: 0, covered: 0, channels: [] });
  });

  it('covers as many of the last seconds of play as asked, up to 30, and waits until it has watched them', async () => {
    const w = new MeterWatch();
    let level = 0.9;
    const read = (): MeterReading => [level, level, 0];
    w.start(0);
    // loud for the first 5 s, then quiet for 15
    for (let t = 0; t <= 20_000; t += 50) {
      if (t > 5000) level = 0.1;
      w.sample(['master'], read, t);
    }
    expect(w.report(20_000, ['master'], 8000)).toMatchObject({
      seconds: 20,
      covered: 8,
      channels: [{ peak: [db(0.1), db(0.1)], max: [db(0.9), db(0.9)] }],
    });
    // the last 16 s reach back into the loud part; asked for more than was watched, it covers what was
    expect(w.report(20_000, ['master'], 16_000).channels[0]?.peak).toEqual([db(0.9), db(0.9)]);
    expect(w.report(20_000, ['master'], 30_000)).toMatchObject({ covered: 20 });
    // the seconds asked for: 8 unless it says, from 1 to 30
    expect([metersSeconds(undefined), metersSeconds(12), metersSeconds(0.2), metersSeconds(90)]).toEqual([
      8, 12, 1, 30,
    ]);

    // play started a second ago: the answer waits until 8 s have been watched
    let now = 1000;
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      now += ms;
    };
    w.start(0);
    await w.until(8000, () => now, sleep);
    expect(now).toBeGreaterThanOrEqual(8000);
    expect(now).toBeLessThan(8300);
    expect(Math.max(...slept)).toBeLessThanOrEqual(250);
    // already watched long enough, or not playing: at once
    slept.length = 0;
    await w.until(8000, () => now, sleep);
    expect(slept).toEqual([]);
    // play stops while it waits: it answers then
    w.start(now);
    const stopAt = now + 2000;
    await w.until(
      8000,
      () => now,
      async (ms) => {
        now += ms;
        if (now >= stopAt) w.stop(stopAt);
      },
    );
    expect(now).toBeLessThan(stopAt + 300);
    expect(w.report(now, ['master'], 8000)).toMatchObject({ playing: false, seconds: 2 });
  });
});
