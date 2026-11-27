// HO[LO] in Docker, kept up to date (`pnpm run update`, `pnpm run up`, `pnpm run autoupdate`).
//
//   update [main|stable]   follow the image CI publishes (ghcr.io/shooter-git/holo-desk:<channel>):
//                          pull it and start it, with the recognition engines' beside it (omr-<channel>;
//                          `pnpm omr off` leaves them out). The channel is kept in .env (HOLO_CHANNEL).
//   source                 build from this checkout instead (holo-desk:local): your own changes. Auto-update
//                          waits until you run `update` again, so it never replaces your build.
//   autoupdate on|off|status
//                          a timer (systemd, as you) that runs `tick` every 15 minutes
//   tick                   one look: when following a channel and no studio is playing or recording, pull;
//                          a new image is started, the same one changes nothing (the engines' too)
//
// A new version is started with care. The songs' database is copied first (the server makes the copy,
// in the data folder's `backups`, the last few kept; with no room for one, the update says so and goes
// on). The version that was running is kept at hand (holo-desk:previous), and when the new one doesn't
// answer within a few minutes it's started again: HO[LO] is then back on it, the log says so, and each
// look waits for a newer version than the one that didn't start. A copy is only put back by hand.
//   runner-service on|off|status
//                          the runner (`pnpm runner`: creations' renders, and the agent's harness when the
//                          agent is on) as a service (systemd, as you), started again after each update
//
// The mode lives in .env (HOLO_IMAGE), so every `docker compose` command (pnpm lan, pnpm down) agrees.
//
// Following a channel also keeps this checkout at the code of the image it runs (a release's tag on
// stable, main's head on main), so its compose file, its tools and the runner (which runs from it) match
// the server. Only a checkout that's following moves: no change to its files, on no branch, and only
// forward. A branch is someone's work: automatic updates never move one, and `pnpm run update` only takes
// a checkout on main along (once; after that it's on no branch and follows).
import { execFileSync, spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const envFile = join(root, '.env');
const LOCAL = 'holo-desk:local';
/** The version that ran before the one started last: what HO[LO] goes back to when that one doesn't answer. */
export const PREVIOUS = 'holo-desk:previous';
export const REPO = process.env.HOLO_IMAGE_REPO ?? 'ghcr.io/shooter-git/holo-desk';
const [command = 'update', arg] = process.argv.slice(2);

export function readEnv() {
  if (!existsSync(envFile)) writeFileSync(envFile, readFileSync(join(root, '.env.example'), 'utf8'));
  const text = readFileSync(envFile, 'utf8');
  const values = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) values[m[1]] = m[2];
  }
  return { text, values };
}

export function setEnv(key, value) {
  const { text } = readEnv();
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  writeFileSync(envFile, re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, '\n')}${line}\n`);
}

/** A setting taken out of .env, so the compose file's (or the server's) default holds. */
export function unsetEnv(key) {
  const { text } = readEnv();
  writeFileSync(envFile, text.replace(new RegExp(`^${key}=.*\\n?`, 'm'), ''));
}

/** Whether the recognition engines are on: they are unless `pnpm omr off` (HOLO_OMR_URL set empty). */
export function omrOn(values) {
  return values.HOLO_OMR_URL !== '' && values.HOLO_OMR_REPLICAS !== '0';
}

/** The engines' image CI publishes for a channel (from deploy/omr), beside the studio's. */
export const omrImage = (channel, repo = REPO) => `${repo}:omr-${channel}`;

/** Whether the engines' image follows CI's (not set yet, or one of its channels): not one built here. */
export const followsOmr = (image, repo = REPO) => !image || image.startsWith(`${repo}:omr-`);

export function compose(...args) {
  const r = spawnSync(
    'docker',
    ['compose', '--project-directory', '.', '-f', 'deploy/compose.yml', '--env-file', '.env', ...args],
    { cwd: root, stdio: 'inherit' },
  );
  if (r.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed`);
}

function imageId(ref) {
  try {
    return execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * The recognition engines started beside the studio (pulled first when `pull`, and their image is
 * CI's). Never fatal: a studio whose engines can't be fetched yet runs without them, and the next look
 * tries again.
 */
export function startEngines(pull = true, quiet = false) {
  const { values } = readEnv();
  if (!omrOn(values)) return;
  const image = values.HOLO_OMR_IMAGE || omrImage('stable');
  const later = (why) =>
    console.log(`The recognition engines aren’t running yet (${why}): the next update tries again`);
  if (pull && followsOmr(values.HOLO_OMR_IMAGE)) {
    try {
      compose('pull', ...(quiet ? ['--quiet'] : []), 'omr');
    } catch (err) {
      // (offline, or not published yet: the image here, if there is one, still starts)
      if (!imageId(image)) return later(err instanceof Error ? err.message : err);
    }
  }
  try {
    // (up to date and running, nothing happens)
    compose('up', '-d', '--no-build', 'omr');
  } catch (err) {
    later(err instanceof Error ? err.message : err);
  }
}

/**
 * The engines' image set to follow the studio's channel, unless it's one built here (`pnpm omr build`).
 * A host that turned them off before they were on by default (HOLO_OMR_URL empty, nothing else) gets
 * the rest of off too, so a plain `docker compose up` doesn't start them.
 */
function followOmr(channel) {
  const { values } = readEnv();
  if (followsOmr(values.HOLO_OMR_IMAGE) && values.HOLO_OMR_IMAGE !== omrImage(channel))
    setEnv('HOLO_OMR_IMAGE', omrImage(channel));
  if (values.HOLO_OMR_URL === '' && values.HOLO_OMR_REPLICAS === undefined) setEnv('HOLO_OMR_REPLICAS', '0');
}

/** What the server says of itself (/api/health), or null when it doesn't answer. */
async function health() {
  const port = readEnv().values.HOLO_PORT || '47800';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) });
    return await res.json();
  } catch {
    return null;
  }
}

/** A studio playing or recording right now (the server says): an update waits for the next look. */
async function busy() {
  return (await health())?.busy === true; // not running: nothing to interrupt
}

/** The image the studio's container runs now (its id), or null when there's none. */
function runningImage() {
  const ps = spawnSync(
    'docker',
    ['compose', '--project-directory', '.', '-f', 'deploy/compose.yml', '--env-file', '.env', 'ps', '-q', 'holo'],
    { cwd: root, encoding: 'utf8' },
  );
  const container = ps.status === 0 ? ps.stdout.trim().split('\n')[0] : '';
  if (!container) return null;
  try {
    return (
      execFileSync('docker', ['inspect', '--format', '{{.Image}}', container], { encoding: 'utf8' }).trim() || null
    );
  } catch {
    return null;
  }
}

/** A size as people say it. */
const sizeText = (bytes) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : bytes >= 1024 ** 2
      ? `${Math.round(bytes / 1024 ** 2)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** What became of the copy the server was asked for (POST /api/backup), as the update's log says it. */
export function copyNote(status, body) {
  if (status === 200 && typeof body?.file === 'string')
    return `The songs’ database was copied first: ${body.file}${typeof body.size === 'number' ? ` (${sizeText(body.size)})` : ''}`;
  if (status === 507)
    return `No room for a copy of the songs’ database${
      typeof body?.need === 'number' && typeof body?.free === 'number'
        ? ` (it needs ${sizeText(body.need)}, ${sizeText(body.free)} are free)`
        : ''
    }: updating without one`;
  // a version from before copies: the one that starts now makes them
  if (status === 404) return 'The version running can’t copy its database yet: the next update is copied first';
  if (status === 403) return 'No copy of the songs’ database: the runner key in the data folder isn’t this HO[LO]’s';
  return `No copy of the songs’ database (the server answered ${status}): updating without one`;
}

/** Room left over once a copy is made, at least (as the server asks: apps/server/src/backup.ts). */
const SPARE_BYTES = 64 * 1024 * 1024;

/**
 * The copy made from here, for a server that doesn't answer: SQLite's own backup of `holo.db` into the
 * data folder's `backups`. What it did, as a line for the log; null when there's no database yet.
 */
export async function copyHere(dataDir, now = new Date(), free = null) {
  const db = join(dataDir, 'holo.db');
  if (!existsSync(db)) return null;
  const size = (f) => (existsSync(f) ? statSync(f).size : 0);
  const need = size(db) + size(`${db}-wal`) + SPARE_BYTES;
  const left = free ?? Number(statfsSync(dataDir).bavail) * Number(statfsSync(dataDir).bsize);
  if (left < need) return copyNote(507, { need, free: left });
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const dir = join(dataDir, 'backups');
  const file = join(dir, `holo-before-update-${stamp}.db`);
  const part = `${file}.part`;
  let source;
  try {
    // (Node's own SQLite, as the server's: nothing to install; an older Node hasn't its backup)
    const { DatabaseSync, backup } = await import('node:sqlite');
    if (typeof backup !== 'function') return 'No copy of the songs’ database: this Node can’t make one from here';
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    rmSync(part, { force: true });
    source = new DatabaseSync(db, { readOnly: true });
    await backup(source, part);
    chmodSync(part, 0o600);
    renameSync(part, file);
    return copyNote(200, { file: join('backups', `holo-before-update-${stamp}.db`), size: size(file) });
  } catch (err) {
    rmSync(part, { force: true });
    return `No copy of the songs’ database (${err instanceof Error ? err.message : err}): updating without one`;
  } finally {
    try {
      source?.close();
    } catch {
      // closed already
    }
  }
}

/** The data folder, as the server and the runner find it. */
const dataDirOf = (values) => resolve(root, values.HOLO_DATA_DIR || './data');

/**
 * A copy of the songs' database before a new version starts: the server is asked for it (as this
 * computer's owner, with the runner key); one that doesn't answer is copied from here. Never fatal:
 * an update goes on without a copy, saying so.
 */
async function copyFirst() {
  const { values } = readEnv();
  const dataDir = dataDirOf(values);
  let key = process.env.HOLO_RUNNER_KEY?.trim() || '';
  try {
    key ||= readFileSync(join(dataDir, 'runner.key'), 'utf8').trim();
  } catch {
    // none: a data folder from before runner keys, or one this user can't read
  }
  let res = null;
  if (key) {
    try {
      // (a big database takes a while: the copy is made before the answer comes)
      res = await fetch(`http://127.0.0.1:${values.HOLO_PORT || '47800'}/api/backup`, {
        method: 'POST',
        headers: { 'x-holo-runner-key': key },
        signal: AbortSignal.timeout(15 * 60_000),
      });
    } catch {
      // not answering: copied from here, below
    }
  }
  if (res) {
    console.log(copyNote(res.status, await res.json().catch(() => null)));
    return;
  }
  try {
    // a server that's there but not answering is stopped first (the new version is about to take its
    // place anyway): the database is then copied with nobody else at it
    if (runningImage()) compose('stop', 'holo');
    const note = await copyHere(dataDir);
    if (note) console.log(note);
  } catch (err) {
    console.log(`No copy of the songs’ database (${err instanceof Error ? err.message : err}): updating without one`);
  }
}

/** How long a version that was just started has to answer (HOLO_UPDATE_WAIT_S, in seconds: three minutes). */
const answerMs = () => {
  const s = Number(process.env.HOLO_UPDATE_WAIT_S);
  return (Number.isFinite(s) && s > 0 ? s : 180) * 1000;
};

/** Whether the server answers, running `image` (when its id is known), before the time is up. */
async function answers(image) {
  const end = Date.now() + answerMs();
  for (;;) {
    if ((await health())?.ok === true && (!image || runningImage() === image)) return true;
    if (Date.now() >= end) return false;
    await new Promise((ok) => setTimeout(ok, 2000));
  }
}

/** What starting a version really does, here: `startNew` is given these (its tests, others). */
const HERE = {
  copy: copyFirst,
  tag: (id) => spawnSync('docker', ['tag', id, PREVIOUS], { stdio: 'inherit' }).status === 0,
  up: () => compose('up', '-d', '--no-build', 'holo'),
  answers,
  imageId,
  setEnv,
  log: (line) => console.log(line),
};

/**
 * A new version started with care: the songs' database copied first, the version that was running
 * (`previous`, its image's id; null when nothing ran) kept at hand, and gone back to when the new one
 * doesn't answer in time. Says how it went: `started`; `back` (HO[LO] runs the version before again,
 * and .env says which image didn't start); or `down` (it doesn't answer, and there's nothing to go
 * back to, or that didn't answer either).
 */
export async function startNew(d, image, previous) {
  await d.copy();
  const kept = previous ? d.tag(previous) : false;
  d.up();
  const next = d.imageId(image);
  if (await d.answers(next)) return 'started';
  if (!kept) {
    d.log('The new version isn’t answering, and there’s no version before it to go back to: look at `docker logs`');
    return 'down';
  }
  d.log('The new version didn’t answer in time: going back to the one before');
  d.setEnv('HOLO_IMAGE', PREVIOUS);
  d.setEnv('HOLO_ROLLED_BACK_FROM', next ?? 'unknown');
  d.up();
  if (await d.answers(previous)) {
    d.log(
      'HO[LO] is back on the version before. It stays there until a newer one is out (each look checks), or `pnpm run update` is run by hand.',
    );
    return 'back';
  }
  d.log('The version before isn’t answering either: look at `docker logs`');
  return 'down';
}

/**
 * Gone back to the version before (above): whether what the channel has now is a version to go
 * forward to (not the one that didn't start).
 */
export function goesForward(values, id) {
  return !!id && id !== values.HOLO_ROLLED_BACK_FROM;
}

/** The version the server runs, once it answers (a minute at most, as a new image starts). */
async function runningVersion() {
  for (let i = 0; i < 30; i++) {
    const h = await health();
    if (typeof h?.version === 'string') return h.version;
    await new Promise((ok) => setTimeout(ok, 2000));
  }
  return null;
}

/** git in a checkout: its output, or null when it fails. */
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Move a checkout to `target` (a ref it has, such as `refs/tags/v0.7.1`), detached, if it's following:
 * - no change to its tracked files (untracked ones, such as .env and data, don't count);
 * - on no branch. A branch is someone's work, and is never moved by itself. Only `pnpm run update`,
 *   asked for by hand (`start`), takes a checkout on main along, leaving the branch main where it is;
 * - and only forward: its commit is already in the target's history, so nothing of its own is left behind.
 * The commit it moved to, or null when it stayed (already there, someone's work, or no such target).
 */
export function followCheckout(cwd, target, start = false) {
  const to = git(cwd, 'rev-parse', '-q', '--verify', `${target}^{commit}`);
  const head = git(cwd, 'rev-parse', 'HEAD');
  if (!to || !head || head === to) return null;
  if (git(cwd, 'status', '--porcelain', '--untracked-files=no') !== '') return null;
  const branch = git(cwd, 'symbolic-ref', '-q', '--short', 'HEAD');
  if (branch !== null && !(start && branch === 'main')) return null;
  if (git(cwd, 'merge-base', '--is-ancestor', head, to) === null) return null;
  return git(cwd, 'checkout', '-q', '--detach', to) === null ? null : to;
}

/**
 * This checkout at the code of the image the server runs (`start`: asked for by hand); when it moves,
 * the server and the runner start again from it.
 */
async function follow(image, start = false) {
  let target;
  if (image.endsWith(':main')) {
    if (git(root, 'fetch', '-q', 'origin', 'main') === null) return;
    target = 'refs/remotes/origin/main';
  } else {
    const version = await runningVersion();
    if (!version || git(root, 'fetch', '-q', '--tags', 'origin') === null) return;
    target = `refs/tags/v${version}`;
  }
  const moved = followCheckout(root, target, start);
  if (!moved) {
    if (start && git(root, 'symbolic-ref', '-q', 'HEAD') !== null)
      console.log('This checkout is on a branch (your work): it stays as it is, so it doesn’t follow the image');
    return;
  }
  console.log(`This checkout moved to ${target.replace(/^refs\/(tags|remotes)\//, '')} (${moved.slice(0, 7)})`);
  // its compose file may be new (nothing happens when it isn't), and the runner runs from it
  compose('up', '-d', '--no-build', 'holo');
  startEngines(false);
  if (existsSync(join(units, RUNNER_UNIT))) systemctl('try-restart', RUNNER_UNIT);
}

async function update(channel) {
  const values = readEnv().values;
  const ch = channel ?? values.HOLO_CHANNEL ?? 'stable';
  if (ch !== 'main' && ch !== 'stable') throw new Error('The channel is main (every merge) or stable (each release)');
  const image = `${REPO}:${ch}`;
  // what runs now, to go back to (asked for by hand, a version that didn't start is tried again)
  const running = runningImage();
  setEnv('HOLO_CHANNEL', ch);
  setEnv('HOLO_IMAGE', image);
  unsetEnv('HOLO_ROLLED_BACK_FROM');
  followOmr(ch);
  console.log(`Following ${image}`);
  compose('pull', 'holo');
  const next = imageId(image);
  let how = 'started';
  if (running && next && next !== running) how = await startNew(HERE, image, running);
  // (nothing new, or nothing was running: started as it is)
  else compose('up', '-d', '--no-build', 'holo');
  startEngines();
  if (how !== 'started') throw new Error('The new version didn’t start (above)');
  await follow(image, true);
}

function source() {
  execFileSync(process.execPath, [join(root, 'tools/engine-stamp.mjs')], { cwd: root, stdio: 'inherit' });
  setEnv('HOLO_IMAGE', LOCAL);
  console.log(`Building ${LOCAL} from this checkout (auto-update waits until \`pnpm run update\`)`);
  compose('up', '-d', '--build', 'holo');
  // the engines as they are (fetched the first time)
  startEngines(false);
}

/**
 * A look while HO[LO] runs the version before one that didn't start: what the channel has now is
 * fetched, and started when it's another version than that one.
 */
async function tickAfterGoingBack(values) {
  const image = `${REPO}:${values.HOLO_CHANNEL || 'stable'}`;
  if (await busy()) {
    console.log('A studio is busy: next time');
    return;
  }
  if (spawnSync('docker', ['pull', '--quiet', image], { stdio: 'inherit' }).status !== 0) {
    console.log(`${image} couldn’t be fetched: next time`);
    return;
  }
  const next = imageId(image);
  if (!goesForward(values, next)) {
    console.log(`${image} is still the version that didn’t start: HO[LO] stays on the one before`);
    return;
  }
  console.log(`A newer ${image}: starting it`);
  const running = runningImage();
  setEnv('HOLO_IMAGE', image);
  unsetEnv('HOLO_ROLLED_BACK_FROM');
  const how = await startNew(HERE, image, running);
  startEngines(true, true);
  if (how === 'started') await follow(image);
  else process.exitCode = 1;
}

async function tick() {
  const { values } = readEnv();
  const image = values.HOLO_IMAGE;
  if (image === PREVIOUS && values.HOLO_ROLLED_BACK_FROM) return tickAfterGoingBack(values);
  if (!image || image === LOCAL || !image.startsWith(`${REPO}:`)) {
    console.log('Built from this checkout: auto-update waits (`pnpm run update` to follow a channel again)');
    return;
  }
  if (await busy()) {
    console.log('A studio is playing or recording: next time');
    return;
  }
  // (a host set up before the engines were on by default gets them on its first look)
  const channel = image.slice(REPO.length + 1);
  if (channel === 'main' || channel === 'stable') followOmr(channel);
  // what runs now: a version fetched at an earlier look, and kept waiting by a busy studio, starts at this one
  const running = runningImage() ?? imageId(image);
  compose('pull', '--quiet', 'holo');
  const next = imageId(image);
  if (next && next !== running) {
    // (the fetch took a while: a studio may have started playing since)
    if (await busy()) {
      console.log(`New ${image}, and a studio is busy: it starts at the next look`);
      return;
    }
    console.log(`New ${image}: starting it`);
    const how = await startNew(HERE, image, running);
    if (how !== 'started') {
      // (this checkout and the runner stay with the version that runs)
      startEngines(true, true);
      process.exitCode = 1;
      return;
    }
  }
  startEngines(true, true);
  // (each look: a checkout that fell behind catches up, the same image or not)
  await follow(image);
}

const units = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd/user');
const RUNNER_UNIT = 'holo-runner.service';
/** A path as one argument of a unit's ExecStart (a folder like "VS Code" has a space in it). */
const quoted = (p) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
/** A path as a unit's WorkingDirectory: the whole line is the path; only its % are special. */
const dir = (p) => p.replace(/%/g, '%%');
const systemctl = (...a) => spawnSync('systemctl', ['--user', ...a], { stdio: 'inherit' }).status === 0;

/** Whether systemd keeps your user services (the timer, the runner) going without a login: null when it can't tell. */
function lingering() {
  const user = userInfo().username;
  const r = spawnSync('loginctl', ['show-user', user, '--property=Linger', '--value'], { encoding: 'utf8' });
  const v = r.status === 0 ? r.stdout.trim() : '';
  return { user, linger: v === 'yes' ? true : v === 'no' ? false : null };
}

/**
 * What turning on `what` (the timer, the runner) says about logging out and rebooting. Without linger,
 * systemd stops your user services when your last session ends (an SSH session too) and starts them
 * again only at your next login, so a server nobody stays logged into needs it.
 */
export function lingerNote(what, { linger, user }) {
  if (linger === true) return `Linger is on, so ${what} keeps running after you log out and starts at boot.`;
  return (
    `${linger === false ? 'Linger is off, so' : 'Without linger,'} ${what} stops when you log out and waits for your next` +
    ` login after a reboot. To keep it running on its own (a server nobody stays logged into), once: sudo loginctl enable-linger ${user}`
  );
}

function autoupdate(what) {
  if (process.platform !== 'linux')
    throw new Error('Automatic updates use a systemd timer (Linux): elsewhere, run `pnpm run update` now and then');
  if (what === 'on') {
    mkdirSync(units, { recursive: true });
    writeFileSync(
      join(units, 'holo-update.service'),
      `[Unit]\nDescription=HO[LO] Desk: update to the newest published image\n\n[Service]\nType=oneshot\nWorkingDirectory=${dir(root)}\nExecStart=${quoted(process.execPath)} ${quoted(join(root, 'tools/update.mjs'))} tick\n`,
    );
    writeFileSync(
      join(units, 'holo-update.timer'),
      '[Unit]\nDescription=HO[LO] Desk: look for an update every 15 minutes\n\n[Timer]\nOnBootSec=5min\nOnUnitActiveSec=15min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n',
    );
    if (!systemctl('daemon-reload') || !systemctl('enable', '--now', 'holo-update.timer'))
      throw new Error('systemctl --user could not start the timer');
    const { values } = readEnv();
    console.log(
      `On: every 15 minutes, following ${values.HOLO_IMAGE?.startsWith(REPO) ? values.HOLO_IMAGE : `${REPO}:${values.HOLO_CHANNEL ?? 'stable'} once you run \`pnpm run update\``}.` +
        `\n${lingerNote('the timer', lingering())}`,
    );
  } else if (what === 'off') {
    systemctl('disable', '--now', 'holo-update.timer');
    rmSync(join(units, 'holo-update.service'), { force: true });
    rmSync(join(units, 'holo-update.timer'), { force: true });
    systemctl('daemon-reload');
    console.log('Off');
  } else {
    systemctl('list-timers', 'holo-update.timer', '--no-pager');
  }
}

/** A package's scripts folder (node_modules/.bin), or the one pnpm puts node-gyp in. */
const SCRIPTS = /[\\/]node_modules[\\/]\.bin[\\/]?$|[\\/]node-gyp-bin[\\/]?$/;

/**
 * The PATH the runner gets: this one's absolute folders (where the harnesses are), without a package's
 * scripts folders, with node's own first.
 */
export function runnerPath(path, node = process.execPath) {
  const dirs = [dirname(node), ...path.split(':').filter((d) => d && isAbsolute(d) && !SCRIPTS.test(d))];
  return [...new Set(dirs)].join(':');
}

/** The first `name` on PATH that can be run, or null. */
function onPath(name, path) {
  for (const d of path.split(':')) {
    try {
      accessSync(join(d, name), constants.X_OK);
      return join(d, name);
    } catch {}
  }
  return null;
}

/** The runner's unit: from this checkout, as you, its packages first (the checkout may have moved). */
export function runnerUnit(repo, node, path, pnpm) {
  return [
    '[Unit]',
    "Description=HO[LO] Desk: the runner (creations' renders, and the agent's harness when the agent is on)",
    '',
    '[Service]',
    `WorkingDirectory=${dir(repo)}`,
    `Environment=${quoted(`PATH=${path}`)}`,
    // quick when nothing changed; if it can't (offline, a lockfile being edited), the runner starts anyway
    ...(pnpm ? [`ExecStartPre=-${quoted(pnpm)} install --frozen-lockfile --prefer-offline --filter @holo/cli...`] : []),
    `ExecStart=${quoted(node)} --env-file-if-exists=.env --disable-warning=ExperimentalWarning ${quoted(join(repo, 'packages/cli/src/main.ts'))} runner`,
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function runnerService(what) {
  if (process.platform !== 'linux')
    throw new Error(
      'The runner as a service uses systemd (Linux): elsewhere, keep `pnpm runner` running in a terminal',
    );
  const unit = join(units, RUNNER_UNIT);
  if (what === 'on') {
    const path = runnerPath(process.env.PATH ?? '');
    const pnpm = onPath('pnpm', path);
    mkdirSync(units, { recursive: true });
    writeFileSync(unit, runnerUnit(root, process.execPath, path, pnpm));
    if (!systemctl('daemon-reload') || !systemctl('enable', RUNNER_UNIT) || !systemctl('restart', RUNNER_UNIT))
      throw new Error('systemctl --user could not start the runner');
    console.log(
      'On: the runner runs as you, now, and starts again after each update.' +
        (pnpm ? '' : '\n(pnpm isn’t on your PATH: after an update its packages wait for `pnpm install`.)') +
        '\nIt finds a harness (Claude Code, Codex, Cursor, Antigravity) on the PATH you have now: install one later in a new' +
        ' folder, and run `pnpm run runner-service on` again.' +
        '\nIts log: journalctl --user -u holo-runner' +
        `\n${lingerNote('the runner', lingering())}`,
    );
  } else if (what === 'off') {
    systemctl('disable', '--now', RUNNER_UNIT);
    rmSync(unit, { force: true });
    systemctl('daemon-reload');
    console.log('Off');
  } else {
    systemctl('status', RUNNER_UNIT, '--no-pager', '--lines=5');
  }
}

if (import.meta.main) {
  try {
    if (command === 'update') await update(arg);
    else if (command === 'source') source();
    else if (command === 'tick') await tick();
    else if (command === 'autoupdate') autoupdate(arg ?? 'status');
    else if (command === 'runner-service') runnerService(arg ?? 'status');
    else
      console.log(
        readFileSync(import.meta.filename, 'utf8')
          .split('\nimport')[0]
          .replace(/^\/\/ ?/gm, ''),
      );
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
