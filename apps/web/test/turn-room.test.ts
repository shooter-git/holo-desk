import { describe, expect, it } from 'vitest';
import { shareRoom, type TurnSize } from '../src/ui/turn-room.ts';

/** A turn 40 px as a line; opened out, 20 px besides its lines, each 20 px tall. */
const turn = (you: number, said: number): TurnSize => ({ fold: 40, rest: 20, you, said, youLine: 20, saidLine: 20 });

describe('the room a short conversation leaves, shared among its earlier turns', () => {
  it('leaves a turn as a line when there is no room to open it out', () => {
    // opened out with a line of each it's 60 px: 20 more than as a line
    expect(shareRoom([turn(2, 4)], 0)).toEqual([null]);
    expect(shareRoom([turn(2, 4)], 19)).toEqual([null]);
    expect(shareRoom([turn(2, 4)], 20)).toEqual([{ you: 1, said: 1 }]);
  });

  it('gives lines to the reply until it is whole, then to the request', () => {
    expect(shareRoom([turn(2, 4)], 60)).toEqual([{ you: 1, said: 3 }]);
    expect(shareRoom([turn(2, 4)], 80)).toEqual([{ you: 1, said: 4 }]);
    expect(shareRoom([turn(2, 4)], 100)).toEqual([{ you: 2, said: 4 }]);
  });

  it('never gives a turn more lines than it has', () => {
    expect(shareRoom([turn(2, 4)], 1000)).toEqual([{ you: 2, said: 4 }]);
    expect(shareRoom([turn(3, 0)], 1000)).toEqual([{ you: 3, said: 0 }]);
  });

  it('serves the turn nearest the newest first, and the next with what is left', () => {
    // the first takes 100 of 130; the second opens out with the 30 left, a line of each
    expect(shareRoom([turn(2, 4), turn(3, 6)], 130)).toEqual([
      { you: 2, said: 4 },
      { you: 1, said: 1 },
    ]);
  });

  it('leaves every turn after the first that can’t open out as a line', () => {
    const tall: TurnSize = { ...turn(1, 1), rest: 200 };
    expect(shareRoom([turn(2, 4), tall, turn(1, 2)], 150)).toEqual([{ you: 2, said: 4 }, null, null]);
  });

  it('opens out a turn with no reply to show on its request alone', () => {
    expect(shareRoom([turn(3, 0)], 20)).toEqual([{ you: 2, said: 0 }]);
  });
});
