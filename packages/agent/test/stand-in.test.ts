/**
 * The stand-in harness (packages/agent/stand-in): its script, and that HO[LO]'s own adapters take it
 * for Claude Code and for Codex, from the look at it (found, signed in, sealed, its models) to a run
 * that changes a song through HO[LO]'s real MCP server.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { applyOps, newProject, type Op, type Project } from '@holo/session';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { claudeHarness } from '../src/harness/claude.ts';
import { codexArgs, codexHarness } from '../src/harness/codex.ts';
import type { Harness, RunEvent } from '../src/harness/types.ts';
import { mcpServer } from '../src/harness/workspace.ts';
import { claudeServer, codexServer } from '../stand-in/config.ts';
import { writeLaunchers } from '../stand-in/launcher.ts';
import { DEFAULT_STEPS, parseScript, recallOf, requestOf, scriptOf, splitSteps } from '../stand-in/script.ts';
import { job as anyJob, REPO, runToEnd, type Sandbox, sandbox, TOKEN } from './fakes.ts';

describe('a stand-in script', () => {
  it('is what follows the prompt’s last "The request"', () => {
    expect(requestOf('# Rules\n\n## The request\nstandin: finish Hi\n')).toBe('standin: finish Hi');
    expect(requestOf('## The request\nold\n\n## The request\nnew')).toBe('new');
    expect(requestOf('no headings at all')).toBe('no headings at all');
  });

  it('splits at each ; outside quotes, braces and brackets', () => {
    expect(splitSteps('a {"x": "1;2"}; b [1;2] ; c "x;y";; d')).toEqual(['a {"x": "1;2"}', 'b [1;2]', 'c "x;y"', 'd']);
  });

  it('reads tools, waits, words and a failure, in order', () => {
    expect(parseScript('standin: track_add {"name": "Bass"}; wait 250; say Hm; finish Added a bass; fail No')).toEqual([
      { do: 'call', tool: 'track_add', args: { name: 'Bass' } },
      { do: 'wait', ms: 250 },
      { do: 'say', text: 'Hm' },
      { do: 'call', tool: 'finish', args: { label: 'Stand-in', reply: 'Added a bass' } },
      { do: 'fail', error: 'No' },
    ]);
    expect(parseScript('Standin: song_status; finish {"label": "L", "reply": "R"}')).toEqual([
      { do: 'call', tool: 'song_status', args: {} },
      { do: 'call', tool: 'finish', args: { label: 'L', reply: 'R' } },
    ]);
  });

  it('reads a failure that happens once, and an account out of usage', () => {
    expect(parseScript('standin: fail-once Overloaded; limit; limit 90')).toEqual([
      { do: 'fail', error: 'Overloaded', once: true },
      { do: 'limit', seconds: 3600 },
      { do: 'limit', seconds: 90 },
    ]);
    expect(parseScript('standin: limit never')).toMatch(/seconds/);
    // one harness's account alone
    expect(parseScript('standin: limit 90 claude; finish Done')).toMatchObject([
      { do: 'limit', seconds: 90, only: 'claude' },
      { do: 'call', tool: 'finish' },
    ]);
    expect(parseScript('standin: limit 90 cursor')).toMatch(/claude or codex/);
    // till a time
    expect(parseScript('standin: limit-until 4102444800 claude')).toEqual([
      { do: 'limit', seconds: 0, until: 4102444800, only: 'claude' },
    ]);
    expect(parseScript('standin: limit-until soon')).toMatch(/seconds since 1970/);
  });

  it('finds the script in a request carried on: from its last line that starts with standin:', () => {
    const wrapped = 'Your last go at this request didn’t finish.\nThen carry on with the request:\nstandin: finish Hi';
    expect(scriptOf(wrapped)).toBe('standin: finish Hi');
    expect(parseScript(wrapped)).toEqual([{ do: 'call', tool: 'finish', args: { label: 'Stand-in', reply: 'Hi' } }]);
    expect(scriptOf('Make the chorus bigger, standin: or not')).toBeNull();
  });

  it('says what a prompt told of the conversation before the request', () => {
    expect(recallOf('## The request\nstandin: recall')).toBe(
      'Told: nothing before the request. Turns in the record: 0.',
    );
    expect(
      recallOf(
        '# Rules\n### 1. A rule of the agent’s\n\n## The conversation so far\nA record.\n\n### 1. Asked\nOne\n\n### 2. Asked\nTwo\n\n## The song now\n- Read it.\n\n## The request\nstandin: recall',
      ),
    ).toBe('Told: The conversation so far, The song now. Turns in the record: 2.');
    expect(parseScript('standin: recall')).toEqual([{ do: 'recall' }]);
  });

  it('reads the song and finishes when the request isn’t a script', () => {
    expect(parseScript('Make the chorus bigger')).toEqual(DEFAULT_STEPS);
  });

  it('says what’s wrong with a script it can’t read', () => {
    expect(parseScript('standin: track_add {name}')).toMatch(/aren't JSON/);
    expect(parseScript('standin: track_add [1]')).toMatch(/JSON object/);
    expect(parseScript('standin: wait soon')).toMatch(/milliseconds/);
    expect(parseScript('standin: Track-Add {}')).toMatch(/not a step/);
    expect(parseScript('standin: ;')).toBe('an empty script');
  });
});

describe('where a stand-in run finds HO[LO]’s tools', () => {
  const server = mcpServer({
    node: '/usr/bin/node',
    repo: '/srv/holo desk',
    base: 'http://127.0.0.1:47999',
    job: 'agj_0123456789ab',
    workspace: '/tmp/work "space"',
    middleC: 'C3',
  });

  it('reads Codex’s settings as HO[LO] writes them', () => {
    const argv = codexArgs({ model: '', effort: 'low', workspace: '/tmp/w' }, server);
    expect(codexServer(argv)).toEqual(server);
    expect(codexServer(['exec', '-'])).toBeNull();
  });

  it('reads Claude Code’s MCP config', () => {
    expect(claudeServer(JSON.stringify({ mcpServers: { holo: { type: 'stdio', ...server, timeout: 1 } } }))).toEqual(
      server,
    );
    expect(claudeServer('{}')).toBeNull();
    expect(claudeServer('not json')).toBeNull();
  });
});

// ---- HO[LO]'s job routes, as far as these runs reach them ----

let song: Project = newProject('Stand-in song');
const seen: { method: string; path: string; body: unknown }[] = [];
let http: Server;
let base = '';
const JOB = 'agj_0123456789ab';

beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as unknown) : undefined;
      const path = (req.url ?? '').split('?')[0] ?? '';
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(403, { error: 'Not this job' });
      const prefix = `/api/agent/jobs/${JOB}`;
      if (!path.startsWith(prefix)) return send(404, { error: 'Not found' });
      const rest = path.slice(prefix.length);
      seen.push({ method: req.method ?? '', path: rest, body });
      if (req.method === 'GET' && rest === '/song') return send(200, song);
      if (req.method === 'GET' && rest === '/state')
        return send(200, { playhead: 0, position: '1.1', playing: false, selection: {}, about: [] });
      if (req.method === 'GET' && rest === '/commands') return send(200, { commands: [] });
      if (req.method === 'POST' && rest === '/ops') {
        song = applyOps(song, (body as { ops: Op[] }).ops);
        return send(200, { ok: true, revision: 2 });
      }
      if (req.method === 'POST' && (rest === '/progress' || rest === '/finish')) return send(200, { ok: true });
      return send(404, { error: 'Not found' });
    });
  });
  await new Promise<void>((ok) => http.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(() => http?.close());

let s: Sandbox;
afterEach(() => {
  s?.cleanup();
  seen.length = 0;
  song = newProject('Stand-in song');
});

const posted = (path: string) => seen.filter((r) => r.method === 'POST' && r.path === path).map((r) => r.body);
const ended = (events: RunEvent[]) => events.find((e) => e.type === 'done' || e.type === 'failed');
const sessionOf = (events: RunEvent[]) => events.find((e) => e.type === 'session')?.session;

const HARNESSES: [string, (sb: Sandbox) => Harness, { model: string; effort: string }][] = [
  [
    'Claude Code',
    (sb) =>
      claudeHarness({
        env: { ...sb.env, HOLO_CLAUDE: writeLaunchers(join(sb.dir, 'bin')).claude },
        root: sb.root,
        repo: REPO,
        fetchText: async () => '2.1.999\n',
      }),
    { model: 'opus', effort: 'low' },
  ],
  [
    'Codex',
    (sb) =>
      codexHarness({
        env: { ...sb.env, HOLO_CODEX: writeLaunchers(join(sb.dir, 'bin')).codex },
        root: sb.root,
        repo: REPO,
        fetchText: async () => JSON.stringify({ version: '0.999.0' }),
      }),
    { model: '', effort: '' },
  ],
];

describe('the stand-in as Claude Code, asked of itself as it starts', () => {
  it('says its models, what each alias stands for and its account’s limits, with no request made', async () => {
    s = sandbox();
    const h = (HARNESSES[0] as (typeof HARNESSES)[number])[1](s);
    const info = await h.info();
    expect(info).toMatchObject({
      found: true,
      sealed: true,
      signedIn: true,
      models: ['opus', 'sonnet'],
      efforts: ['low', 'medium', 'high'],
      aliases: { opus: 'claude-opus-stand-in', sonnet: 'claude-sonnet-stand-in' },
      mustChoose: true,
      limits: {
        groups: [
          {
            windows: [
              { minutes: 10080, used: 0.37 },
              { minutes: 300, used: 0.12 },
            ],
          },
        ],
      },
    });
  });
});

describe.each(HARNESSES)('the stand-in as %s', (_name, make, runsWith) => {
  const request = (text: string, over: { session?: string } = {}) =>
    anyJob(s, { ...runsWith, ...over, base, prompt: `## The request\n${text}\n` });

  it('is found, signed in and sealed, with models to choose from', async () => {
    s = sandbox();
    const info = await make(s).info(true);
    expect(info).toMatchObject({ found: true, signedIn: true, sealed: true });
    expect(info.version).toContain('999');
    expect(info.models?.length).toBeGreaterThan(1);
  });

  it('runs a script through HO[LO]’s tools: the song changes, and finish says so', async () => {
    s = sandbox();
    const events = await runToEnd(make(s), request('standin: track_add {"name": "Bass"}; finish Added a bass track'));
    expect(ended(events)).toMatchObject({ type: 'done' });
    expect(ended(events)).toHaveProperty('usage');
    expect(sessionOf(events)).toBeTruthy();
    expect(song.tracks.map((t) => t.name)).toContain('Bass');
    expect(posted('/finish')).toEqual([expect.objectContaining({ label: 'Stand-in', reply: 'Added a bass track' })]);
  });

  it('fails as the harness does, with the script’s words', async () => {
    s = sandbox();
    const events = await runToEnd(make(s), request('standin: fail Quota exceeded.'));
    expect(ended(events)).toMatchObject({ type: 'failed', error: 'Quota exceeded.' });
    expect(posted('/finish')).toEqual([]);
  });

  it('fails once, and carries on after that step at the next go, as a request tried again does', async () => {
    s = sandbox();
    const h = make(s);
    const script =
      'standin: track_add {"name": "Bass"}; fail-once Overloaded; track_add {"name": "Strings"}; finish Both';
    const first = await runToEnd(h, request(script));
    expect(ended(first)).toMatchObject({ type: 'failed', error: 'Overloaded' });
    expect(ended(first)).not.toHaveProperty('why');
    expect(song.tracks.map((t) => t.name)).toEqual(expect.arrayContaining(['Bass']));
    expect(song.tracks.map((t) => t.name)).not.toContain('Strings');
    // (as HO[LO] words a request it carries on, in the same conversation)
    const again = await runToEnd(
      h,
      request(`Your last go at this request didn’t finish.\n${script}`, { session: sessionOf(first) as string }),
    );
    expect(ended(again)).toMatchObject({ type: 'done' });
    expect(song.tracks.filter((t) => t.name === 'Bass')).toHaveLength(1);
    expect(song.tracks.map((t) => t.name)).toContain('Strings');
  });

  it('runs out of usage as its harness says it: no reason is guessed, the harness’s own signal is read', async () => {
    s = sandbox();
    const before = Date.now();
    const events = await runToEnd(make(s), request('standin: limit 600'));
    expect(ended(events)).toMatchObject({ type: 'failed', why: 'usage' });
    const resets = (ended(events) as { resets?: number }).resets;
    // (Claude Code says when the limit starts again; an API key's quota, as Codex words it, doesn't)
    if (resets !== undefined) {
      expect(resets).toBeGreaterThan(before + 590_000);
      expect(resets).toBeLessThan(Date.now() + 610_000);
    }
  });

  it('goes on past a limit that is only the other harness’s account’s', async () => {
    s = sandbox();
    const mine = _name === 'Claude Code' ? 'claude' : 'codex';
    const other = mine === 'claude' ? 'codex' : 'claude';
    expect(ended(await runToEnd(make(s), request(`standin: limit 600 ${other}; finish Went on`)))).toMatchObject({
      type: 'done',
    });
    expect(ended(await runToEnd(make(s), request(`standin: limit 600 ${mine}; finish Went on`)))).toMatchObject({
      type: 'failed',
      why: 'usage',
    });
  });

  it('is out of usage till a time, and goes on once that has passed', async () => {
    s = sandbox();
    const soon = Math.floor(Date.now() / 1000) + 600;
    const out = ended(await runToEnd(make(s), request(`standin: limit-until ${soon}; finish Went on`)));
    expect(out).toMatchObject({ type: 'failed', why: 'usage' });
    const past = Math.floor(Date.now() / 1000) - 5;
    expect(ended(await runToEnd(make(s), request(`standin: limit-until ${past}; finish Went on`)))).toMatchObject({
      type: 'done',
    });
  });

  it('carries a conversation on under the session it was given', async () => {
    s = sandbox();
    const h = make(s);
    const first = sessionOf(await runToEnd(h, request('standin: finish One')));
    expect(first).toBeTruthy();
    const again = await runToEnd(h, request('standin: finish Two', { session: first as string }));
    expect(ended(again)).toMatchObject({ type: 'done' });
    // (a session that's the same isn't said again)
    expect(sessionOf(again) ?? first).toBe(first);
    expect(posted('/finish')).toHaveLength(2);
  });

  it('is asked for finish when a turn ends without it, and gives it', async () => {
    s = sandbox();
    const events = await runToEnd(make(s), request('standin: say All done, I think'));
    expect(ended(events)).toMatchObject({ type: 'done' });
    expect(posted('/finish')).toHaveLength(1);
  });
});
