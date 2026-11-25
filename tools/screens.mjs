// The README's pictures: real frames of the studio playing HO[LO]'s own demo song ("Night Window",
// put in the studio by tools/demo-song.mjs), at a desktop's size and a phone's, and HO[LO] Remote on a
// phone driving it. Nothing in them is drawn by hand.
//
//   node tools/demo-song.mjs && node tools/screens.mjs
//
// Writes docs/images/{studio,score,mixer,phone,remote}.jpg (then `pnpm banner` makes the banner from
// studio.jpg). Needs Playwright (its index.mjs in PLAYWRIGHT if it isn't installed here;
// PLAYWRIGHT_CHROMIUM, a Chromium already on the machine) and ImageMagick's `convert`. HOLO_WEB_URL
// is the studio (default http://127.0.0.1:47800), with the packs the demo song plays installed
// (`pnpm packs install vsco2 vcsl meatbass iowa`).
//
// The agent's pictures (agent.jpg, phone-agent.jpg) are of a real request and its real reply, so they
// need the agent on and a device allowed: HOLO_AGENT_PAIR names a file holding what POST
// /api/agent/pair answered ({token, device}). When the song has no conversation yet, the request
// below is asked in the studio's bar and waited for (a minute or so, on the harness chosen in
// Settings › Agent); the reply is the agent's own, so it isn't the same twice. Without
// HOLO_AGENT_PAIR those two pictures are left as they are.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUEST =
  'The theme in bars 5 to 8 feels a little bare. Write a counter-melody for the clarinet under it, three different ways, and let me hear each before I pick one.';

const root = resolve(import.meta.dirname, '..');
const web = (process.env.HOLO_WEB_URL ?? 'http://127.0.0.1:47800').replace(/\/$/, '');
const where = process.env.PLAYWRIGHT ?? 'playwright';
const { chromium } = await import(where.startsWith('/') ? pathToFileURL(where).href : where);
const pair = process.env.HOLO_AGENT_PAIR ? JSON.parse(readFileSync(process.env.HOLO_AGENT_PAIR, 'utf8')) : null;
const songs = await (await fetch(`${web}/api/projects`)).json();
const song = songs.find((r) => r.title === 'Night Window')?.id;
if (!song) throw new Error('No "Night Window" in the studio: run node tools/demo-song.mjs first');
const shots = mkdtempSync(join(tmpdir(), 'holo-screens-'));
const images = join(root, 'docs/images');
const magick = (...a) => execFileSync('convert', a, { stdio: 'inherit' });

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
  ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
});
/** A device with the studio (or `path`) open, remembering `view`; `allowed`, as a device the agent knows. */
const open = async (opts, view, { path = `/?project=${song}&at=5`, allowed = false } = {}) => {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.addInitScript(
    ([v, p]) => {
      localStorage.setItem('holo:view', JSON.stringify(v));
      if (p) {
        localStorage.setItem('holo:agent-token', p.token);
        localStorage.setItem('holo:agent-device', p.device.id);
      }
    },
    [view, allowed ? pair : null],
  );
  await page.goto(`${web}${path}`);
  await page.waitForTimeout(800);
  return { ctx, page };
};
/** Start the studio and wait until every sound of the song has loaded. */
const start = async (page) => {
  await page.getByText('Start the studio').click();
  await page.waitForTimeout(1000);
  await page
    .getByText(/to load/i)
    .first()
    .waitFor({ state: 'hidden', timeout: 120_000 });
  await page.waitForTimeout(500);
};
const shoot = (page, name) => page.screenshot({ path: join(shots, `${name}.png`) });
const desk = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

// the studio, playing the theme on the piano
const s = await open(desk, {
  inspector: true,
  editor: 'piano',
  noteView: 'roll',
  editorHeight: 380,
  keyHeight: 7,
  zoom: 60,
  deviceName: 'Studio',
});
await start(s.page);
await s.page.locator('.track-row').first().click();
await s.page.keyboard.press('Space');
await s.page.waitForTimeout(2600);
await shoot(s.page, 'studio');

// HO[LO] Remote on a phone, driving that studio while it plays
const r = await open(phone, {}, { path: '/remote' });
const picker = r.page.locator('.remote-bar select');
if (await picker.count()) await picker.selectOption('Studio');
await r.page.waitForTimeout(1500);
await shoot(r.page, 'remote-tracks');
await r.page.getByText('Mixer').tap();
await r.page.waitForTimeout(1200);
await shoot(r.page, 'remote-mixer');
await r.page.getByText('Markers').tap();
await r.page.waitForTimeout(600);
await shoot(r.page, 'remote-markers');
await s.page.keyboard.press('Space');
await r.ctx.close();
await s.ctx.close();

// the whole song as a score
const c = await open(desk, {
  inspector: false,
  editor: 'piano',
  noteView: 'score',
  scoreAll: true,
  editorHeight: 560,
  zoom: 60,
  deviceName: 'Studio',
});
await start(c.page);
await c.page.waitForTimeout(1500);
await shoot(c.page, 'score');
await c.ctx.close();

// the mixer while the song plays, the piano's compressor open, and a palette of sounds in the Library
const m = await open(desk, {
  inspector: false,
  library: true,
  editor: 'mixer',
  editorHeight: 470,
  zoom: 60,
  deviceName: 'Studio',
});
await start(m.page);
await m.page.locator('.track-row').first().click();
await m.page.getByText('Classic Symphonic').click();
await m.page.locator('.mixer .slot', { hasText: 'Comp' }).first().click();
await m.page.waitForTimeout(600);
await m.page.keyboard.press('Space');
await m.page.waitForTimeout(3000);
await shoot(m.page, 'mixer');
await m.page.keyboard.press('Space');
await m.ctx.close();

// the studio itself on a phone: the tracks, the Piano Roll and the keyboard
for (const tab of ['tracks', 'editor', 'play']) {
  const p = await open(phone, { mobileTab: tab, noteView: 'roll', deviceName: 'Phone' });
  await start(p.page);
  await shoot(p.page, `phone-${tab}`);
  await p.ctx.close();
}

// the agent: a request in the desktop's dock and its reply, then the same conversation on a phone
if (pair) {
  const thread = async () =>
    (await fetch(`${web}/api/agent/threads/${song}`, { headers: { authorization: `Bearer ${pair.token}` } })).json();
  const a = await open(
    desk,
    {
      inspector: true,
      editor: 'piano',
      noteView: 'roll',
      editorHeight: 380,
      keyHeight: 7,
      zoom: 60,
      deviceName: 'Studio',
    },
    { allowed: true },
  );
  await start(a.page);
  await a.page.locator('.track-row', { hasText: 'Clarinet' }).click();
  await a.page.keyboard.press('Control+/');
  await a.page.waitForTimeout(600);
  if (!(await thread()).thread?.turns.length) {
    await a.page.keyboard.type(REQUEST, { delay: 5 });
    await a.page.keyboard.press('Enter');
    const asked = Date.now();
    for (;;) {
      await a.page.waitForTimeout(5000);
      const t = await thread();
      if (!t.job && t.thread?.turns.at(-1)?.state !== 'running') break;
      if (t.job && t.job.state !== 'running') throw new Error(`The agent stopped: ${JSON.stringify(t.job)}`);
      if (Date.now() - asked > 30 * 60_000) throw new Error('The agent has not answered in 30 minutes');
    }
    await a.page.waitForTimeout(3000);
  }
  await a.page.locator('.talk-page .agent-view').first().waitFor();
  // (the caret out of the picture)
  await a.page.evaluate(() => document.activeElement?.blur?.());
  await a.page.waitForTimeout(500);
  await shoot(a.page, 'agent');
  await a.ctx.close();

  // on a phone: the page with the conversation, then its reply's controls kept above the transport
  const p = await open(phone, { mobileTab: 'tracks', deviceName: 'Phone' }, { allowed: true });
  await start(p.page);
  await p.page.locator('.cb-bar').tap();
  await p.page.locator('.talk-room .agent-view').first().waitFor();
  await p.page.waitForTimeout(1000);
  await shoot(p.page, 'phone-page');
  await p.page.locator('.cb-bar').tap();
  await p.page.waitForTimeout(1200);
  await shoot(p.page, 'phone-tray');
  await p.ctx.close();
}
await browser.close();

// into the README's JPEGs: phone screens side by side, with a little room between them
const jpeg = ['-strip', '-quality', '84', '-sampling-factor', '4:2:0'];
const beside = (names, out) =>
  magick(
    ...names.flatMap((n, i) => [
      ...(i ? ['(', '-size', '24x1200', 'xc:#0b0d10', ')'] : []),
      '(',
      join(shots, `${n}.png`),
      '-resize',
      'x1200',
      ')',
    ]),
    '+append',
    ...jpeg,
    join(images, out),
  );
for (const name of ['studio', 'score', 'mixer', ...(pair ? ['agent'] : [])])
  magick(join(shots, `${name}.png`), ...jpeg, join(images, `${name}.jpg`));
beside(['phone-tracks', 'phone-editor', 'phone-play'], 'phone.jpg');
beside(['remote-tracks', 'remote-mixer', 'remote-markers'], 'remote.jpg');
if (pair) beside(['phone-page', 'phone-tray'], 'phone-agent.jpg');
rmSync(shots, { recursive: true, force: true });
console.log(`docs/images: studio, score, mixer, phone, remote${pair ? ', agent, phone-agent' : ''} (from "${song}")`);
