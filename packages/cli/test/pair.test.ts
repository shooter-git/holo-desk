import { describe, expect, it } from 'vitest';
import { lanSites, pairLink, pairText, type StudioLink, tailnetOrigin, terminalQr } from '../src/pair.ts';

const status = JSON.stringify({ Self: { DNSName: 'studio.example-tailnet.ts.net.' } });
const serving = (port: number, proxy: string) =>
  JSON.stringify({
    TCP: { [String(port)]: { HTTPS: true } },
    Web: { [`studio.example-tailnet.ts.net:${port}`]: { Handlers: { '/': { Proxy: proxy } } } },
  });

describe('holo pair', () => {
  it('puts the code in the link’s fragment', () => {
    expect(pairLink('https://studio.example:47801/', '012345')).toBe('https://studio.example:47801/#agent-pair=012345');
  });

  it('links the tailnet address only while pnpm tailnet serves this HO[LO] there', () => {
    expect(tailnetOrigin(status, serving(47801, 'http://127.0.0.1:47800'), 47801, 47800)).toBe(
      'https://studio.example-tailnet.ts.net:47801',
    );
    // another port, another target, nothing served, or Tailscale saying nonsense
    expect(tailnetOrigin(status, serving(47802, 'http://127.0.0.1:47800'), 47801, 47800)).toBeNull();
    expect(tailnetOrigin(status, serving(47801, 'http://127.0.0.1:3000'), 47801, 47800)).toBeNull();
    expect(tailnetOrigin(status, '', 47801, 47800)).toBeNull();
    expect(tailnetOrigin('not json', '{}', 47801, 47800)).toBeNull();
    expect(tailnetOrigin(JSON.stringify({ Self: { DNSName: 'bad name;' } }), '{}', 47801, 47800)).toBeNull();
  });

  it('reads the network’s addresses pnpm lan wrote', () => {
    expect(lanSites('https://192.168.1.20:47843, https://studio:47843')).toEqual([
      'https://192.168.1.20:47843',
      'https://studio:47843',
    ]);
    expect(lanSites('"https://10.0.0.5:47843"')).toEqual(['https://10.0.0.5:47843']);
    expect(lanSites(undefined)).toEqual([]);
    expect(lanSites('http://plain:80, https://with/path, nonsense')).toEqual([]);
  });

  it('prints the code, how long it works, and a link for each address', () => {
    const now = 1_000_000;
    const links: StudioLink[] = [
      { url: 'https://studio.example-tailnet.ts.net:47801', where: 'your tailnet', remote: true },
      { url: 'http://127.0.0.1:47800', where: 'this computer', remote: false },
    ];
    const text = pairText('012345', now + 10 * 60_000, links, now);
    expect(text).toMatch(/^Pairing code: 012345 \(it works once, for 10 minutes\)/);
    expect(text).toContain('https://studio.example-tailnet.ts.net:47801/#agent-pair=012345   your tailnet');
    expect(text).toContain('http://127.0.0.1:47800/#agent-pair=012345');
    expect(text).not.toContain('pnpm tailnet on');
    // nothing another device can reach: how to open HO[LO] to one
    const alone = pairText('012345', now + 60_000, [links[1] as StudioLink], now);
    expect(alone).toContain('for 1 minute)');
    expect(alone).toContain('pnpm tailnet on');
  });

  it('draws a QR code two rows a line, dark on white, with a quiet zone', () => {
    const qr = terminalQr('https://studio.example-tailnet.ts.net:47801/#agent-pair=012345');
    const lines = qr.split('\n');
    const plain = lines.map((l) => l.replace(new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*m`, 'g'), ''));
    const width = plain[0]?.length ?? 0;
    expect(plain.every((l) => l.length === width)).toBe(true);
    expect(lines.length).toBe(Math.ceil(width / 2));
    expect(lines.every((l) => l.startsWith('\x1b[30;107m') && l.endsWith('\x1b[0m'))).toBe(true);
    // the quiet zone: the first line and each line's first two columns are light
    expect(plain[0]?.trim()).toBe('');
    expect(plain.every((l) => l.startsWith('  '))).toBe(true);
  });
});
