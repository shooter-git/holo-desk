import { describe, expect, it } from 'vitest';
import {
  applyOps,
  type FormMark,
  type Note,
  newProject,
  newRegion,
  PPQ,
  type Project,
  performed,
  playedAt,
  playMap,
  realize,
  unrollOps,
  writtenAt,
  writtenSpans,
} from '../src/index.ts';

const B = PPQ * 4;
const INF = Number.POSITIVE_INFINITY;

const formed = (form: FormMark[], pickup?: number) =>
  playMap({ form, meter: [{ tick: 0, num: 4, den: 4, ...(pickup ? { pickup } : {}) }] });

/** A song of `bars` bars, a quarter note on each beat (pitch 60 + the bar's number). */
function song(bars: number, form?: FormMark[]): Project {
  const p = newProject('Form');
  const t = p.tracks[0];
  if (!t) throw new Error('no track');
  const r = newRegion(0, bars * B);
  for (let bar = 0; bar < bars; bar++)
    for (let beat = 0; beat < 4; beat++) r.notes.push({ t: bar * B + beat * PPQ, d: PPQ, p: 60 + bar, v: 90 });
  t.regions = [r];
  if (form) p.form = form;
  return p;
}

/** The pitches a performed song plays, bar by bar (the bar's first note's pitch, as it is 60 + its bar). */
const barsPlayed = (p: Project) =>
  (performed(p).tracks[0]?.regions ?? [])
    .flatMap((r) => r.notes.map((n) => ({ t: r.start + n.t, p: n.p })))
    .sort((a, b) => a.t - b.t)
    .filter((n) => n.t % B === 0)
    .map((n) => n.p - 60);

describe('the walk through the form', () => {
  it('plays a song with no form straight through', () => {
    expect(formed([])).toBe(null);
    const p = song(2);
    expect(performed(p)).toBe(p);
  });

  it('repeats, back to the top', () => {
    expect(formed([{ tick: 2 * B, k: 'end' }])).toEqual([
      { from: 0, to: 2 * B, at: 0, n: 1 },
      { from: 0, to: INF, at: 2 * B, n: 2 },
    ]);
    expect(barsPlayed(song(3, [{ tick: 2 * B, k: 'end' }]))).toEqual([0, 1, 0, 1, 2]);
  });

  it('plays a passage three times when asked', () => {
    const form: FormMark[] = [
      { tick: B, k: 'start' },
      { tick: 2 * B, k: 'end', times: 3 },
    ];
    expect(barsPlayed(song(3, form))).toEqual([0, 1, 1, 1, 2]);
  });

  it('takes the first ending, then the second', () => {
    const form: FormMark[] = [
      { tick: B, k: 'start' },
      { tick: 3 * B, k: 'ending', e: 4 * B, passes: [1] },
      { tick: 4 * B, k: 'end' },
      { tick: 4 * B, k: 'ending', e: 5 * B, passes: [2] },
    ];
    expect(formed(form)).toEqual([
      { from: 0, to: 4 * B, at: 0, n: 1 },
      { from: B, to: 3 * B, at: 4 * B, n: 2 },
      { from: 4 * B, to: INF, at: 6 * B, n: 1 },
    ]);
    expect(barsPlayed(song(6, form))).toEqual([0, 1, 2, 3, 1, 2, 4, 5]);
  });

  it('goes da capo al Fine', () => {
    const form: FormMark[] = [
      { tick: 2 * B, k: 'fine' },
      { tick: 4 * B, k: 'dc', al: 'fine' },
    ];
    expect(barsPlayed(song(5, form))).toEqual([0, 1, 2, 3, 0, 1]);
  });

  it('goes dal segno al Coda', () => {
    const form: FormMark[] = [
      { tick: B, k: 'segno' },
      { tick: 3 * B, k: 'toCoda' },
      { tick: 4 * B, k: 'ds', al: 'coda' },
      { tick: 5 * B, k: 'coda' },
    ];
    expect(barsPlayed(song(6, form))).toEqual([0, 1, 2, 3, 1, 2, 5]);
  });

  it('skips repeats after a jump, unless it says to take them, and then takes the last ending', () => {
    const form: FormMark[] = [
      { tick: 2 * B, k: 'ending', e: 3 * B, passes: [1] },
      { tick: 3 * B, k: 'end' },
      { tick: 3 * B, k: 'ending', e: 4 * B, passes: [2] },
      { tick: 4 * B, k: 'dc' },
    ];
    expect(barsPlayed(song(4, form))).toEqual([0, 1, 2, 0, 1, 3, 0, 1, 3]);
    form[3] = { tick: 4 * B, k: 'dc', repeats: true };
    expect(barsPlayed(song(4, form))).toEqual([0, 1, 2, 0, 1, 3, 0, 1, 2, 0, 1, 3]);
  });

  it('goes back to the pickup, and keeps the bars’ beat', () => {
    const map = formed([{ tick: 3 * B - PPQ, k: 'end' }], PPQ);
    expect(map).toEqual([
      { from: 0, to: 3 * B - PPQ, at: 0, n: 1 },
      { from: 3 * PPQ, to: INF, at: 3 * B - PPQ, n: 2 },
    ]);
    const p = song(4, [{ tick: 3 * B - PPQ, k: 'end' }]);
    p.meter = [{ tick: 0, num: 4, den: 4, pickup: PPQ }];
    expect(performed(p).meter).toEqual([{ tick: 0, num: 4, den: 4, pickup: PPQ }]);
  });

  it('stops a song that would never end', () => {
    const map = formed([{ tick: B, k: 'end', times: 100000 }]);
    expect(map?.length).toBeLessThan(500);
  });
});

describe('the playhead', () => {
  const map = formed([{ tick: 2 * B, k: 'end' }]);
  it('says where it is in the music, and which time through', () => {
    expect(writtenAt(map, 100)).toEqual({ tick: 100, n: 1 });
    expect(writtenAt(map, 2 * B + 100)).toEqual({ tick: 100, n: 2 });
    expect(writtenAt(map, 4 * B + 100)).toEqual({ tick: 2 * B + 100, n: 2 });
  });
  it('goes to a bar the first time it plays, or the next time after a place', () => {
    expect(playedAt(map, 100)).toBe(100);
    expect(playedAt(map, 100, B)).toBe(2 * B + 100);
    expect(playedAt(map, 2 * B + 100)).toBe(4 * B + 100);
  });
  it('puts a take recorded through a repeat back where each pass was played', () => {
    // played from the middle of bar 2 to the middle of the second time through bar 1
    expect(writtenSpans(map, 1.5 * B, 2.5 * B)).toEqual([
      { from: 1.5 * B, to: 2 * B, at: 1.5 * B, n: 1 },
      { from: 0, to: 0.5 * B, at: 2 * B, n: 2 },
    ]);
    expect(writtenSpans(null, 10, 20)).toEqual([{ from: 10, to: 20, at: 10, n: 1 }]);
  });
  it('takes music after a Fine to where the song ends', () => {
    const fine = formed([
      { tick: B, k: 'fine' },
      { tick: 2 * B, k: 'dc', al: 'fine' },
    ]);
    expect(playedAt(fine, 2 * B + 10)).toBe(3 * B);
  });
});

describe('the song as heard', () => {
  it('keeps what an edit didn’t touch the same, so an engine has nothing to do again', () => {
    const p = song(3, [{ tick: 2 * B, k: 'end' }]);
    const a = performed(p);
    expect(performed(p)).toBe(a);
    const louder: Project = { ...p, master: { ...p.master, volume: -3 } };
    const b = performed(louder);
    expect(b.tracks).toBe(a.tracks);
    expect(b.tempo).toBe(a.tempo);
    expect(b.master).toBe(louder.master);
  });

  it('cuts controllers, automation and tempo by the passes, each from where it was', () => {
    const p = song(3, [
      { tick: B, k: 'start' },
      { tick: 2 * B, k: 'end' },
    ]);
    const r = p.tracks[0]?.regions[0];
    if (!r) throw new Error('no region');
    r.cc = {
      '64': [
        [B / 2, 127],
        [B + B / 2, 0],
      ],
    };
    p.tempo = [
      { tick: 0, bpm: 100 },
      { tick: B + B / 2, bpm: 80 },
    ];
    p.master.automation = [
      {
        param: 'volume',
        points: [
          [0, 0],
          [2 * B, -10],
        ],
        mode: 'read',
      },
    ];
    const heard = performed(p);
    const regions = heard.tracks[0]?.regions ?? [];
    expect(regions.map((x) => [x.start, x.length])).toEqual([
      [0, 2 * B],
      [2 * B, 2 * B],
    ]);
    // the second time through bar 2 starts with the pedal down, as it was at bar 2
    expect(regions[1]?.cc['64']).toEqual([
      [0, 127],
      [B / 2, 0],
    ]);
    expect(heard.tempo).toEqual([
      { tick: 0, bpm: 100 },
      { tick: B + B / 2, bpm: 80 },
      { tick: 2 * B, bpm: 100 },
      { tick: 2 * B + B / 2, bpm: 80 },
    ]);
    expect(heard.master.automation?.[0]?.points).toEqual([
      [0, 0],
      [2 * B, -10],
      [2 * B, -5],
      [3 * B, -10],
    ]);
  });

  it('plays ornaments as notes', () => {
    const trill: Note = { t: 0, d: 2 * PPQ, p: 64, v: 90, n: { a: ['tr'] } };
    const notes = realize([trill], { start: 0, tempo: [{ tick: 0, bpm: 120 }], keys: [] });
    expect(new Set(notes.map((n) => n.p))).toEqual(new Set([64, 65]));
    expect(notes[0]?.p).toBe(64);
    expect(notes[notes.length - 1]?.p).toBe(64);
    expect(notes.reduce((s, n) => s + n.d, 0)).toBe(2 * PPQ);
    const mordent: Note = { t: 0, d: PPQ, p: 62, v: 90, n: { a: ['mord'] } };
    expect(realize([mordent], { start: 0, tempo: [{ tick: 0, bpm: 120 }], keys: [] }).map((n) => n.p)).toEqual([
      62, 60, 62,
    ]);
    // in D major the note above F♯ is G, and below C♯… is B
    const keys = [{ tick: 0, fifths: 2, mode: 'major' as const }];
    const turn: Note = { t: 0, d: PPQ, p: 66, v: 90, n: { a: ['turn'] } };
    expect(realize([turn], { start: 0, tempo: [{ tick: 0, bpm: 120 }], keys }).map((n) => n.p)).toEqual([
      67, 66, 64, 66,
    ]);
    const chord: Note[] = [60, 64, 67].map((p) => ({ t: 0, d: PPQ, p, v: 90, n: { a: ['arp'] } }));
    const rolled = realize(chord, { start: 0, tempo: [{ tick: 0, bpm: 120 }], keys: [] });
    expect(rolled.map((n) => n.t)).toEqual([0, 67, 134]);
    expect(rolled.every((n) => n.t + n.d === PPQ)).toBe(true);
  });
});

describe('unrolling the repeats', () => {
  it('writes every pass out, with its markers and chords, and no repeat signs', () => {
    const p = song(3, [
      { tick: B, k: 'start' },
      { tick: 2 * B, k: 'end' },
    ]);
    p.markers = [{ id: 'mrk1', tick: B, name: 'Verse' }];
    p.chords = [{ tick: B, symbol: 'F' }];
    const r = p.tracks[0]?.regions[0];
    if (r) r.marks = [{ t: B, k: 'dyn', v: 'p' }];
    const out = applyOps(p, unrollOps(p));
    expect(out.form).toBeUndefined();
    expect(barsPlayed(out)).toEqual([0, 1, 1, 2]);
    expect(out.markers.map((m) => [m.tick, m.name])).toEqual([
      [B, 'Verse'],
      [2 * B, 'Verse'],
    ]);
    expect(out.chords).toEqual([
      { tick: B, symbol: 'F' },
      { tick: 2 * B, symbol: 'F' },
    ]);
    expect(out.tracks[0]?.regions.flatMap((x) => (x.marks ?? []).map((m) => x.start + m.t))).toEqual([B, 2 * B]);
  });
});
