import { describe, expect, it } from 'vitest';
import type { PreparedImpulse } from '../src/convolver.ts';
import { EngineCore } from '../src/core.ts';

const SR = 48000;
type Message = Parameters<EngineCore['receive']>[0];

describe('what the engine lets go when the studio says so', () => {
  it("drops a hall's response no plugin plays any more", () => {
    const core = new EngineCore(SR, () => undefined);
    const data = { parts: [] } as unknown as PreparedImpulse;
    core.receive({ type: 'impulse', key: 'space:hall:1:1@48000', data } as Message);
    expect(core.impulse('space:hall:1:1@48000')).toBe(data);
    core.receive({ type: 'forgetImpulse', key: 'space:hall:1:1@48000' });
    expect(core.impulse('space:hall:1:1@48000')).toBeUndefined();
  });

  it("drops a Performance instrument's sample files no part plays any more", () => {
    const core = new EngineCore(SR, () => undefined);
    const perf = () => (core as unknown as { perfData: Map<string, Map<number, unknown>> }).perfData;
    const left = new Float32Array(16);
    core.receive({ type: 'performance', key: 'pack/horns', samples: [{ index: 3, left, right: left }] });
    core.receive({ type: 'performance', key: 'pack/flute', samples: [{ index: 0, left, right: left }] });
    expect(perf().get('pack/horns')?.has(3)).toBe(true);
    core.receive({ type: 'forgetPerformance', key: 'pack/horns' });
    expect(perf().has('pack/horns')).toBe(false);
    expect(perf().has('pack/flute')).toBe(true);
  });
});
