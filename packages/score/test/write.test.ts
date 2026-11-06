import { applyOps, type Note, newProject, newRegion, newTrack, PPQ, type Project, parseNotation } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { bakeTempo, checkScore, levelAt, notate, scoreText, writeScoreText } from '../src/index.ts';

const q = PPQ;

/** A song with a flute and a piano, a few bars long. */
function song(): Project {
  const p = newProject('Write');
  const flute = p.tracks[0];
  if (!flute) throw new Error('no track');
  flute.name = 'Flute';
  const piano = newTrack('Piano', { type: 'synth', preset: 'Soft Keys' });
  p.tracks.push(piano);
  const r = newRegion(0, q * 12);
  r.notes = [
    ...parseNotation('D5:3 E5:1 F5:2 A5:2 | G5:4 F5:2 E5:2 | D5:8', { unit: q / 2 }),
    // a triplet in bar 3's last beat replaces nothing: bar 3 is a whole note; add a tie across bars 2–3
  ];
  r.marks = [
    { t: 0, k: 'dyn', v: 'mp' },
    { t: 0, k: 'slur', e: 3.5 * q },
    { t: 4 * q, k: 'cresc', e: 8 * q },
    { t: 8 * q, k: 'dyn', v: 'f' },
  ];
  flute.regions = [r];
  const pr = newRegion(0, q * 12);
  pr.notes = [
    ...parseNotation('(F4 A4):4 (E4 G4):4 (D4 F4 A4):4', { unit: q }),
    ...parseNotation('D3:4 C3:4 D3:4', { unit: q }),
  ];
  piano.regions = [pr];
  p.key = 'D minor';
  p.chords = [
    { tick: 0, symbol: 'Dm' },
    { tick: 4 * q, symbol: 'C' },
  ];
  return p;
}

/** The same song with its notes and marks taken away. */
function emptied(p: Project): Project {
  return {
    ...p,
    chords: [],
    tracks: p.tracks.map((t) => ({ ...t, regions: t.regions.map((r) => ({ ...r, notes: [], marks: [] })) })),
  };
}

const show = (p: Project) => scoreText(notate(p));

describe('writing a score as text', () => {
  it('reads back what it shows', () => {
    const p = song();
    const text = show(p);
    const result = writeScoreText(emptied(p), text);
    expect(result.errors).toEqual([]);
    expect(result.written).toEqual([1, 2, 3]);
    expect(show(applyOps(emptied(p), result.ops))).toBe(text);
  });

  it('writes notes, spelled and sounding as the dynamics and articulations say', () => {
    const p = song();
    const result = writeScoreText(p, 'bar 1\n  P1: p bb4:q+stacc c5:q f c5:q+acc r:q');
    expect(result.errors).toEqual([]);
    const next = applyOps(p, result.ops);
    const notes = next.tracks[0]?.regions[0]?.notes.filter((n) => n.t < 4 * q) as Note[];
    expect(notes.map((n) => [n.t, n.d, n.p])).toEqual([
      [0, 480, 70],
      [q, 883, 72],
      [2 * q, 883, 72],
    ]);
    expect(notes[0]?.n).toMatchObject({ sp: [6, -1, 70], a: ['stacc'], w: [960, 480] });
    expect(notes[0]?.v).toBe(48);
    expect(notes[2]?.v).toBe(108);
    // the piano's bar 1 is untouched
    expect(
      show(next)
        .split('\n')
        .filter((l) => l.startsWith('  P2'))[0],
    ).toBe('  P2 s1: [f4 a4]:w');
  });

  it('refuses a bar that does not add up, and writes the others', () => {
    const p = song();
    const result = writeScoreText(p, 'bar 1\n  P1: d5:h\nbar 2\n  P1: e5:w');
    expect(result.written).toEqual([2]);
    expect(result.errors).toEqual(['bar 1 P1: its notes and rests add up to 2 quarter beats, the bar has 4']);
  });

  it('writes one staff of a grand staff, keeping the other', () => {
    const p = song();
    const next = applyOps(p, writeScoreText(p, 'bar 2\n  P2 s2: c3:h c3:h').ops);
    const lines = show(next).split('\n');
    const bar2 = lines.slice(lines.indexOf('bar 2'), lines.indexOf('bar 3'));
    expect(bar2).toContain('  P2 s1: [e4 g4]:w');
    expect(bar2).toContain('  P2 s2: c3:h c3:h');
  });

  it('writes a transposing part as it reads', () => {
    const p = song();
    const clarinet = newTrack('Clarinet in Bb', { type: 'synth', preset: 'Soft Keys' });
    clarinet.regions = [newRegion(0, 4 * q)];
    p.tracks.push(clarinet);
    const next = applyOps(p, writeScoreText(p, 'bar 1\n  P3: g4:w').ops);
    expect(next.tracks[2]?.regions[0]?.notes[0]?.p).toBe(65);
  });

  it('writes ties, triplets, lyrics and hairpins across bars', () => {
    const p = emptied(song());
    const text = [
      'bar 1',
      '  P1: < d5:h 3:2{e5:e f5:e g5:e} a5:q~',
      '  lyrics P1 1: Hal- le- lu- jah *',
      'bar 2',
      '  P1: a5:h ! r:h',
    ].join('\n');
    const result = writeScoreText(p, text);
    expect(result.errors).toEqual([]);
    const next = applyOps(p, result.ops);
    const r = next.tracks[0]?.regions[0];
    const long = r?.notes.find((n) => n.p === 81);
    expect(long?.n?.w?.[0] ?? long?.d).toBe(3 * q);
    expect(r?.notes.find((n) => n.p === 76)?.n?.ly).toEqual(['le-']);
    expect(r?.marks).toEqual([{ t: 0, k: 'cresc', e: 6 * q }]);
    const shown = show(next).split('\n');
    expect(shown).toContain('  P1: < d5:h 3:2{e5:e f5:e g5:e} a5:q~');
    expect(shown).toContain('  P1: a5:h ! r:h');
  });

  it('adds the time, key, tempo and repeats a header names', () => {
    const p = song();
    const result = writeScoreText(
      p,
      'bar 2  time 3/4  key A major  tempo 100 "Allegro"  |:\n  P1: e5:h.\n  P2 s1: R\n  P2 s2: R',
    );
    expect(result.errors).toEqual([]);
    const next = applyOps(p, result.ops);
    expect(next.meter).toEqual([
      { tick: 0, num: 4, den: 4 },
      { tick: 4 * q, num: 3, den: 4 },
    ]);
    expect(next.keys?.[1]).toEqual({ tick: 4 * q, fifths: 3, mode: 'major' });
    expect(next.tempo.at(-1)).toEqual({ tick: 4 * q, bpm: 100, text: 'Allegro', mm: true });
    expect(next.form).toEqual([{ tick: 4 * q, k: 'start' }]);
  });

  it('writes past the end of the song, in a new region', () => {
    const p = song();
    const next = applyOps(p, writeScoreText(p, 'bar 5\n  P1: c5:w').ops);
    const r = next.tracks[0]?.regions.find((x) => x.start === 16 * q);
    expect(r?.notes.map((n) => n.p)).toEqual([72]);
  });
});

describe('the sound of the markings', () => {
  it('follows dynamics and hairpins', () => {
    const marks = [
      { t: 0, k: 'dyn' as const, v: 'p' },
      { t: 960, k: 'cresc' as const, e: 2880 },
      { t: 2880, k: 'dyn' as const, v: 'f' },
    ];
    expect(levelAt(marks, 0)).toBe(48);
    expect(levelAt(marks, 1920)).toBe(71);
    expect(levelAt(marks, 2880)).toBe(94);
  });
  it('makes tempo steps for a rit. and a fermata', () => {
    const p = song();
    p.tempo = [
      { tick: 0, bpm: 120 },
      { tick: 4 * q, bpm: 120, text: 'rit.' },
      { tick: 8 * q, bpm: 90, text: 'a tempo' },
    ];
    const f = p.tracks[0]?.regions[0]?.notes.at(-1);
    if (f) f.n = { a: ['ferm'] };
    const tempo = bakeTempo(p);
    expect(tempo.filter((t) => t.gen).length).toBeGreaterThan(3);
    expect(tempo.find((t) => t.tick === 5 * q)?.bpm).toBeLessThan(120);
    expect(tempo.find((t) => t.tick === 8 * q)?.bpm).toBe(45);
  });
});

describe('checks', () => {
  it('finds notes out of range', () => {
    const p = song();
    const r = p.tracks[0]?.regions[0];
    r?.notes.push({ t: 0, d: q, p: 40, v: 80 });
    expect(checkScore(notate(p)).map((f) => f.text)).toContain("E2 is below the flute's range (C4–C7)");
  });
});
