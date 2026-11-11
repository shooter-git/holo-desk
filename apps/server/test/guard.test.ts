import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { guardedPath, hostAllowed, originAllowed } from '../src/guard.ts';

describe('which origins may use the live channel and the agent', () => {
  it('lets in a request with no Origin: the holo command, the runner, curl', () => {
    expect(originAllowed(undefined, '127.0.0.1:47800')).toBe(true);
    expect(originAllowed(undefined, undefined)).toBe(true);
  });

  it('lets in the studio this server (or a proxy keeping the Host) handed out', () => {
    expect(originAllowed('https://holo.example.com', 'holo.example.com')).toBe(true);
    expect(originAllowed('https://holo.example.com', 'holo.example.com:443')).toBe(true);
    expect(originAllowed('http://holo.example.com:8080', 'holo.example.com:8080')).toBe(true);
    // pnpm lan: Caddy keeps the Host, and the machine's bare name is one of its sites
    expect(originAllowed('https://studio-pc:47843', 'studio-pc:47843')).toBe(true);
    // not the same site: another port, another name
    expect(originAllowed('http://holo.example.com:8081', 'holo.example.com:8080')).toBe(false);
    expect(originAllowed('https://holo.example.com.evil.example', 'holo.example.com')).toBe(false);
    // a Host that would read as more than a host doesn't make another site the same one
    expect(originAllowed('https://evil.example', `x${'@'}evil.example`)).toBe(false);
  });

  it('lets in this computer on any port (the Vite dev server on :47810 proxies to the server)', () => {
    expect(originAllowed('http://127.0.0.1:47810', '127.0.0.1:47810')).toBe(true);
    expect(originAllowed('http://127.0.0.1:47810', '127.0.0.1:47800')).toBe(true);
    expect(originAllowed('http://localhost:5173', '127.0.0.1:47800')).toBe(true);
    expect(originAllowed('http://[::1]:47800', '127.0.0.1:47800')).toBe(true);
  });

  it('lets in the local network and tailnets', () => {
    expect(originAllowed('https://192.168.1.20:47843', '127.0.0.1:47800')).toBe(true);
    expect(originAllowed('https://10.0.0.5:47843', '127.0.0.1:47800')).toBe(true);
    expect(originAllowed('https://172.20.1.2:47843', '127.0.0.1:47800')).toBe(true);
    expect(originAllowed('https://100.101.102.103:47801', '127.0.0.1:47800')).toBe(true);
    expect(originAllowed('https://studio.example.ts.net:47801', '127.0.0.1:47800')).toBe(true);
    expect(originAllowed('https://studio.local:47843', '127.0.0.1:47800')).toBe(true);
    // public addresses aren't
    expect(originAllowed('https://172.32.0.1', '127.0.0.1:47800')).toBe(false);
    expect(originAllowed('https://8.8.8.8', '127.0.0.1:47800')).toBe(false);
  });

  it('lets in the hosts HOLO_ALLOWED_HOSTS names', () => {
    const allowed = loadConfig({
      HOLO_ALLOWED_HOSTS: 'holo.example.com, studio.example.org:8443,https://music.example.net',
    }).allowedHosts;
    expect(allowed).toEqual(['holo.example.com', 'studio.example.org:8443', 'https://music.example.net']);
    expect(originAllowed('https://holo.example.com', '127.0.0.1:47800', allowed)).toBe(true);
    expect(originAllowed('https://holo.example.com:9000', '127.0.0.1:47800', allowed)).toBe(true);
    expect(originAllowed('https://studio.example.org:8443', '127.0.0.1:47800', allowed)).toBe(true);
    expect(originAllowed('https://studio.example.org', '127.0.0.1:47800', allowed)).toBe(false);
    expect(originAllowed('https://music.example.net', '127.0.0.1:47800', allowed)).toBe(true);
    expect(originAllowed('http://music.example.net', '127.0.0.1:47800', allowed)).toBe(false);
    expect(originAllowed('https://sub.holo.example.com', '127.0.0.1:47800', allowed)).toBe(false);
    expect(loadConfig({}).allowedHosts).toEqual([]);
  });

  it('refuses other sites, and origins that are not sites', () => {
    expect(originAllowed('https://evil.example', '127.0.0.1:47800')).toBe(false);
    expect(originAllowed('https://evil.example', '127.0.0.1:47800', ['holo.example.com'])).toBe(false);
    expect(originAllowed('null', '127.0.0.1:47800')).toBe(false);
    expect(originAllowed('chrome-extension://abcdefghijklmnop', '127.0.0.1:47800')).toBe(false);
    expect(originAllowed('https://localhost.evil.example', '127.0.0.1:47800')).toBe(false);
    expect(originAllowed('not a url', '127.0.0.1:47800')).toBe(false);
  });

  it('lets in requests for HO[LO]’s own names: this computer, the network, a tailnet', () => {
    // the holo command, the runner, the studio served here, the Vite dev server (no changeOrigin)
    expect(hostAllowed('127.0.0.1:47800')).toBe(true);
    expect(hostAllowed('127.0.0.1:47810')).toBe(true);
    expect(hostAllowed('localhost:47810')).toBe(true);
    expect(hostAllowed('[::1]:47800')).toBe(true);
    // Tailscale Serve keeps the name the browser asked for
    expect(hostAllowed('studio.example.ts.net:47801')).toBe(true);
    expect(hostAllowed('STUDIO.example.ts.net')).toBe(true);
    expect(hostAllowed('100.101.102.103:47801')).toBe(true);
    // pnpm lan: Caddy keeps the name too, an address or the machine's bare name
    expect(hostAllowed('192.168.1.20:47843')).toBe(true);
    expect(hostAllowed('10.0.0.5')).toBe(true);
    expect(hostAllowed('studio-pc:47843')).toBe(true);
    expect(hostAllowed('studio.local:47843')).toBe(true);
  });

  it('lets in the names HOLO_ALLOWED_HOSTS gives, however they are written', () => {
    for (const entry of [
      'holo.example.com',
      'holo.example.com:8443',
      'https://holo.example.com',
      'HOLO.example.com/',
    ]) {
      expect(hostAllowed('holo.example.com', [entry])).toBe(true);
      expect(hostAllowed('holo.example.com:8443', [entry])).toBe(true);
    }
    expect(hostAllowed('sub.holo.example.com', ['holo.example.com'])).toBe(false);
  });

  it('refuses requests for any other name: a site pointed at this computer (DNS rebinding)', () => {
    expect(hostAllowed(undefined)).toBe(false);
    expect(hostAllowed('')).toBe(false);
    expect(hostAllowed('evil.example')).toBe(false);
    expect(hostAllowed('evil.example:47800')).toBe(false);
    expect(hostAllowed('127.0.0.1.nip.io:47800')).toBe(false);
    expect(hostAllowed('localhost.evil.example')).toBe(false);
    expect(hostAllowed('8.8.8.8')).toBe(false);
    expect(hostAllowed('x@127.0.0.1')).toBe(false);
    expect(hostAllowed('evil.example', ['holo.example.com'])).toBe(false);
  });

  it('covers the live channel and everything under /api/agent, and nothing the CLI uses', () => {
    expect(guardedPath('/api/live')).toBe(true);
    expect(guardedPath('/api/live?x=1')).toBe(true);
    expect(guardedPath('/api/agent')).toBe(true);
    expect(guardedPath('/api/agent/jobs/job_1/ops')).toBe(true);
    expect(guardedPath('/api/agents')).toBe(false);
    expect(guardedPath('/api/live/state')).toBe(false);
    expect(guardedPath('/api/projects/prj_1/ops')).toBe(false);
  });
});

describe('the guard on the server', () => {
  const work = mkdtempSync(join(tmpdir(), 'holo-guard-test-'));
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let port = 0;

  beforeAll(async () => {
    ({ app } = await buildApp({
      port: 0,
      host: '127.0.0.1',
      dataDir: join(work, 'data'),
      creationsDir: null,
      webDir: join(work, 'no-web'),
      repoDir: resolve(import.meta.dirname, '../../..'),
      networkMidi: null,
      allowedHosts: ['holo.example.com'],
    }));
    // a route of the agent's, as later ones will be: the guard covers it without being told
    app.get('/api/agent/probe', async () => ({ ok: true }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
  }, 30_000);
  afterAll(async () => {
    await app.close();
    rmSync(work, { recursive: true, force: true });
  });

  /**
   * A WebSocket upgrade of /api/live, as a browser on the given site would ask for it (for the given
   * name, as a proxy forwards it): its status.
   */
  const upgrade = (origin?: string, host?: string) =>
    new Promise<number>((done, fail) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path: '/api/live',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': randomBytes(16).toString('base64'),
          ...(origin ? { origin } : {}),
          ...(host ? { host } : {}),
        },
      });
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        done(res.statusCode ?? 0);
      });
      req.on('response', (res) => {
        res.resume();
        res.socket.destroy();
        done(res.statusCode ?? 0);
      });
      req.on('error', fail);
      req.end();
    });

  it('refuses the live channel to a page from another site', async () => {
    expect(await upgrade('https://evil.example')).toBe(403);
    expect(await upgrade('null')).toBe(403);
  });

  it('opens it with no Origin, from this computer, the network, a tailnet and the allowed hosts', async () => {
    expect(await upgrade()).toBe(101);
    expect(await upgrade('http://127.0.0.1:47810')).toBe(101);
    expect(await upgrade('http://localhost:47800')).toBe(101);
    expect(await upgrade('https://192.168.1.20:47843')).toBe(101);
    expect(await upgrade('https://studio.example.ts.net:47801')).toBe(101);
    expect(await upgrade('https://holo.example.com')).toBe(101);
  });

  it('opens it for HO[LO]’s own names, as Tailscale Serve, pnpm lan and Vite forward them', async () => {
    expect(await upgrade('http://127.0.0.1:47800', '127.0.0.1:47800')).toBe(101);
    expect(await upgrade('http://127.0.0.1:47810', '127.0.0.1:47810')).toBe(101);
    expect(await upgrade('https://studio.example.ts.net:47801', 'studio.example.ts.net:47801')).toBe(101);
    expect(await upgrade('https://192.168.1.20:47843', '192.168.1.20:47843')).toBe(101);
    expect(await upgrade('https://studio-pc:47843', 'studio-pc:47843')).toBe(101);
    expect(await upgrade('https://holo.example.com', 'holo.example.com')).toBe(101);
  });

  it('refuses it to a site pointed at this computer, even as its own origin', async () => {
    expect(await upgrade('http://evil.example', 'evil.example')).toBe(403);
    expect(await upgrade(`http://evil.example:${port}`, `evil.example:${port}`)).toBe(403);
    expect(await upgrade(undefined, `evil.example:${port}`)).toBe(403);
  });

  it('lets a runner in with no Origin, as Node’s own WebSocket connects', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live`);
    const peers = await new Promise<unknown>((done, fail) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as { type: string; peers?: unknown };
        // (connections the tests above opened may still be closing)
        if (msg.type === 'peers' && JSON.stringify(msg.peers).includes('test runner')) done(msg.peers);
      };
      ws.onerror = () => fail(new Error('The live channel refused the runner'));
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'runner', name: 'test runner' }));
    });
    expect(peers).toContainEqual({ role: 'runner', name: 'test runner' });
    ws.close();
  });

  it('refuses the agent’s routes to another site, and nothing else changes', async () => {
    const probe = (origin?: string) =>
      app.inject({ method: 'GET', url: '/api/agent/probe', headers: origin ? { origin } : {} });
    expect((await probe('https://evil.example')).statusCode).toBe(403);
    expect((await probe()).statusCode).toBe(200);
    expect((await probe('http://127.0.0.1:47810')).statusCode).toBe(200);
    // a same-origin GET from a site pointed at this computer carries no Origin: its name gives it away
    const rebound = await app.inject({ method: 'GET', url: '/api/agent/probe', headers: { host: 'evil.example' } });
    expect(rebound.statusCode).toBe(403);
    const forTailnet = { host: 'studio.example.ts.net:47801', origin: 'https://studio.example.ts.net:47801' };
    expect((await app.inject({ method: 'GET', url: '/api/agent/probe', headers: forTailnet })).statusCode).toBe(200);
    // not routes of the agent's (the CLI's, the studio's): as before, whatever the Origin
    expect(
      (await app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://evil.example' } })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/live/state', headers: { origin: 'https://evil.example' } }))
        .statusCode,
    ).toBe(200);
  });

  /** A request with no Host at all (HTTP/1.0: Node itself answers 400 to HTTP/1.1 without one): its status line. */
  const hostless = (path: string) =>
    new Promise<string>((done, fail) => {
      const socket = connect(port, '127.0.0.1', () => socket.write(`GET ${path} HTTP/1.0\r\n\r\n`));
      let text = '';
      socket.on('data', (d) => {
        text += String(d);
      });
      socket.on('end', () => done(text.split('\r\n')[0] ?? ''));
      socket.on('error', fail);
    });

  it('refuses a request that names no host, and only on the guarded paths', async () => {
    expect(await hostless('/api/agent/probe')).toMatch(/ 403 /);
    expect(await hostless('/api/health')).toMatch(/ 200 /);
  });
});
