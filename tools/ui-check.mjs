// `pnpm ui:check`: the studio's layout, looked at in a real browser at a desktop's size, a tablet's
// and a phone's (upright and on its side). It opens every main view, the two big dialogs and the
// commands (the bar on a desktop, the agent's page elsewhere, and on a desktop with the agent on, where
// it's a dock beside the studio: with the agent off, and with it on and a conversation to show), and
// Settings › Agent with the agent on, and fails when:
//
//   - the page itself scrolls (something is wider or taller than the screen);
//   - a control can't be reached: cut off by its pane with no scroll that would bring it in;
//   - a control is covered by something that isn't a menu, a dialog or a window;
//   - undo and redo show more than once (the control bar's pair and an editor's own, side by side);
//   - the mixer's strips don't line up (pan, level, fader, buttons and name start at the same
//     height on every strip), or a fader has less than its least travel;
//   - with the page open, the transport or the tabs are covered (no dialog excuses it), or the page
//     lets the studio show through (it's solid: no blur, nothing see-through);
//   - a desktop's dock, in a window wide enough for the studio to give it the room, is over the studio
//     (or the studio hasn't taken the room back once it's closed);
//   - a request's working line, its time and Stop don't fit beside each other;
//   - a reply's view (or its dock) isn't laid out whole: a control runs past the view's edge (where
//     nothing scrolls it in), two controls are over each other, or a control's words don't fit in it
//     (crammed, cut off or ellipsized), a slider's or a list's words included. Besides the song's
//     conversation, two replies are looked at on their own: one comparing takes (choices of four and
//     three long-ish labels, each with a row of three buttons) and one with everything at once (a
//     choice of six, five long buttons, a table of six columns, long-named sliders, toggles, a list, a
//     chart, notes, a waveform, a group in a group);
//   - a reply's view is measured and laid out again while one of its sliders moves (it's laid out when
//     what it shows changes, or its width: not each time the page renders again);
//   - Settings › Agent's Tell me outside HO[LO] isn't whole: its three choices side by side, in the dialog;
//   - with a reply that has a dock read and the page closed, a phone shows no tray, or one that isn't a
//     row of its own (or × leaves it there); a tablet or a desktop shows one;
//   - Songs' open song's bounces, folded under its row or opened with a delete asked, aren't whole, or Keep
//     doesn't bring the bounce back;
//   - the Arrangement and Chords lanes, switched on in Settings › View, cut a control off or don't go when
//     switched off again;
//   - Scan's list of a song's earlier scans, a delete asked, isn't whole, or Keep doesn't bring the scan back;
//   - a scan's review (Scan, over the whole studio) isn't whole, or its header's Commands button can't
//     be pressed; the commands opened from it don't come up over the review, under its header; Escape
//     closes the review instead of them; or, with the agent on, they don't offer to read the scan;
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
import { crc32, deflateSync } from 'node:zlib';
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
  // (the recognition engines off: nothing is fetched, and a scan's review says they're off)
  env: {
    ...process.env,
    HOLO_PORT: String(port),
    HOLO_HOST: '127.0.0.1',
    HOLO_DATA_DIR: data,
    HOLO_WEB_DIR: built,
    HOLO_OMR_URL: '',
  },
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

// ---- a scan of a page, its two systems not read yet ----

/** A grey picture `w` × `h` as a PNG (no library: a stored row of each, deflated). */
function png(w, h) {
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const rows = Buffer.alloc((w + 1) * h, 0xe8);
  for (let y = 0; y < h; y++) rows[y * (w + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function makeScan(project) {
  const call = async (method, path, body, type = 'application/json') => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': type },
      body: type === 'application/json' ? JSON.stringify(body) : body,
    });
    if (!res.ok) throw new Error(`The scan couldn’t be made (${path}): ${res.status} ${await res.text()}`);
    return res.json();
  };
  const scan = await call('POST', '/api/scans', { project, title: 'Hymn, page 1' });
  await call('PUT', `/api/scans/${scan.id}/pages/0`, png(1200, 800), 'image/png');
  for (const k of [0, 1]) await call('PUT', `/api/scans/${scan.id}/strips/0/${k}`, png(1200, 160), 'image/png');
  const system = (k) => ({
    k,
    top: k * 400,
    bottom: k * 400 + 400,
    left: 40,
    right: 1160,
    staves: 2,
    bars: [40, 600, 1160],
    state: 'new',
  });
  await call('PUT', `/api/scans/${scan.id}`, {
    ...scan,
    pages: [{ n: 0, w: 1200, h: 800, type: 'png', systems: [system(0), system(1)] }],
  });
}

// ---- the song's bounces: four, so three show and the rest are asked for ----

/** A quarter of a second of silence as a WAV (16-bit, two channels, 48 kHz). */
function wav() {
  const frames = 12000;
  const b = Buffer.alloc(44 + frames * 4);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + frames * 4, 4);
  b.write('WAVEfmt ', 8, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(48000, 24);
  b.writeUInt32LE(48000 * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(frames * 4, 40);
  return b;
}

async function makeBounces(project) {
  // (names of their own: bounces made in the same second under one name are one file)
  for (const name of ['Layout check', 'Layout check (cycle)', 'Layout check with a longer name than most', 'Take 4']) {
    const res = await fetch(`${base}/api/projects/${project}/bounces?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: wav(),
    });
    if (!res.ok) throw new Error(`The bounce couldn’t be made: ${res.status} ${await res.text()}`);
  }
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
      // (the splitter under the tracks answers a little past its edge, so the foot of the row that
      // meets it is under that: the tracks scroll it clear, with room to spare past the last of them)
      if (top.closest('.splitter') && el.closest('.track-list')) continue;
      // (and the commands are over a scan's review on purpose, opened from its header)
      if (top.closest('.bar-scrim, .talk-room') && el.closest('.scan-window')) continue;
      say(`covered by ${name(top)}`);
    }
  }

  // undo and redo: one pair on screen, the control bar's or (where that has none) the editor's own
  const undos = [...document.querySelectorAll('button[aria-label="Undo"]')].filter(shown);
  if (undos.length > 1) out.push(`undo and redo are on screen ${undos.length} times: ${undos.map(name).join(', ')}`);

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

/**
 * A desktop's dock is beside the studio where the window is wide enough for the studio to give it the
 * room (styles/app.css: 1360 px), not over it: the studio ends where the dock begins.
 */
function dockBeside() {
  const dock = document.querySelector('.talk-page')?.getBoundingClientRect();
  const studio = document.querySelector('.app-body')?.getBoundingClientRect();
  if (!dock || !studio) return ['the dock didn’t open'];
  if (innerWidth < 1360) return [];
  return Math.abs(studio.right - dock.left) > 1
    ? [`the dock begins at ${Math.round(dock.left)} px and the studio ends at ${Math.round(studio.right)} px`]
    : [];
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

/**
 * Settings › Agent's Tell me outside HO[LO]: its three choices whole and side by side, and what's said
 * under them, inside the dialog.
 */
function noticesFit() {
  const row = document.querySelector('.agent-notices');
  if (!row) return ['Tell me outside HO[LO] isn’t in Settings › Agent'];
  const box = (row.closest('.content') ?? document.documentElement).getBoundingClientRect();
  const buttons = [...row.querySelectorAll('.seg .btn')];
  const out = [];
  if (buttons.map((b) => b.textContent.trim()).join(', ') !== 'Off, Long runs, Every reply')
    out.push(`its choices are ${buttons.map((b) => `“${b.textContent.trim()}”`).join(', ')}`);
  if (new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size > 1)
    out.push('its choices aren’t side by side');
  for (const el of [...buttons, ...row.querySelectorAll('.muted')]) {
    const r = el.getBoundingClientRect();
    const what = el.textContent.trim().slice(0, 30);
    if (el.scrollWidth > el.clientWidth + 1) out.push(`“${what}” is cut off`);
    if (r.left < box.left - 1 || r.right > box.right + 1) out.push(`“${what}” runs past the dialog`);
  }
  if (!row.querySelector('.seg .btn.on')) out.push('none of its choices shows as chosen');
  return out;
}

/**
 * A reply with a dock read, the page closed: on a phone its row waits in the studio, one row of its own
 * on the screen (the view ends above it; held upright, the transport starts below it), with × and ^.
 */
function tray() {
  const el = document.querySelector('.tray');
  if (!el) return ['no tray once a reply with a dock was read and the page closed'];
  const out = [];
  const r = el.getBoundingClientRect();
  if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1)
    out.push('the tray is partly off the screen');
  if (r.height > 52) out.push(`the tray is ${Math.round(r.height)} px tall: more than a row`);
  const view = document.querySelector('.phone-view')?.getBoundingClientRect();
  if (view && view.bottom > r.top + 1) out.push('the view reaches under the tray');
  const transport = document.querySelector('.phone-dock .phone-transport')?.getBoundingClientRect();
  if (transport && transport.top < r.bottom - 1) out.push('the tray reaches over the transport');
  const controls = [...el.querySelectorAll('.dock-view .btn')];
  if (controls.length < 2) out.push(`the tray shows ${controls.length} of the dock's controls`);
  const tops = controls.map((b) => b.getBoundingClientRect().top);
  if (tops.length && Math.max(...tops) - Math.min(...tops) > 1) out.push('the dock’s controls aren’t in one row');
  for (const name of ['Put this away', 'Open the conversation'])
    if (!el.querySelector(`button[aria-label="${name}"]`)) out.push(`the tray has no “${name}”`);
  return out;
}

/** No tray: put away, or not a phone (a tablet's sheet, or a desktop's bar or dock, stays open beside the studio). */
function noTray() {
  return document.querySelector('.tray') ? ['a tray shows'] : [];
}

/**
 * A reply's view (and a dock) laid out whole: every control inside the view, or in a box of it that
 * scrolls (a table), no two over each other, and each control's words whole inside it: none spilling
 * past its edge, none cut off or ellipsized (a slider's name and a list's rows too).
 */
function viewFits() {
  const out = [];
  const said = new Set();
  const say = (line) => {
    if (!said.has(line)) out.push(line);
    said.add(line);
  };
  const words = (el) =>
    (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 36);
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.checkVisibility({ visibilityProperty: true });
  };
  // a box between the control and the view that scrolls sideways (a table does; a choice must not)
  const scrolled = (el, view) => {
    for (let e = el.parentElement; e && e !== view; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (/auto|scroll/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 1) return e;
    }
    return null;
  };
  for (const view of document.querySelectorAll('.convo .agent-view, .convo .dock-view')) {
    if (!shown(view)) continue;
    // (its box, padding included: a list's rows reach into it on purpose, their words in line with the rest)
    const { left, right } = view.getBoundingClientRect();
    const controls = [...view.querySelectorAll('button, input, select, textarea')].filter(shown);
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      const box = scrolled(el, view);
      if (box && !box.matches('.v-table')) say(`a box scrolls sideways to show “${words(el)}”: ${box.className}`);
      else if (!box && (r.left < left - 1 || r.right > right + 1))
        say(
          `“${words(el)}” runs past the reply's view (${Math.round(r.left - left)} to ${Math.round(r.right - right)} px)`,
        );
      // its words (and icon): all of what it holds, inside its own box
      const range = document.createRange();
      range.selectNodeContents(el);
      const w = range.getBoundingClientRect();
      if (w.width > 0 && (w.left < r.left - 1 || w.right > r.right + 1 || w.top < r.top - 1 || w.bottom > r.bottom + 1))
        say(
          `the words of “${words(el)}” run past it (${Math.round(w.width)} px of words in ${Math.round(r.width)} px)`,
        );
    }
    // words a box hides: ellipsized, or clipped by it
    for (const el of view.querySelectorAll('span, div')) {
      const st = getComputedStyle(el);
      if (st.overflowX === 'visible' || !shown(el) || el.matches('.v-table, .seg')) continue;
      if (el.scrollWidth > el.clientWidth + 1)
        say(`“${words(el)}” is cut off (${el.scrollWidth} px in ${el.clientWidth})`);
    }
    for (let i = 0; i < controls.length; i++)
      for (let j = i + 1; j < controls.length; j++) {
        const [a, b] = [controls[i], controls[j]];
        if (a.contains(b) || b.contains(a)) continue;
        const p = a.getBoundingClientRect();
        const q = b.getBoundingClientRect();
        const x = Math.min(p.right, q.right) - Math.max(p.left, q.left);
        const y = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
        if (x > 1 && y > 1) say(`“${words(a)}” and “${words(b)}” are over each other`);
      }
  }
  return out;
}

/**
 * A reply's view is laid out again only when what it shows changes, or its width: not each time the page
 * renders again. Moving one of its sliders (the song changes, the page renders again with it) lays out
 * nothing (ui/view-fit.ts marks each time it measures with data-measuring).
 */
async function fitsOnce() {
  const view = document.querySelector('.talk.newest .agent-view, .bar .talk .agent-view');
  const slider = view?.querySelector('.v-slider input');
  if (!slider) return ['the newest reply has no slider to move'];
  let passes = 0;
  const count = (records) => {
    for (const r of records) if (r.oldValue === null) passes++;
  };
  const watch = new MutationObserver(count);
  watch.observe(view, { attributes: true, attributeFilter: ['data-measuring'], attributeOldValue: true });
  const was = slider.value;
  slider.focus();
  for (let i = 0; i < 5; i++) {
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    await new Promise((ok) => requestAnimationFrame(() => setTimeout(ok, 30)));
  }
  // (and the gesture ends, after its idle time)
  await new Promise((ok) => setTimeout(ok, 500));
  count(watch.takeRecords());
  watch.disconnect();
  slider.blur();
  const out = [];
  if (slider.value === was) out.push('the reply’s slider didn’t move');
  if (passes) out.push(`moving a reply’s slider laid its view out again ${passes} times`);
  return out;
}

/**
 * The page's conversation in its room: it starts under the header, with nothing left blank over it; an
 * earlier turn shown on more than a line never makes it longer than the page; and a phone held upright
 * has a grip for a header (the song's name and the way to close it are in the control bar), a sheet Done.
 */
function threadRoom() {
  const page = document.querySelector('.talk-page');
  const thread = page?.querySelector('.talk-thread');
  const body = thread?.firstElementChild;
  if (!page || !thread || !body) return [];
  const out = [];
  const scrolls = thread.scrollHeight > thread.clientHeight + 1;
  const over = body.getBoundingClientRect().top - thread.getBoundingClientRect().top;
  if (!scrolls && over > 1) out.push(`${Math.round(over)} px is left blank over the conversation`);
  const roomy = thread.querySelectorAll('.talk-row[data-roomy]').length;
  if (roomy && scrolls) out.push(`${roomy} earlier turn(s) opened out, and the conversation no longer fits the page`);
  for (const row of thread.querySelectorAll('.talk-turn.open > .talk-row[data-roomy]'))
    out.push(`an opened turn is still laid out as a line with room ("${row.textContent.slice(0, 30)}")`);
  const head = page.querySelector('.talk-head');
  const done = head?.querySelector('.talk-done');
  if (head && done && getComputedStyle(head).display !== 'none') {
    const upright = document.documentElement.dataset.layout === 'phone-portrait';
    // (a desktop's dock: its name, and a button that slides it in, as tall as the tracks' toolbar beside it)
    const dock = document.documentElement.dataset.layout === 'desktop';
    const h = head.getBoundingClientRect().height;
    const d = done.getBoundingClientRect();
    if (upright && h > 30) out.push(`the header is ${Math.round(h)} px tall: it should be a grip`);
    if (upright && d.width > 2) out.push('Done shows on a phone held upright with no keyboard up');
    if (dock) {
      if (d.width < 20 || done.getAttribute('aria-label') !== 'Close') out.push('the dock’s header has no Close');
      if (head.textContent.trim() !== 'HO[LO]-agent') out.push(`the dock’s header says "${head.textContent.trim()}"`);
      const tools = document.querySelector('.tracks-toolbar')?.getBoundingClientRect();
      const foot = head.getBoundingClientRect().bottom;
      if (tools && tools.height > 0 && Math.abs(tools.bottom - foot) > 1)
        out.push(
          `the dock’s header ends at ${Math.round(foot)} px, the tracks’ toolbar at ${Math.round(tools.bottom)} px`,
        );
    } else {
      if (!upright && d.width < 30) out.push('the sheet’s header has no Done');
      if (head.textContent.trim() !== 'Done') out.push(`the header says more than Done ("${head.textContent.trim()}")`);
    }
  }
  return out;
}

/**
 * The commands opened from a scan's review: over it (what's in the middle of where they are is theirs),
 * under its header (whose Commands button, beside Close, stays in reach), and the review still there.
 */
function scanOver() {
  const head = document.querySelector('.scan-window .scan-bar');
  const el = document.querySelector('.talk-page') ?? document.querySelector('.bar');
  if (!head) return ['the review closed'];
  if (!el) return ['the commands didn’t open'];
  const out = [];
  const r = el.getBoundingClientRect();
  const mid = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!mid || !el.contains(mid)) out.push(`they're under the review (${mid?.className ?? 'nothing'} is over them)`);
  if (el.classList.contains('talk-page') && r.top < head.getBoundingClientRect().bottom - 1)
    out.push('the page covers the review’s header');
  // (the page keeps it in reach to put the page away; a desktop's bar is a menu: a press outside closes it)
  const button = el.classList.contains('talk-page') ? head.querySelector('.cb-bar') : null;
  if (button) {
    const b = button.getBoundingClientRect();
    const at = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    if (!at || !button.contains(at))
      out.push(`the header’s Commands button is covered by ${at?.className ?? 'nothing'}`);
  }
  return out;
}

/** With the agent on, the commands opened over a scan's review offer to read it. */
function scanOffered() {
  const rows = [...document.querySelectorAll('.talk-page [role=option], .bar [role=option]')].map((e) =>
    e.textContent.trim(),
  );
  return rows.some((t) => t.startsWith('Read this scan'))
    ? []
    : [`they don't offer to read the scan (${rows.slice(0, 4).join(' / ') || 'nothing listed'})`];
}

const CHECKS = {
  scanOver,
  scanOffered,
  transportClear,
  dockBeside,
  solid,
  workingFits,
  windowClear,
  wide,
  noticesFit,
  tray,
  noTray,
  viewFits,
  threadRoom,
  fitsOnce,
};

// ---- the agent's host, played here: on, this device allowed, and a song's conversation ----

/**
 * Two replies looked at on their own, as the newest turn (the bar shows only that one): takes compared
 * in two places, each with a row of buttons; and everything at once, as many and as long as a view can
 * have them.
 */
const NEWEST = {
  compare: {
    what: 'a reply comparing takes',
    turn(doc, now) {
      const lead = doc.tracks[2].id;
      const take = (label, version, from, to) => ({ label, do: { play: { from, to, version } } });
      const solo = (label, version) => ({ button: label, do: { play: { from: 1, to: 5, version, solo: [lead] } } });
      return {
        job: 'agj_00000000000e',
        request: 'The lead sounds thin: try a few other voices for it',
        reply:
          'I made three other voices for the lead, each kept as a version. Play each against the old one, then keep the one you like.',
        label: 'Lead voices',
        state: 'done',
        at: now - 100_000,
        view: {
          blocks: [
            {
              group: [
                {
                  choice: [
                    take('The old lead', 'before', 1, 5),
                    take('Glassy Pad Lead', 'Glassy', 1, 5),
                    take('Warm Saw Lead', 'Warm saw', 1, 5),
                    take('Soft Organ Lead', 'Soft organ', 1, 5),
                  ],
                },
                {
                  row: [
                    solo('Solo Glassy Pad Lead', 'Glassy'),
                    solo('Solo Warm Saw Lead', 'Warm saw'),
                    solo('Solo Soft Organ Lead', 'Soft organ'),
                  ],
                },
              ],
              title: 'Compare in the intro (bars 1–4)',
            },
            {
              group: [
                {
                  choice: [
                    take('Glassy Pad Lead', 'Glassy', 5, 9),
                    take('Warm Saw Lead', 'Warm saw', 5, 9),
                    take('Soft Organ Lead', 'Soft organ', 5, 9),
                  ],
                },
                {
                  row: [
                    { button: 'Keep Glassy Pad Lead', do: { keep: 'Glassy' } },
                    { button: 'Keep Warm Saw Lead', do: { keep: 'Warm saw' } },
                    { button: 'Keep Soft Organ Lead', do: { keep: 'Soft organ' } },
                  ],
                },
              ],
              title: 'Compare in the verse (bars 5–8) and choose',
            },
          ],
          versions: { before: 3, after: 4, Glassy: 4, 'Warm saw': 5, 'Soft organ': 6 },
        },
      };
    },
  },
  crowded: {
    what: 'a reply with everything at once',
    turn(doc, now) {
      const [keys, , lead, bass, drums] = doc.tracks.map((t) => t.id);
      const delay = doc.tracks[0].channel.inserts.find((p) => p.type === 'delay').id;
      const hall = doc.buses[0].id;
      const play = (version) => ({ play: { from: 9, to: 13, version, solo: [keys, drums] } });
      const takes = [
        ['Take one, close and dry', 'Take one'],
        ['Take two, with the room around it', 'Take two'],
        ['Take three, an octave up', 'Take three'],
        ['Take four, at half time', 'Take four'],
        ['Take five, doubled and wide', 'Take five'],
        ['Take six, the long one with the fills', 'Take six'],
      ];
      return {
        job: 'agj_00000000000f',
        request: 'Show me every take of the chorus and every setting I might want, all at once',
        reply: 'Here is all of it at once: six takes, what to keep, how they measure, and the settings to try.',
        label: 'Everything at once',
        state: 'done',
        at: now - 100_000,
        view: {
          blocks: [
            { text: 'Six takes of the chorus, bars 9–12, each with the drums', quiet: true },
            { choice: takes.map(([label, version]) => ({ label, do: play(version) })) },
            {
              row: [
                { button: 'Keep take one as it was played', do: { keep: 'Take one' } },
                { button: 'Keep take two with the room sound', do: { keep: 'Take two' } },
                { button: 'Keep take three an octave higher', do: { keep: 'Take three' } },
                { button: 'Ask for a seventh take in half time', do: { ask: 'Write a seventh take, in half time' } },
                { button: 'Open the chorus where it starts', do: { go: { bar: 9, track: keys } } },
              ],
            },
            {
              table: {
                head: ['Take', 'Bars', 'Notes', 'Loudest', 'Timing', ''],
                rows: takes
                  .slice(0, 5)
                  .map(([label, version], i) => [
                    label,
                    '9–12',
                    40 + i * 6,
                    `−${(6 + i * 0.7).toFixed(1)} dB`,
                    i % 2 ? 'a little behind the beat' : 'tight',
                    { button: 'Play', do: play(version) },
                  ]),
              },
            },
            {
              slider: { track: keys, param: `fx:${delay}:highcut` },
              label: 'The high cut of the keys’ delay, over the whole long chorus',
            },
            { slider: { track: bass, param: 'volume' }, label: 'Bass level' },
            {
              row: [
                { slider: { track: keys, param: `send:${hall}` }, label: 'How much of the keys goes to the hall' },
                { slider: { track: lead, param: 'pan' }, label: 'Where the lead sits' },
              ],
            },
            {
              row: [
                { toggle: { track: drums, param: 'mute' }, label: 'Mute the drums while you listen' },
                { toggle: { track: bass, param: 'solo' }, label: 'Solo the bass' },
                { toggle: { track: keys, param: `on:${delay}` }, label: 'The keys’ delay on' },
              ],
            },
            {
              list: [
                {
                  text: 'The chorus from its first bar, with every take one after another',
                  detail: 'bars 9–12, the loudest part of the song, where the takes differ the most',
                  do: { go: { bar: 9 } },
                },
                {
                  text: 'Take six on its own',
                  detail: 'the long one, with the fills at its end',
                  do: play('Take six'),
                },
                { text: 'What the takes have in common', detail: 'the same four chords, at the same tempo' },
              ],
            },
            {
              chart: takes.map(([label], i) => ({ y: -6 - ((i * 7) % 5) * 0.8, label })),
              kind: 'bars',
              unit: 'dB',
              ref: -6,
            },
            {
              group: [
                { notes: { track: keys, from: 9, to: 13 } },
                { wave: { track: keys, from: 9, to: 13 } },
                {
                  group: [
                    { text: 'A group inside a group, with its own buttons', quiet: true },
                    { button: 'Go to the start of the chorus', do: { go: { bar: 9 } } },
                    { button: 'Go to the end of the song', do: { go: { bar: 17 } } },
                  ],
                  title: 'And inside it another group, its title long enough for two lines',
                },
              ],
              title: 'The keys in the chorus, as notes and as a waveform',
            },
          ],
          versions: Object.fromEntries([
            ['before', 3],
            ['after', 4],
            ...takes.map(([, version], i) => [version, 4 + i]),
          ]),
        },
      };
    },
  },
};

/**
 * A conversation of three turns (a list, a brief, a choice with sliders); `running`, a fourth that has
 * worked 65 s; `newest`, a fourth from NEWEST.
 */
function conversation(doc, id, running, newest) {
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
          { button: 'Keep Take 3', do: { keep: 'after' } },
        ],
        versions: { before: 2, after: 3 },
        // its takes and Keep again, for a phone's tray once it has been read
        dock: [
          {
            choice: [
              { label: 'Take 1', do: { play: { from: 5, to: 13, solo: [bass, drums] } } },
              { label: 'Take 2', do: { play: { from: 5, to: 13 } } },
              { label: 'Take 3', do: { play: { from: 5, to: 13 } } },
            ],
          },
          { button: 'Keep Take 3', do: { keep: 'after' } },
        ],
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
  if (newest) turns.push(NEWEST[newest].turn(doc, now));
  return { thread: { id: 'agt_uicheck', harness: 'claude', turns }, job, now };
}

/**
 * A browser where the agent is on and this device allowed: its token is kept as a paired device's is,
 * and the agent's routes are answered here (the live channel's hello with a token the host doesn't
 * know is only that: no device).
 */
async function withAgent(ctx, doc, id, running, newest) {
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
    if (path.startsWith('/api/agent/threads/')) return json(conversation(doc, id, running, newest));
    // this device's notices outside HO[LO]: on, for long runs (Settings › Agent says when they come)
    if (path === '/api/agent/push')
      return json({
        key: `B${'A'.repeat(86)}`,
        mode: 'long',
        endpoint: 'https://fcm.googleapis.com/fcm/send/ui-check',
        unseen: 2,
      });
    if (path === '/api/agent/seen') return json({ unseen: 0 });
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
 * The commands: on a desktop the bar (Ctrl /), elsewhere the page (the slash button, Done to close);
 * `agentOn`, a desktop has the page too, as its dock (the slash button, its header's Close). Each says
 * what's checked besides.
 */
function commands(page, layout, press, agentOn = false) {
  const dock = layout === 'desktop' && agentOn;
  const page_ = layout !== 'desktop' || dock;
  const open = () => (page_ ? press(control(page, 'Commands')) : page.keyboard.press('Control+/'));
  // (a phone held upright has a grip for a header, and across a phone on its side, typing, the sheet has
  // none: the Commands button, over or beside it, puts it away; a tablet's sheet has Done, a dock Close)
  const shut = () =>
    !page_
      ? page.keyboard.press('Escape')
      : dock
        ? press(page.locator('.talk-head button[aria-label="Close"]'))
        : layout === 'tablet'
          ? press(page.locator('.talk-head button', { hasText: 'Done' }))
          : press(control(page, 'Commands'));
  const field = () => page.locator('.talk-page .field textarea, .bar .field input').first();
  const name = dock
    ? 'Commands dock'
    : layout === 'desktop'
      ? 'Commands'
      : layout === 'phone-portrait'
        ? 'Commands page'
        : 'Commands sheet';
  const checks = dock ? ['transportClear', 'dockBeside', 'solid'] : page_ ? ['transportClear', 'solid'] : ['solid'];
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
  if (dock) return [[name, open, shut, checks], typed, windowed];
  if (layout === 'tablet') return [[name, open, shut, checks], windowed];
  return [[name, open, shut, checks]];
}

/**
 * With the agent on: the page (a desktop's dock) with the song's conversation, or a request working; and the
 * newest reply's dock, once it has been read: on a phone the tray, put away with ×, and nowhere else.
 */
function agentViews(page, layout, finger, running) {
  const press = (loc) => (finger ? loc.tap() : loc.click());
  const [, open, shut, checks] = commands(page, layout, press, true)[0];
  const where = layout === 'desktop' ? 'Dock' : 'Page';
  // Settings › Agent, this device allowed: its harness, what it asks first, its notices, its devices
  const settings = [
    'Settings › Agent',
    async () => {
      await press(control(page, 'Settings'));
      await press(page.getByRole('tab', { name: 'Agent' }));
      await page.locator('.agent-notices .seg .btn.on').waitFor();
      await page.locator('.agent-notices').scrollIntoViewIfNeeded();
    },
    () => page.keyboard.press('Escape'),
    ['noticesFit'],
  ];
  // the reply read on the page (or the bar), then closed
  const read = async () => {
    await open();
    await page.waitForTimeout(300);
    await shut();
  };
  const tray = layout.startsWith('phone')
    ? [
        ['Tray', read, null, ['tray', 'transportClear', 'viewFits']],
        ['Tray, put away', () => press(page.locator('.tray button[aria-label="Put this away"]')), null, ['noTray']],
      ]
    : [['No tray', read, null, ['noTray']]];
  return running
    ? [[`${where}: working turn`, open, shut, [...checks, 'workingFits', 'threadRoom']]]
    : [
        settings,
        [`${where} with a thread`, open, shut, [...checks, 'viewFits', 'fitsOnce', 'threadRoom']],
        // a desktop's dock, typed in (the commands it finds, over its field) and with a plugin's window opened
        ...(layout === 'desktop' ? commands(page, layout, press, true).slice(1) : []),
        // an earlier turn opened: its view drawn
        [
          `${where} with a thread, a turn opened`,
          async () => {
            await open();
            await press(page.locator('.talk-row').last());
          },
          shut,
          [...checks, 'viewFits', 'threadRoom'],
        ],
        ...tray,
        ...scanViews(page, layout, press, true),
      ];
}

/** The page (a desktop's dock) with a reply of NEWEST's as its newest turn: its view laid out whole. */
function replyViews(page, layout, finger, newest) {
  const press = (loc) => (finger ? loc.tap() : loc.click());
  const [, open, shut, checks] = commands(page, layout, press, true)[0];
  const where = layout === 'desktop' ? 'Dock' : 'Page';
  return [
    [
      `${where}: ${NEWEST[newest].what}`,
      async () => {
        await open();
        await page.locator('.talk.newest .agent-view, .bar .talk .agent-view').first().waitFor();
      },
      shut,
      [...checks, 'viewFits'],
    ],
  ];
}

/** What to look at on a screen: each opens something, and says how to close it again (and what's checked besides). */
/**
 * A scan's review, opened from the Score (on a phone held upright, behind its ⋯), then the commands
 * from its header's button, closed with Escape (the review stays), and the review closed. With the
 * agent on, the commands must offer to read the scan.
 */
function scanViews(page, layout, press, agent) {
  const toScan = async () => {
    await page.keyboard.press('n');
    await page.waitForTimeout(300);
    if (layout === 'phone-portrait') {
      await press(control(page, 'More'));
      await press(page.getByRole('menuitem', { name: 'Scan…' }));
    } else await press(control(page, 'Scan sheet music'));
  };
  const open = async () => {
    await toScan();
    await press(page.locator('.scan-earlier .scan-open').first());
    await page.locator('.scan-row').first().waitFor();
  };
  // an earlier scan's delete, asked first: the question laid out whole, and Keep bringing the scan back
  const ask = async () => {
    await toScan();
    await press(page.locator('.scan-earlier button[title="Delete this scan"]').first());
    await page.locator('.scan-earlier-row.asking').waitFor();
  };
  const keep = async () => {
    await press(page.locator('.scan-earlier-row.asking').getByRole('button', { name: 'Keep' }));
    if (!(await page.locator('.scan-earlier .scan-open').count())) throw new Error('Keep didn’t bring the scan back');
    await press(page.locator('.scan-window button[title="Close"]'));
    await page.keyboard.press('n');
  };
  const commandsOpen = async () => {
    await press(page.locator('.scan-window .cb-bar'));
    await page.locator('.talk-page, .bar').first().waitFor();
  };
  const shut = async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    if (!(await page.locator('.scan-window .scan-bar').count()))
      throw new Error('Escape closed the review, not the commands');
    if (await page.locator('.talk-page, .bar').count()) throw new Error('Escape left the commands open');
    await press(page.locator('.scan-window button[title="Close"]'));
    await page.keyboard.press('n');
  };
  return [
    ['Scan, an earlier scan’s delete asked', ask, keep],
    ['Scan review', open, null],
    ['Scan review, its commands', commandsOpen, shut, agent ? ['scanOver', 'scanOffered'] : ['scanOver']],
  ];
}

function views(page, layout, finger) {
  const phone = layout.startsWith('phone');
  const press = (loc) => (finger ? loc.tap() : loc.click());
  const lanes = async (on) => {
    await press(control(page, 'Settings'));
    await press(page.getByRole('tab', { name: 'View' }));
    for (const name of ['Arrangement lane', 'Chords lane']) {
      const box = page.locator('.view-item', { hasText: name }).locator('input');
      await box.scrollIntoViewIfNeeded();
      if ((await box.isChecked()) !== on) await press(box);
    }
    // (left on its first tab, as the views after this one find it)
    await press(page.getByRole('tab', { name: 'General' }));
    await page.keyboard.press('Escape');
    if (on) await page.locator('.song-lanes').waitFor();
    else if (await page.locator('.song-lanes').count())
      throw new Error('the lanes are still there with View’s two off');
  };
  const dialogs = [
    ['Songs', () => press(control(page, 'Songs')), () => page.keyboard.press('Escape')],
    // the open song's bounces (under its row, folded until pressed), all of them, one's delete asked: the
    // question whole, and Keep bringing it back
    [
      'Songs, a bounce’s delete asked',
      async () => {
        await press(control(page, 'Songs'));
        await press(page.locator('.song-bounces .bounces-head'));
        await press(page.locator('.song-bounces .bounces-all'));
        await press(page.locator('.song-bounces button[title="Delete this bounce"]').first());
        await page.locator('.song-bounces .bounce-row.asking').waitFor();
      },
      async () => {
        await press(page.locator('.song-bounces .bounce-row.asking').getByRole('button', { name: 'Keep' }));
        if ((await page.locator('.song-bounces button[title="Delete this bounce"]').count()) !== 4)
          throw new Error('Keep didn’t bring the bounce back');
        await page.keyboard.press('Escape');
      },
    ],
    ['Settings', () => press(control(page, 'Settings')), () => page.keyboard.press('Escape')],
    // the Arrangement and Chords lanes, switched on in Settings › View: the tracks with both under the ruler
    ['Tracks, with the Arrangement and Chords lanes', () => lanes(true), () => lanes(false)],
    // Settings › Audio: the rate, where bounces are made, the devices
    [
      'Settings › Audio',
      async () => {
        await press(control(page, 'Settings'));
        await press(page.getByRole('tab', { name: 'Audio' }));
        await page.getByText('Bounce on', { exact: true }).scrollIntoViewIfNeeded();
      },
      async () => {
        // (left on its first tab, as the views after this one find it)
        await press(page.getByRole('tab', { name: 'General' }));
        await page.keyboard.press('Escape');
      },
    ],
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
      ...scanViews(page, layout, press, false),
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
    ...scanViews(page, layout, press, false),
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
  await makeScan(id);
  await makeBounces(id);

  browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required'],
    ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
  });
  // a screen's studio, opened and started, in a browser of its own; what's wrong on each view is said
  const look = async (name, screen, list, agent) => {
    const ctx = await browser.newContext(screen);
    if (agent) await withAgent(ctx, doc, id, agent.running, agent.newest);
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
    // and a reply of each kind of NEWEST, on its own
    for (const newest of Object.keys(NEWEST))
      looked += await look(name, screen, (page, layout, finger) => replyViews(page, layout, finger, newest), {
        running: false,
        newest,
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
