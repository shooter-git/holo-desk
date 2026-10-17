// The README's banner: a real frame of the studio (docs/images/studio.jpg, as HO[LO] draws it), dimmed
// to one side, with the name set over it in the studio's own typeface. Nothing in it is drawn by hand.
//
//   node tools/banner.mjs        writes docs/images/banner.jpg (needs Playwright: its index.mjs in
//                                PLAYWRIGHT if it isn't installed here, and ImageMagick's `convert`)
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const where = process.env.PLAYWRIGHT ?? 'playwright';
const { chromium } = await import(where.startsWith('/') ? pathToFileURL(where).href : where);
const data = (path, type) => `data:${type};base64,${readFileSync(join(root, path)).toString('base64')}`;

const frame = data('docs/images/studio.jpg', 'image/jpeg');
const icon = data('apps/web/public/icons/icon-512.png', 'image/png');
const inter = data(
  'apps/web/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  'font/woff2',
);

const html = `<!doctype html><html><head><style>
@font-face { font-family: Inter; src: url(${inter}) format('woff2'); font-weight: 100 900; }
html, body { margin: 0; }
.banner { position: relative; width: 1600px; height: 520px; overflow: hidden; background: #0b0d10; font-family: Inter, sans-serif; }
.frame { position: absolute; inset: -40px -40px -40px 520px; background: url(${frame}) center / cover; filter: saturate(1.05); }
.shade { position: absolute; inset: 0; background:
  linear-gradient(90deg, #0b0d10 0%, #0b0d10 30%, rgba(11,13,16,0.86) 46%, rgba(11,13,16,0.35) 72%, rgba(11,13,16,0.15) 100%),
  linear-gradient(0deg, rgba(11,13,16,0.6), transparent 40%); }
.text { position: absolute; left: 96px; top: 50%; transform: translateY(-50%); display: grid; gap: 22px; }
.icon { width: 88px; height: 88px; border-radius: 20px; box-shadow: 0 0 0 1px rgba(255,255,255,0.07), 0 14px 40px rgba(0,0,0,0.6); }
.name { display: flex; align-items: baseline; font-size: 84px; font-weight: 800; letter-spacing: 0.1em; line-height: 1; color: #e4e8ef; white-space: nowrap; }
.ho, .lo { margin-right: -0.1em; }
.lo { color: #6d7584; }
.br { color: #5cb8ff; font-weight: 300; letter-spacing: 0; margin: 0 0.05em; }
.desk { margin-left: 0.42em; color: #a9b1be; font-weight: 500; letter-spacing: 0.01em; }
.what { font-size: 28px; color: #e4e8ef; font-weight: 450; }
.tag { font-size: 15px; color: #6d7584; font-weight: 600; letter-spacing: 0.24em; text-transform: uppercase; }
</style></head><body><div class="banner">
<div class="frame"></div><div class="shade"></div>
<div class="text">
  <img class="icon" src="${icon}" alt="">
  <div class="name"><span class="ho">HO</span><span class="br">[</span><span class="lo">LO</span><span class="br">]</span><span class="desk">Desk</span></div>
  <div class="what">A studio for writing, recording and mixing music</div>
  <div class="tag">Headphones On [Lights Out]</div>
</div></div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 520 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
const png = join(tmpdir(), 'holo-banner.png');
await page.locator('.banner').screenshot({ path: png });
await browser.close();
execFileSync('convert', [png, '-strip', '-quality', '88', join(root, 'docs/images/banner.jpg')]);
rmSync(png);
console.log('docs/images/banner.jpg');
