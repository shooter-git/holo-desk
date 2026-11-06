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
//
// The mode lives in .env (HOLO_IMAGE), so every `docker compose` command (pnpm lan, pnpm down) agrees.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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

/** A studio playing or recording right now (the server says): an update waits for the next look. */
async function busy() {
  const port = readEnv().values.HOLO_PORT || '47800';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) });
    return (await res.json()).busy === true;
  } catch {
    return false; // not running: nothing to interrupt
  }
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
  if (imageId(image) === before) return;
  console.log(`New ${image}: starting it`);
  compose('up', '-d', '--no-build', 'holo');
}

const units = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd/user');
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

try {
  if (command === 'update') await update(arg);
  else if (command === 'source') source();
  else if (command === 'tick') await tick();
  else if (command === 'autoupdate') autoupdate(arg ?? 'status');
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
