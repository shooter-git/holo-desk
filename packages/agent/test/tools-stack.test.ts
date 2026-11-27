/** The agent's `stack` tool: folders and summing stacks made, changed and taken apart, and every routing said. */
import { newBus, newProject, newTrack, type Project, type Track } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { fakeJobApi } from '../src/api.ts';
import { call, lastOps, refused } from './helpers.ts';

/** Violins, Violas, Cellos, Flute and Drums, and a bus "Hall". */
function song(): Project {
  const p = newProject('Orchestra');
  p.tracks = ['Violins', 'Violas', 'Cellos', 'Flute', 'Drums'].map((name) => ({
    ...newTrack(name, { type: 'synth', preset: 'Soft Keys' }),
    id: `trk_${name.toLowerCase()}`,
  }));
  p.buses = [{ ...newBus('Hall'), id: 'bus_hall' }];
  return p;
}
const setup = () => fakeJobApi(song());
type Api = ReturnType<typeof setup>;
const order = (api: Api) => api.project.tracks.map((t) => (t.stack ? `${t.name}*` : t.name)).join(' ');
const out = (api: Api, name: string) => (api.project.tracks.find((t) => t.name === name) as Track).channel.output;
const busNamed = (api: Api, name: string) => api.project.buses.find((b) => b.name === name)?.id;

describe('stack', () => {
  it('says there are none, then makes a folder: the tracks together, nothing routed', async () => {
    const api = setup();
    expect((await call(api, 'stack')).text).toMatch(/^The song has no stacks/);
    const r = await call(api, 'stack', { action: 'make', name: 'Strings', tracks: ['Violins', 'Cellos'] });
    expect(r.text).toContain('Stacked Violins and Cellos as "Strings".');
    expect(r.text).toContain('A folder: its tracks play where they did (Stereo Out).');
    expect(order(api)).toBe('Violins* Cellos* Violas Flute Drums');
    expect(api.project.stacks).toEqual([{ id: expect.stringMatching(/^stk_/), name: 'Strings' }]);
    expect(api.project.tracks.every((t) => t.channel.output === 'master')).toBe(true);
    expect(api.batches).toHaveLength(1);
    expect(lastOps(api).map((o) => o.op)).toEqual(['addStack']);
    expect((await call(api, 'stack')).text).toContain('"Strings" [');
  });

  it('makes a summing stack with a new bus, routes its tracks there in the same step, and says so', async () => {
    const api = setup();
    const r = await call(api, 'stack', { action: 'make', name: 'Strings', tracks: ['Violins', 'Violas'], bus: 'new' });
    const bus = busNamed(api, 'Strings');
    expect(bus).toBeDefined();
    expect(lastOps(api).map((o) => o.op)).toEqual(['addBus', 'addStack', 'updateChannel', 'updateChannel']);
    expect([out(api, 'Violins'), out(api, 'Violas'), out(api, 'Cellos')]).toEqual([bus, bus, 'master']);
    expect(api.project.stacks?.[0]?.bus).toBe(bus);
    expect(r.text).toContain('a new bus "Strings" for it; Violins and Violas now play through it');
    expect(r.text).toContain('all its tracks play through it');
    expect(api.batches).toHaveLength(1);
  });

  it('uses a bus the song has, and leaves every output alone when told', async () => {
    const api = setup();
    const r = await call(api, 'stack', { action: 'make', name: 'Winds', tracks: ['Flute'], bus: 'Hall', route: false });
    expect(api.project.stacks?.[0]?.bus).toBe('bus_hall');
    expect(out(api, 'Flute')).toBe('master');
    expect(r.text).toContain('Flute (to Stereo Out) does not');
    expect(await refused(api, 'stack', { action: 'make', name: 'X', tracks: ['Drums'], bus: 'Nope' })).toMatch(
      /No bus "Nope": "Hall". "new" makes one/,
    );
  });

  it('puts tracks in and takes them out, routing them with the stack’s bus and back', async () => {
    const api = setup();
    await call(api, 'stack', { action: 'make', name: 'Strings', tracks: ['Violins'], bus: 'new' });
    const bus = busNamed(api, 'Strings');
    const added = await call(api, 'stack', { action: 'add', stack: 'strings', tracks: ['Cellos', 'Violas'] });
    expect(order(api)).toBe('Violins* Cellos* Violas* Flute Drums');
    expect([out(api, 'Cellos'), out(api, 'Violas')]).toEqual([bus, bus]);
    expect(added.text).toContain(
      'Cellos and Violas into the stack "Strings": Cellos and Violas now play through Strings',
    );
    const removed = await call(api, 'stack', { action: 'remove', stack: 'Str', tracks: ['Cellos'] });
    expect(order(api)).toBe('Violins* Violas* Cellos Flute Drums');
    expect(out(api, 'Cellos')).toBe('master');
    expect(removed.text).toContain('Cellos now plays to Stereo Out');
    // told to leave the outputs alone
    await call(api, 'stack', { action: 'remove', stack: 'Strings', tracks: ['Violas'], route: false });
    expect(out(api, 'Violas')).toBe(bus);
    expect(await refused(api, 'stack', { action: 'add', stack: 'Strings', tracks: ['Violins'] })).toMatch(
      /is in "Strings" already/,
    );
    expect(await refused(api, 'stack', { action: 'remove', stack: 'Strings', tracks: ['Flute'] })).toMatch(
      /isn't in "Strings"/,
    );
  });

  it('gives a folder a bus, and takes it away without moving an output unless told', async () => {
    const api = setup();
    await call(api, 'stack', { action: 'make', name: 'Strings', tracks: ['Violins', 'Violas'] });
    const on = await call(api, 'stack', { action: 'bus', stack: 'Strings', bus: 'new' });
    const bus = busNamed(api, 'Strings');
    expect(on.text).toContain('mixed through a new bus "Strings": Violins and Violas now play through it');
    expect([out(api, 'Violins'), api.project.stacks?.[0]?.bus]).toEqual([bus, bus]);
    const off = await call(api, 'stack', { action: 'bus', stack: 'Strings', bus: 'off' });
    expect(off.text).toContain('Violins and Violas still play through Strings ("route": true sends them back');
    expect([out(api, 'Violins'), api.project.stacks?.[0]?.bus]).toEqual([bus, undefined]);
    // the bus itself is still in the song
    expect(busNamed(api, 'Strings')).toBe(bus);
    await call(api, 'stack', { action: 'bus', stack: 'Strings', bus: 'Strings' });
    const back = await call(api, 'stack', { action: 'bus', stack: 'Strings', bus: 'off', route: true });
    expect(back.text).toContain('Violins and Violas now play to Stereo Out');
    expect(out(api, 'Violas')).toBe('master');
    expect(await refused(api, 'stack', { action: 'bus', stack: 'Strings', bus: 'off' })).toMatch(/has no bus/);
  });

  it('renames, moves the block whole, and unstacks leaving the tracks where they are', async () => {
    const api = setup();
    await call(api, 'stack', { action: 'make', name: 'Strings', tracks: ['Violins', 'Violas'], bus: 'new' });
    await call(api, 'stack', { action: 'rename', stack: 'Strings', name: 'Upper strings', color: '#ff8800' });
    expect(api.project.stacks?.[0]).toMatchObject({ name: 'Upper strings', color: '#ff8800' });
    await call(api, 'stack', { action: 'move', stack: 'Upper', index: 4 });
    expect(order(api)).toBe('Cellos Flute Drums Violins* Violas*');
    const bus = busNamed(api, 'Strings');
    const r = await call(api, 'stack', { action: 'unstack', stack: 'Upper strings' });
    expect(r.text).toContain('Unstacked "Upper strings" (2 tracks stay where they are)');
    expect(r.text).toContain('still play through the bus Strings, which is still there');
    expect(order(api)).toBe('Cellos Flute Drums Violins Violas');
    expect(api.project.stacks).toBeUndefined();
    expect(out(api, 'Violins')).toBe(bus);
  });

  it('is named in the song as the agent reads it', async () => {
    const api = setup();
    await call(api, 'stack', { action: 'make', name: 'Strings', tracks: ['Violins', 'Violas'], bus: 'new' });
    const shown = (await call(api, 'song_show')).text;
    expect(shown).toMatch(/Strings \[stk_\w+\]: Violins, Violas; its header controls the bus Strings \[bus_/);
    expect(shown).toMatch(/Violins \[trk_violins\].*in the stack "Strings"/);
  });

  it('says which stacks there are when one isn’t found, and what a make needs', async () => {
    const api = setup();
    await call(api, 'stack', { action: 'make', name: 'Strings', tracks: ['Violins'] });
    expect(await refused(api, 'stack', { action: 'unstack', stack: 'Brass' })).toMatch(
      /No stack "Brass". The stacks: "Strings"/,
    );
    expect(await refused(api, 'stack', { action: 'make', name: 'Strings', tracks: ['Flute'] })).toMatch(
      /already: "add"/,
    );
    expect(await refused(api, 'stack', { action: 'make', name: 'Winds' })).toMatch(/which "tracks"/);
    expect(await refused(api, 'stack', { action: 'make', name: 'Winds', tracks: ['Oboe'] })).toMatch(/Oboe/);
  });
});

describe('a track and its stack', () => {
  it('track_add puts a new track in a stack, through its bus when it has one', async () => {
    const api = setup();
    await call(api, 'stack', { action: 'make', name: 'Strings', tracks: ['Violins', 'Violas'], bus: 'new' });
    const r = await call(api, 'track_add', { name: 'Basses', stack: 'Strings' });
    expect(order(api)).toBe('Violins* Violas* Basses* Cellos Flute Drums');
    expect(out(api, 'Basses')).toBe(busNamed(api, 'Strings'));
    expect(r.text).toContain('in the stack "Strings". It plays through the stack\'s bus, Strings.');
  });

  it('track_set moves a track into a stack and out of it, and says where it plays', async () => {
    const api = setup();
    await call(api, 'stack', { action: 'make', name: 'Strings', tracks: ['Violins', 'Violas'], bus: 'new' });
    const into = await call(api, 'track_set', { track: 'Cellos', stack: 'Strings' });
    expect(into.text).toBe('Cellos: into the stack "Strings" (now through its bus, Strings).');
    expect(order(api)).toBe('Violins* Violas* Cellos* Flute Drums');
    const outOf = await call(api, 'track_set', { track: 'Violins', stack: 'none' });
    expect(outOf.text).toBe('Violins: out of the stack "Strings" (now to Stereo Out).');
    expect(order(api)).toBe('Violas* Cellos* Violins Flute Drums');
    expect(await refused(api, 'track_set', { track: 'Flute', stack: 'none' })).toMatch(/isn't in a stack/);
    expect(await refused(api, 'track_set', { track: 'Cellos', stack: 'Strings' })).toMatch(/already/);
  });

  it('can’t be stacked by a raw track patch: ops_apply’s own stack operations do it', async () => {
    const api = setup();
    await call(api, 'ops_apply', {
      label: 'Stack by hand',
      ops: [
        { op: 'addStack', stack: { id: 'stk_h', name: 'By hand' }, tracks: ['trk_flute'] },
        { op: 'updateTrack', track: 'trk_drums', patch: { stack: 'stk_h', name: 'Kit' } },
      ],
    });
    expect(order(api)).toBe('Violins Violas Cellos Flute* Kit');
  });
});
