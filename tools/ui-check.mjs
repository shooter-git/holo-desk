// `pnpm ui:check`: the studio's layout, looked at in a real browser at a desktop's size, a tablet's
// and a phone's (upright and on its side). It opens every main view and the two big dialogs, and
// fails when:
//
//   - the page itself scrolls (something is wider or taller than the screen);
//   - a control can't be reached: cut off by its pane with no scroll that would bring it in;
//   - a control is covered by something that isn't a menu, a dialog or a window;
//   - the mixer's strips don't line up (pan, level, fader, buttons and name start at the same
//     height on every strip), or a fader has less than its least travel;
//   - the page throws.
//
// It starts a studio of its own (a server on a free port, a data folder that's removed after) with a
// small song made here, on the built-in synths, so nothing is fetched and nobody's songs are touched.
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
  const over = '[role=dialog], [role=menu], .view-menu, .scrim, .toast, .banner, .overlay-panel';
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
      // (a label is its field's; what's over the studio on purpose isn't a fault of what's under it)
      if (top.closest('label')?.contains(el) || (top.closest(over) && !el.closest(over))) continue;
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

/** What to look at on a screen: each opens something, and says how to close it again. */
function views(page, phone, finger) {
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
  for (const { name, ...screen } of SCREENS) {
    const ctx = await browser.newContext(screen);
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
    const phone = (await page.evaluate(() => document.documentElement.dataset.layout ?? '')).startsWith('phone');
    let looked = 0;
    for (const [label, open, shut] of views(page, phone, !!screen.hasTouch)) {
      view = label;
      try {
        if (open) await open();
        await page.waitForTimeout(450);
        for (const what of await page.evaluate(problems)) fail(label, what);
        if (shut) await shut();
        if (shut) await page.waitForTimeout(250);
        looked++;
      } catch (e) {
        fail(label, `couldn’t be opened: ${String(e.message).split('\n')[0]}`);
      }
    }
    console.log(`${name} (${screen.viewport.width}×${screen.viewport.height}): ${looked} views looked at`);
    await ctx.close();
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
