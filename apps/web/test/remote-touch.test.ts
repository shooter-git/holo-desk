import { describe, expect, it } from 'vitest';
import { HIDDEN_STALE_MS, outOfTouch, STALE_MS, type StudioState } from '../src/app/remote.ts';

/** A studio's report, with only what the rule reads set. */
const studio = (patch: Partial<StudioState>): StudioState =>
  ({ project: 'prj_song', playing: false, audio: true, hidden: false, ...patch }) as StudioState;

describe('a remote telling whether the studio is still in touch', () => {
  it('expects a studio in front to report within a couple of seconds while it plays or its audio runs', () => {
    expect(outOfTouch(studio({}), STALE_MS - 1, null)).toBe(false);
    expect(outOfTouch(studio({}), STALE_MS + 1, null)).toBe(true);
    expect(outOfTouch(studio({ playing: true, audio: false }), STALE_MS + 1, null)).toBe(true);
  });

  it('expects nothing from an idle studio, which only reports what changes', () => {
    expect(outOfTouch(studio({ audio: false }), 10 * 60_000, null)).toBe(false);
    expect(outOfTouch(studio({ project: null }), 10 * 60_000, null)).toBe(false);
  });

  it('allows a hidden studio a minute’s silence, since its browser slows its timers', () => {
    const hidden = studio({ hidden: true });
    expect(outOfTouch(hidden, 61_000, null)).toBe(false);
    expect(outOfTouch(studio({ hidden: true, playing: true }), 61_000, null)).toBe(false);
    expect(outOfTouch(hidden, HIDDEN_STALE_MS + 1, null)).toBe(true);
  });

  it('expects a hidden studio to answer a command within a couple of seconds, however quiet it is otherwise', () => {
    const hidden = studio({ hidden: true });
    expect(outOfTouch(hidden, 30_000, STALE_MS - 1)).toBe(false);
    expect(outOfTouch(hidden, 30_000, STALE_MS + 1)).toBe(true);
    // (an idle one too: a command not answered is a studio not there)
    expect(outOfTouch(studio({ hidden: true, audio: false }), 30_000, STALE_MS + 1)).toBe(true);
  });

  it('keeps the old rule for a studio in front, whatever was asked of it (it doesn’t answer each command)', () => {
    expect(outOfTouch(studio({ audio: false }), 30_000, 10_000)).toBe(false);
    expect(outOfTouch(studio({}), STALE_MS - 1, 10_000)).toBe(false);
  });
});
