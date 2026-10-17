// Opens HO[LO] to your own devices over HTTPS with a trusted certificate, through Tailscale Serve:
//   pnpm tailnet on | off | status
// Browsers only allow MIDI and low-latency audio on a secure page, so a laptop, another computer or a
// phone on your tailnet opens https://<this machine>.<tailnet>.ts.net:<HOLO_TAILNET_HTTPS>. Only
// devices signed in to your tailnet can reach it. Nothing else in Tailscale's configuration changes.
import { execFileSync } from 'node:child_process';

const [command = 'status'] = process.argv.slice(2);
const local = Number(process.env.HOLO_PORT ?? 47800);
const port = Number(process.env.HOLO_TAILNET_HTTPS ?? 47801);
const target = `http://127.0.0.1:${local}`;

const tailscale = (...args) => execFileSync('tailscale', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let host;
try {
  host = JSON.parse(tailscale('status', '--json')).Self.DNSName.replace(/\.$/, '');
} catch {
  console.error('Tailscale is not installed or not connected on this machine.');
  process.exit(1);
}

const serving = () => {
  try {
    const config = JSON.parse(tailscale('serve', 'status', '--json') || '{}');
    if (!config.TCP?.[String(port)]) return null;
    return config.Web?.[`${host}:${port}`]?.Handlers?.['/']?.Proxy ?? 'something else';
  } catch {
    return null;
  }
};

const url = `https://${host}:${port}`;
if (command === 'on') {
  const now = serving();
  if (now && now !== target) {
    console.error(`Tailnet port ${port} already serves ${now}. Set HOLO_TAILNET_HTTPS in .env to a free port.`);
    process.exit(1);
  }
  tailscale('serve', '--bg', `--https=${port}`, target);
  console.log(`On: ${url}`);
  console.log('Open it on any device signed in to your Tailscale (with Tailscale on).');
} else if (command === 'off') {
  if (serving() === target) tailscale('serve', `--https=${port}`, 'off');
  console.log('Off.');
} else {
  const now = serving();
  console.log(
    now === target
      ? `On: ${url} → ${target}`
      : now
        ? `Port ${port} serves ${now}`
        : `Off (${url} would serve ${target})`,
  );
}
