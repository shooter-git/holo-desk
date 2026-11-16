/**
 * `holo pair`: a code that pairs a phone or computer with the in-studio agent, printed here, on the
 * computer HO[LO] runs on. It proves it runs here, as HO[LO]'s owner, with the runner key (as the
 * runner does), so it needs no runner and no studio. With the code it prints a link for each way this
 * setup already opens HO[LO] to other devices (`pnpm tailnet on`, `pnpm lan on`) and for this computer,
 * which opens Settings › Agent with the code filled in, and a QR code for the first one a phone can reach.
 */
import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import qrcode from 'qrcode-generator';
import { readRunnerKey, runnerKeyFile } from './runner-key.ts';

/** A studio address this setup serves, and where it reaches. */
export interface StudioLink {
  url: string;
  where: string;
  /** Another device can open it (a QR code is for one of these). */
  remote: boolean;
}

/** The link that fills a code in: in the fragment, which never reaches a server, and the studio drops once read. */
export const pairLink = (origin: string, code: string): string => `${origin.replace(/\/+$/, '')}/#agent-pair=${code}`;

/**
 * The address `pnpm tailnet on` serves HO[LO] at (tools/tailnet.mjs), from Tailscale's status and Serve
 * configuration (each as JSON): only while it serves this HO[LO] there.
 */
export function tailnetOrigin(status: string, serve: string, port: number, local: number): string | null {
  try {
    const host = String(JSON.parse(status)?.Self?.DNSName ?? '').replace(/\.$/, '');
    if (!/^[\w.-]+$/.test(host)) return null;
    const proxy = JSON.parse(serve || '{}')?.Web?.[`${host}:${port}`]?.Handlers?.['/']?.Proxy;
    return proxy === `http://127.0.0.1:${local}` ? `https://${host}:${port}` : null;
  } catch {
    return null;
  }
}

/** The addresses `pnpm lan on` wrote (HOLO_LAN_SITES in .env, tools/lan.mjs). */
export function lanSites(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter((s) => /^https:\/\/[^\s/]+$/.test(s));
}

/** Whether something answers at this address's host and port (the network's HTTPS proxy is running). */
function answers(site: string, ms = 800): Promise<boolean> {
  const url = new URL(site);
  return new Promise((done) => {
    const socket = connect({ host: url.hostname, port: Number(url.port || 443) });
    const end = (ok: boolean) => {
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(ms, () => end(false));
    socket.once('connect', () => end(true));
    socket.once('error', () => end(false));
  });
}

/** The studio's addresses this setup serves: the tailnet's, the network's, then the server's own. */
export async function studioLinks(base: string, env: NodeJS.ProcessEnv = process.env): Promise<StudioLink[]> {
  const links: StudioLink[] = [];
  const local = Number(env.HOLO_PORT ?? 47800);
  try {
    const run = (...args: string[]) =>
      execFileSync('tailscale', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 });
    const origin = tailnetOrigin(
      run('status', '--json'),
      run('serve', 'status', '--json'),
      Number(env.HOLO_TAILNET_HTTPS ?? 47801),
      local,
    );
    if (origin) links.push({ url: origin, where: 'your tailnet', remote: true });
  } catch {
    // no Tailscale here
  }
  const sites = lanSites(env.HOLO_LAN_SITES);
  if (sites[0] && (await answers(sites[0])))
    for (const url of sites) links.push({ url, where: 'your network (pnpm lan)', remote: true });
  const own = new URL(base);
  const here = /^(localhost|127\.[\d.]+|\[::1\])$/.test(own.hostname);
  links.push({ url: own.origin, where: here ? 'this computer' : 'HOLO_URL', remote: !here });
  return links;
}

/** A QR code as text for a terminal: two rows of modules a line, dark on white whatever its colors. */
export function terminalQr(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2;
  const dark = (r: number, c: number) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  const lines: string[] = [];
  for (let r = -quiet; r < n + quiet; r += 2) {
    let line = '';
    for (let c = -quiet; c < n + quiet; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(`\x1b[30;107m${line}\x1b[0m`);
  }
  return lines.join('\n');
}

/** What `holo pair` prints: the code, how long it works, and the links that fill it in. */
export function pairText(code: string, expires: number, links: StudioLink[], now = Date.now()): string {
  const minutes = Math.max(1, Math.round((expires - now) / 60_000));
  const width = Math.max(...links.map((l) => pairLink(l.url, code).length));
  const out = [
    `Pairing code: ${code} (it works once, for ${minutes} minute${minutes === 1 ? '' : 's'})`,
    '',
    'On the phone or computer to pair: open HO[LO], then Settings › Agent › On, and enter it.',
    'Or open one of these there, which fills it in:',
    ...links.map((l) => `  ${pairLink(l.url, code).padEnd(width)}   ${l.where}`),
  ];
  if (!links.some((l) => l.remote))
    out.push(
      '',
      'Another device reaches HO[LO] once pnpm tailnet on (a tailnet) or pnpm lan on (your network) is on:',
      'then this prints a link to it too, with a QR code.',
    );
  return out.join('\n');
}

export async function pair(base: string, repo: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const key = readRunnerKey(repo, env);
  if (!key)
    throw new Error(
      `holo pair proves it runs on HO[LO]'s computer with the runner key, which couldn't be read (${runnerKeyFile(repo, env)}, or HOLO_RUNNER_KEY). Run it there, from HO[LO]'s checkout, once HO[LO] has started.`,
    );
  let res: Response;
  try {
    res = await fetch(`${base}/api/agent/pairing`, { method: 'POST', headers: { 'x-holo-runner-key': key } });
  } catch {
    throw new Error(
      `HO[LO] isn't answering at ${base}. Start it (pnpm start, or pnpm run update for Docker) or set HOLO_URL.`,
    );
  }
  const data = (await res.json().catch(() => ({}))) as { code?: unknown; expires?: unknown; error?: unknown };
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : `HO[LO] answered ${res.status}`);
  if (typeof data.code !== 'string' || typeof data.expires !== 'number')
    throw new Error('This HO[LO] is older than holo pair: update it (the runner prints the code meanwhile)');
  const links = await studioLinks(base, env);
  console.log(pairText(data.code, data.expires, links));
  const first = links.find((l) => l.remote);
  if (first && process.stdout.isTTY) {
    console.log(`\n${terminalQr(pairLink(first.url, data.code))}`);
    console.log(`Scan it with the phone's camera: it opens the link for ${first.where}.`);
  }
}
