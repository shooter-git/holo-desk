import { describe, expect, it } from 'vitest';
import { type CacheLike, type CachesLike, PatchStore, packPatch, unpackPatch } from '../src/audio/patch-store.ts';

/** The device's cache, in memory: each named cache a map from path to bytes. `fail` makes what it names throw. */
function device(fail: { open?: boolean; put?: boolean; match?: boolean } = {}) {
  const stores = new Map<string, Map<string, ArrayBuffer>>();
  const pathOf = (req: string | { url: string }) =>
    new URL(typeof req === 'string' ? req : req.url, 'http://local').pathname;
  const caches: CachesLike = {
    async open(name) {
      if (fail.open) throw new Error('no storage here');
      let m = stores.get(name);
      if (!m) {
        m = new Map();
        stores.set(name, m);
      }
      const map = m;
      const cache: CacheLike = {
        async match(url) {
          if (fail.match) throw new Error('refused');
          const b = map.get(pathOf(url));
          return b ? new Response(b.slice(0)) : undefined;
        },
        async put(url, res) {
          if (fail.put) throw new Error('quota exceeded');
          map.set(pathOf(url), await res.arrayBuffer());
        },
        async delete(req) {
          return map.delete(pathOf(req));
        },
        async keys() {
          return [...map.keys()].map((p) => ({ url: `http://local${p}` }));
        },
      };
      return cache;
    },
  };
  /** The paths kept, the index left out. */
  const paths = () => [...(stores.get('holo-patches-v1')?.keys() ?? [])].filter((p) => !p.endsWith('/index')).sort();
  return { caches, paths, stores };
}

/** A patch of `n` frames on `count` channels, each frame its own number. */
const patch = (n: number, count = 2, seed = 1) =>
  Array.from({ length: count }, (_, c) => Float32Array.from({ length: n }, (_, i) => Math.sin(seed + i * 0.01 + c)));

/** Bytes a patch of `n` frames on two channels takes, packed. */
const bytesOf = (n: number) => packPatch(patch(n)).byteLength;

const store = (caches: CachesLike | null, more: Partial<ConstructorParameters<typeof PatchStore>[0]> = {}) => {
  let t = 0;
  return new PatchStore({ engine: 'eng1', budget: 1e9, caches, estimate: async () => ({}), now: () => ++t, ...more });
};

describe('a patch’s bytes', () => {
  it('come back as the channels they were, each its own memory', () => {
    for (const channels of [patch(1000, 2), patch(17, 1), [new Float32Array(5), new Float32Array(3)]]) {
      const back = unpackPatch(packPatch(channels));
      expect(back?.length).toBe(channels.length);
      for (const [i, c] of (back ?? []).entries())
        expect(Buffer.from(c.buffer).equals(Buffer.from((channels[i] as Float32Array).buffer))).toBe(true);
      if (back && back.length > 1) expect(back[0]?.buffer).not.toBe(back[1]?.buffer);
    }
  });

  it('are not something else’s, nor cut short', () => {
    expect(unpackPatch(new ArrayBuffer(4))).toBeNull();
    expect(unpackPatch(new Uint8Array(64).buffer)).toBeNull();
    const packed = packPatch(patch(100));
    expect(unpackPatch(packed.slice(0, packed.byteLength - 4))).toBeNull();
    const longer = new Uint8Array(packed.byteLength + 4);
    longer.set(new Uint8Array(packed));
    expect(unpackPatch(longer.buffer)).toBeNull();
  });
});

describe('patches kept on the device', () => {
  it('are found again, and again once the studio opens anew', async () => {
    const d = device();
    const a = store(d.caches);
    await a.ready;
    expect(a.has('take#1')).toBe(false);
    expect(await a.get('take#1')).toBeNull();
    const kept = patch(4800);
    a.put('take#1', kept);
    await a.flush();
    expect(a.has('take#1')).toBe(true);
    const back = await a.get('take#1');
    const right = back?.[1] ?? new Float32Array(0);
    expect(Buffer.from(right.buffer).equals(Buffer.from((kept[1] as Float32Array).buffer))).toBe(true);
    // a reload: the index says what's kept
    const b = store(d.caches);
    expect(b.loaded).toBe(false);
    await b.ready;
    expect(b.loaded).toBe(true);
    expect(b.has('take#1')).toBe(true);
    expect(b.bytes).toBe(bytesOf(4800));
    expect((await b.get('take#1'))?.[0]?.length).toBe(4800);
  });

  it('keep within the budget, the least lately used going first', async () => {
    const d = device();
    const s = store(d.caches, { budget: bytesOf(1000) * 3 });
    s.put('a', patch(1000));
    s.put('b', patch(1000));
    s.put('c', patch(1000));
    await s.flush();
    expect(s.size).toBe(3);
    // a used again: b is now the least lately
    await s.get('a');
    s.put('d', patch(1000));
    await s.flush();
    expect([s.has('a'), s.has('b'), s.has('c'), s.has('d')]).toEqual([true, false, true, true]);
    expect(s.bytes).toBeLessThanOrEqual(s.budget);
    expect(d.paths().map((p) => p.split('/').pop())).toEqual(['a', 'c', 'd']);
    // the order is kept for the next time: after a reload, c goes before a
    const again = store(d.caches, { budget: bytesOf(1000) * 3, now: () => 1e6 });
    await again.ready;
    again.put('e', patch(1000));
    await again.flush();
    expect([again.has('a'), again.has('c'), again.has('d'), again.has('e')]).toEqual([true, false, true, true]);
    // (one bigger than the whole budget isn't kept)
    again.put('huge', patch(5000));
    await again.flush();
    expect(again.has('huge')).toBe(false);
  });

  it('come to no more than a quarter of what the device allows', async () => {
    const s = store(device().caches, { budget: 512 * 2 ** 20, estimate: async () => ({ quota: 200 * 2 ** 20 }) });
    await s.ready;
    expect(s.budget).toBe(50 * 2 ** 20);
  });

  it('let go of what another engine rendered, and of what the index doesn’t know', async () => {
    const d = device();
    const old = store(d.caches, { engine: 'eng0' });
    old.put('take#1', patch(100));
    await old.flush();
    const cache = await d.caches.open('holo-patches-v1');
    // (written as the page closed, before the index was)
    await cache.put('/patches/eng1/stray', new Response(packPatch(patch(10))));
    expect(d.paths()).toHaveLength(2);
    const now = store(d.caches, { engine: 'eng1' });
    await now.ready;
    expect(now.has('take#1')).toBe(false);
    expect(await now.get('take#1')).toBeNull();
    expect(d.paths()).toEqual([]);
    expect([...(d.stores.get('holo-patches-v1')?.keys() ?? [])]).not.toContain('/patches/eng0/index');
  });

  it('forget one that can’t be read back', async () => {
    const d = device();
    const s = store(d.caches);
    s.put('take#1', patch(100));
    await s.flush();
    const cache = await d.caches.open('holo-patches-v1');
    await cache.put('/patches/eng1/take%231', new Response(new ArrayBuffer(12)));
    expect(await s.get('take#1')).toBeNull();
    expect(s.has('take#1')).toBe(false);
  });

  it('are simply not kept where storage throws, or there is none', async () => {
    for (const fail of [{ open: true }, { put: true }, { match: true }]) {
      const s = store(device(fail).caches);
      await s.ready;
      expect(s.loaded).toBe(true);
      s.put('take#1', patch(100));
      await s.flush();
      expect(await s.get('take#1')).toBeNull();
      if (!fail.match) expect(s.has('take#1')).toBe(false);
    }
    for (const caches of [null, undefined]) {
      const s = new PatchStore({ engine: 'eng1', budget: 1e9, caches, estimate: async () => ({}) });
      await s.ready;
      s.put('take#1', patch(100));
      await s.flush();
      expect(s.has('take#1')).toBe(false);
    }
    // nor without an engine to keep them under
    const none = store(device().caches, { engine: '' });
    none.put('take#1', patch(100));
    await none.flush();
    expect(none.has('take#1')).toBe(false);
  });
});
