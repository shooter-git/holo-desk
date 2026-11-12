import { describe, expect, it } from 'vitest';
import {
  type AudioClip,
  fadeTo,
  fileSpan,
  newProject,
  newRegion,
  PPQ,
  type Project,
  type Region,
  secondsToTick,
  setStretch,
  stretchMidi,
  tickToSeconds,
  trimEnd,
  trimMidiStart,
  trimStart,
} from '../src/index.ts';

// ---- the studio's own code, as apps/web/src/ui/wave.ts had it before it moved here ----

const seconds = (project: Project, from: number, to: number) =>
  tickToSeconds(project.tempo, to) - tickToSeconds(project.tempo, from);

const was = {
  fileSpan(project: Project, region: Pick<Region, 'start'>, clip: AudioClip): [number, number] {
    const file = project.files?.find((f) => f.id === clip.file);
    const s0 = tickToSeconds(project.tempo, region.start);
    const start = secondsToTick(project.tempo, Math.max(0, s0 - clip.offset * clip.stretch));
    const end = file
      ? secondsToTick(project.tempo, s0 + (file.seconds - clip.offset) * clip.stretch)
      : Number.POSITIVE_INFINITY;
    return [start, end];
  },
  trimEnd(project: Project, region: Region, clip: AudioClip, length: number, stretch: boolean) {
    if (stretch) {
      const before = seconds(project, region.start, region.start + region.length);
      const ratio = seconds(project, region.start, region.start + Math.max(1, length)) / before;
      const s = Math.round(Math.max(0.25, Math.min(4, clip.stretch * ratio)) * 10000) / 10000;
      const sec = (before * s) / clip.stretch;
      const end = secondsToTick(project.tempo, tickToSeconds(project.tempo, region.start) + sec);
      return { length: Math.max(1, Math.round(end - region.start)), audio: { ...clip, stretch: s } };
    }
    const [, fileEnd] = was.fileSpan(project, region, clip);
    return { length: Math.max(1, Math.min(Math.round(length), Math.floor(fileEnd - region.start))), audio: clip };
  },
  trimStart(project: Project, region: Region, clip: AudioClip, start: number) {
    const end = region.start + region.length;
    const [fileStart] = was.fileSpan(project, region, clip);
    const s = Math.round(Math.max(Math.ceil(fileStart), 0, Math.min(end - 1, start)));
    const offset = Math.max(0, clip.offset + seconds(project, region.start, s) / clip.stretch);
    return { start: s, length: end - s, audio: { ...clip, offset } };
  },
  fadeTo(project: Project, region: Region, clip: AudioClip, which: 'fadeIn' | 'fadeOut', tick: number) {
    const total = seconds(project, region.start, region.start + region.length);
    const sec = seconds(project, region.start, tick);
    const ms = (v: number) => Math.round(v * 1000) / 1000;
    return which === 'fadeIn'
      ? { ...clip, fadeIn: ms(Math.max(0, Math.min(total - clip.fadeOut, sec))) }
      : { ...clip, fadeOut: ms(Math.max(0, Math.min(total - clip.fadeIn, total - sec))) };
  },
  setStretch(project: Project, region: Region, clip: AudioClip, stretch: number): Region {
    const s = Math.round(Math.max(0.25, Math.min(4, stretch)) * 10000) / 10000;
    const sec = (seconds(project, region.start, region.start + region.length) * s) / clip.stretch;
    const end = secondsToTick(project.tempo, tickToSeconds(project.tempo, region.start) + sec);
    return { ...region, length: Math.max(1, Math.round(end - region.start)), audio: { ...clip, stretch: s } };
  },
};

const BAR = PPQ * 4;

function songs(): Project[] {
  const one = newProject('One tempo');
  one.files = [{ id: 'aud_a', name: 'a.wav', seconds: 40, rate: 48000, channels: 2 }];
  const many = newProject('Tempo changes');
  many.files = one.files;
  many.tempo = [
    { tick: 0, bpm: 92 },
    { tick: 3 * BAR, bpm: 140 },
    { tick: 5 * BAR + PPQ, bpm: 71.5 },
  ];
  return [one, many];
}

const clips: AudioClip[] = [
  { file: 'aud_a', offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 },
  { file: 'aud_a', offset: 2.37, gain: -4, fadeIn: 0.3, fadeOut: 1.1, stretch: 1.6 },
  { file: 'aud_a', offset: 11, gain: 2, fadeIn: 0, fadeOut: 0.05, stretch: 0.5 },
  { file: 'aud_missing', offset: 1, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 },
];

const regions = (clip: AudioClip): Region[] =>
  [
    [0, 2 * BAR],
    [2 * BAR + 333, 3 * BAR],
    [4 * BAR, BAR + 17],
  ].map(([start, length]) => ({ ...newRegion(start as number, length as number), audio: clip }));

describe('the audio region arithmetic, moved from the studio', () => {
  it('gives the very same numbers as the studio’s own code did', () => {
    let checked = 0;
    for (const project of songs()) {
      for (const clip of clips) {
        for (const region of regions(clip)) {
          expect(fileSpan(project, region, clip)).toEqual(was.fileSpan(project, region, clip));
          for (const length of [1, PPQ, BAR + 5, 3 * BAR, 40 * BAR]) {
            for (const stretch of [false, true])
              expect(trimEnd(project, region, clip, length, stretch)).toEqual(
                was.trimEnd(project, region, clip, length, stretch),
              );
          }
          for (const start of [-BAR, 0, region.start - PPQ, region.start + 7, region.start + region.length + BAR])
            expect(trimStart(project, region, clip, start)).toEqual(was.trimStart(project, region, clip, start));
          for (const tick of [region.start - 10, region.start + PPQ, region.start + region.length / 2, 99 * BAR]) {
            expect(fadeTo(project, region, clip, 'fadeIn', tick)).toEqual(
              was.fadeTo(project, region, clip, 'fadeIn', tick),
            );
            expect(fadeTo(project, region, clip, 'fadeOut', tick)).toEqual(
              was.fadeTo(project, region, clip, 'fadeOut', tick),
            );
          }
          for (const s of [0.1, 0.5, 1, 1.37, 2, 9])
            expect(setStretch(project, region, clip, s)).toEqual(was.setStretch(project, region, clip, s));
          checked++;
        }
      }
    }
    expect(checked).toBe(24);
  });
});

describe('a MIDI region’s edges', () => {
  const region = (): Region => ({
    ...newRegion(BAR, 2 * BAR),
    notes: [
      { t: 0, d: PPQ, p: 60, v: 90 },
      { t: PPQ * 2, d: PPQ, p: 62, v: 90 },
      { t: BAR, d: PPQ, p: 64, v: 90 },
    ],
    cc: {
      '1': [
        [0, 20],
        [PPQ, 40],
        [BAR + PPQ, 90],
      ],
    },
    marks: [
      { t: 0, k: 'dyn', v: 'p' },
      { t: PPQ * 2, k: 'cresc', e: BAR + PPQ },
    ],
  });

  it('trims its start later, its notes staying where they are in the song', () => {
    const r = trimMidiStart(region(), BAR + PPQ * 2);
    expect([r.start, r.length]).toEqual([BAR + PPQ * 2, 2 * BAR - PPQ * 2]);
    expect(r.notes.map((n) => n.t)).toEqual([0, BAR - PPQ * 2]);
    expect(r.cc['1']).toEqual([
      [0, 40],
      [BAR - PPQ, 90],
    ]);
    expect(r.marks).toEqual([{ t: 0, k: 'cresc', e: BAR - PPQ }]);
  });

  it('trims its start earlier, and stretches it in time', () => {
    const early = trimMidiStart(region(), 0);
    expect([early.start, early.length, early.notes[0]?.t]).toEqual([0, 3 * BAR, BAR]);
    const twice = stretchMidi(region(), 2);
    expect(twice.length).toBe(4 * BAR);
    expect(twice.notes.map((n) => [n.t, n.d])).toEqual([
      [0, 2 * PPQ],
      [4 * PPQ, 2 * PPQ],
      [2 * BAR, 2 * PPQ],
    ]);
    expect(twice.cc['1']?.map((p) => p[0])).toEqual([0, 2 * PPQ, 2 * BAR + 2 * PPQ]);
    expect(twice.marks?.[1]).toEqual({ t: 4 * PPQ, k: 'cresc', e: 2 * BAR + 2 * PPQ });
  });
});
