/**
 * What the agent's page says a song's conversation runs with, and what its chooser offers
 * (ui/agent-chooser.ts): the header's line, what's left of an account's usage for a model, which
 * harnesses are offered with what filled in, and the line where a conversation changed hands.
 */
import { describe, expect, it } from 'vitest';
import type { AgentSettings, AgentState, HarnessInfo, Turn } from '../src/app/agent.ts';
import * as A from '../src/app/agent.ts';
import {
  asksFirst,
  canMove,
  choiceOf,
  chooserFor,
  chooserNote,
  leftOf,
  movedLine,
  offers,
  runsLine,
  runsNow,
  toPick,
} from '../src/ui/agent-chooser.ts';

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

const week = (used: number, resets = NOW + 51 * H) => ({ minutes: 10080, used, resets });
const five = (used: number, resets = NOW + 2 * H + 10 * 60_000) => ({ minutes: 300, used, resets });

const claude = (over: Partial<HarnessInfo> = {}) =>
  base('claude', 'Claude Code', {
    models: ['opus', 'sonnet'],
    efforts: ['low', 'high'],
    aliases: { opus: 'claude-opus-9-1' },
    mustChoose: true,
    limits: { at: NOW - 60_000, groups: [{ windows: [week(0.37), five(0.2)] }] },
    ...over,
  });
const codex = (over: Partial<HarnessInfo> = {}) =>
  base('codex', 'Codex', {
    models: ['gpt-6.1-sol', 'gpt-6.1-luna'],
    efforts: ['low', 'medium', 'high'],
    defaultModel: 'gpt-6.1-sol',
    defaultEfforts: { 'gpt-6.1-sol': 'medium' },
    limits: { at: NOW - 60_000, groups: [{ windows: [week(0.37)] }] },
    ...over,
  });
const cursor = (over: Partial<HarnessInfo> = {}) =>
  base('cursor', 'Cursor', { models: ['auto'], modelEfforts: { auto: [] }, defaultModel: 'auto', ...over });
const antigravity = (over: Partial<HarnessInfo> = {}) =>
  base('antigravity', 'Antigravity', {
    models: ['gemini-4-neon', 'claude-opus-5.5'],
    defaultModel: 'gemini-4-neon',
    limits: {
      at: NOW - 60_000,
      groups: [
        { name: 'Gemini Models', models: ['Gemini 4 Neon'], windows: [week(0.5)] },
        { name: 'Claude and GPT models', models: ['Claude Opus 5.5'], windows: [week(1)] },
      ],
    },
    ...over,
  });

const settings = (harnesses: HarnessInfo[], over: Partial<AgentSettings> = {}): AgentSettings => ({
  enabled: true,
  harness: 'claude',
  model: 'opus',
  effort: 'high',
  harnesses,
  ...over,
});

type Told = Pick<AgentState, 'settings' | 'thread' | 'harness'>;
const told = (
  s: AgentSettings | null,
  thread: AgentState['thread'] = null,
  harness: AgentState['harness'] = {},
): Told => ({
  settings: s,
  thread,
  harness,
});
const turn = (job: string, over: Partial<Turn> = {}): Turn => ({
  job,
  request: 'A bass',
  reply: 'Done.',
  label: null,
  state: 'done',
  at: 1,
  ...over,
});
const P = 'prj_a';

describe('what a song’s conversation runs with', () => {
  it('is what Settings says, until the song has its own choice', () => {
    const a = told(settings([claude(), codex()]));
    expect(runsNow(a, P)).toMatchObject({ id: 'claude', model: 'opus', effort: 'high', own: false });
    const own = told(a.settings, { project: P, turns: [], choice: { harness: 'codex', model: '', effort: '' } });
    expect(runsNow(own, P)).toMatchObject({ id: 'codex', model: '', effort: '', own: true });
    // another song's choice isn't this one's
    expect(runsNow(own, 'prj_b')).toMatchObject({ id: 'claude', own: false });
    // nothing chosen in Settings: the harness the host would pick, never one that asks first
    expect(runsNow(told(settings([antigravity(), codex()], { harness: null, model: '', effort: '' })), P)?.id).toBe(
      'codex',
    );
    // not known yet, or no harness at all: nothing
    expect(runsNow(told(null), P)).toBeNull();
    expect(runsNow(told(settings([], { harness: null })), P)).toBeNull();
    expect(runsNow(a, null)).toBeNull();
    // the harness Settings names isn't on the host now: it's still the one named (a request is
    // refused, it isn't run with another), and the line says so
    const named = told(settings([codex()]));
    expect(runsNow(named, P)).toMatchObject({ id: 'claude', info: null, model: 'opus', effort: 'high' });
    expect(runsLine(runsNow(named, P) as NonNullable<ReturnType<typeof runsNow>>, clock)).toEqual({
      text: 'Claude Code · Opus · high',
      usage: { text: 'not on the host now', warn: true },
    });
  });

  it('is said in one line: the harness, its model and effort, and what’s left', () => {
    const a = told(settings([claude(), codex()]));
    const line = (t: Told) => runsLine(runsNow(t, P) as NonNullable<ReturnType<typeof runsNow>>, clock);
    // an alias keeps its own name; the tightest limit is the week's here
    expect(line(a)).toEqual({ text: 'Claude Code · Opus · high', usage: { text: '63% left', warn: false } });
    // the song's own: said so; the harness's defaults by name where it says them
    const own = told(a.settings, { project: P, turns: [], choice: { harness: 'codex', model: '', effort: '' } });
    expect(line(own)).toEqual({
      text: 'This song: Codex · Gpt-6.1-sol · medium',
      usage: { text: '63% left', warn: false },
    });
    // a model that carries its effort, a harness that reports no limits
    expect(line(told(settings([cursor()], { harness: 'cursor', model: 'auto', effort: '' })))).toEqual({
      text: 'Cursor · Auto',
      usage: null,
    });
    // a harness of the song's choice no runner has now: still named
    const gone = told(settings([claude()]), {
      project: P,
      turns: [],
      choice: { harness: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    });
    expect(line(gone)).toEqual({
      text: 'This song: Codex · Gpt-6.1-sol · high',
      usage: { text: 'not on the host now', warn: true },
    });
    // a share read an hour ago or more says so (the account may have been used since)
    const old = (ago: number) =>
      told(settings([codex({ limits: { at: NOW - ago, groups: [{ windows: [week(0.37)] }] } })], { harness: 'codex' }));
    expect(line(old(59 * 60_000)).usage?.text).toBe('63% left');
    expect(line(old(3 * H)).usage?.text).toBe('63% left, read 3 h ago');
    expect(line(old(6 * 24 * H)).usage?.text).toBe('63% left, read 6 days ago');
  });

  it('says a harness’s own word that it’s out of usage, whatever limits were last read', () => {
    const a = told(settings([claude(), cursor()]));
    const runs = runsNow(a, P) as NonNullable<ReturnType<typeof runsNow>>;
    const refused = (over: object = {}) => ({
      failed: true,
      harness: 'claude' as const,
      model: 'opus',
      stop: { why: 'usage' as const, resets: NOW + 2 * H },
      ...over,
    });
    expect(runsLine(runs, clock, refused()).usage).toEqual({ text: 'Used up, resets in 2 h', warn: true });
    // with no time said, it's still what the harness said (and what the reply under the line says)
    expect(runsLine(runs, clock, refused({ stop: { why: 'usage' } })).usage).toEqual({ text: 'Used up', warn: true });
    // it has started again since, or it was another harness's or model's: as the limits say
    for (const other of [
      refused({ stop: { why: 'usage', resets: NOW - H } }),
      refused({ harness: 'codex' }),
      refused({ model: 'sonnet' }),
      refused({ stop: null }),
      refused({ failed: false }),
    ])
      expect(runsLine(runs, clock, other).usage).toEqual({ text: '63% left', warn: false });
    // a harness that reports no limits
    const c = runsNow(told(settings([cursor()], { harness: 'cursor', model: 'auto', effort: '' })), P);
    expect(runsLine(c as NonNullable<typeof c>, clock, refused({ harness: 'cursor', model: 'auto' })).usage).toEqual({
      text: 'Used up, resets in 2 h',
      warn: true,
    });
  });

  it('says the tightest limit, by its name when it isn’t the week, and warns at a fifth or less', () => {
    const groups = [{ windows: [week(0.37), five(0.92)] }];
    expect(leftOf(groups, ['opus'], clock)).toEqual({
      level: 'low',
      text: '5-hour: 8% left',
      say: 'has 8% left of its 5-hour limit',
    });
    expect(leftOf([{ windows: [week(0.8)] }], [null], clock)).toMatchObject({ level: 'low', text: '20% left' });
    expect(leftOf([{ windows: [week(0.37)] }], [null], clock)).toMatchObject({ say: 'has 63% left this week' });
    // used up: when it starts again (the last of the used-up ones)
    expect(leftOf([{ windows: [week(0.4), five(1)] }], ['opus'], clock)).toEqual({
      level: 'out',
      text: 'Used up, resets in 2 h 10 min',
      say: 'is used up, resets in 2 h 10 min',
    });
    expect(leftOf([{ windows: [week(1, NOW + 43 * H)] }], [null], clock)?.text).toBe(
      'Used up, resets Wed 7 Jan, 07:00',
    );
    expect(leftOf([{ windows: [{ minutes: 10080, used: 1 }] }], [null], clock)?.text).toBe('Used up');
  });

  it('says nothing where nothing is known', () => {
    expect(leftOf([], ['opus'], clock)).toBeNull();
    // a limit that started again since it was read isn't taken as full: the others still say
    expect(leftOf([{ windows: [week(0.37), five(0.99, NOW - H)] }], [null], clock)?.text).toBe('63% left');
    expect(leftOf([{ windows: [week(0.9, NOW - H)] }], [null], clock)).toBeNull();
    // limits by model, and this model in none of them
    const byModel = antigravity().limits?.groups ?? [];
    expect(leftOf(byModel, ['some-other-model'], clock)).toBeNull();
    // the model chosen, or else the one a run uses, finds its group (by the vendor's name for it)
    expect(leftOf(byModel, ['', 'gemini-4-neon'], clock)?.text).toBe('50% left');
    expect(leftOf(byModel, ['claude-opus-5.5'], clock)?.level).toBe('out');
    // signed out: its limits aren't its account's any more
    const out = told(settings([codex({ signedIn: false })], { harness: 'codex', model: '', effort: '' }));
    expect(runsLine(runsNow(out, P) as NonNullable<ReturnType<typeof runsNow>>, clock).usage).toBeNull();
  });
});

describe('where a conversation changed hands', () => {
  it('is said before a turn that ran with another harness or model', () => {
    const a = { harness: 'claude', model: 'opus', effort: 'high' } as const;
    expect(movedLine(a, { harness: 'codex', model: 'gpt-6.1-sol', effort: 'high' })).toBe(
      'Continued with Codex, Gpt-6.1-sol at high',
    );
    expect(movedLine(a, { harness: 'codex', model: '', effort: '' })).toBe('Continued with Codex');
    expect(movedLine(a, { harness: 'claude', model: 'sonnet', effort: 'high' })).toBe(
      'Continued with Claude Code, Sonnet at high',
    );
    // the same harness and model (another effort is Settings' everyday business): nothing
    expect(movedLine(a, { harness: 'claude', model: 'opus', effort: 'low' })).toBeNull();
    // one of them not known (a request on its way, a turn from before this was kept)
    expect(movedLine({ harness: null, model: '' }, { harness: 'codex', model: '', effort: '' })).toBeNull();
    expect(movedLine(a, { harness: null, model: '', effort: '' })).toBeNull();
  });

  it('shows in the conversation’s exchanges', () => {
    let s = A.reduce(A.EMPTY, {
      type: 'info',
      info: { enabled: true, allowed: true, pairing: false, runner: { connected: true, keyed: true } },
    });
    s = A.reduce(s, {
      type: 'thread',
      project: P,
      turns: [
        turn('agj_1', { at: 1, harness: 'claude', model: 'opus', effort: 'high' }),
        turn('agj_2', { at: 2, harness: 'codex', model: 'gpt-6.1-sol', effort: 'low' }),
      ],
      choice: { harness: 'codex', model: 'gpt-6.1-sol', effort: 'low' },
    });
    const [first, second] = A.conversation(s, P);
    expect(movedLine(first as A.Exchange, second as A.Exchange)).toBe('Continued with Codex, Gpt-6.1-sol at low');
    expect(s.thread?.choice).toEqual({ harness: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
    // a conversation started over follows Settings again
    expect(A.reduce(s, { type: 'reset', project: P }).thread).toEqual({ project: P, turns: [], choice: null });
  });
});

describe('what the chooser offers', () => {
  const failed = (harness: HarnessInfo['id'], why?: NonNullable<A.Exchange['stop']>['why']) => ({
    failed: true,
    harness,
    stop: why ? { why } : null,
  });

  it('offers the harnesses that are ready, and says why the others aren’t', () => {
    const a = told(
      settings([
        claude(),
        codex(),
        cursor({ signedIn: false }),
        antigravity(),
        base('cursor', 'Not here', { found: false }),
      ]),
    );
    const o = offers(a, P, null, clock);
    expect(o.ready.map((r) => [r.h.id, r.model, r.effort, r.asks])).toEqual([
      ['claude', 'opus', 'high', false],
      ['codex', '', '', false],
      ['antigravity', '', '', true],
    ]);
    expect(o.notes).toEqual(['Cursor is signed out']);
    expect(o.settings).toEqual({
      id: 'claude',
      text: 'Claude Code, Opus at high effort (last ran as Opus 9.1)',
      asks: false,
    });
    // the song follows Settings: that's what's picked as it opens
    expect(o).toMatchObject({ selected: 'settings', own: false });
  });

  it('leaves out one that can’t be limited, is being updated, or is out of usage with every model', () => {
    const a = told(
      settings([
        claude({ sealed: false, reason: 'too old' }),
        codex({ limits: { at: NOW, groups: [{ windows: [week(1, NOW + 2 * H)] }] } }),
        cursor(),
        antigravity({
          limits: {
            at: NOW,
            groups: [
              { models: ['Gemini 4 Neon'], windows: [week(1, NOW + 5 * H)] },
              { models: ['Claude Opus 5.5'], windows: [week(1, NOW + 3 * H)] },
            ],
          },
        }),
      ]),
      null,
      { cursor: { harness: 'cursor', kind: 'update', state: 'running' } },
    );
    const o = offers(a, P, null, clock);
    expect(o.ready).toEqual([]);
    expect(o.notes).toEqual([
      'Codex is used up, resets in 2 h',
      'Cursor is being updated',
      // (from when the first of its models runs again)
      'Antigravity is used up, resets in 3 h',
    ]);
    // what Settings says is still what the song follows, and can be gone back to
    expect(o).toMatchObject({ settings: { id: 'claude' }, selected: 'settings' });
    // under a failed request it isn't offered: it couldn't carry it on
    expect(offers(a, P, { failed: true, harness: 'cursor', stop: null }, clock)).toMatchObject({
      settings: null,
      selected: null,
    });
    expect(toPick(null)).toBe('Pick a harness');
    expect(chooserNote(null, o.notes, clock)?.text).toBe(
      'Codex is used up, resets in 2 h. Cursor is being updated. Antigravity is used up, resets in 3 h.',
    );
    // one model's limit used up isn't the harness's: it's offered
    expect(offers(told(settings([antigravity()])), P, null, clock).ready.map((r) => r.h.id)).toEqual(['antigravity']);
  });

  it('fills in what each would run with: the song’s own, what it last ran with here, Settings’, its default', () => {
    const thread = {
      project: P,
      turns: [
        turn('agj_1', { harness: 'codex', model: 'gpt-6.1-luna', effort: 'high' }),
        turn('agj_2', { harness: 'claude', model: 'haiku', effort: 'max' }),
      ],
      choice: null,
    };
    const a = told(settings([claude(), codex(), cursor()], { harness: 'cursor', model: 'auto', effort: '' }), thread);
    const by = (o: ReturnType<typeof offers>) => Object.fromEntries(o.ready.map((r) => [r.h.id, [r.model, r.effort]]));
    expect(by(offers(a, P, null, clock))).toEqual({
      // (what it ran with isn't offered any more: left to choose)
      claude: ['', ''],
      codex: ['gpt-6.1-luna', 'high'],
      cursor: ['auto', ''],
    });
    const own = told(a.settings, { ...thread, choice: { harness: 'codex', model: 'gpt-6.1-sol', effort: 'low' } });
    const o = offers(own, P, null, clock);
    expect(by(o).codex).toEqual(['gpt-6.1-sol', 'low']);
    // the song has its own: that's what's picked, and Settings' can be gone back to
    expect(o).toMatchObject({ selected: 'codex', own: true, settings: { id: 'cursor' } });
    // a harness with no defaults says what's left to choose before Continue
    const c = offers(a, P, null, clock).ready[0] as ReturnType<typeof offers>['ready'][number];
    expect(toPick(c)).toBe('Choose a model and an effort first');
    expect(toPick({ ...c, model: 'opus', effort: 'low' })).toBeNull();
    expect(toPick('settings')).toBeNull();
    expect(choiceOf({ ...c, model: 'opus', effort: 'low' })).toEqual({
      harness: 'claude',
      model: 'opus',
      effort: 'low',
    });
    expect(choiceOf('settings')).toBeNull();
  });

  it('under a failure picks another harness ahead, never one that asks first', () => {
    const a = told(settings([claude(), antigravity(), codex()]));
    const blip = offers(a, P, failed('claude'), clock);
    expect(blip.ready.map((r) => r.h.id)).toEqual(['claude', 'antigravity', 'codex']);
    expect(blip.selected).toBe('codex');
    expect(canMove(blip, failed('claude'))).toBe(true);
    // only the one that failed is there: Try again is all there is
    const alone = offers(told(settings([claude()])), P, failed('claude'), clock);
    expect(canMove(alone, failed('claude'))).toBe(false);
    // only one that asks first beside it: offered, not picked ahead; what Settings says is (it failed
    // in passing, and picking it doesn't make it the song's own)
    const asks = offers(told(settings([claude(), antigravity()])), P, failed('claude'), clock);
    expect(asks.selected).toBe('settings');
    expect(canMove(asks, failed('claude'))).toBe(true);
    // not a failure: nothing to continue with
    expect(canMove(blip, { failed: false, harness: 'claude', stop: null })).toBe(false);
  });

  it('doesn’t offer the harness that failed where that wouldn’t help', () => {
    const as = {
      usage: claude(),
      'signed-out': claude({ signedIn: false }),
      'not-installed': claude({ found: false }),
    };
    for (const why of ['usage', 'signed-out', 'not-installed'] as const) {
      const a = told(settings([as[why], codex()]));
      const o = offers(a, P, failed('claude', why), clock);
      expect(o.ready.map((r) => r.h.id)).toEqual(['codex']);
      // (the reply says it of the one that failed; following Settings would be it again)
      expect(o).toMatchObject({ notes: [], settings: null, selected: 'codex' });
      expect(canMove(o, failed('claude', why))).toBe(true);
    }
    // out of usage, alone: nothing to continue with
    const alone = offers(told(settings([claude()])), P, failed('claude', 'usage'), clock);
    expect(alone.ready).toEqual([]);
    expect(canMove(alone, failed('claude', 'usage'))).toBe(false);
    // out of usage with one model, its limits (by model) showing another's still run: offered with that one
    const ranOut = { ...failed('antigravity', 'usage'), model: 'claude-opus-5.5' };
    const models = offers(
      told(settings([antigravity()], { harness: 'antigravity', model: 'claude-opus-5.5', effort: '' })),
      P,
      ranOut,
      clock,
    );
    expect(models.ready.map((r) => [r.h.id, r.model])).toEqual([['antigravity', 'gemini-4-neon']]);
    expect(canMove(models, ranOut)).toBe(true);
    expect(chooserNote(models.ready[0] ?? null, models.notes, clock)).toEqual({
      text: 'Antigravity has 50% left this week.',
      warn: false,
    });
    // a model picked there whose own limit is used up: said so
    expect(
      chooserNote({ ...(models.ready[0] as (typeof models.ready)[number]), model: 'claude-opus-5.5' }, [], clock),
    ).toEqual({ text: 'Antigravity has used up this model’s limit, resets Wed 7 Jan, 15:00.', warn: true });
    // which limit the model that ran out counts against can't be told: not offered again
    expect(
      offers(told(settings([antigravity()])), P, { ...failed('antigravity', 'usage'), model: 'other' }, clock).ready,
    ).toEqual([]);
    // the song's own choice failed, Settings' harness is ready: it can be gone back to
    const own = told(settings([claude(), codex()]), {
      project: P,
      turns: [],
      choice: { harness: 'codex', model: '', effort: '' },
    });
    expect(offers(own, P, failed('codex', 'usage'), clock)).toMatchObject({
      settings: { id: 'claude' },
      selected: 'claude',
    });
  });

  it('offers the harness that failed again once what stopped it no longer holds', () => {
    const a = told(settings([claude(), codex()]));
    // its limit has started again since; it's signed in, or installed, again
    for (const stop of [
      { why: 'usage' as const, resets: NOW - H },
      { why: 'signed-out' as const },
      { why: 'not-installed' as const },
    ]) {
      const o = offers(a, P, { failed: true, harness: 'claude', stop }, clock);
      expect(o.ready.map((r) => r.h.id)).toEqual(['claude', 'codex']);
      expect(o.settings).toMatchObject({ id: 'claude' });
    }
    // a host with that harness alone, hours after it ran out: the chooser isn't empty
    const alone = told(settings([claude()]));
    expect(
      offers(alone, P, { failed: true, harness: 'claude', stop: { why: 'usage', resets: NOW - H } }, clock),
    ).toMatchObject({
      ready: [{ model: 'opus', effort: 'high' }],
      selected: 'settings',
    });
  });

  it('with nothing to carry a failed request on with, is the chooser for the song’s next requests', () => {
    const alone = told(settings([claude()]));
    const out = { failed: true, harness: 'claude' as const, model: 'opus', stop: { why: 'usage' as const } };
    expect(offers(alone, P, out, clock)).toMatchObject({ ready: [], settings: null });
    // (so what the song runs with can still be changed: another model, say)
    const c = chooserFor(alone, P, out, clock);
    expect(c.carries).toBe(false);
    expect(c.o).toMatchObject({ ready: [{ h: { id: 'claude' } }], settings: { id: 'claude' }, selected: 'settings' });
    // with another harness ready, it carries the request on
    expect(chooserFor(told(settings([claude(), codex()])), P, out, clock)).toMatchObject({
      carries: true,
      o: { selected: 'codex' },
    });
    expect(chooserFor(alone, P, null, clock).carries).toBe(false);
  });

  it('never picks ahead, or runs without asking, a harness that asks first: by name or as what Settings says', () => {
    // Settings' harness asks first; the song's own choice is another, which ran out
    const a = told(settings([claude(), antigravity()], { harness: 'antigravity', model: '', effort: '' }), {
      project: P,
      turns: [],
      choice: { harness: 'claude', model: 'opus', effort: 'high' },
    });
    const o = offers(a, P, { failed: true, harness: 'claude', model: 'opus', stop: { why: 'usage' } }, clock);
    expect(o.ready.map((r) => [r.h.id, r.asks])).toEqual([['antigravity', true]]);
    expect(o.settings).toMatchObject({ id: 'antigravity', asks: true });
    expect(o.selected).toBeNull();
    const runs = runsNow(a, P);
    expect(asksFirst('settings', o, runs)).toBe('antigravity');
    expect(asksFirst(o.ready[0] ?? null, o, runs)).toBe('antigravity');
    // the conversation already runs with it: it was asked then
    const follows = told(a.settings);
    expect(asksFirst('settings', offers(follows, P, null, clock), runsNow(follows, P))).toBeNull();
    // one that doesn't ask
    const plain = offers(told(settings([claude(), codex()])), P, null, clock);
    expect(asksFirst(plain.ready[1] ?? null, plain, null)).toBeNull();
    expect(asksFirst('settings', plain, null)).toBeNull();
    expect(asksFirst(null, plain, null)).toBeNull();
  });

  it('doesn’t call a harness used up when one of its models counts against no limit it reports', () => {
    const groups = [
      { models: ['Gemini 4 Neon'], windows: [week(1, NOW + 5 * H)] },
      { models: ['Claude Opus 5.5'], windows: [week(1, NOW + 3 * H)] },
    ];
    const all = antigravity({ limits: { at: NOW, groups } });
    expect(offers(told(settings([all])), P, null, clock).notes).toEqual(['Antigravity is used up, resets in 3 h']);
    const more = antigravity({ models: ['gemini-4-neon', 'claude-opus-5.5', 'gpt-oss'], limits: { at: NOW, groups } });
    expect(offers(told(settings([more])), P, null, clock)).toMatchObject({
      ready: [{ h: { id: 'antigravity' } }],
      notes: [],
    });
  });

  it('says what’s left for what’s picked, then of the others', () => {
    const o = offers(told(settings([claude(), codex(), cursor({ signedIn: false })])), P, null, clock);
    const codexOffer = o.ready.find((r) => r.h.id === 'codex') ?? null;
    expect(chooserNote(codexOffer, o.notes, clock)).toEqual({
      text: 'Codex has 63% left this week. Cursor is signed out.',
      warn: false,
    });
    expect(chooserNote(null, [], clock)).toBeNull();
  });
});

describe('the bar’s command', () => {
  const run = { scan: () => undefined, reset: () => undefined };
  it('opens the chooser, when nothing works on the song', () => {
    let opened = 0;
    const rows = A.agentCommands({ on: true, project: P, scan: null, busy: false }, { ...run, choose: () => opened++ });
    const c = rows.commands.find((r) => r.id === 'agent-continue');
    expect(c).toMatchObject({ title: 'Continue this conversation with…', group: 'Agent', keepOpen: true });
    c?.run();
    expect(opened).toBe(1);
    const busy = A.agentCommands({ on: true, project: P, scan: null, busy: true }, { ...run, choose: () => opened++ });
    expect(busy.commands.find((r) => r.id === 'agent-continue')?.available?.({} as never)).toBe(false);
  });

  it('the chooser is one song’s, shown and put away', () => {
    let s = A.reduce(A.EMPTY, { type: 'choosing', project: P });
    expect(s.choosing).toBe(P);
    s = A.reduce(s, { type: 'choosing', project: null });
    expect(s.choosing).toBeNull();
  });
});
