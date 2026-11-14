import type { AudioNote } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { loudestOf, type NoteCurve, RecordingNotes } from '../src/audio/notes.ts';

const curve = (): NoteCurve => ({
  t: Float64Array.from([0, 0.005, 0.01]),
  midi: Float64Array.from([Number.NaN, 64, 64.1]),
  power: Float64Array.from([Number.NaN, 0.02, 0.5]),
});

/** A note finder that answers when told to, counting what it was asked. */
function finder() {
  const asked: string[] = [];
  const answers = new Map<
    string,
    { ok: (r: { notes: AudioNote[]; curve: NoteCurve }) => void; fail: (e: Error) => void }
  >();
  const find = (project: string, file: string) => {
    asked.push(`${project}/${file}`);
    return new Promise<{ notes: AudioNote[]; curve: NoteCurve }>((ok, fail) => answers.set(file, { ok, fail }));
  };
  return { asked, answers, find };
}

const settled = () => new Promise((r) => setTimeout(r, 0));

describe('a recording’s notes, found once', () => {
  it('finds a file’s notes once, however many ask while they’re found', async () => {
    const f = finder();
    const notes = new RecordingNotes(f.find);
    expect(notes.of('p1', 'aud_a').state).toBe('finding');
    expect(notes.of('p1', 'aud_a').state).toBe('finding');
    expect(f.asked).toEqual(['p1/aud_a']);
    f.answers.get('aud_a')?.ok({ notes: [{ t: 0.005, d: 0.2, p: 64 }], curve: curve() });
    await settled();
    const known = notes.of('p1', 'aud_a');
    expect(known.state).toBe('found');
    if (known.state !== 'found') return;
    expect(known.found.notes).toHaveLength(1);
    expect(known.found.loudest).toBe(0.5);
    // kept: never found again
    expect(f.asked).toEqual(['p1/aud_a']);
  });

  it('finds each file on its own', () => {
    const f = finder();
    const notes = new RecordingNotes(f.find);
    notes.of('p1', 'aud_a');
    notes.of('p1', 'aud_b');
    expect(f.asked).toEqual(['p1/aud_a', 'p1/aud_b']);
  });

  it('tells whoever listens once they’re known', async () => {
    const f = finder();
    const notes = new RecordingNotes(f.find);
    let heard = 0;
    const stop = notes.subscribe(() => heard++);
    notes.of('p1', 'aud_a');
    expect(heard).toBe(0);
    f.answers.get('aud_a')?.ok({ notes: [], curve: curve() });
    await settled();
    expect(heard).toBe(1);
    stop();
    notes.of('p1', 'aud_b');
    f.answers.get('aud_b')?.ok({ notes: [], curve: curve() });
    await settled();
    expect(heard).toBe(1);
  });

  it('says why they couldn’t be found', async () => {
    const f = finder();
    const notes = new RecordingNotes(f.find);
    notes.of('p1', 'aud_a');
    f.answers.get('aud_a')?.fail(new Error('Not a WAV file'));
    await settled();
    expect(notes.of('p1', 'aud_a')).toEqual({ state: 'failed', error: 'Not a WAV file' });
    expect(f.asked).toHaveLength(1);
  });

  it('draws a level against the loudest on the curve (where it isn’t voiced too)', () => {
    expect(loudestOf(Float64Array.from([0.1, Number.NaN, 0.4, 0.2]))).toBe(0.4);
    expect(loudestOf(new Float64Array(0))).toBe(0);
  });
});
