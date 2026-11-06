/**
 * Compressed MusicXML (.mxl): a zip holding the score and a container file saying which it is. Read
 * with the platform's own inflate (DecompressionStream, in browsers and Node alike).
 */

const u16 = (b: Uint8Array, i: number) => (b[i] as number) | ((b[i + 1] as number) << 8);
const u32 = (b: Uint8Array, i: number) => (u16(b, i) | (u16(b, i + 2) << 16)) >>> 0;

/** Whether bytes are a zip (an .mxl), not XML. */
export const isZip = (b: Uint8Array): boolean => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

interface Entry {
  name: string;
  method: number;
  size: number;
  offset: number;
}

function entries(b: Uint8Array): Entry[] {
  // the central directory, from its end record (in the last 64 KB)
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (u32(b, i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Not a zip: no end record');
  const count = u16(b, end + 10);
  let at = u32(b, end + 16);
  const out: Entry[] = [];
  for (let k = 0; k < count && at + 46 <= b.length; k++) {
    if (u32(b, at) !== 0x02014b50) break;
    const method = u16(b, at + 10);
    const size = u32(b, at + 20);
    const nameLen = u16(b, at + 28);
    const extra = u16(b, at + 30);
    const comment = u16(b, at + 32);
    const local = u32(b, at + 42);
    const name = new TextDecoder().decode(b.subarray(at + 46, at + 46 + nameLen));
    // where its data starts: past the local header's own name and extra field
    const offset = local + 30 + u16(b, local + 26) + u16(b, local + 28);
    out.push({ name, method, size, offset });
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(data);
      c.close();
    },
  });
  // the DOM's and Node's typings of the stream differ; the stream is the same
  const stream = source.pipeThrough(
    new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function read(b: Uint8Array, e: Entry): Promise<string> {
  const data = b.subarray(e.offset, e.offset + e.size);
  const bytes = e.method === 0 ? data : e.method === 8 ? await inflate(data) : null;
  if (!bytes) throw new Error(`The .mxl uses a compression HO[LO] doesn't read (${e.method})`);
  return new TextDecoder().decode(bytes);
}

/** The score inside an .mxl, as MusicXML text. */
export async function readMxl(b: Uint8Array): Promise<string> {
  const list = entries(b);
  const container = list.find((e) => e.name === 'META-INF/container.xml');
  let path: string | undefined;
  if (container) path = /full-path="([^"]+)"/.exec(await read(b, container))?.[1];
  const score =
    list.find((e) => e.name === path) ??
    list.find((e) => !e.name.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(e.name));
  if (!score) throw new Error('The .mxl holds no score');
  return read(b, score);
}

/** Text from MusicXML bytes (UTF-8, or UTF-16 with its mark). */
export function decodeXml(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  return new TextDecoder().decode(b);
}

/** A score file's text, whichever kind it is. */
export async function scoreFileText(b: Uint8Array): Promise<string> {
  return isZip(b) ? readMxl(b) : decodeXml(b);
}
