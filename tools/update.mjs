// HO[LO] in Docker, kept up to date (`pnpm run update`, `pnpm run up`, `pnpm run autoupdate`).
//
//   update [main|stable]   follow the image CI publishes (ghcr.io/shooter-git/holo-desk:<channel>):
//                          pull it and start it. The channel is kept in .env (HOLO_CHANNEL).
//   source                 build from this checkout instead (holo-desk:local): your own changes. Auto-update
//                          waits until you run `update` again, so it never replaces your build.
//   autoupdate on|off|status
//                          a timer (systemd, as you) that runs `tick` every 15 minutes
//   tick                   one look: when following a channel and no studio is playing or recording, pull;
//                          a new image is started, the same one changes nothing
//   runner-service on|off|status
//                          the runner (`pnpm runner`: creations' renders, and the agent's harness when the
//                          agent is on) as a service (systemd, as you), started again after each update
//
// The mode lives in .env (HOLO_IMAGE), so every `docker compose` command (pnpm lan, pnpm down) agrees.
//
// Following a channel also keeps this checkout at the code of the image it runs (a release's tag on
// stable, main's head on main), so its compose file, its tools and the runner (which runs from it) match
// the server. Only a checkout that's following moves: no change to its files, and on no branch or on one
// with nothing its remote lacks. Anything else is someone's work, and stays as it is.
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const envFile = join(root, '.env');
const LOCAL = 'holo-desk:local';
const REPO = process.env.HOLO_IMAGE_REPO ?? 'ghcr.io/shooter-git/holo-desk';
const [command = 'update', arg] = process.argv.slice(2);

function readEnv() {
  if (!existsSync(envFile)) writeFileSync(envFile, readFileSync(join(root, '.env.example'), 'utf8'));
  const text = readFileSync(envFile, 'utf8');
  const values = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) values[m[1]] = m[2];
  }
  return { text, values };
}

function setEnv(key, value) {
  const { text } = readEnv();
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  writeFileSync(envFile, re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, '\n')}${line}\n`);
}

function compose(...args) {
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
 * no change to its tracked files, and on no branch or on one with nothing its upstream lacks. Untracked
 * files (.env, data) don't count. The commit it moved to, or null when it stayed (already there, someone's
 * work, or no such target).
 */
export function followCheckout(cwd, target) {
  const to = git(cwd, 'rev-parse', '-q', '--verify', `${target}^{commit}`);
  if (!to || git(cwd, 'rev-parse', 'HEAD') === to) return null;
  if (git(cwd, 'status', '--porcelain', '--untracked-files=no') !== '') return null;
  if (git(cwd, 'symbolic-ref', '-q', 'HEAD') !== null) {
    // on a branch: only one with an upstream and nothing of its own
    if (git(cwd, 'rev-parse', '-q', '--verify', '@{upstream}') === null) return null;
    if (git(cwd, 'rev-list', '--count', '@{upstream}..HEAD') !== '0') return null;
  }
  return git(cwd, 'checkout', '-q', '--detach', to) === null ? null : to;
}

/** This checkout at the code of the image the server runs; when it moves, the server and the runner start again from it. */
async function follow(image) {
  let target;
  if (image.endsWith(':main')) {
    if (git(root, 'fetch', '-q', 'origin', 'main') === null) return;
    target = 'refs/remotes/origin/main';
  } else {
    const version = await runningVersion();
    if (!version || git(root, 'fetch', '-q', '--tags', 'origin') === null) return;
    target = `refs/tags/v${version}`;
  }
  const moved = followCheckout(root, target);
  if (!moved) return;
  console.log(`This checkout moved to ${target.replace(/^refs\/(tags|remotes)\//, '')} (${moved.slice(0, 7)})`);
  // its compose file may be new (nothing happens when it isn't), and the runner runs from it
  compose('up', '-d', '--no-build', 'holo');
  if (existsSync(join(units, RUNNER_UNIT))) systemctl('try-restart', RUNNER_UNIT);
}

async function update(channel) {
  const values = readEnv().values;
  const ch = channel ?? values.HOLO_CHANNEL ?? 'stable';
  if (ch !== 'main' && ch !== 'stable') throw new Error('The channel is main (every merge) or stable (each release)');
  const image = `${REPO}:${ch}`;
  setEnv('HOLO_CHANNEL', ch);
  setEnv('HOLO_IMAGE', image);
  console.log(`Following ${image}`);
  compose('pull', 'holo');
  compose('up', '-d', '--no-build', 'holo');
  await follow(image);
}

function source() {
  execFileSync(process.execPath, [join(root, 'tools/engine-stamp.mjs')], { cwd: root, stdio: 'inherit' });
  setEnv('HOLO_IMAGE', LOCAL);
  console.log(`Building ${LOCAL} from this checkout (auto-update waits until \`pnpm run update\`)`);
  compose('up', '-d', '--build', 'holo');
}

async function tick() {
  const { values } = readEnv();
  const image = values.HOLO_IMAGE;
  if (!image || image === LOCAL || !image.startsWith(`${REPO}:`)) {
    console.log('Built from this checkout: auto-update waits (`pnpm run update` to follow a channel again)');
    return;
  }
  if (await busy()) {
    console.log('A studio is playing or recording: next time');
    return;
  }
  const before = imageId(image);
  compose('pull', '--quiet', 'holo');
  if (imageId(image) !== before) {
    console.log(`New ${image}: starting it`);
    compose('up', '-d', '--no-build', 'holo');
  }
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
        '\nTo keep it running while you are logged out: loginctl enable-linger',
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
      'On: the runner runs as you, now and whenever you log in, and starts again after each update.' +
        (pnpm ? '' : '\n(pnpm isn’t on your PATH: after an update its packages wait for `pnpm install`.)') +
        '\nIt finds a harness (Claude Code, Codex, Cursor) on the PATH you have now: install one later in a new' +
        ' folder, and run `pnpm run runner-service on` again.' +
        '\nIts log: journalctl --user -u holo-runner. To keep it running while you are logged out: loginctl enable-linger',
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
