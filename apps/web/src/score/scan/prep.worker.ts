/**
 * Pages made ready to read, off the main thread: the corners guessed, the page straightened, its
 * shadows taken out, its systems found, and the page and each system's strip made into PNGs.
 */
import {
  binarize,
  crop,
  enhance,
  type FoundSystem,
  findPage,
  findSystems,
  flatten,
  type Gray,
  guessCorners,
  level,
  type Point,
  skewAngle,
  toGray,
  warp,
} from '@holo/score';

export type PrepRequest =
  | { type: 'guess'; id: number; rgba: ArrayBuffer; w: number; h: number }
  | {
      type: 'prepare';
      id: number;
      rgba: ArrayBuffer;
      w: number;
      h: number;
      corners: [Point, Point, Point, Point];
      enhance: boolean;
    };

export type PrepReply =
  | { id: number; corners: [Point, Point, Point, Point] }
  | { id: number; page: Blob; w: number; h: number; space: number; systems: FoundSystem[]; strips: Blob[] }
  | { id: number; error: string };

/** The longest side a straightened page gets (enough for 5–6 px staff spaces at the smallest). */
const LONG = 2600;

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

async function png(img: Gray): Promise<Blob> {
  const canvas = new OffscreenCanvas(img.w, img.h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No canvas here');
  const rgba = new ImageData(img.w, img.h);
  for (let i = 0, j = 0; i < img.data.length; i++, j += 4) {
    const v = img.data[i] as number;
    rgba.data[j] = v;
    rgba.data[j + 1] = v;
    rgba.data[j + 2] = v;
    rgba.data[j + 3] = 255;
  }
  ctx.putImageData(rgba, 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** A smaller copy (for guessing the corners quickly). */
function shrink(img: Gray, max: number): { img: Gray; scale: number } {
  const scale = Math.min(1, max / Math.max(img.w, img.h));
  if (scale === 1) return { img, scale };
  const w = Math.max(1, Math.round(img.w * scale));
  const h = Math.max(1, Math.round(img.h * scale));
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++)
      data[y * w + x] = img.data[Math.floor(y / scale) * img.w + Math.floor(x / scale)] as number;
  }
  return { img: { w, h, data }, scale };
}

const post = (m: PrepReply, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<PrepRequest>) => {
  const req = e.data;
  try {
    const gray = toGray(new Uint8ClampedArray(req.rgba), req.w, req.h);
    if (req.type === 'guess') {
      const { img, scale } = shrink(gray, 900);
      // the paper itself when it stands out from what it lies on; else around the ink
      const page = findPage(img) ?? guessCorners(binarize(flatten(img)), img.w, img.h);
      const corners = page.map(([x, y]): Point => [x / scale, y / scale]) as [Point, Point, Point, Point];
      post({ id: req.id, corners });
      return;
    }
    const [tl, tr, br, bl] = req.corners;
    let w = Math.max(dist(tl, tr), dist(bl, br));
    let h = Math.max(dist(tl, bl), dist(tr, br));
    const scale = Math.min(1, LONG / Math.max(w, h));
    w = Math.round(w * scale);
    h = Math.round(h * scale);
    let page = flatten(warp(gray, req.corners, w, h));
    if (req.enhance) page = enhance(page);
    // made level, if the corners left it a little crooked
    page = level(page, skewAngle(binarize(page), w, h));
    const ink = binarize(page);
    const layout = findSystems(ink, w, h);
    const strips: Blob[] = [];
    for (const s of layout.systems) {
      const left = Math.max(0, Math.round(s.left - layout.space * 3));
      const right = Math.min(w, Math.round(s.right + layout.space));
      strips.push(await png(crop(page, left, s.top, right - left, s.bottom - s.top)));
    }
    post({ id: req.id, page: await png(page), w, h, space: layout.space, systems: layout.systems, strips });
  } catch (err) {
    post({ id: req.id, error: err instanceof Error ? err.message : String(err) });
  }
};
