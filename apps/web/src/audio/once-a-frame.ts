/**
 * The latest of what's asked for, once a frame: a pointer moves far more often than frames are
 * drawn, and whoever follows it (the audio thread, behind a fader) needs only where it has got to.
 *
 * A hidden page draws no frames: a tab in the background, a minimised window. Its song can still be
 * changing under a gesture, a remote's fader above all, since a remote is for when the studio isn't
 * in front of you. Waiting for a frame there would be waiting for the page to be shown again, so
 * while it is hidden what's asked for is done at once, and what was waiting when it was hidden goes
 * as it hides.
 */
export class OnceAFrame<T> {
  private pending: { value: T } | null = null;
  private frame = 0;

  constructor(private readonly run: (value: T) => void) {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (pageHidden()) this.flush();
      });
    }
  }

  /** Do this at the next frame, in place of whatever was waiting for it. */
  ask(value: T): void {
    if (pageHidden()) {
      this.pending = null;
      this.run(value);
      return;
    }
    this.pending = { value };
    if (this.frame) return;
    this.frame = nextFrame(() => {
      this.frame = 0;
      this.flush();
    });
  }

  /** What is waiting is done now. */
  flush(): void {
    const p = this.pending;
    this.pending = null;
    if (p) this.run(p.value);
  }

  /** What is waiting is no longer wanted (something else has covered it). */
  drop(): void {
    this.pending = null;
  }
}

function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** Before the next frame is drawn (a timer where there are no frames). */
function nextFrame(fn: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(fn);
  return setTimeout(fn, 16) as unknown as number;
}
