// Network MIDI for your phone: `pnpm netmidi on | lan | off | status`.
//
// HO[LO] answers as a network MIDI session (RTP-MIDI, built into iOS and macOS) on UDP 5004 and 5005.
// `on` lets your tailnet reach it (an iPhone with Tailscale, anywhere), `lan` your whole local network,
// `off` this machine only. HO[LO] has no accounts: whoever can reach it can play notes into the studio.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const envFile = join(repo, '.env');
const [command = 'status'] = process.argv.slice(2);

function setEnv(key, value) {
  let text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  const line = `${key}=${value}`;
  text = new RegExp(`^${key}=.*$`, 'm').test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line)
    : `${text.replace(/\n?$/, '\n')}${line}\n`;
  writeFileSync(envFile, text);
}

function tailnetAddress() {
  try {
    return execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split('\n')[0] || null;
  } catch {
    for (const [name, list] of Object.entries(networkInterfaces())) {
      if (!/^tailscale/.test(name)) continue;
      for (const a of list ?? []) if (a.family === 'IPv4') return a.address;
    }
    return null;
  }
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (/^(lo|docker|br-|veth|tailscale|wg|tun|utun|virbr|zt)/.test(name)) continue;
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

const restart = () =>
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
      'up',
      '-d',
      'holo',
    ],
    { stdio: 'inherit' },
  );

const tell = (addresses) => {
  console.log('\nOn the iPhone or iPad: plug the keyboard in, then in a MIDI app with network sessions (midimittr,');
  console.log('for one) add a session at this address, port 5004, connect, and route the keyboard to it:');
  for (const a of addresses) console.log(`    ${a}  port 5004`);
  console.log('On a Mac: Audio MIDI Setup → MIDI Studio → Network → Directory, add the same, then Connect.');
  console.log('The studio hears it as a MIDI device named after the phone (Audio & MIDI settings lists it).');
};

if (command === 'on') {
  const ip = tailnetAddress();
  if (!ip) {
    console.error('No tailnet address here. Start Tailscale, or use `pnpm netmidi lan` for your local network.');
    process.exit(1);
  }
  setEnv('HOLO_NETWORK_MIDI_BIND', ip);
  restart();
  tell([ip, `${hostname().toLowerCase()} (its tailnet name)`]);
} else if (command === 'lan') {
  setEnv('HOLO_NETWORK_MIDI_BIND', '0.0.0.0');
  restart();
  tell(lanAddresses());
  console.log('Anyone on this network can send notes into the studio while this is on. `pnpm netmidi off` stops it.');
} else if (command === 'off') {
  setEnv('HOLO_NETWORK_MIDI_BIND', '127.0.0.1');
  restart();
  console.log('Off: network MIDI answers on this machine only.');
} else {
  console.log(`Network MIDI is reachable at: ${process.env.HOLO_NETWORK_MIDI_BIND ?? '127.0.0.1'} (UDP 5004-5005)`);
}
