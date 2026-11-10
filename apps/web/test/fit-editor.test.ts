import { describe, expect, it } from 'vitest';
import { clampEditorHeight, fitEditorHeight } from '../src/app/layout.ts';

describe('a double-click on the bar above the editor', () => {
  it('gives the editor the empty room under the last track', () => {
    // a 900 px window, the editor at 300, 250 px empty under the tracks
    expect(fitEditorHeight(300, 250, 900)).toBe(550);
  });

  it('changes nothing when the tracks fill the top already', () => {
    expect(fitEditorHeight(300, 0, 900)).toBeNull();
    expect(fitEditorHeight(300, -400, 900)).toBeNull();
    expect(fitEditorHeight(300, 0.4, 900)).toBeNull();
  });

  it('stops where the window leaves the tracks their least', () => {
    // the editor can be at most 900 - 180 = 720
    expect(fitEditorHeight(600, 500, 900)).toBe(720);
    expect(fitEditorHeight(720, 100, 900)).toBeNull();
  });

  it('keeps to whole pixels', () => {
    expect(fitEditorHeight(300, 120.6, 900)).toBe(421);
  });
});

describe("the editor's height", () => {
  it('is never under 140 or over what leaves the tracks 180', () => {
    expect(clampEditorHeight(50, 900)).toBe(140);
    expect(clampEditorHeight(2000, 900)).toBe(720);
    expect(clampEditorHeight(400, 900)).toBe(400);
  });
});
