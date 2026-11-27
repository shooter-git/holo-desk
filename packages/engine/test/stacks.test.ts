/** Track stacks change nothing of what's heard: a song renders the same samples with them as without. */
import { applyOps, newBus, newPlugin, newProject, newRegion, newTrack, PPQ, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { type RenderSource, renderSession } from '../src/render.ts';

const SR = 48000;
const source: RenderSource = {
  manifest: async () => {
    throw new Error('no packs here');
  },
  sample: async () => {
    throw new Error('no samples here');
  },
} as unknown as RenderSource;

/** Bass, Keys, Pad and Lead (synths), Keys and Pad through a bus with an EQ, the Lead sent to a hall. */
function song(): Project {
  const p = newProject('Stacks');
  p.tempo = [{ tick: 0, bpm: 120 }];
  const sum = { ...newBus('Sum'), id: 'bus_sum' };
  sum.channel.inserts = [newPlugin('eq')];
  sum.channel.volume = -3;
  const hall = { ...newBus('Hall'), id: 'bus_hall' };
  hall.channel.inserts = [newPlugin('reverb')];
  p.buses = [sum, hall];
  const part = (name: string, preset: string, pitches: number[]) => {
    const t = { ...newTrack(name, { type: 'synth', preset }), id: `trk_${name.toLowerCase()}` };
    t.regions = [{ ...newRegion(0, PPQ * 4), notes: pitches.map((k, i) => ({ t: i * PPQ, d: PPQ, p: k, v: 96 })) }];
    return t;
  };
  const keys = part('Keys', 'Soft Keys', [60, 64, 67, 72]);
  const pad = part('Pad', 'Warm Pad', [48, 55]);
  keys.channel.output = 'bus_sum';
  pad.channel.output = 'bus_sum';
  const lead = part('Lead', 'Bright Lead', [79, 76, 72, 74]);
  lead.channel.sends = [{ bus: 'bus_hall', level: -10, pre: false }];
  p.tracks = [part('Bass', 'Fat Mono', [36, 38, 41, 43]), keys, pad, lead];
  return p;
}

const render = async (p: Project) => {
  const out = await renderSession(p, source, { sampleRate: SR, tail: 1 });
  expect(out.errors).toEqual([]);
  return out.channels;
};

describe('a song with track stacks', () => {
  it('renders the same samples as the song without them: a folder, a summing stack, tracks moved in and out', async () => {
    const plain = song();
    const stacked = applyOps(plain, [
      { op: 'addStack', stack: { id: 'stk_sum', name: 'Keys', bus: 'bus_sum' }, tracks: ['trk_keys', 'trk_pad'] },
      { op: 'addStack', stack: { id: 'stk_low', name: 'Low' }, tracks: ['trk_bass'] },
      // (in and out of stacks, and a stack moved: none of it routes anything)
      { op: 'moveTrack', track: 'trk_lead', index: 1, stack: 'stk_sum' },
      { op: 'moveStack', stack: 'stk_low', index: 9 },
      { op: 'moveTrack', track: 'trk_lead', index: 0, stack: null },
    ]);
    expect(stacked.stacks).toHaveLength(2);
    expect(stacked.tracks.map((t) => t.name)).not.toEqual(plain.tracks.map((t) => t.name));
    const [a, b] = [await render(plain), await render(stacked)];
    expect(a.length).toBe(b.length);
    let peak = 0;
    a.forEach((ch, c) => {
      const other = b[c] as Float32Array;
      expect(other.length).toBe(ch.length);
      for (let i = 0; i < ch.length; i++) {
        peak = Math.max(peak, Math.abs(ch[i] as number));
        if (ch[i] !== other[i]) throw new Error(`channel ${c} differs at sample ${i}: ${ch[i]} and ${other[i]}`);
      }
    });
    expect(peak).toBeGreaterThan(0.01);
  }, 60_000);
});
