import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWav } from '@holo/engine';
import { newPlugin, newRegion, newTrack, type Project, type Track } from '@holo/session';
import { afterAll, describe, expect, it } from 'vitest';
import { renderRange, runTask, soloCopy } from '../src/agent/measure/tasks.ts';
import { BAR, SR, takeWorld, tone } from './measure-fakes.ts';

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** The take's song, with its Keys (a synth, sent to the reverb bus) playing chords through bars 1–4. */
function world(format: 'wav' | 'flac' = 'wav') {
  const w = takeWorld(format);
  made.push(join(w.dataDir, '..'));
  const keys = w.song.tracks[0] as Track;
  const r = newRegion(0, BAR * 4, 'Chords');
  for (let b = 0; b < 4; b++) for (const p of [50, 53, 57]) r.notes.push({ t: b * BAR, d: BAR, p, v: 90 });
  keys.regions.push(r);
  return { ...w, keys };
}

const progressOf = () => {
  const seen: number[] = [];
  return { seen, progress: (f: number) => void seen.push(f) };
};

describe('the measurements', () => {
  it('renders the mix as it plays, from two bars before, and measures what was asked', async () => {
    const { dataDir, song } = world();
    expect(renderRange(song, BAR * 2, BAR * 4)).toEqual({ start: 0, from: BAR * 2, to: BAR * 4 });
    const { seen, progress } = progressOf();
    const r = await runTask({ kind: 'mix', dataDir, project: song, from: BAR * 2, to: BAR * 4 }, progress);
    if (r.kind !== 'mix') throw new Error(r.kind);
    expect(r).toMatchObject({ source: 'render', tick: BAR * 2, end: BAR * 4, errors: [] });
    // two bars at 120: four seconds, the pre-roll left out
    expect(r.loudness.seconds).toBeCloseTo(4, 1);
    expect(r.loudness.integrated).toBeLessThan(-6);
    expect(r.loudness.truePeak).not.toBeNull();
    expect(r.sections).toHaveLength(1);
    expect(r.octaves).toHaveLength(10);
    expect(r.tilt).not.toBeNull();
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.every((f, i) => i === 0 || f >= (seen[i - 1] as number))).toBe(true);
  });

  it('plays a FLAC recording in a render', async () => {
    const { dataDir, song, keys } = world('flac');
    keys.channel.mute = true;
    const r = await runTask({ kind: 'mix', dataDir, project: song, from: BAR, to: BAR * 3 }, () => {});
    if (r.kind !== 'mix') throw new Error(r.kind);
    expect(r.errors).toEqual([]);
    expect(r.loudness.integrated).toBeGreaterThan(-30);
  });

  it('renders each track alone, says which play nothing, and where two compete', async () => {
    const { dataDir, song, keys, vocals } = world();
    const empty = { ...newTrack('Empty', { type: 'synth', preset: 'Warm Pad' }), id: 'trk_empty' };
    song.tracks.push(empty);
    keys.channel.mute = true;
    const r = await runTask({ kind: 'tracks', dataDir, project: song, tracks: [keys.id, vocals.id] }, () => {});
    if (r.kind !== 'tracks') throw new Error(r.kind);
    const [k, v] = r.tracks;
    expect(k).toMatchObject({ name: 'Keys', muted: true, silent: false, output: 'master' });
    expect(k?.lufs).not.toBeNull();
    expect(v?.source?.lufs).not.toBeNull();
    // the recording alone, mono, a channel's worth of power under the track as it reaches the master
    expect((v?.lufs ?? 0) - (v?.source?.lufs ?? 0)).toBeCloseTo(3, 0);
    expect(r.masking).toMatchObject({ a: keys.id, b: vocals.id });
    const alone = await runTask({ kind: 'tracks', dataDir, project: song, tracks: [empty.id] }, () => {});
    if (alone.kind !== 'tracks') throw new Error(alone.kind);
    expect(alone.tracks[0]).toMatchObject({ silent: true, lufs: null });
  });

  it('reads a filter’s, a reverb’s and a delay’s response to an impulse', async () => {
    const { dataDir, song, keys } = world();
    const eq = newPlugin('eq', { b2Freq: 1000, b2Gain: 12, b2Q: 1 });
    const delay = newPlugin('delay', { sync: 0, time: 300, feedback: 50, mix: 50, lowcut: 20, highcut: 20000 });
    keys.channel.inserts.push(eq, delay);
    const response = async (channel: string, plugin: string) => {
      const r = await runTask({ kind: 'plugin', dataDir, project: song, channel, plugin }, () => {});
      if (r.kind !== 'plugin' || !r.response) throw new Error('no response');
      return r.response;
    };
    const g = await response(keys.id, eq.id);
    expect(g.thirds[16]).toBeCloseTo(12, 0); // 1 kHz
    expect(Math.abs(g.thirds[4] ?? 99)).toBeLessThan(1); // 63 Hz
    const d = await response(keys.id, delay.id);
    expect(d.echoes?.map(([ms]) => Math.round(ms / 10) * 10).slice(0, 2)).toEqual([300, 600]);
    const bus = song.buses[0];
    const reverb = bus?.channel.inserts[0];
    const rv = await response(bus?.id ?? '', reverb?.id ?? '');
    expect(rv.decay).toBeGreaterThan(0.5);
    expect(rv.predelay).toBeGreaterThan(5);
  });

  it('measures a compressor’s gain reduction on its track’s own sound', async () => {
    const { dataDir, song, keys } = world();
    const comp = newPlugin('compressor', { threshold: -40, ratio: 4, attack: 5, release: 100 });
    keys.channel.inserts.push(comp, newPlugin('saturator'));
    keys.channel.volume = -20;
    const r = await runTask({ kind: 'plugin', dataDir, project: song, channel: keys.id, plugin: comp.id }, () => {});
    if (r.kind !== 'plugin' || !r.signal) throw new Error('no signal');
    expect(r.method).toBe('signal');
    expect(r.signal.gr?.active).toBeGreaterThan(0.5);
    expect(r.signal.gr?.median).toBeGreaterThan(3);
    expect((r.signal.out.lufs ?? 0) < (r.signal.in.lufs ?? 0)).toBe(true);
    // on a bus, only what a plugin's response says is measured
    const bus = song.buses[0] as Project['buses'][number];
    const busComp = newPlugin('compressor');
    bus.channel.inserts.push(busComp);
    await expect(
      runTask({ kind: 'plugin', dataDir, project: song, channel: bus.id, plugin: busComp.id }, () => {}),
    ).rejects.toThrow('on a bus');
  });

  it('renders what plays a pack that isn’t installed here silent, as the studio does, and says so', async () => {
    const { dataDir, song, keys } = world();
    // no packs in this data folder: the piano's (with a compressor) and the Drum Replacer's kit are missing
    const piano = { ...newTrack('Piano', { type: 'sampler', pack: 'vsco2', name: 'piano' }), id: 'trk_piano' };
    const r = newRegion(0, BAR * 4, 'Chords');
    r.notes.push({ t: 0, d: BAR * 4, p: 60, v: 90 });
    piano.regions.push(r);
    const comp = newPlugin('compressor');
    piano.channel.inserts.push(comp);
    song.tracks.push(piano);
    const replacer = { ...newPlugin('replacer'), settings: { kit: 'vsco2/kit' } };
    keys.channel.inserts.push(replacer);
    keys.channel.automation = [{ param: `fx:${replacer.id}:mix`, points: [[0, 50]], mode: 'read' }];
    const unplayable = {
      tracks: [{ id: piano.id, name: 'Piano', pack: 'vsco2' }],
      plugins: [{ id: replacer.id, name: 'Drum Replacer', channel: keys.id, pack: 'vsco2' }],
    };
    const mix = await runTask({ kind: 'mix', dataDir, project: song, from: BAR, to: BAR * 3 }, () => {});
    if (mix.kind !== 'mix') throw new Error(mix.kind);
    expect(mix.unplayable).toEqual(unplayable);
    expect(mix.errors).toEqual([]);
    // the same as the mix without them
    const without = structuredClone(song);
    without.tracks = without.tracks.filter((t) => t.id !== piano.id);
    const k = without.tracks.find((t) => t.id === keys.id) as Track;
    k.channel.inserts = k.channel.inserts.filter((p) => p.id !== replacer.id);
    k.channel.automation = [];
    const plain = await runTask({ kind: 'mix', dataDir, project: without, from: BAR, to: BAR * 3 }, () => {});
    if (plain.kind !== 'mix') throw new Error(plain.kind);
    expect(plain.unplayable).toBeUndefined();
    expect(mix.loudness.integrated).toBeCloseTo(plain.loudness.integrated ?? 0, 1);
    // the song itself is left as it is
    expect(piano.instrument).toEqual({ type: 'sampler', pack: 'vsco2', name: 'piano' });
    expect(keys.channel.inserts.map((p) => p.id)).toContain(replacer.id);
    // each track alone: the piano silent, the Keys without its replacer
    const each = await runTask({ kind: 'tracks', dataDir, project: song, tracks: [piano.id, keys.id] }, () => {});
    if (each.kind !== 'tracks') throw new Error(each.kind);
    expect(each.tracks[0]).toMatchObject({ name: 'Piano', silent: true, missing: 'vsco2', lufs: null });
    expect(each.tracks[1]?.lufs).not.toBeNull();
    expect(each.unplayable).toEqual(unplayable);
    const vocalsAlone = await runTask({ kind: 'tracks', dataDir, project: song, tracks: ['trk_vocals'] }, () => {});
    expect(vocalsAlone.kind === 'tracks' && vocalsAlone.unplayable).toBeUndefined();
    // a plugin with nothing to work on, or one that plays the missing pack itself, says why
    await expect(
      runTask({ kind: 'plugin', dataDir, project: song, channel: piano.id, plugin: comp.id }, () => {}),
    ).rejects.toThrow("Piano plays vsco2, a pack that isn't installed here");
    await expect(
      runTask({ kind: 'plugin', dataDir, project: song, channel: keys.id, plugin: replacer.id }, () => {}),
    ).rejects.toThrow("The Drum Replacer plays a sound from vsco2, a pack that isn't installed here");
  });

  it('measures a bounce, as the song from its start', async () => {
    const { dataDir, song } = world();
    const dir = join(dataDir, 'bounces', song.id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, '2026-11-12 10.00.00 Measured.wav');
    const s = tone(69 + 12 * Math.log2(1000 / 440), 8, 0.1);
    writeFileSync(path, encodeWav([s, s], SR, 'pcm24'));
    const r = await runTask({ kind: 'file', path, name: 'x.wav', source: 'bounce', project: song }, () => {});
    if (r.kind !== 'mix') throw new Error(r.kind);
    expect(r.source).toBe('bounce');
    expect(r.loudness.integrated).toBeCloseTo(-20, 0);
    expect(r.tick).toBe(0);
  });

  it('makes a track’s solo copy: it alone, out to a bare master; before a plugin, without its fader', () => {
    const { song, keys } = world();
    const eq = newPlugin('eq');
    const comp = newPlugin('compressor');
    keys.channel.inserts.push(eq, comp);
    keys.channel.volume = -6;
    keys.channel.automation = [
      { param: 'volume', points: [[0, -6]], mode: 'read' },
      { param: `fx:${eq.id}:b2Gain`, points: [[0, 3]], mode: 'read' },
      { param: `send:${song.buses[0]?.id}`, points: [[0, -10]], mode: 'read' },
    ];
    const solo = soloCopy(song, keys.id);
    expect(solo.tracks.map((t) => t.id)).toEqual([keys.id]);
    expect(solo.buses).toEqual([]);
    expect(solo.tracks[0]?.channel).toMatchObject({ sends: [], output: 'master', volume: -6 });
    expect(solo.master).toMatchObject({ inserts: [], volume: 0, automation: [] });
    expect(solo.tracks[0]?.channel.automation?.map((a) => a.param)).toEqual(['volume', `fx:${eq.id}:b2Gain`]);
    const before = soloCopy(song, keys.id, comp.id);
    expect(before.tracks[0]?.channel.inserts.map((p) => p.id)).toEqual([eq.id]);
    expect(before.tracks[0]?.channel).toMatchObject({ volume: 0, pan: 0 });
    expect(before.tracks[0]?.channel.automation?.map((a) => a.param)).toEqual([`fx:${eq.id}:b2Gain`]);
    // the song itself is left as it was
    expect(song.tracks).toHaveLength(2);
  });
});
