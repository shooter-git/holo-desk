import { describe, expect, it } from 'vitest';
import {
  applyOps,
  barToTick,
  describeProject,
  keyShort,
  keysOf,
  keyText,
  nameOnFifths,
  newProject,
  newRegion,
  PPQ,
  type Project,
  parseKey,
  parseNotation,
  parsePosition,
  parseProject,
  projectFromMidi,
  readMidi,
  tickToBarBeat,
  writeMidi,
} from '../src/index.ts';

const BAR = PPQ * 4;

/** A song with every score field set, as the score and the AI write them. */
function scored(): Project {
  const p = newProject('Scored');
  const track = p.tracks[0];
  if (!track) throw new Error('no track');
  const region = newRegion(0, BAR * 2);
  region.notes = [
    { t: 0, d: 480, p: 70, v: 80, n: { sp: [6, -1, 70], w: [960, 480], a: ['stacc', 'acc'], ly: ['Hal-', 'Sing'] } },
    { t: 960, d: 960, p: 62, v: 72, n: { vo: 2, st: 2, dv: 72, tb: [3, 62], tu: [3, 2], hd: 'x', stem: 'down' } },
    { t: 1920, d: 240, p: 64, v: 60, n: { g: 'a', fi: '3' } },
  ];
  region.marks = [
    { t: 0, k: 'dyn', v: 'mf' },
    { t: 0, k: 'slur', e: 1920, st: 1, vo: 1 },
    { t: 960, k: 'cresc', e: 3840 },
    { t: 3840, k: 'oct', e: 5760, v: 8 },
  ];
  track.regions = [region];
  track.score = {
    abbr: 'Pno.',
    staves: 2,
    split: 60,
    clefs: [
      [0, 1, 'G'],
      [0, 2, 'F'],
    ],
    tr: [2, 1],
    drums: { '36': [-3, 'normal'], '42': [5, 'x'] },
    tab: { tuning: [64, 59, 55, 50, 45, 40], capo: 2 },
    grid: 240,
    hidden: true,
  };
  p.meter = [{ tick: 0, num: 4, den: 4, pickup: PPQ }];
  p.tempo = [
    { tick: 0, bpm: 96, text: 'Andante', mm: true },
    { tick: BAR * 4, bpm: 96, text: 'rit.', ramp: BAR * 5, to: 72 },
    { tick: BAR * 4 + 960, bpm: 90, gen: true },
  ];
  p.key = 'D minor';
  p.keys = [
    { tick: 0, fifths: -1, mode: 'minor' },
    { tick: BAR * 8, fifths: 2, mode: 'major' },
  ];
  p.form = [
    { tick: BAR, k: 'start' },
    { tick: BAR * 3, k: 'end', times: 3 },
    { tick: BAR * 3, k: 'ending', e: BAR * 4, passes: [1, 2] },
    { tick: BAR * 6, k: 'ds', al: 'coda' },
  ];
  p.score = {
    composer: 'Someone',
    groups: [[track.id, track.id, 'brace']],
    breaks: [[BAR * 4, 'system']],
    page: { size: 'a4', staff: 7 },
    concert: true,
  };
  return p;
}

describe('the score in the session', () => {
  it('keeps every score field through a save and a load', () => {
    const p = scored();
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it('leaves out hints that make no sense, keeping the note', () => {
    const p = scored();
    const raw = JSON.parse(JSON.stringify(p));
    raw.tracks[0].regions[0].notes[0].n = { sp: [9, 0, 70], vo: 7, a: ['stacc', 3, 'no spaces'], g: 'x', ly: [5] };
    raw.tracks[0].regions[0].marks.push({ t: 0, k: 'sparkle' }, { t: 10, k: 'slur', e: 5 });
    raw.tracks[0].score.clefs.push([0, 1, 'Z']);
    raw.keys.push({ tick: 10, fifths: 9, mode: 'major' });
    raw.form.push({ tick: 0, k: 'ending' }, { tick: 0, k: 'jump' });
    raw.meter[0].pickup = BAR * 2;
    const back = parseProject(raw);
    const n = back.tracks[0]?.regions[0]?.notes[0];
    expect(n?.n).toEqual({ a: ['stacc'] });
    expect(back.tracks[0]?.regions[0]?.marks).toHaveLength(5);
    expect(back.tracks[0]?.regions[0]?.marks?.at(-1)).toEqual({ t: 3840, k: 'oct', e: 5760, v: 8 });
    expect(back.tracks[0]?.regions[0]?.marks?.some((m) => m.t === 10 && m.e === undefined)).toBe(true);
    expect(back.tracks[0]?.score?.clefs).toHaveLength(2);
    expect(back.keys).toHaveLength(2);
    expect(back.form).toHaveLength(4);
    expect(back.meter[0]?.pickup).toBeUndefined();
  });

  it('adds nothing to a song that has no score', () => {
    const p = newProject('Plain');
    const back = parseProject(JSON.parse(JSON.stringify(p)));
    expect(back).toEqual(p);
    expect('keys' in back || 'form' in back || 'score' in back).toBe(false);
  });
});

describe('key signatures', () => {
  it('reads keys from text', () => {
    expect(parseKey('D minor')).toEqual({ fifths: -1, mode: 'minor' });
    expect(parseKey('Bb major')).toEqual({ fifths: -2, mode: 'major' });
    expect(parseKey('F#')).toEqual({ fifths: 6, mode: 'major' });
    expect(parseKey('Am')).toEqual({ fifths: 0, mode: 'minor' });
    expect(parseKey('A lydian')).toEqual({ fifths: 4, mode: 'lydian' });
    expect(parseKey('E harmonic minor')).toEqual({ fifths: 1, mode: 'minor' });
    expect(parseKey('G# major')).toEqual({ fifths: -4, mode: 'major' });
    expect(parseKey('no key')).toBeNull();
    expect(parseKey(null)).toBeNull();
  });

  it('names keys and notes on the line of fifths', () => {
    expect(keyText({ fifths: -1, mode: 'minor' })).toBe('D minor');
    expect(keyText({ fifths: -3, mode: 'major' })).toBe('Eb major');
    expect(keyText({ fifths: 4, mode: 'lydian' })).toBe('A lydian');
    expect([0, -2, 6, 13, -9].map(nameOnFifths)).toEqual(['C', 'Bb', 'F#', 'F##', 'Bbb']);
  });

  it('writes keys short, as a chord chart does', () => {
    expect(['D major', 'F# minor', 'Bb', 'Am', 'A lydian', 'E harmonic minor', 'G# major'].map(keyShort)).toEqual([
      'D',
      'F#m',
      'Bb',
      'Am',
      'A lyd',
      'Em',
      'G#',
    ]);
    expect(keyShort('no key')).toBe('no key');
  });

  it('keeps the key text and the key signatures the same', () => {
    let p = scored();
    p = applyOps(p, [{ op: 'setProject', patch: { key: 'E major' } }]);
    expect(p.keys).toEqual([
      { tick: 0, fifths: 4, mode: 'major' },
      { tick: BAR * 8, fifths: 2, mode: 'major' },
    ]);
    p = applyOps(p, [{ op: 'setProject', patch: { keys: [{ tick: 0, fifths: -3, mode: 'minor' }] } }]);
    expect(p.key).toBe('C minor');
    p = applyOps(p, [{ op: 'setProject', patch: { key: null } }]);
    expect(p.keys).toBeUndefined();
    expect(keysOf(p)).toEqual([]);
    // a song that never had key points keeps only its text, and the score reads the key from it
    const plain = applyOps(newProject('Plain'), [{ op: 'setProject', patch: { key: 'A minor' } }]);
    expect(plain.keys).toBeUndefined();
    expect(keysOf(plain)).toEqual([{ tick: 0, fifths: 0, mode: 'minor' }]);
  });

  it('lets the key points win over a text that disagrees, keeping a text that agrees', () => {
    const raw = JSON.parse(JSON.stringify(scored()));
    raw.key = 'D harmonic minor';
    expect(parseProject(raw).key).toBe('D harmonic minor');
    raw.key = 'G major';
    expect(parseProject(raw).key).toBe('D minor');
  });
});

describe('writing part of a region', () => {
  it('replaces only the notes and marks in the range', () => {
    const p = scored();
    const track = p.tracks[0];
    const region = track?.regions[0];
    if (!track || !region) throw new Error('no region');
    const next = applyOps(p, [
      {
        op: 'setNotesIn',
        track: track.id,
        region: region.id,
        from: 960,
        to: 1920,
        notes: [{ t: 1200, d: 120, p: 67, v: 90 }],
      },
      { op: 'setMarksIn', track: track.id, region: region.id, from: 900, to: 3840, marks: [] },
    ]);
    const r = next.tracks[0]?.regions[0];
    expect(r?.notes.map((n) => n.t)).toEqual([0, 1200, 1920]);
    expect(r?.notes[0]).toBe(region.notes[0]);
    expect(r?.marks?.map((m) => m.k)).toEqual(['dyn', 'slur', 'oct']);
    const cleared = applyOps(next, [
      { op: 'setMarksIn', track: track.id, region: region.id, from: 0, to: BAR * 8, marks: [] },
    ]);
    expect(cleared.tracks[0]?.regions[0]?.marks).toBeUndefined();
  });

  it('sets and removes the form and the score settings', () => {
    let p = scored();
    p = applyOps(p, [{ op: 'setProject', patch: { form: null, score: null } }]);
    expect(p.form).toBeUndefined();
    expect(p.score).toBeUndefined();
    p = applyOps(p, [
      {
        op: 'setProject',
        patch: {
          form: [
            { tick: BAR * 2, k: 'end' },
            { tick: 0, k: 'start' },
          ],
        },
      },
    ]);
    expect(p.form?.map((f) => f.k)).toEqual(['start', 'end']);
    expect(describeProject(p)).toContain('form: repeat start at 0 1 1; repeat end at 2 1 1');
  });
});

describe('a pickup', () => {
  const meter = [{ tick: 0, num: 4, den: 4, pickup: PPQ }];
  it('numbers its bar 0 and the first full bar 1', () => {
    expect(barToTick(meter, 0)).toBe(0);
    expect(barToTick(meter, 1)).toBe(BAR);
    expect(tickToBarBeat(meter, BAR - PPQ)).toEqual({ bar: 0, beat: 4, div: 1, tick: 0 });
    expect(tickToBarBeat(meter, BAR)).toEqual({ bar: 1, beat: 1, div: 1, tick: 0 });
    expect(parsePosition(meter, '2.3')).toBe(BAR * 2 + PPQ * 2);
  });
  it('is described', () => {
    const p = { ...newProject('Up'), meter };
    expect(describeProject(p)).toContain('starts with a pickup of 1 beat(s): bar 0');
  });
});

describe('spelling in the text notation', () => {
  it('keeps sharps and flats as written', () => {
    const notes = parseNotation('Bb4:1 A#4:1 C4:1 E#4:1 (Db5 F5):1', { unit: PPQ });
    expect(notes.map((n) => n.n?.sp ?? null)).toEqual([[6, -1, 70], [5, 1, 70], null, [2, 1, 65], [1, -1, 73], null]);
  });
});

describe('MIDI files and the score', () => {
  it('keep key changes and lyrics', () => {
    const p = newProject('Song');
    const t = p.tracks[0];
    if (!t) throw new Error('no track');
    const r = newRegion(0, BAR * 2);
    r.notes = [
      { t: 0, d: PPQ, p: 62, v: 80, n: { ly: ['Hal-'] } },
      { t: PPQ, d: PPQ, p: 64, v: 80, n: { ly: ['le'] } },
    ];
    t.regions = [r];
    p.keys = [
      { tick: 0, fifths: -1, mode: 'minor' },
      { tick: BAR, fifths: 2, mode: 'major' },
    ];
    p.key = 'D minor';
    const back = projectFromMidi(readMidi(writeMidi(p)), 'Song');
    expect(back.keys).toEqual(p.keys);
    expect(back.key).toBe('D minor');
    expect(back.tracks[0]?.regions[0]?.notes.map((n) => n.n?.ly?.[0])).toEqual(['Hal-', 'le']);
  });
});
