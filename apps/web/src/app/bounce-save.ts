/**
 * Saving a finished bounce on the device. On a computer the file downloads as it always has. A
 * phone or a tablet is shown that it's done and saves it from a tap, and an installed iPhone or
 * iPad app through the share sheet (Save to Files, AirDrop…): such an app has no browser around
 * it, so following a link to a download takes it to a page of the file with no way back.
 *
 * The share sheet opens only straight from a tap, so the file is fetched beforehand (while the
 * page is in front) and held here until it's saved or let go.
 */
import { isStems } from './host-bounce.ts';
import { isIosLike } from './notify.ts';

/** How a device saves a bounce: 'auto', by itself when it's done; 'tap', from a button; 'share', the button opens the share sheet. */
export type SaveWay = 'auto' | 'tap' | 'share';

export interface SaveFacts {
  /** An iPhone, iPad or iPod. */
  iosLike: boolean;
  /** Installed (a Home Screen web app): no browser around the page. */
  standalone: boolean;
  /** A touch device (its main pointer is a finger). */
  touch: boolean;
  /** It can hand files to the share sheet. */
  canShareFiles: boolean;
}

/**
 * How a device saves a bounce. An installed iOS app first, whatever its pointer (an iPad with a
 * trackpad is still one): the share sheet where it can share files, else a tap on the link, as
 * before. Any other iOS or touch device: a tap. A computer: by itself.
 */
export function saveWay(f: SaveFacts): SaveWay {
  if (f.iosLike && f.standalone) return f.canShareFiles ? 'share' : 'tap';
  return f.iosLike || f.touch ? 'tap' : 'auto';
}

/** This device's way. */
export function thisSaveWay(): SaveWay {
  const nav = navigator as Navigator & { standalone?: boolean };
  let canShareFiles = false;
  try {
    const probe = new File([new Uint8Array(1)], 'bounce.wav', { type: 'audio/wav' });
    canShareFiles = typeof nav.share === 'function' && nav.canShare?.({ files: [probe] }) === true;
  } catch {
    canShareFiles = false;
  }
  return saveWay({
    iosLike: isIosLike(),
    standalone: window.matchMedia?.('(display-mode: standalone)').matches || nav.standalone === true,
    touch: window.matchMedia?.('(pointer: coarse)').matches === true,
    canShareFiles,
  });
}

/**
 * Where a device keeps the bounce it asked for: one that saves from a tap, where the app being
 * closed and opened again finds it; a computer, for its tab alone (as it was: no other tab picks
 * the bounce up and downloads it too).
 */
export const bounceShelf = (way: SaveWay): Storage => (way === 'auto' ? sessionStorage : localStorage);

/** Past this a bounce isn't fetched to be shared (a phone's page holding it whole): its link is followed instead. */
const HOLD_BYTES = 400 * 1024 * 1024;

let held: File | null = null;
let fetching: AbortController | null = null;
let waiting: (() => void) | null = null;

/** Let go of the file held, and of one on its way. */
export function letFileGo(): void {
  held = null;
  fetching?.abort();
  fetching = null;
  if (waiting) document.removeEventListener('visibilitychange', waiting);
  waiting = null;
}

/**
 * Hold a bounce's file for the share sheet: the one a bounce made here already has, or the host's,
 * fetched once the page is in front. `ready` is told when Save can be pressed: with the file held,
 * or without it (too big, out of reach), when Save follows the link instead.
 */
export function holdFile(name: string, source: Blob | string, ready: () => void): void {
  letFileGo();
  // (a bounce is a WAV; a song's stems, fetched from the host, a ZIP)
  const zip = typeof source === 'string' && isStems(source);
  const file = (blob: Blob) =>
    new File([blob], `${name}.${zip ? 'zip' : 'wav'}`, { type: zip ? 'application/zip' : 'audio/wav' });
  if (typeof source !== 'string') {
    held = file(source);
    ready();
    return;
  }
  const get = async () => {
    const stop = new AbortController();
    fetching = stop;
    try {
      const res = await fetch(source, { signal: stop.signal });
      if (!res.ok) throw new Error(String(res.status));
      if (Number(res.headers.get('content-length') ?? 0) > HOLD_BYTES) {
        stop.abort();
        throw new Error('too big to hold');
      }
      const blob = await res.blob();
      if (fetching !== stop) return;
      held = file(blob);
    } catch {
      if (fetching !== stop) return;
    }
    fetching = null;
    ready();
  };
  if (document.visibilityState === 'visible') void get();
  else {
    waiting = () => {
      if (document.visibilityState !== 'visible') return;
      if (waiting) document.removeEventListener('visibilitychange', waiting);
      waiting = null;
      void get();
    };
    document.addEventListener('visibilitychange', waiting);
  }
}

/** Follow a link to the file: a download where there's a browser to take it. */
function follow(href: string, name: string, ext = 'wav'): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = `${name}.${ext}`;
  a.click();
}

/**
 * Save the bounce, from the tap: through the share sheet with the file held, else by its link on
 * the host (or, a bounce that never reached the host, the file itself). False when the share sheet
 * was closed with nothing done: the bounce is still to be saved.
 */
export async function saveFile(name: string, url: string | null): Promise<boolean> {
  const file = held;
  const ext = isStems(url) || file?.name.endsWith('.zip') ? 'zip' : 'wav';
  // (a device may share a recording and not an archive: then its link is followed, as for a file too big to hold)
  const shares =
    file !== null &&
    typeof navigator.share === 'function' &&
    (ext === 'wav' || navigator.canShare?.({ files: [file] }) === true);
  if (file && shares) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return false;
      // (it wouldn't share: the link, as before)
    }
  }
  if (url) follow(`${url}?as=${encodeURIComponent(name)}`, name, ext);
  else if (file) {
    const href = URL.createObjectURL(file);
    follow(href, name, ext);
    window.setTimeout(() => URL.revokeObjectURL(href), 60_000);
  } else return false;
  return true;
}
