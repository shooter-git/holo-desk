/**
 * Sessions as text a person or the AI can read: an overview, and a track's notes bar by bar.
 */
import { automationTargets } from './automation.ts';
import { type MiddleC, noteName } from './notation.ts';
import { pluginDef } from './plugins.ts';
import { formatBarBeat, meterAt, tickToBarBeat, tickToSeconds } from './time.ts';
import type { Instrument, Note, Project, Track } from './types.ts';
import { projectEnd } from './validate.ts';

export function describeInstrument(i: Instrument): string {
  if (i.type === 'sampler') return `${i.pack}/${i.name}`;
  if (i.type === 'synth') return `synth "${i.preset}"`;
  return 'no instrument';
}

function describeInput(t: Track): string {
  const i = t.audioInput ?? { input: 0, channels: 1 };
  return i.channels === 2 ? `${i.input + 1}-${i.input + 2}` : `${i.input + 1}`;
}

const db = (v: number) => (v <= -144 ? '-∞' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`);

export function describeProject(project: Project): string {
  const end = projectEnd(project);
  const bars = tickToBarBeat(project.meter, end - 1).bar;
  const m = project.meter[0];
  const lines = [
    `"${project.title}" (id ${project.id}, revision ${project.revision})`,
    `  ${project.tempo.map((t) => `${t.bpm} bpm at ${formatBarBeat(project.meter, t.tick)}`).join(', ')}; ` +
      `${project.meter.map((x) => `${x.num}/${x.den}${x.groups ? ` (${x.groups.join('+')})` : ''}`).join(', ')}; ` +
      `${project.key ?? 'no key set'}; ${bars} bars, ${tickToSeconds(project.tempo, end).toFixed(1)} s`,
    `  cycle ${project.cycle.on ? 'on' : 'off'}: ${formatBarBeat(project.meter, project.cycle.start)} to ${formatBarBeat(project.meter, project.cycle.end)}`,
  ];
  if (m?.groups) lines.push(`  felt as ${m.groups.join('+')}`);
  if (project.loop) {
    lines.push(
      `  a loop: ${formatBarBeat(project.meter, project.loop.start)} to ${formatBarBeat(project.meter, project.loop.end)}` +
        ` (renders play it as it loops forever), then ${project.loop.tail} s of its start`,
    );
  }
  if (project.finish) {
    const f = project.finish;
    lines.push(
      `  finished to ${f.lufs} LUFS under ${f.ceiling} dBTP${f.glue ? ', glued' : ''} (low cut ${f.lowcut} Hz, tilt ${f.tilt > 0 ? '+' : ''}${f.tilt} dB)`,
    );
  }
  if (project.sampleRate) lines.push(`  renders at ${project.sampleRate} Hz`);
  if (project.origin) {
    lines.push(`  from ${project.origin.creation} / ${project.origin.piece}, sent ${project.origin.exportedAt}`);
  }
  if (project.markers.length) {
    lines.push(
      `  markers: ${project.markers.map((x) => `${formatBarBeat(project.meter, x.tick)} "${x.name}"`).join('; ')}`,
    );
  }
  lines.push('Tracks:');
  project.tracks.forEach((t, i) => {
    const notes = t.regions.reduce((n, r) => n + r.notes.length, 0);
    const span = t.regions.length
      ? `bars ${tickToBarBeat(project.meter, Math.min(...t.regions.map((r) => r.start))).bar}–${
          tickToBarBeat(project.meter, Math.max(...t.regions.map((r) => r.start + r.length)) - 1).bar
        }`
      : 'empty';
    const flags = [
      t.channel.mute && 'muted',
      t.channel.solo && 'solo',
      t.armed && 'armed',
      t.origin?.edited && 'edited here',
      t.origin?.locked && 'locked',
    ].filter(Boolean);
    const what =
      t.kind === 'audio'
        ? `audio track (input ${describeInput(t)}); ${t.regions.length} region(s), ${span}`
        : `${describeInstrument(t.instrument)}; ${t.regions.length} region(s), ${notes} notes, ${span}`;
    lines.push(
      `  ${i + 1}. ${t.name} [${t.id}] ${what}; ` +
        `${db(t.channel.volume)}, pan ${Math.round(t.channel.pan * 64)}${flags.length ? `; ${flags.join(', ')}` : ''}`,
    );
    if (t.kind === 'audio') {
      for (const r of t.regions) {
        const a = r.audio;
        if (!a) continue;
        const file = project.files?.find((f) => f.id === a.file);
        const extras = [
          a.offset > 0 && `from ${a.offset.toFixed(2)} s`,
          a.gain !== 0 && db(a.gain),
          a.stretch !== 1 && `stretched ×${a.stretch.toFixed(3)}`,
          a.fadeIn > 0 && `fade in ${a.fadeIn.toFixed(2)} s`,
          a.fadeOut > 0 && `fade out ${a.fadeOut.toFixed(2)} s`,
          r.muted && 'muted',
        ].filter(Boolean);
        lines.push(
          `     region ${r.id} at ${formatBarBeat(project.meter, r.start)}: "${file?.name ?? a.file}"` +
            `${extras.length ? ` (${extras.join(', ')})` : ''}`,
        );
      }
    }
    const fx = [...t.midiFx, ...t.channel.inserts].map((p) => pluginDef(p.type)?.name ?? p.type);
    if (fx.length) lines.push(`     plugins: ${fx.join(' → ')}`);
    const st = t.channel.stage;
    if (st) {
      const bus = (id: string) => project.buses.find((b) => b.id === id)?.name ?? id;
      const seat = (s: typeof st.near) =>
        `depth ${Math.round(s.depth * 100)}%${s.sends.length ? `, ${s.sends.map((x) => `${bus(x.bus)} ${db(x.level)}`).join(', ')}` : ''}`;
      lines.push(
        `     stage: distance ${Math.round(st.distance * 100)}%; near (${seat(st.near)}); far (${seat(st.far)})`,
      );
    }
    if (t.channel.automation?.length) {
      const targets = automationTargets(project, t.channel);
      const lanes = t.channel.automation.map(
        (a) =>
          `${targets.find((x) => x.param === a.param)?.name ?? a.param} (${a.points.length} points${a.curve === 'smooth' ? ', smooth' : ''}${a.mode === 'off' ? ', off' : ''})`,
      );
      lines.push(`     automation: ${lanes.join('; ')}`);
    }
  });
  if (project.buses.length) {
    lines.push('Buses:');
    for (const b of project.buses) {
      const fx = b.channel.inserts.map((p) => pluginDef(p.type)?.name ?? p.type);
      lines.push(`  ${b.name} [${b.id}] ${db(b.channel.volume)}${fx.length ? `; ${fx.join(' → ')}` : ''}`);
    }
  }
  return lines.join('\n');
}

export interface NoteListOptions {
  from?: number;
  to?: number;
  middleC?: MiddleC;
}

/** A track's notes in order, one per line: position, name (MIDI number), length in ticks, velocity. */
export function describeNotes(project: Project, track: Track, options: NoteListOptions = {}): string {
  const { from = 0, to = Number.POSITIVE_INFINITY, middleC = 'C4' } = options;
  const all: { at: number; n: Note; region: string }[] = [];
  for (const r of track.regions) {
    for (const n of r.notes) {
      const at = r.start + n.t;
      if (at >= from && at < to) all.push({ at, n, region: r.id });
    }
  }
  all.sort((a, b) => a.at - b.at || a.n.p - b.n.p);
  const lines = [
    `${track.name} [${track.id}]: ${all.length} notes (positions bar.beat.sixteenth.tick; 960 ticks = a quarter)`,
  ];
  let bar = -1;
  for (const { at, n, region } of all) {
    const pos = tickToBarBeat(project.meter, at);
    if (pos.bar !== bar) {
      bar = pos.bar;
      const m = meterAt(project.meter, at);
      lines.push(`bar ${bar} (${m.num}/${m.den})`);
    }
    const art = n.art ? ` art=${n.art}` : '';
    lines.push(
      `  ${pos.bar}.${pos.beat}.${pos.div}.${pos.tick}  ${noteName(n.p, middleC)} (${n.p})  len ${n.d}  vel ${Math.round(n.v)}${art}  [${region}]`,
    );
  }
  return lines.join('\n');
}
