/**
 * Measuring what the song sounds like (docs/agent.md, "Measuring"): a vocal or a solo's pitch, timing
 * and loudness note by note, the mix's loudness, peaks and balance, each track's level, what a plugin
 * does, the studio's meters while it plays, a bounce or an attached recording. HO[LO] measures; this
 * says the numbers in a few plain lines for the model to read.
 *
 * Rendering is slow (slower than the song plays), so a measurement that renders may not be done within
 * a call: the call answers how far it has got, and the same call again picks it up.
 */
import { letterOf, spellInKey } from '@holo/score';
import { type KeyPoint, keyAt, keysOf, type MiddleC, noteName, type Project, tickToBarBeat } from '@holo/session';
import type {
  MeasureAnswer,
  MeasureBody,
  MeasureResult,
  MeasureWhat,
  MetersMeasure,
  MixMeasure,
  PluginMeasure,
  TakeMeasure,
  TracksMeasure,
} from '../api.ts';
import {
  barsText,
  channelRef,
  num as numArg,
  plural,
  position,
  str,
  type Tool,
  type ToolContext,
  ToolError,
  trackRef,
  UNITS,
  unitTicks,
} from './common.ts';

const OCTAVES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const THIRDS = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000,
  5000, 6300, 8000, 10000, 12500, 16000, 20000,
];

const hz = (v: number) => (v >= 1000 ? `${Number((v / 1000).toFixed(2))}k` : `${v}`);
const hzUnit = (v: number) => (v >= 1000 ? `${Number((v / 1000).toFixed(2))} kHz` : `${v} Hz`);
const num = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? 'silent' : v.toFixed(digits);
const signed = (v: number, digits = 0) => `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** A tick as bar.beat.sixteenth. */
function pos(song: Project, tick: number): string {
  const p = tickToBarBeat(song.meter, tick);
  return `${p.bar}.${p.beat}.${p.div}`;
}

/**
 * A note's name as the song's key spells it there (B♭ in D minor, A♯ in B major; sharps with no key),
 * named the studio's way (middle C is C4 or C3).
 */
function keyName(pitch: number, key: KeyPoint | null, middleC: MiddleC): string {
  if (!key) return noteName(pitch, middleC);
  const s = spellInKey(Math.round(pitch), key.fifths, key.mode);
  const accidental = s.alter > 0 ? '#'.repeat(s.alter) : 'b'.repeat(-s.alter);
  return `${letterOf(s.step)}${accidental}${s.octave - (middleC === 'C3' ? 1 : 0)}`;
}

/** A channel's name by id. */
function channelName(song: Project, id: string): string {
  if (id === 'master') return 'the master';
  return song.tracks.find((t) => t.id === id)?.name ?? song.buses.find((b) => b.id === id)?.name ?? id;
}

/** Bands as "125 -24, 250 -22, …" (those within `within` dB of the loudest). */
function bandsText(centers: readonly number[], levels: readonly (number | null)[], within = 60): string {
  const top = Math.max(...levels.filter((v): v is number => v !== null));
  return centers
    .map((c, i) => [c, levels[i]] as const)
    .filter(([, v]) => v !== null && v !== undefined && v >= top - within)
    .map(([c, v]) => `${hz(c)} ${(v as number).toFixed(0)}`)
    .join(', ');
}

/** The octave band where most of a track's sound is, as "around 125 Hz". */
function loudest(levels: readonly (number | null)[]): string {
  let best = -1;
  levels.forEach((v, i) => {
    if (v !== null && (best < 0 || v > (levels[best] as number))) best = i;
  });
  return best < 0 ? '' : `around ${hzUnit(OCTAVES[best] as number)}`;
}

// ---- what each measurement says ----

function takeText(r: TakeMeasure, song: Project, middleC: MiddleC): string {
  const s = r.summary;
  const notes = r.notes;
  const first = notes[0];
  const last = notes[notes.length - 1];
  const where = (n: { tick: number | null; at: number }) =>
    n.tick !== null ? pos(song, n.tick) : `${n.at.toFixed(2)} s`;
  const span =
    first && last && first.tick !== null
      ? barsText(song, first.tick, last.end ?? first.tick + 1)
      : `${r.seconds} s of recording`;
  const against =
    r.against.kind === 'key'
      ? `the key (${r.against.keys.join(', then ')}): each note against its nearest scale tone`
      : r.against.kind === 'track'
        ? `the notes ${channelName(song, r.against.track)} plays`
        : `the nearest semitone${song.key ? '' : ' (the song has no key)'}`;
  const gridName = Object.entries({ '1/4': 960, '1/8': 480, '1/16': 240, '1/32': 120, '1/8T': 320, '1/16T': 160 }).find(
    ([, t]) => t === r.grid,
  )?.[0];
  const lines = [
    `${r.name}, ${span}${r.regions.length > 1 ? ` (${plural(r.regions.length, 'region')})` : ''}: measured against ${against}.`,
  ];
  if (!notes.length) {
    lines.push(
      'No notes were heard: it may be silent there, too quiet, or more than one line at a time (only one voice or instrument is measured).',
    );
    return lines.join('\n');
  }
  const worst = [...notes]
    .filter((n) => Math.abs(n.cents) > 25)
    .sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents))
    .slice(0, 5)
    .map((n) => `${where(n)} ${signed(n.cents)}c`);
  lines.push(
    `${plural(s.notes, 'note')}. Pitch: ${s.meanAbs.toFixed(0)} cents off on average${
      Math.abs(s.bias) >= 3 ? `, leaning ${Math.abs(s.bias).toFixed(0)} cents ${s.bias > 0 ? 'sharp' : 'flat'}` : ''
    }; ${pct(s.within10)} within ±10 cents, ${pct(s.within25)} within ±25; ${s.sharp} sharp and ${s.flat} flat by more than 25${
      worst.length ? ` (${worst.join(', ')})` : ''
    }.`,
  );
  if (s.timing)
    lines.push(
      `Timing against the ${gridName ?? `${r.grid}-tick`} grid: ${
        Math.abs(s.timing.mean) < 3
          ? 'on it on average'
          : `${Math.abs(s.timing.mean).toFixed(0)} ms ${s.timing.mean > 0 ? 'late' : 'early'} on average`
      }, spread ±${s.timing.spread.toFixed(0)} ms; ${s.timing.late} more than 30 ms late, ${s.timing.early} more than 30 ms early.`,
    );
  const extra: string[] = [];
  if (s.vibrato)
    extra.push(
      `Vibrato on ${plural(s.vibrato.notes, 'note')} (${s.vibrato.rate.toFixed(1)} Hz, ±${s.vibrato.depth.toFixed(0)} cents on average)`,
    );
  if (s.drifting)
    extra.push(
      `${plural(s.drifting, 'note')} ${s.drifting === 1 ? "drifts 15 cents or more as it's" : "drift 15 cents or more as they're"} held`,
    );
  if (extra.length) lines.push(`${extra.join('. ')}.`);
  if (r.phrases.length) {
    const levels = r.phrases.map((p) => p.db).sort((a, b) => a - b);
    const mid = levels[Math.floor(levels.length / 2)] as number;
    const phrase = r.phrases.slice(0, 16).map((p) => {
      const at =
        p.tick !== null && p.end !== null ? `${pos(song, p.tick)}–${pos(song, p.end)}` : `${p.at.toFixed(1)} s`;
      const off = p.db - mid;
      return `${at} ${p.db.toFixed(1)} dB${Math.abs(off) >= 3 && r.phrases.length > 2 ? ` (${Math.abs(off).toFixed(1)} dB ${off < 0 ? 'under' : 'over'} the rest)` : ''}`;
    });
    lines.push(
      `Phrases (RMS level): ${phrase.join('; ')}${r.phrases.length > 16 ? `; … ${r.phrases.length - 16} more` : ''}.`,
    );
  }
  const MOST = 40;
  // each note named as the key spells it where it is (an attached recording: as its measurement's key)
  const keys = keysOf(song);
  const keyOf = (n: { tick: number | null }) => (n.tick !== null ? keyAt(keys, n.tick) : (keys[0] ?? null));
  lines.push('Notes (where, note, cents, start against the grid, level):');
  for (const n of notes.slice(0, MOST)) {
    const key = keyOf(n);
    const parts = [where(n), keyName(n.target, key, middleC), `${signed(n.cents)}c`];
    if (n.inKey === false) parts.push('(not in the key)');
    if (n.ref === null) parts.push(`(${channelName(song, (r.against as { track: string }).track)} plays nothing here)`);
    else if (n.ref !== undefined && Math.round(n.target) % 12 !== Math.round(n.ref) % 12)
      parts.push(`(it plays ${keyName(n.ref, key, middleC)})`);
    if (n.grid !== null) parts.push(`${signed(n.grid)} ms`);
    parts.push(`${n.db.toFixed(0)} dB`);
    if (n.vibrato) parts.push(`vibrato ${n.vibrato[0].toFixed(1)} Hz ±${n.vibrato[1].toFixed(0)}c`);
    if (Math.abs(n.drift) >= 10) parts.push(`drifts ${signed(n.drift)}c`);
    lines.push(parts.join(' '));
  }
  if (notes.length > MOST)
    lines.push(`… ${plural(notes.length - MOST, 'more note')}: measure fewer bars ("from", "to") to see each.`);
  return lines.join('\n');
}

function loudnessLines(l: MixMeasure['loudness']): string[] {
  const out = [
    `Integrated ${num(l.integrated)} LUFS; loudest 3 s ${num(l.shortTermMax)} LUFS, loudest 400 ms ${num(l.momentaryMax)} LUFS; loudness range ${num(l.range)} LU.`,
  ];
  out.push(
    `True peak ${num(l.truePeak)} dBTP, sample peak ${num(l.samplePeak)} dBFS; ${
      l.over
        ? `${plural(l.over, 'sample')} at full scale in ${plural(l.overRuns, 'place')}: it clips`
        : 'nothing reaches full scale'
    }.`,
  );
  return out;
}

function mixText(r: MixMeasure, song: Project): string {
  const span = r.tick !== null && r.end !== null ? barsText(song, r.tick, r.end) : null;
  const lines: string[] = [];
  if (r.source === 'render')
    lines.push(`The mix, rendered${span ? `, ${span}` : ''} (${clock(r.loudness.seconds)}), as it plays: unmastered.`);
  else if (r.source === 'bounce') {
    const ago = r.made ? Math.max(0, Math.round((Date.now() - Date.parse(r.made)) / 60000)) : null;
    lines.push(
      `The newest bounce, "${r.name}" (${clock(r.loudness.seconds)}${ago !== null ? `, made ${ago < 1 ? 'just now' : ago < 120 ? `${ago} min ago` : `${Math.round(ago / 60)} h ago`}` : ''})${
        r.stale ? ': the song has changed since, so it may not be the song as it is now' : ''
      }.`,
    );
  } else lines.push(`The recording "${r.name}" (${clock(r.loudness.seconds)}).`);
  lines.push(...loudnessLines(r.loudness));
  if (r.sections.length > 1)
    lines.push(
      `By section (integrated LUFS): ${r.sections
        .map((s) => {
          const at =
            s.tick !== null && s.end !== null
              ? barsText(song, s.tick, s.end)
              : `${clock(s.at)}–${clock(s.at + s.length)}`;
          return `${s.name ? `${s.name} (${at})` : at} ${num(s.lufs)}`;
        })
        .join('; ')}.`,
    );
  if (r.octaves.some((v) => v !== null))
    lines.push(
      `Balance (octave bands, dB): ${bandsText(OCTAVES, r.octaves)}${
        r.tilt !== null
          ? `; tilt ${signed(r.tilt, 1)} dB per octave (0 is pink noise; most mixes sit between -1 and -5)`
          : ''
      }.`,
    );
  if (r.source === 'render' && song.finish)
    lines.push(
      `Bounces are mastered on top of this, to ${song.finish.lufs} LUFS with a ${song.finish.ceiling} dBTP ceiling (finish_master).`,
    );
  if (r.errors.length) lines.push(`The render reported: ${r.errors.join('; ')}`);
  return lines.join('\n');
}

function tracksText(r: TracksMeasure, song: Project): string {
  const lines = [
    `Each track alone, ${barsText(song, r.tick, r.end)}, as it reaches the master (its fader, pan and plugins in; its sends and buses out):`,
  ];
  for (const t of r.tracks) {
    const parts: string[] = [];
    if (t.silent) parts.push('nothing plays there');
    else {
      parts.push(`${num(t.lufs)} LUFS, peak ${num(t.peak)} dBFS`);
      const where = loudest(t.octaves);
      if (where) parts.push(`loudest ${where}`);
    }
    if (t.muted) parts.push('muted in the mix');
    if (t.output !== 'master') parts.push(`goes to ${t.output} in the mix`);
    if (t.source) parts.push(`its recordings ${num(t.source.lufs)} LUFS, peak ${num(t.source.peak)} dBFS`);
    lines.push(`${t.name}: ${parts.join('; ')}.`);
    if (t.thirds) lines.push(`  Third-octave bands (dB): ${bandsText(THIRDS, t.thirds, 40)}.`);
  }
  if (r.masking) {
    const a = channelName(song, r.masking.a);
    const b = channelName(song, r.masking.b);
    lines.push(
      r.masking.bands.length
        ? `${a} and ${b} compete at ${r.masking.bands
            .map(
              (m) =>
                `${hzUnit(m.hz)} (both sound there within 10 dB of each other ${pct(m.overlap)} of the time; ${
                  Math.abs(m.diff) < 0.5
                    ? 'about level'
                    : `${a} ${m.diff > 0 ? 'louder' : 'quieter'} by ${Math.abs(m.diff).toFixed(1)} dB`
                })`,
            )
            .join(', ')}.`
        : `${a} and ${b} hardly compete: no band has both sounding together a quarter of the time.`,
    );
  }
  if (r.errors.length) lines.push(`The render reported: ${r.errors.join('; ')}`);
  return lines.join('\n');
}

function pluginText(r: PluginMeasure, song: Project): string {
  const head = `${r.plugin.name} (${r.plugin.id}) on ${channelName(song, r.channel)}${r.plugin.bypass ? ', bypassed in the mix' : ''}`;
  const lines: string[] = [];
  if (r.method === 'response' && r.response) {
    const g = r.response;
    lines.push(`${head}: its response to an impulse, as set now (automation aside).`);
    const bands = THIRDS.map((c, i) => [c, g.thirds[i]] as const).filter(
      (x): x is readonly [number, number] => x[1] !== null && x[1] !== undefined && x[0] >= 20 && x[0] <= 20000,
    );
    const changed = bands.filter(([, v]) => Math.abs(v) >= 1);
    lines.push(
      changed.length
        ? `Gain by third-octave band (dB, where it's 1 dB or more): ${changed.map(([c, v]) => `${hz(c)} ${signed(v, 1)}`).join(', ')}.`
        : 'It leaves every band within 1 dB.',
    );
    if (bands.length) {
      const up = bands.reduce((a, b) => (b[1] > a[1] ? b : a));
      const down = bands.reduce((a, b) => (b[1] < a[1] ? b : a));
      if (up[1] >= 1) lines.push(`Most boost: ${signed(up[1], 1)} dB around ${hzUnit(up[0])}.`);
      if (down[1] <= -1) lines.push(`Most cut: ${signed(down[1], 1)} dB around ${hzUnit(down[0])}.`);
    }
    if (g.decay !== undefined)
      lines.push(
        `Decay (RT60) ${g.decay === null ? 'not measurable' : `${g.decay.toFixed(1)} s`}${g.predelay !== null && g.predelay !== undefined ? `, pre-delay ${g.predelay.toFixed(0)} ms` : ''}.`,
      );
    if (g.echoes)
      lines.push(
        g.echoes.length
          ? `Echoes at ${g.echoes.map(([ms, d]) => `${ms.toFixed(0)} ms (${signed(d, 1)} dB)`).join(', ')}.`
          : 'No echoes stand out.',
      );
    if (g.latency) lines.push(`It delays the sound by ${g.latency} frames (the mixer makes up for it).`);
  } else if (r.signal) {
    const s = r.signal;
    lines.push(`${head}, ${barsText(song, s.tick, s.end)}, on the sound it gets there (as set now, automation aside):`);
    if (s.gr) {
      lines.push(
        s.gr.active > 0
          ? `Gain reduction while the track plays: working ${pct(s.gr.active)} of the time; typically ${s.gr.median.toFixed(1)} dB, ${s.gr.p90.toFixed(1)} dB at the 90th percentile, ${s.gr.max.toFixed(1)} dB at most.`
          : 'It hardly works: under 0.5 dB of gain reduction all the way through.',
      );
    }
    lines.push(
      `In ${num(s.in.lufs)} LUFS (peak ${num(s.in.peak)} dBFS), out ${num(s.out.lufs)} LUFS (peak ${num(s.out.peak)} dBFS).`,
    );
    const deltas = OCTAVES.map((c, i) => {
      const a = s.octavesIn[i];
      const b = s.octavesOut[i];
      return a !== null && a !== undefined && b !== null && b !== undefined && a > -90 ? ([c, b - a] as const) : null;
    }).filter((x): x is readonly [number, number] => x !== null);
    const moved = deltas.filter(([, d]) => Math.abs(d) >= 1);
    if (moved.length)
      lines.push(`Change by octave band (dB): ${moved.map(([c, d]) => `${hz(c)} ${signed(d, 1)}`).join(', ')}.`);
  }
  if (r.errors.length) lines.push(`The render reported: ${r.errors.join('; ')}`);
  return lines.join('\n');
}

function metersText(r: MetersMeasure, song: Project): string {
  if (!r.channels.length)
    return r.playing
      ? 'The song is playing but no channel has sounded yet: measure the meters again in a few seconds.'
      : "The meters have nothing to show: the song hasn't played since the studio opened it. Start it (transport play), let it run a few seconds, then measure the meters again.";
  const pair = (p: [number | null, number | null]) => `${num(p[0])}/${num(p[1])}`;
  const covered = Math.round(r.covered);
  const watched = Math.round(r.seconds);
  const lines = [
    `The studio's meters, ${r.playing ? 'still playing' : 'stopped'}: they cover the last ${plural(covered, 'second')} of play${
      watched > covered ? ` (of ${watched} s watched since play started)` : ''
    }. Peaks left/right in dBFS over those seconds, then (max) since play started.`,
  ];
  if (covered < 3)
    lines.push(
      `That's only ${plural(covered, 'second')} of the song: play it longer, or a louder part, before judging it all.`,
    );
  for (const c of r.channels) {
    const parts = [`${pair(c.peak)} (${pair(c.max)} max)`];
    if (c.grMax !== null)
      parts.push(
        `gain reduction ${c.gr === null ? '0' : Math.abs(c.gr).toFixed(1)} dB (${Math.abs(c.grMax).toFixed(1)} max)`,
      );
    if (c.clipped) parts.push('CLIPPED (went past full scale)');
    const name = channelName(song, c.id);
    lines.push(`${name.charAt(0).toUpperCase()}${name.slice(1)}: ${parts.join('; ')}.`);
  }
  return lines.join('\n');
}

function resultText(r: MeasureResult, song: Project, middleC: MiddleC): string {
  switch (r.kind) {
    case 'take':
      return takeText(r, song, middleC);
    case 'mix':
      return mixText(r, song);
    case 'tracks':
      return tracksText(r, song);
    case 'plugin':
      return pluginText(r, song);
    case 'meters':
      return metersText(r, song);
  }
}

function pendingText(a: Extract<MeasureAnswer, { done: false }>, what: string): string {
  const left =
    a.eta === null ? '' : a.eta < 90 ? `, about ${a.eta} s left` : `, about ${Math.round(a.eta / 60)} min left`;
  return [
    `Still measuring ${what}: ${pct(a.progress)} done${left} (${a.stage}).`,
    "It goes on in HO[LO]: call measure again with the same arguments to get the result (each call waits up to 40 s). Meanwhile carry on with other work, or tell the user it is on its way; don't call it over and over.",
  ].join('\n');
}

// ---- the song's references ----

/** A region of a track by id, name, or "selected" (the studio's selection). */
async function regionRef(ctx: ToolContext, song: Project, trackId: string, text: string): Promise<string> {
  const track = song.tracks.find((t) => t.id === trackId);
  if (!track) throw new ToolError('No such track');
  if (text.toLowerCase() === 'selected') {
    const sel = (await ctx.api.state()).selection?.regions ?? [];
    const found = track.regions.find((r) => sel.includes(r.id));
    if (!found) throw new ToolError(`No region of ${track.name} is selected`);
    return found.id;
  }
  const lower = text.toLowerCase();
  const found = track.regions.find((r) => r.id === text) ?? track.regions.filter((r) => r.name.toLowerCase() === lower);
  if (!Array.isArray(found)) return found.id;
  if (found.length === 1) return (found[0] as { id: string }).id;
  if (found.length > 1)
    throw new ToolError(`${track.name} has ${found.length} regions called "${text}": say which by id`);
  throw new ToolError(
    `No region "${text}" on ${track.name}. Its regions: ${track.regions.map((r) => `${r.name} (${r.id})`).join(', ') || 'none'}`,
  );
}

/** A plugin on a channel by id, type or name ("compressor"), or the nth of a type ("compressor#2"). */
function pluginRef(channel: { name: string; channel: Project['master'] }, text: string): string {
  const inserts = channel.channel.inserts;
  const exact = inserts.find((p) => p.id === text);
  if (exact) return exact.id;
  const m = /^(.+?)(?:#(\d+))?$/.exec(text.trim().toLowerCase());
  const type = (m?.[1] ?? '').replace(/\s+/g, '');
  const nth = Number(m?.[2] ?? 1);
  const same = inserts.filter((p) => p.type.toLowerCase() === type);
  if (same.length > 1 && !m?.[2])
    throw new ToolError(`${channel.name} has ${same.length} ${type} plugins: say "${type}#1" or "${type}#2", or an id`);
  const found = same[nth - 1];
  if (found) return found.id;
  throw new ToolError(
    `No plugin "${text}" on ${channel.name}. Its plugins: ${inserts.map((p) => `${p.type} (${p.id})`).join(', ') || 'none'}`,
  );
}

const WHAT: MeasureWhat[] = ['take', 'mix', 'tracks', 'plugin', 'meters', 'file'];

export const measure: Tool = {
  name: 'measure',
  kind: 'see',
  summary:
    'Measure how the song sounds, before judging it. "what": "take" (an audio track\'s recording, one line such as a vocal: each note\'s pitch in cents against the song\'s key, or against a track\'s notes with "against", its drift and vibrato, its start against the "grid", and each phrase\'s level; quick), "mix" (the mix\'s loudness in LUFS, true peak, clipping, each section\'s loudness and its balance across octave bands; rendered, or "source": "bounce" for the newest bounce), "tracks" (each track alone: its loudness, peak and where its sound sits; with "track" one track in detail, and with "against" a second track: where the two mask each other), "plugin" (what a plugin on "track" does: an EQ\'s or a reverb\'s response, or a compressor\'s gain reduction on the track\'s own sound), "meters" (the studio\'s meters while the song plays: peaks, gain reduction, clipping; start playback first, then measure the meters: they cover the last "seconds" of playing, 8 unless you say, up to 30, and the studio waits until it has played that long), "file" (an attached recording, or the newest bounce). "from" and "to" limit it to some bars. Rendering is slower than the song plays: a call waits up to 40 s and otherwise says how far it got; call again with the same arguments for the result. Example: {"what": "take", "track": "Vocals", "from": "17", "to": "25"}.',
  args: [
    { name: 'what', type: 'enum', values: WHAT, describe: 'What to measure', required: true },
    {
      name: 'track',
      type: 'string',
      describe: 'A track (take: the recording; tracks: one track), or for plugin the track, bus or "master" it is on',
    },
    { name: 'region', type: 'string', describe: 'take: one region of the track, by name or id, or "selected"' },
    { name: 'plugin', type: 'string', describe: 'plugin: which, by id, type ("compressor") or the nth ("eq#2")' },
    { name: 'from', type: 'string', describe: 'Where to start, e.g. "17" (bar 17) or "17.3"' },
    { name: 'to', type: 'string', describe: 'Where to stop (not included), e.g. "25"' },
    {
      name: 'against',
      type: 'string',
      describe:
        'take: "key" (each note against its nearest scale tone; the default), "none" (the nearest semitone) or a track whose notes it should match; tracks: a second track, to see where the two mask each other',
    },
    {
      name: 'grid',
      type: 'enum',
      values: UNITS,
      describe: 'take: the grid starts are measured against',
      default: '1/16',
    },
    {
      name: 'source',
      type: 'enum',
      values: ['render', 'bounce'],
      describe: 'mix: render it (the default) or read the newest bounce',
    },
    { name: 'attachment', type: 'string', describe: 'take or file: an attached recording, by id (att_…)' },
    {
      name: 'seconds',
      type: 'number',
      describe: 'meters: how many seconds of playing they cover, the last of it (8 by default)',
      min: 1,
      max: 30,
    },
  ],
  async run(ctx, args) {
    const what = str(args, 'what') as MeasureWhat;
    if (what === 'meters') {
      const seconds = numArg(args, 'seconds');
      const a = await ctx.api.measure({ what, ...(seconds !== undefined ? { seconds } : {}) });
      const song = await ctx.api.song();
      return { text: a.done ? resultText(a.result, song, ctx.middleC) : pendingText(a, 'the meters') };
    }
    const song = await ctx.api.song();
    const body: MeasureBody = { what };
    const from = str(args, 'from');
    const to = str(args, 'to');
    if (from) body.from = position(song, from, '"from"');
    if (to) body.to = position(song, to, '"to"');
    if (body.from !== undefined && body.to !== undefined && body.to <= body.from)
      throw new ToolError('"to" must come after "from"');
    const trackText = str(args, 'track')?.trim();
    const against = str(args, 'against')?.trim();
    const attachment = str(args, 'attachment')?.trim();
    let label: string = what === 'mix' ? 'the mix' : what;
    switch (what) {
      case 'take': {
        if (attachment) {
          body.attachment = attachment;
          if (against && against !== 'key' && against !== 'none')
            throw new ToolError('An attached recording is measured against "key" or "none"');
          if (against) body.against = against;
          label = 'the recording';
          break;
        }
        const audio = song.tracks.filter((t) => t.kind === 'audio');
        const track = trackText
          ? trackRef(song, trackText)
          : audio.length === 1
            ? (audio[0] as Project['tracks'][number])
            : null;
        if (!track)
          throw new ToolError(
            `Say which "track": ${audio.length ? `the audio tracks are ${audio.map((t) => `"${t.name}"`).join(', ')}` : 'the song has no audio tracks (a take is a recording on one)'}`,
          );
        if (track.kind !== 'audio') throw new ToolError(`${track.name} isn't an audio track: a take is a recording`);
        body.track = track.id;
        const region = str(args, 'region')?.trim();
        if (region) body.region = await regionRef(ctx, song, track.id, region);
        if (against && against !== 'key' && against !== 'none') {
          const ref = trackRef(song, against);
          if (ref.kind !== 'instrument')
            throw new ToolError(`"against" is "key", "none" or an instrument track with notes`);
          body.against = ref.id;
        } else if (against) body.against = against;
        body.grid = unitTicks(str(args, 'grid') ?? '1/16');
        label = `the take on ${track.name}`;
        break;
      }
      case 'mix': {
        const source = str(args, 'source');
        if (source === 'render' || source === 'bounce') body.source = source;
        if (body.source === 'bounce') label = 'the bounce';
        break;
      }
      case 'tracks': {
        if (trackText) body.track = trackRef(song, trackText).id;
        if (against) {
          if (!body.track) throw new ToolError('Say which "track" to compare with the "against" track');
          body.against = trackRef(song, against).id;
        }
        label = body.track ? 'the track' : 'each track';
        break;
      }
      case 'plugin': {
        if (!trackText) throw new ToolError('Say which "track" (or bus, or "master") the plugin is on');
        const ch = channelRef(song, trackText);
        const pluginText = str(args, 'plugin')?.trim();
        if (!pluginText)
          throw new ToolError(
            `Say which "plugin": on ${ch.name}, ${ch.channel.inserts.map((p) => `${p.type} (${p.id})`).join(', ') || 'there are none'}`,
          );
        body.track = ch.id;
        body.plugin = pluginRef(ch, pluginText);
        label = `the plugin on ${ch.name}`;
        break;
      }
      case 'file': {
        if (attachment) body.attachment = attachment;
        else body.source = 'bounce';
        label = attachment ? 'the recording' : 'the bounce';
        break;
      }
    }
    const answer = await ctx.api.measure(body);
    if (!answer.done) return { text: pendingText(answer, label) };
    return { text: resultText(answer.result, song, ctx.middleC) };
  },
};

export const measureTools: Tool[] = [measure];
