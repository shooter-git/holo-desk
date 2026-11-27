/** The agent's `steps` tool: a drum part read as lines, and every Step Grid edit made through it. */
import { newProject, newRegion, newTrack, PPQ, type Project, type Track } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { fakeJobApi } from '../src/api.ts';
import { STEP_EDITS } from '../src/edits/steps.ts';
import { toolNamed } from '../src/tools/index.ts';
import { BAR, call, lastOps, refused } from './helpers.ts';

const S = PPQ / 4;

/** Drums (Drum Synth: a kick on the beats and a snare on 2 and 4 of bar 1, of two bars), Kit (a sampled kit), Keys. */
function song(): Project {
  const p = newProject('Beat');
  const drums: Track = { ...newTrack('Drums', { type: 'synth', preset: 'Drum Synth' }), id: 'trk_drums' };
  const r = { ...newRegion(0, BAR * 2, 'Beat'), id: 'rgn_beat' };
  r.notes = [
    ...[0, 4, 8, 12].map((i) => ({ t: S * i, d: S, p: 36, v: 100 })),
    { t: S * 4, d: S, p: 38, v: 124 },
    { t: S * 12 + 20, d: S, p: 38, v: 124 },
  ];
  drums.regions = [r];
  const kit: Track = { ...newTrack('Kit', { type: 'sampler', pack: 'pk', name: 'Studio Kit' }), id: 'trk_kit' };
  const keys: Track = { ...newTrack('Keys', { type: 'synth', preset: 'Soft Keys' }), id: 'trk_keys' };
  p.tracks = [drums, kit, keys];
  return p;
}

const setup = () =>
  fakeJobApi(song(), {
    instruments: {
      'pk/Studio Kit': {
        pads: [
          { key: 36, name: 'Kick In' },
          { key: 40, name: 'Snare Top' },
        ],
      },
      'pk/Grand': {},
    },
  });
const notes = (api: ReturnType<typeof setup>, track = 'trk_drums') =>
  (api.project.tracks.find((t) => t.id === track) as Track).regions.flatMap((r) =>
    r.notes.map((n) => [r.start + n.t, n.p, n.v]),
  );

describe('steps', () => {
  it('shows a part’s bars as lines, a row a piece, with what else the kit has', async () => {
    const api = setup();
    const r = await call(api, 'steps', { track: 'Drums', bars: '1-2' });
    expect(r.text.split('\n')).toEqual([
      'Drums, bars 1–2, 1/16 (16 steps a bar):',
      'Kick   x...x...x...x... | ................',
      'Snare  ....X.......X... | ................',
      expect.stringMatching(/^The kit also has: Kick 2, Snare 2, Side Stick, Clap, Closed Hat, /),
      'X accent, x hit, o soft, g ghost, . none.',
    ]);
    // with no bars said: the part's own, from where it starts
    expect((await call(api, 'steps', { track: 'Drums' })).text).toContain('Drums, bars 1–2');
    // every piece, and another grid
    const all = await call(api, 'steps', { track: 'Drums', bars: '1', grid: '1/8', all: true });
    expect(all.text).toMatch(/^Closed Hat +\.{8}$/m);
    expect(all.text).not.toContain('The kit also has');
    expect(all.text).toContain('(8 steps a bar)');
    expect(api.batches).toEqual([]);
  });

  it('writes rows from lines, in one change, and answers with the bars as they are now', async () => {
    const api = setup();
    const r = await call(api, 'steps', {
      track: 'Drums',
      bars: '1-2',
      action: 'write',
      lines: 'Kick: x.......x.x.....; Closed Hat = x.x.x.x.x.x.x.x.\nsnare: ....X.......X...',
    });
    expect(api.batches).toHaveLength(1);
    expect(lastOps(api).map((o) => o.op)).toEqual(['setNotes']);
    expect(r.text).toContain('3 rows written (Drums, bars 1–2).');
    expect(r.text).toContain('Kick        x.......x.x..... | x.......x.x.....');
    expect(r.text).toContain('Closed Hat  x.x.x.x.x.x.x.x. | x.x.x.x.x.x.x.x.');
    expect(r.progress).toBe('3 rows written');
    // the snare was those steps already: its late hit is where it was
    expect(notes(api)).toContainEqual([S * 12 + 20, 38, 124]);
    // one row, with its pattern
    await call(api, 'steps', { track: 'Drums', bars: '2', action: 'write', row: 'clap', pattern: '....x...' });
    expect(
      notes(api)
        .filter(([, p]) => p === 39)
        .map(([t]) => t),
    ).toEqual([BAR + S * 4, BAR + S * 12]);
  });

  it('lights steps and puts them out, counted from 1 over the bars', async () => {
    const api = setup();
    await call(api, 'steps', {
      track: 'Drums',
      bars: '1-2',
      action: 'set',
      row: 'Open Hat',
      steps: [3, 19],
      level: 'soft',
    });
    expect(notes(api).filter(([, p]) => p === 46)).toEqual([
      [S * 2, 46, 72],
      [BAR + S * 2, 46, 72],
    ]);
    await call(api, 'steps', { track: 'Drums', bars: '1', action: 'clear', row: 'kick', step: 5 });
    expect(
      notes(api)
        .filter(([, p]) => p === 36)
        .map(([t]) => t),
    ).toEqual([0, S * 8, S * 12]);
    expect(await refused(api, 'steps', { track: 'Drums', bars: '1', action: 'set', row: 'kick', step: 17 })).toMatch(
      /16 steps on this grid: step 17/,
    );
    expect(await refused(api, 'steps', { track: 'Drums', bars: '1', action: 'set', row: 'kick' })).toMatch(
      /which "step"/,
    );
    expect(await refused(api, 'steps', { track: 'Drums', bars: '1', action: 'set', step: 1 })).toMatch(/which "row"/);
  });

  it('makes each pattern edit', async () => {
    const api = setup();
    const go = (args: Record<string, unknown>) => call(api, 'steps', { track: 'Drums', bars: '1', ...args });
    expect((await go({ action: 'velocity', row: 'snare', level: 'ghost' })).text).toContain('Snare  ....g.......g...');
    expect((await go({ action: 'velocity', row: 'snare', by: 40 })).text).toContain('Snare  ....o.......o...');
    expect((await go({ action: 'fill', row: 'Closed Hat', every: 2 })).text).toContain('Closed Hat  x.x.x.x.x.x.x.x.');
    expect((await go({ action: 'euclid', row: 'kick', hits: 3 })).text).toContain('Kick        x.....x....x....');
    expect((await go({ action: 'shift', row: 'kick', by: 2 })).text).toContain('Kick        ..x.....x....x..');
    const varied = await go({ action: 'humanize', row: 'Closed Hat', amount: 25, seed: 3 });
    expect(varied.text).toContain('velocities varied by up to 25');
    expect(
      new Set(
        notes(api)
          .filter(([, p]) => p === 42)
          .map(([, , v]) => v),
      ).size,
    ).toBeGreaterThan(1);
    expect((await go({ action: 'swing', amount: 60 })).text).toContain('The pattern: swung 60 %');
    expect(notes(api).some(([t, p]) => p === 42 && t === S * 2)).toBe(true);
    const copied = await call(api, 'steps', { track: 'Drums', bars: '1', action: 'copy', to: 2 });
    expect(copied.text).toContain('The pattern copied to bar 2 (Drums, bar 1).');
    expect((await call(api, 'steps', { track: 'Drums', bars: '2' })).text).toContain('Kick        ..x.....x....x..');
    expect((await go({ action: 'clear-row', row: 'kick' })).text).not.toContain('Kick  ');
    // (an empty bar shows the kit's first pieces, ready to write)
    expect((await go({ action: 'clear-row' })).text).toContain('Kick        ................');
    expect(notes(api).filter(([t]) => (t as number) < BAR - S)).toEqual([]);
    // each was one change
    expect(api.batches).toHaveLength(10);
  });

  it('has an action for every edit the Step Grid makes', () => {
    const actions = toolNamed('steps')?.args.find((a) => a.name === 'action')?.values ?? [];
    for (const e of STEP_EDITS) expect(actions, e.name).toContain(e.name);
    const words = String(toolNamed('steps')?.summary);
    for (const e of STEP_EDITS) expect(words, e.name).toContain(`"${e.name}"`);
  });

  it('names rows as the kit does, and makes a region where the part has none', async () => {
    const api = setup();
    const r = await call(api, 'steps', {
      track: 'Kit',
      bars: '5',
      action: 'write',
      lines: 'Kick In: x...x...x...x...; snare: ....x.......x...',
    });
    expect(r.text).toContain('Kick In    x...x...x...x...');
    expect(r.text).toContain('Snare Top  ....x.......x...');
    expect(lastOps(api).map((o) => o.op)).toEqual(['addRegion']);
    const kit = api.project.tracks.find((t) => t.id === 'trk_kit') as Track;
    expect(kit.regions.map((x) => [x.start, x.length, x.notes.length])).toEqual([[BAR * 4, BAR, 6]]);
    expect(await refused(api, 'steps', { track: 'Kit', bars: '5', action: 'clear-row', row: 'cowbell' })).toMatch(
      /No "cowbell" in this kit. Its pieces: Kick In, Snare Top/,
    );
  });

  it('is for kits: a part played by pitch is sent to its notes', async () => {
    const api = setup();
    expect(await refused(api, 'steps', { track: 'Keys' })).toMatch(/plays "Soft Keys" by pitch, not as a kit/);
    expect(await refused(api, 'steps', { track: 'Drums', bars: '1-40' })).toMatch(/At most 16 bars/);
    expect(await refused(api, 'steps', { track: 'Drums', bars: 'x' })).toMatch(/isn't bars/);
    expect(
      await refused(api, 'steps', { track: 'Drums', bars: '1', action: 'swing', grid: '1/8T', amount: 50 }),
    ).toMatch(/triplet grid/);
  });

  it('says so when nothing would change', async () => {
    const api = setup();
    const r = await call(api, 'steps', { track: 'Drums', bars: '1', action: 'write', row: 'kick', pattern: 'x...' });
    expect(r.text).toMatch(/^Nothing to change/);
    expect(api.batches).toEqual([]);
  });
});
