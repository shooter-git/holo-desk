/**
 * Changes to a session, as plain JSON. The studio's own edits, the AI's and the command line's are
 * all operations, applied by this one function, so they behave the same wherever they're applied:
 * in the open studio (with an undo step) or on the server when no studio has the song open.
 */
import type {
  AudioFile,
  Bus,
  CCPoint,
  Channel,
  Finish,
  Loop,
  Note,
  Plugin,
  Project,
  Region,
  Seat,
  Stage,
  Track,
} from './types.ts';

/** The song's settings to change; `finish: null` or `loop: null` takes them away. */
export type ProjectPatch = Partial<
  Pick<Project, 'title' | 'key' | 'notes' | 'cycle' | 'tempo' | 'meter' | 'markers' | 'chords' | 'sampleRate'>
> & { finish?: Finish | null; loop?: Loop | null };
export type TrackPatch = Partial<Omit<Track, 'id' | 'kind' | 'regions' | 'channel'>>;
export type RegionPatch = Partial<Omit<Region, 'id' | 'notes' | 'cc'>>;
/** A channel's settings to change; `stage: null` takes it off its stage. */
export type ChannelPatch = Partial<Omit<Channel, 'inserts' | 'stage'>> & { stage?: Stage | null };

export type Op =
  | { op: 'setProject'; patch: ProjectPatch }
  | { op: 'addTrack'; track: Track; index?: number }
  | { op: 'removeTrack'; track: string }
  | { op: 'moveTrack'; track: string; index: number }
  | { op: 'updateTrack'; track: string; patch: TrackPatch }
  /** `target` is a track id, a bus id or "master". */
  | { op: 'updateChannel'; target: string; patch: ChannelPatch }
  | { op: 'addPlugin'; target: string; slot: 'inserts' | 'midiFx'; plugin: Plugin; index?: number }
  | {
      op: 'updatePlugin';
      target: string;
      plugin: string;
      patch: { bypass?: boolean; params?: Record<string, number>; settings?: Record<string, string> };
    }
  | { op: 'removePlugin'; target: string; plugin: string }
  | { op: 'movePlugin'; target: string; plugin: string; index: number }
  | { op: 'addBus'; bus: Bus }
  | { op: 'removeBus'; bus: string }
  | { op: 'updateBus'; bus: string; patch: Partial<Pick<Bus, 'name' | 'color'>> }
  | { op: 'addRegion'; track: string; region: Region }
  | { op: 'updateRegion'; track: string; region: string; patch: RegionPatch }
  | { op: 'removeRegion'; track: string; region: string }
  | { op: 'moveRegion'; from: string; to: string; region: string; start?: number }
  | { op: 'setNotes'; track: string; region: string; notes: Note[] }
  | { op: 'addNotes'; track: string; region: string; notes: Note[] }
  | { op: 'setCC'; track: string; region: string; lane: string; points: CCPoint[] }
  /** `target` a track id, a bus id or "master"; no points removes the lane. */
  | {
      op: 'setAutomation';
      target: string;
      param: string;
      points: [number, number][];
      mode?: 'read' | 'off';
      curve?: 'linear' | 'smooth';
    }
  | { op: 'addFile'; file: AudioFile };

export class OpError extends Error {}

const byStart = (a: Note, b: Note) => a.t - b.t || a.p - b.p;

function mapTrack(project: Project, id: string, fn: (t: Track) => Track): Project {
  const index = project.tracks.findIndex((t) => t.id === id);
  if (index < 0) throw new OpError(`No track "${id}"`);
  const tracks = project.tracks.slice();
  tracks[index] = fn(tracks[index] as Track);
  return { ...project, tracks };
}

/** A track whose music changed: if it came from a creation, the creation must take these notes. */
function edited(track: Track): Track {
  return track.origin && !track.origin.edited ? { ...track, origin: { ...track.origin, edited: true } } : track;
}

function mapRegion(track: Track, id: string, fn: (r: Region) => Region): Track {
  const index = track.regions.findIndex((r) => r.id === id);
  if (index < 0) throw new OpError(`No region "${id}" on track "${track.name}"`);
  const regions = track.regions.slice();
  regions[index] = fn(regions[index] as Region);
  return edited({ ...track, regions });
}

function mapChannel(project: Project, target: string, fn: (c: Channel) => Channel): Project {
  if (target === 'master') return { ...project, master: fn(project.master) };
  const bus = project.buses.findIndex((b) => b.id === target);
  if (bus >= 0) {
    const buses = project.buses.slice();
    const b = buses[bus] as Bus;
    buses[bus] = { ...b, channel: fn(b.channel) };
    return { ...project, buses };
  }
  return mapTrack(project, target, (t) => ({ ...t, channel: fn(t.channel) }));
}

function pluginSlot(project: Project, target: string, plugin: string): 'inserts' | 'midiFx' {
  const track = project.tracks.find((t) => t.id === target);
  return track?.midiFx.some((p) => p.id === plugin) ? 'midiFx' : 'inserts';
}

function mapPlugins(
  project: Project,
  target: string,
  slot: 'inserts' | 'midiFx',
  fn: (list: Plugin[]) => Plugin[],
): Project {
  if (slot === 'midiFx') return mapTrack(project, target, (t) => ({ ...t, midiFx: fn(t.midiFx) }));
  return mapChannel(project, target, (c) => ({ ...c, inserts: fn(c.inserts) }));
}

function move<T>(list: T[], from: number, to: number): T[] {
  const out = list.slice();
  const [item] = out.splice(from, 1);
  if (item !== undefined) out.splice(Math.max(0, Math.min(out.length, to)), 0, item);
  return out;
}

export function applyOp(project: Project, op: Op): Project {
  switch (op.op) {
    case 'setProject': {
      const { finish, loop, ...rest } = op.patch;
      const next: Project = { ...project, ...rest };
      if (finish === null) delete next.finish;
      else if (finish) next.finish = finish;
      if (loop === null) delete next.loop;
      else if (loop) next.loop = loop;
      return next;
    }
    case 'addTrack': {
      if (project.tracks.some((t) => t.id === op.track.id)) throw new OpError(`Track "${op.track.id}" exists`);
      const tracks = project.tracks.slice();
      tracks.splice(op.index ?? tracks.length, 0, op.track);
      return { ...project, tracks };
    }
    case 'removeTrack':
      if (!project.tracks.some((t) => t.id === op.track)) throw new OpError(`No track "${op.track}"`);
      return { ...project, tracks: project.tracks.filter((t) => t.id !== op.track) };
    case 'moveTrack': {
      const from = project.tracks.findIndex((t) => t.id === op.track);
      if (from < 0) throw new OpError(`No track "${op.track}"`);
      return { ...project, tracks: move(project.tracks, from, op.index) };
    }
    case 'updateTrack':
      return mapTrack(project, op.track, (t) => ({ ...t, ...op.patch }));
    case 'updateChannel':
      return mapChannel(project, op.target, (c) => {
        const { stage, ...rest } = op.patch;
        const next: Channel = { ...c, ...rest };
        if (stage === null) delete next.stage;
        else if (stage) next.stage = stage;
        return next;
      });
    case 'addPlugin':
      return mapPlugins(project, op.target, op.slot, (list) => {
        const out = list.slice();
        out.splice(op.index ?? out.length, 0, op.plugin);
        return out;
      });
    case 'updatePlugin':
      return mapPlugins(project, op.target, pluginSlot(project, op.target, op.plugin), (list) => {
        if (!list.some((p) => p.id === op.plugin)) throw new OpError(`No plugin "${op.plugin}"`);
        return list.map((p) =>
          p.id === op.plugin
            ? {
                ...p,
                bypass: op.patch.bypass ?? p.bypass,
                params: op.patch.params ? { ...p.params, ...op.patch.params } : p.params,
                ...(op.patch.settings || p.settings ? { settings: { ...p.settings, ...op.patch.settings } } : {}),
              }
            : p,
        );
      });
    case 'removePlugin':
      return mapPlugins(project, op.target, pluginSlot(project, op.target, op.plugin), (list) =>
        list.filter((p) => p.id !== op.plugin),
      );
    case 'movePlugin':
      return mapPlugins(project, op.target, pluginSlot(project, op.target, op.plugin), (list) =>
        move(
          list,
          list.findIndex((p) => p.id === op.plugin),
          op.index,
        ),
      );
    case 'addBus':
      return { ...project, buses: [...project.buses, op.bus] };
    case 'removeBus': {
      const unseat = (seat: Seat): Seat => ({ ...seat, sends: seat.sends.filter((s) => s.bus !== op.bus) });
      const unsend = (c: Channel): Channel => ({
        ...c,
        sends: c.sends.filter((s) => s.bus !== op.bus),
        output: c.output === op.bus ? 'master' : c.output,
        ...(c.stage ? { stage: { ...c.stage, near: unseat(c.stage.near), far: unseat(c.stage.far) } } : {}),
      });
      return {
        ...project,
        buses: project.buses.filter((b) => b.id !== op.bus).map((b) => ({ ...b, channel: unsend(b.channel) })),
        tracks: project.tracks.map((t) => ({ ...t, channel: unsend(t.channel) })),
      };
    }
    case 'updateBus':
      return {
        ...project,
        buses: project.buses.map((b) => (b.id === op.bus ? { ...b, ...op.patch } : b)),
      };
    case 'addRegion':
      return mapTrack(project, op.track, (t) =>
        edited({ ...t, regions: [...t.regions, { ...op.region, notes: op.region.notes.slice().sort(byStart) }] }),
      );
    case 'updateRegion':
      return mapTrack(project, op.track, (t) => mapRegion(t, op.region, (r) => ({ ...r, ...op.patch })));
    case 'removeRegion':
      return mapTrack(project, op.track, (t) => {
        if (!t.regions.some((r) => r.id === op.region)) throw new OpError(`No region "${op.region}"`);
        return edited({ ...t, regions: t.regions.filter((r) => r.id !== op.region) });
      });
    case 'moveRegion': {
      const source = project.tracks.find((t) => t.id === op.from);
      const region = source?.regions.find((r) => r.id === op.region);
      if (!source || !region) throw new OpError(`No region "${op.region}" on track "${op.from}"`);
      const moved = { ...region, start: op.start ?? region.start };
      if (op.from === op.to) {
        return mapTrack(project, op.from, (t) => mapRegion(t, op.region, () => moved));
      }
      const without = mapTrack(project, op.from, (t) =>
        edited({ ...t, regions: t.regions.filter((r) => r.id !== op.region) }),
      );
      return mapTrack(without, op.to, (t) => edited({ ...t, regions: [...t.regions, moved] }));
    }
    case 'setNotes':
      return mapTrack(project, op.track, (t) =>
        mapRegion(t, op.region, (r) => ({ ...r, notes: op.notes.slice().sort(byStart) })),
      );
    case 'addNotes':
      return mapTrack(project, op.track, (t) =>
        mapRegion(t, op.region, (r) => ({ ...r, notes: [...r.notes, ...op.notes].sort(byStart) })),
      );
    case 'setCC':
      return mapTrack(project, op.track, (t) =>
        mapRegion(t, op.region, (r) => {
          const cc = { ...r.cc };
          if (op.points.length) cc[op.lane] = op.points.slice().sort((a, b) => a[0] - b[0]);
          else delete cc[op.lane];
          return { ...r, cc };
        }),
      );
    case 'addFile':
      if (project.files?.some((f) => f.id === op.file.id)) return project;
      return { ...project, files: [...(project.files ?? []), op.file] };
    case 'setAutomation':
      return mapChannel(project, op.target, (c) => {
        const others = (c.automation ?? []).filter((a) => a.param !== op.param);
        const prev = c.automation?.find((a) => a.param === op.param);
        if (!op.points.length) return { ...c, automation: others };
        const curve = op.curve ?? prev?.curve;
        const lane = {
          param: op.param,
          points: op.points.slice().sort((a, b) => a[0] - b[0]),
          mode: op.mode ?? prev?.mode ?? ('read' as const),
          ...(curve === 'smooth' ? { curve } : {}),
        };
        return { ...c, automation: [...others, lane] };
      });
    default: {
      const unknown: never = op;
      throw new OpError(`Unknown operation ${JSON.stringify(unknown)}`);
    }
  }
}

export function applyOps(project: Project, ops: readonly Op[]): Project {
  return ops.reduce(applyOp, project);
}

/** Find a track by id, by exact name, or by a name it starts with (case aside). */
export function findTrack(project: Project, ref: string): Track | undefined {
  const lower = ref.toLowerCase();
  return (
    project.tracks.find((t) => t.id === ref) ??
    project.tracks.find((t) => t.name.toLowerCase() === lower) ??
    project.tracks.find((t) => t.name.toLowerCase().startsWith(lower))
  );
}
