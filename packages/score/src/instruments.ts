/**
 * How a track is written when its score settings don't say: a piano on a grand staff, a cello in
 * the bass clef, a clarinet a tone above how it sounds, a kit on a drum staff. Read from the track's
 * name and its instrument, so it works for whatever is loaded.
 */
import type { Track } from '@holo/session';

export interface PartDefaults {
  staves: number;
  clefs: string[];
  /** Written above sounding by [semitones, letter steps]. */
  tr: [number, number] | null;
  drums: boolean;
  /** Comfortable and full ranges (sounding), for checks. */
  range?: [number, number];
}

interface Rule {
  match: RegExp;
  staves?: number;
  clefs?: string[];
  tr?: [number, number];
  range?: [number, number];
}

/** First match wins: the more specific names first. */
const RULES: Rule[] = [
  {
    match: /piano|keys|steinway|rhodes|wurli|electric piano|harpsichord|celesta|clav/i,
    staves: 2,
    clefs: ['G', 'F'],
    range: [21, 108],
  },
  { match: /harp\b/i, staves: 2, clefs: ['G', 'F'], range: [24, 103] },
  { match: /organ/i, staves: 2, clefs: ['G', 'F'], range: [36, 96] },
  { match: /marimba|vibraphone|vibes/i, staves: 1, clefs: ['G'], range: [45, 96] },
  { match: /glock/i, clefs: ['G'], tr: [-24, -14], range: [79, 108] },
  { match: /xylo/i, clefs: ['G'], tr: [-12, -7], range: [65, 108] },
  { match: /piccolo/i, clefs: ['G'], tr: [-12, -7], range: [74, 108] },
  { match: /alto flute/i, clefs: ['G'], tr: [5, 3], range: [55, 91] },
  { match: /flute/i, clefs: ['G'], range: [60, 96] },
  { match: /english horn|cor anglais/i, clefs: ['G'], tr: [7, 4], range: [52, 81] },
  { match: /oboe/i, clefs: ['G'], range: [58, 93] },
  { match: /bass clarinet/i, clefs: ['G'], tr: [14, 8], range: [38, 77] },
  { match: /clarinet/i, clefs: ['G'], tr: [2, 1], range: [50, 94] },
  { match: /contrabassoon/i, clefs: ['F'], tr: [12, 7], range: [22, 53] },
  { match: /bassoon/i, clefs: ['F'], range: [34, 76] },
  { match: /soprano sax/i, clefs: ['G'], tr: [2, 1], range: [56, 87] },
  { match: /alto sax/i, clefs: ['G'], tr: [9, 5], range: [49, 80] },
  { match: /tenor sax/i, clefs: ['G'], tr: [14, 8], range: [44, 75] },
  { match: /bari(tone)? sax/i, clefs: ['G'], tr: [21, 12], range: [36, 68] },
  { match: /horn/i, clefs: ['G'], tr: [7, 4], range: [35, 77] },
  { match: /trumpet|cornet|flugel/i, clefs: ['G'], tr: [2, 1], range: [54, 82] },
  { match: /bass trombone|tuba|euphonium|sousaphone/i, clefs: ['F'], range: [26, 65] },
  { match: /trombone/i, clefs: ['F'], range: [40, 72] },
  { match: /timpani/i, clefs: ['F'], range: [38, 57] },
  { match: /violas?\b/i, clefs: ['C3'], range: [48, 88] },
  { match: /violin|fiddle/i, clefs: ['G'], range: [55, 103] },
  { match: /cellos?\b|violoncello/i, clefs: ['F'], range: [36, 84] },
  {
    match: /contrabass|double bass|upright|meatbass|bass guitar|electric bass|fingered bass|picked bass/i,
    clefs: ['F'],
    tr: [12, 7],
    range: [28, 67],
  },
  { match: /guitar|freepats-guitar|banjo|mandolin|ukulele/i, clefs: ['G8vb'], range: [40, 88] },
  { match: /soprano|treble voice/i, clefs: ['G'], range: [60, 81] },
  { match: /\balto\b|mezzo|contralto/i, clefs: ['G'], range: [53, 77] },
  { match: /tenor/i, clefs: ['G8vb'], range: [48, 69] },
  { match: /baritone|bass voice/i, clefs: ['F'], range: [41, 64] },
  { match: /\b(voice|vocals?|vox|singer|lead vocal|melody|choir)\b/i, clefs: ['G'], range: [55, 79] },
  // a choir's basses, a synth bass: the bass clef, as it sounds
  { match: /\bbass\b/i, clefs: ['F'] },
];

/** Whether a track plays drums (each key a sound, not a pitch). */
export function isDrums(track: Track): boolean {
  if (track.score?.drums) return true;
  const i = track.instrument;
  if (i.type === 'synth' && i.preset === 'Drum Synth') return true;
  const pack = i.type === 'sampler' || i.type === 'performance' ? `${i.pack}/${i.name}` : '';
  return /kit|drum|perc/i.test(pack) || /\b(drums?|kit|percussion)\b/i.test(track.name);
}

export function partDefaults(track: Track, pitches: readonly number[]): PartDefaults {
  if (isDrums(track)) return { staves: 1, clefs: ['perc'], tr: null, drums: true };
  const i = track.instrument;
  // the track's own name first (a "Flute" played on Soft Keys is a flute part), then its instrument
  const sound = `${i.type === 'sampler' || i.type === 'performance' ? `${i.pack} ${i.name}` : ''} ${i.type === 'synth' ? i.preset : ''}`;
  for (const words of [track.name, sound]) {
    const rule = RULES.find((r) => r.match.test(words));
    if (!rule) continue;
    return {
      staves: rule.staves ?? 1,
      clefs: rule.clefs ?? ['G'],
      tr: rule.tr ?? null,
      drums: false,
      ...(rule.range ? { range: rule.range } : {}),
    };
  }
  // anything else: by where it plays, a grand staff when it spans both clefs widely
  if (!pitches.length) return { staves: 1, clefs: ['G'], tr: null, drums: false };
  const sorted = pitches.slice().sort((a, b) => a - b);
  const low = sorted[Math.floor(sorted.length * 0.1)] as number;
  const high = sorted[Math.floor(sorted.length * 0.9)] as number;
  if (low < 52 && high > 67) return { staves: 2, clefs: ['G', 'F'], tr: null, drums: false };
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  return { staves: 1, clefs: [median < 56 ? 'F' : 'G'], tr: null, drums: false };
}

/**
 * A drum staff: General MIDI's drums placed as drummers read them, [place on the staff (0 the
 * middle line, 1 the space above, −1 the space below…), notehead]. Kick and pedal hat are the feet
 * (stems down), everything else the hands.
 */
export const GM_DRUM_STAFF: Record<number, [number, string]> = {
  35: [-4, 'normal'],
  36: [-3, 'normal'],
  37: [1, 'circle-x'],
  38: [1, 'normal'],
  39: [1, 'x'],
  40: [1, 'normal'],
  41: [-2, 'normal'],
  42: [5, 'x'],
  43: [-1, 'normal'],
  44: [-5, 'x'],
  45: [0, 'normal'],
  46: [5, 'circle-x'],
  47: [2, 'normal'],
  48: [3, 'normal'],
  49: [6, 'x'],
  50: [4, 'normal'],
  51: [4, 'x'],
  52: [7, 'x'],
  53: [4, 'diamond'],
  54: [3, 'x'],
  55: [7, 'x'],
  56: [3, 'triangle'],
  57: [7, 'x'],
  59: [4, 'x'],
};

export const FEET = new Set([35, 36, 44]);

/** Where a drum sits on the staff: the track's own map, General MIDI's, or the snare line. */
export function drumPlace(track: Track, pitch: number): [number, string] {
  return track.score?.drums?.[String(pitch)] ?? GM_DRUM_STAFF[pitch] ?? [1, 'x'];
}
