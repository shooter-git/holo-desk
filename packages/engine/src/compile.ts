/** A session, turned into what the audio thread plays: tempo segments, event lists and the mixer graph. */
import {
  type AudioClip,
  automationTargets,
  type Channel,
  type Instrument,
  PPQ,
  type Project,
  type Track,
  ticksPerBar,
  ticksPerBeat,
} from '@holo/session';
import {
  type ChannelSpec,
  type ClipSpec,
  EV_BEND,
  EV_CC,
  EV_OFF,
  EV_ON,
  EV_PRESSURE,
  EVENT_SIZE,
  type GraphSpec,
  type InstrumentSpec,
  type TempoSegment,
  type TrackSpec,
} from './protocol.ts';
import { type ImpulseSource, pluginImpulses } from './space.ts';

export function compileTempo(project: Project, sr: number): TempoSegment[] {
  const out: TempoSegment[] = [];
  let frame = 0;
  project.tempo.forEach((t, i) => {
    const framesPerTick = (60 / t.bpm / PPQ) * sr;
    out.push({ frame, tick: t.tick, framesPerTick });
    const next = project.tempo[i + 1];
    if (next) frame += (next.tick - t.tick) * framesPerTick;
  });
  return out;
}

export function tickToFrame(segments: readonly TempoSegment[], tick: number): number {
  let seg = segments[0] as TempoSegment;
  for (const s of segments) {
    if (s.tick > tick) break;
    seg = s;
  }
  return seg.frame + (tick - seg.tick) * seg.framesPerTick;
}

export function frameToTick(segments: readonly TempoSegment[], frame: number): number {
  let seg = segments[0] as TempoSegment;
  for (const s of segments) {
    if (s.frame > frame) break;
    seg = s;
  }
  return seg.tick + (frame - seg.frame) / seg.framesPerTick;
}

export function instrumentSpec(i: Instrument): InstrumentSpec {
  // a Performance instrument's live notes play on its pack's plain sampler (its parts play as planned)
  if (i.type === 'sampler' || i.type === 'performance') return { kind: 'sampler', key: `${i.pack}/${i.name}` };
  if (i.type === 'glass') return { kind: 'synth', preset: 'Soft Keys' };
  if (i.type === 'synth') {
    if (i.preset === 'Drum Synth') return { kind: 'drums' };
    return i.params ? { kind: 'synth', preset: i.preset, params: i.params } : { kind: 'synth', preset: i.preset };
  }
  return { kind: 'none' };
}

/** A track's notes and controllers as [frame, kind, a, b, articulation] in frame order. */
export function compileTrack(track: Track, segments: readonly TempoSegment[]): Float64Array {
  const rows: number[][] = [];
  const artIndex = new Map(track.articulations.map((a, i) => [a.id, i + 1]));
  for (const region of track.regions) {
    if (region.muted) continue;
    const end = region.start + region.length;
    for (const n of region.notes) {
      const on = region.start + n.t;
      if (on >= end) continue;
      const off = Math.min(end, on + n.d);
      const art = n.art ? (artIndex.get(n.art) ?? 0) : 0;
      // note-offs sort before note-ons at the same frame, so a repeated note re-strikes
      rows.push([tickToFrame(segments, on), EV_ON, n.p, n.v, art]);
      rows.push([tickToFrame(segments, off) - 0.001, EV_OFF, n.p, 0, art]);
    }
    for (const [lane, points] of Object.entries(region.cc)) {
      for (const [t, v] of points) {
        if (t < 0 || t > region.length) continue;
        const frame = tickToFrame(segments, region.start + t);
        if (lane === 'pb') rows.push([frame, EV_BEND, v, 0, 0]);
        else if (lane === 'at') rows.push([frame, EV_PRESSURE, v, 0, 0]);
        else rows.push([frame, EV_CC, Number(lane), v, 0]);
      }
    }
  }
  rows.sort((a, b) => (a[0] as number) - (b[0] as number) || (a[1] as number) - (b[1] as number));
  const out = new Float64Array(rows.length * EVENT_SIZE);
  for (let i = 0; i < rows.length; i++) out.set(rows[i] as number[], i * EVENT_SIZE);
  return out;
}

/** The engine-side key of a clip's audio: the file, or the file stretched. */
export const clipKey = (clip: Pick<AudioClip, 'file' | 'stretch'>): string =>
  Math.abs(clip.stretch - 1) < 1e-4 ? clip.file : `${clip.file}@${clip.stretch.toFixed(4)}`;

/**
 * An audio track's regions as clips in song frames, in start order. Like Logic, a track plays one
 * region at a time: where regions overlap, the later one (drawn on top, the newer take) is heard.
 */
export function compileClips(track: Track, segments: readonly TempoSegment[], sr: number): ClipSpec[] {
  if (track.kind !== 'audio') return [];
  const out: ClipSpec[] = [];
  const covered: [number, number][] = [];
  for (let i = track.regions.length - 1; i >= 0; i--) {
    const r = track.regions[i] as Track['regions'][number];
    const a = r.audio;
    if (!a || r.muted) continue;
    const start = Math.round(tickToFrame(segments, r.start));
    const end = Math.round(tickToFrame(segments, r.start + r.length));
    let pieces: [number, number][] = [[start, end]];
    for (const [c0, c1] of covered) {
      pieces = pieces.flatMap(([s, e]): [number, number][] =>
        c1 <= s || c0 >= e
          ? [[s, e]]
          : [...(c0 > s ? [[s, c0] as [number, number]] : []), ...(c1 < e ? [[c1, e] as [number, number]] : [])],
      );
    }
    const source = Math.round(a.offset * a.stretch * sr);
    for (const [s, e] of pieces) {
      if (e <= s) continue;
      out.push({
        key: clipKey(a),
        start: s,
        end: e,
        source: source + (s - start),
        regionStart: start,
        regionEnd: end,
        gain: 10 ** (a.gain / 20),
        fadeIn: Math.round(a.fadeIn * sr),
        fadeOut: Math.round(a.fadeOut * sr),
      });
    }
    covered.push([start, end]);
  }
  return out.sort((x, y) => x.start - y.start);
}

/** Every clip of a song, one per key: what the engine needs loaded. */
export function songClips(project: Project): AudioClip[] {
  const keys = new Map<string, AudioClip>();
  for (const t of project.tracks) {
    if (t.kind !== 'audio') continue;
    for (const r of t.regions) if (r.audio) keys.set(clipKey(r.audio), r.audio);
  }
  // plugins' data in the song's files: a Wow & Flutter's drift curve
  const channels = [project.master, ...project.buses.map((b) => b.channel), ...project.tracks.map((t) => t.channel)];
  for (const c of channels) {
    for (const p of c.inserts) {
      const file = p.type === 'wow' ? p.settings?.curve : undefined;
      if (file)
        keys.set(clipKey({ file, stretch: 1 }), { file, offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 });
    }
  }
  return [...keys.values()];
}

function channelSpec(
  num: number,
  id: string,
  c: Channel,
  project: Project,
  segments: readonly TempoSegment[],
): ChannelSpec {
  const targets = c.automation?.length ? automationTargets(project, c) : [];
  return {
    num,
    id,
    volume: c.volume,
    pan: c.pan,
    mute: c.mute,
    inserts: c.inserts.map((p) => ({
      id: p.id,
      type: p.type,
      bypass: p.bypass,
      params: p.params,
      ...(p.settings ? { settings: p.settings } : {}),
    })),
    sends: c.sends.map((s) => ({ bus: s.bus, level: s.level, pre: s.pre })),
    output: c.output,
    automation: (c.automation ?? [])
      .filter((a) => a.mode === 'read' && a.points.length)
      .map((a) => ({
        param: a.param,
        // frames as they fall (not rounded), so a curve lands where it's drawn to the sample
        points: a.points.flatMap(([t, v]) => [tickToFrame(segments, t), v]),
        stepped: targets.find((x) => x.param === a.param)?.stepped ?? a.param === 'mute',
        ...(a.curve === 'smooth' ? { smooth: true } : {}),
      })),
    ...(c.stage ? { stage: c.stage } : {}),
  };
}

export function compileGraph(
  project: Project,
  numOf: (id: string) => number,
  segments: readonly TempoSegment[],
): GraphSpec {
  const tracks: TrackSpec[] = project.tracks.map((t) => ({
    ...channelSpec(numOf(t.id), t.id, t.channel, project, segments),
    instrument: instrumentSpec(t.instrument),
    articulations: t.articulations.map((a) => instrumentSpec(a.instrument)),
    midiFx: t.midiFx.map((p) => ({ id: p.id, type: p.type, bypass: p.bypass, params: p.params })),
  }));
  const anySolo = project.tracks.some((t) => t.channel.solo);
  return {
    tracks,
    buses: mixOrder(project).map((b) => channelSpec(numOf(b.id), b.id, b.channel, project, segments)),
    master: channelSpec(0, 'master', project.master, project, segments),
    // buses stay audible when something is soloed (a soloed track still reaches its reverb)
    soloed: anySolo
      ? [...project.tracks.filter((t) => t.channel.solo).map((t) => t.id), ...project.buses.map((b) => b.id)]
      : null,
  };
}

/**
 * The buses in the order they're mixed: each after every bus that feeds it (by its output, its sends
 * or a stage's seats), so whatever reaches a bus arrives in the same block. A loop of buses keeps the
 * session's order where it closes.
 */
function mixOrder(project: Project): Project['buses'] {
  const feeds = new Map<string, Set<string>>();
  for (const b of project.buses) {
    const c = b.channel;
    const to = [
      c.output,
      ...c.sends.map((s) => s.bus),
      ...(c.stage ? [c.stage.near, c.stage.far] : []).flatMap((s) => s.sends.map((x) => x.bus)),
    ];
    for (const d of to) {
      if (!d || d === b.id) continue;
      if (!feeds.has(d)) feeds.set(d, new Set());
      feeds.get(d)?.add(b.id);
    }
  }
  const out: Project['buses'] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const byId = new Map(project.buses.map((b) => [b.id, b]));
  const visit = (id: string) => {
    if (state.get(id)) return;
    state.set(id, 'visiting');
    for (const src of feeds.get(id) ?? []) if (!state.get(src)) visit(src);
    state.set(id, 'done');
    const b = byId.get(id);
    if (b) out.push(b);
  };
  for (const b of project.buses) visit(b.id);
  return out;
}

export function meterTicks(project: Project): { beatTicks: number; barTicks: number } {
  const m = project.meter[0] ?? { tick: 0, num: 4, den: 4 };
  return { beatTicks: ticksPerBeat(m), barTicks: ticksPerBar(m) };
}

/** Every response a song's spaces need at a rate (Space Designer's, Shimmer's), once each. */
export function songImpulses(project: Project, rate: number): { key: string; source: ImpulseSource }[] {
  const out = new Map<string, ImpulseSource>();
  const channels = [project.master, ...project.buses.map((b) => b.channel), ...project.tracks.map((t) => t.channel)];
  for (const c of channels) {
    for (const p of c.inserts) {
      for (const want of pluginImpulses(p.type, p.params, p.settings, rate)) out.set(want.key, want.source);
    }
  }
  return [...out].map(([key, source]) => ({ key, source }));
}
