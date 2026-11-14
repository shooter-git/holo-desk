import { describe, expect, it } from 'vitest';
import { sideways, WheelSteps, wheelPixels } from '../src/ui/wheel-steps.ts';

const wheel = (deltaY: number, o: Partial<{ deltaX: number; deltaMode: number; shiftKey: boolean }> = {}) => ({
  deltaX: 0,
  deltaMode: 0,
  shiftKey: false,
  ...o,
  deltaY,
});

/** The steps a run of wheel events makes, one every `gap` ms. */
function run(deltas: number[], gap = 16): number {
  const w = new WheelSteps();
  return deltas.reduce((sum, d, i) => sum + w.take(wheel(d), i * gap), 0);
}

describe('the wheel over a knob or a fader', () => {
  it('a mouse wheel notch is a step', () => {
    expect(run([100])).toBe(1);
    expect(run([-100])).toBe(-1);
    expect(run([100, 100, 100], 200)).toBe(3);
  });

  it('a notch counted in lines is a step too', () => {
    const w = new WheelSteps();
    expect(w.take(wheel(3, { deltaMode: 1 }), 0)).toBe(1);
    expect(wheelPixels(wheel(-3, { deltaMode: 1 }))).toBe(-100);
  });

  it('a trackpad swipe is a few steps, not one for each of its events', () => {
    // forty small movements, 240 px in all
    const swipe = Array.from({ length: 40 }, () => 6);
    expect(run(swipe)).toBe(3);
  });

  it('the first movement of a turn is a step, however small', () => {
    expect(run([4])).toBe(1);
    expect(run([-2])).toBe(-1);
  });

  it('turning back starts afresh, with no travel owed from the other way', () => {
    const w = new WheelSteps();
    expect(w.take(wheel(100), 0)).toBe(1);
    expect(w.take(wheel(90), 16)).toBe(0);
    expect(w.take(wheel(-10), 32)).toBe(-1);
    expect(w.take(wheel(-80), 48)).toBe(0);
    expect(w.take(wheel(-20), 64)).toBe(-1);
  });

  it('a wheel that rested starts a new turn', () => {
    const w = new WheelSteps();
    expect(w.take(wheel(100), 0)).toBe(1);
    expect(w.take(wheel(60), 16)).toBe(0);
    expect(w.take(wheel(60), 1000)).toBe(1);
  });

  it('sideways is a scroll, not the control’s', () => {
    expect(sideways(wheel(2, { deltaX: 40 }))).toBe(true);
    expect(sideways(wheel(40, { deltaX: 2 }))).toBe(false);
  });

  it('with Shift, a mouse wheel the browser turned sideways is still the control’s, for a fine step', () => {
    const e = wheel(0, { deltaX: 100, shiftKey: true });
    expect(sideways(e)).toBe(false);
    expect(new WheelSteps().take(e, 0)).toBe(1);
  });

  it('nothing turned, nothing stepped', () => {
    expect(new WheelSteps().take(wheel(0, { deltaX: 30 }), 0)).toBe(0);
  });
});
