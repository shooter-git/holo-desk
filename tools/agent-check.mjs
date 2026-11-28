// `pnpm agent:check`: the agent, end to end, in a real browser, with no harness signed in and no
// subscription. It starts a studio of its own (a server on a free port, a data folder removed after),
// the real runner, and for Claude Code and Codex the stand-in (packages/agent/stand-in): a program that
// answers as each does and, for a request, does what the request's script says through HO[LO]'s own
// tools. So everything between the bar and the song is the real thing: pairing, the runner, the
// adapters and their seal checks, the MCP server, the job's routes, the studio's undo step.
//
// What it asks, and fails on:
//
//   - a request: typed in the bar, it adds a track; the reply shows, the track is in the studio, and
//     one Undo takes it out again;
//   - a request while away: the studio's page is closed while the request works; its change is saved
//     on the host, the reply waits, and the studio that comes back has both;
//   - a restart of HO[LO]: while a request works HO[LO] says it's busy (an update waits for it); stopped
//     under it and started again, the request reads as cut short, saying why; a reply that was waiting
//     for the user's OK still shows its button;
//   - Try again: a request that fails in passing shows Try again; pressed, the request carries on from
//     where it was, the page shows it as one exchange, and one Undo takes the whole request back;
//   - out of usage: a request its harness's limit refused says so, with when the limit starts again, and
//     doesn't offer Try again.
//
//   pnpm build && pnpm agent:check
//
// Needs Playwright with its Chromium, as `pnpm ui:check` does: PLAYWRIGHT can be the path of its
// index.mjs when it isn't installed here; PLAYWRIGHT_CHROMIUM, a Chromium already on the machine.
// The runner's HOME and cache are folders of this check's own, and its PATH is Node's folder and the
// system's: the harnesses installed on this computer aren't looked for in your home, signed in or run.
// Linux and macOS (the stand-in's launchers are sh).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeLaunchers } from '../packages/agent/stand-in/launcher.ts';
import { newProject } from '../packages/session/src/index.ts';

const root = resolve(import.meta.dirname, '..');
const built = resolve(root, process.env.HOLO_WEB_DIR ?? 'apps/web/dist');
if (!existsSync(join(built, 'index.html'))) {
  console.error('The studio isn’t built: run pnpm build first.');
  process.exit(2);
}
const where = process.env.PLAYWRIGHT ?? 'playwright';
let chromium;
try {
  ({ chromium } = await import(where.startsWith('/') ? pathToFileURL(where).href : where));
} catch {
  console.error('Playwright isn’t here: install it, or give its index.mjs in PLAYWRIGHT (see the top of this file).');
  process.exit(2);
}

// ---- a studio of its own, and its runner ----

const port = await new Promise((ok, fail) => {
  const s = createServer();
  s.once('error', fail);
  s.listen(0, '127.0.0.1', () => {
    const { port: free } = s.address();
    s.close(() => ok(free));
  });
});
const scratch = mkdtempSync(join(tmpdir(), 'holo-agent-check-'));
const data = join(scratch, 'data');
const base = `http://127.0.0.1:${port}`;
const NODE = ['--disable-warning=ExperimentalWarning'];

const logs = { server: '', runner: '' };
const started = [];
function start(name, args, env) {
  const child = spawn(process.execPath, [...NODE, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => (logs[name] += d));
  child.stderr.on('data', (d) => (logs[name] += d));
  started.push(child);
  return child;
}

const startServer = () =>
  start('server', ['apps/server/src/main.ts'], {
    ...process.env,
    HOLO_PORT: String(port),
    HOLO_HOST: '127.0.0.1',
    HOLO_DATA_DIR: data,
    HOLO_WEB_DIR: built,
    // (the recognition engines off: nothing is fetched)
    HOLO_OMR_URL: '',
  });
let server = startServer();

let browser;
const tidy = () => {
  for (const child of started) child.kill();
  rmSync(scratch, { recursive: true, force: true });
};
process.on('exit', tidy);

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Wait until `test` answers something (it may throw meanwhile), or say what never came. */
async function until(what, test, ms = 20_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const found = await test();
      if (found) return found;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw new Error(`${what} (waited ${Math.round(ms / 1000)} s)${last ? `: ${last.message}` : ''}`);
}

async function api(path, { token, key, method = 'GET', body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'x-holo-runner-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const answer = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(answer)}`);
  return answer;
}

// ---- in the studio ----

const field = (page) => page.locator('.talk-page .field textarea').first();
const track = (page, name) => page.locator(`.track-row div.name[title="${name}"]`);
const songTracks = async (id) => (await api(`/api/projects/${id}`)).tracks.map((t) => t.name);

/** A studio with the song open and started, as the paired device. */
async function open(ctx, id) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(`${base}/?project=${id}`);
  await page.getByRole('button', { name: 'Start the studio' }).click();
  await page.locator('.track-row').first().waitFor();
  return page;
}

/** Type a request in the bar and send it to the agent. */
async function ask(page, text) {
  // (the slash button in the control bar: with the agent on for this device, a desktop's bar is the dock)
  if (!(await page.locator('.talk-page').count())) await page.locator('.cb-bar').first().click();
  await field(page).waitFor();
  await field(page).fill(text);
  await page.locator('.talk-page [role=option]', { hasText: 'Ask the agent' }).first().click();
}

const SCENARIOS = {
  /** A request adds a track: the reply, the track, and one Undo that takes it out. */
  async request({ ctx, id }) {
    const page = await open(ctx, id);
    await ask(page, 'standin: track_add {"name": "Bass"}; finish Added a bass track');
    await page.locator('.talk-page .reply', { hasText: 'Added a bass track' }).waitFor();
    await track(page, 'Bass').waitFor();
    await page.locator('button[aria-label="Undo"]').first().click();
    await track(page, 'Bass').waitFor({ state: 'detached' });
    await page.close();
  },

  /** The studio goes while the request works: the change is saved on the host, and is there on return. */
  async away({ ctx, id, token }) {
    const page = await open(ctx, id);
    await ask(page, 'standin: wait 2500; track_add {"name": "Strings"}; finish Added strings while you were away');
    await page.locator('.talk-page .status').first().waitFor();
    await page.close();
    // (the host gives a studio that went with its page in view a quarter of a minute to come back)
    await until(
      'the request never ended with its studio away',
      async () => (await api(`/api/agent/threads/${id}`, { token })).thread?.turns.at(-1)?.state === 'done',
      60_000,
    );
    if (!(await songTracks(id)).includes('Strings'))
      throw new Error('the change made while away isn’t in the song on the host');
    const back = await open(ctx, id);
    await track(back, 'Strings').waitFor();
    await back.locator('.cb-bar').first().click();
    await back.locator('.talk-page', { hasText: 'Added strings while you were away' }).waitFor();
    await back.close();
  },

  /** A request that fails in passing is tried again: it carries on, as one exchange and one undo step. */
  async again({ ctx, id }) {
    const page = await open(ctx, id);
    await ask(
      page,
      'standin: track_add {"name": "Bass"}; fail-once The service is overloaded; track_add {"name": "Strings"}; finish Added a bass and strings',
    );
    await page.locator('.talk-page .reply', { hasText: 'The service is overloaded' }).waitFor();
    await track(page, 'Bass').waitFor();
    await page.locator('.talk-page button', { hasText: 'Try again' }).click();
    await page.locator('.talk-page .reply', { hasText: 'Added a bass and strings' }).waitFor();
    await track(page, 'Strings').waitFor();
    if (await page.locator('.talk-page .reply', { hasText: 'The service is overloaded' }).count())
      throw new Error('the go that failed still shows beside the one that carried it on');
    if (await page.locator('.talk-page button', { hasText: 'Try again' }).count())
      throw new Error('Try again is still offered after the request finished');
    // the whole request is one step: what both goes changed goes with one Undo
    await page.locator('button[aria-label="Undo"]').first().click();
    await track(page, 'Strings').waitFor({ state: 'detached' });
    await track(page, 'Bass').waitFor({ state: 'detached' });
    await page.close();
  },

  /** A request its harness's limit refused says so, with when it starts again, and isn't offered again as it is. */
  async usage({ ctx, id }) {
    const page = await open(ctx, id);
    await ask(page, 'standin: limit 7200');
    await page
      .locator('.talk-page .reply-after', {
        hasText: /Claude Code is out of usage: its limit starts again in (2 h|1 h 5\d min)\./,
      })
      .waitFor();
    if (await page.locator('.talk-page button', { hasText: 'Try again' }).count())
      throw new Error('Try again is offered for a request that’s out of usage');
    await page.close();
  },

  /** HO[LO] restarts under a working request, and under a reply that waits for an OK. */
  async restart({ ctx, id, token }) {
    const lastTurn = async () => (await api(`/api/agent/threads/${id}`, { token })).thread?.turns.at(-1);
    const page = await open(ctx, id);
    // a request at work: HO[LO] is busy, so an update waits; stopped under it anyway, it says why
    await ask(page, 'standin: wait 20000; finish Too late');
    await until('the request never started', async () => ['waiting', 'running'].includes((await lastTurn())?.state));
    if ((await api('/api/health')).busy !== true) throw new Error('HO[LO] didn’t say it’s busy while a request worked');
    await restart(token);
    const cut = await lastTurn();
    if (cut?.state !== 'failed' || !/restarted/.test(cut.error ?? ''))
      throw new Error(`the request cut short reads ${cut?.state}: ${cut?.error ?? 'no reason given'}`);
    if ((await api('/api/health')).busy !== false) throw new Error('HO[LO] still says it’s busy after the restart');
    await page.reload();
    await page.getByRole('button', { name: 'Start the studio' }).click();
    await page.locator('.track-row').first().waitFor();
    await page.locator('.cb-bar').first().click();
    await page.locator('.talk-page', { hasText: 'HO[LO] restarted while it was working' }).waitFor();

    // a reply that waits for an OK: its button is there after a restart
    await ask(
      page,
      'standin: ask_permission {"kind": "bounce", "detail": "To hear the mix"}; finish Shall I bounce it?',
    );
    const allow = () => page.locator('.talk-page button', { hasText: 'Bounce the song' });
    await allow().waitFor();
    await restart(token);
    if ((await lastTurn())?.state !== 'awaiting')
      throw new Error('the reply no longer waits for its OK after the restart');
    await page.reload();
    await page.getByRole('button', { name: 'Start the studio' }).click();
    await page.locator('.track-row').first().waitFor();
    await page.locator('.cb-bar').first().click();
    await allow().waitFor();
    await page.close();
  },
};

const answering = () =>
  until('The studio didn’t start', async () => {
    if (server.exitCode !== null) throw new Error(`it stopped (${server.exitCode})`);
    return (await fetch(`${base}/api/health`)).ok;
  });

/** Whether both stand-in harnesses are ready, as the runner reports them. */
async function harnessesReady(token) {
  const { harnesses } = await api('/api/agent/settings', { token });
  const ready = (h) => h?.found && h.sealed && h.signedIn !== false;
  return ready(harnesses.find((h) => h.id === 'claude')) && ready(harnesses.find((h) => h.id === 'codex'));
}

/** HO[LO] stopped (as an update or a reboot stops it) and started again on the same data; its runner finds it again. */
async function restart(token) {
  const gone = new Promise((ok) => server.once('exit', ok));
  server.kill();
  await gone;
  server = startServer();
  await answering();
  await until('The runner never came back after the restart', () => harnessesReady(token), 40_000);
}

const failures = [];
try {
  await answering();
  const key = readFileSync(join(data, 'runner.key'), 'utf8').trim();
  const bin = writeLaunchers(join(scratch, 'bin'));
  mkdirSync(join(scratch, 'home'), { recursive: true });
  mkdirSync(join(scratch, 'creations'), { recursive: true });
  start('runner', ['packages/cli/src/main.ts', 'runner', '--creations', join(scratch, 'creations')], {
    PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    HOME: join(scratch, 'home'),
    XDG_CACHE_HOME: join(scratch, 'cache'),
    LANG: 'C.UTF-8',
    HOLO_URL: base,
    HOLO_DATA_DIR: data,
    HOLO_CLAUDE: bin.claude,
    HOLO_CODEX: bin.codex,
  });

  // this check is the device: paired with a code asked for as `holo pair` asks, then the agent's choices
  const { code } = await until('No pairing code came', () =>
    api('/api/agent/pairing', { method: 'POST', key, body: {} }),
  );
  const { token, device } = await api('/api/agent/pair', { method: 'POST', body: { code, name: 'Agent check' } });
  await api('/api/agent/settings', { method: 'PUT', token, body: { harness: 'claude', model: 'opus', effort: 'low' } });
  await until('The runner never reported the stand-in harnesses as ready', () => harnessesReady(token));

  browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required'],
    ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
  });
  const only = process.argv.slice(2);
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    if (only.length && !only.includes(name)) continue;
    const doc = newProject(`Agent check: ${name}`);
    const { id } = await api('/api/projects', { method: 'POST', body: { title: doc.title, doc } });
    // a browser of its own for each, so nothing one keeps (its history, its followed requests) reaches the next
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(
      ([t, d]) => {
        try {
          localStorage.setItem('holo:agent-token', t);
          localStorage.setItem('holo:agent-device', d);
        } catch {
          // a document with no storage of its own (a blank one, before the studio's): nothing to set
        }
      },
      [token, device.id],
    );
    const errors = [];
    ctx.on('weberror', (e) => errors.push(e.error().message));
    const began = Date.now();
    try {
      await scenario({ ctx, id, token });
      if (errors.length) throw new Error(`the page threw: ${errors[0]}`);
      console.log(`${name}: as it should be (${((Date.now() - began) / 1000).toFixed(1)} s)`);
    } catch (e) {
      // (what the studio showed then, for whoever reads the failure: AGENT_CHECK_SHOTS names a folder)
      if (process.env.AGENT_CHECK_SHOTS)
        for (const [i, page] of ctx.pages().entries())
          await page.screenshot({ path: join(process.env.AGENT_CHECK_SHOTS, `${name}-${i}.png`) }).catch(() => {});
      // (a locator that never came is named on the lines after the first)
      const lines = String(e?.message ?? e).split('\n');
      const waited = lines.find((l) => /waiting for /.test(l));
      failures.push(`${name}: ${lines[0]}${waited ? ` (${waited.trim().replace(/^- /, '')})` : ''}`);
    }
    await ctx.close();
  }
} catch (e) {
  failures.push(String(e?.message ?? e));
} finally {
  await browser?.close();
}

if (failures.length) {
  console.error(`\n${failures.length} thing${failures.length === 1 ? '' : 's'} wrong:\n`);
  for (const f of failures) console.error(`  ${f}`);
  // what the host and its runner said, for whoever reads the failure
  for (const [name, text] of Object.entries(logs))
    console.error(`\n---- the ${name}'s last lines ----\n${text.split('\n').slice(-40).join('\n')}`);
  tidy();
  process.exit(1);
}
tidy();
console.log('\nNothing wrong.');
