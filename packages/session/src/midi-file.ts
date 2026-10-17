/**
 * Standard MIDI files: write a session out (format 1, one MIDI track per track) and read any
 * format 0 or 1 file in (format 0 is split by channel).
 */
import { newChannel, newId, newProject, newRegion, TRACK_COLORS } from './defaults.ts';
import { type CCPoint, type MeterPoint, type Note, PPQ, type Project, type TempoPoint, type Track } from './types.ts';

// ---- writing ----

function vlq(n: number): number[] {
  let v = Math.max(0, Math.round(n));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

const text = (s: string) => Array.from(new TextEncoder().encode(s));
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

interface Ev {
  tick: number;
  order: number;
  bytes: number[];
}

function chunk(events: Ev[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let last = 0;
  for (const e of events) {
    body.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  body.push(0, 0xff, 0x2f, 0);
  return [...text('MTrk'), ...u32(body.length), ...body];
}

const meta = (type: number, data: number[]) => [0xff, type, ...vlq(data.length), ...data];

/** MIDI channels for tracks in order, skipping channel 10 (drums in General MIDI). */
const channelFor = (index: number) => {
  const c = index % 15;
  return c >= 9 ? c + 1 : c;
};

export function writeMidi(project: Project): Uint8Array {
  const conductor: Ev[] = [{ tick: 0, order: 0, bytes: meta(0x03, text(project.title)) }];
  for (const t of project.tempo) {
    const us = Math.round(60_000_000 / t.bpm);
    conductor.push({ tick: t.tick, order: 1, bytes: meta(0x51, [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]) });
  }
  for (const m of project.meter) {
    conductor.push({ tick: m.tick, order: 1, bytes: meta(0x58, [m.num, Math.log2(m.den), 24, 8]) });
  }
  for (const m of project.markers) conductor.push({ tick: m.tick, order: 2, bytes: meta(0x06, text(m.name)) });

  const tracks = project.tracks.map((track, index) => {
    const ch = channelFor(index);
    const events: Ev[] = [{ tick: 0, order: 0, bytes: meta(0x03, text(track.name)) }];
    for (const region of track.regions) {
      if (region.muted) continue;
      for (const n of region.notes) {
        const p = Math.max(0, Math.min(127, Math.round(n.p)));
        const v = Math.max(1, Math.min(127, Math.round(n.v)));
        const on = region.start + n.t;
        events.push({ tick: on, order: 2, bytes: [0x90 | ch, p, v] });
        events.push({ tick: on + Math.max(1, n.d), order: 1, bytes: [0x80 | ch, p, 0] });
      }
      for (const [lane, points] of Object.entries(region.cc)) {
        for (const [t, value] of points) {
          const tick = region.start + t;
          if (lane === 'pb') {
            const v = Math.max(0, Math.min(16383, Math.round(value) + 8192));
            events.push({ tick, order: 1, bytes: [0xe0 | ch, v & 0x7f, v >> 7] });
          } else if (lane === 'at') {
            events.push({ tick, order: 1, bytes: [0xd0 | ch, Math.max(0, Math.min(127, Math.round(value)))] });
          } else {
            const cc = Number(lane);
            if (Number.isInteger(cc) && cc >= 0 && cc < 128) {
              events.push({ tick, order: 1, bytes: [0xb0 | ch, cc, Math.max(0, Math.min(127, Math.round(value)))] });
            }
          }
        }
      }
    }
    return chunk(events);
  });

  const header = [...text('MThd'), ...u32(6), 0, 1, 0, tracks.length + 1, (PPQ >> 8) & 0xff, PPQ & 0xff];
  return new Uint8Array([...header, ...chunk(conductor), ...tracks.flat()]);
}

// ---- reading ----

export interface MidiTrack {
  name: string;
  channel: number;
  notes: Note[];
  cc: Record<string, CCPoint[]>;
}

export interface MidiFile {
  tempo: TempoPoint[];
  meter: MeterPoint[];
  markers: { tick: number; name: string }[];
  tracks: MidiTrack[];
  title: string;
}

export function readMidi(data: Uint8Array): MidiFile {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (at: number) => String.fromCharCode(...data.subarray(at, at + 4));
  if (tag(0) !== 'MThd') throw new Error('Not a MIDI file');
  const format = view.getUint16(8);
  const division = view.getUint16(12);
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  const scale = PPQ / division;
  const tempo: TempoPoint[] = [];
  const meter: MeterPoint[] = [];
  const markers: { tick: number; name: string }[] = [];
  const tracks: MidiTrack[] = [];
  let title = '';
  let pos = 8 + view.getUint32(4);
  let trackIndex = 0;
  const decoder = new TextDecoder();

  while (pos + 8 <= data.length) {
    const length = view.getUint32(pos + 4);
    const isTrack = tag(pos) === 'MTrk';
    let p = pos + 8;
    const end = Math.min(data.length, p + length);
    pos = end;
    if (!isTrack) continue;
    const byChannel = new Map<number, MidiTrack>();
    let name = '';
    const forChannel = (ch: number) => {
      let t = byChannel.get(ch);
      if (!t) {
        t = { name: '', channel: ch, notes: [], cc: {} };
        byChannel.set(ch, t);
      }
      return t;
    };
    const held = new Map<number, Note[]>();
    let tick = 0;
    let status = 0;
    const readVlq = () => {
      let v = 0;
      let b: number;
      do {
        b = data[p++] ?? 0;
        v = (v << 7) | (b & 0x7f);
      } while (b & 0x80 && p < end);
      return v;
    };
    while (p < end) {
      tick += readVlq();
      const at = Math.round(tick * scale);
      let b = data[p] ?? 0;
      if (b & 0x80) {
        status = b;
        p++;
      } else b = status;
      if (status === 0xff) {
        const type = data[p++] ?? 0;
        const len = readVlq();
        const body = data.subarray(p, p + len);
        p += len;
        if (type === 0x03 && !name) name = decoder.decode(body);
        else if (type === 0x51 && len === 3) {
          const us = ((body[0] ?? 0) << 16) | ((body[1] ?? 0) << 8) | (body[2] ?? 0);
          tempo.push({ tick: at, bpm: Math.round((60_000_000 / us) * 1000) / 1000 });
        } else if (type === 0x58 && len >= 2) {
          meter.push({ tick: at, num: body[0] ?? 4, den: 2 ** (body[1] ?? 2) });
        } else if (type === 0x06 || type === 0x01) {
          if (type === 0x06) markers.push({ tick: at, name: decoder.decode(body) });
        } else if (type === 0x2f) break;
        status = 0;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        p += readVlq();
        status = 0;
        continue;
      }
      const kind = status & 0xf0;
      const ch = status & 0x0f;
      const d1 = data[p++] ?? 0;
      const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : (data[p++] ?? 0);
      const key = ch * 128 + d1;
      if (kind === 0x90 && d2 > 0) {
        const note: Note = { t: at, d: 0, p: d1, v: d2 };
        forChannel(ch).notes.push(note);
        const list = held.get(key) ?? [];
        list.push(note);
        held.set(key, list);
      } else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
        const note = held.get(key)?.shift();
        if (note) note.d = Math.max(1, at - note.t);
      } else if (kind === 0xb0) {
        const lane = forChannel(ch).cc;
        const list = lane[String(d1)] ?? [];
        list.push([at, d2]);
        lane[String(d1)] = list;
      } else if (kind === 0xe0) {
        const lane = forChannel(ch).cc;
        const list = lane.pb ?? [];
        list.push([at, ((d2 << 7) | d1) - 8192]);
        lane.pb = list;
      } else if (kind === 0xd0) {
        const lane = forChannel(ch).cc;
        const list = lane.at ?? [];
        list.push([at, d1]);
        lane.at = list;
      }
    }
    // notes never released end at the track's last event
    for (const list of held.values()) for (const n of list) n.d = Math.max(1, Math.round(tick * scale) - n.t);
    const parts = [...byChannel.values()].filter((t) => t.notes.length || Object.keys(t.cc).length);
    if (format === 1 && trackIndex === 0 && parts.length === 0) title = name;
    for (const part of parts) {
      part.name =
        name && parts.length === 1 ? name : name ? `${name} (ch ${part.channel + 1})` : `Channel ${part.channel + 1}`;
      tracks.push(part);
    }
    trackIndex++;
  }
  tempo.sort((a, b) => a.tick - b.tick);
  meter.sort((a, b) => a.tick - b.tick);
  if (!tempo.length || (tempo[0] as TempoPoint).tick > 0) tempo.unshift({ tick: 0, bpm: 120 });
  if (!meter.length || (meter[0] as MeterPoint).tick > 0) meter.unshift({ tick: 0, num: 4, den: 4 });
  return { tempo, meter, markers, tracks, title };
}

/** A new session from a MIDI file: one track per MIDI track, its notes in one region. */
export function projectFromMidi(file: MidiFile, title: string): Project {
  const project = newProject(file.title || title);
  const reverb = project.buses[0];
  project.tempo = file.tempo;
  project.meter = file.meter;
  project.markers = file.markers.map((m) => ({ id: newId('mrk'), tick: m.tick, name: m.name }));
  const bar = PPQ * 4;
  project.tracks = file.tracks.map((mt, i): Track => {
    const lastTick = Math.max(
      0,
      ...mt.notes.map((n) => n.t + n.d),
      ...Object.values(mt.cc).flatMap((pts) => pts.map((pt) => pt[0])),
    );
    const firstTick = Math.min(...mt.notes.map((n) => n.t), lastTick);
    const start = Math.floor(firstTick / bar) * bar;
    const region = newRegion(start, Math.max(bar, Math.ceil((lastTick - start) / bar) * bar), mt.name);
    region.notes = mt.notes.map((n) => ({ ...n, t: n.t - start }));
    region.cc = Object.fromEntries(
      Object.entries(mt.cc).map(([k, pts]) => [k, pts.map(([t, v]): CCPoint => [t - start, v])]),
    );
    const channel = newChannel();
    if (reverb) channel.sends.push({ bus: reverb.id, level: -15, pre: false });
    return {
      id: newId('trk'),
      name: mt.name,
      color: TRACK_COLORS[i % TRACK_COLORS.length] ?? '#3fa7d6',
      kind: 'instrument',
      instrument: mt.channel === 9 ? { type: 'synth', preset: 'Drum Synth' } : { type: 'synth', preset: 'Soft Keys' },
      articulations: [],
      input: { port: '*', channel: 0 },
      armed: false,
      midiFx: [],
      regions: [region],
      channel,
    };
  });
  return project;
}
