import { type Instrument, type Note, newProject, newRegion, PPQ, type Project, parseNotation } from '@holo/session';
import { VerovioToolkit } from 'verovio/esm';
import createVerovioModule from 'verovio/wasm';
import { describe, expect, it } from 'vitest';
import {
  BarAccidentals,
  beatGrid,
  beatsOf,
  keyAlters,
  notate,
  scoreText,
  spellInKey,
  splitValues,
  strength,
  toMEI,
  transposeSpelling,
  tupletFor,
  valueFor,
} from '../src/index.ts';

const q = PPQ;
const four = beatsOf({ num: 4, den: 4 });
const three = beatsOf({ num: 3, den: 4 });
const six = beatsOf({ num: 6, den: 8 });

describe('rhythm', () => {
  it('knows written values', () => {
    expect(valueFor(q * 1.5)).toEqual({ value: 4, dots: 1 });
    expect(valueFor(q * 3.5)).toEqual({ value: 2, dots: 2 });
    expect(valueFor(q * 5)).toBeNull();
  });
  it('feels the bar', () => {
    expect(four.groups).toEqual([2 * q, 2 * q]);
    expect([0, 2 * q, q, q / 2, q / 4].map((t) => strength(four, t))).toEqual([100, 80, 60, 40, 30]);
    expect(six).toMatchObject({ beat: 1.5 * q, compound: true });
    expect(strength(six, q / 2)).toBe(40);
  });
  it('splits values so they never hide a stronger beat', () => {
    // a half on beat 2 of 4/4: two tied quarters; on beat 2 of 3/4 it stays a half
    expect(splitValues(four, q, 3 * q, false)).toEqual([
      [q, 2 * q],
      [2 * q, 3 * q],
    ]);
    expect(splitValues(three, q, 3 * q, false)).toEqual([[q, 3 * q]]);
    // a dotted half from the downbeat stays; an offbeat quarter is two tied eighths
    expect(splitValues(four, 0, 3 * q, false)).toEqual([[0, 3 * q]]);
    expect(splitValues(four, q / 2, 1.5 * q, false)).toEqual([
      [q / 2, q],
      [q, 1.5 * q],
    ]);
    // rests in simple time aren't dotted; in 6/8 they are
    expect(splitValues(four, 0, 1.5 * q, true)).toEqual([
      [0, q],
      [q, 1.5 * q],
    ]);
    expect(splitValues(six, 0, 1.5 * q, true)).toEqual([[0, 1.5 * q]]);
  });
  it('finds tuplets', () => {
    expect(tupletFor([320, 640], q, false)).toEqual({ num: 3, numbase: 2 });
    expect(tupletFor([480], q, false)).toBeNull();
    // two dotted eighths in a 6/8 beat need no bracket; four even notes are a quadruplet
    expect(tupletFor([720], 1.5 * q, true)).toBeNull();
    expect(tupletFor([360, 720, 1080], 1.5 * q, true)).toEqual({ num: 4, numbase: 6 });
    expect(tupletFor([192, 384, 576, 768], q, false)).toEqual({ num: 5, numbase: 4 });
  });
  it('picks the grid played-in music sits on', () => {
    expect(beatGrid([0, 470, 490, 960], q, false)).toBe(q / 2);
    expect(beatGrid([0, 330, 650, 960], q, false)).toBe(q / 3);
    expect(beatGrid([0, 960], q, false)).toBe(q);
  });
});

describe('spelling', () => {
  it('spells by the key, leaning with the line', () => {
    const name = (s: { step: number; alter: number }) =>
      `${'CDEFGAB'[s.step] ?? '?'}${['bb', 'b', '', '#', '##'][s.alter + 2] ?? '?'}`;
    expect(name(spellInKey(61, 0, 'major', 1))).toBe('C#');
    expect(name(spellInKey(61, 0, 'major', -1))).toBe('Db');
    expect(name(spellInKey(68, 0, 'minor'))).toBe('G#');
    expect(name(spellInKey(70, -1, 'major'))).toBe('Bb');
    expect(name(spellInKey(66, 6, 'major'))).toBe('F#');
    expect(name(spellInKey(66, -6, 'major'))).toBe('Gb');
  });
  it('shows accidentals once a bar, against the key', () => {
    const bar = new BarAccidentals(keyAlters(-1));
    expect(bar.show({ step: 6, alter: -1, octave: 4 })).toBeNull();
    expect(bar.show({ step: 6, alter: 0, octave: 4 })).toBe(0);
    expect(bar.show({ step: 6, alter: 0, octave: 4 })).toBeNull();
    expect(bar.show({ step: 6, alter: -1, octave: 4 })).toBe(-1);
  });
  it('transposes spellings', () => {
    // a B♭ clarinet: concert B♭ is written C
    expect(transposeSpelling({ step: 6, alter: -1, octave: 3 }, 2, 1)).toEqual({ step: 0, alter: 0, octave: 4 });
  });
});

function one(name: string, notes: Note[], setup?: (p: Project) => void, instrument?: Instrument): Project {
  const p = newProject(name);
  const t = p.tracks[0];
  if (!t) throw new Error('no track');
  t.name = name;
  if (instrument) t.instrument = instrument;
  const r = newRegion(0, q * 4);
  r.notes = notes;
  t.regions = [r];
  setup?.(p);
  return p;
}

const text = (p: Project) => scoreText(notate(p)).split('\n').slice(1);

describe('laying out a song', () => {
  it('writes a melody with its rhythm, slur and dynamic', () => {
    const p = one('Flute', parseNotation('D5:3 E5:1 F5:2 A5:2', { unit: q / 2 }), (p) => {
      p.key = 'D minor';
      const r = p.tracks[0]?.regions[0];
      if (r)
        r.marks = [
          { t: 0, k: 'dyn', v: 'mf' },
          { t: 0, k: 'slur', e: 3.5 * q },
        ];
    });
    expect(text(p)).toEqual([
      'parts: P1 Flute',
      'bar 1  time 4/4  key D minor',
      '  clef P1 s1 G',
      '  P1: mf ( d5:q. e5:e f5:q a5:q )',
    ]);
  });

  it('shows music played a little loose on its grid', () => {
    const loose = [0, 470, 980, 1450, 1930, 2420, 2890, 3370].map((t, i) => ({ t, d: 430, p: 60 + i * 2, v: 80 }));
    expect(text(one('Oboe', loose)).at(-1)).toBe('  P1: c4:e d4:e e4:e f#4:e g#4:e bb4:e c5:e d5:e');
  });

  it('writes a note held under a moving line as a second voice', () => {
    const notes = [
      { t: 0, d: 4 * q, p: 64, v: 70 },
      ...[0, 1, 2, 3].map((i) => ({ t: i * q, d: q, p: 72 + 2 * i, v: 80 })),
    ];
    expect(text(one('Violin', notes)).slice(-2)).toEqual(['  P1 s1 v1: c5:q d5:q e5:q f#5:q', '  P1 s1 v2: e4:w']);
  });

  it('puts a piano on a grand staff', () => {
    const notes = [...parseNotation('(C3 G3):4', { unit: q }), ...parseNotation('(E5 G5):4', { unit: q })];
    expect(text(one('Piano', notes))).toEqual([
      'parts: P1 Piano (2 staves)',
      'bar 1  time 4/4',
      '  clef P1 s1 G',
      '  P1 s1: [e5 g5]:w',
      '  clef P1 s2 F',
      '  P1 s2: [c3 g3]:w',
    ]);
  });

  it('writes triplets, and ties a syncopated half', () => {
    const notes = [
      ...[0, 320, 640].map((x, i) => ({ t: x, d: 320, p: 74 + i * 2, v: 80 })),
      { t: q, d: 2 * q, p: 81, v: 80 },
    ];
    expect(text(one('Violin', notes)).at(-1)).toBe('  P1: 3:2{d5:e e5:e f#5:e} a5:q~ a5:q r:q');
  });

  it('writes drums on a drum staff, hands up and feet down', () => {
    const drums: Note[] = [];
    for (let i = 0; i < 8; i++) drums.push({ t: i * 480, d: 60, p: 42, v: 70 });
    for (const b of [0, 2]) drums.push({ t: b * q, d: 60, p: 36, v: 100 });
    for (const b of [1, 3]) drums.push({ t: b * q, d: 60, p: 38, v: 100 });
    const doc = notate(one('Drums', drums, undefined, { type: 'synth', preset: 'Drum Synth' }));
    expect(scoreText(doc).split('\n').slice(-2)).toEqual([
      '  P1 s1 v1: g5:e g5:e [c5 g5]:e g5:e g5:e g5:e [c5 g5]:e g5:e',
      '  P1 s1 v2: f4:h f4:h',
    ]);
    const hat = doc.parts[0]?.staves[0]?.bars[0]?.voices[0]?.events[0];
    expect(hat?.kind === 'chord' && hat.heads[0]?.head).toBe('x');
  });

  it('writes a transposing instrument as it reads', () => {
    const p = one('Clarinet in Bb', parseNotation('F4:1 G4:1 A4:1 Bb4:1', { unit: q }), (p) => {
      p.key = 'F major';
    });
    expect(text(p)).toEqual([
      'parts: P1 Clarinet in Bb (written a major 2nd above sounding)',
      'bar 1  time 4/4  key F major',
      '  clef P1 s1 G',
      '  P1: g4:q a4:q b4:q c5:q',
    ]);
    expect(toMEI(notate(p))).toContain('key.sig="1s"');
  });

  it('writes a pickup as bar 0, and repeats with endings', () => {
    const p = one('Voice', parseNotation('r:3 C4:1 | F4:4 | G4:4 | A4:4', { unit: q }), (p) => {
      p.meter = [{ tick: 0, num: 4, den: 4, pickup: q }];
      p.form = [
        { tick: 4 * q, k: 'start' },
        { tick: 8 * q, k: 'ending', e: 12 * q, passes: [1] },
        { tick: 12 * q, k: 'end' },
        { tick: 12 * q, k: 'ending', e: 16 * q, passes: [2] },
      ];
      const r = p.tracks[0]?.regions[0];
      if (r) r.length = 16 * q;
    });
    expect(text(p).filter((l) => l.startsWith('bar') || l.startsWith('  P1:'))).toEqual([
      'bar 0  time 4/4  pickup',
      '  P1: c4:q',
      'bar 1  |:',
      '  P1: f4:w',
      'bar 2  ending 1  :|',
      '  P1: g4:w',
      'bar 3  ending 2',
      '  P1: a4:w',
    ]);
    const mei = toMEI(notate(p));
    expect(mei).toContain('metcon="false"');
    expect(mei).toContain('left="rptstart"');
    expect(mei).toContain('<ending n="1" label="1.">');
  });

  it('keeps the hints: spelling, written length, grace notes, lyrics, an octave line', () => {
    const p = one(
      'Soprano',
      [
        { t: 0, d: 480, p: 66, v: 80, n: { sp: [4, -1, 66], w: [960, 480], a: ['stacc'], ly: ['Hal-'] } },
        { t: q - 120, d: 120, p: 71, v: 70, n: { g: 'a' } },
        { t: q, d: q, p: 72, v: 80, n: { ly: ['le-'] } },
        { t: 2 * q, d: 2 * q, p: 84, v: 80, n: { ly: ['lu'] } },
      ],
      (p) => {
        const r = p.tracks[0]?.regions[0];
        if (r) r.marks = [{ t: 2 * q, k: 'oct', e: 4 * q, v: 8 }];
      },
    );
    expect(text(p).slice(-2)).toEqual([
      '  P1: gb4:q+stacc b4:s+grace c5:q 8va c5:h loco',
      '  lyrics P1 1: Hal- le- lu',
    ]);
  });

  it('follows a note moved in the piano roll: its old spelling and written length no longer apply', () => {
    const p = one('Flute', [{ t: 0, d: 600, p: 61, v: 80, n: { sp: [1, -1, 70], w: [960, 480] } }]);
    expect(text(p).at(-1)).toBe('  P1: c#4:e~ c#4:t r:t r:s r:q r:h');
  });
});

describe('drawing', () => {
  it('draws a song with everything in it, without a complaint from Verovio', async () => {
    const p = one('Piano', [
      ...parseNotation('D5:3 E5:1 F5:2 A5:2', { unit: q / 2 }),
      ...parseNotation('(D3 A3):4', { unit: q }),
      { t: 0, d: q, p: 50, v: 60, n: { a: ['ferm', 'acc'] } },
    ]);
    p.key = 'D minor';
    p.chords = [{ tick: 0, symbol: 'Dm' }];
    p.tempo = [{ tick: 0, bpm: 96, text: 'Andante', mm: true }];
    p.form = [
      { tick: 0, k: 'segno' },
      { tick: 4 * q, k: 'ds', al: 'coda' },
    ];
    p.score = { composer: 'Someone' };
    const r = p.tracks[0]?.regions[0];
    if (r) {
      r.marks = [
        { t: 0, k: 'dyn', v: 'p' },
        { t: 0, k: 'cresc', e: 2 * q },
        { t: 0, k: 'slur', e: 3 * q },
        { t: q, k: 'expr', v: 'dolce' },
      ];
      r.cc = {
        '64': [
          [0, 127],
          [3 * q, 0],
        ],
      };
    }
    const doc = notate(p);
    const tk = new VerovioToolkit(await createVerovioModule());
    tk.setOptions({ pageWidth: 2100, adjustPageHeight: true });
    expect(tk.loadData(toMEI(doc))).toBeTruthy();
    const svg = tk.renderToSVG(1);
    expect(tk.getLog()).toBe('');
    for (const id of doc.refs.keys()) expect(svg).toContain(`id="${id}"`);
  });
});
