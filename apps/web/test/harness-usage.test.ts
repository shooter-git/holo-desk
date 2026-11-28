/**
 * What a harness's row in Settings › Agent says of its account's usage (ui/harness-usage.ts): each
 * limit's line, which lines show folded, and what the requests through HO[LO] used.
 */
import { describe, expect, it } from 'vitest';
import type { HarnessInfo, UsageSum } from '../src/app/agent.ts';
import { atClock, meter, startsAgain, tokenCount, usageView, windowLabel } from '../src/ui/harness-usage.ts';

const NOW = Date.UTC(2099, 0, 5, 12, 0);
const H = 3_600_000;
const clock = { now: NOW, locale: 'en-GB', timeZone: 'UTC' };

const base = (id: HarnessInfo['id'], name: string, over: Partial<HarnessInfo> = {}): HarnessInfo => ({
  id,
  name,
  found: true,
  sealed: true,
  signedIn: true,
  ...over,
});

const claude = base('claude', 'Claude Code', {
  plan: 'max',
  limits: {
    at: NOW - 2 * 60_000,
    groups: [
      {
        windows: [
          { minutes: 10080, used: 0.71, resets: NOW + 51 * H },
          { minutes: 300, used: 0.33, resets: NOW + 2 * H + 10 * 60_000 },
        ],
      },
    ],
  },
});

const antigravity = base('antigravity', 'Antigravity', {
  limits: {
    at: NOW - 60_000,
    groups: [
      {
        name: 'Gemini Models',
        models: ['Gemini 4 Neon', 'Gemini 3.8 Flash'],
        windows: [
          { minutes: 10080, used: 0.627, resets: NOW + 134 * H },
          { minutes: 300, used: 0, resets: NOW + 4 * H },
        ],
      },
      {
        name: 'Claude and GPT models',
        models: ['Claude Opus 5.5', 'GPT-OSS 120B'],
        // never used: its vendor gives no reset
        windows: [
          { minutes: 10080, used: 0 },
          { minutes: 300, used: 0 },
        ],
      },
    ],
  },
});

const rows: UsageSum[] = [
  { harness: 'claude', model: 'opus', effort: 'high', requests: 98, input: 412_000, cached: 2_950_000, output: 61_400 },
  {
    harness: 'claude',
    model: 'sonnet',
    effort: 'medium',
    requests: 26,
    input: 88_000,
    cached: 512_000,
    output: 12_300,
  },
  { harness: 'cursor', model: 'auto', effort: '', requests: 1, input: 900, cached: 40, output: 12 },
];

describe('a limit, as its line', () => {
  it('names a window by its length', () => {
    expect([300, 10080, 1440, 43200, 44640, 4320, 180, 90].map(windowLabel)).toEqual([
      '5-hour',
      'Weekly',
      'Daily',
      'Monthly',
      'Monthly',
      '3-day',
      '3-hour',
      '90-minute',
    ]);
  });

  it('says what’s left, and when it starts again: in how long under a day, else the day and time', () => {
    expect(meter({ minutes: 10080, used: 0.71, resets: NOW + 51 * H }, 'k', clock)).toEqual({
      key: 'k',
      label: 'Weekly',
      left: expect.closeTo(0.29, 5),
      text: '29% left',
      when: 'resets Wed 7 Jan, 15:00',
      level: 'ok',
    });
    expect(meter({ minutes: 300, used: 0.33, resets: NOW + 2 * H + 10 * 60_000 }, 'k', clock)).toMatchObject({
      text: '67% left',
      when: 'resets in 2 h 10 min',
    });
    expect(meter({ minutes: 300, used: 0.5, resets: NOW + 25 * 60_000 }, 'k', clock).when).toBe('resets in 25 min');
    expect(meter({ minutes: 300, used: 0.5, resets: NOW + 3 * H }, 'k', clock).when).toBe('resets in 3 h');
    // midnight is 00:00
    expect(meter({ minutes: 10080, used: 0.5, resets: Date.UTC(2099, 0, 9) }, 'k', clock).when).toBe(
      'resets Fri 9 Jan, 00:00',
    );
    // the vendor gives no reset for one never used
    expect(meter({ minutes: 10080, used: 0 }, 'k', clock)).toMatchObject({ text: '100% left', when: '', left: 1 });
  });

  it('turns amber at a fifth, and says so when nothing’s left', () => {
    expect(meter({ minutes: 10080, used: 0.79 }, 'k', clock).level).toBe('ok');
    expect(meter({ minutes: 10080, used: 0.8 }, 'k', clock)).toMatchObject({ level: 'low', text: '20% left' });
    expect(meter({ minutes: 10080, used: 0.997 }, 'k', clock)).toMatchObject({ level: 'low', text: 'Under 1% left' });
    expect(meter({ minutes: 10080, used: 1 }, 'k', clock)).toMatchObject({ level: 'out', text: 'Used up', left: 0 });
  });

  it('never takes a limit that has started again since it was read as full', () => {
    expect(meter({ minutes: 300, used: 0.9, resets: NOW - 4 * H }, 'k', clock)).toEqual({
      key: 'k',
      label: '5-hour',
      left: null,
      text: 'Reset 4 h ago',
      when: 'not read since',
      level: 'stale',
    });
    expect(meter({ minutes: 10080, used: 0.9, resets: NOW - 50 * H }, 'k', clock).text).toBe('Reset Sat 3 Jan, 10:00');
  });

  it('writes token counts short', () => {
    expect(
      [0, 940, 1000, 3449, 41_000, 706_000, 999_600, 3_362_000, 12_000_000, 2_400_000_000].map(tokenCount),
    ).toEqual(['0', '940', '1k', '3.4k', '41k', '706k', '1M', '3.4M', '12M', '2.4B']);
  });
});

describe('a harness’s usage, for its row', () => {
  it('shows the longest limit folded, and every limit of its own for the one in use', () => {
    const other = usageView(claude, { ...clock, current: false, usage: { days: 30, rows } });
    expect(other?.lead.map((m) => m.label)).toEqual(['Weekly']);
    expect(other?.summaryOf).toBeNull();
    // the rest is under More: its other limit, its plan, the requests
    expect(other?.more).toBe(true);
    const used = usageView(claude, { ...clock, current: true, chosen: 'opus', runs: 'claude-opus-5-5' });
    expect(used?.lead.map((m) => `${m.label}: ${m.text}`)).toEqual(['Weekly: 29% left', '5-hour: 67% left']);
    expect(used?.plan).toBe('Max plan');
    // read two minutes ago: not worth saying
    expect(used?.read).toBeNull();
    expect(used?.more).toBe(true);
    expect(used?.through).toBeNull();
  });

  it('leads with the group the model in use counts against, where limits go by groups of models', () => {
    const gemini = usageView(antigravity, { ...clock, current: true, chosen: 'gemini-4-neon', runs: 'gemini-4-neon' });
    expect(gemini?.summaryOf).toBe('Gemini Models');
    expect(gemini?.groups.map((g) => [g.name, g.inUse])).toEqual([
      ['Gemini Models', true],
      ['Claude and GPT models', false],
    ]);
    expect(gemini?.lead.map((m) => m.text)).toEqual(['37% left', '100% left']);
    const claudeThere = usageView(antigravity, {
      ...clock,
      current: true,
      chosen: 'claude-opus-5-5',
      runs: 'claude-opus-5-5',
    });
    expect(claudeThere?.summaryOf).toBe('Claude and GPT models');
    expect(claudeThere?.groups[0]).toMatchObject({ inUse: true, models: 'Claude Opus 5.5, GPT-OSS 120B' });
    expect(claudeThere?.lead.map((m) => m.when)).toEqual(['', '']);
    // not the one in use, or a model no group lists: the vendor's first group, none marked
    const idle = usageView(antigravity, { ...clock, current: false });
    expect(idle?.summaryOf).toBe('Gemini Models');
    expect(idle?.lead).toHaveLength(1);
    expect(idle?.groups.some((g) => g.inUse)).toBe(false);
    const unknown = usageView(antigravity, { ...clock, current: true, chosen: 'new-model', runs: 'new-model' });
    expect(unknown?.groups.some((g) => g.inUse)).toBe(false);
  });

  it('names the limits every model shares beside a family’s own, which a model of that family leads with', () => {
    // (as Claude Code says them as it starts: the session and the week, and one family's own week,
    // with the ids a run of that family is given)
    const families = base('claude', 'Claude Code', {
      limits: {
        at: NOW - 60_000,
        groups: [
          { windows: [{ minutes: 10080, used: 0.71, resets: NOW + 51 * H }] },
          {
            name: 'Fable models',
            models: ['Fable'],
            ids: ['fable', 'claude-fable-9-2'],
            windows: [{ minutes: 10080, used: 0.83, resets: NOW + 51 * H }],
          },
        ],
      },
    });
    const view = usageView(families, { ...clock, current: true, chosen: 'claude-fable-9-2', runs: 'claude-fable-9-2' });
    expect(view?.groups.map((g) => [g.name, g.models, g.inUse])).toEqual([
      ['Fable models', 'Fable', true],
      ['Every model', null, false],
    ]);
    expect(view?.summary?.text).toBe('17% left');
    // a model of no family: the shared ones lead
    const other = usageView(families, { ...clock, current: true, chosen: 'opus', runs: 'claude-opus-9-1' });
    expect(other?.groups[0]?.name).toBe('Every model');
  });

  it('adds up the requests through HO[LO], by model', () => {
    const v = usageView(claude, { ...clock, current: true, usage: { days: 30, rows } });
    expect(v?.through).toEqual({
      days: 30,
      line: '124 requests · 4M tokens in, 74k out',
      rows: [
        { key: 'opus|high', label: 'Opus · high', requests: '98', read: '3.4M', written: '61k' },
        { key: 'sonnet|medium', label: 'Sonnet · medium', requests: '26', read: '600k', written: '12k' },
      ],
    });
  });

  it('says so of a harness that doesn’t report what’s left, with its plan, its own page and HO[LO]’s counts', () => {
    const cursor = base('cursor', 'Cursor', { plan: 'Pro+' });
    const v = usageView(cursor, { ...clock, current: false, usage: { days: 30, rows } });
    expect(v).toMatchObject({
      summary: null,
      lead: [],
      plan: 'Pro+ plan',
      none: 'Cursor doesn’t report what’s left of its plan',
      link: { href: 'https://cursor.com/dashboard?tab=usage', text: 'Cursor’s usage page' },
      more: true,
    });
    expect(v?.through?.line).toBe('1 request · 940 tokens in, 12 out');
    expect(v?.through?.rows[0]?.label).toBe('Auto');
    // nothing counted yet: nothing to unfold
    expect(usageView(cursor, { ...clock, current: false })?.more).toBe(false);
  });

  it('says a harness that tells with each request will show after its next one', () => {
    const fresh = base('claude', 'Claude Code', { plan: 'max' });
    expect(usageView(fresh, { ...clock, current: true })).toMatchObject({
      summary: null,
      none: 'Claude Code says what’s left with each request: it shows after the next one',
      link: null,
    });
    // one that's asked and didn't answer says nothing of it
    expect(usageView(base('codex', 'Codex'), { ...clock, current: false })).toBeNull();
    expect(usageView(base('codex', 'Codex', { plan: 'plus' }), { ...clock, current: false })).toMatchObject({
      plan: 'Plus plan',
      none: null,
    });
  });

  it('says how long ago the limits were read once that’s a while, and a note folded when a limit is low', () => {
    const old = { ...claude, limits: { ...(claude.limits as NonNullable<HarnessInfo['limits']>), at: NOW - 9 * H } };
    expect(usageView(old, { ...clock, current: true })?.read).toBe('Read 9 h ago');
    expect(
      usageView({ ...old, limits: { ...old.limits, at: NOW - 25 * 60_000 } }, { ...clock, current: true })?.read,
    ).toBe('Read 25 min ago');
    expect(usageView({ ...old, limits: { ...old.limits, at: NOW - 80 * H } }, { ...clock, current: true })?.read).toBe(
      'Read 3 days ago',
    );
    const codex = base('codex', 'Codex', {
      limits: { at: NOW, note: '1 early reset available', groups: [{ windows: [{ minutes: 10080, used: 1 }] }] },
    });
    expect(usageView(codex, { ...clock, current: false })).toMatchObject({
      note: '1 early reset available',
      noteNow: '1 early reset available',
    });
    const fine = { ...codex, limits: { ...codex.limits, groups: [{ windows: [{ minutes: 10080, used: 0.1 }] }] } };
    expect(usageView(fine as HarnessInfo, { ...clock, current: false })?.noteNow).toBeNull();
  });

  it('shows nothing of one that isn’t installed, and of one signed out only what was counted', () => {
    expect(usageView({ ...claude, found: false }, { ...clock, current: false })).toBeNull();
    expect(usageView({ ...claude, signedIn: false }, { ...clock, current: false })).toBeNull();
    const out = usageView({ ...claude, signedIn: false }, { ...clock, current: false, usage: { days: 30, rows } });
    expect(out).toMatchObject({ summary: null, plan: null, none: null, groups: [] });
    expect(out?.through?.rows).toHaveLength(2);
  });
});

describe('when a limit starts again', () => {
  it('is said as a wait under a day away, and as a day and a time past that', () => {
    expect(startsAgain(NOW + 2 * H + 10 * 60_000, clock)).toBe('in 2 h 10 min');
    expect(startsAgain(NOW + 25 * 60_000, clock)).toBe('in 25 min');
    expect(startsAgain(NOW + 44 * H, clock)).toBe('Wed 7 Jan, 08:00');
    // a time as a button says it
    expect(atClock(NOW + 2 * H + 5 * 60_000, clock)).toBe('at 14:05');
    expect(atClock(NOW + 12 * H, clock)).toBe('at 00:00');
    expect(atClock(NOW + 44 * H, clock)).toBe('Wed 7 Jan, 08:00');
  });
});
