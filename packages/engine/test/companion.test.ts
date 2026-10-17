import { describe, expect, it } from 'vitest';
import {
  decodeMessage,
  encodeMessage,
  type LiveRoute,
  type LiveRoutes,
  privateHost,
  routeLive,
} from '../src/companion.ts';

/** Through the wire and back, the frame copied first (as a socket would). */
function roundTrip<T>(msg: T): T {
  return decodeMessage(encodeMessage(msg).slice(0)) as T;
}

describe('the wire to HO[LO] Engine', () => {
  it('carries typed arrays exactly, views of a bigger buffer included', () => {
    const big = new Float32Array(1000).map((_, i) => Math.sin(i) * 0.5);
    const msg = {
      type: 'sampler',
      spec: {
        key: 'pack/piano',
        zones: [
          { left: big.subarray(10, 510), right: null, root: 60.25, loopEnd: 0 },
          { left: new Float32Array([1, -1, 0.5]), right: new Float32Array([0.25]), root: 72, loopEnd: 3 },
        ],
      },
      events: new Float64Array([0, 1, 60, 100, 0, 480.5, 0, 60, 0, 0]),
      ring: new Int32Array([-5, 2 ** 31 - 1]),
      bytes: new Uint8Array([0, 255, 7]),
    };
    const back = roundTrip(msg);
    expect(back.spec.zones[0]?.left).toBeInstanceOf(Float32Array);
    expect([...(back.spec.zones[0]?.left ?? [])]).toEqual([...big.subarray(10, 510)]);
    expect(back.spec.zones[1]?.right).toEqual(new Float32Array([0.25]));
    expect(back.spec.zones[0]?.right).toBeNull();
    expect(back.events).toEqual(msg.events);
    expect(back.ring).toEqual(msg.ring);
    expect(back.bytes).toEqual(msg.bytes);
    expect(back.spec.zones[0]?.root).toBe(60.25);
  });

  it('keeps what JSON alone would lose: NaN, the infinities, -0 and undefined', () => {
    const msg = {
      a: Number.NaN,
      b: Number.POSITIVE_INFINITY,
      c: Number.NEGATIVE_INFINITY,
      d: -0,
      e: [1, undefined, 3],
    };
    const back = roundTrip(msg);
    expect(back.a).toBeNaN();
    expect(back.b).toBe(Number.POSITIVE_INFINITY);
    expect(back.c).toBe(Number.NEGATIVE_INFINITY);
    expect(Object.is(back.d, -0)).toBe(true);
    expect(back.e).toEqual([1, undefined, 3]);
  });

  it('keeps the bits of samples (NaN payloads and denormals in arrays are bytes)', () => {
    const x = new Float64Array([Number.NaN, -0, 5e-324, Number.MAX_VALUE]);
    const back = roundTrip({ x }).x;
    expect(new Uint8Array(back.buffer, back.byteOffset, back.byteLength)).toEqual(new Uint8Array(x.buffer));
  });

  it('lines every array up for reading in place', () => {
    const back = roundTrip({ a: new Uint8Array(3), b: new Float64Array([1.5]), c: new Float32Array([2]) });
    expect(back.b.byteOffset % 8).toBe(0);
    expect(back.c.byteOffset % 4).toBe(0);
    expect(back.b[0]).toBe(1.5);
  });

  it('refuses a frame cut short', () => {
    const frame = encodeMessage({ x: new Float32Array(4) });
    const header = new DataView(frame).getUint32(0, true);
    const cut = frame.slice(0, 8 + header);
    new DataView(cut).setUint32(4, 0, true);
    expect(() => decodeMessage(cut)).toThrow(/cut short/);
  });
});

describe('live MIDI routes', () => {
  // the rule as the studio wrote it before the companion (actions.ts): kept here to hold routeLive to it
  function before(tracks: { num: number; armed: boolean; port: string; channel: number }[], selected: number | null) {
    return (port: string, channel: number) => {
      const matches = (t: { port: string; channel: number }) =>
        (t.port === '*' || t.port === port) && (t.channel === 0 || t.channel === channel);
      const armed = tracks.filter((t) => t.armed && matches(t));
      if (armed.length) return armed.map((t) => t.num);
      const s = tracks.find((t) => t.num === selected);
      return s && matches(s) ? [s.num] : [];
    };
  }

  it('follows the studio’s rule: armed tracks whose input matches, else the selected track', () => {
    const ports = ['*', 'Drum Module', 'Keyboard 61', 'USB MIDI Interface'];
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let trial = 0; trial < 300; trial++) {
      const tracks = Array.from({ length: 1 + rand(5) }, (_, i) => ({
        num: i + 1,
        armed: rand(3) === 0,
        port: ports[rand(ports.length)] as string,
        channel: rand(3) === 0 ? 0 : 1 + rand(16),
      }));
      const selected = rand(4) === 0 ? null : 1 + rand(tracks.length);
      const route = (t: (typeof tracks)[number]): LiveRoute => ({ num: t.num, port: t.port, channel: t.channel });
      const sel = tracks.find((t) => t.num === selected);
      const routes: LiveRoutes = { armed: tracks.filter((t) => t.armed).map(route), selected: sel ? route(sel) : null };
      const old = before(tracks, selected);
      for (const port of ports.slice(1)) {
        for (let channel = 1; channel <= 16; channel++)
          expect(routeLive(routes, port, channel)).toEqual(old(port, channel));
      }
    }
  });

  it('sends drums on channel 10 and keys on channel 1 from one interface to their own tracks', () => {
    const routes: LiveRoutes = {
      armed: [
        { num: 1, port: 'USB MIDI Interface', channel: 10 },
        { num: 2, port: 'USB MIDI Interface', channel: 1 },
      ],
      selected: { num: 3, port: '*', channel: 0 },
    };
    expect(routeLive(routes, 'USB MIDI Interface', 10)).toEqual([1]);
    expect(routeLive(routes, 'USB MIDI Interface', 1)).toEqual([2]);
    // nothing armed listens to another keyboard: the selected track plays it
    expect(routeLive(routes, 'Another keyboard', 1)).toEqual([3]);
  });
});

describe('where the studio finds the companion by itself', () => {
  it('is this computer, the local network or a tailnet', () => {
    for (const h of [
      'localhost',
      'studio.localhost',
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.20',
      '172.20.0.5',
      '100.101.102.103',
      'box.your-tailnet.ts.net',
      'nas.local',
      '[::1]',
      'fd12:3456::1',
    ])
      expect(privateHost(h), h).toBe(true);
  });

  it('isn’t a public site (the browser asks there first)', () => {
    for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '100.128.0.1', 'ts.net.example.com', '2001:4860::8888'])
      expect(privateHost(h), h).toBe(false);
  });
});
