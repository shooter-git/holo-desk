import { describe, expect, it } from 'vitest';
import {
  along,
  atEnd,
  CLOSE_PX,
  closes,
  drawn,
  drawnToward,
  FLICK_PX,
  FLICK_SPEED,
  HOLD_MS,
  judge,
  judgeToward,
  MOVE_PX,
  speedToward,
  speedUp,
} from '../src/ui/bar-swipe.ts';

describe('a finger on the bar', () => {
  it('is a tap until it has gone a few pixels', () => {
    expect(judge(0, 0, 10)).toBeNull();
    expect(judge(3, -3, 40)).toBeNull();
    expect(judge(0, -MOVE_PX, 40)).toBe('swipe');
  });

  it('draws the card when it goes up, more up than sideways', () => {
    expect(judge(2, -10, 50)).toBe('swipe');
    expect(judge(-7, -8, 50)).toBe('swipe');
  });

  it('leaves the browser a swipe down, a sideways drag, and a press held first', () => {
    // down: a reply scrolled back, or nothing
    expect(judge(0, 10, 50)).toBe('pass');
    // sideways: the caret, or a table that scrolls across
    expect(judge(10, -4, 50)).toBe('pass');
    // held still first: the caret's magnifier, a selection, a menu
    expect(judge(0, -20, HOLD_MS + 1)).toBe('pass');
    expect(judge(0, -20, HOLD_MS)).toBe('swipe');
  });
});

describe('the card under a swipe', () => {
  it('goes up with the finger and never down', () => {
    expect(drawn(-40)).toBe(-40);
    expect(drawn(25)).toBe(0);
  });

  it('closes when drawn far enough up, or flicked', () => {
    expect(closes(CLOSE_PX, 0)).toBe(true);
    expect(closes(CLOSE_PX - 1, 0)).toBe(false);
    expect(closes(FLICK_PX, FLICK_SPEED)).toBe(true);
    // a flick has to go somewhere: a quick twitch drops back
    expect(closes(FLICK_PX - 1, 2)).toBe(false);
    // and has to be quick
    expect(closes(40, FLICK_SPEED / 2)).toBe(false);
  });
});

describe('how fast a finger goes up as it lets go', () => {
  const moves = [
    { y: 300, at: 0 },
    { y: 290, at: 16 },
    { y: 270, at: 32 },
    { y: 240, at: 48 },
  ];

  it('is measured over its last moves', () => {
    expect(speedUp(moves, 50)).toBeCloseTo(60 / 48);
  });

  it('only counts the moves just before it let go', () => {
    const slow = [{ y: 600, at: 0 }, ...moves.map((m) => ({ ...m, at: m.at + 500 }))];
    expect(speedUp(slow, 550)).toBeCloseTo(60 / 48);
  });

  it('is nothing when it rested before it let go, or never moved', () => {
    expect(speedUp(moves, 400)).toBe(0);
    expect(speedUp([], 10)).toBe(0);
    expect(speedUp([{ y: 300, at: 0 }], 10)).toBe(0);
  });

  it('comes out below zero for a finger going down', () => {
    const down = moves.map((m) => ({ ...m, y: 600 - m.y }));
    expect(speedUp(down, 50)).toBeCloseTo(-60 / 48);
  });
});

describe('a reply that scrolls', () => {
  it('is at its end when the last of it shows, give or take a pixel', () => {
    expect(atEnd({ scrollTop: 0, clientHeight: 300, scrollHeight: 300 })).toBe(true);
    expect(atEnd({ scrollTop: 699.5, clientHeight: 300, scrollHeight: 1000 })).toBe(true);
    expect(atEnd({ scrollTop: 600, clientHeight: 300, scrollHeight: 1000 })).toBe(false);
    // past it, as a scroll bounces
    expect(atEnd({ scrollTop: 720, clientHeight: 300, scrollHeight: 1000 })).toBe(true);
  });
});

describe('the page’s swipes, toward its own side', () => {
  it('measures a move toward each side', () => {
    expect(along(3, -10, 'up')).toBe(10);
    expect(along(3, 10, 'down')).toBe(10);
    expect(along(12, 4, 'right')).toBe(12);
    expect(along(-12, 4, 'left')).toBe(12);
    expect(along(-12, 4, 'right')).toBe(-12);
  });

  it('down, held upright: a finger going down takes it, one going up or across is the browser’s', () => {
    expect(judgeToward(0, 3, 20, 'down')).toBeNull();
    expect(judgeToward(2, 10, 50, 'down')).toBe('swipe');
    expect(judgeToward(0, -10, 50, 'down')).toBe('pass');
    expect(judgeToward(10, 4, 50, 'down')).toBe('pass');
    expect(judgeToward(0, 20, HOLD_MS + 1, 'down')).toBe('pass');
  });

  it('right, a sheet: a finger going right takes it, a scroll up or down doesn’t', () => {
    expect(judgeToward(10, 3, 50, 'right')).toBe('swipe');
    expect(judgeToward(-10, 3, 50, 'right')).toBe('pass');
    expect(judgeToward(4, 10, 50, 'right')).toBe('pass');
    expect(judgeToward(0, -MOVE_PX, 40, 'right')).toBe('pass');
    // the bar's own rule is the same as before
    for (const [dx, dy, ms] of [
      [2, -10, 50],
      [0, 10, 50],
      [10, -4, 50],
      [0, -20, HOLD_MS + 1],
    ] as const)
      expect(judgeToward(dx, dy, ms)).toBe(judge(dx, dy, ms));
  });

  it('draws the page toward its side with the finger, never the other way', () => {
    expect(drawnToward(30, 'down')).toBe(30);
    expect(drawnToward(-30, 'down')).toBe(0);
    expect(drawnToward(30, 'right')).toBe(30);
    expect(drawnToward(-30, 'right')).toBe(0);
    expect(drawnToward(-30, 'left')).toBe(-30);
    expect(drawnToward(-30)).toBe(drawn(-30));
  });

  it('measures a flick toward its side as it lets go', () => {
    const right = [
      { x: 100, y: 200, at: 0 },
      { x: 110, y: 201, at: 16 },
      { x: 130, y: 199, at: 32 },
      { x: 160, y: 200, at: 48 },
    ];
    expect(speedToward(right, 50, 'right')).toBeCloseTo(60 / 48);
    expect(speedToward(right, 50, 'left')).toBeCloseTo(-60 / 48);
    expect(speedToward(right, 400, 'right')).toBe(0);
    const down = right.map((m) => ({ x: m.y, y: m.x, at: m.at }));
    expect(speedToward(down, 50, 'down')).toBeCloseTo(60 / 48);
    expect(closes(40, speedToward(right, 50, 'right'))).toBe(true);
  });
});
