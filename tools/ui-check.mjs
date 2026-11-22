// `pnpm ui:check`: the studio's layout, looked at in a real browser at a desktop's size, a tablet's
// and a phone's (upright and on its side). It opens every main view, the two big dialogs and the
// commands (the bar on a desktop, the agent's page elsewhere: with the agent off, and with it on and
// a conversation to show), and fails when:
//
//   - the page itself scrolls (something is wider or taller than the screen);
//   - a control can't be reached: cut off by its pane with no scroll that would bring it in;
//   - a control is covered by something that isn't a menu, a dialog or a window;
//   - the mixer's strips don't line up (pan, level, fader, buttons and name start at the same
//     height on every strip), or a fader has less than its least travel;
//   - with the page open, the transport or the tabs are covered (no dialog excuses it), or the page
//     lets the studio show through (it's solid: no blur, nothing see-through);
//   - a request's working line, its time and Stop don't fit beside each other;
//   - the page throws.
//
// It starts a studio of its own (a server on a free port, a data folder that's removed after) with a
// small song made here, on the built-in synths, so nothing is fetched and nobody's songs are touched.
// The agent's host is played by the check itself (its routes answered in the browser), so no runner
// or harness is needed.
//
//   pnpm build && pnpm ui:check
//
// Needs Playwright with its Chromium (`npx playwright install chromium`). As for tools/screens.mjs,
// PLAYWRIGHT can be the path of its index.mjs when it isn't installed here; PLAYWRIGHT_CHROMIUM, a
// Chromium already on the machine.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  newBus,
  newPlugin,
  newProject,
  newRegion,
  newTrack,
  PPQ,
  TRACK_COLORS,
} from '../packages/session/src/index.ts';

const root = resolve(import.meta.dirname, '..');
// (HOLO_WEB_DIR, as for the server: a build somewhere else)
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

// ---- a song with enough in it: more strips than a phone is wide, slots of every kind ----

const BAR = PPQ * 4;
function song() {
  const p = newProject('UI check');
  const hall = p.buses[0];
  const plate = newBus('Plate');
  plate.channel.inserts.push(newPlugin('reverb'), newPlugin('eq'));
  p.buses.push(plate);
  const parts = [
    ['Keys', 'Electric Piano', ['eq', 'compressor', 'chorus', 'delay', 'limiter']],
    ['A pad with a name too long for its strip', 'Ethereal Pad', ['eq', 'width']],
    ['Lead', 'Fat Mono', ['saturator', 'phaser', 'tremolo']],
    ['Bass', 'FM Bass', ['eq']],
    ['Drums', 'Analog Machine', ['gate', 'compressor']],
    ['Organ', 'Tonewheel Jazz', ['rotary']],
    ['Bells', 'FM Bells', []],
    ['Strings', 'Strings Ensemble', ['eq']],
    ['Pluck', 'Morph Pluck', []],
    ['Sub', 'Sub Bass', []],
  ];
  p.tracks = parts.map(([name, preset, inserts], i) => {
    const t = newTrack(name, { type: 'synth', preset }, TRACK_COLORS[i % TRACK_COLORS.length]);
    t.channel.volume = -6 - i;
    t.channel.pan = ((i % 5) - 2) / 4;
    t.channel.inserts = inserts.map((type) => newPlugin(type));
    t.channel.sends = [{ bus: hall.id, level: -12, pre: false }];
    if (i % 2) t.channel.sends.push({ bus: plate.id, level: -18, pre: false });
    for (const start of [i % 3, 5 + (i % 3)]) {
      const r = newRegion(start * BAR, 4 * BAR);
      r.notes = [0, 1, 2, 3].flatMap((bar) =>
        [57, 60, 64].map((pitch) => ({ t: bar * BAR, d: BAR - 60, p: pitch + (i % 3) * 2, v: 80 })),
      );
      t.regions.push(r);
    }
    return t;
  });
  p.tracks[0].armed = true;
  p.tracks[0].channel.automation = [
    {
      param: 'volume',
      mode: 'read',
      points: [
        [0, -12],
        [BAR * 4, -3],
        [BAR * 8, -9],
      ],
    },
  ];
  p.markers = [
    { id: 'mrk_intro', tick: 0, name: 'Intro' },
    { id: 'mrk_verse', tick: BAR * 4, name: 'A marker with a long name' },
  ];
  return p;
}

// ---- a studio of its own ----

const port = await new Promise((ok, fail) => {
  const s = createServer();
  s.once('error', fail);
  s.listen(0, '127.0.0.1', () => {
    const { port: free } = s.address();
    s.close(() => ok(free));
  });
});
const data = mkdtempSync(join(tmpdir(), 'holo-ui-check-'));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'apps/server/src/main.ts'], {
  cwd: root,
  env: { ...process.env, HOLO_PORT: String(port), HOLO_HOST: '127.0.0.1', HOLO_DATA_DIR: data, HOLO_WEB_DIR: built },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
let browser;
const tidy = () => {
  server.kill();
  rmSync(data, { recursive: true, force: true });
};
process.on('exit', tidy);

async function up() {
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) break;
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`The studio didn’t start:\n${serverLog}`);
}

// ---- what's wrong on the page as it stands (runs in the page) ----

function problems() {
  const out = [];
  const vw = innerWidth;
  const vh = innerHeight;
  const name = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 36);
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''} “${label}”`;
  };
  const de = document.documentElement;
  if (de.scrollWidth > vw + 1) out.push(`the page scrolls sideways (${de.scrollWidth} px wide on a ${vw} px screen)`);
  if (de.scrollHeight > vh + 1) out.push(`the page scrolls down (${de.scrollHeight} px tall on a ${vh} px screen)`);

  const shown = (el) => {
    if (el.closest('[inert]')) return false;
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // the part of a control that can be seen, clipped by every pane around it, and whether one of them
  // could scroll the rest in
  const seen = (el) => {
    const r = el.getBoundingClientRect();
    let [x0, y0, x1, y1] = [r.left, r.top, r.right, r.bottom];
    let scrollX = false;
    let scrollY = false;
    for (let e = el.parentElement; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      const b = e.getBoundingClientRect();
      if (/auto|scroll/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 1) scrollX = true;
      if (/auto|scroll/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1) scrollY = true;
      // (the tracks scroll by their own hand: view.ts)
      if (e.classList.contains('track-list')) scrollY = true;
      if (s.overflowX !== 'visible') [x0, x1] = [Math.max(x0, b.left), Math.min(x1, b.right)];
      if (s.overflowY !== 'visible') [y0, y1] = [Math.max(y0, b.top), Math.min(y1, b.bottom)];
      if (s.position === 'fixed') break;
    }
    [x0, y0, x1, y1] = [Math.max(x0, 0), Math.max(y0, 0), Math.min(x1, vw), Math.min(y1, vh)];
    return { r, x0, y0, x1, y1, scrollX, scrollY };
  };
  const controls =
    'button, a[href], input, select, textarea, [role=button], [role=slider], [role=tab], [role=switch], [role=checkbox], [tabindex]:not([tabindex="-1"])';
  const over = '[role=dialog], [role=menu], .view-menu, .scrim, .bar-scrim, .toast, .banner, .overlay-panel';
  const said = new Set();
  for (const el of document.querySelectorAll(controls)) {
    if (el.disabled || !shown(el)) continue;
    const c = seen(el);
    const w = Math.max(0, c.x1 - c.x0);
    const h = Math.max(0, c.y1 - c.y0);
    const say = (what) => {
      const line = `${what}: ${name(el)}`;
      if (!said.has(line)) out.push(line);
      said.add(line);
    };
    if (w / c.r.width < 0.98 && !c.scrollX)
      say(`cut off sideways (${Math.round((w / c.r.width) * 100)}% shows, nothing scrolls it in)`);
    else if (h / c.r.height < 0.98 && !c.scrollY)
      say(`cut off in height (${Math.round((h / c.r.height) * 100)}% shows, nothing scrolls it in)`);
    else if (w > 4 && h > 4 && w / c.r.width >= 0.98 && h / c.r.height >= 0.98) {
      const top = document.elementFromPoint((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2);
      if (!top || top === el || el.contains(top) || top.contains(el)) continue;
      // (a label is its field's; what's over the studio on purpose isn't a fault of what's under it, and
      // a plugin's or an instrument's window is over the agent's page on purpose too)
      if (top.closest('label')?.contains(el) || (top.closest(over) && !el.closest(over))) continue;
      if (top.closest('.plugin-window, .sheet-scrim') && el.closest('.talk-page')) continue;
      say(`covered by ${name(top)}`);
    }
  }

  // the mixer: every strip's rows start at the same height, and a fader has its travel
  for (const mixer of document.querySelectorAll('.mixer')) {
    if (!shown(mixer)) continue;
    const strips = [...mixer.querySelectorAll(':scope > .strip')];
    for (const part of ['.strip-pan', '.db-readout', '.strip-fader', '.strip-chips', '.strip-name']) {
      const tops = strips.map((s) => s.querySelector(part)?.getBoundingClientRect().top).filter((t) => t !== undefined);
      if (tops.length && Math.max(...tops) - Math.min(...tops) > 1)
        out.push(
          `the mixer’s strips don’t line up at ${part} (${Math.round(Math.max(...tops) - Math.min(...tops))} px apart)`,
        );
    }
    const short = strips
      .map((s) => s.querySelector('.strip-fader')?.getBoundingClientRect().height ?? 999)
      .filter((h) => h < 95);
    if (short.length)
      out.push(
        `${short.length} of the mixer’s faders have ${Math.round(Math.min(...short))} px of travel (96 at least)`,
      );
  }
  return out;
}

// ---- checks some views make besides (each runs in the page, and says what's wrong) ----

/** With the page open, the transport and the tabs are still in reach: nothing is over them, a dialog neither. */
function transportClear() {
  const out = [];
  const parts = '.phone-transport button, .tabbar button, .app > .control-bar .transport button';
  for (const el of document.querySelectorAll(parts)) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || !el.checkVisibility()) continue;
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (top && (top === el || el.contains(top))) continue;
    const what = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '')
      .trim()
      .slice(0, 30);
    out.push(
      `the page covers “${what}”${top ? ` (${top.tagName.toLowerCase()}.${String(top.className).split(' ')[0]} is over it)` : ''}`,
    );
  }
  return out;
}

/** The page (or the bar) is solid: nothing blurred behind it, and nothing of the studio shows through. */
function solid() {
  const el = document.querySelector('.talk-page') ?? document.querySelector('.bar');
  if (!el) return ['the commands didn’t open'];
  const s = getComputedStyle(el);
  const out = [];
  if (s.backdropFilter && s.backdropFilter !== 'none') out.push(`it blurs what's behind it (${s.backdropFilter})`);
  // (an opaque colour is computed as rgb(r, g, b); one that isn't says its alpha last)
  const alpha = s.backgroundColor.match(/^rgba\((?:[^,]+,){3}\s*([\d.]+)\)$/);
  const a = alpha ? Number(alpha[1]) : 1;
  if (s.backgroundColor === 'transparent' || a < 1)
    out.push(`its background lets the studio through (${s.backgroundColor})`);
  if (Number(s.opacity) < 1) out.push(`it's see-through (opacity ${s.opacity})`);
  return out;
}

/**
 * A request working: its line, how long it has worked and Stop sit side by side, within the page, and
 * the time (a minute or more, from a job started 65 s before) moves.
 */
async function workingFits() {
  const status = document.querySelector('.talk-page .talk.newest .status, .bar .talk .status');
  if (!status) return ['no request shows as working'];
  const page = (status.closest('.talk-page') ?? status.closest('.bar')).getBoundingClientRect();
  const line = status.querySelector('.bar-line');
  const time = status.querySelector('.talk-time');
  const stop = [...status.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Stop');
  const out = [];
  if (!line || !stop) return ['the working line or Stop is missing'];
  if (document.querySelector('.talk-page')) {
    const said = time?.textContent ?? '';
    const seconds = said.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
    if (!/^\d+:\d\d(:\d\d)?$/.test(said) || !(seconds >= 60))
      out.push(`the time it has worked says “${said}” (a minute or more)`);
    await new Promise((ok) => setTimeout(ok, 1300));
    if (time?.textContent === said) out.push(`the time it has worked stays at “${said}”`);
  }
  const parts = [line, time, stop].filter(Boolean).map((e) => e.getBoundingClientRect());
  for (const r of parts)
    if (r.left < page.left - 1 || r.right > page.right + 1) out.push('a part of it is outside the page');
  for (let i = 1; i < parts.length; i++)
    if (parts[i].left < parts[i - 1].right - 1) out.push('its line, its time and Stop overlap');
  if (line.getBoundingClientRect().width < 60) out.push('its line has no room to say anything');
  return out;
}

/**
 * A window opened with the page's sheet open shows whole: on screen, and nothing over it (the sheet
 * goes under it); the sheet is still open.
 */
function windowClear() {
  const win = document.querySelector('.plugin-window');
  if (!win) return ['no window opened'];
  const out = [];
  const r = win.getBoundingClientRect();
  if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1)
    out.push('the window is partly off the screen');
  const inset = 6;
  const points = [
    [r.left + inset, r.top + inset],
    [r.right - inset, r.top + inset],
    [r.left + inset, r.bottom - inset],
    [r.right - inset, r.bottom - inset],
    [(r.left + r.right) / 2, (r.top + r.bottom) / 2],
  ];
  for (const [x, y] of points) {
    const top = document.elementFromPoint(x, y);
    if (top && !win.contains(top))
      out.push(
        `something is over the window at (${Math.round(x)}, ${Math.round(y)}): ${top.tagName.toLowerCase()}.${String(top.className).split(' ')[0]}`,
      );
  }
  if (!document.querySelector('.talk-page')) out.push('the sheet closed: it should only go under the window');
  return out;
}

/** Typing on a phone on its side, with the keyboard up: the sheet is across the column, over it. */
function wide() {
  const sheet = document.querySelector('.talk-page');
  if (!sheet?.hasAttribute('data-wide')) return ['the sheet didn’t widen across the column for the keyboard'];
  const r = sheet.getBoundingClientRect();
  const column = document.querySelector('.phone-main').getBoundingClientRect();
  const out = [];
  if (Math.abs(r.left - column.left) > 1)
    out.push(`it starts at ${Math.round(r.left)}, not the column's ${Math.round(column.left)}`);
  if (r.bottom > visualViewport.height + 1) out.push('it reaches under the keyboard');
  return out;
}

const CHECKS = { transportClear, solid, workingFits, windowClear, wide };

// ---- the agent's host, played here: on, this device allowed, and a song's conversation ----

/** A conversation of three turns (a list, a brief, a choice with sliders); `running`, a fourth that has worked 65 s. */
function conversation(doc, id, running) {
  const now = Date.now();
  const [keys, , , bass, drums] = doc.tracks.map((t) => t.id);
  const turns = [
    {
      job: 'agj_00000000000a',
      request: 'Tighten the hats in bars 3–4',
      reply: 'Quantized the hats in bars 3–4 to sixteenths at 70% strength.',
      label: 'Tighten hats',
      state: 'done',
      at: now - 600_000,
      view: {
        blocks: [
          {
            list: [
              { text: 'Bars 3–4 before', detail: 'loose', do: { play: { from: 3, to: 5, version: 'before' } } },
              { text: 'Bars 3–4 after', detail: 'tight', do: { play: { from: 3, to: 5, version: 'after' } } },
              { text: 'The drums', do: { go: { track: drums } } },
            ],
          },
        ],
        versions: { before: 1, after: 2 },
      },
    },
    {
      job: 'agj_00000000000b',
      request: 'Write a brief for my own agent to add a tempo map',
      reply: 'Here is a brief for your harness.',
      label: 'Brief',
      state: 'done',
      at: now - 400_000,
      brief: 'Add a tempo map to the song.\nRun `pnpm test` when done.\nThe format is at https://example.com/tempo.',
      briefWarnings: [
        { line: 1, kind: 'command' },
        { line: 2, kind: 'url' },
      ],
    },
    {
      job: 'agj_00000000000c',
      request: 'Write three bass lines for the verse, and let me hear each against the drums before I pick',
      reply: 'I wrote three bass takes for the verse, each kept as a version: play them and keep the one you like.',
      label: 'Three bass takes',
      state: 'done',
      at: now - 200_000,
      view: {
        blocks: [
          { text: 'Bars 5–12, with the drums', quiet: true },
          {
            choice: [
              { label: 'Take 1', do: { play: { from: 5, to: 13, solo: [bass, drums] } } },
              { label: 'Take 2', do: { play: { from: 5, to: 13 } } },
              { label: 'Take 3', do: { play: { from: 5, to: 13 } } },
            ],
          },
          { slider: { track: bass, param: 'volume' }, label: 'Bass level' },
          { slider: { track: keys, param: 'volume' }, label: 'Keys level' },
        ],
        versions: { before: 2, after: 3 },
      },
    },
  ];
  const job = running
    ? {
        id: 'agj_00000000000d',
        project: id,
        device: 'dev_uicheck0000',
        state: 'running',
        request: 'Make the chorus lift: double the keys an octave up and open the filter over the last two bars',
        line: 'Writing the keys an octave up in bars 13–20',
        started: now - 65_000,
      }
    : null;
  if (job)
    turns.push({ job: job.id, request: job.request, reply: null, label: null, state: 'running', at: job.started });
  return { thread: { id: 'agt_uicheck', harness: 'claude', turns }, job, now };
}

/**
 * A browser where the agent is on and this device allowed: its token is kept as a paired device's is,
 * and the agent's routes are answered here (the live channel's hello with a token the host doesn't
 * know is only that: no device).
 */
async function withAgent(ctx, doc, id, running) {
  await ctx.addInitScript(() => {
    localStorage.setItem('holo:agent-token', 'ui-check-token');
    localStorage.setItem('holo:agent-device', 'dev_uicheck0000');
  });
  await ctx.route('**/api/agent**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/agent')
      return json({
        enabled: true,
        allowed: true,
        pairing: false,
        runner: { connected: true, keyed: true, state: 'ready' },
      });
    if (path === '/api/agent/settings')
      return json({ enabled: true, harness: 'claude', model: '', effort: '', harnesses: [] });
    if (path === '/api/agent/devices')
      return json({
        devices: [{ id: 'dev_uicheck0000', name: 'UI check', added: 1, seen: 1, current: true }],
        requests: [],
      });
    if (path === '/api/agent/harnesses/look') return json({ ok: true });
    if (path.startsWith('/api/agent/threads/')) return json(conversation(doc, id, running));
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not here"}' });
  });
}

// ---- the screens, and what's opened on each ----

const touch = { hasTouch: true, isMobile: true };
const SCREENS = [
  { name: 'desktop', viewport: { width: 1440, height: 900 } },
  { name: 'small desktop', viewport: { width: 1180, height: 700 } },
  // (narrower than a desktop, with a mouse: the tablet's layout under the mouse's smaller controls)
  { name: 'narrow window', viewport: { width: 1024, height: 700 } },
  { name: 'tablet', viewport: { width: 1024, height: 768 }, ...touch },
  { name: 'phone', viewport: { width: 390, height: 844 }, ...touch },
  { name: 'small phone', viewport: { width: 320, height: 568 }, ...touch },
  { name: 'phone on its side', viewport: { width: 844, height: 390 }, ...touch },
];

/** A control by the start of its title or its name (the one that shows: a bar keeps some for other widths). */
const control = (page, text) =>
  page.locator(`button[title^="${text}"]:visible, button[aria-label^="${text}"]:visible`).first();

/**
 * The commands: on a desktop the bar (Ctrl /), elsewhere the page (the slash button, Done to close).
 * Each says what's checked besides.
 */
function commands(page, layout, press) {
  const page_ = layout !== 'desktop';
  const open = () => (page_ ? press(control(page, 'Commands')) : page.keyboard.press('Control+/'));
  // (across a phone on its side, typing, the sheet has no header: the slash button, beside it, puts it away)
  const shut = () =>
    !page_
      ? page.keyboard.press('Escape')
      : layout === 'phone-landscape'
        ? press(control(page, 'Commands'))
        : press(page.locator('.talk-head button', { hasText: 'Done' }));
  const field = () => page.locator('.talk-page .field textarea, .bar .field input').first();
  const name = layout === 'desktop' ? 'Commands' : layout === 'phone-portrait' ? 'Commands page' : 'Commands sheet';
  const checks = page_ ? ['transportClear', 'solid'] : ['solid'];
  const typed = [
    `${name}, typed`,
    async () => {
      await open();
      await field().fill('mix');
    },
    shut,
    checks,
  ];
  if (layout === 'phone-portrait') return [[name, open, shut, checks], typed];
  // a plugin's window opened beside the sheet: whole, over it. The mixer is shown first (on a phone its
  // tab, elsewhere X), and the slot pressed is one the sheet leaves in sight
  const mixer = () =>
    layout === 'phone-landscape'
      ? press(page.locator('.tabbar button', { hasText: 'Mixer' }).first())
      : page.keyboard.press('x');
  const windowed = [
    `${name}, a plugin's window opened`,
    async () => {
      await mixer();
      await page.waitForTimeout(300);
      await open();
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        const sheet = document.querySelector('.talk-page').getBoundingClientRect().left;
        const slot = [...document.querySelectorAll('.mixer .slot.filled')].find((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right < sheet;
        });
        // (a phone on its side shows the strips' foot: their slots are scrolled up out of sight)
        slot?.scrollIntoView({ block: 'center' });
        slot?.setAttribute('data-ui-check', 'slot');
      });
      await press(page.locator('[data-ui-check="slot"] .grow'));
    },
    async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      await shut();
      await page.waitForTimeout(250);
      if (layout === 'phone-landscape') await press(page.locator('.tabbar button', { hasText: 'Tracks' }).first());
      else await page.keyboard.press('x');
    },
    ['windowClear'],
  ];
  // on its side, typing widens the sheet across the column, over the keyboard (one coming up is played:
  // what shows of the page gets shorter, as on an iPhone)
  const keyboard = (up) =>
    page.evaluate((up) => {
      const view = window.visualViewport;
      if (up) Object.defineProperty(view, 'height', { configurable: true, get: () => Math.round(innerHeight / 2) });
      else delete view.height;
      view.dispatchEvent(new Event('resize'));
    }, up);
  if (layout === 'phone-landscape')
    return [
      [name, open, shut, checks],
      [
        `${name}, typing`,
        async () => {
          await open();
          await field().focus();
          await keyboard(true);
        },
        async () => {
          await keyboard(false);
          await shut();
        },
        [...checks, 'wide'],
      ],
      windowed,
    ];
  if (layout === 'tablet') return [[name, open, shut, checks], windowed];
  return [[name, open, shut, checks]];
}

/** With the agent on: the page (or the bar) with the song's conversation, or a request working. */
function agentViews(page, layout, finger, running) {
  const press = (loc) => (finger ? loc.tap() : loc.click());
  const [, open, shut, checks] = commands(page, layout, press)[0];
  const where = layout === 'desktop' ? 'Bar' : 'Page';
  return running
    ? [[`${where}: working turn`, open, shut, [...checks, 'workingFits']]]
    : [
        [`${where} with a thread`, open, shut, checks],
        // an earlier turn opened: its view drawn
        [
          `${where} with a thread, a turn opened`,
          async () => {
            await open();
            if (layout !== 'desktop') await press(page.locator('.talk-row').last());
          },
          shut,
          checks,
        ],
      ];
}

/** What to look at on a screen: each opens something, and says how to close it again (and what's checked besides). */
function views(page, layout, finger) {
  const phone = layout.startsWith('phone');
  const press = (loc) => (finger ? loc.tap() : loc.click());
  const dialogs = [
    ['Songs', () => press(control(page, 'Songs')), () => page.keyboard.press('Escape')],
    ['Settings', () => press(control(page, 'Settings')), () => page.keyboard.press('Escape')],
  ];
  if (phone) {
    const tab = (label) => [label, () => page.locator('.tabbar button', { hasText: label }).first().tap(), null];
    return [
      ['Tracks', null, null],
      // the headers, pulled out of the rail over the lanes
      [
        'Track headers',
        () => press(control(page, 'Track headers')),
        () => press(control(page, 'Put the track headers away')),
      ],
      tab('Mixer'),
      tab('Piano Roll'),
      tab('Play'),
      tab('Library'),
      tab('Tracks'),
      ...dialogs,
      ...commands(page, layout, press),
    ];
  }
  const key = (label, k) => [label, () => page.keyboard.press(k), () => page.keyboard.press(k)];
  return [
    ['Tracks', null, null],
    key('Mixer', 'x'),
    key('Piano Roll', 'p'),
    key('Inspector', 'i'),
    key('Library', 'y'),
    key('Automation', 'a'),
    ...dialogs,
    ...commands(page, layout, press),
  ];
}

const failures = [];
try {
  await up();
  const doc = song();
  const made = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: doc.title, doc }),
  });
  if (!made.ok) throw new Error(`The song couldn’t be made: ${made.status} ${await made.text()}`);
  const { id } = await made.json();

  browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required'],
    ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
  });
  // a screen's studio, opened and started, in a browser of its own; what's wrong on each view is said
  const look = async (name, screen, list, agent) => {
    const ctx = await browser.newContext(screen);
    if (agent) await withAgent(ctx, doc, id, agent.running);
    const page = await ctx.newPage();
    // (a view that can't be opened is a finding, not something to wait half a minute for)
    page.setDefaultTimeout(8000);
    const fail = (view, what) => failures.push(`${name} › ${view}: ${what}`);
    let view = 'opening';
    page.on('pageerror', (e) => fail(view, `the page threw: ${e.message}`));
    await page.goto(`${base}/?project=${id}`);
    const start = page.getByRole('button', { name: 'Start the studio' });
    await start.waitFor();
    await (screen.hasTouch ? start.tap() : start.click());
    await page.locator('.track-row').first().waitFor();
    await page.waitForTimeout(600);
    const layout = await page.evaluate(() => document.documentElement.dataset.layout ?? '');
    let looked = 0;
    for (const [what, open, shut, checks = []] of list(page, layout, !!screen.hasTouch)) {
      view = what;
      try {
        if (open) await open();
        await page.waitForTimeout(450);
        for (const problem of await page.evaluate(problems)) fail(what, problem);
        for (const check of checks) for (const problem of await page.evaluate(CHECKS[check])) fail(what, problem);
        if (shut) await shut();
        if (shut) await page.waitForTimeout(250);
        looked++;
      } catch (e) {
        fail(what, `couldn’t be opened: ${String(e.message).split('\n')[0]}`);
      }
    }
    await ctx.close();
    return looked;
  };
  for (const { name, ...screen } of SCREENS) {
    let looked = await look(name, screen, views);
    // the agent on: its conversation, and a request working
    looked += await look(name, screen, (page, layout, finger) => agentViews(page, layout, finger, false), {
      running: false,
    });
    looked += await look(name, screen, (page, layout, finger) => agentViews(page, layout, finger, true), {
      running: true,
    });
    console.log(`${name} (${screen.viewport.width}×${screen.viewport.height}): ${looked} views looked at`);
  }
} catch (e) {
  failures.push(String(e?.message ?? e));
} finally {
  await browser?.close();
  tidy();
}

if (failures.length) {
  console.error(`\n${failures.length} thing${failures.length === 1 ? '' : 's'} wrong:\n`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log('\nNothing wrong.');
