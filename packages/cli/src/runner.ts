/**
 * The creation runner (`pnpm runner`, or `holo runner`): runs a creation's own renderer on this
 * computer when the studio asks, so you can hear a song as the creation itself plays it (its samples,
 * its halls, its mastering) beside HO[LO]'s mix.
 *
 * HO[LO]'s server never runs commands (it may be in Docker, and anyone on your network can reach it).
 * The runner does, and only one kind: the render command a creation declares in its own
 * holo.creation.json, with the piece's name checked, the song handed over as a session file in a
 * scratch folder and the renderer told to write only into another. The WAV it makes is added to the
 * song as an audio track, soloed, as one undoable step.
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { newAudioTrack, newRegion, type Op, type Project, secondsToTick } from '@holo/session';

interface RenderSpec {
  command: string[];
  env?: Record<string, string>;
  output: string;
}

interface Manifest {
  format: string;
  name: string;
  title: string;
  render?: RenderSpec;
}

interface Job {
  id: string;
  creation: string;
  piece: string;
  project: string;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LIMIT_MS = 45 * 60 * 1000;

function findCreation(dir: string, name: string): { root: string; manifest: Manifest } | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const file = join(dir, entry.name, 'holo.creation.json');
    if (!existsSync(file)) continue;
    try {
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
      if (manifest.format === 'holo-creation' && manifest.name === name)
        return { root: join(dir, entry.name), manifest };
    } catch {
      // not readable
    }
  }
  return null;
}

/** The file a render wrote: the output path, whose last part may be a pattern ("*.wav"). */
function outputFile(path: string): string | null {
  const name = basename(path);
  if (!name.includes('*')) return existsSync(path) ? path : null;
  const dir = dirname(path);
  if (!existsSync(dir)) return null;
  const re = new RegExp(
    `^${name
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  const hits = readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return hits[0] ?? null;
}

export async function runner(base: string, creationsDir: string): Promise<void> {
  const name = `runner on ${hostname()}`;
  const queue: Job[] = [];
  let busy = false;
  let ws: WebSocket | null = null;
  const send = (msg: unknown) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${base}${path}`, init);
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `${path}: ${res.status}`);
    return body;
  };

  async function run(job: Job): Promise<void> {
    const started = Date.now();
    const say = (line: string) => {
      console.log(`[${job.piece}] ${line}`);
      send({ type: 'render-progress', id: job.id, line });
    };
    const found = findCreation(creationsDir, job.creation);
    const spec = found?.manifest.render;
    if (!found || !spec || !NAME.test(job.piece) || !Array.isArray(spec.command) || !spec.command.length) {
      throw new Error(`${job.creation} has no render command in its holo.creation.json (in ${creationsDir})`);
    }
    const scratch = mkdtempSync(join(tmpdir(), 'holo-render-'));
    try {
      const sessions = join(scratch, 'sessions');
      const out = join(scratch, 'out');
      mkdirSync(sessions);
      mkdirSync(out);
      const session = await fetch(`${base}/api/renders/${job.id}/session`);
      if (!session.ok) throw new Error('The song could not be read from HO[LO]');
      const text = await session.text();
      writeFileSync(join(sessions, `${job.piece}.holo.json`), text);
      // and its own audio files beside it, as Send leaves them in the creation (<piece>.audio/)
      for (const f of (JSON.parse(text) as Project).files ?? []) {
        if (!/^aud_[a-z0-9]+$/.test(f.id)) continue;
        const res = await fetch(`${base}/api/projects/${job.project}/files/${f.id}`);
        if (!res.ok) continue;
        const ext = /\.[a-z0-9]{2,5}$/i.exec(f.name)?.[0]?.toLowerCase() ?? '.wav';
        mkdirSync(join(sessions, `${job.piece}.audio`), { recursive: true });
        writeFileSync(join(sessions, `${job.piece}.audio`, `${f.id}${ext}`), new Uint8Array(await res.arrayBuffer()));
      }
      const fill = (s: string) =>
        s.replaceAll('{piece}', job.piece).replaceAll('{out}', out).replaceAll('{sessions}', sessions);
      const [cmd, ...args] = spec.command.map(fill);
      const env = {
        ...process.env,
        ...Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, fill(v)])),
      };
      say(`${found.manifest.title} renders ${job.piece}: ${[cmd, ...args].join(' ')}`);
      const tail: string[] = [];
      const code = await new Promise<number>((done, fail) => {
        const child = spawn(cmd as string, args, { cwd: found.root, env, stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          fail(new Error(`The render took longer than ${LIMIT_MS / 60000} minutes`));
        }, LIMIT_MS);
        let last = 0;
        let pending = '';
        const lines = (chunk: Buffer) => {
          const text = pending + chunk.toString();
          const parts = text.split(/\r?\n/);
          pending = parts.pop() ?? '';
          for (const raw of parts) {
            const line = raw.trimEnd();
            if (!line) continue;
            tail.push(line);
            if (tail.length > 20) tail.shift();
            // a few lines a second is plenty for a progress line
            const now = Date.now();
            if (now - last > 300) {
              last = now;
              say(line);
            }
          }
        };
        child.stdout.on('data', lines);
        child.stderr.on('data', lines);
        child.on('error', (err) => {
          clearTimeout(timer);
          fail(err);
        });
        child.on('close', (c) => {
          clearTimeout(timer);
          done(c ?? 1);
        });
      });
      if (code !== 0) throw new Error(`The renderer stopped (exit ${code}):\n${tail.slice(-8).join('\n')}`);
      const file = outputFile(fill(spec.output));
      if (!file || !resolve(file).startsWith(resolve(out) + sep)) {
        throw new Error(`The renderer finished but wrote no ${spec.output} into the scratch folder`);
      }
      say(`uploading ${(statSync(file).size / 1e6).toFixed(1)} MB`);
      const title = found.manifest.title;
      const up = await api<{ id: string; seconds?: number; rate?: number; channels?: number }>(
        `/api/projects/${job.project}/files?name=${encodeURIComponent(`${title} render of ${job.piece}.wav`)}`,
        { method: 'POST', headers: { 'content-type': 'application/x-holo-audio' }, body: readFileSync(file) },
      );
      if (!up.seconds || !up.rate || !up.channels) throw new Error('HO[LO] could not read the rendered WAV');
      // on its own track at the top, replacing the last render, soloed so Play is the creation's sound
      const project = await api<Project>(`/api/projects/${job.project}`);
      const trackId = `trk_render_${job.creation.replace(/[^a-z0-9]/g, '_')}`;
      const existing = project.tracks.find((t) => t.id === trackId);
      const ops: Op[] = [
        {
          op: 'addFile',
          file: {
            id: up.id,
            name: `${title} render of ${job.piece}.wav`,
            seconds: up.seconds,
            rate: up.rate,
            channels: up.channels,
          },
        },
      ];
      if (existing) for (const r of existing.regions) ops.push({ op: 'removeRegion', track: trackId, region: r.id });
      else
        ops.push({ op: 'addTrack', track: { ...newAudioTrack(`${title} render`, '#9aa3b2'), id: trackId }, index: 0 });
      const length = Math.max(1, Math.round(secondsToTick(project.tempo, up.seconds)));
      const region = newRegion(0, length, `Rendered by ${title}`);
      region.audio = { file: up.id, offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 };
      ops.push(
        { op: 'addRegion', track: trackId, region },
        { op: 'updateChannel', target: trackId, patch: { solo: true } },
      );
      await api(`/api/projects/${job.project}/ops`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ops,
          author: title,
          label: `its own render of ${job.piece} (soloed: unsolo it to hear the studio's mix)`,
        }),
      });
      console.log(`[${job.piece}] done in ${Math.round((Date.now() - started) / 1000)} s`);
      send({ type: 'render-done', id: job.id });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  const next = async () => {
    if (busy) return;
    const job = queue.shift();
    if (!job) return;
    busy = true;
    try {
      await run(job);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${job.piece}] failed: ${message}`);
      send({ type: 'render-failed', id: job.id, error: message });
    } finally {
      busy = false;
      void next();
    }
  };

  const connect = () => {
    const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/api/live`);
    ws = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'hello', role: 'runner', name }));
      console.log(`Creation runner connected to ${base} (creations in ${creationsDir}). Waiting for renders…`);
    };
    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as Record<string, unknown>;
        if (msg.type !== 'render') return;
        queue.push({
          id: String(msg.id),
          creation: String(msg.creation),
          piece: String(msg.piece),
          project: String(msg.project),
        });
        void next();
      } catch {
        // not for us
      }
    };
    socket.onclose = () => {
      ws = null;
      setTimeout(connect, 3000);
    };
    socket.onerror = () => undefined;
  };
  connect();
  await new Promise<never>(() => undefined);
}
