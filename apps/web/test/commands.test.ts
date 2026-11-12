import { type Note, newProject, newRegion, newTrack, PPQ, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import {
  type Actions,
  type BarState,
  barRows,
  type Command,
  commandTable,
  typedPosition,
} from '../src/app/commands.ts';
import { KEY_COMMANDS } from '../src/app/keys.ts';

const BAR = PPQ * 4;

/** Every action the commands call, written down by name and arguments instead of done. */
function recorder(): { act: Actions; calls: string[] } {
  const calls: string[] = [];
  const act = new Proxy({} as Actions, {
    get:
      (_, name) =>
      (...args: unknown[]) =>
        calls.push(`${String(name)}(${args.map((a) => JSON.stringify(a)).join(', ')})`),
  });
  return { act, calls };
}

/** A song in 4/4: Piano with a region over bars 5–8 holding two notes, Bass, and two markers. */
function song(): { project: Project; region: string; notes: Note[]; piano: string; bass: string } {
  const project = newProject('Night Window');
  const piano = newTrack('Piano', { type: 'synth', preset: 'Soft Keys' });
  const bass = newTrack('Bass', { type: 'synth', preset: 'Soft Keys' });
  const region = newRegion(4 * BAR, 4 * BAR);
  const notes: Note[] = [
    { t: 0, d: PPQ, p: 60, v: 100 },
    { t: BAR + PPQ, d: PPQ, p: 64, v: 100 },
  ];
  region.notes = notes;
  piano.regions.push(region);
  project.tracks = [piano, bass];
  project.markers = [
    { id: 'mk_b', tick: 12 * BAR, name: 'Bridge' },
    { id: 'mk_a', tick: 4 * BAR, name: 'Theme' },
  ];
  return { project, region: region.id, notes, piano: piano.id, bass: bass.id };
}

function studio(patch: Partial<BarState> = {}): BarState {
  return {
    project: song().project,
    selectedTrack: null,
    selectedRegions: [],
    selectedNotes: [],
    editor: 'piano',
    noteView: 'roll',
    inspector: true,
    library: false,
    automationView: false,
    playing: false,
    recording: false,
    typing: false,
    undo: [],
    redo: [],
    bouncing: null,
    playhead: 0,
    phone: false,
    ...patch,
  };
}

const titles = (query: string, s: BarState) => barRows(query, s, recorder().act).map((c) => c.title);

describe('the bar’s commands', () => {
  it('finds a command from the start of its name', () => {
    const { project, region } = song();
    const s = studio({ project, selectedRegions: [region] });
    expect(titles('quant', s)[0]).toBe('Quantize the selection');
    expect(titles('mix', s)[0]).toBe('Mixer');
    expect(titles('bounce', s)[0]).toBe('Bounce to a WAV file');
    // a word it's also known by, and its group, find it as well, after what its title names
    expect(titles('export', s)).toContain('Bounce to a WAV file');
    expect(titles('save', s)[0]).toBe('Save now');
  });

  it('lists at most eight rows, and offers to find what was typed in the Library last', () => {
    const s = studio();
    expect(barRows('', s, recorder().act).length).toBeLessThanOrEqual(8);
    expect(barRows('t', s, recorder().act).length).toBeLessThanOrEqual(8);
    const rows = titles('cello', s);
    expect(rows.at(-1)).toBe('Find “cello” in the Library');
    const { act, calls } = recorder();
    barRows('cello', s, act).at(-1)?.run();
    expect(calls).toEqual(['set({"library":true,"librarySearch":"cello"})']);
    const phone = recorder();
    barRows('cello', studio({ phone: true }), phone.act)
      .at(-1)
      ?.run();
    expect(phone.calls).toEqual(['set({"mobileTab":"library","librarySearch":"cello"})']);
  });

  it('is just a field when nothing is typed: only what fits the window open is offered', () => {
    const { project, region, notes, piano } = song();
    expect(titles('', studio({ project }))).toEqual([]);
    expect(titles('', studio({ project, selectedTrack: piano, selectedRegions: [region] }))).toEqual([]);
    expect(titles('', studio({ project, selectedTrack: piano, selectedNotes: notes }))).toEqual([]);
    // a scan's tasks while its window is open (with the agent): those, and nothing else
    const read: Command = { id: 'scan-read', title: 'Read this scan', group: 'Agent', run: () => undefined };
    expect(barRows('', studio({ project }), recorder().act, { suggest: [read] }).map((c) => c.title)).toEqual([
      'Read this scan',
    ]);
  });

  it('offers only what can act now', () => {
    const { project, region, notes, piano } = song();
    const ids = (s: BarState) =>
      commandTable(s, recorder().act)
        .filter((c) => c.available?.(s) ?? true)
        .map((c) => c.id);
    const none = ids(studio({ project }));
    for (const id of ['quantize', 'repeat', 'split', 'transpose-up', 'delete', 'mute', 'solo', 'undo', 'redo'])
      expect(none).not.toContain(id);
    const regionIds = ids(studio({ project, selectedTrack: piano, selectedRegions: [region], playhead: 4 * BAR }));
    expect(regionIds).toEqual(expect.arrayContaining(['quantize', 'repeat', 'delete', 'mute', 'solo']));
    // the playhead at the region's start cuts nothing: no Split
    expect(regionIds).not.toContain('split');
    expect(regionIds).not.toContain('transpose-up');
    const noteIds = ids(studio({ project, selectedTrack: piano, selectedNotes: notes }));
    expect(noteIds).toEqual(expect.arrayContaining(['quantize', 'transpose-up', 'transpose-octave-down', 'delete']));
    expect(noteIds).not.toContain('repeat');
    // no song yet: the panes still open, the transport and edits wait
    const empty = ids(studio({ project: null }));
    expect(empty).toContain('mixer');
    expect(empty).not.toContain('play');
    expect(empty).not.toContain('save');
    // a phone has no Inspector, no Musical Typing and no keys to list
    const phone = ids(studio({ project, phone: true }));
    expect(phone).not.toContain('inspector');
    expect(phone).not.toContain('typing');
    expect(phone).not.toContain('shortcuts');
  });

  it('names what it will do', () => {
    const { project, piano } = song();
    const track = project.tracks.find((t) => t.id === piano);
    if (track) track.channel.mute = true;
    const s = studio({
      project,
      selectedTrack: piano,
      playing: true,
      undo: [{ project, label: 'Quantize' }],
    });
    const table = commandTable(s, recorder().act);
    const title = (id: string) => table.find((c) => c.id === id)?.title;
    expect(title('mute')).toBe('Unmute Piano');
    expect(title('solo')).toBe('Solo Piano');
    expect(title('play')).toBe('Stop');
    expect(title('undo')).toBe('Undo Quantize');
    expect(title('quantize')).toBe('Quantize the track');
  });

  it('goes to a bar typed in the field: "17", "17.3", "bar 9"', () => {
    const { project } = song();
    const s = studio({ project });
    const go = (q: string) => {
      const { act, calls } = recorder();
      const rows = barRows(q, s, act);
      rows[0]?.run();
      return { titles: rows.map((r) => r.title), calls };
    };
    expect(go('17')).toEqual({ titles: ['Go to bar 17'], calls: [`locate(${16 * BAR})`] });
    expect(go('17.3')).toEqual({ titles: ['Go to bar 17, beat 3'], calls: [`locate(${16 * BAR + 2 * PPQ})`] });
    expect(go(' bar 9 ').calls).toEqual([`locate(${8 * BAR})`]);
    expect(go('17.3.2').titles).toEqual(['Go to 17.3.2']);
    // a beat the bar hasn't got, or a bar before the first, is no position
    expect(typedPosition(project.meter, '17.5')).toBeNull();
    expect(typedPosition(project.meter, '0')).toBeNull();
    expect(typedPosition(project.meter, 'quantize')).toBeNull();
    expect(go('17.5').titles[0]).not.toMatch(/^Go to/);
  });

  it('makes a row for each marker and each track', () => {
    const { project, piano } = song();
    const { act, calls } = recorder();
    const s = studio({ project });
    const table = commandTable(s, act);
    const markers = table.filter((c) => c.group === 'Markers');
    expect(markers.map((c) => [c.title, c.note])).toEqual([
      ['Go to marker: Theme', 'bar 5'],
      ['Go to marker: Bridge', 'bar 13'],
    ]);
    expect(barRows('bridge', s, act)[0]?.title).toBe('Go to marker: Bridge');
    barRows('bridge', s, act)[0]?.run();
    expect(calls).toEqual([`locate(${12 * BAR})`]);
    const pick = barRows('piano', s, act).find((c) => c.title === 'Select track: Piano');
    pick?.run();
    expect(calls.at(-1)).toBe(`selectTrack("${piano}")`);
  });

  it('has no two commands with the same id', () => {
    const { project, region, piano } = song();
    const table = commandTable(studio({ project, selectedTrack: piano, selectedRegions: [region] }), recorder().act);
    const ids = table.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a command for every key command that does something', () => {
    // not commands: the Score's note entry (the keys type notes while writing), Musical Typing's keys
    // (they play notes), and the bar's own key
    const skip = (k: (typeof KEY_COMMANDS)[number]) =>
      k.group === 'Musical Typing' || (k.group === 'Score' && k.keys !== 'Shift N') || k.keys === 'Ctrl /';
    const table = commandTable(studio(), recorder().act);
    const missing = KEY_COMMANDS.filter((k) => !skip(k))
      .flatMap((k) => k.keys.split(' / '))
      .filter((keys) => !table.some((c) => c.keys === keys));
    expect(missing).toEqual([]);
  });

  it('runs what the keys run', () => {
    const { project, piano } = song();
    const s = studio({ project, selectedTrack: piano, editor: 'piano', noteView: 'roll' });
    const { act, calls } = recorder();
    const run = (id: string) =>
      commandTable(s, act)
        .find((c) => c.id === id)
        ?.run();
    run('piano-roll');
    run('mixer');
    run('mute');
    run('songs');
    expect(calls).toEqual([
      'set({"editor":null,"noteView":"roll","mobileTab":"editor"})',
      'set({"editor":"mixer","mobileTab":"mixer"})',
      `setChannel("${piano}", {"mute":true}, "Mute")`,
      'set({"dialog":"projects"})',
    ]);
  });
});
