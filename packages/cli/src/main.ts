#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * holo: HO[LO] Desk from the command line. Everything it changes goes through the open studio when
 * there is one (so you see and hear it at once, and can undo it), or straight to the saved song.
 * Run `holo help` for the commands.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DIVISIONS,
  findTrack,
  formatBarBeat,
  type Instrument,
  type MiddleC,
  meterAt,
  type Note,
  newAudioTrack,
  newPlugin,
  newRegion,
  newTrack,
  noteName,
  type Op,
  PLUGINS,
  PPQ,
  type Project,
  parseNotation,
  parsePosition,
  parseProject,
  pluginDef,
  SYNTH_PRESETS,
  secondsToTick,
  TRACK_COLORS,
  ticksPerBar,
  tickToSeconds,
} from '@holo/session';

const BASE = (process.env.HOLO_URL ?? `http://127.0.0.1:${process.env.HOLO_PORT ?? 47800}`).replace(/\/$/, '');
const AUTHOR = process.env.HOLO_AUTHOR ?? 'AI';

// ---- arguments ----

const argv = process.argv.slice(2);
const command = argv.shift() ?? 'help';
const flags = new Map<string, string | true>();
const words: string[] = [];
/** Flags that never take a value. */
const SWITCHES = new Set(['replace', 'new', 'help', 'no-wait', 'smooth', 'linear', 'no-finish', 'no-loop']);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] as string;
  if (a.startsWith('--')) {
    const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
    const next = argv[i + 1];
    if (inline !== undefined) flags.set(k, inline);
    else if (SWITCHES.has(k)) flags.set(k, true);
    else if (next !== undefined && !next.startsWith('--')) {
      flags.set(k, next);
      i++;
    } else flags.set(k, true);
  } else words.push(a);
}
const flag = (k: string): string | undefined => {
  const v = flags.get(k);
  return v === true ? '' : v;
};
const has = (k: string) => flags.has(k);

// ---- the server ----

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json', ...init?.headers } : init?.headers,
    });
  } catch {
    throw new Error(`HO[LO] isn't answering at ${BASE}. Start it (pnpm dev, or pnpm up for Docker) or set HOLO_URL.`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // plain text
    }
    throw new Error(msg || `${res.status} ${res.statusText}`);
  }
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('json') ? JSON.parse(text) : text) as T;
}

interface LiveState {
  editor: boolean;
  state: {
    project: string | null;
    title: string | null;
    playing: boolean;
    recording: boolean;
    tick: number;
    position: string;
    bpm: number;
    selection: { track: string | null; regions: string[]; notes: number };
    cycle: { on: boolean; start: number; end: number };
    middleC: MiddleC;
    midiPorts: string[];
    latencyMs: number | null;
    device: string;
  } | null;
  peers: { role: string; name: string }[];
}

const live = () => call<LiveState>('/api/live/state');

/** The song to work on: --song, else the one open in the studio, else the most recent. */
async function songId(): Promise<string> {
  const given = flag('song');
  if (given) return given;
  const l = await live();
  if (l.state?.project) return l.state.project;
  const rows = await call<{ id: string }[]>('/api/projects');
  if (!rows[0]) throw new Error('There are no songs yet: make one with `holo new "Title"`');
  return rows[0].id;
}

const song = async (): Promise<Project> => call<Project>(`/api/projects/${await songId()}`);

async function ops(project: Project, list: Op[], label: string): Promise<void> {
  const r = await call<{ via: string; revision?: number }>(`/api/projects/${project.id}/ops`, {
    method: 'POST',
    body: JSON.stringify({ ops: list, author: AUTHOR, label }),
  });
  console.log(
    `${label} (${r.via === 'studio' ? 'in the open studio' : 'saved'}${r.revision ? `, revision ${r.revision}` : ''})`,
  );
}

// ---- helpers ----

const names = (): MiddleC => (flag('names') === 'logic' ? 'C3' : 'C4');

function unitTicks(): number {
  const u = flag('unit') ?? '1/8';
  const t = DIVISIONS[u];
  if (!t) throw new Error(`--unit must be one of ${Object.keys(DIVISIONS).join(', ')}`);
  return t;
}

function parseInstrument(spec: string): Instrument {
  if (spec.startsWith('synth:')) return { type: 'synth', preset: spec.slice(6) };
  if ((SYNTH_PRESETS as readonly string[]).includes(spec)) return { type: 'synth', preset: spec };
  const [pack, name] = spec.split('/');
  if (pack && name) return { type: 'sampler', pack, name };
  throw new Error(
    `Instrument "${spec}": use a preset ("synth:Warm Pad") or pack/name ("vsco2/violins_pizz"); \`holo instruments\` lists them`,
  );
}

function trackOf(project: Project, ref: string | undefined) {
  if (!ref) {
    throw new Error(`Say which track (--track NAME). Tracks: ${project.tracks.map((t) => t.name).join(', ')}`);
  }
  const t = findTrack(project, ref);
  if (!t) throw new Error(`No track "${ref}". Tracks: ${project.tracks.map((x) => x.name).join(', ')}`);
  return t;
}

function position(project: Project, text: string | undefined, fallback = 0): number {
  return text ? parsePosition(project.meter, text) : fallback;
}

function parseParams(list: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of list) {
    const m = /^([\w]+)=(-?[\d.]+)$/.exec(w);
    if (!m) throw new Error(`"${w}": parameters are name=number (e.g. mix=30)`);
    out[m[1] as string] = Number(m[2]);
  }
  return out;
}

/** Notes into a track from `start`: into the region there (grown to fit), or a new one on whole bars. */
function writeOps(
  project: Project,
  trackRef: string,
  start: number,
  notes: Note[],
  replace: boolean,
): { ops: Op[]; region: string } {
  const track = trackOf(project, trackRef);
  const end = Math.max(start + 1, ...notes.map((n) => n.t + n.d));
  const bar = ticksPerBar(meterAt(project.meter, start));
  const list: Op[] = [];
  const region = track.regions.find((r) => start >= r.start && start < r.start + r.length);
  if (!region) {
    const s = Math.floor(start / bar) * bar;
    const fresh = newRegion(s, Math.max(bar, Math.ceil((end - s) / bar) * bar), '');
    fresh.notes = notes.map((n) => ({ ...n, t: n.t - s }));
    list.push({ op: 'addRegion', track: track.id, region: fresh });
    return { ops: list, region: fresh.id };
  }
  if (end > region.start + region.length) {
    list.push({
      op: 'updateRegion',
      track: track.id,
      region: region.id,
      patch: { length: Math.ceil((end - region.start) / bar) * bar },
    });
  }
  const shifted = notes.map((n) => ({ ...n, t: n.t - (region as { start: number }).start }));
  if (replace) {
    const kept = region.notes.filter((n) => {
      const at = (region as { start: number }).start + n.t;
      return at < start || at >= end;
    });
    list.push({ op: 'setNotes', track: track.id, region: region.id, notes: [...kept, ...shifted] });
  } else list.push({ op: 'addNotes', track: track.id, region: region.id, notes: shifted });
  return { ops: list, region: region.id };
}

// ---- commands ----

const HELP = `holo: HO[LO] Desk from the command line (server: ${BASE})

Seeing
  holo status                         the studio: song, playhead, selection, MIDI devices, latency
  holo songs                          every song
  holo show [--track T] [--from 9] [--to 17] [--names logic]
                                      the song, or a track's notes bar by bar
  holo instruments                    built-in presets and every sample-pack instrument
  holo plugins                        the stock plugins and their parameters

Writing (positions are bar.beat.sixteenth: 14, 14.3, 14.3.2; notes as "D5:1 B5:2 (D4 F#4 A4):2 r:1")
  holo write --track T --at 14 [--unit 1/8] [--velocity 90] [--replace] "NOTES"
  holo clear --track T --from 14 --to 18
  holo track add NAME --instrument synth:"Warm Pad"|pack/name
  holo track set T [--volume -6] [--pan -0.3] [--mute on|off] [--solo on|off] [--instrument …] [--arm on|off]
  holo fx add T|bus-name|master TYPE [param=value…]     e.g. holo fx add Keys harmonizer key=9 scale=6 voice1=2
  holo fx set T TYPE|ID param=value…
  holo fx remove T TYPE|ID
  holo automate --track T PARAM 9=-12 13=-3 17=-12 [--smooth]   a lane through those points (bar=value);
                                      --smooth eases between them instead of straight lines
         PARAM: volume (dB) | pan (-1..1) | mute (0/1) | distance (0 near..1 far, on a stage) | send:BUS (dB)
                | TYPE.PARAM (reverb.mix, eq.b2Gain…)
  holo automate --track T PARAM clear|off|read
  holo tempo BPM | holo key "A lydian" | holo marker 9 "Chorus"
  holo finish --lufs -16 --ceiling -1 [--glue on|off] [--lowcut 28] [--tilt 0] | holo finish off
                                      master every bounce and render: loudness, a true-peak ceiling, glue
  holo looping 1 57 [--tail 4] | holo looping off
                                      the song is a loop (a game's music): renders play it as it loops
                                      forever, its end ringing into its start, then its first --tail seconds again
  holo ops FILE.json|-                raw operations (see docs/session-format.md)

In the studio, live
  holo play [--from 9] | holo stop | holo loop 9 17 | holo loop off | holo locate 9
  holo audition [--track T] [--bpm 90] [--unit 1/8] "NOTES"   play notes now (not recorded)
  holo listen [--seconds 8]           what you play in the next few seconds, as notes
  holo open SONG_ID | holo new "Title"

Files and creations
  holo bounce                         render the song (or the cycle) to a WAV, kept with the song on the host
  holo import-midi FILE.mid | holo export-midi [FILE.mid]
  holo audio FILE.wav|.flac [--track T] [--at 9] [--name N]   a recording or stem on an audio track
                                      (a new audio track unless --track names one)
  holo creations                      creations and their pieces
  holo pull CREATION PIECE            bring a piece in from its creation (and open it)
  holo send                           send the open song back to its creation
  holo render [--no-wait]             the creation renders the song itself (edits and all): its own sound
                                      comes back as a soloed audio track (needs \`pnpm runner\` on the host)
  holo runner [--creations DIR]       run creations' renderers for the studio (keep it running on the host)
  holo render-audio [--session FILE] [--out FILE.wav] [--rate 44100] [--format float|24] [--from 9 --to 17]
                    [--no-finish] [--no-loop]
                                      the song rendered headless by HO[LO]'s engine, exactly as the studio
                                      bounces it (the open song, --song ID, or a session file)

Experiences (a new project whose music is made here and built by the project itself)
  holo init [DIR] [--name N] [--title T] [--out music/build] [--format wav|wav24] [--ref REF]
                                      set a project up: its holo.creation.json, music/sessions for its songs,
                                      HO[LO]'s engine pinned in music/holo (as commit REF has it, HEAD by
                                      default), and npm run music to build them
  holo new "Title" --for EXPERIENCE [--piece P]
                                      a song for an experience: written into it, and open in the studio
  holo send --to EXPERIENCE [--piece P]
                                      the open song into an experience (it belongs to it from then on)
  holo update-engine [DIR] [--ref REF]
                                      pin this HO[LO]'s engine, rebuild every song, say how far each moved

Every change is one undo step in the studio, labelled "${AUTHOR}: …". --song ID picks a song other than the open one.
Note names are scientific (middle C = C4 = MIDI 60) unless --names logic (middle C = C3).`;

async function main(): Promise<void> {
  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;

    case 'status': {
      const l = await live();
      const health = await call<{ version: string }>('/api/health');
      console.log(`HO[LO] Desk ${health.version} at ${BASE}`);
      if (!l.editor || !l.state) {
        console.log('No studio is open in a browser. Changes go straight to the saved song.');
        return;
      }
      const s = l.state;
      console.log(`Open: "${s.title}" [${s.project}] on ${s.device}`);
      console.log(
        `  ${s.playing ? (s.recording ? 'recording' : 'playing') : 'stopped'} at ${s.position.trim()} · ${s.bpm} bpm · cycle ${s.cycle.on ? 'on' : 'off'}`,
      );
      console.log(
        `  selected track: ${s.selection.track ?? 'none'}; ${s.selection.regions.length} region(s), ${s.selection.notes} note(s) selected`,
      );
      console.log(
        `  the studio names middle C ${s.middleC}${s.middleC === 'C3' ? ' (Logic): add --names logic to match it' : ''}`,
      );
      console.log(
        `  MIDI in: ${s.midiPorts.length ? s.midiPorts.join(', ') : 'none'} · output latency ${s.latencyMs ?? '?'} ms`,
      );
      const others = l.peers.filter((p) => p.role !== 'editor').map((p) => `${p.name} (${p.role})`);
      if (others.length) console.log(`  also connected: ${others.join(', ')}`);
      return;
    }

    case 'songs': {
      const rows =
        await call<{ id: string; title: string; modified: string; creation: string | null; piece: string | null }[]>(
          '/api/projects',
        );
      for (const r of rows)
        console.log(`${r.id}  ${r.title}${r.creation ? `  (${r.creation}/${r.piece})` : ''}  ${r.modified}`);
      return;
    }

    case 'show': {
      const id = await songId();
      const q = new URLSearchParams();
      if (flag('track')) q.set('track', flag('track') as string);
      if (flag('from')) q.set('from', flag('from') as string);
      if (flag('to')) q.set('to', flag('to') as string);
      q.set('middleC', names());
      console.log(await call<string>(`/api/projects/${id}/describe?${q}`));
      return;
    }

    case 'instruments': {
      console.log(`Built-in: ${SYNTH_PRESETS.map((p) => `synth:"${p}"`).join(', ')}`);
      const packs =
        await call<{ id: string; name: string; instruments: { name: string; title: string; category: string }[] }[]>(
          '/api/packs',
        );
      for (const p of packs) {
        console.log(`\n${p.name} (${p.id})`);
        for (const i of p.instruments) console.log(`  ${p.id}/${i.name}  ${i.title}  [${i.category}]`);
      }
      return;
    }

    case 'plugins': {
      for (const p of PLUGINS) {
        console.log(`${p.type} (${p.name}, ${p.kind === 'midi' ? 'MIDI effect' : 'audio effect'}): ${p.description}`);
        for (const d of p.params) {
          const range = d.options
            ? d.options.map((o, i) => `${i}=${o}`).join(' ')
            : `${d.min}…${d.max}${d.unit ? ` ${d.unit}` : ''}`;
          console.log(`    ${d.id}: ${range} (default ${d.default})`);
        }
      }
      return;
    }

    case 'write': {
      const project = await song();
      const text = words.join(' ');
      if (!text) throw new Error('Give the notes, e.g. holo write --track Keys --at 9 "C4:2 E4:2 G4:4"');
      const start = position(project, flag('at'), 0);
      const notes = parseNotation(text, {
        unit: unitTicks(),
        start,
        velocity: Number(flag('velocity') ?? 90),
        middleC: names(),
        ...(flag('gate') ? { gate: Number(flag('gate')) } : {}),
      });
      const track = trackOf(project, flag('track'));
      const { ops: list } = writeOps(project, track.name, start, notes, has('replace'));
      await ops(
        project,
        list,
        `${notes.length} note${notes.length === 1 ? '' : 's'} on ${track.name} at ${formatBarBeat(project.meter, start)}`,
      );
      return;
    }

    case 'clear': {
      const project = await song();
      const track = trackOf(project, flag('track'));
      const from = position(project, flag('from'), 0);
      const to = position(project, flag('to'), Number.POSITIVE_INFINITY);
      const list: Op[] = [];
      let n = 0;
      for (const r of track.regions) {
        const kept = r.notes.filter((x) => r.start + x.t < from || r.start + x.t >= to);
        if (kept.length !== r.notes.length) {
          n += r.notes.length - kept.length;
          list.push({ op: 'setNotes', track: track.id, region: r.id, notes: kept });
        }
      }
      if (!list.length) {
        console.log('Nothing there to clear.');
        return;
      }
      await ops(project, list, `Cleared ${n} notes on ${track.name}`);
      return;
    }

    case 'track': {
      const project = await song();
      const sub = words.shift();
      if (sub === 'add') {
        const name = words.join(' ') || 'New Track';
        const instrument = parseInstrument(flag('instrument') ?? 'synth:Soft Keys');
        const t = newTrack(name, instrument, TRACK_COLORS[project.tracks.length % TRACK_COLORS.length]);
        const reverb = project.buses[0];
        if (reverb) t.channel.sends.push({ bus: reverb.id, level: -18, pre: false });
        await ops(project, [{ op: 'addTrack', track: t }], `New track ${name}`);
        return;
      }
      if (sub === 'set') {
        const t = trackOf(project, words.join(' ') || flag('track'));
        const list: Op[] = [];
        const ch: Record<string, unknown> = {};
        if (flag('volume')) ch.volume = Number(flag('volume'));
        if (flag('pan')) ch.pan = Number(flag('pan'));
        if (flag('mute')) ch.mute = flag('mute') !== 'off';
        if (flag('solo')) ch.solo = flag('solo') !== 'off';
        if (Object.keys(ch).length) list.push({ op: 'updateChannel', target: t.id, patch: ch });
        const tp: Record<string, unknown> = {};
        if (flag('instrument')) tp.instrument = parseInstrument(flag('instrument') as string);
        if (flag('arm')) tp.armed = flag('arm') !== 'off';
        if (flag('name')) tp.name = flag('name');
        if (Object.keys(tp).length) list.push({ op: 'updateTrack', track: t.id, patch: tp });
        if (!list.length)
          throw new Error('Nothing to set: --volume, --pan, --mute, --solo, --instrument, --arm, --name');
        await ops(project, list, `${t.name}: ${Object.keys({ ...ch, ...tp }).join(', ')}`);
        return;
      }
      throw new Error('holo track add NAME --instrument … | holo track set NAME --volume …');
    }

    case 'fx': {
      const project = await song();
      const sub = words.shift();
      const targetRef = words.shift() ?? '';
      const target =
        targetRef === 'master'
          ? 'master'
          : (project.buses.find((b) => b.id === targetRef || b.name.toLowerCase() === targetRef.toLowerCase())?.id ??
            trackOf(project, targetRef).id);
      const owner =
        target === 'master'
          ? project.master.inserts
          : (project.buses.find((b) => b.id === target)?.channel.inserts ?? [
              ...(project.tracks.find((t) => t.id === target)?.midiFx ?? []),
              ...(project.tracks.find((t) => t.id === target)?.channel.inserts ?? []),
            ]);
      if (sub === 'add') {
        const type = words.shift() ?? '';
        const def = pluginDef(type);
        if (!def) throw new Error(`No plugin "${type}": ${PLUGINS.map((p) => p.type).join(', ')}`);
        const plugin = newPlugin(type, parseParams(words));
        const slot = def.kind === 'midi' ? 'midiFx' : 'inserts';
        if (slot === 'midiFx' && (target === 'master' || project.buses.some((b) => b.id === target))) {
          throw new Error('MIDI effects go on tracks');
        }
        await ops(project, [{ op: 'addPlugin', target, slot, plugin }], `${def.name} on ${targetRef}`);
        return;
      }
      const ref = words.shift() ?? '';
      const plugin = owner.find((p) => p.id === ref) ?? owner.find((p) => p.type === ref);
      if (!plugin)
        throw new Error(
          `No "${ref}" on ${targetRef}. It has: ${owner.map((p) => `${p.type} (${p.id})`).join(', ') || 'nothing'}`,
        );
      if (sub === 'set') {
        const params = parseParams(words);
        const def = pluginDef(plugin.type);
        for (const k of Object.keys(params)) {
          if (def && !def.params.some((p) => p.id === k))
            throw new Error(`${def.name} has no "${k}": ${def.params.map((p) => p.id).join(', ')}`);
        }
        await ops(
          project,
          [{ op: 'updatePlugin', target, plugin: plugin.id, patch: { params } }],
          `${def?.name ?? plugin.type} on ${targetRef}: ${words.join(' ')}`,
        );
        return;
      }
      if (sub === 'remove') {
        await ops(
          project,
          [{ op: 'removePlugin', target, plugin: plugin.id }],
          `Removed ${plugin.type} from ${targetRef}`,
        );
        return;
      }
      throw new Error('holo fx add|set|remove …');
    }

    case 'automate': {
      const project = await song();
      const ref = flag('track') ?? flag('bus');
      const target =
        ref === 'master' || flag('master') !== undefined
          ? { id: 'master', channel: project.master, name: 'Stereo Out' }
          : (() => {
              const bus = project.buses.find((b) => b.name.toLowerCase() === (ref ?? '').toLowerCase() || b.id === ref);
              if (bus) return { id: bus.id, channel: bus.channel, name: bus.name };
              const t = trackOf(project, ref);
              return { id: t.id, channel: t.channel, name: t.name };
            })();
      const spec = words.shift() ?? '';
      let param = spec;
      if (spec.startsWith('send:')) {
        const bus = project.buses.find(
          (b) => b.name.toLowerCase() === spec.slice(5).toLowerCase() || b.id === spec.slice(5),
        );
        if (!bus) throw new Error(`No bus "${spec.slice(5)}": ${project.buses.map((b) => b.name).join(', ')}`);
        param = `send:${bus.id}`;
      } else if (spec.includes('.')) {
        const [type, id] = spec.split('.');
        const plugin = target.channel.inserts.find((p) => p.type === type);
        if (!plugin)
          throw new Error(`${target.name} has no ${type}: add it first (holo fx add ${target.name} ${type})`);
        param = `fx:${plugin.id}:${id}`;
      } else if (spec === 'distance') {
        if (!target.channel.stage)
          throw new Error(`${target.name} isn't on a stage (the mixer's Stage slot puts it on one)`);
      } else if (!['volume', 'pan', 'mute'].includes(spec)) {
        throw new Error('PARAM is volume, pan, mute, distance, send:BUS or TYPE.PARAM (e.g. reverb.mix)');
      }
      const lane = target.channel.automation?.find((a) => a.param === param);
      const first = words[0];
      if (first === 'clear' || first === 'off' || first === 'read') {
        await ops(
          project,
          [
            {
              op: 'setAutomation',
              target: target.id,
              param,
              points: first === 'clear' ? [] : (lane?.points ?? []),
              mode: first === 'off' ? 'off' : 'read',
            },
          ],
          `${target.name}: ${spec} automation ${first}`,
        );
        return;
      }
      const points = words.map((w): [number, number] => {
        const m = /^([\d.]+|t:\d+)=(-?[\d.]+)$/.exec(w);
        if (!m) throw new Error(`"${w}": points are position=value, e.g. 9=-12 or 9.3=0.5`);
        return [position(project, m[1] as string), Number(m[2])];
      });
      if (!points.length) throw new Error('Give the points: holo automate --track Strings volume 9=-20 13=-6');
      const curve = flag('smooth') !== undefined ? 'smooth' : flag('linear') !== undefined ? 'linear' : undefined;
      await ops(
        project,
        [{ op: 'setAutomation', target: target.id, param, points, ...(curve ? { curve } : {}) }],
        `${target.name}: ${spec} automation (${points.length} points${curve ? `, ${curve}` : ''})`,
      );
      return;
    }

    case 'finish': {
      const project = await song();
      if (words[0] === 'off') {
        await ops(project, [{ op: 'setProject', patch: { finish: null } }], 'No finish');
        return;
      }
      const was = project.finish;
      const number = (name: string, fallback: number) => {
        const v = flag(name);
        if (v === undefined) return fallback;
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`--${name} takes a number`);
        return n;
      };
      const glue = flag('glue');
      const next = {
        lufs: number('lufs', was?.lufs ?? -16),
        ceiling: number('ceiling', was?.ceiling ?? -1),
        glue: glue === undefined ? (was?.glue ?? true) : glue !== 'off',
        lowcut: number('lowcut', was?.lowcut ?? 28),
        tilt: number('tilt', was?.tilt ?? 0),
      };
      await ops(
        project,
        [{ op: 'setProject', patch: { finish: next } }],
        `Finish: ${next.lufs} LUFS, ceiling ${next.ceiling} dBTP${next.glue ? ', glue' : ''}`,
      );
      return;
    }

    case 'looping': {
      const project = await song();
      if (words[0] === 'off') {
        await ops(project, [{ op: 'setProject', patch: { loop: null } }], 'Not a loop');
        return;
      }
      if (words.length < 2) throw new Error('holo looping 1 57 [--tail 4]: where the loop starts and ends (bars)');
      const start = position(project, words[0]);
      const end = position(project, words[1]);
      if (!(end > start)) throw new Error('The loop ends after it starts');
      const tail = Number(flag('tail') ?? project.loop?.tail ?? 0);
      await ops(
        project,
        [{ op: 'setProject', patch: { loop: { start, end, tail } } }],
        `A loop: bars ${words[0]} to ${words[1]}, tail ${tail} s`,
      );
      return;
    }

    case 'tempo': {
      const project = await song();
      const bpm = Number(words[0]);
      if (!(bpm > 0)) throw new Error('holo tempo 96');
      await ops(
        project,
        [{ op: 'setProject', patch: { tempo: [{ tick: 0, bpm }, ...project.tempo.slice(1)] } }],
        `Tempo ${bpm}`,
      );
      return;
    }

    case 'key': {
      const project = await song();
      await ops(project, [{ op: 'setProject', patch: { key: words.join(' ') || null } }], `Key ${words.join(' ')}`);
      return;
    }

    case 'marker': {
      const project = await song();
      const at = position(project, words.shift());
      const name = words.join(' ') || 'Marker';
      const markers = [...project.markers, { id: `mrk_${Date.now().toString(36)}`, tick: at, name }].sort(
        (a, b) => a.tick - b.tick,
      );
      await ops(project, [{ op: 'setProject', patch: { markers } }], `Marker "${name}"`);
      return;
    }

    case 'ops': {
      const project = await song();
      const src = words[0] === '-' || !words[0] ? readFileSync(0, 'utf8') : readFileSync(words[0], 'utf8');
      const list = JSON.parse(src) as Op[];
      await ops(
        project,
        Array.isArray(list) ? list : [list],
        flag('label') ?? `${Array.isArray(list) ? list.length : 1} change(s)`,
      );
      return;
    }

    case 'play':
    case 'stop':
    case 'locate': {
      const project = await song();
      const at = flag('from') ?? (command === 'locate' ? words[0] : undefined);
      await call('/api/live/transport', {
        method: 'POST',
        body: JSON.stringify({ action: command, ...(at ? { at: position(project, at) } : {}) }),
      });
      console.log(
        command === 'stop' ? 'Stopped' : at ? `${command === 'play' ? 'Playing from' : 'At'} ${at}` : 'Playing',
      );
      return;
    }

    case 'loop': {
      const project = await song();
      if (words[0] === 'off') {
        await ops(project, [{ op: 'setProject', patch: { cycle: { ...project.cycle, on: false } } }], 'Cycle off');
        return;
      }
      const start = position(project, words[0]);
      const end = position(project, words[1], start + ticksPerBar(meterAt(project.meter, start)) * 4);
      await ops(
        project,
        [{ op: 'setProject', patch: { cycle: { on: true, start, end } } }],
        `Cycle ${words[0]} to ${words[1] ?? '+4 bars'}`,
      );
      return;
    }

    case 'audition': {
      const bpm = Number(flag('bpm') ?? (await live()).state?.bpm ?? 120);
      const msPerTick = 60000 / bpm / PPQ;
      const notes = parseNotation(words.join(' '), {
        unit: unitTicks(),
        velocity: Number(flag('velocity') ?? 90),
        middleC: names(),
      });
      const events: number[][] = [];
      for (const n of notes) {
        const p = Math.round(n.p);
        events.push([Math.round(n.t * msPerTick), 0x90, p, Math.round(n.v)]);
        events.push([Math.round((n.t + n.d) * msPerTick) - 5, 0x80, p, 0]);
      }
      await call('/api/live/midi', { method: 'POST', body: JSON.stringify({ events, track: flag('track') ?? null }) });
      console.log(`Playing ${notes.length} note(s) in the studio`);
      return;
    }

    case 'listen': {
      const seconds = Number(flag('seconds') ?? 8);
      console.log(`Listening for ${seconds} s…`);
      const project = await song().catch(() => null);
      const r = await call<{
        notes: {
          tick: number | null;
          time: number;
          pitch: number;
          velocity: number;
          length: number | null;
          port: string;
        }[];
      }>(`/api/live/listen?seconds=${seconds}`);
      if (!r.notes.length) {
        console.log('Nothing was played.');
        return;
      }
      for (const n of r.notes) {
        const where =
          n.tick !== null && project
            ? `at ${formatBarBeat(project.meter, n.tick, true)}`
            : `at ${(n.time / 1000).toFixed(2)} s`;
        console.log(
          `${noteName(n.pitch, names())} (${n.pitch}) vel ${n.velocity} ${where}, ${n.length !== null ? `${n.length} ms` : 'still held'} [${n.port}]`,
        );
      }
      return;
    }

    case 'bounce': {
      console.log('Bouncing in the studio…');
      const r = await call<{ ok: boolean; error?: string; path?: string; url?: string; seconds?: number }>(
        '/api/live/bounce',
        { method: 'POST' },
      );
      if (!r.ok) throw new Error(r.error ?? 'The bounce failed');
      console.log(`Bounced ${r.seconds ? `${r.seconds.toFixed(1)} s` : ''} to ${r.path} on the host (${BASE}${r.url})`);
      return;
    }

    case 'open': {
      await call('/api/live/open', { method: 'POST', body: JSON.stringify({ project: words[0] }) });
      console.log(`Opened ${words[0]}`);
      return;
    }

    case 'new': {
      if (flag('for')) {
        const r = await call<{ project: Project; path: string }>(`/api/creations/${flag('for')}/songs`, {
          method: 'POST',
          body: JSON.stringify({
            title: words.join(' ') || 'Untitled',
            ...(flag('piece') ? { piece: flag('piece') } : {}),
          }),
        });
        console.log(`Made "${r.project.title}" [${r.project.id}] for ${flag('for')}: ${r.path}`);
        await call('/api/live/open', { method: 'POST', body: JSON.stringify({ project: r.project.id }) }).catch(
          () => undefined,
        );
        return;
      }
      const project = await call<Project>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ title: words.join(' ') || 'Untitled' }),
      });
      console.log(`Made "${project.title}" [${project.id}]`);
      await call('/api/live/open', { method: 'POST', body: JSON.stringify({ project: project.id }) }).catch(
        () => undefined,
      );
      return;
    }

    case 'audio': {
      const file = resolve(words[0] ?? '');
      if (!existsSync(file) || !/\.(wav|flac)$/i.test(file)) {
        throw new Error('holo audio FILE.wav|FILE.flac (other formats: drop them on the studio)');
      }
      const project = await song();
      const base = file.replace(/.*\//, '');
      const res = await fetch(`${BASE}/api/projects/${project.id}/files?name=${encodeURIComponent(base)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-holo-audio' },
        body: readFileSync(file),
      });
      const up = (await res.json()) as {
        id?: string;
        seconds?: number;
        rate?: number;
        channels?: number;
        error?: string;
      };
      if (!res.ok || !up.id) throw new Error(up.error ?? `Upload failed (${res.status})`);
      if (!up.seconds || !up.rate || !up.channels) throw new Error(`${base}: couldn't read its length`);
      const name = flag('name') ?? base.replace(/\.[^.]+$/, '');
      const list: Op[] = [
        { op: 'addFile', file: { id: up.id, name: base, seconds: up.seconds, rate: up.rate, channels: up.channels } },
      ];
      let target = flag('track') ? trackOf(project, flag('track')) : null;
      if (target && target.kind !== 'audio')
        throw new Error(`"${target.name}" is an instrument track, not an audio track`);
      if (!target) {
        target = newAudioTrack(name, TRACK_COLORS[project.tracks.length % TRACK_COLORS.length]);
        list.push({ op: 'addTrack', track: target });
      }
      const at = position(project, flag('at'));
      const end = Math.round(secondsToTick(project.tempo, tickToSeconds(project.tempo, at) + up.seconds));
      const region = newRegion(at, Math.max(1, end - at), name);
      region.audio = { file: up.id, offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 };
      list.push({ op: 'addRegion', track: target.id, region });
      await ops(project, list, `Audio ${name}`);
      console.log(`${name}: ${up.seconds.toFixed(2)} s on ${target.name} at ${formatBarBeat(project.meter, at)}`);
      return;
    }

    case 'render-audio': {
      const { renderSession, encodeWav } = await import('@holo/engine');
      const { dataFolderSource } = await import('@holo/engine/node');
      const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
      const dataDir = resolve(repo, process.env.HOLO_DATA_DIR ?? './data');
      const sessionFile = flag('session');
      const project = sessionFile
        ? parseProject(JSON.parse(readFileSync(resolve(String(sessionFile)), 'utf8')))
        : await song();
      const rate = Number(flag('rate') ?? project.sampleRate ?? 48000);
      const range = {
        from: flag('from') ? position(project, String(flag('from'))) : undefined,
        to: flag('to') ? position(project, String(flag('to'))) : undefined,
      };
      const started = Date.now();
      const out = await renderSession(project, dataFolderSource(dataDir, project.id), {
        sampleRate: rate,
        ...range,
        tail: Number(flag('tail') ?? 4),
        ...(flag('no-finish') !== undefined ? { finish: false } : {}),
        ...(flag('no-loop') !== undefined ? { loop: false } : {}),
        onProgress: (text) => process.stderr.write(`\r${text.padEnd(40)}`),
      });
      process.stderr.write('\n');
      if (out.errors.length) throw new Error(`The engine stopped: ${out.errors[0]}`);
      const file = resolve(String(flag('out') ?? `${project.title.replace(/[^\w\- ]+/g, '').trim() || 'song'}.wav`));
      writeFileSync(file, encodeWav(out.channels, rate, flag('format') === '24' ? 'pcm24' : 'float32'));
      const seconds = (out.channels[0]?.length ?? 0) / rate;
      console.log(
        `Rendered ${seconds.toFixed(1)} s at ${rate} Hz in ${((Date.now() - started) / 1000).toFixed(1)} s: ${file}`,
      );
      return;
    }

    case 'init':
    case 'update-engine': {
      const { init, updateEngine } = await import('./experience.ts');
      const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
      const dir = words[0] ?? '.';
      const ref = flag('ref');
      if (command === 'update-engine') await updateEngine(repo, dir, ref ? { ref } : {}, console.log);
      else {
        const opts: Record<string, string> = {};
        for (const k of ['name', 'title', 'sessions', 'out', 'format', 'ref'] as const) {
          const v = flag(k);
          if (v) opts[k] = v;
        }
        await init(repo, dir, opts, console.log);
      }
      return;
    }

    case 'runner': {
      const { runner } = await import('./runner.ts');
      const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
      const dir = resolve(repo, String(flag('creations') ?? process.env.HOLO_CREATIONS_DIR ?? '..'));
      await runner(BASE, dir);
      return;
    }

    case 'render': {
      const project = await song();
      const r = await call<{ ok: boolean; id: string; already?: boolean }>(`/api/projects/${project.id}/render`, {
        method: 'POST',
      });
      console.log(r.already ? 'Already rendering; following it…' : `Rendering "${project.title}" in its creation…`);
      if (flag('no-wait')) return;
      let last = '';
      for (;;) {
        await new Promise((ok) => setTimeout(ok, 2000));
        const job = await call<{ state: string; lines: string[]; error: string | null; started: number }>(
          `/api/renders/${r.id}`,
        );
        // the job keeps its last dozen lines: print the ones after what was printed
        const from = last ? job.lines.lastIndexOf(last) + 1 : 0;
        for (const line of job.lines.slice(from)) console.log(`  ${line}`);
        last = job.lines[job.lines.length - 1] ?? last;
        if (job.state === 'done') {
          console.log(
            `Done in ${Math.round((Date.now() - job.started) / 1000)} s: the creation's render is on its own track, soloed.`,
          );
          return;
        }
        if (job.state === 'failed') throw new Error(job.error ?? 'The render failed');
      }
    }

    case 'import-midi': {
      const file = resolve(words[0] ?? '');
      if (!existsSync(file)) throw new Error('holo import-midi FILE.mid');
      const res = await fetch(
        `${BASE}/api/import/midi?title=${encodeURIComponent(file.replace(/.*\//, '').replace(/\.midi?$/i, ''))}`,
        {
          method: 'POST',
          headers: { 'content-type': 'audio/midi' },
          body: readFileSync(file),
        },
      );
      const p = (await res.json()) as Project;
      console.log(`Imported "${p.title}" [${p.id}]`);
      return;
    }

    case 'export-midi': {
      const id = await songId();
      const res = await fetch(`${BASE}/api/projects/${id}/midi`);
      if (!res.ok) throw new Error(await res.text());
      const out = words[0] ?? `${id}.mid`;
      writeFileSync(out, Buffer.from(await res.arrayBuffer()));
      console.log(`Wrote ${out}`);
      return;
    }

    case 'creations': {
      const list =
        await call<
          {
            name: string;
            title: string;
            exportHelp: string | null;
            engine: { label: string; date: string | null; node: string; relation: string; studio: string } | null;
            pieces: { piece: string; title: string; edited: number; project: string | null }[];
          }[]
        >('/api/creations');
      if (!list.length)
        console.log('No creations found. Set HOLO_CREATIONS_DIR and give each creation a holo.creation.json.');
      for (const c of list) {
        console.log(`${c.title} (${c.name})`);
        if (c.engine) {
          const e = c.engine;
          const how =
            e.relation === 'same'
              ? "the studio's"
              : e.relation === 'older'
                ? `older than the studio's ${e.studio}: holo update-engine moves it`
                : e.relation === 'newer'
                  ? `newer than the studio's ${e.studio}: rebuild the studio (pnpm up)`
                  : `not the studio's ${e.studio}`;
          console.log(`  builds its songs with engine ${e.label}, Node.js ${e.node} (${how})`);
        }
        if (c.exportHelp) console.log(`  to bring a piece in: ${c.exportHelp}`);
        for (const p of c.pieces)
          console.log(
            `  ${p.piece}: ${p.title}${p.edited ? `, ${p.edited} edited track(s)` : ''}${p.project ? ` [open as ${p.project}]` : ''}`,
          );
      }
      return;
    }

    case 'pull': {
      const [creation, piece] = words;
      if (!creation || !piece) throw new Error('holo pull CREATION PIECE');
      const p = await call<Project>(`/api/creations/${creation}/pieces/${piece}/open`, {
        method: 'POST',
        body: JSON.stringify({ mode: has('new') ? 'new' : 'replace' }),
      });
      console.log(`"${p.title}" [${p.id}] from ${creation}/${piece}`);
      await call('/api/live/open', { method: 'POST', body: JSON.stringify({ project: p.id }) }).catch(() => undefined);
      return;
    }

    case 'send': {
      const id = await songId();
      const to = flag('to');
      const r = await call<{ path: string; edited: string[] }>(`/api/projects/${id}/send`, {
        method: 'POST',
        ...(to ? { body: JSON.stringify({ creation: to, ...(flag('piece') ? { piece: flag('piece') } : {}) }) } : {}),
      });
      console.log(`Sent to ${r.path}${r.edited.length ? `; edited tracks: ${r.edited.join(', ')}` : ''}`);
      return;
    }

    default:
      throw new Error(`Unknown command "${command}". holo help lists them.`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
