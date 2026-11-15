/**
 * `holo notes` as the terminal runs it: its flags read as the agent's audio_notes fields (`toolArgs`),
 * then the agent's own tool (`runTool`), against a studio that answers as HO[LO] would (the agent's
 * fake job API): a macro, `midi`, a note's sound or edits copied and an edit linked across regions,
 * from flags. Synthetic notes only.
 */
import { type FakeJobApi, fakeJobApi, newMemory, type Tool, toolNamed } from '@holo/agent';
import {
  type AudioNote,
  type AudioNotes,
  newProject,
  newRegion,
  newTrack,
  PPQ,
  type Project,
  parseProject,
  type Region,
  type Track,
} from '@holo/session';
import { describe, expect, it } from 'vitest';
import type { TerminalApi } from '../src/terminal-api.ts';
import { runTool, toolArgs, type Wording } from '../src/tool-commands.ts';

const BAR = 4 * PPQ;

/** A vocal take at 120 bpm (bars 1–4 of its 8 s recording): a note every half second, 20 to 40 cents off, louder and quieter in turn. */
function song(): { project: Project; notes: AudioNotes; levels: number[] } {
  const n: AudioNote[] = [];
  for (let k = 0; k < 12; k++) n.push({ t: 0.25 + k * 0.5, d: 0.4, p: 60 + (k % 5) + (k % 2 ? -0.3 : 0.2) });
  const notes: AudioNotes = { mode: 'mono', v: 1, n };
  const p = newProject('Take');
  p.key = 'C major';
  p.tempo = [{ tick: 0, bpm: 120 }];
  p.files = [{ id: 'aud_take', name: 'Take.wav', seconds: 8, rate: 48000, channels: 1 }];
  const vocal: Track = { ...newTrack('Vocal', { type: 'none' }), id: 'trk_vocal', kind: 'audio' };
  const take: Region = { ...newRegion(0, 4 * BAR, 'Take'), id: 'rgn_take' };
  take.audio = { file: 'aud_take', offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 };
  vocal.regions = [take];
  p.tracks = [vocal];
  return { project: parseProject(p), notes, levels: n.map((_, k) => (k % 2 ? -22 : -16)) };
}

/** The fake studio, as the terminal's API: the same object, so its song is the one the tools change. */
function terminal(): FakeJobApi & TerminalApi {
  const { project, notes, levels } = song();
  const api = fakeJobApi(project, {
    measured: {
      notes: {
        done: true,
        task: 'msr_1',
        result: {
          kind: 'notes',
          file: 'aud_take',
          name: 'Take.wav',
          seconds: 8,
          notes,
          shapes: notes.n.map(() => ({ drift: 0, vibrato: null })),
          levels,
          looks: 'mono',
        },
      },
    },
  });
  return Object.assign(api, { changes: [], measured: null, attach: () => '' });
}

const how: Wording = { command: 'holo notes', positional: { field: 'action', say: 'ACTION' } };
const tool = toolNamed('audio_notes') as Tool;

/** `holo notes ACTION [words] --flag value…`, as main.ts hands it to the tool. */
async function holoNotes(api: TerminalApi, action: string, flags: Record<string, string>, chosen?: string) {
  const args = toolArgs(tool, new Map(Object.entries(flags)), how, ['wait']);
  if (chosen) args.notes = chosen;
  return runTool({ api, middleC: 'C4', memory: newMemory() }, 'audio_notes', { ...args, action }, how);
}

const keptNotes = (api: FakeJobApi) => api.project.tracks[0]?.regions[0]?.audio?.notes as AudioNotes;
const notesOf = (api: FakeJobApi, id: string) =>
  api.project.tracks[0]?.regions.find((r) => r.id === id)?.audio?.notes as AudioNotes | undefined;

describe('holo notes: the macros and midi from the terminal', () => {
  it('runs correct-pitch from flags, as the agent does, one batch', async () => {
    const api = terminal();
    const r = await holoNotes(
      api,
      'correct-pitch',
      { centre: '100', drift: '50', tolerance: '25', track: 'Vocal' },
      'all',
    );
    expect(r.text.split('\n')[0]).toMatch(
      /^"Take": correct-pitch all notes, centre 100%, drift 50%, tolerance 25 cents: /,
    );
    const kept = keptNotes(api);
    // 20 cents sharp: within the tolerance, left; 30 flat: tuned, half its drift taken out
    expect(kept.n[0]).toEqual({ t: 0.25, d: 0.4, p: 60.2 });
    expect(kept.n[1]).toEqual({ t: 0.75, d: 0.4, p: 60.7, to: 61, dr: 0.5 });
    expect(api.batches.map((b) => b.label)).toEqual([
      '"Take": correct-pitch all notes, centre 100%, drift 50%, tolerance 25 cents',
    ]);
  });

  it('runs quantize-time and level from flags, the grid named as the piano roll names it', async () => {
    const api = terminal();
    await holoNotes(api, 'move', { seconds: '0.03', track: 'Vocal' }, '3');
    await holoNotes(api, 'quantize-time', { grid: '1/8', track: 'Vocal' }, '3');
    // back on the grid: its move undone
    expect(keptNotes(api).n[2]).toEqual({ t: 1.25, d: 0.4, p: 62.2 });
    await holoNotes(api, 'level', { amount: '100', track: 'Vocal' }, '1-4');
    expect(
      keptNotes(api)
        .n.slice(0, 4)
        .map((n) => n.g),
    ).toEqual([-3, 3, -3, 3]);
    // the words refused in flags
    await expect(holoNotes(api, 'quantize-time', { grid: '1/7', track: 'Vocal' }, '3')).rejects.toThrow(/--grid/);
  });

  it('adds a MIDI track (holo notes midi)', async () => {
    const api = terminal();
    const r = await holoNotes(api, 'midi', { track: 'Vocal' });
    expect(r.text).toMatch(/^"Take": notes to MIDI: added "Vocal notes", a MIDI track below Vocal, playing 12 notes/);
    // (the agent's other tools named as commands)
    expect(r.text).toContain('give it an instrument with holo track set.');
    const added = api.project.tracks[1];
    expect(added?.name).toBe('Vocal notes');
    expect(added?.regions[0]?.notes.map((n) => n.p)).toEqual([60, 61, 62, 63, 64, 60, 61, 62, 63, 64, 60, 61]);
    expect(added?.regions[0]?.notes.map((n) => n.v).slice(0, 2)).toEqual([110, Math.round(110 * 10 ** (-6 / 40))]);
    await expect(holoNotes(api, 'midi', { track: 'Vocal' }, 'all')).rejects.toThrow(
      'midi writes all the notes the region plays: leave --notes out',
    );
  });
});

describe('holo notes: paste, copy-settings and --linked from the terminal', () => {
  it('pastes a note’s sound (--from), copies its edits, and says its refusals in flags', async () => {
    const api = terminal();
    const r = await holoNotes(api, 'paste', { from: '3', track: 'Vocal' }, '5');
    expect(r.text.split('\n')[0]).toBe(
      '"Take": paste note 5, from note 3: 1 note pasted; its notes are kept in the song from now on, as found, with this edit.',
    );
    expect(keptNotes(api).n[4]).toEqual({ t: 2.25, d: 0.4, p: 62.2, s: 1.25 });
    await holoNotes(api, 'gain', { db: '-5', track: 'Vocal' }, '1');
    await holoNotes(api, 'copy-settings', { from: '1', track: 'Vocal' }, '2-3');
    expect(
      keptNotes(api)
        .n.slice(0, 3)
        .map((n) => n.g),
    ).toEqual([-5, -5, -5]);
    await expect(holoNotes(api, 'paste', { track: 'Vocal' }, '5')).rejects.toThrow(/^Say --from: /);
    await expect(holoNotes(api, 'paste', { from: '1', 'from-region': 'Nope', track: 'Vocal' }, '5')).rejects.toThrow(
      /No recording "Nope"/,
    );
  });

  it('makes an edit in every region playing the recording too (--linked), one batch', async () => {
    const api = terminal();
    const vocal = api.project.tracks[0] as Track;
    const take = vocal.regions[0] as Region;
    vocal.regions.push({ ...structuredClone(take), id: 'rgn_again', name: 'Again', start: 6 * BAR });
    const r = await holoNotes(api, 'shift', { semitones: '1', track: 'Vocal', region: 'Take', linked: 'on' }, '2');
    expect(r.text.split('\n').at(-1)).toBe(
      'Linked: also made in "Again" [rgn_again] on Vocal, bars 7–10 (1 note tuned; its notes kept in the song from now on).',
    );
    expect(api.batches).toHaveLength(1);
    expect(notesOf(api, 'rgn_again')?.n[1]).toEqual({ t: 0.75, d: 0.4, p: 60.7, to: 61.7 });
    // (--linked alone, as a switch)
    const flags = toolArgs(tool, new Map<string, string | true>([['linked', true]]), how, ['wait']);
    expect(flags).toEqual({ linked: true });
  });
});
