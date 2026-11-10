import { applyOps, newProject, newRegion, PPQ, type Project, parseNotation } from '@holo/session';
import { describe, expect, it } from 'vitest';
import {
  addMark,
  type Caret,
  enter,
  extend,
  letterPitch,
  notate,
  quantizeToScore,
  respell,
  scoreText,
  setForm,
  staffPlace,
  toggleArticulation,
  writeScoreText,
} from '../src/index.ts';

const q = PPQ;

function flute(notes = 'D5:2 E5:2 F5:2 G5:2'): Project {
  const p = newProject('Edit');
  const t = p.tracks[0];
  if (!t) throw new Error('no track');
  t.name = 'Flute';
  const r = newRegion(0, 4 * q);
  r.notes = parseNotation(notes, { unit: q / 2 });
  t.regions = [r];
  p.key = 'D major';
  return p;
}

const last = (p: Project) => scoreText(notate(p)).split('\n').at(-1);

describe('editing a score', () => {
  it('enters a note over what was there', () => {
    const p = flute();
    const doc = notate(p);
    const caret: Caret = { track: p.tracks[0]?.id as string, staff: 1, voice: 1, tick: q / 2 };
    const r = enter(p, doc, caret, [{ p: 81 }], q);
    const next = applyOps(p, r.ops);
    // an offbeat quarter is two tied eighths; the E it covered is gone
    expect(last(next)).toBe('  P1: d5:e a5:e~ a5:e r:e f5:q g5:q');
    expect(next.tracks[0]?.regions[0]?.notes).toContain(r.notes[0]);
    expect(r.notes[0]?.n?.w).toEqual([q, Math.round(q * 0.92)]);
  });

  it('enters a rest, and runs past the region, lengthening it', () => {
    const p = flute();
    const id = p.tracks[0]?.id as string;
    let next = applyOps(p, enter(p, notate(p), { track: id, staff: 1, voice: 1, tick: 0 }, [], q).ops);
    expect(last(next)).toBe('  P1: r:q e5:q f5:q g5:q');
    next = applyOps(
      next,
      enter(next, notate(next), { track: id, staff: 1, voice: 1, tick: 4 * q }, [{ p: 74 }], 2 * q).ops,
    );
    expect(next.tracks[0]?.regions.map((r) => r.length)).toEqual([6 * q]);
  });

  it('types letters in the key, near the last note', () => {
    const p = flute();
    const doc = notate(p);
    const caret: Caret = { track: p.tracks[0]?.id as string, staff: 1, voice: 1, tick: 0 };
    // F in D major is F♯; near D5 it's F♯5
    const f = letterPitch(p, doc, caret, 3, { step: 1, alter: 0, octave: 5 });
    expect(f.pitch.p).toBe(78);
    // B near C5 is the B below
    expect(letterPitch(p, doc, caret, 6, { step: 0, alter: 0, octave: 5 }).pitch.p).toBe(71);
  });

  it('types a transposing part as it reads', () => {
    const p = flute();
    const t = p.tracks[0];
    if (t) t.name = 'Clarinet in Bb';
    const doc = notate(p);
    const caret: Caret = { track: t?.id as string, staff: 1, voice: 1, tick: 0 };
    // written E (in the clarinet's E major: no accidental needed) sounds D
    const e = letterPitch(p, doc, caret, 2, { step: 2, alter: 0, octave: 5 });
    expect(e.pitch.p).toBe(74);
  });

  it('ties on, staccatos, and lets a dynamic move only notes the dynamics shaped', () => {
    const p = flute();
    const id = p.tracks[0]?.id as string;
    let doc = notate(p);
    const caret: Caret = { track: id, staff: 1, voice: 1, tick: 0 };
    const first = enter(p, doc, caret, [{ p: 74 }], q / 2);
    let next = applyOps(p, first.ops);
    doc = notate(next);
    const tied = extend(next, doc, { ...caret, tick: q / 2 }, first.notes, q / 2);
    next = applyOps(next, tied.ops);
    expect(last(next)).toBe('  P1: d5:q e5:q f5:q g5:q');
    const d5 = next.tracks[0]?.regions[0]?.notes.find((n) => n.p === 74);
    if (!d5) throw new Error('no d5');
    next = applyOps(next, toggleArticulation(next, notate(next), [d5], 'stacc').ops);
    const st = next.tracks[0]?.regions[0]?.notes.find((n) => n.p === 74);
    expect(st?.d).toBe(q / 2);
    expect(st?.n?.w).toEqual([q, q / 2]);
    // shape one note by hand, then mark the bar forte: only the other notes get louder
    const g5 = next.tracks[0]?.regions[0]?.notes.find((n) => n.p === 79);
    if (!g5) throw new Error('no g5');
    next = applyOps(next, [
      {
        op: 'setNotes',
        track: id,
        region: next.tracks[0]?.regions[0]?.id as string,
        notes: (next.tracks[0]?.regions[0]?.notes ?? []).map((n) => (n === g5 ? { ...n, v: 30 } : n)),
      },
    ]);
    next = applyOps(next, addMark(next, notate(next), id, 1, { t: 0, k: 'dyn', v: 'f' }).ops);
    const vs = next.tracks[0]?.regions[0]?.notes.map((n) => [n.p, n.v]);
    expect(vs).toContainEqual([74, 94]);
    expect(vs).toContainEqual([79, 30]);
  });

  it('respells a note', () => {
    const p = flute('F#5:8');
    const doc = notate(p);
    const n = p.tracks[0]?.regions[0]?.notes[0];
    if (!n) throw new Error('no note');
    const next = applyOps(p, respell(p, doc, [n]).ops);
    expect(last(next)).toBe('  P1: gb5:w');
  });

  it('writes played-in music as the score shows it', () => {
    const p = flute();
    const r = p.tracks[0]?.regions[0];
    if (r) r.notes = [0, 470, 980, 1450].map((t, i) => ({ t, d: 400, p: 74 + i, v: 80 }));
    const id = p.tracks[0]?.id as string;
    const next = applyOps(p, quantizeToScore(p, notate(p), id).ops);
    expect(next.tracks[0]?.regions[0]?.notes.map((n) => n.t)).toEqual([0, 480, 960, 1440]);
    expect(last(next)).toBe(last(p));
  });
});

describe('places on a staff', () => {
  it('reads lines and spaces under each clef', () => {
    const name = (s: { step: number; octave: number }) => `${'CDEFGAB'[s.step]}${s.octave}`;
    expect(name(staffPlace('G', 0))).toBe('F5');
    expect(name(staffPlace('G', 8))).toBe('E4');
    expect(name(staffPlace('G', 10))).toBe('C4');
    expect(name(staffPlace('F', 0))).toBe('A3');
    expect(name(staffPlace('F', 8))).toBe('G2');
    expect(name(staffPlace('C3', 4))).toBe('C4');
    expect(name(staffPlace('C4', 2))).toBe('C4');
  });
  it('writes and reads a clef change', () => {
    const p = flute('D5:8 | D5:8');
    const r = p.tracks[0]?.regions[0];
    if (r) r.length = 8 * q;
    const result = writeScoreText(p, 'bar 2\n  clef P1 s1 F\n  P1: d3:w');
    expect(result.errors).toEqual([]);
    const shown = scoreText(notate(applyOps(p, result.ops))).split('\n');
    expect(shown).toContain('  clef P1 s1 F');
    expect(shown.at(-1)).toBe('  P1: d3:w');
  });

  it('puts repeat signs, endings and jumps in a bar, and takes them away', () => {
    const p = newProject('Form');
    const bar = PPQ * 4;
    let q = applyOps(p, setForm(p, bar, 2 * bar, 'start'));
    q = applyOps(q, setForm(q, 2 * bar, 3 * bar, 'ending1'));
    q = applyOps(q, setForm(q, 3 * bar, 4 * bar, 'ending2'));
    q = applyOps(q, setForm(q, 3 * bar, 4 * bar, 'dcFine'));
    expect(q.form).toEqual([
      { tick: bar, k: 'start' },
      { tick: 2 * bar, k: 'ending', e: 3 * bar, passes: [1] },
      { tick: 3 * bar, k: 'end' },
      { tick: 3 * bar, k: 'ending', e: 4 * bar, passes: [2] },
      { tick: 4 * bar, k: 'dc', al: 'fine' },
    ]);
    // a D.S. where the D.C. was replaces it
    q = applyOps(q, setForm(q, 3 * bar, 4 * bar, 'dsCoda'));
    expect(q.form?.filter((f) => f.tick === 4 * bar)).toEqual([{ tick: 4 * bar, k: 'ds', al: 'coda' }]);
    // the bar's own signs go; its neighbors' stay
    q = applyOps(q, setForm(q, 2 * bar, 3 * bar, null));
    expect(q.form?.map((f) => [f.tick / bar, f.k])).toEqual([
      [1, 'start'],
      [3, 'ending'],
      [4, 'ds'],
    ]);
  });
});
