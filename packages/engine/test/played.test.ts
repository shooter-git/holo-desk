import {
  newPlugin,
  newProject,
  newRegion,
  newTrack,
  PPQ,
  type Project,
  performed,
  type Region,
  type Track,
} from '@holo/session';
import { describe, expect, it } from 'vitest';
import { type PlayedZone, playedKeys, playedZones } from '../src/played.ts';
import type { SamplerSpec, SampleZone } from '../src/protocol.ts';
import {
  buildSampler,
  type InstrumentManifest,
  type RenderSource,
  renderSession,
  type ZoneManifest,
} from '../src/render.ts';
import { Sampler } from '../src/sampler.ts';
import { encodeWav } from '../src/wav.ts';

// A render loads only the zones its song can sound (played.ts). What it renders is the same to the
// byte as with every zone loaded: shown here at the sampler, with thousands of made-up instruments
// and phrases, and through whole renders of made-up songs.

const SR = 48000;

/** Numbers from a seed, the same every run. */
function seeded(seed: number) {
  let a = (seed * 2654435761) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const of = <T>(list: readonly T[]) => list[int(0, list.length - 1)] as T;
  const chance = (p: number) => next() < p;
  const shuffled = <T>(list: T[]) => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = int(0, i);
      [list[i], list[j]] = [list[j] as T, list[i] as T];
    }
    return list;
  };
  return { next, int, of, chance, shuffled };
}
type Rnd = ReturnType<typeof seeded>;

const same = (a: Float32Array, b: Float32Array) =>
  a.length === b.length &&
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

/** What decides when a zone sounds, for a made-up instrument: its keys, velocities, round robins, set and microphone. */
interface Made extends PlayedZone {
  rr: number;
  group?: number;
  offBy?: number;
}

/**
 * A made-up instrument's zones: struck ones over ranges with gaps and overlaps, split by velocity
 * (gaps there too), several round robins of some, on the instrument's microphones or none; release
 * samples in parts, sparser than the struck; the pedal's own sounds. In no particular order.
 */
function madeZones(r: Rnd, mics: readonly string[]): Made[] {
  const out: Made[] = [];
  const anyMic = () => (r.chance(0.6) && mics.length ? { mic: r.of([...mics, ...mics, 'unlisted']) } : {});
  const ranges = (count: number, from: number, to: number): [number, number][] => {
    // side by side, key after key (a key between two is then nearest both), or scattered, with gaps and overlaps
    if (r.chance(0.4)) {
      let lo = r.int(from, from + 30);
      return Array.from({ length: count }, () => {
        const hi = lo + r.of([0, 0, 1, 4]);
        const range: [number, number] = [lo, hi];
        lo = hi + 1;
        return range;
      });
    }
    return Array.from({ length: count }, () => {
      const lo = r.int(from, to);
      return [lo, r.chance(0.3) ? lo : Math.min(127, lo + r.int(0, 9))];
    });
  };
  const splits = (): [number, number][] =>
    r.of([
      [[0, 127]],
      [
        [1, 60],
        [61, 127],
      ],
      [
        [1, 40],
        [50, 90],
        [100, 127],
      ],
      [[20, 80]],
      [[1, 20]],
      [[110, 127]],
      [
        [1, 127],
        [1, 127],
      ],
    ] as [number, number][][]);
  for (const [lo, hi] of ranges(r.int(2, 8), 20, 100)) {
    // a range's zones on microphones or not, all alike or each as it comes
    const how = r.of(['none', 'none', 'one', 'each'] as const);
    const one = anyMic();
    const mic = () => (how === 'none' ? {} : how === 'one' ? one : anyMic());
    for (const [lovel, hivel] of splits()) {
      const robins = r.of([1, 1, 2, 3]);
      for (let n = 1; n <= robins; n++) {
        out.push({ lo, hi, lovel, hivel, rr: n, ...mic(), ...(r.chance(0.15) ? { group: r.int(1, 2) } : {}) });
        if (r.chance(0.1)) (out.at(-1) as Made).offBy = r.int(1, 2);
        // (and one that starts where it does and stops short: they take turns over part of its keys)
        if (hi > lo && r.chance(0.25)) out.push({ lo, hi: r.int(lo, hi - 1), lovel, hivel, rr: n + 1, ...mic() });
      }
    }
  }
  for (let part = 0; part < r.int(0, 2); part++) {
    for (const [lo, hi] of ranges(r.int(1, 4), 10, 110)) {
      for (const [lovel, hivel] of r.chance(0.5) ? [[0, 127]] : splits()) {
        const zone: Made = {
          lo,
          hi,
          lovel: lovel as number,
          hivel: hivel as number,
          rr: 1,
          trigger: 'release',
          ...anyMic(),
        };
        if (part) zone.part = part;
        out.push(zone);
        if (r.chance(0.3)) out.push({ ...zone, rr: 2 });
      }
    }
  }
  for (const trigger of ['pedalDown', 'pedalUp'] as const) {
    if (!r.chance(0.4)) continue;
    for (let n = 1; n <= r.of([1, 2]); n++)
      out.push({ lo: r.of([0, 0, 21]), hi: r.of([127, 127, 108]), lovel: 0, hivel: 127, rr: n, trigger, ...anyMic() });
  }
  return r.shuffled(out);
}

/** A made zone as the sampler takes it: a short sound of its own (no other zone's), louder on one side. */
function sampleZone(z: Made, n: number): SampleZone {
  const level = 0.05 + ((n * 37) % 89) / 100;
  const { lo, hi, lovel, hivel, rr, ...rest } = z;
  return {
    left: Float32Array.from({ length: 300 }, (_, i) => level * Math.sin((i * (n + 3)) / 17)),
    right: n % 3 ? Float32Array.from({ length: 300 }, (_, i) => level * 0.5 * Math.cos((i * (n + 5)) / 13)) : null,
    root: Math.round((lo + hi) / 2),
    lo,
    hi,
    lovel,
    hivel,
    gain: 1,
    loopStart: 0,
    loopEnd: 0,
    rr,
    ...rest,
  };
}

/** Keys a made-up phrase plays: on the keyboard, between two keys, and off either end of it. */
const KEYS = [
  -3, 15, 21, 30.45, 36, 40.55, 47.5, 48, 50.45, 55, 59.3, 60, 60.45, 60.5, 61, 64, 67, 72, 79.9, 84, 96, 108, 111, 127,
  140,
];
const VELOCITIES = [1, 20, 45, 64, 64.5, 100, 127, 300, 999];

type Event = [frame: number, what: 'on' | 'off' | 'cc', a: number, b: number];

/** A made-up phrase on a handful of keys: notes struck (again and again: round robins turn) and let go, the pedal, all notes off. */
function phrase(r: Rnd, frames: number, zones: readonly PlayedZone[] = []): Event[] {
  // (keys from anywhere, and keys at and just past the edges of the instrument's own zones)
  const edges = zones.flatMap((z) => [z.lo, z.hi, z.hi + 0.45, z.hi + 0.55, z.lo - 1]);
  const pool = Array.from({ length: r.int(2, 7) }, () => (edges.length && r.chance(0.6) ? r.of(edges) : r.of(KEYS)));
  const out: Event[] = [];
  for (let at = 0; at < frames; at += r.int(40, 700)) {
    const roll = r.next();
    if (roll < 0.55) out.push([at, 'on', r.of(pool), r.of(VELOCITIES)]);
    else if (roll < 0.8) out.push([at, 'off', r.of(pool), 0]);
    else if (roll < 0.92) out.push([at, 'cc', 64, r.of([0, 0, 127, 64, 63])]);
    else out.push([at, 'cc', r.of([123, 123, 120]), 0]);
  }
  return out;
}

/** The phrase played on a sampler (keys and velocities as the engine hands them over: 32-bit floats). */
function played(sampler: Sampler, events: readonly Event[], frames: number): [Float32Array, Float32Array] {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  let e = 0;
  for (let f = 0; f < frames; f += 128) {
    for (; e < events.length && (events[e] as Event)[0] < f + 128; e++) {
      const [, what, a, b] = events[e] as Event;
      if (what === 'on') sampler.noteOn(Math.fround(a), Math.fround(b));
      else if (what === 'off') sampler.noteOff(Math.fround(a));
      else sampler.cc(a, b);
    }
    sampler.render(l, r, f, Math.min(frames, f + 128));
  }
  return [l, r];
}

const keysOf = (events: readonly Event[]) => [
  ...new Set(events.filter((e) => e[1] === 'on').map((e) => Math.fround(e[2]))),
];

describe('the zones a song can sound, at the sampler', () => {
  it('play as all of them do, for thousands of made-up instruments and phrases', () => {
    let zonesInAll = 0;
    let zonesKept = 0;
    let loud = 0;
    for (let n = 1; n <= 3000; n++) {
      const r = seeded(n);
      const mics = ['near', 'far', 'room'].slice(0, r.of([0, 0, 1, 2, 3]));
      const zones = madeZones(r, mics).map(sampleZone);
      const spec: SamplerSpec = {
        key: 'made',
        zones,
        release: r.of([0.004, 0.02]),
        oneShot: r.chance(0.2),
        pitched: r.chance(0.8),
        velocityRange: r.of([0, 20, 40]),
        attack: r.of([0, 0.002]),
        ...(mics.length ? { mics: mics.map((id) => ({ id, name: id })) } : {}),
        ...(r.chance(0.2) ? { polyphony: r.int(1, 4) } : {}),
        ...(r.chance(0.2) ? { notePolyphony: r.int(1, 2) } : {}),
        ...(r.chance(0.2) ? { undamped: r.int(60, 100) } : {}),
        ...(r.chance(0.3) ? { releaseDecay: r.of([0, 6, 40]) } : {}),
      };
      const frames = r.of([2048, 4800, 9600]);
      const events = phrase(r, frames, zones);
      const keep = playedZones(zones, mics, keysOf(events));
      if (!keep) throw new Error(`case ${n}: the whole instrument, where its zones could be told`);
      const [al, ar] = played(new Sampler(SR, spec), events, frames);
      const [bl, br] = played(
        new Sampler(SR, { ...spec, zones: zones.filter((_z, i) => keep.has(i)) }),
        events,
        frames,
      );
      if (!same(al, bl) || !same(ar, br)) throw new Error(`case ${n}: the zones kept play something else`);
      zonesInAll += zones.length;
      zonesKept += keep.size;
      if (al.some((v) => v !== 0)) loud++;
    }
    // (they sound, nearly all of them, and far from every zone is kept)
    expect(loud).toBeGreaterThan(2700);
    expect(zonesKept).toBeLessThan(zonesInAll * 0.75);
  }, 60_000);

  it('keep what all-notes-off releases after the pedal’s own sound: the release samples nearest key -1', () => {
    // a release sample far below anything struck: what the pedal's voice (key -1) is let go through
    const zones: Made[] = [
      { lo: 60, hi: 72, lovel: 0, hivel: 127, rr: 1 },
      { lo: 10, hi: 20, lovel: 0, hivel: 127, rr: 1, trigger: 'release' },
      { lo: 60, hi: 72, lovel: 0, hivel: 127, rr: 1, trigger: 'release' },
      { lo: 0, hi: 127, lovel: 0, hivel: 127, rr: 1, trigger: 'pedalDown' },
    ];
    const keep = playedZones(zones, [], [64]);
    expect([...(keep ?? [])].sort()).toEqual([0, 1, 2, 3]);
    const spec: SamplerSpec = {
      key: 'made',
      zones: zones.map(sampleZone),
      release: 0.02,
      oneShot: false,
      pitched: true,
      velocityRange: 0,
      attack: 0,
    };
    const events: Event[] = [
      [0, 'on', 64, 100],
      [600, 'cc', 64, 127],
      // (while the pedal's own sound is still sounding)
      [700, 'cc', 123, 0],
    ];
    const whole = played(new Sampler(SR, spec), events, 4800);
    const kept = played(new Sampler(SR, { ...spec, zones: spec.zones.filter((_z, i) => keep?.has(i)) }), events, 4800);
    expect(same(whole[0], kept[0])).toBe(true);
    // without it the release would go unheard: it is something
    const without = played(new Sampler(SR, { ...spec, zones: spec.zones.filter((_z, i) => i !== 1) }), events, 4800);
    expect(same(whole[0], without[0])).toBe(false);
  });

  it('keep a set whole when what’s kept of it would have no microphone and the set has one', () => {
    // two zones tie for 60 to 62; a third, far off, is the only one on a microphone
    const zones: Made[] = [
      { lo: 60, hi: 64, lovel: 0, hivel: 127, rr: 1 },
      { lo: 60, hi: 62, lovel: 0, hivel: 127, rr: 2 },
      { lo: 90, hi: 90, lovel: 0, hivel: 127, rr: 1, mic: 'm' },
    ];
    expect([...(playedZones(zones, ['m'], [62, 64]) ?? [])].sort()).toEqual([0, 1, 2]);
    // (with no such microphone on the instrument, the far zone is nothing to these keys)
    expect([...(playedZones(zones, [], [62, 64]) ?? [])].sort()).toEqual([0, 1]);
    const spec: SamplerSpec = {
      key: 'made',
      zones: zones.map(sampleZone),
      release: 0.02,
      oneShot: false,
      pitched: true,
      velocityRange: 0,
      attack: 0,
      mics: [{ id: 'm', name: 'M' }],
    };
    const events: Event[] = [
      [0, 'on', 62, 100],
      [900, 'on', 62, 100],
      [1800, 'on', 64, 100],
      [2700, 'on', 62, 100],
    ];
    const whole = played(new Sampler(SR, spec), events, 4800);
    // left out, the round robins would turn another way: why it is kept
    const without = played(new Sampler(SR, { ...spec, zones: spec.zones.slice(0, 2) }), events, 4800);
    expect(same(whole[0], without[0])).toBe(false);
  });
});

describe('the zones of an instrument a song’s keys can sound', () => {
  const z = (lo: number, hi: number, lovel = 0, hivel = 127, more: Partial<Made> = {}): Made => ({
    lo,
    hi,
    lovel,
    hivel,
    rr: 1,
    ...more,
  });
  const kept = (zones: Made[], keys: number[], mics: string[] = []) =>
    [...(playedZones(zones, mics, keys) ?? [-1])].sort((a, b) => a - b);

  it('are every velocity layer and round robin of the keys played, and nothing of the others', () => {
    const zones = [
      z(48, 59, 1, 60),
      z(48, 59, 61, 127),
      z(60, 71, 1, 60),
      z(60, 71, 61, 127, { rr: 1 }),
      z(60, 71, 61, 127, { rr: 2 }),
      z(72, 83),
    ];
    expect(kept(zones, [64])).toEqual([2, 3, 4]);
    expect(kept(zones, [50, 80])).toEqual([0, 1, 5]);
    expect(kept(zones, [])).toEqual([]);
  });

  it('are the nearest for a key outside them all, as the sampler takes it', () => {
    const zones = [z(40, 50), z(60, 70), z(60, 70, 0, 127, { rr: 2 }), z(90, 95)];
    expect(kept(zones, [55])).toEqual([0, 1, 2]);
    expect(kept(zones, [56])).toEqual([1, 2]);
    expect(kept(zones, [120])).toEqual([3]);
    expect(kept(zones, [-3])).toEqual([0]);
  });

  it('are both neighbours of a key between two', () => {
    const zones = [z(59, 59), z(60, 60), z(61, 61), z(62, 62)];
    expect(kept(zones, [Math.fround(60.5)])).toEqual([1, 2]);
    // (nearer one of them: the other still wins at some velocities, within a semitone of it)
    expect(kept(zones, [Math.fround(60.3)])).toEqual([1, 2]);
    expect(kept(zones, [60])).toEqual([1]);
  });

  it('take release samples by their own nearest, part by part, whatever the struck zones cover', () => {
    const zones = [
      z(21, 108),
      // dampers stop below the top keys: a release sample for 21 to 88 only
      z(21, 50, 0, 127, { trigger: 'release' }),
      z(51, 88, 0, 127, { trigger: 'release' }),
      // a second part (hammers) in one zone
      z(0, 127, 0, 127, { trigger: 'release', part: 1 }),
    ];
    // a top key lets go through the nearest damper sample (and the pedal's voice, key -1, through the lowest)
    expect(kept(zones, [100])).toEqual([0, 1, 2, 3]);
    expect(kept(zones, [30])).toEqual([0, 1, 3]);
  });

  it('keep the pedal’s sounds whole, and don’t let them stand in for a struck zone', () => {
    const zones = [
      z(60, 72),
      z(0, 127, 0, 127, { trigger: 'pedalDown' }),
      z(0, 127, 0, 127, { trigger: 'pedalUp' }),
      z(0, 127, 0, 127, { trigger: 'pedalUp', rr: 2 }),
    ];
    // (a key far outside the struck zones still takes the nearest of them)
    expect(kept(zones, [30])).toEqual([0, 1, 2, 3]);
    expect(kept(zones, [])).toEqual([1, 2, 3]);
  });

  it('are all of them where a zone is nothing it reasons about', () => {
    expect(playedZones([z(60, 72, 5000, 6000)], [], [64])).toBeNull();
    expect(playedZones([z(60, 72, -1, 127)], [], [64])).toBeNull();
    expect(playedZones([z(Number.NaN, 72)], [], [64])).toBeNull();
    expect(playedZones([z(60, 1e9)], [], [64])).toBeNull();
    expect(playedZones([z(60, 72)], [], [1e17])).toBeNull();
    expect(playedZones([z(60, 72)], [], [Number.NaN])).toBeNull();
  });
});

describe('the keys a song sends each sampled instrument', () => {
  const sampler = (name: string) => ({ type: 'sampler' as const, pack: 'test', name });
  const notes = (...pitches: number[]): Region => ({
    ...newRegion(0, PPQ * 4),
    notes: pitches.map((p, i) => ({ t: i * 120, d: 100, p, v: 90 })),
  });
  const song = (...tracks: Track[]) => {
    const p = newProject('Keys');
    p.tracks = tracks;
    return performed(p);
  };
  const track = (name: string, ...regions: Region[]) => ({ ...newTrack(name, sampler(name)), regions });
  const sorted = (keys: number[] | null | undefined) => keys && [...keys].sort((a, b) => a - b);

  it('are its tracks’ notes, every region’s, muted or not, a fractional one as the engine has it', () => {
    const muted = { ...notes(72), muted: true };
    const keys = playedKeys(
      song(track('piano', notes(60, 64, 67.3), muted), newTrack('Synth', { type: 'synth', preset: 'Soft Keys' })),
    );
    expect([...keys.keys()]).toEqual(['test/piano']);
    expect(sorted(keys.get('test/piano'))).toEqual([60, 64, Math.fround(67.3), 72]);
  });

  it('are every track’s on the instrument together, and an articulation’s sampler gets its track’s', () => {
    const a = track('piano', notes(60));
    const b = track('piano', notes(48, 60));
    b.articulations = [{ id: 'art_1', name: 'Mute', instrument: sampler('muted') }];
    const keys = playedKeys(song(a, b));
    expect(sorted(keys.get('test/piano'))).toEqual([48, 60]);
    expect(sorted(keys.get('test/muted'))).toEqual([48, 60]);
  });

  it('are none for an instrument that only hears the pedal, and an inactive track counts for nothing', () => {
    const quiet = track('piano');
    const off = { ...track('strings', notes(55)), inactive: true };
    const keys = playedKeys(song(quiet, off));
    expect(keys.get('test/piano')).toEqual([]);
    expect(keys.has('test/strings')).toBe(false);
  });

  it('can’t be told where a MIDI effect plays, unless it’s bypassed', () => {
    const arp = track('piano', notes(60));
    arp.midiFx = [newPlugin('arpeggiator')];
    expect(playedKeys(song(arp)).get('test/piano')).toBeNull();
    // (and the same instrument on a plain track is then whole too)
    expect(playedKeys(song(track('piano', notes(48)), arp)).get('test/piano')).toBeNull();
    expect(playedKeys(song(arp, track('piano', notes(48)))).get('test/piano')).toBeNull();
    arp.midiFx = [{ ...newPlugin('arpeggiator'), bypass: true }];
    expect(sorted(playedKeys(song(arp)).get('test/piano'))).toEqual([60]);
  });

  it('are none from a planned part’s notes, and can’t be told where a MIDI effect plays over one', () => {
    const planned = {
      ...newTrack('Violins', { type: 'performance', pack: 'test', name: 'piano' }),
      regions: [notes(70)],
    };
    expect(playedKeys(song(planned, track('piano', notes(60)))).get('test/piano')).toEqual([60]);
    // the Session Drummer plays from no notes at all, on whatever sampler the track has
    planned.midiFx = [newPlugin('drummer')];
    expect(playedKeys(song(planned, track('piano', notes(60)))).get('test/piano')).toBeNull();
  });

  it('can’t be told for a kit a plugin plays, a track’s own instrument or not', () => {
    const drums = track('kit', notes(36, 38));
    const replaced = newTrack('Snare', { type: 'synth', preset: 'Soft Keys' });
    replaced.channel.inserts = [{ ...newPlugin('replacer'), settings: { kit: 'test/kit' } }];
    const keys = playedKeys(song(drums, replaced, track('piano', notes(60))));
    expect(keys.get('test/kit')).toBeNull();
    expect(keys.get('test/piano')).toEqual([60]);
  });

  it('can’t be told from a note that isn’t one', () => {
    const odd = (p: number, v: number) =>
      playedKeys(song(track('piano', { ...newRegion(0, PPQ), notes: [{ t: 0, d: 10, p, v }] })));
    expect(odd(60, 5000).get('test/piano')).toBeNull();
    expect(odd(60, -1).get('test/piano')).toBeNull();
    expect(odd(Number.NaN, 90).get('test/piano')).toBeNull();
    expect(odd(1e30, 90).get('test/piano')).toBeNull();
    expect(odd(60, 999).get('test/piano')).toEqual([60]);
  });
});

// ---- whole renders, from a made-up pack ----

/** A pack in memory: its instruments' manifests and its files, and what was asked of it. */
function pack(r: Rnd, instruments: readonly string[]) {
  const files = new Map<string, Uint8Array>();
  const manifests = new Map<string, InstrumentManifest>();
  for (const name of instruments) {
    const mics = ['near', 'far'].slice(0, r.of([0, 0, 1, 2]));
    const zones: ZoneManifest[] = madeZones(r, mics).map((z, n) => {
      // (now and then a zone of the same file as another, and files at another rate than the render's)
      const file = `${name}/${r.chance(0.15) && n ? n - 1 : n}.wav`;
      if (!files.has(file)) {
        const rate = r.of([SR, SR, 44100]);
        const level = 0.05 + ((n * 37) % 89) / 100;
        const mono = Float32Array.from({ length: 900 }, (_, i) => level * Math.sin((i * (n + 3)) / 17));
        files.set(file, encodeWav(r.chance(0.5) ? [mono] : [mono, mono.map((v) => v * 0.4)], rate));
      }
      const { lo, hi, lovel, hivel, rr, ...rest } = z;
      return {
        file,
        root: Math.round((lo + hi) / 2),
        lo,
        hi,
        lovel,
        hivel,
        gain: -3,
        start: r.of([0, 0, 40]),
        end: r.of([0, 700, 850]),
        loopStart: 0,
        loopEnd: 0,
        rate: SR,
        rr,
        ...(r.chance(0.2) ? { fadeOut: 100 } : {}),
        ...rest,
      };
    });
    manifests.set(name, {
      pack: 'test',
      name,
      release: 0.02,
      attack: 0,
      oneShot: r.chance(0.2),
      pitched: true,
      velocityRange: 20,
      zones,
      ...(mics.length ? { mics: mics.map((id) => ({ id, name: id })) } : {}),
      ...(r.chance(0.3) ? { releaseDecay: 6 } : {}),
    } as InstrumentManifest);
  }
  const asked: string[] = [];
  const source: RenderSource = {
    instrument: async (_pack, name) => manifests.get(name) as InstrumentManifest,
    sample: async (_pack, file) => {
      asked.push(file);
      return files.get(file) as Uint8Array;
    },
    audio: () => Promise.reject(new Error('no audio here')),
    impulse: () => Promise.reject(new Error('no packs here')),
  };
  return { source, asked, manifests, files };
}

const BAR = PPQ * 4;

/** A made-up song on the pack's instruments: tracks sharing them, an articulation, a muted region, the pedal and all-notes-off. */
function madeSong(r: Rnd, instruments: readonly string[]): Project {
  const p = newProject('Made up');
  p.buses = [];
  p.master.inserts = [];
  p.tempo = [{ tick: 0, bpm: 240 }];
  p.tracks = Array.from({ length: r.int(1, 3) }, (_, t) => {
    const track = newTrack(`T${t}`, { type: 'sampler', pack: 'test', name: r.of(instruments) });
    track.channel.sends = [];
    track.channel.inserts = [];
    if (r.chance(0.4))
      track.articulations = [
        { id: 'art_x', name: 'Other', instrument: { type: 'sampler', pack: 'test', name: r.of(instruments) } },
      ];
    const pool = Array.from({ length: r.int(1, 6) }, () => r.of(KEYS));
    track.regions = Array.from({ length: r.int(1, 3) }, (_, g) => {
      const region = newRegion(g * BAR, BAR);
      for (let at = 0; at < BAR; at += r.int(60, 600))
        region.notes.push({
          t: at,
          d: r.int(30, 500),
          p: r.of(pool),
          v: r.of(VELOCITIES),
          ...(r.chance(0.3) ? { art: 'art_x' } : {}),
        });
      if (r.chance(0.5))
        region.cc['64'] = [
          [r.int(0, BAR / 2), 127],
          [r.int(BAR / 2, BAR), 0],
        ];
      if (r.chance(0.2)) region.cc['123'] = [[r.int(0, BAR), 0]];
      if (r.chance(0.15)) region.muted = true;
      return region;
    });
    return track;
  });
  if (r.chance(0.2)) p.loop = { start: 0, end: BAR * 2, tail: 0.1 };
  return p;
}

describe('a render of the zones its song can sound', () => {
  it('is the render of them all, to the byte, for a hundred made-up songs', async () => {
    let askedAll = 0;
    let askedPlayed = 0;
    let loud = 0;
    for (let n = 1; n <= 100; n++) {
      const r = seeded(n + 5000);
      const instruments = ['a', 'b'];
      const { source, asked } = pack(r, instruments);
      const song = madeSong(r, instruments);
      const range = !song.loop && r.chance(0.3) ? { from: BAR / 2, to: BAR + BAR / 2 } : {};
      const opts = { sampleRate: SR, tail: 0.1, finish: false, ...range };
      const all = await renderSession(song, source, { ...opts, samples: 'all' });
      askedAll += asked.splice(0).length;
      const some = await renderSession(song, source, opts);
      askedPlayed += asked.splice(0).length;
      expect(some.errors, `song ${n}`).toEqual(all.errors);
      expect(some.channels.length, `song ${n}`).toBe(all.channels.length);
      for (const [c, channel] of all.channels.entries())
        if (!same(channel, some.channels[c] as Float32Array)) throw new Error(`song ${n}: another render`);
      if ((all.channels[0] as Float32Array).some((v) => v !== 0)) loud++;
    }
    expect(loud).toBeGreaterThan(80);
    expect(askedPlayed).toBeLessThan(askedAll * 0.75);
  }, 120_000);

  it('asks its source only for the files of those zones, and for all of an instrument it can’t tell the keys of', async () => {
    // a key to a zone, two octaves of them
    const zones: ZoneManifest[] = Array.from({ length: 24 }, (_, i) => ({
      file: `k${48 + i}.wav`,
      root: 48 + i,
      lo: 48 + i,
      hi: 48 + i,
      lovel: 0,
      hivel: 127,
      gain: 0,
      start: 0,
      end: 0,
      loopStart: 0,
      loopEnd: 0,
      rate: SR,
      rr: 1,
    }));
    const manifest = {
      pack: 'test',
      name: 'keys',
      release: 0.02,
      attack: 0,
      oneShot: false,
      pitched: true,
      velocityRange: 0,
    };
    const asked: string[] = [];
    const wav = encodeWav([Float32Array.from({ length: 600 }, (_, i) => Math.sin(i / 9) * 0.5)], SR);
    const source = (extra: Partial<InstrumentManifest> = {}, list = zones): RenderSource => ({
      instrument: async () => ({ ...manifest, zones: list, ...extra }) as InstrumentManifest,
      sample: async (_pack, file) => {
        asked.push(file);
        return wav;
      },
      audio: () => Promise.reject(new Error('no audio here')),
      impulse: () => Promise.reject(new Error('no packs here')),
    });
    const song = newProject('Three keys');
    const track = newTrack('Keys', { type: 'sampler', pack: 'test', name: 'keys' });
    track.regions = [{ ...newRegion(0, BAR), notes: [50, 55, 62.5].map((p, i) => ({ t: i * PPQ, d: PPQ, p, v: 90 })) }];
    song.tracks = [track];
    const opts = { sampleRate: SR, tail: 0.1, finish: false };

    const some = await renderSession(song, source(), opts);
    expect(asked.splice(0).sort()).toEqual(['k50.wav', 'k55.wav', 'k62.wav', 'k63.wav']);
    const all = await renderSession(song, source(), { ...opts, samples: 'all' });
    expect(asked.splice(0)).toHaveLength(24);
    expect(same(all.channels[0] as Float32Array, some.channels[0] as Float32Array)).toBe(true);
    expect((all.channels[0] as Float32Array).some((v) => v !== 0)).toBe(true);

    // a MIDI effect on the track: every zone, as ever
    track.midiFx = [newPlugin('arpeggiator')];
    await renderSession(song, source(), opts);
    expect(asked.splice(0)).toHaveLength(24);
    track.midiFx = [];

    // an instrument that plays through a synth (its zones are a patch's data), one with a partial set
    // among its zones, one with a zone it doesn't reason about: every zone
    await buildSampler(source({ synth: 'Glass Pad' } as Partial<InstrumentManifest>), 'test', 'keys', SR, [50]);
    expect(asked.splice(0)).toHaveLength(24);
    const partial = [...zones.slice(0, 23), { ...(zones[23] as ZoneManifest), partials: true }];
    await buildSampler(source({}, partial), 'test', 'keys', SR, [50]);
    expect(asked.splice(0)).toHaveLength(24);
    const odd = [...zones.slice(0, 23), { ...(zones[23] as ZoneManifest), lovel: 5000, hivel: 6000 }];
    await buildSampler(source({}, odd), 'test', 'keys', SR, [50]);
    expect(asked.splice(0)).toHaveLength(24);
    // and with keys it's told, or none it's told of at all
    await buildSampler(source(), 'test', 'keys', SR, [50]);
    expect(asked.splice(0)).toEqual(['k50.wav']);
    await buildSampler(source(), 'test', 'keys', SR);
    expect(asked.splice(0)).toHaveLength(24);
    await buildSampler(source(), 'test', 'keys', SR, null);
    expect(asked.splice(0)).toHaveLength(24);
  });
});
