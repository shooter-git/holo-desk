/**
 * Stopping the server (SIGTERM, Ctrl C) with the live channel in use: a runner and a studio connected,
 * a peer that never answers the goodbye, and a long request under way. It closes within a couple of
 * seconds; before, a peer that didn't answer held it up for 30 s.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { type AddressInfo, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runnerKey } from '../src/agent/keys.ts';
import { buildApp } from '../src/app.ts';

let work = '';
afterEach(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  work = '';
});

/** A live-channel connection, as the runner and the studio make one: its close code, once closed. */
function client(port: number, hello: Record<string, unknown>) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live`);
  const closed = new Promise<number>((done) => {
    ws.onclose = (e) => done(e.code);
  });
  const open = new Promise<void>((done, fail) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', ...hello }));
      done();
    };
    ws.onerror = () => fail(new Error('The live channel refused the connection'));
  });
  return { ws, open, closed };
}

describe('stopping the server', () => {
  it('closes the live channel’s connections and what’s under way, and is done within a couple of seconds', async () => {
    work = mkdtempSync(join(tmpdir(), 'holo-shutdown-test-'));
    const dataDir = join(work, 'data');
    const { app, services } = await buildApp({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      creationsDir: null,
      webDir: join(work, 'no-web'),
      repoDir: resolve(import.meta.dirname, '../../..'),
      networkMidi: null,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    const runner = client(port, {
      role: 'runner',
      name: 'runner',
      key: runnerKey(dataDir),
      caps: { render: true, agent: true },
    });
    const studio = client(port, { role: 'editor', name: 'studio' });
    await Promise.all([runner.open, studio.open]);

    // a peer that upgrades, then reads nothing and never answers the server's goodbye
    const silent = connect(port, '127.0.0.1');
    await new Promise((done) => silent.once('connect', done));
    silent.write(
      `GET /api/live HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    const upgraded = await new Promise<string>((done) => silent.once('data', (d: Buffer) => done(d.toString())));
    expect(upgraded).toMatch(/^HTTP\/1\.1 101/);
    silent.pause();
    const silentGone = new Promise<void>((done) => silent.once('close', () => done()));
    silent.on('error', () => undefined);

    // a request that would wait a minute: listening to the studio
    await expect.poll(() => services.live.editor() !== null).toBe(true);
    const listen = fetch(`http://127.0.0.1:${port}/api/live/listen?seconds=60`).then(
      (res) => res.status,
      () => 'dropped',
    );
    await new Promise((done) => setTimeout(done, 100));

    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(2500);
    // the runner and the studio were told the server is going away; the rest was dropped
    expect(await runner.closed).toBe(1001);
    expect(await studio.closed).toBe(1001);
    silent.resume();
    await silentGone;
    expect(await listen).toBe('dropped');
  }, 15_000);
});
