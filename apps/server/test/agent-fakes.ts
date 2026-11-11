/**
 * What the agent's tests share: HO[LO]'s server in a scratch data folder, and fake connections on its
 * live channel (a keyed runner that has a harness, studios on allowed devices) that answer as the real
 * ones do.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { newProject, type Project } from '@holo/session';
import type { WebSocket } from 'ws';
import { runnerKey } from '../src/agent/keys.ts';
import { buildApp } from '../src/app.ts';

export type Msg = Record<string, unknown>;

/** A connection as Live sees one: messages in, what it was sent kept, and an answer for what asks one. */
export class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Msg[] = [];
  /** Answers a message that wants one (an ack); null: none. */
  answer: ((msg: Msg) => Msg | Promise<Msg> | null) | null = null;
  send(data: string): void {
    const msg = JSON.parse(data) as Msg;
    this.sent.push(msg);
    const answer = this.answer;
    if (answer && typeof msg.id === 'string') {
      void Promise.resolve()
        .then(() => answer(msg))
        .then((reply) => {
          if (reply) this.say({ type: 'ack', id: msg.id, ...reply });
        });
    }
  }
  say(msg: Msg): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }
  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
  got(type: string): Msg[] {
    return this.sent.filter((m) => m.type === type);
  }
}

export const CLAUDE = {
  id: 'claude',
  name: 'Claude Code',
  found: true,
  sealed: true,
  signedIn: true,
  version: '2.1.0',
};

export async function agentApp() {
  const work = mkdtempSync(join(tmpdir(), 'holo-agent-test-'));
  const dataDir = join(work, 'data');
  const { app, services } = await buildApp({
    port: 47899,
    host: '127.0.0.1',
    dataDir,
    creationsDir: null,
    webDir: join(work, 'no-web'),
    repoDir: resolve(import.meta.dirname, '../../..'),
    networkMidi: null,
  });
  const key = runnerKey(dataDir);
  const { live } = services;

  const connect = (hello: Msg) => {
    const ws = new FakeSocket();
    live.attach(ws as unknown as WebSocket);
    ws.say({ type: 'hello', ...hello });
    return ws;
  };

  /** A runner with the key that runs the agent's jobs and has Claude Code (or what's given). */
  const runner = (harnesses: Msg[] = [CLAUDE], name = 'runner') => {
    const ws = connect({ role: 'runner', name, key, caps: { render: true, agent: true } });
    ws.say({ type: 'harnesses', list: harnesses });
    return ws;
  };

  /**
   * A studio on a device (its agent token) with a song open. It applies nothing; it answers each
   * request (a flush with its song's revision as saved, ops and transport with ok), unless told otherwise.
   */
  const studio = (token: string | null, project: string | null, name = 'studio') => {
    const ws = connect({ role: 'editor', name, ...(token ? { agentToken: token } : {}) });
    ws.say({
      type: 'state',
      state: { project, revision: 0, tick: 0, selection: { track: null, regions: [], notes: 0 } },
    });
    ws.answer = (msg) => {
      const id = typeof msg.project === 'string' ? msg.project : project;
      const revision = id ? (services.store.get(id)?.revision ?? 0) : 0;
      return { ok: true, revision };
    };
    return ws;
  };

  /** Pair the first device with the code a keyed runner was sent: its token. */
  const pair = async (via: FakeSocket, name = 'Desk') => {
    const started = await app.inject({ method: 'POST', url: '/api/agent/pairing' });
    if (started.statusCode !== 200) throw new Error(`pairing: ${started.body}`);
    const code = String(via.got('pairing-code').at(-1)?.code);
    const paired = await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { code, name } });
    if (paired.statusCode !== 200) throw new Error(`pair: ${paired.body}`);
    return paired.json() as { token: string; device: { id: string; name: string } };
  };

  /** A later device, asked for and approved by an allowed one: its token. */
  const admit = async (approver: string, name = 'Phone') => {
    const asked = (
      await app.inject({ method: 'POST', url: '/api/agent/devices/requests', payload: { name } })
    ).json() as {
      id: string;
      secret: string;
    };
    await app.inject({
      method: 'POST',
      url: `/api/agent/devices/requests/${asked.id}/approve`,
      headers: auth(approver),
    });
    const polled = await app.inject({
      method: 'GET',
      url: `/api/agent/devices/requests/${asked.id}?secret=${asked.secret}`,
    });
    return polled.json() as { token: string; device: { id: string; name: string } };
  };

  const song = async (title = 'Song'): Promise<Project> => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: newProject(title) as object });
    return res.json() as Project;
  };

  /** The studio saves a version of the song, as its own save would. */
  const save = async (project: Project): Promise<Project> => {
    const current = services.store.get(project.id) as Project;
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}`,
      payload: { doc: project, baseRevision: current.revision },
    });
    if (res.statusCode !== 200) throw new Error(`save: ${res.body}`);
    return services.store.get(project.id) as Project;
  };

  const close = async () => {
    await app.close();
    rmSync(work, { recursive: true, force: true });
  };

  return { app, services, dataDir, key, connect, runner, studio, pair, admit, song, save, close };
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Let messages sent on a microtask (the fakes' answers) arrive. */
export const settle = () => new Promise((r) => setTimeout(r, 5));

/** Wait until `check` holds (what the server does after a message arrives may take a few turns). */
export async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}
