// The README's pictures: real frames of the studio playing HO[LO]'s own demo song ("Night Window",
// put in the studio by tools/demo-song.mjs), at a desktop's size and a phone's, and HO[LO] Remote on a
// phone driving it. Nothing in them is drawn by hand.
//
//   node tools/demo-song.mjs && node tools/screens.mjs
//
// Writes docs/images/{studio,mixer,phone,phone-landscape,remote}.jpg (then `pnpm banner` makes the
// banner from studio.jpg). Needs Playwright (its index.mjs in PLAYWRIGHT if it isn't installed here)
// and ImageMagick's `convert`. HOLO_WEB_URL is the studio (default http://127.0.0.1:47800).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const web = (process.env.HOLO_WEB_URL ?? 'http://127.0.0.1:47800').replace(/\/$/, '');
const where = process.env.PLAYWRIGHT ?? 'playwright';
const { chromium } = await import(where.startsWith('/') ? pathToFileURL(where).href : where);
const songs = await (await fetch(`${web}/api/projects`)).json();
const song = songs.find((r) => r.title === 'Night Window')?.id;
if (!song) throw new Error('No "Night Window" in the studio: run node tools/demo-song.mjs first');
const shots = mkdtempSync(join(tmpdir(), 'holo-screens-'));
const images = join(root, 'docs/images');
const magick = (...a) => execFileSync('convert', a, { stdio: 'inherit' });

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const open = async (opts, view, path = `/?project=${song}&at=5`) => {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.addInitScript((v) => localStorage.setItem('holo:view', JSON.stringify(v)), view);
  await page.goto(`${web}${path}`);
  await page.waitForTimeout(800);
  return { ctx, page };
};
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

// the studio, playing the theme on the piano
const s = await open(
  { viewport: { width: 1440, height: 900 } },
  { inspector: true, editor: 'piano', editorHeight: 380, keyHeight: 7, zoom: 60, deviceName: 'Studio' },
);
await s.page.getByText('Start the studio').click();
await s.page.waitForTimeout(1500);
await s.page.locator('.track-row').first().click();
await s.page.keyboard.press('Space');
await s.page.waitForTimeout(2600);
await s.page.screenshot({ path: join(shots, 'studio.png') });
await s.page.keyboard.press('x');
await s.page.waitForTimeout(500);
await s.page.screenshot({ path: join(shots, 'mixer.png') });

// HO[LO] Remote on a phone, driving that studio while it plays
const r = await open(phone, {}, '/remote');
const picker = r.page.locator('.remote-bar select');
if (await picker.count()) await picker.selectOption('Studio');
await r.page.waitForTimeout(1500);
await r.page.screenshot({ path: join(shots, 'remote-tracks.png') });
await r.page.getByText('Mixer').tap();
await r.page.waitForTimeout(1200);
await r.page.screenshot({ path: join(shots, 'remote-mixer.png') });
await r.page.getByText('Markers').tap();
await r.page.waitForTimeout(600);
await r.page.screenshot({ path: join(shots, 'remote-markers.png') });
await s.page.keyboard.press('Space');

// the studio itself on a phone: the Piano Roll, the mixer and the keyboard, then on its side
for (const tab of ['editor', 'mixer', 'play']) {
  const p = await open(phone, { mobileTab: tab, deviceName: 'Phone' });
  await p.page.getByText('Start the studio').click();
  await p.page.waitForTimeout(1500);
  await p.page.screenshot({ path: join(shots, `phone-${tab}.png`) });
  await p.ctx.close();
}
const l = await open(
  { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { mobileTab: 'tracks', deviceName: 'Phone' },
);
await l.page.getByText('Start the studio').click();
await l.page.waitForTimeout(1500);
await l.page.screenshot({ path: join(shots, 'phone-landscape.png') });
await browser.close();

// into the README's JPEGs: three phone screens side by side, at the height the README shows them
const jpeg = ['-strip', '-quality', '86', '-sampling-factor', '4:2:0'];
const three = (names, out) =>
  magick(...names.map((n) => join(shots, `${n}.png`)), '-resize', 'x913', '+append', ...jpeg, join(images, out));
magick(join(shots, 'studio.png'), ...jpeg, join(images, 'studio.jpg'));
magick(join(shots, 'mixer.png'), ...jpeg, join(images, 'mixer.jpg'));
three(['phone-editor', 'phone-mixer', 'phone-play'], 'phone.jpg');
three(['remote-tracks', 'remote-mixer', 'remote-markers'], 'remote.jpg');
magick(join(shots, 'phone-landscape.png'), '-resize', '844x390', ...jpeg, join(images, 'phone-landscape.jpg'));
rmSync(shots, { recursive: true, force: true });
console.log(`docs/images: studio, mixer, phone, phone-landscape, remote (from "${song}")`);
