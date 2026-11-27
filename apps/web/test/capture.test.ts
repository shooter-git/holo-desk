/** Capture: which stretch of playing is "what I just played", and where it goes in the song. */
import { routeLive } from '@holo/engine/companion';
import {
  newAudioTrack,
  newProject,
  newTrack,
  PPQ,
  type Project,
  playMap,
  type Region,
  type Track,
} from '@holo/session';
import { describe, expect, it } from 'vitest';
import {
  CaptureMemory,
  heardBy,
  KEEP_MS,
  type Played,
  planCapture,
  SILENCE_MS,
  takeRegions,
} from '../src/app/capture.ts';

const BAR = PPQ * 4;

const msg = (
  at: number,
  status: number,
  d1: number,
  d2: number,
  tick: number | null,
  tracks = ['trk_keys'],
): Played => ({
  at,
  status,
  d1,
  d2,
  port: 'Keys',
  tracks,
  tick,
});
const on = (at: number, pitch: number, tick: number | null = null, tracks?: string[]) =>
  msg(at, 0x90, pitch, 100, tick, tracks);
const off = (at: number, pitch: number, tick: number | null = null, tracks?: string[]) =>
  msg(at, 0x80, pitch, 0, tick, tracks);

function song(): Project {
  const p = newProject('Capture');
  p.tempo = [{ tick: 0, bpm: 120 }];
  const keys: Track = { ...newTrack('Keys', { type: 'synth', preset: 'Soft Keys' }), id: 'trk_keys' };
  const bass: Track = { ...newTrack('Bass', { type: 'synth', preset: 'Analog Bass' }), id: 'trk_bass' };
  const vocal: Track = { ...newAudioTrack('Vocal'), id: 'trk_vocal' };
  p.tracks = [keys, bass, vocal];
  return p;
}

let ids = 0;
const at = (patch: Partial<Parameters<typeof planCapture>[2]> = {}) => ({
  selectedTrack: 'trk_keys',
  playhead: 0,
  playedNow: 0,
  map: null,
  id: () => `rgn_${++ids}`,
  ...patch,
});
const regionsOf = (plan: ReturnType<typeof planCapture>): { track: string; region: Region }[] =>
  (plan?.ops ?? []).flatMap((op) => (op.op === 'addRegion' ? [{ track: op.track, region: op.region }] : []));

describe('what counts as a phrase', () => {
  it('is nothing until a note is played', () => {
    const m = new CaptureMemory();
    expect(m.ready).toBe(false);
    m.add(msg(0, 0xb0, 64, 127, null));
    expect([m.ready, m.phrase(100)]).toEqual([false, null]);
    m.add(on(200, 60));
    expect(m.ready).toBe(true);
    expect(m.phrase(900)?.events.length).toBe(2);
  });

  it('keeps the pedal, bends and pressure with the notes, and nothing else', () => {
    const m = new CaptureMemory();
    m.add(msg(0, 0xb0, 64, 127, null));
    m.add(on(10, 60));
    m.add(msg(20, 0xe0, 0, 96, null));
    m.add(msg(30, 0xd0, 80, 0, null));
    m.add(msg(40, 0xc0, 5, 0, null)); // a program change
    m.add(msg(50, 0xf8, 0, 0, null)); // clock
    expect(m.phrase(60)?.events.map((e) => e.status)).toEqual([0xb0, 0x90, 0xe0, 0xd0]);
  });

  it('while stopped, playing after a long silence is a new phrase', () => {
    const m = new CaptureMemory();
    m.add(on(0, 60));
    m.add(off(400, 60));
    m.add(on(400 + SILENCE_MS + 1, 62));
    m.add(off(900 + SILENCE_MS, 62));
    expect(m.phrase(20_000)?.events.map((e) => e.d1)).toEqual([62, 62]);
  });

  it('a key held through the silence keeps it one phrase', () => {
    const m = new CaptureMemory();
    m.add(on(0, 48));
    m.add(on(SILENCE_MS + 500, 62));
    m.add(off(SILENCE_MS + 900, 62));
    m.add(off(SILENCE_MS + 950, 48));
    expect(m.phrase(30_000)?.events.length).toBe(4);
  });

  it('playing along is one phrase however long the rests', () => {
    const m = new CaptureMemory();
    m.add(on(0, 60, 0));
    m.add(off(300, 60, 240));
    m.add(on(30_000, 62, 16 * BAR));
    m.add(off(30_300, 62, 16 * BAR + 240));
    const phrase = m.phrase(31_000);
    expect([phrase?.playing, phrase?.events.length]).toEqual([true, 4]);
  });

  it('ends where the transport starts, stops or is moved: the last run with a note in it', () => {
    const m = new CaptureMemory();
    m.add(on(0, 60)); // stopped
    m.add(off(300, 60));
    m.mark('play', 1000);
    m.add(on(2000, 64, 960)); // along
    m.add(off(2300, 64, 1200));
    expect(m.phrase(2500)?.events.map((e) => e.d1)).toEqual([64, 64]);
    // stopped again with nothing played since: the run before the stop is still the phrase
    m.mark('stop', 3000);
    expect(m.phrase(3500)?.playing).toBe(true);
    // moved while it played: what came before the jump isn't joined to what comes after
    m.mark('play', 4000);
    m.add(on(4500, 65, 0));
    m.mark('locate', 5000);
    m.add(on(5500, 67, 8 * BAR));
    expect(m.phrase(6000)?.events.map((e) => e.d1)).toEqual([67]);
  });

  it('forgets everything at a floor (it was captured, recorded, or the song changed)', () => {
    const m = new CaptureMemory();
    m.add(on(0, 60));
    m.mark('floor', 100);
    expect([m.ready, m.phrase(200)]).toEqual([false, null]);
    m.add(on(300, 62));
    expect(m.phrase(400)?.events.map((e) => e.d1)).toEqual([62]);
  });

  it('lets go of what is older than it remembers', () => {
    const m = new CaptureMemory();
    m.add(on(0, 60, 0));
    m.add(on(KEEP_MS + 1000, 62, 960));
    expect(m.phrase(KEEP_MS + 2000)?.events.map((e) => e.d1)).toEqual([62]);
  });
});

describe('who heard it', () => {
  it('is the armed tracks its input reaches, else the selected one, and never an inactive one', () => {
    const p = song();
    expect(heardBy(p, 'trk_keys', 'Keys', 1)).toEqual(['trk_keys']);
    (p.tracks[1] as Track).armed = true;
    expect(heardBy(p, 'trk_keys', 'Keys', 1)).toEqual(['trk_bass']);
    (p.tracks[1] as Track).input = { port: 'Pads', channel: 0 };
    expect(heardBy(p, 'trk_keys', 'Keys', 1)).toEqual(['trk_keys']);
    (p.tracks[0] as Track).input = { port: '*', channel: 2 };
    expect(heardBy(p, 'trk_keys', 'Keys', 1)).toEqual([]);
    (p.tracks[0] as Track).input = { port: '*', channel: 0 };
    (p.tracks[0] as Track).inactive = true;
    expect(heardBy(p, 'trk_keys', 'Keys', 1)).toEqual([]);
    expect(heardBy(null, null, 'Keys', 1)).toEqual([]);
  });

  it('agrees with the engine’s own routing on made-up setups', () => {
    let seed = 11;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed % n;
    };
    for (let round = 0; round < 300; round++) {
      const p = song();
      p.tracks.forEach((t) => {
        t.armed = rnd(3) === 0;
        t.input = { port: ['*', 'Keys', 'Pads'][rnd(3)] as string, channel: rnd(3) };
        if (rnd(5) === 0) t.inactive = true;
      });
      const selected = [null, ...p.tracks.map((t) => t.id)][rnd(4)] as string | null;
      const port = ['Keys', 'Pads'][rnd(2)] as string;
      const channel = 1 + rnd(2);
      // as the studio hands the engine its routes: the tracks that are on, numbered in order
      const live = p.tracks.filter((t) => !t.inactive);
      const route = (t: Track) => ({ num: p.tracks.indexOf(t), port: t.input.port, channel: t.input.channel });
      const sel = live.find((t) => t.id === selected);
      const nums = routeLive(
        { armed: live.filter((t) => t.armed).map(route), selected: sel ? route(sel) : null },
        port,
        channel,
      );
      expect(heardBy(p, selected, port, channel)).toEqual(nums.map((n) => (p.tracks[n] as Track).id));
    }
  });
});

describe('where a phrase goes', () => {
  it('played along, the notes go where they were played, on whole bars, with the pedal', () => {
    const m = new CaptureMemory();
    m.add(msg(900, 0xb0, 64, 127, BAR + 100));
    m.add(on(1000, 60, BAR + 240));
    m.add(off(1500, 60, BAR + 1200));
    m.add(on(2000, 64, 2 * BAR + 10));
    m.add(msg(2600, 0xb0, 64, 0, 2 * BAR + 900));
    const plan = planCapture(song(), m.phrase(3000) as never, at({ playedNow: 2 * BAR + 1500 }));
    const [made] = regionsOf(plan);
    expect([made?.track, made?.region.name, made?.region.start, made?.region.length]).toEqual([
      'trk_keys',
      'Captured',
      BAR,
      2 * BAR,
    ]);
    // the second note was still held: it ends where the song is now
    expect(made?.region.notes.map((n) => [n.t, n.d, n.p])).toEqual([
      [240, 960, 60],
      [BAR + 10, 1490, 64],
    ]);
    expect(made?.region.cc).toEqual({
      '64': [
        [100, 127],
        [BAR + 900, 0],
      ],
    });
    expect([plan?.notes, plan?.tracks]).toEqual([2, ['Keys']]);
  });

  it('played while stopped, it starts at the playhead’s bar and runs as played at the song’s tempo', () => {
    const m = new CaptureMemory();
    // 120 bpm: 500 ms a beat, 960 ticks
    m.add(on(5000, 60));
    m.add(off(5250, 60));
    m.add(on(5500, 62));
    m.add(off(6500, 62));
    const p = song();
    const plan = planCapture(p, m.phrase(7000) as never, at({ playhead: 2 * BAR + 700 }));
    const [made] = regionsOf(plan);
    expect([made?.region.start, made?.region.length]).toEqual([2 * BAR, BAR]);
    expect(made?.region.notes.map((n) => [n.t, n.d, n.p])).toEqual([
      [0, 480, 60],
      [960, 1920, 62],
    ]);
    // at half the tempo the same playing covers half the ticks
    p.tempo = [{ tick: 0, bpm: 60 }];
    const slow = regionsOf(planCapture(p, m.phrase(7000) as never, at({ playhead: 0 })))[0];
    expect(slow?.region.notes.map((n) => [n.t, n.d])).toEqual([
      [0, 240],
      [480, 960],
    ]);
  });

  it('goes by HO[LO] Engine’s own clock where every message has it', () => {
    const m = new CaptureMemory();
    // two notes that reached the page in one batch, played half a second apart
    m.add({ ...on(8000, 60), fine: 100_000 });
    m.add({ ...off(8000, 60), fine: 100_250 });
    m.add({ ...on(8000, 62), fine: 100_500 });
    m.add({ ...off(8000, 62), fine: 100_750 });
    const [made] = regionsOf(planCapture(song(), m.phrase(8100) as never, at()));
    expect(made?.region.notes.map((n) => [n.t, n.d])).toEqual([
      [0, 480],
      [960, 480],
    ]);
  });

  it('around a cycle, the last time through plays and the earlier ones are kept, muted', () => {
    const m = new CaptureMemory();
    // a two-bar cycle from bar 5, three times through; the first pass's last note is held across the jump
    const start = 4 * BAR;
    // (120 bpm: a bar is 2 s, the cycle 4 s around)
    m.add(on(0, 60, start + 0));
    m.add(off(200, 60, start + 384));
    m.add(on(3950, 67, start + 2 * BAR - 100));
    m.add(off(4104, 67, start + 200)); // let go after the jump
    m.add(on(4500, 62, start + 960));
    m.add(off(4700, 62, start + 1344));
    m.add(on(8250, 64, start + 480));
    m.add(off(8500, 64, start + 960));
    const cycled = song();
    cycled.cycle = { on: true, start, end: start + 2 * BAR };
    const plan = planCapture(cycled, m.phrase(9000) as never, at({ playedNow: start + 1000 }));
    const made = regionsOf(plan);
    expect(made.map((r) => [r.region.name, r.region.muted, r.region.start, r.region.notes.map((n) => n.p)])).toEqual([
      ['Captured (pass 1)', true, start, [60, 67]],
      ['Captured (pass 2)', true, start, [62]],
      ['Captured', false, start, [64]],
    ]);
    // the held note ends at the cycle's end, not a cycle later
    expect(made[0]?.region.notes[1]?.d).toBe(100);
    // what's said is what plays
    expect(plan?.notes).toBe(1);
  });

  it('tells the times around a cycle apart by the clock, when each note falls later in the bar than the last', () => {
    // a one-bar cycle at 120 (2 s around): a note a little later in the bar each time
    const m = new CaptureMemory();
    m.add(on(500, 60, 960));
    m.add(off(700, 60, 1344));
    m.add(on(2800, 62, 1536)); // 2.3 s on: once around, and 576 ticks further in
    m.add(off(3000, 62, 1920));
    m.add(on(5100, 64, 2112));
    m.add(off(5300, 64, 2496));
    const cycled = song();
    cycled.cycle = { on: true, start: 0, end: BAR };
    const made = regionsOf(planCapture(cycled, m.phrase(5600) as never, at({ playedNow: 3000 })));
    expect(made.map((r) => [r.region.name, r.region.muted, r.region.notes.map((n) => n.p)])).toEqual([
      ['Captured (pass 1)', true, [60]],
      ['Captured (pass 2)', true, [62]],
      ['Captured', false, [64]],
    ]);
    // played straight through with no cycle, the same notes a little apart are one take
    const straight = new CaptureMemory();
    straight.add(on(500, 60, 960));
    straight.add(off(700, 60, 1344));
    straight.add(on(800, 62, 1536));
    straight.add(off(1000, 62, 1920));
    expect(regionsOf(planCapture(song(), straight.phrase(1200) as never, at({ playedNow: 2000 }))).length).toBe(1);
  });

  it('follows the song’s repeats: each time through is a region where it’s written', () => {
    const p = song();
    // bars 1–2 repeated: as played, bars 1 2 1 2
    p.form = [
      { tick: 0, k: 'start' },
      { tick: 2 * BAR, k: 'end' },
    ];
    const m = new CaptureMemory();
    m.add(on(0, 60, 240));
    m.add(off(100, 60, 480));
    m.add(on(4000, 62, 2 * BAR + 240)); // the second time through bar 1
    m.add(off(4100, 62, 2 * BAR + 480));
    const made = regionsOf(planCapture(p, m.phrase(5000) as never, at({ map: playMap(p), playedNow: 3 * BAR })));
    expect(made.map((r) => [r.region.name, r.region.start, r.region.muted, r.region.notes[0]?.t])).toEqual([
      ['Captured', 0, true, 240],
      ['Captured (time 2)', 0, false, 240],
    ]);
  });

  it('goes to the tracks that sounded it; with none, to the selected track', () => {
    const m = new CaptureMemory();
    m.add(on(0, 60, null, ['trk_keys', 'trk_bass']));
    m.add(off(250, 60, null, ['trk_keys', 'trk_bass']));
    m.add(on(500, 62, null, []));
    m.add(off(750, 62, null, []));
    const made = regionsOf(planCapture(song(), m.phrase(1000) as never, at({ selectedTrack: 'trk_bass' })));
    expect(made.map((r) => [r.track, r.region.notes.map((n) => n.p)])).toEqual([
      ['trk_keys', [60]],
      ['trk_bass', [60, 62]],
    ]);
  });

  it('has nowhere to go without an instrument track that is on', () => {
    const m = new CaptureMemory();
    m.add(on(0, 60, null, []));
    m.add(off(250, 60, null, []));
    const p = song();
    expect(planCapture(p, m.phrase(1000) as never, at({ selectedTrack: 'trk_vocal' }))).toBeNull();
    expect(planCapture(p, m.phrase(1000) as never, at({ selectedTrack: null }))).toBeNull();
    // the track that sounded it has since been deleted, or switched off: the selected one takes it
    const gone = new CaptureMemory();
    gone.add(on(0, 60, null, ['trk_gone']));
    gone.add(off(250, 60, null, ['trk_gone']));
    expect(regionsOf(planCapture(p, gone.phrase(1000) as never, at()))[0]?.track).toBe('trk_keys');
  });
});

describe('a take’s regions (the recorder’s too)', () => {
  it('is one region on whole bars, long enough for its last note', () => {
    const take = { notes: [{ t: BAR + 100, d: 2 * BAR, p: 60, v: 90 }], cc: new Map() };
    const made = takeRegions(song(), null, take, 'Recording', () => 'rgn_x');
    expect(made.map((r) => [r.name, r.start, r.length, r.notes[0]?.t])).toEqual([['Recording', BAR, 3 * BAR, 100]]);
  });

  it('is nothing for an empty take', () => {
    expect(takeRegions(song(), null, { notes: [], cc: new Map() }, 'Recording', () => 'x')).toEqual([]);
  });
});
