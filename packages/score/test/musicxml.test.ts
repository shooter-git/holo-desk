import { deflateRawSync } from 'node:zlib';
import { type Instrument, type Note, newProject, newRegion, PPQ, type Project, parseNotation } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { notate, parseXml, readMusicXml, readMxl, scoreFileText, scoreText, toMusicXml } from '../src/index.ts';

const q = PPQ;

function song(name: string, notes: Note[], setup?: (p: Project) => void, instrument?: Instrument): Project {
  const p = newProject(name);
  const t = p.tracks[0];
  if (!t) throw new Error('no track');
  t.name = name;
  if (instrument) t.instrument = instrument;
  const r = newRegion(0, q * 8);
  r.notes = notes;
  t.regions = [r];
  setup?.(p);
  return p;
}

/** Out as MusicXML and back in: the score reads the same. */
function roundTrip(p: Project): [string, string] {
  const doc = notate(p);
  const xml = toMusicXml(doc);
  parseXml(xml); // it parses
  return [scoreText(doc), scoreText(notate(readMusicXml(xml).project))];
}

describe('MusicXML', () => {
  it('takes a melody with its marks out and back', () => {
    const p = song('Flute', parseNotation('D5:3 E5:1 F5:2 A5:2 | G5:4 F5:2 E5:2', { unit: q / 2 }), (p) => {
      p.key = 'D minor';
      p.chords = [
        { tick: 0, symbol: 'Dm' },
        { tick: 2 * q, symbol: 'A7/C#' },
        { tick: 4 * q, symbol: 'Gm7' },
      ];
      p.tempo = [{ tick: 0, bpm: 96, text: 'Andante', mm: true }];
      const r = p.tracks[0]?.regions[0];
      if (r) {
        r.marks = [
          { t: 0, k: 'dyn', v: 'mp' },
          { t: 0, k: 'slur', e: 3.5 * q },
          { t: 4 * q, k: 'cresc', e: 7 * q },
          { t: 7 * q, k: 'dyn', v: 'f' },
          { t: 4 * q, k: 'expr', v: 'dolce' },
        ];
      }
    });
    const [out, back] = roundTrip(p);
    expect(back).toBe(out);
  });

  it('takes a piano on two staves with two voices out and back', () => {
    const p = song(
      'Piano',
      [
        { t: 0, d: 4 * q, p: 64, v: 70, n: { vo: 2, st: 1 } },
        ...[0, 1, 2, 3].map((i) => ({ t: i * q, d: q, p: 72 + 2 * i, v: 80, n: { vo: 1, st: 1 } })),
        ...parseNotation('(C3 G3):4 (B2 G3):4', { unit: q }),
      ],
      (p) => {
        p.key = 'C major';
      },
    );
    const [out, back] = roundTrip(p);
    expect(back).toBe(out);
  });

  it('keeps a pickup, repeats, endings and a jump', () => {
    const p = song('Voice', parseNotation('r:3 C4:1 | F4:4 | G4:4 | A4:4', { unit: q }), (p) => {
      p.meter = [{ tick: 0, num: 4, den: 4, pickup: q }];
      p.form = [
        { tick: 4 * q, k: 'start' },
        { tick: 8 * q, k: 'ending', e: 12 * q, passes: [1] },
        { tick: 12 * q, k: 'end' },
        { tick: 12 * q, k: 'ending', e: 16 * q, passes: [2] },
        { tick: 16 * q, k: 'dc', al: 'fine' },
      ];
      const r = p.tracks[0]?.regions[0];
      if (r) r.length = 16 * q;
    });
    const [out, back] = roundTrip(p);
    expect(back).toBe(out);
  });

  it('keeps a transposing part at concert pitch inside and written outside', () => {
    const p = song('Clarinet in Bb', parseNotation('F4:1 G4:1 A4:1 Bb4:1', { unit: q }), (p) => {
      p.key = 'F major';
    });
    const xml = toMusicXml(notate(p));
    expect(xml).toContain('<chromatic>-2</chromatic>');
    expect(xml).toContain('<fifths>1</fifths>');
    const back = readMusicXml(xml).project;
    expect(back.tracks[0]?.regions[0]?.notes.map((n) => n.p)).toEqual([65, 67, 69, 70]);
    expect(back.key).toBe('F major');
    const [out, again] = roundTrip(p);
    expect(again).toBe(out);
  });

  it('keeps triplets, ties across bars, lyrics, grace notes, articulations and an 8va', () => {
    const p = song(
      'Soprano',
      [
        ...[0, 320, 640].map((t, i) => ({
          t,
          d: 320,
          p: 72 + i * 2,
          v: 80,
          n: { ly: [['Glo-', 'ri-', 'a'][i] as string] },
        })),
        { t: q, d: 2 * q, p: 79, v: 80, n: { a: ['acc'] } },
        { t: 3 * q - 90, d: 90, p: 81, v: 70, n: { g: 'a' } },
        { t: 3 * q, d: 2 * q, p: 84, v: 80, n: { a: ['ferm'] } },
        { t: 5 * q, d: q, p: 84, v: 80, n: { w: [q, q / 2], a: ['stacc'] } },
      ],
      (p) => {
        const r = p.tracks[0]?.regions[0];
        if (r) r.marks = [{ t: 5 * q, k: 'oct', e: 7 * q, v: 8 }];
      },
    );
    const [out, back] = roundTrip(p);
    expect(back).toBe(out);
  });

  it('keeps the strings a guitar part is played on', () => {
    const p = song('Guitar', parseNotation('E4:1 B3:1 (G3 D4):2', { unit: q }), (p) => {
      const t = p.tracks[0];
      if (t) t.score = { tab: { tuning: [64, 59, 55, 50, 45, 40] } };
      // the E played on the B string, not open
      const n = p.tracks[0]?.regions[0]?.notes[0];
      if (n) n.n = { tb: [2, 64] };
    });
    const xml = toMusicXml(notate(p));
    expect(xml).toContain('<technical><string>2</string><fret>5</fret></technical>');
    const back = readMusicXml(xml).project;
    expect(back.tracks[0]?.regions[0]?.notes.find((n) => n.p === 64)?.n?.tb).toEqual([2, 64]);
  });

  it('keeps drums on their staff', () => {
    const drums: Note[] = [];
    for (let i = 0; i < 8; i++) drums.push({ t: i * 480, d: 60, p: 42, v: 70 });
    for (const b of [0, 2]) drums.push({ t: b * q, d: 60, p: 36, v: 100 });
    for (const b of [1, 3]) drums.push({ t: b * q, d: 60, p: 38, v: 100 });
    const p = song('Drums', drums, undefined, { type: 'synth', preset: 'Drum Synth' });
    const [out, back] = roundTrip(p);
    expect(back).toBe(out);
  });
});

describe('MusicXML from elsewhere', () => {
  it('reads a score as another program writes it', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <work><work-title>Little Song &amp; Dance</work-title></work>
  <identification><creator type="composer">A. Composer</creator></identification>
  <part-list>
    <score-part id="P1"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="0" implicit="yes">
      <attributes><divisions>2</divisions><key><fifths>-1</fifths><mode>major</mode></key>
        <time><beats>3</beats><beat-type>4</beat-type></time><staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>
      <direction placement="below"><direction-type><dynamics><p/></dynamics></direction-type><staff>1</staff></direction>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff>
        <lyric number="1"><syllabic>single</syllabic><text>Hey</text></lyric></note>
      <backup><duration>2</duration></backup>
      <note><rest/><duration>2</duration><voice>5</voice><type>quarter</type><staff>2</staff></note>
    </measure>
    <measure number="1">
      <harmony><root><root-step>F</root-step></root><kind>major</kind></harmony>
      <note><pitch><step>F</step><octave>5</octave></pitch><duration>4</duration><tie type="start"/><voice>1</voice><type>half</type><staff>1</staff>
        <notations><tied type="start"/><articulations><accent/></articulations></notations></note>
      <note><pitch><step>B</step><alter>-1</alter><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <backup><duration>6</duration></backup>
      <note><pitch><step>F</step><octave>3</octave></pitch><duration>6</duration><voice>5</voice><type>half</type><dot/><staff>2</staff></note>
      <note><chord/><pitch><step>C</step><octave>4</octave></pitch><duration>6</duration><voice>5</voice><type>half</type><dot/><staff>2</staff></note>
      <barline location="right"><bar-style>light-heavy</bar-style></barline>
    </measure>
  </part>
</score-partwise>`;
    const { project } = readMusicXml(xml);
    expect(project.title).toBe('Little Song & Dance');
    expect(project.score?.composer).toBe('A. Composer');
    expect(project.meter[0]).toEqual({ tick: 0, num: 3, den: 4, pickup: q });
    expect(project.key).toBe('F major');
    expect(scoreText(notate(project)).split('\n').slice(1)).toEqual([
      'parts: P1 Piano (2 staves)',
      'bar 0  time 3/4  key F major  pickup',
      '  clef P1 s1 G',
      '  P1 s1: p c5:q',
      '  lyrics P1 s1 1: Hey',
      '  clef P1 s2 F',
      '  P1 s2: R',
      'bar 1',
      '  P1 s1: f5:h+acc bb4:q',
      '  P1 s2: [f3 c4]:h.',
      '  chords: F@1',
    ]);
  });
});

/** A zip as an .mxl is: the container stored, the score deflated. */
function zip(files: [string, string, boolean][]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text, deflate] of files) {
    const raw = Buffer.from(text);
    const data = deflate ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, end]));
}

describe('compressed MusicXML', () => {
  it('reads the score the container names', async () => {
    const score = toMusicXml(notate(song('Flute', parseNotation('C5:8', { unit: q / 2 }))));
    const mxl = zip([
      ['mimetype', 'application/vnd.recordare.musicxml', false],
      [
        'META-INF/container.xml',
        '<container><rootfiles><rootfile full-path="score.musicxml"/></rootfiles></container>',
        false,
      ],
      ['score.musicxml', score, true],
    ]);
    expect(await readMxl(mxl)).toBe(score);
    expect(await scoreFileText(mxl)).toBe(score);
    expect(await scoreFileText(new TextEncoder().encode(score))).toBe(score);
  });
});
