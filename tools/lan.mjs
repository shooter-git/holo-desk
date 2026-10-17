// HTTPS on your local network, for devices that aren't on a tailnet: `pnpm lan on | off | status`.
//
// A Caddy container (deploy/compose.yml, profile "lan") answers on this machine's network addresses
// with certificates from its own certificate authority. Each device installs that authority's root
// certificate once (http://<this machine>:47844/holo-ca.crt), then opens https://<address>:47843.
// HO[LO] has no accounts: anyone on your network can use it while this is on.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const envFile = join(repo, '.env');
const [command = 'status'] = process.argv.slice(2);
const https = Number(process.env.HOLO_LAN_HTTPS ?? 47843);
const caPort = Number(process.env.HOLO_LAN_CA ?? 47844);
const compose = (...args) =>
  execFileSync(
    'docker',
    [
      'compose',
      '--project-directory',
      repo,
      '-f',
      join(repo, 'deploy/compose.yml'),
      '--env-file',
      envFile,
      '--profile',
      'lan',
      ...args,
    ],
    { stdio: 'inherit' },
  );

/** This machine's addresses on real networks (not Docker's bridges, not tunnels). */
function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (/^(lo|docker|br-|veth|tailscale|wg|tun|utun|virbr|zt)/.test(name)) continue;
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function setEnv(key, value) {
  let text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  const line = `${key}=${value}`;
  text = new RegExp(`^${key}=.*$`, 'm').test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line)
    : `${text.replace(/\n?$/, '\n')}${line}\n`;
  writeFileSync(envFile, text);
}

const names = [...addresses(), hostname().toLowerCase()];
if (command === 'on') {
  const sites = names.map((n) => `https://${n}:${https}`).join(', ');
  setEnv('HOLO_LAN_SITES', `"${sites}"`);
  setEnv('HOLO_LAN_DEFAULT_SNI', names[0]);
  process.env.HOLO_LAN_SITES = sites;
  process.env.HOLO_LAN_DEFAULT_SNI = names[0];
  // made here, as you: Docker would make it as root, and Caddy runs as you
  mkdirSync(resolve(repo, process.env.HOLO_DATA_DIR ?? './data', 'caddy'), { recursive: true });
  compose('up', '-d', 'lan');
  const ip = addresses()[0] ?? hostname();
  console.log(
    `\nOn. On each device, once: install http://${ip}:${caPort}/holo-ca.crt as a trusted certificate authority.`,
  );
  console.log(`Then open ${names.map((n) => `https://${n}:${https}`).join('  or  ')}`);
  console.log('Anyone on this network can use HO[LO] while this is on (it has no accounts). `pnpm lan off` stops it.');
} else if (command === 'off') {
  compose('rm', '-sf', 'lan');
  console.log('Off.');
} else {
  console.log(`Would answer on: ${names.map((n) => `https://${n}:${https}`).join(', ')}`);
  try {
    compose('ps', 'lan');
  } catch {
    // not running
  }
}
