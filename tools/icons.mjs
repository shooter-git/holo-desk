// HO[LO] Desk's icons are a real frame of the studio, not a drawing: the Piano Roll in the dark, its
// notes lit by how hard they're played (a piano part, as HO[LO] draws it).
//
//   node tools/icons.mjs --capture [--song ID] [--track NAME] [--bar 5]
//     Draws the frame again from the dev servers (pnpm dev; HOLO_WEB_URL, default
//     http://localhost:47810) into tools/icons/frame.png. Needs Playwright: its index.mjs in
//     PLAYWRIGHT if it isn't installed here.
//   node tools/icons.mjs
//     Crops tools/icons/frame.png into apps/web/public/icons/. Needs ImageMagick (`convert`).
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const root = resolve(import.meta.dirname, '..');
const frame = join(root, 'tools/icons/frame.png');
const out = join(root, 'apps/web/public/icons');
mkdirSync(out, { recursive: true });
mkdirSync(join(root, 'tools/icons'), { recursive: true });

if (args.includes('--capture')) {
  const web = process.env.HOLO_WEB_URL ?? 'http://localhost:47810';
  const where = process.env.PLAYWRIGHT ?? 'playwright';
  const { chromium } = await import(where.startsWith('/') ? pathToFileURL(where).href : where);
  let song = opt('song');
  if (!song) {
    const rows = await (await fetch(`${web}/api/projects`)).json();
    song = (rows.find((r) => r.title === 'Night Window') ?? rows[0])?.id;
  }
  const trackName = opt('track', 'Piano');
  const bar = Number(opt('bar', '5'));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 760, height: 900 }, deviceScaleFactor: 2 });
  await page.addInitScript(() => {
    localStorage.setItem(
      'holo:view',
      JSON.stringify({
        editor: 'piano',
        editorHeight: 760,
        inspector: false,
        library: false,
        keyHeight: 11,
        pianoZoom: 70,
        follow: false,
        lane: 'velocity',
      }),
    );
  });
  // a link to the bar puts the playhead there; the Piano Roll opens around it, centred on its notes
  await page.goto(`${web}/?project=${song}&at=${bar}`);
  await page.getByText('Start the studio').click();
  await page
    .locator('.track-row')
    .filter({ has: page.locator('.name', { hasText: new RegExp(`^${trackName}$`) }) })
    .first()
    .dispatchEvent('pointerdown');
  const notes = page.locator('.roll .cell').nth(2);
  await notes.waitFor();
  await page.waitForTimeout(1500);
  const box = await notes.boundingBox();
  const side = Math.min(box.width, box.height);
  await page.screenshot({
    path: frame,
    clip: { x: box.x, y: box.y + (box.height - side) / 2, width: side, height: side },
  });
  await browser.close();
  console.log(`frame: ${frame}`);
}

const magick = (...a) => execFileSync('convert', a, { stdio: 'inherit' });
// a gentle lift so the dark frame still reads at 16 pixels
const base = [
  '-gravity',
  'center',
  '-crop',
  '64%x64%+0+0',
  '+repage',
  '-modulate',
  '112,118,100',
  '-sigmoidal-contrast',
  '3,40%',
];
const rounded = (size, radius, file) =>
  magick(
    frame,
    ...base,
    '-resize',
    `${size}x${size}^`,
    '-gravity',
    'center',
    '-extent',
    `${size}x${size}`,
    '(',
    '-size',
    `${size}x${size}`,
    'xc:none',
    '-fill',
    'white',
    '-draw',
    `roundrectangle 0,0,${size - 1},${size - 1},${radius},${radius}`,
    ')',
    '-compose',
    'DstIn',
    '-composite',
    join(out, file),
  );
const square = (size, file) =>
  magick(
    frame,
    ...base,
    '-resize',
    `${size}x${size}^`,
    '-gravity',
    'center',
    '-extent',
    `${size}x${size}`,
    join(out, file),
  );

rounded(512, 112, 'icon-512.png');
rounded(192, 42, 'icon-192.png');
rounded(64, 14, 'favicon.png');
square(512, 'maskable-512.png');
square(180, 'apple-touch-icon.png');
console.log(`icons: ${out}`);
