import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnceAFrame } from '../src/audio/once-a-frame.ts';

/** A page whose frames are drawn only when the test says, and which can be hidden. */
class Page extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  private frames: (() => void)[] = [];

  request = (fn: () => void): number => {
    this.frames.push(fn);
    return this.frames.length;
  };

  /** One frame is drawn (never while hidden: a hidden page's callbacks wait until it is shown). */
  draw(): void {
    if (this.visibilityState === 'hidden') return;
    const due = this.frames;
    this.frames = [];
    for (const fn of due) fn();
  }

  show(visible: boolean): void {
    this.visibilityState = visible ? 'visible' : 'hidden';
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

describe('the latest of what was asked for, once a frame', () => {
  let page: Page;
  let done: number[];
  let latest: OnceAFrame<number>;

  beforeEach(() => {
    page = new Page();
    vi.stubGlobal('document', page);
    vi.stubGlobal('requestAnimationFrame', page.request);
    done = [];
    latest = new OnceAFrame<number>((n) => done.push(n));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does only the last of a frame’s askings, when the frame comes', () => {
    latest.ask(1);
    latest.ask(2);
    latest.ask(3);
    expect(done).toEqual([]);
    page.draw();
    expect(done).toEqual([3]);
    page.draw();
    expect(done).toEqual([3]);
    latest.ask(4);
    page.draw();
    expect(done).toEqual([3, 4]);
  });

  it('drops what was waiting when something else has covered it', () => {
    latest.ask(1);
    latest.drop();
    page.draw();
    expect(done).toEqual([]);
    // (and the next asking still gets its frame)
    latest.ask(2);
    page.draw();
    expect(done).toEqual([2]);
  });

  it('does not wait for a frame while the page is hidden: none is coming', () => {
    page.show(false);
    latest.ask(1);
    latest.ask(2);
    expect(done).toEqual([1, 2]);
    page.draw();
    expect(done).toEqual([1, 2]);
  });

  it('does what was waiting as the page is hidden', () => {
    latest.ask(1);
    page.show(false);
    expect(done).toEqual([1]);
  });

  it('never goes back to an older asking when the page is shown again', () => {
    latest.ask(1);
    page.show(false);
    latest.ask(2);
    latest.ask(3);
    page.show(true);
    // (the frame asked for before it was hidden comes now, with nothing left to do)
    page.draw();
    expect(done).toEqual([1, 2, 3]);
    latest.ask(4);
    expect(done).toEqual([1, 2, 3]);
    page.draw();
    expect(done).toEqual([1, 2, 3, 4]);
  });

  it('uses a timer where there are no frames at all', () => {
    vi.unstubAllGlobals();
    vi.useFakeTimers();
    try {
      const out: string[] = [];
      const plain = new OnceAFrame<string>((s) => out.push(s));
      plain.ask('a');
      plain.ask('b');
      expect(out).toEqual([]);
      vi.advanceTimersByTime(20);
      expect(out).toEqual(['b']);
    } finally {
      vi.useRealTimers();
    }
  });
});
