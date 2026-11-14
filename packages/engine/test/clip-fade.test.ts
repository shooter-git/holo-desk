import { newAudioTrack, newProject, PPQ, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { compileGraph, compileTempo, compileTrack, meterTicks } from '../src/compile.ts';
import { EngineCore } from '../src/core.ts';
import type { ClipSpec, ToWorklet } from '../src/protocol.ts';

// A track's clips swapped while it plays (a note edit's patch coming in or going, in the studio):
// at once, as ever, or crossfaded over the frames a `fade` gives, both lists playing meanwhile.

const SR = 48000;
const BLOCK = 128;
const BLOCKS = 40;
/** The block before which the clips are swapped. */
const AT = 20;

/** Two seconds of a tone. */
const tone = (hz: number, level: number) =>
  Float32Array.from({ length: SR * 2 }, (_, i) => level * Math.sin((2 * Math.PI * hz * i) / SR));

/** A song of one audio track and nothing after it: no plugins, no buses, so the mix is the clips' sum. */
function song(): Project {
  const p = newProject('Crossfade');
  p.buses = [];
  p.master.inserts = [];
  const t = { ...newAudioTrack('Vocal'), id: 'trk_v' };
  t.channel.sends = [];
  p.tracks = [t];
  return p;
}

const clips = (key: string): ClipSpec[] => [
  { key, start: 0, end: SR * 2, source: 0, regionStart: 0, regionEnd: SR * 2, gain: 1, fadeIn: 0, fadeOut: 0 },
];

/** The song played block by block, `swap` sent before block AT (none: the first list throughout). */
function play(first: ClipSpec[], swap?: Extract<ToWorklet, { type: 'clips' }>): Float32Array {
  const p = song();
  const core = new EngineCore(SR, (m) => {
    if (m.type === 'error') throw new Error(m.message);
  });
  const segments = compileTempo(p, SR);
  core.receive({ type: 'init', ring: null, meters: null, transport: null });
  core.receive({ type: 'tempo', segments, ppq: PPQ, ...meterTicks(p) });
  core.receive({ type: 'audio', key: 'old', channels: [tone(220, 0.4)] });
  core.receive({ type: 'audio', key: 'new', channels: [tone(330, 0.3)] });
  core.receive({ type: 'graph', graph: compileGraph(p, () => 1, segments) });
  core.receive({ type: 'sequence', num: 1, events: compileTrack(p.tracks[0] as Project['tracks'][number], segments) });
  core.receive({ type: 'clips', num: 1, clips: first });
  core.receive({ type: 'play', frame: 0, record: false, countIn: 0 });
  const out = new Float32Array(BLOCKS * BLOCK);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let b = 0; b < BLOCKS; b++) {
    if (b === AT && swap) core.receive(swap);
    core.process(l, r, undefined, b * BLOCK);
    out.set(l, b * BLOCK);
  }
  return out;
}

const bytes = (x: Float32Array) => Buffer.from(x.buffer, x.byteOffset, x.byteLength);

describe('a track’s clips swapped while it plays', () => {
  const old = play(clips('old'));
  const neu = play(clips('new'));
  const from = AT * BLOCK;

  it('take over at once without a fade, as they always have', () => {
    const out = play(clips('old'), { type: 'clips', num: 1, clips: clips('new') });
    expect(bytes(out.subarray(0, from)).equals(bytes(old.subarray(0, from)))).toBe(true);
    expect(bytes(out.subarray(from)).equals(bytes(neu.subarray(from)))).toBe(true);
  });

  for (const fade of [256, 200]) {
    it(`crossfade linearly over ${fade} frames with one`, () => {
      const out = play(clips('old'), { type: 'clips', num: 1, clips: clips('new'), fade });
      // before it: the old list, to the bit
      expect(bytes(out.subarray(0, from)).equals(bytes(old.subarray(0, from)))).toBe(true);
      // across it: old · (1 − λ) + new · λ, λ rising from the first frame
      let worst = 0;
      for (let k = 0; k < fade; k++) {
        const lambda = (k + 1) / fade;
        const want = (old[from + k] as number) * (1 - lambda) + (neu[from + k] as number) * lambda;
        worst = Math.max(worst, Math.abs((out[from + k] as number) - want));
      }
      expect(worst).toBeLessThan(1e-6);
      // after it: the new list (to the bit from the block after it ends)
      const blockAfter = Math.ceil((from + fade) / BLOCK) * BLOCK;
      for (let i = from + fade; i < blockAfter; i++) expect(out[i]).toBeCloseTo(neu[i] as number, 7);
      expect(bytes(out.subarray(blockAfter)).equals(bytes(neu.subarray(blockAfter)))).toBe(true);
      // and no step larger than either tone's own, but for the fade's own slope (their gap over its length)
      let step = 0;
      let own = 0;
      let gap = 0;
      for (let i = 1; i < out.length; i++) {
        step = Math.max(step, Math.abs((out[i] as number) - (out[i - 1] as number)));
        own = Math.max(
          own,
          Math.abs((old[i] as number) - (old[i - 1] as number)),
          Math.abs((neu[i] as number) - (neu[i - 1] as number)),
        );
        gap = Math.max(gap, Math.abs((neu[i] as number) - (old[i] as number)));
      }
      expect(step).toBeLessThanOrEqual(own + gap / fade + 1e-6);
    });
  }

  it('fade to no clips at all, and from none at once', () => {
    const out = play(clips('old'), { type: 'clips', num: 1, clips: [], fade: 256 });
    for (let k = 0; k < 256; k++) expect(out[from + k]).toBeCloseTo((old[from + k] as number) * (1 - (k + 1) / 256), 6);
    expect(out.subarray(from + 256).every((x) => x === 0)).toBe(true);
    const back = play([], { type: 'clips', num: 1, clips: clips('new'), fade: 256 });
    expect(bytes(back.subarray(from)).equals(bytes(neu.subarray(from)))).toBe(true);
  });
});
