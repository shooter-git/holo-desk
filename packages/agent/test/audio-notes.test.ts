/**
 * audio_notes: a recording's notes edited from the agent, its actions made from the session's list of
 * note edits (NOTE_EDITS). Notes are found on the host (a fake measurement here), kept in the song with
 * the first edit, chosen as the studio chooses them, and every edit is one valid batch.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AudioNote,
  type AudioNotes,
  missingNoteEdits,
  NOTE_EDITS,
  type NoteEdit,
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
import { type FakeJobApi, type FakeJobApiOptions, fakeJobApi, type MeasureAnswer } from '../src/api.ts';
import { toJsonSchema } from '../src/args.ts';
import { audioNotes, NOTE_TOOL_FIELDS } from '../src/tools/audio-notes.ts';
import { TOOLS } from '../src/tools/index.ts';
import { call, refused } from './helpers.ts';

const BAR = PPQ * 4;

/**
 * A line found in a 40 s recording: a note every second from 0.5 s, each 0.6 s long (E4, 26 cents
 * sharp, then G4, A4 and back), but the one at 13.5 s sung straight into the next; and a breath at 21.2 s.
 */
function found(): AudioNotes {
  const n: AudioNote[] = [];
  const line = [64.26, 67, 69, 67];
  for (let k = 0; k < 40; k++) {
    if (k === 21) {
      n.push({ t: 21.2, d: 0.2, p: null });
      continue;
    }
    n.push({ t: k + 0.5, d: k === 13 ? 1 : 0.6, p: line[k % 4] as number, ...(k % 5 === 0 ? { u: 0.03 } : {}) });
  }
  return parseProjectNotes({ mode: 'mono', v: 1, n });
}

/** Notes as a song keeps them (canonical), through a song read back. */
function parseProjectNotes(notes: AudioNotes): AudioNotes {
  const p = songWith(notes);
  return (p.tracks[1]?.regions[0]?.audio?.notes ?? notes) as AudioNotes;
}

/**
 * Keys (MIDI), Vocal (audio: "Take" bars 5–8 at 120 bpm, 10 s into its 40 s recording, so 8 s of it:
 * 10 s to 18 s), its notes kept if given; Pad (empty). In C major.
 */
function songWith(notes?: AudioNotes): Project {
  const p = newProject('Notes');
  p.key = 'C major';
  p.tempo = [{ tick: 0, bpm: 120 }];
  p.files = [{ id: 'aud_take', name: 'Take 3.wav', seconds: 40, rate: 48000, channels: 1 }];
  const keys: Track = { ...newTrack('Keys', { type: 'synth', preset: 'Soft Keys' }), id: 'trk_keys' };
  const vocal: Track = { ...newTrack('Vocal', { type: 'none' }), id: 'trk_vocal', kind: 'audio' };
  const take: Region = { ...newRegion(4 * BAR, 4 * BAR, 'Take'), id: 'rgn_take' };
  take.audio = {
    file: 'aud_take',
    offset: 10,
    gain: 0,
    fadeIn: 0,
    fadeOut: 0,
    stretch: 1,
    ...(notes ? { notes } : {}),
  };
  vocal.regions = [take];
  p.tracks = [keys, vocal, { ...newTrack('Pad', { type: 'synth', preset: 'Warm Pad' }), id: 'trk_pad' }];
  return parseProject(p);
}

const answer = (notes = found()): MeasureAnswer => ({
  done: true,
  task: 'msr_1',
  result: {
    kind: 'notes',
    file: 'aud_take',
    name: 'Take 3.wav',
    seconds: 40,
    notes,
    shapes: notes.n.map((n, i) =>
      n.p === null ? null : { drift: i === 12 ? -34 : 0, vibrato: i === 13 ? ([5.6, 35] as [number, number]) : null },
    ),
    looks: 'mono',
  },
});

const setup = (o: FakeJobApiOptions & { kept?: AudioNotes } = {}): FakeJobApi =>
  fakeJobApi(songWith(o.kept), { measured: { notes: answer() }, ...o });

const takeOf = (api: FakeJobApi) => api.project.tracks[1]?.regions[0] as Region;
const keptNotes = (api: FakeJobApi) => takeOf(api).audio?.notes as AudioNotes;
const measured = (api: FakeJobApi) => api.calls.filter((c) => c.method === 'measure').length;

/** Arguments an edit can be made with on the notes above: its required ones (and a few more) in range. */
function argsFor(e: NoteEdit): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of e.args) {
    if (!a.required && !(e.name === 'shift' && a.name === 'semitones')) continue;
    if (a.kind === 'pitch') out[a.name] = 'D4';
    else if (a.values) out[a.name] = a.values[a.values.length - 1];
    else if (a.kind === 'boolean') out[a.name] = true;
    else if (e.name === 'add' && a.name === 'start') out[a.name] = 13.2;
    else if (e.name === 'add' && a.name === 'length') out[a.name] = 0.2;
    else if (a.kind === 'seconds') out[a.name] = 0.05;
    else if (a.kind === 'percent') out[a.name] = 50;
    else out[a.name] = Math.min(a.max ?? 2, 2);
  }
  return out;
}

/** What makes an edit change something on notes found untouched: an edit before it. */
const BEFORE: Record<string, { action: string; [k: string]: unknown }> = {
  reset: { action: 'shift', notes: '7', semitones: 1 },
  unmute: { action: 'mute', notes: '7' },
};

describe('audio_notes, made from the note edits', () => {
  it('offers every note edit as an action, with its arguments, and keeps the tool list within 48', () => {
    const actions = audioNotes.args.find((a) => a.name === 'action')?.values ?? [];
    expect(actions.slice(0, 2)).toEqual(['show', 'detect']);
    expect(missingNoteEdits(actions)).toEqual([]);
    const fields = audioNotes.args.map((a) => a.name);
    for (const e of NOTE_EDITS) {
      for (const a of e.args) {
        expect(fields, `${e.name}: ${a.name}`).toContain(a.name);
        expect(
          NOTE_TOOL_FIELDS as readonly string[],
          `${e.name}'s ${a.name} is a field of the tool's own`,
        ).not.toContain(a.name);
      }
      expect(['show', 'detect']).not.toContain(e.name);
    }
    // no defaults: an edit fills in its own, and refuses what it doesn't take
    expect(audioNotes.args.filter((a) => a.default !== undefined)).toEqual([]);
    expect(toJsonSchema(audioNotes.args)).toMatchObject({ required: ['action'], additionalProperties: false });
    expect(audioNotes.args.find((a) => a.name === 'snap')).toMatchObject({
      type: 'enum',
      values: ['free', 'semitone', 'scale'],
    });
    expect(audioNotes.args.find((a) => a.name === 'semitones')?.describe).toMatch(
      /shift: .*-48 to 48 semitones.*formant: .*-12 to 12/,
    );
    expect(TOOLS.filter((t) => t.name === 'audio_notes')).toHaveLength(1);
    expect(TOOLS.length).toBeLessThanOrEqual(48);
  });

  it('shows the notes the region plays, numbered as its first edit will keep them, and changes nothing', async () => {
    const api = setup();
    const r = await call(api, 'audio_notes', { action: 'show', track: 'Vocal' });
    expect(api.batches).toEqual([]);
    expect(api.calls.find((c) => c.method === 'measure')?.args[0]).toEqual({
      what: 'notes',
      track: 'trk_vocal',
      region: 'rgn_take',
    });
    const lines = r.text.split('\n');
    // the 8 s it plays (10 s to 18 s of the recording: notes from 9.5 s to 17.5 s), two past either side
    expect(lines[0]).toBe(
      '"Take" [rgn_take] on Vocal, bars 5–8: 13 notes, a line’s notes (mono); not edited yet: found by HO[LO], and kept in the song with the first edit (one undo step).',
    );
    // 7.5 s into the recording plays 2.5 s before the region starts (bar 5, 8 s into the song): 3.4
    expect(lines[2]).toBe('1  3.4.1  G4  0.60 s  (outside the region)');
    expect(lines[5]).toBe('4  5.2.1  A4  0.60 s');
    expect(lines[7]).toBe('6  6.2.1  E4 +26c  0.60 s  drift -34c');
    expect(lines[8]).toBe('7  6.4.1  G4  1.00 s  vibrato 5.6 Hz ±35c');
    expect(lines).toHaveLength(15);
    // a page of chosen notes
    const some = await call(api, 'audio_notes', { action: 'show', track: 'Vocal', notes: 'pitch E4' });
    expect(some.text).toContain('"pitch E4": notes 2–10');
    expect(some.text.split('\n').filter((l) => /^\d+ {2}/.test(l))).toHaveLength(3);
    expect(api.batches).toEqual([]);
  });

  it('says what detection found, and keeps nothing', async () => {
    const api = setup();
    const r = await call(api, 'audio_notes', { action: 'detect', region: 'Take' });
    expect(r.text).toContain(
      'Found 40 notes in Take 3.wav (40.0 s), a line’s notes (mono); "Take" on Vocal has 13 notes of them',
    );
    expect(r.text).toContain('Pitches E4–A4; 3 more than 25 cents off a semitone; vibrato on 1, 1 drifting');
    expect(r.text).toContain('Nothing is kept in the song yet');
    expect(api.batches).toEqual([]);
  });

  it('keeps the notes with the first edit, in one batch, and edits what it keeps after that', async () => {
    const api = setup();
    const r = await call(api, 'audio_notes', { action: 'shift', track: 'Vocal', notes: '6', semitones: 2 });
    expect(r.text.split('\n')[0]).toBe(
      '"Take": shift note 6, 2 semitones: 1 note tuned; its notes are kept in the song from now on, as found, with this edit.',
    );
    expect(r.text).toContain('6  6.2.1  E4 +26c → F#4 +26c (off the key)  0.60 s  drift -34c  [pitch +2 st]');
    expect(api.batches).toHaveLength(1);
    const [op] = api.batches[0]?.ops ?? [];
    expect(op).toMatchObject({ op: 'updateRegion', track: 'trk_vocal', region: 'rgn_take' });
    const kept = keptNotes(api);
    expect(kept.n).toHaveLength(13);
    expect(kept.n[5]).toEqual({ t: 12.5, d: 0.6, p: 64.26, to: 66.26 });
    // the song reads back the same, to the bit
    expect(parseProject(structuredClone(api.project)).tracks[1]?.regions[0]?.audio?.notes).toEqual(kept);
    // after that, what it keeps is edited: nothing is found again
    const before = measured(api);
    await call(api, 'audio_notes', { action: 'vibrato', track: 'Vocal', notes: '6', keep: 0 });
    expect(measured(api)).toBe(before);
    expect(keptNotes(api).n[5]).toMatchObject({ to: 66.26, mo: 0 });
    await call(api, 'audio_notes', { action: 'reset', track: 'Vocal', notes: '6' });
    expect(keptNotes(api).n[5]).toEqual({ t: 12.5, d: 0.6, p: 64.26 });
    expect(api.batches.map((b) => b.label)).toEqual([
      '"Take": shift note 6, 2 semitones',
      '"Take": vibrato note 6, keep 0%',
      '"Take": reset note 6',
    ]);
  });

  it('makes every edit of the list as one valid batch', async () => {
    for (const e of NOTE_EDITS) {
      const api = setup();
      const before = BEFORE[e.name];
      if (before) await call(api, 'audio_notes', { track: 'Vocal', ...before });
      const args = { action: e.name, track: 'Vocal', ...(e.selection ? { notes: '7' } : {}), ...argsFor(e) };
      const r = await call(api, 'audio_notes', args);
      expect(r.text, `${e.name}: ${r.text}`).not.toMatch(/^Nothing changed/);
      expect(api.batches, e.name).toHaveLength(before ? 2 : 1);
      const op = api.batches.at(-1)?.ops[0];
      expect(op, e.name).toMatchObject({ op: 'updateRegion', region: 'rgn_take' });
      // (change() tried it on the song first; it reads back the same)
      const notes = keptNotes(api);
      expect(parseProject(structuredClone(api.project)).tracks[1]?.regions[0]?.audio?.notes, e.name).toEqual(notes);
    }
  });

  it('chooses notes as the studio does: all, numbers, bars, a pitch named the studio’s way, the selection', async () => {
    const chosen = async (notes: string, o: FakeJobApiOptions = {}, middleC: 'C3' | 'C4' = 'C4') => {
      const api = setup(o);
      await call(api, 'audio_notes', { action: 'gain', track: 'Vocal', notes, db: -3 }, middleC);
      return keptNotes(api)
        .n.map((n, i) => (n.g === -3 ? i + 1 : 0))
        .filter(Boolean);
    };
    expect(await chosen('all')).toHaveLength(13);
    expect(await chosen('1-3,5')).toEqual([1, 2, 3, 5]);
    // bar 6 plays 12 s to 14 s of the recording: the notes whose beat is there
    expect(await chosen('bars 6')).toEqual([6, 7]);
    expect(await chosen('bars 6-7')).toEqual([6, 7, 8, 9]);
    expect(await chosen('pitch E4')).toEqual([2, 6, 10]);
    expect(await chosen('pitch E3', {}, 'C3')).toEqual([2, 6, 10]);
    expect(
      await chosen('selected', { state: { selection: { audioNotes: { region: 'rgn_take', notes: [0, 9] } } } }),
    ).toEqual([1, 10]);
    const api = setup({ state: { selection: { audioNotes: { region: 'rgn_other', notes: [0] } } } });
    expect(await refused(api, 'audio_notes', { action: 'mute', track: 'Vocal', notes: 'selected' })).toMatch(
      /No notes of "Take" are selected in the studio's Notes/,
    );
  });

  it('refuses arguments in the list’s own words, before anything is found', async () => {
    const api = setup();
    const no = (args: Record<string, unknown>) => refused(api, 'audio_notes', { track: 'Vocal', ...args });
    expect(await no({ action: 'vibrato', notes: '3' })).toBe(
      'Say "keep": 100 as sung, 0 none, 200 twice as wide (0 to 200 %)',
    );
    expect(await no({ action: 'shift', notes: '3', semitones: 60 })).toBe(
      '"semitones" is -48 to 48 semitones (got 60)',
    );
    expect(await no({ action: 'shift', notes: '3', keep: 50 })).toBe(
      'shift takes no "keep" (it takes semitones, cents, snap)',
    );
    expect(await no({ action: 'set-pitch', notes: '3', pitch: 'H9' })).toMatch(/^"pitch" is a note name/);
    expect(await no({ action: 'mute' })).toMatch(/^Say which "notes": "all", "selected"/);
    expect(await no({ action: 'add', notes: '3', start: 13.2, length: 0.2 })).toBe(
      'add chooses no notes: leave "notes" out',
    );
    expect(await no({ action: 'show', semitones: 2 })).toBe('show takes no "semitones"');
    expect(measured(api)).toBe(0);
    expect(await no({ action: 'mute', notes: '99' })).toBe("There are 13 notes: 99 isn't one");
    expect(await no({ action: 'mute', notes: 'loud ones' })).toMatch(/doesn't choose notes/);
    expect(await no({ action: 'mute', notes: 'pitch C2' })).toBe('"pitch C2" chooses none of the notes of "Take"');
    expect(await refused(api, 'audio_notes', { action: 'show', track: 'Keys' })).toMatch(/Keys isn't an audio track/);
    expect(api.batches).toEqual([]);
  });

  it('refuses a time edit on chords’ notes, and makes the rest', async () => {
    const poly: AudioNotes = {
      mode: 'poly',
      v: 1,
      n: [
        { t: 10.5, d: 1, p: 60 },
        { t: 10.5, d: 1, p: 64 },
        { t: 10.5, d: 1, p: 67 },
      ],
    };
    const api = setup({ kept: poly });
    expect(await refused(api, 'audio_notes', { action: 'move', track: 'Vocal', notes: '2', seconds: 0.1 })).toBe(
      'move is for a line’s notes (mono): the notes of "Take" are chords’ notes (poly)',
    );
    await call(api, 'audio_notes', { action: 'shift', track: 'Vocal', notes: 'pitch E4', semitones: -1 });
    expect(keptNotes(api).n[1]).toMatchObject({ p: 64, to: 63 });
    expect(measured(api)).toBe(0);
  });

  it('says why an edit changes nothing: a breath has no pitch, a note is that way already', async () => {
    const kept: AudioNotes = {
      mode: 'mono',
      v: 1,
      n: [
        { t: 10.5, d: 0.6, p: 64 },
        { t: 11.5, d: 0.2, p: null },
      ],
    };
    const api = setup({ kept });
    expect((await call(api, 'audio_notes', { action: 'vibrato', track: 'Vocal', notes: '2', keep: 0 })).text).toBe(
      'Nothing changed: "Take": vibrato note 2, keep 0% leaves the notes as they are: note 2 has no pitch (a breath, a consonant or a noise) for it to change.',
    );
    expect((await call(api, 'audio_notes', { action: 'reset', track: 'Vocal', notes: '1-2' })).text).toBe(
      'Nothing changed: "Take": reset notes 1-2 leaves the notes as they are: they are that way already.',
    );
    expect(api.batches).toEqual([]);
    await call(api, 'audio_notes', { action: 'gain', track: 'Vocal', notes: '2', db: -6 });
    expect(keptNotes(api).n[1]).toEqual({ t: 11.5, d: 0.2, p: null, g: -6 });
  });

  it('says when the notes are still being found, and changes nothing', async () => {
    const api = setup({
      measured: {
        notes: { done: false, task: 'msr_2', progress: 0.4, eta: 6, stage: 'Finding the notes in Take 3.wav' },
      },
    });
    const r = await call(api, 'audio_notes', { action: 'shift', track: 'Vocal', notes: '3', semitones: 1 });
    expect(r.text).toMatch(/^Still finding the notes of Take 3\.wav: 40% done, about 6 s left/);
    expect(r.text).toContain('call audio_notes again with the same arguments');
    expect(api.batches).toEqual([]);
  });

  it('picks the only audio track’s only recording, or says which to choose', async () => {
    const api = setup();
    expect((await call(api, 'audio_notes', { action: 'show' })).text).toContain('"Take" [rgn_take] on Vocal');
    const take = takeOf(api);
    api.project.tracks[1]?.regions.push({ ...structuredClone(take), id: 'rgn_take2', name: 'Take 2', start: 12 * BAR });
    expect(await refused(api, 'audio_notes', { action: 'show' })).toMatch(/^Vocal has 2 recordings: say which/);
    expect((await call(api, 'audio_notes', { action: 'show', region: 'Take 2' })).text).toContain('[rgn_take2]');
  });
});

describe('the agent’s instructions', () => {
  it('stay within what the server reads of them', () => {
    const text = readFileSync(join(import.meta.dirname, '..', 'AGENT.md'), 'utf8');
    expect(text.length).toBeLessThan(40_000);
    expect(text).toContain('audio_notes');
  });
});
