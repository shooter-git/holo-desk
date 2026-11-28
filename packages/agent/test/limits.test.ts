import { describe, expect, it } from 'vitest';
import {
  addUsage,
  checkFailureKind,
  checkLimits,
  checkRead,
  checkUsage,
  groupFor,
  type LimitGroup,
  usedUp,
} from '../src/limits.ts';

const NOW = Date.UTC(2099, 0, 5);

describe('limits: what a runner reports, checked', () => {
  it('keeps windows as they should be, the longest first, and holds the share used to 0…1', () => {
    expect(
      checkLimits({
        at: NOW,
        note: 'One\nline\u0007 only',
        groups: [
          {
            name: 'Gemini Models',
            models: ['Gemini 4 Neon', 7, ''],
            windows: [
              { minutes: 300, used: -0.2, resets: NOW + 3_600_000 },
              { minutes: 10080, used: 1.4 },
              { minutes: 0, used: 0.5 },
              { minutes: 60, used: 'half' },
              // a reset that isn't a time in this century is left out, the window kept
              { minutes: 1440, used: 0.5, resets: 12 },
            ],
          },
          { name: 'Nothing in it', windows: [] },
          'nope',
        ],
      }),
    ).toEqual({
      at: NOW,
      note: 'One line only',
      groups: [
        {
          name: 'Gemini Models',
          models: ['Gemini 4 Neon'],
          windows: [
            { minutes: 10080, used: 1 },
            { minutes: 1440, used: 0.5 },
            { minutes: 300, used: 0, resets: NOW + 3_600_000 },
          ],
        },
      ],
    });
  });

  it('is nothing when there’s nothing in it to show, or no time it was read', () => {
    expect(checkLimits({ at: NOW, groups: [] })).toBeNull();
    expect(checkLimits({ groups: [{ windows: [{ minutes: 300, used: 0.1 }] }] })).toBeNull();
    expect(checkLimits(null)).toBeNull();
    // a note alone stands
    expect(checkLimits({ at: NOW, note: 'x', groups: [] })).toEqual({ at: NOW, note: 'x', groups: [] });
    // a read may say only the plan
    expect(checkRead({ plan: ' Pro+ ', groups: [] })).toEqual({ plan: 'Pro+', groups: [] });
    expect(checkRead({ groups: [] })).toBeNull();
  });

  it('takes a request’s usage as whole counts, none negative, and adds two up', () => {
    expect(checkUsage({ input: 10.4, cached: 2, output: 3 })).toEqual({ input: 10, cached: 2, output: 3 });
    expect(checkUsage({ input: -1, cached: 2, output: 3 })).toBeNull();
    expect(checkUsage({ input: Number.NaN, cached: 2, output: 3 })).toBeNull();
    expect(checkUsage({ input: 0, cached: 0, output: 0 })).toBeNull();
    expect(checkUsage({ input: 1, output: 3 })).toBeNull();
    expect(addUsage({ input: 1, cached: 2, output: 3 }, { input: 10, cached: 20, output: 30 })).toEqual({
      input: 11,
      cached: 22,
      output: 33,
    });
    expect(addUsage(null, { input: 1, cached: 2, output: 3 })).toEqual({ input: 1, cached: 2, output: 3 });
    expect(addUsage(null, null)).toBeNull();
  });
});

describe('limits: the group a model counts against', () => {
  const week = [{ minutes: 10080, used: 0.5 }];
  const groups: LimitGroup[] = [
    { name: 'Gemini Models', models: ['Gemini 4 Neon', 'Gemini 3.8 Flash'], windows: week },
    { name: 'Claude and GPT models', models: ['Claude Opus 5.5', 'GPT-OSS 120B'], windows: week },
  ];

  it('is the one that lists it, by the vendor’s name or the id the harness takes for it', () => {
    expect(groupFor(groups, 'gemini-4-neon')?.name).toBe('Gemini Models');
    expect(groupFor(groups, 'claude-opus-5-5')?.name).toBe('Claude and GPT models');
    expect(groupFor(groups, 'gpt-oss-120b')?.name).toBe('Claude and GPT models');
    expect(groupFor(groups, 'Gemini 3.8 Flash')?.name).toBe('Gemini Models');
  });

  it('is the only group when it lists no models, and unknown when that can’t be told', () => {
    expect(groupFor([{ windows: week }], 'anything')).toEqual({ windows: week });
    expect(groupFor([{ windows: week }], null)).toEqual({ windows: week });
    expect(groupFor(groups, 'some-other-model')).toBeNull();
    expect(groupFor(groups, '')).toBeNull();
    expect(groupFor(groups, null)).toBeNull();
    expect(groupFor([], 'gemini-4-neon')).toBeNull();
  });
});

describe('limits: whether a model is out of usage now', () => {
  const HOUR = 3_600_000;
  const shared: LimitGroup = {
    windows: [
      { minutes: 10080, used: 0.4, resets: NOW + 48 * HOUR },
      { minutes: 300, used: 1, resets: NOW + 2 * HOUR },
    ],
  };
  const opus: LimitGroup = {
    name: 'Opus models',
    models: ['Opus'],
    windows: [{ minutes: 10080, used: 1, resets: NOW + 72 * HOUR }],
  };

  it('is when a window its requests count against is used up and hasn’t started again', () => {
    expect(usedUp([shared], 'sonnet', NOW)).toEqual({ resets: NOW + 2 * HOUR });
    expect(usedUp([shared], '', NOW)).toEqual({ resets: NOW + 2 * HOUR });
    // (the reset has come since they were read: not known to be used up any more)
    expect(usedUp([shared], 'sonnet', NOW + 3 * HOUR)).toBeNull();
    expect(usedUp([{ windows: [{ minutes: 300, used: 0.99 }] }], 'sonnet', NOW)).toBeNull();
    // a window with no word of when it starts again: used up, till when isn't said
    expect(usedUp([{ windows: [{ minutes: 300, used: 1 }] }], 'sonnet', NOW)).toEqual({});
  });

  it('counts the limits every model shares and the model’s own, and waits for the last of them', () => {
    expect(usedUp([shared, opus], 'opus', NOW)).toEqual({ resets: NOW + 72 * HOUR });
    // another model's own limit says nothing of this one
    expect(usedUp([{ windows: [{ minutes: 300, used: 0.2 }] }, opus], 'sonnet', NOW)).toBeNull();
    expect(usedUp([shared, opus], 'sonnet', NOW)).toEqual({ resets: NOW + 2 * HOUR });
  });

  it('says nothing when the limits go by model and this one is in none of them', () => {
    const gemini: LimitGroup = {
      name: 'Gemini Models',
      models: ['Gemini 4 Neon'],
      windows: [{ minutes: 300, used: 1 }],
    };
    expect(usedUp([gemini], '', NOW)).toBeNull();
    expect(usedUp([gemini], 'claude-opus-5-5', NOW)).toBeNull();
    expect(usedUp([gemini], 'gemini-4-neon', NOW)).toEqual({});
    expect(usedUp([], 'anything', NOW)).toBeNull();
  });
});

describe('why a request stopped, as a runner says it', () => {
  it('is one of the reasons known, with a reset only for usage, ahead and within reason', () => {
    expect(checkFailureKind('usage', NOW + 1000, NOW)).toEqual({ why: 'usage', resets: NOW + 1000 });
    expect(checkFailureKind('usage', NOW - 1000, NOW)).toEqual({ why: 'usage' });
    expect(checkFailureKind('usage', NOW + 400 * 24 * 3_600_000, NOW)).toEqual({ why: 'usage' });
    expect(checkFailureKind('usage', 'soon', NOW)).toEqual({ why: 'usage' });
    expect(checkFailureKind('signed-out', NOW + 1000, NOW)).toEqual({ why: 'signed-out' });
    expect(checkFailureKind('not-installed', undefined, NOW)).toEqual({ why: 'not-installed' });
    expect(checkFailureKind('tired', undefined, NOW)).toBeNull();
    expect(checkFailureKind(undefined, NOW + 1000, NOW)).toBeNull();
  });
});
