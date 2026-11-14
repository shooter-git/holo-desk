import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flickSpeed, panAxis, revealBy, TouchPan, Viewport } from '../src/ui/view.ts';

describe('bringing a row into view', () => {
  it('leaves a row that shows where it is', () => {
    expect(revealBy(100, 56, 80, 400)).toBe(0);
    expect(revealBy(80, 56, 80, 400)).toBe(0);
    expect(revealBy(424, 56, 80, 400)).toBe(0);
  });

  it('scrolls down just far enough for a row under the fold', () => {
    expect(revealBy(450, 56, 80, 400)).toBe(26);
  });

  it('scrolls up to a row above the view', () => {
    expect(revealBy(56, 56, 80, 400)).toBe(-24);
  });

  it('brings a row taller than the view to its top', () => {
    expect(revealBy(300, 500, 80, 400)).toBe(220);
  });
});

const at = (clientX: number, clientY: number, timeStamp: number) => ({ clientX, clientY, timeStamp });

describe('which way a finger scrolls', () => {
  it('holds to a direction the drag starts mostly along', () => {
    expect(panAxis('xy', 2, 10)).toBe('y');
    expect(panAxis('xy', 10, 3)).toBe('x');
  });

  it('moves both ways for a diagonal drag', () => {
    expect(panAxis('xy', 7, 9)).toBe('xy');
  });

  it("keeps to a list's one direction", () => {
    expect(panAxis('y', 10, 0)).toBe('y');
  });
});

describe('a flick', () => {
  it('carries the view on at the speed of the last moves, against the finger', () => {
    // the finger went up 60 px in 60 ms: the view moves on down at 1 px/ms
    const moves = [at(0, 300, 1000), at(0, 270, 1030), at(0, 240, 1060)];
    const v = flickSpeed(moves, 1065);
    expect(v?.vx).toBeCloseTo(0);
    expect(v?.vy).toBeCloseTo(1);
  });

  it('counts only the moves just before the lift', () => {
    // slow at first, then fast: the speed is the fast part's
    const moves = [at(0, 500, 0), at(0, 490, 300), at(0, 450, 420), at(0, 370, 460), at(0, 290, 500)];
    expect(flickSpeed(moves, 500)?.vy).toBeCloseTo(2);
  });

  it("isn't one when the finger stopped before it lifted", () => {
    const moves = [at(0, 300, 1000), at(0, 240, 1060)];
    expect(flickSpeed(moves, 1200)).toBeNull();
  });

  it("isn't one when the finger was slow", () => {
    const moves = [at(0, 300, 1000), at(0, 297, 1060)];
    expect(flickSpeed(moves, 1060)).toBeNull();
  });

  it('has a top speed', () => {
    const moves = [at(0, 2000, 1000), at(0, 0, 1020)];
    expect(flickSpeed(moves, 1020)?.vy).toBeCloseTo(8);
  });
});

describe('a finger dragging the view', () => {
  // animation frames, run by hand
  let frames: [number, FrameRequestCallback][] = [];
  let id = 0;
  beforeEach(() => {
    frames = [];
    globalThis.requestAnimationFrame = (cb) => {
      frames.push([++id, cb]);
      return id;
    };
    globalThis.cancelAnimationFrame = (n) => {
      frames = frames.filter(([i]) => i !== n);
    };
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  });
  const runFrames = (from: number, count: number) => {
    for (let i = 0; i < count; i++) {
      const due = frames;
      frames = [];
      for (const [, cb] of due) cb(from + i * 16);
    }
  };

  it("doesn't move until the finger passes the slop, then follows it from the slop (no jump)", () => {
    const view = new Viewport(100);
    const pan = new TouchPan(view, 'xy', () => 1000, at(100, 300, 0));
    pan.move(at(100, 295, 10));
    expect(view.y).toBe(0);
    pan.move(at(100, 290, 20)); // 10 px: past the 8 px slop, so the view moves the 2 beyond it
    expect(view.y).toBeCloseTo(2);
    pan.move(at(100, 250, 30));
    expect(view.y).toBeCloseTo(42);
  });

  it("scrolling a list of tracks doesn't drift the time sideways", () => {
    const view = new Viewport(100);
    const pan = new TouchPan(view, 'xy', () => 1000, at(100, 300, 0));
    pan.move(at(102, 280, 10));
    pan.move(at(106, 200, 20));
    expect(view.x).toBe(0);
    expect(view.y).toBeCloseTo(92, 0);
  });

  it('coasts after a flick, slowing to a stop, and stays inside the list', () => {
    const view = new Viewport(100);
    const pan = new TouchPan(view, 'y', () => 400, at(0, 300, 0));
    for (let t = 1; t <= 6; t++) pan.move(at(0, 300 - t * 20, t * 10));
    const lifted = view.y;
    pan.end(60);
    runFrames(100, 2);
    expect(view.y).toBeGreaterThan(lifted);
    runFrames(132, 400);
    expect(view.y).toBe(400);
    expect(frames).toHaveLength(0);
  });

  it('stops coasting when a finger catches it', () => {
    const view = new Viewport(100);
    const pan = new TouchPan(view, 'y', () => 10000, at(0, 300, 0));
    for (let t = 1; t <= 6; t++) pan.move(at(0, 300 - t * 20, t * 10));
    pan.end(60);
    runFrames(100, 3);
    const caught = view.y;
    expect(view.stopFling()).toBe(true);
    runFrames(148, 10);
    expect(view.y).toBe(caught);
    expect(view.stopFling()).toBe(false);
  });

  it("doesn't coast when the finger stopped before it lifted", () => {
    const view = new Viewport(100);
    const pan = new TouchPan(view, 'y', () => 10000, at(0, 300, 0));
    for (let t = 1; t <= 6; t++) pan.move(at(0, 300 - t * 20, t * 10));
    pan.end(400);
    expect(frames).toHaveLength(0);
  });
});
