import type { View } from '@holo/agent/view';
import { newAudioTrack, newPlugin, newProject, newRegion, newTrack, PPQ, type Project } from '@holo/session';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ViewModule from '../src/app/agent-view.ts';
import type * as StoreModule from '../src/app/store.ts';

class Storage {
  items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

let S: typeof StoreModule;
let V: typeof ViewModule;
/** What the history route answers, by revision. */
const kept = new Map<number, Project>();

beforeAll(async () => {
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('innerWidth', 1440);
  vi.stubGlobal('innerHeight', 900);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('addEventListener', () => {});
  vi.stubGlobal('removeEventListener', () => {});
  vi.stubGlobal('document', {
    addEventListener() {},
    removeEventListener() {},
    documentElement: { style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} }, dataset: {} },
    visibilityState: 'visible',
    hidden: false,
  });
  vi.stubGlobal('fetch', async (url: string) => {
    const m = /\/history\/(\d+)$/.exec(url);
    const song = m ? kept.get(Number(m[1])) : undefined;
    return new Response(JSON.stringify(song ?? { error: 'No such revision' }), { status: song ? 200 : 404 });
  });
  S = await import('../src/app/store.ts');
  V = await import('../src/app/agent-view.ts');
});

const BAR = PPQ * 4;

/** Keys, and Strings with a region (bars 1–4: C4, D4, E4 on the first beats) and a reverb. */
function song(): Project {
  const p = newProject('A song');
  const strings = { ...newTrack('Strings', { type: 'synth', preset: 'Warm Pad' }), id: 'trk_strings' };
  const a = { ...newRegion(0, BAR * 4, 'A'), id: 'rgn_a' };
  a.notes = [
    { t: 0, d: PPQ, p: 60, v: 80 },
    { t: BAR, d: PPQ, p: 62, v: 80 },
    { t: BAR * 2, d: PPQ, p: 64, v: 80 },
  ];
  strings.regions.push(a);
  strings.channel.inserts.push({ ...newPlugin('reverb'), id: 'fx_rev' });
  p.tracks.push(strings);
  return p;
}

const open = (p: Project) => S.store.set({ project: p, undo: [], redo: [], selectedNotes: [], selectedRegions: [] });

describe('a view’s go', () => {
  it('selects a region and opens it, or a track’s notes of a pitch', () => {
    const p = song();
    open(p);
    expect(V.goTo({ track: 'trk_strings', region: 'rgn_a' })).toBeNull();
    let s = S.store.get();
    expect([s.selectedTrack, s.selectedRegions, s.editor]).toEqual(['trk_strings', ['rgn_a'], 'piano']);
    expect(V.goTo({ track: 'trk_strings', notes: { from: 2, to: '3.2', pitch: 62 } })).toBeNull();
    s = S.store.get();
    // the song's own notes, as the editor selects them
    expect(s.selectedNotes).toEqual([p.tracks[1]?.regions[0]?.notes[1]]);
    expect(s.selectedNotes[0]).toBe(p.tracks[1]?.regions[0]?.notes[1]);
    expect(V.goTo({ view: 'mixer' })).toBeNull();
    expect(S.store.get().editor).toBe('mixer');
    expect(V.goTo({ track: 'trk_strings', plugin: 'fx_rev' })).toBeNull();
    expect(S.store.get().plugin).toEqual({ target: 'trk_strings', id: 'fx_rev' });
  });

  it('says so when what it names is gone', () => {
    open(song());
    expect(V.goTo({ track: 'trk_gone' })).toMatch(/gone/);
    expect(V.goTo({ track: 'trk_strings', region: 'rgn_gone' })).toMatch(/gone/);
    expect(V.goTo({ track: 'trk_strings', notes: { from: 9, to: 10 } })).toMatch(/gone/);
    expect(V.goTo({ track: 'trk_strings', plugin: 'fx_gone' })).toMatch(/gone/);
  });

  it('opens a span of a track at its region', () => {
    const p = song();
    expect(V.spanGo(p, 'trk_strings', 2)).toEqual({ track: 'trk_strings', region: 'rgn_a', bar: 2 });
    expect(V.spanGo(p, 'trk_strings', 30)).toEqual({ track: 'trk_strings', bar: 30, view: 'editor' });
    expect(V.notesIn(p, 'trk_strings', BAR, BAR * 3).notes.map((n) => n.p)).toEqual([62, 64]);
  });
});

describe('a recording’s notes, from a view', () => {
  /**
   * The song with a Vocal take (at 120 bpm a second is 1920 ticks): a C4 at 0.5 s, a D4 at 2 s moved
   * down to C#4, a breath at 2.6 s, and a muted E4 at 4 s.
   */
  const withTake = (): Project => {
    const p = song();
    const vocal = { ...newAudioTrack('Vocal'), id: 'trk_vocal' };
    vocal.regions.push({
      ...newRegion(0, BAR * 8, 'Take'),
      id: 'rgn_take',
      audio: {
        file: 'aud_1',
        offset: 0,
        gain: 0,
        fadeIn: 0,
        fadeOut: 0,
        stretch: 1,
        notes: {
          mode: 'mono',
          v: 1,
          n: [
            { t: 0.5, d: 0.5, p: 60 },
            { t: 2, d: 0.5, p: 62, to: 61 },
            { t: 2.6, d: 0.3, p: null },
            { t: 4, d: 0.5, p: 64, m: true },
          ],
        },
      },
    });
    p.tracks.push(vocal);
    return p;
  };

  it('places them on the song’s timeline, as sung and as they play, without breaths or muted notes', () => {
    V.setRecordingNoteLister((_song, region) => region.audio?.notes?.n ?? null);
    const p = withTake();
    const region = p.tracks.find((t) => t.id === 'trk_vocal')?.regions[0];
    if (!region) throw new Error('no take');
    expect(V.placedNotes(p, region)).toEqual([
      { index: 0, start: 960, end: 1920, sung: 60, pitch: 60 },
      { index: 1, start: 3840, end: 4800, sung: 62, pitch: 61 },
    ]);
    // still being found
    V.setRecordingNoteLister(() => null);
    expect(V.placedNotes(p, region)).toBeNull();
  });

  it('goes to them in the Audio Editor’s Notes view, selected as the Notes view numbers them', () => {
    V.setRecordingNoteLister((_song, region) => region.audio?.notes?.n ?? null);
    open(withTake());
    S.store.set({ audioMode: 'wave' });
    // bar 2 starts at 2 s: the moved note, by its pitch as sung or as it plays
    expect(V.goTo({ track: 'trk_vocal', notes: { from: 2, to: 3, pitch: 62 } })).toBeNull();
    let s = S.store.get();
    expect([s.selectedAudioNotes, s.selectedRegions, s.editor, s.audioMode]).toEqual([
      { region: 'rgn_take', notes: [1] },
      ['rgn_take'],
      'piano',
      'notes',
    ]);
    expect(V.goTo({ track: 'trk_vocal', notes: { from: 1, to: 3, pitch: 61 } })).toBeNull();
    expect(S.store.get().selectedAudioNotes).toEqual({ region: 'rgn_take', notes: [1] });
    expect(V.goTo({ track: 'trk_vocal', notes: { from: 1, to: 3 } })).toBeNull();
    expect(S.store.get().selectedAudioNotes).toEqual({ region: 'rgn_take', notes: [0, 1] });
    // the muted note isn't one to go to; none there at all
    expect(V.goTo({ track: 'trk_vocal', notes: { from: 3, to: 4, pitch: 64 } })).toMatch(/gone/);
    // still being found: the Notes view opens there, nothing selected yet
    V.setRecordingNoteLister(() => null);
    S.store.set({ audioMode: 'wave', selectedAudioNotes: null });
    expect(V.goTo({ track: 'trk_vocal', notes: { from: 2, to: 3 } })).toBeNull();
    s = S.store.get();
    expect([s.selectedAudioNotes, s.audioMode]).toEqual([null, 'notes']);
    // a go to the notes view alone, and a recording's notes strip clicked
    S.store.set({ audioMode: 'wave' });
    expect(V.goTo({ track: 'trk_vocal', region: 'rgn_take', view: 'notes' })).toBeNull();
    expect(S.store.get().audioMode).toBe('notes');
    expect(V.spanGo(withTake(), 'trk_vocal', 2, true)).toEqual({
      track: 'trk_vocal',
      region: 'rgn_take',
      bar: 2,
      view: 'notes',
    });
    expect(V.spanGo(withTake(), 'trk_vocal', 2)).toEqual({ track: 'trk_vocal', region: 'rgn_take', bar: 2 });
  });
});

describe('a view’s settings', () => {
  it('sets one with a click, one undo step named for it', () => {
    open(song());
    expect(V.setBinding({ track: 'trk_strings', param: 'volume' }, -6)).toBe(true);
    const s = S.store.get();
    expect(s.project?.tracks[1]?.channel.volume).toBe(-6);
    expect(s.undo.map((u) => u.label)).toEqual(['Strings: Volume']);
    expect(V.setBinding({ track: 'trk_gone', param: 'volume' }, -6)).toBe(false);
  });

  it('slides one: heard as it moves, one undo step a drag', () => {
    open(song());
    const b = { track: 'trk_strings', param: 'fx:fx_rev:mix' };
    V.slideStart(b);
    V.slide(b, 10);
    V.slide(b, 20);
    V.slide(b, 30);
    V.slideEnd();
    const s = S.store.get();
    expect(s.project?.tracks[1]?.channel.inserts[0]?.params.mix).toBe(30);
    expect(s.undo).toHaveLength(1);
  });
});

describe('keeping a version', () => {
  it('makes the song that version again, under its own id, as one undo step', async () => {
    const now = song();
    open(now);
    const lower = { ...song(), id: 'prj_other', title: 'Lower', revision: 41 };
    kept.set(41, lower);
    const view: View = { blocks: [], versions: { Lower: 41 } };
    expect(await V.keepVersion(view, 'Lower')).toBe(true);
    const s = S.store.get();
    expect(s.project?.title).toBe('Lower');
    expect(s.project?.id).toBe(now.id);
    expect(s.project?.revision).toBe(now.revision);
    expect(s.undo.map((u) => u.label)).toEqual(['Keep “Lower”']);
    expect(s.undo[0]?.project).toBe(now);
    // a version no longer kept, or never named
    expect(await V.keepVersion({ blocks: [], versions: { Gone: 7 } }, 'Gone')).toBe(false);
    expect(await V.keepVersion(view, 'Hall')).toBe(false);
  });
});

describe('the studio’s commands', () => {
  it('are the bar’s, by id, with their titles', () => {
    open(song());
    S.store.set({ editor: null });
    expect(V.commandInfo('mixer')).toMatchObject({ title: 'Mixer', available: true });
    expect(V.commandInfo('track:trk_strings')).toBeNull();
    expect(V.commandInfo('launch')).toBeNull();
    expect(V.runCommand('mixer')).toBe(true);
    expect(S.store.get().editor).toBe('mixer');
    expect(V.runCommand('launch')).toBe(false);
  });
});
