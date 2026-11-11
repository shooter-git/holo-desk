/**
 * The song as a score: shown bar by bar in the score text, bars written back the same way (each bar
 * replaces only what the staves and voices it names have there), and the parts' and the score's
 * settings. Pitches in the score text are as written on the page, in scientific names (c4 is middle
 * C), whatever the studio's own naming.
 */
import { checkScore, notate, partsLine, type ScoreDoc, scoreText, withTab, writeScoreText } from '@holo/score';
import { meterAt, PPQ, type ScoreSettings, type TrackScore } from '@holo/session';
import { bool, change, need, num, plural, str, type Tool, ToolError } from './common.ts';

/** A part named by its id (P2) or its name (or the start of it), as its index. */
function partIndex(doc: ScoreDoc, ref: string): number {
  const id = /^P(\d+)$/i.exec(ref.trim());
  if (id) return Number(id[1]) - 1;
  const lower = ref.trim().toLowerCase();
  const i = doc.parts.findIndex((p) => p.name.toLowerCase() === lower);
  return i >= 0 ? i : doc.parts.findIndex((p) => p.name.toLowerCase().startsWith(lower));
}

/** "5-8" or "5" as bar indexes [from, to). */
function barRange(doc: ScoreDoc, text: string | undefined): { from?: number; to?: number } {
  if (!text) return {};
  const m = /^\s*(-?\d+)\s*(?:[-–]\s*(-?\d+))?\s*$/.exec(text);
  if (!m) throw new ToolError(`"${text}" isn't bars: use "5-8" or "5"`);
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  if (b < a) throw new ToolError('The last bar comes after the first');
  const from = doc.bars.findIndex((bar) => bar.number >= a);
  if (from < 0) throw new ToolError(`The score has bars ${doc.bars[0]?.number ?? 1}–${doc.bars.at(-1)?.number ?? 1}`);
  let to = from;
  while (to < doc.bars.length && (doc.bars[to]?.number ?? 0) <= b) to++;
  return { from, to };
}

const SCORE_TEXT = `The score text: a header line "bar 5  time 3/4  key D minor  tempo 96 \\"Andante\\"  |:", then a line per staff and voice: "P1: mf ( d5:q. e5:e f5:q ) a5:q", "P2 s2: [d3 a3]:w", "P2 s1 v2: r:h c4:h". Values w h q e s t x (whole … 64th) with dots (q.); [c4 e4]:q a chord; r:q a rest; R a whole-bar rest; ~ after the value ties on; 3:2{c4:e d4:e e4:e} a triplet; +stacc +staccis +ten +acc +marc +ferm +tr +mord +turn +arp +trem3 after the value; +grace before the note it leads to. Before a note: dynamics (p mf ff sfz fp), < or > starts a hairpin and ! ends it, ( and ) a slur, "pizz." above and _"dolce" below, 8va … loco. Lines "lyrics P1 1: Hal- le- lu- jah" (* for none) and "chords: Dm@1 A7@3" (@beat). Headers: time, key, tempo [BPM] ["words"], |:, :| (:|x3), ending 1,2, segno, coda, to coda, fine, D.S. al Coda, D.C. al Fine. Pitches are as written on the page (a B♭ clarinet a tone up), in scientific names: c4 is middle C.`;

export const scoreShow: Tool = {
  name: 'score_show',
  kind: 'see',
  summary: `The song as a score, bar by bar, in the score text score_write takes: each part (P1, P2… in track order) and staff, with dynamics, articulations, slurs, lyrics and chords. "bars" picks bars ("5-8"), "part" one part (P2, or its name). With "check": true it lists instead what a player would stumble on (out-of-range notes, slips, a bar missing). Pitches are as written on the page, in scientific names (c4 is middle C); score_write describes the text.`,
  args: [
    { name: 'bars', type: 'string', describe: 'Bars to show, e.g. "5-8" or "12"; all when left out', maxLength: 20 },
    { name: 'part', type: 'string', describe: 'One part: P1, P2… or its name', maxLength: 60 },
    { name: 'check', type: 'boolean', describe: 'List what a player would stumble on instead', default: false },
  ],
  async run(ctx, args) {
    const doc = notate(await ctx.api.song());
    if (bool(args, 'check')) {
      const flags = checkScore(doc);
      return {
        text: flags.length
          ? flags.map((f) => `bar ${f.bar} ${f.part}${f.staff > 1 ? ` s${f.staff}` : ''}: ${f.text}`).join('\n')
          : 'Nothing to flag.',
      };
    }
    const partRef = str(args, 'part');
    const parts = partRef ? [partIndex(doc, partRef)] : undefined;
    if (parts && !doc.parts[parts[0] as number]) throw new ToolError(`No part "${partRef}": ${partsLine(doc)}`);
    const text = scoreText(doc, { ...barRange(doc, str(args, 'bars')), ...(parts ? { parts } : {}) });
    return { text: doc.warnings.length ? `${text}\n\n${doc.warnings.join('\n')}` : text };
  },
};

export const scoreParts: Tool = {
  name: 'score_parts',
  kind: 'see',
  summary:
    "The score's parts (P1, P2… in track order): each one's staves, clefs, transposition (written above sounding, for a B♭ clarinet or a guitar), drum staff or tablature. Read it before score_write, since pitches there are as written.",
  args: [],
  async run(ctx) {
    const doc = notate(await ctx.api.song());
    const lines = [partsLine(doc)];
    doc.parts.forEach((p, i) => {
      const clefs = p.staves.map((s) => s.clefs.map(([, c]) => c).join('→')).join(' / ');
      lines.push(
        `  P${i + 1} ${p.name}: ${p.staves.length} ${p.staves.length > 1 ? 'staves' : 'staff'}, clef ${clefs}${p.tr ? `, written ${p.tr[0]} semitones up` : ''}${p.drums ? ', drum staff' : ''}`,
      );
    });
    return { text: lines.join('\n') };
  },
};

export const scoreWrite: Tool = {
  name: 'score_write',
  kind: 'change',
  summary: `Write bars of the score from the score text (as score_show prints it): each bar replaces what the staves and voices it names have in that bar; the others keep theirs. Dynamics and articulations become how it plays. Every line must fill its bar with notes and rests: a bar that doesn't is refused with the reason (the others are written), so fix it and write it again. Reading a scanned system, give "scan" and "system" ("PAGE.SYSTEM", e.g. "0.1") and the system is marked read (or flagged with what was refused). ${SCORE_TEXT}`,
  args: [
    {
      name: 'text',
      type: 'string',
      describe: 'The bars, e.g. "bar 9\\n  P1: c5:q d5:q e5:h"',
      required: true,
      maxLength: 60000,
    },
    { name: 'scan', type: 'string', describe: 'The scan these bars were read from (scn_…)', maxLength: 40 },
    { name: 'system', type: 'string', describe: 'Its system, PAGE.SYSTEM from scan_show, e.g. "0.1"', maxLength: 12 },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const text = need(args, 'text');
    if (!/^\s*bar\s+-?\d/m.test(text))
      throw new ToolError('Start with a bar line, e.g. "bar 9", then a line per staff');
    const result = writeScoreText(project, text);
    const bars = result.written;
    const label = bars.length === 1 ? `Score: bar ${bars[0]}` : `Score: bars ${bars[0]}–${bars.at(-1)}`;
    if (result.ops.length) await change(ctx, project, result.ops, label);
    const lines: string[] = [];
    if (bars.length) lines.push(`Wrote ${plural(bars.length, 'bar')}: ${bars.join(', ')}.`);
    for (const w of result.warnings) lines.push(`note: ${w}`);
    if (result.errors.length) lines.push(`Not written:\n${result.errors.map((e) => `  ${e}`).join('\n')}`);
    const scan = str(args, 'scan');
    const system = str(args, 'system');
    if (scan || system) {
      const ref = /^(\d+)\.(\d+)$/.exec(system ?? '');
      if (!scan || !ref) throw new ToolError('Give both "scan" and "system" ("PAGE.SYSTEM", e.g. "0.1")');
      const body: { state: 'read' | 'new'; written?: [number, number]; flags?: string[] } = {
        state: bars.length && !result.errors.length ? 'read' : 'new',
      };
      if (bars.length) body.written = [Math.min(...bars), Math.max(...bars)];
      if (result.errors.length) body.flags = result.errors.slice(0, 20);
      await ctx.api.scanSystem(scan, Number(ref[1]), Number(ref[2]), body);
      lines.push(`Scan ${scan} system ${ref[1]}.${ref[2]}: ${body.state}.`);
    }
    if (!bars.length && !result.ops.length) throw new ToolError(lines.join('\n') || 'Nothing was written');
    return { text: lines.join('\n'), ...(result.ops.length ? { progress: label } : {}) };
  },
};

export const scorePart: Tool = {
  name: 'score_part',
  kind: 'change',
  summary:
    'How a part is written on the score: "staves" (1–4; 2 a grand staff), "clefs" per staff ("G,F"; also C3 alto, C4 tenor, G8vb, perc), "transpose" as semitones,letter steps written above sounding ("2,1" a B♭ clarinet, "7,4" a horn in F, "none"), the part\'s "name" and short "abbr", "hidden" from the full score, and tablature: "tab" on|only|off with a "tuning" (guitar, drop-d, dadgad, open-g, bass, bass-5, ukulele, mandolin, banjo, or MIDI numbers highest string first) and a "capo" fret.',
  args: [
    { name: 'part', type: 'string', describe: "P1, P2… or the part's name", required: true },
    { name: 'staves', type: 'integer', describe: 'How many staves', min: 1, max: 4 },
    { name: 'clefs', type: 'string', describe: 'A clef per staff, e.g. "G,F"', maxLength: 40 },
    {
      name: 'transpose',
      type: 'string',
      describe: '"2,1" (semitones,steps written above sounding) or "none"',
      maxLength: 12,
    },
    { name: 'name', type: 'string', describe: 'Its name on the score', maxLength: 60 },
    { name: 'abbr', type: 'string', describe: 'Its short name on later systems ("Vln. I")', maxLength: 20 },
    { name: 'hidden', type: 'boolean', describe: 'Leave it out of the full score' },
    { name: 'tab', type: 'enum', values: ['on', 'only', 'off'], describe: 'Tablature under the staff, alone, or none' },
    { name: 'tuning', type: 'string', describe: 'guitar, drop-d, bass… or "64,59,55,50,45,40"', maxLength: 60 },
    { name: 'capo', type: 'integer', describe: "The capo's fret", min: 0, max: 12 },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const doc = notate(project);
    const ref = need(args, 'part');
    const part = doc.parts[partIndex(doc, ref)];
    if (!part) throw new ToolError(`No part "${ref}": ${partsLine(doc)}`);
    const track = project.tracks.find((t) => t.id === part.track);
    const score: TrackScore = { ...(track?.score ?? {}) };
    const done: string[] = [];
    const staves = num(args, 'staves');
    if (staves !== undefined) {
      score.staves = staves;
      done.push(plural(staves, 'staff', 'staves'));
    }
    const clefs = str(args, 'clefs');
    if (clefs) {
      score.clefs = clefs.split(',').map((c, k): [number, number, string] => [0, k + 1, c.trim()]);
      done.push(`clefs ${clefs}`);
    }
    const tr = str(args, 'transpose')?.trim();
    if (tr === 'none' || tr === '0') {
      score.tr = [0, 0];
      done.push('not transposed');
    } else if (tr) {
      const m = /^(-?\d+)\s*,\s*(-?\d+)$/.exec(tr);
      if (!m) throw new ToolError('"transpose" is semitones,steps (e.g. "2,1") or "none"');
      score.tr = [Number(m[1]), Number(m[2])];
      done.push(`written ${m[1]} semitones up`);
    }
    for (const k of ['name', 'abbr'] as const) {
      const v = str(args, k);
      if (v) {
        score[k] = v;
        done.push(`${k} "${v}"`);
      }
    }
    const hidden = bool(args, 'hidden');
    if (hidden !== undefined) {
      score.hidden = hidden;
      done.push(hidden ? 'hidden' : 'shown');
    }
    const tab = str(args, 'tab');
    const tuning = str(args, 'tuning');
    const capo = num(args, 'capo');
    if (tab || tuning || capo !== undefined) {
      const mode = tab === 'only' ? 'only' : tab === 'off' ? 'off' : score.tab?.only && !tab ? 'only' : 'under';
      const strings = tuning && /^[\d,\s]+$/.test(tuning) ? tuning.split(',').map(Number) : tuning;
      try {
        Object.assign(score, withTab({ name: track?.name ?? part.name, score }, mode, strings, capo));
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : String(err));
      }
      if (mode === 'off') delete score.tab;
      done.push(`tab ${mode}`);
    }
    if (!done.length)
      throw new ToolError('Say what to set: staves, clefs, transpose, name, abbr, hidden, tab, tuning or capo');
    const label = `Score: ${part.name}, ${done.join(', ')}`;
    await change(ctx, project, [{ op: 'updateTrack', track: part.track, patch: { score } }], label);
    return { text: `${label}.`, progress: label };
  },
};

export const scoreMeta: Tool = {
  name: 'score_meta',
  kind: 'change',
  summary:
    'The score\'s credits (composer, lyricist, arranger, subtitle, copyright; "" removes one), and "pickup": the song starts with an upbeat of that many beats (bar 0; 0 for none).',
  args: [
    { name: 'composer', type: 'string', describe: 'The composer', maxLength: 120 },
    { name: 'lyricist', type: 'string', describe: 'The lyricist', maxLength: 120 },
    { name: 'arranger', type: 'string', describe: 'The arranger', maxLength: 120 },
    { name: 'subtitle', type: 'string', describe: 'A subtitle', maxLength: 200 },
    { name: 'copyright', type: 'string', describe: 'The copyright line', maxLength: 200 },
    { name: 'pickup', type: 'number', describe: 'Beats of upbeat before bar 1 (0 for none)', min: 0, max: 16 },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const score: ScoreSettings = { ...(project.score ?? {}) };
    const done: string[] = [];
    for (const k of ['composer', 'lyricist', 'arranger', 'subtitle', 'copyright'] as const) {
      const v = str(args, k);
      if (v === undefined) continue;
      if (v.trim()) score[k] = v.trim();
      else delete score[k];
      done.push(v.trim() ? `${k} "${v.trim()}"` : `no ${k}`);
    }
    const ops: Parameters<typeof change>[2] = [];
    if (done.length) ops.push({ op: 'setProject', patch: { score } });
    const beats = num(args, 'pickup');
    if (beats !== undefined) {
      const beat = (PPQ * 4) / meterAt(project.meter, 0).den;
      const meter = project.meter.map((m, k) => {
        if (k !== 0) return m;
        const { pickup: _, ...plain } = m;
        return beats > 0 ? { ...plain, pickup: Math.round(beats * beat) } : plain;
      });
      ops.push({ op: 'setProject', patch: { meter } });
      done.push(beats > 0 ? `a pickup of ${beats}` : 'no pickup');
    }
    if (!ops.length)
      throw new ToolError('Say what to set: composer, lyricist, arranger, subtitle, copyright or pickup');
    const label = `Score: ${done.join(', ')}`;
    await change(ctx, project, ops, label);
    return { text: `${label}.`, progress: label };
  },
};

export const scoreTools: Tool[] = [scoreShow, scoreParts, scoreWrite, scorePart, scoreMeta];
