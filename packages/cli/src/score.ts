/**
 * `holo score`: the song as a score, bar by bar, and bars written back the same way. What the AI
 * reads and writes notation with (and anyone who'd rather type music than click it).
 */
import { readFileSync } from 'node:fs';
import { checkScore, notate, partsLine, type ScoreDoc, scoreText, writeScoreText } from '@holo/score';
import { meterAt, type Op, PPQ, type Project, type TrackScore, unrollOps } from '@holo/session';

export interface ScoreContext {
  words: string[];
  flag: (k: string) => string | undefined;
  song: () => Promise<Project>;
  ops: (project: Project, list: Op[], label: string) => Promise<void>;
  call: <T>(path: string, init?: RequestInit) => Promise<T>;
}

export const SCORE_HELP = `holo score: the song as a score (parts P1, P2… in track order; pitches as written on the page)
  holo score show [--part P1|NAME] [--bars 5-8]   bars as text: what's written, with the marks
  holo score write [FILE|-] [--scan S --system 0.1]   bars from text (a file, - for stdin, or the text itself):
                                       each bar replaces what the staves and voices it names have there
  holo score check                     what a player would stumble on: ranges, slips, missing bars
  holo score parts                     the parts: staves, clefs, transposition
  holo score part P1 [--staves 2] [--clefs G,F] [--transpose 2,1|none] [--name N] [--abbr A] [--hidden on|off]
  holo score meta [--composer C] [--lyricist L] [--arranger A] [--subtitle S] [--copyright C]
  holo score pickup BEATS              the song starts with an upbeat of BEATS beats (0: none)
  holo score unroll                    write the repeats and jumps out as they play (no repeat signs after)

The text: "bar 5  time 3/4  key D minor  tempo 96 \\"Andante\\"  |:" then a line a staff (and voice):
  P1: mf ( d5:q. e5:e f5:q ) a5:q        P2 s2: [d3 a3]:w        P2 s1 v2: r:h c4:h
Values w h q e s t x (whole … 64th) with dots; [c4 e4]:q a chord; r:q a rest; R a whole-bar rest;
~ ties on (after the value, or after a pitch in a chord); 3:2{c4:e d4:e e4:e} a triplet; +stacc +acc
+ten +marc +ferm +tr +mord +turn +arp +trem3 after the value; +grace before the note it leads to.
Marks before a note: p mf ff sfz…, < or > start a hairpin and ! ends it, ( and ) a slur, "pizz."
above and _"dolce" below, 8va … loco. Lines "lyrics P1 1: Hal- le- lu- jah" (* for none) and
"chords: Dm@1 A7@3" (@beat). Headers: time, key, tempo [BPM] ["words"][@beat], |:, :| (:|x3),
ending 1,2, segno, coda, to coda, fine, D.S. al Coda, D.C. al Fine.`;

/** A part named by its id (P2) or its name, as its index. */
function partIndex(doc: ScoreDoc, ref: string): number {
  const id = /^P(\d+)$/i.exec(ref);
  if (id) return Number(id[1]) - 1;
  const lower = ref.toLowerCase();
  const i = doc.parts.findIndex((p) => p.name.toLowerCase() === lower);
  return i >= 0 ? i : doc.parts.findIndex((p) => p.name.toLowerCase().startsWith(lower));
}

/** "5-8" or "5" as bar indexes [from, to). */
function barRange(doc: ScoreDoc, text: string | undefined): { from?: number; to?: number } {
  if (!text) return {};
  const [a, b] = text.split(/[-–]/).map((x) => Number(x.trim()));
  const from = doc.bars.findIndex((bar) => bar.number === a);
  const last = b === undefined || Number.isNaN(b) ? a : b;
  let to = doc.bars.length - 1;
  for (let i = doc.bars.length - 1; i >= 0; i--) {
    if ((doc.bars[i]?.number ?? 0) <= (last ?? 0)) {
      to = i;
      break;
    }
  }
  return { from: Math.max(0, from), to: to + 1 };
}

async function readText(arg: string | undefined): Promise<string> {
  if (!arg || arg === '-') {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  if (/^bar\s+\d/m.test(arg)) return arg;
  return readFileSync(arg, 'utf8');
}

export async function scoreCommand(ctx: ScoreContext): Promise<void> {
  const [sub = 'help', ...rest] = ctx.words;
  if (sub === 'help') {
    console.log(SCORE_HELP);
    return;
  }
  const project = await ctx.song();
  const doc = notate(project);
  switch (sub) {
    case 'show': {
      const partRef = ctx.flag('part');
      const parts = partRef ? [partIndex(doc, partRef)] : undefined;
      if (parts && !doc.parts[parts[0] as number]) throw new Error(`No part "${partRef}": ${partsLine(doc)}`);
      console.log(scoreText(doc, { ...barRange(doc, ctx.flag('bars')), ...(parts ? { parts } : {}) }));
      if (doc.warnings.length) console.log(`\n${doc.warnings.join('\n')}`);
      return;
    }
    case 'write': {
      const text = await readText(rest[0]);
      const result = writeScoreText(project, text);
      for (const w of result.warnings) console.log(`note: ${w}`);
      if (result.ops.length) {
        const bars = result.written;
        const label = bars.length === 1 ? `Score: bar ${bars[0]}` : `Score: bars ${bars[0]}–${bars.at(-1)}`;
        await ctx.ops(project, result.ops, label);
      }
      if (result.errors.length) {
        console.log(`Not written:\n${result.errors.map((e) => `  ${e}`).join('\n')}`);
        process.exitCode = 1;
      }
      // a scanned system's bars: it's read (or flagged with what was refused)
      const scan = ctx.flag('scan');
      const system = /^(\d+)\.(\d+)$/.exec(ctx.flag('system') ?? '');
      if (scan && system) {
        const body: Record<string, unknown> = {
          state: result.written.length && !result.errors.length ? 'read' : 'new',
        };
        if (result.written.length) body.written = [Math.min(...result.written), Math.max(...result.written)];
        if (result.errors.length) body.flags = result.errors;
        await ctx.call(`/api/scans/${scan}/systems/${system[1]}/${system[2]}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        console.log(`Scan ${scan} system ${system[1]}.${system[2]}: ${body.state}`);
      }
      return;
    }
    case 'check': {
      const flags = checkScore(doc);
      if (!flags.length) {
        console.log('Nothing to flag.');
        return;
      }
      for (const f of flags) console.log(`bar ${f.bar} ${f.part}${f.staff > 1 ? ` s${f.staff}` : ''}: ${f.text}`);
      return;
    }
    case 'parts': {
      console.log(partsLine(doc));
      doc.parts.forEach((p, i) => {
        const clefs = p.staves.map((s) => s.clefs.map(([, c]) => c).join('→')).join(' / ');
        console.log(
          `  P${i + 1} ${p.name}: ${p.staves.length} ${p.staves.length > 1 ? 'staves' : 'staff'}, clef ${clefs}${p.tr ? `, written ${p.tr[0]} semitones up` : ''}${p.drums ? ', drum staff' : ''}`,
        );
      });
      return;
    }
    case 'part': {
      const ref = rest[0];
      const i = ref ? partIndex(doc, ref) : -1;
      const part = doc.parts[i];
      if (!part) throw new Error(`Which part? ${partsLine(doc)}`);
      const track = project.tracks.find((t) => t.id === part.track);
      const score: TrackScore = { ...(track?.score ?? {}) };
      const staves = ctx.flag('staves');
      if (staves) score.staves = Math.max(1, Math.min(4, Number(staves)));
      const clefs = ctx.flag('clefs');
      if (clefs) score.clefs = clefs.split(',').map((c, k): [number, number, string] => [0, k + 1, c.trim()]);
      const tr = ctx.flag('transpose');
      if (tr === 'none' || tr === '0') score.tr = [0, 0];
      else if (tr) score.tr = tr.split(',').map(Number) as [number, number];
      const name = ctx.flag('name');
      if (name) score.name = name;
      const abbr = ctx.flag('abbr');
      if (abbr) score.abbr = abbr;
      const hidden = ctx.flag('hidden');
      if (hidden) score.hidden = hidden === 'on';
      await ctx.ops(project, [{ op: 'updateTrack', track: part.track, patch: { score } }], `Score: ${part.name}`);
      return;
    }
    case 'meta': {
      const score = { ...(project.score ?? {}) };
      for (const k of ['composer', 'lyricist', 'arranger', 'subtitle', 'copyright'] as const) {
        const v = ctx.flag(k);
        if (v !== undefined) score[k] = v;
      }
      await ctx.ops(project, [{ op: 'setProject', patch: { score } }], 'Score: credits');
      return;
    }
    case 'pickup': {
      const beats = Number(rest[0] ?? 0);
      const beat = (PPQ * 4) / meterAt(project.meter, 0).den;
      const meter = project.meter.map((m, k) => {
        if (k !== 0) return m;
        const { pickup: _, ...plain } = m;
        return beats > 0 ? { ...plain, pickup: Math.round(beats * beat) } : plain;
      });
      await ctx.ops(
        project,
        [{ op: 'setProject', patch: { meter } }],
        beats > 0 ? `Score: a pickup of ${beats}` : 'Score: no pickup',
      );
      return;
    }
    case 'unroll': {
      const ops = unrollOps(project);
      if (!ops.length) {
        console.log('The song has no repeats or jumps to write out.');
        return;
      }
      await ctx.ops(project, ops, 'Unroll Repeats');
      return;
    }
    default:
      console.log(SCORE_HELP);
  }
}
