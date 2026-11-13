/**
 * Generated halls kept on the device. Making one (a Space Designer's space, a Shimmer's) is seconds
 * of work, the same work every time the song is opened: the prepared response is kept in the device's
 * cache, under the engine that made it (another engine may make another hall) and the hall's own
 * key (its space, seed, decay and rate), and read back the next time. Responses from a pack's file
 * are not kept here: a pack can change under the same name.
 */
import type { PreparedImpulse } from '@holo/engine';

const CACHE = 'holo-halls-v1';

type Path = Float32Array | null;

interface Shape {
  rate: number;
  length: number;
  /** Each array's length in the order they're laid out (-1: none): the head's four paths, then each segment's. */
  head: number[] | null;
  segments: { size: number; start: number; parts: number; paths: number[] }[];
}

/** A prepared response as one run of bytes: its shape as text, then every array end to end. */
export function packImpulse(p: PreparedImpulse): ArrayBuffer {
  const arrays: Float32Array[] = [];
  const lay = (paths: Path[]) =>
    paths.map((a) => {
      if (a) arrays.push(a);
      return a ? a.length : -1;
    });
  const shape: Shape = {
    rate: p.rate,
    length: p.length,
    head: p.head ? lay([p.head.ll, p.head.rr, p.head.lr, p.head.rl]) : null,
    segments: p.segments.map((s) => ({
      size: s.size,
      start: s.start,
      parts: s.parts,
      paths: lay([s.ll, s.rr, s.lr, s.rl]),
    })),
  };
  const text = new TextEncoder().encode(JSON.stringify(shape));
  // (the arrays start on a multiple of four bytes)
  const at = 8 + Math.ceil(text.length / 4) * 4;
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new ArrayBuffer(at + total * 4);
  const view = new DataView(out);
  view.setUint32(0, 0x484c4c31, true);
  view.setUint32(4, text.length, true);
  new Uint8Array(out, 8, text.length).set(text);
  const data = new Float32Array(out, at, total);
  let o = 0;
  for (const a of arrays) {
    data.set(a, o);
    o += a.length;
  }
  return out;
}

/** The response those bytes hold, each array its own memory (null when they aren't one). */
export function unpackImpulse(bytes: ArrayBuffer): PreparedImpulse | null {
  try {
    if (bytes.byteLength < 8) return null;
    const view = new DataView(bytes);
    if (view.getUint32(0, true) !== 0x484c4c31) return null;
    const textLength = view.getUint32(4, true);
    const at = 8 + Math.ceil(textLength / 4) * 4;
    const shape = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 8, textLength))) as Shape;
    let o = at;
    const take = (n: number): Path => {
      if (n < 0) return null;
      if (o + n * 4 > bytes.byteLength) throw new Error('short');
      const a = new Float32Array(bytes.slice(o, o + n * 4));
      o += n * 4;
      return a;
    };
    const four = (paths: number[]) => {
      const [ll, rr, lr, rl] = paths.map(take);
      if (!ll || !rr) throw new Error('no paths');
      return { ll, rr, lr: lr ?? null, rl: rl ?? null };
    };
    const head = shape.head ? four(shape.head) : null;
    const segments = shape.segments.map((s) => ({ size: s.size, start: s.start, parts: s.parts, ...four(s.paths) }));
    if (o !== bytes.byteLength) return null;
    return { rate: shape.rate, length: shape.length, head, segments };
  } catch {
    return null;
  }
}

const urlOf = (engine: string, key: string) => `/halls/${encodeURIComponent(engine)}/${encodeURIComponent(key)}`;

/** A hall kept from before (null: none, or nowhere to keep them). */
export async function keptImpulse(engine: string, key: string): Promise<PreparedImpulse | null> {
  if (!engine || !('caches' in globalThis)) return null;
  try {
    const res = await (await caches.open(CACHE)).match(urlOf(engine, key));
    return res ? unpackImpulse(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** Keep a hall for the next time, and let go of those another engine made. */
export async function keepImpulse(engine: string, key: string, packed: ArrayBuffer): Promise<void> {
  if (!engine || !('caches' in globalThis)) return;
  try {
    const cache = await caches.open(CACHE);
    await cache.put(urlOf(engine, key), new Response(packed));
    const mine = `/halls/${encodeURIComponent(engine)}/`;
    for (const req of await cache.keys()) if (!new URL(req.url).pathname.startsWith(mine)) await cache.delete(req);
  } catch {
    // made again next time
  }
}
