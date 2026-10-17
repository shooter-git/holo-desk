/**
 * The live channel: the open studio (the "editor"), remotes (a phone by the instruments, running
 * HO[LO] Remote) and the AI's command line all meet here. The editor reports what it's doing
 * (playhead, tracks, selection), and remotes see it as it changes, with the studio's levels; the AI's
 * changes are sent to the editor, which applies them as undoable steps and saves; a remote's commands
 * (play, record, faders…) and the notes it plays go straight to the studio it controls.
 */
import type { WebSocket } from 'ws';

export interface EditorState {
  project: string | null;
  title: string | null;
  revision: number;
  playing: boolean;
  recording: boolean;
  tick: number;
  position: string;
  bpm: number;
  selection: { track: string | null; regions: string[]; notes: number };
  cycle: { on: boolean; start: number; end: number };
  middleC: 'C4' | 'C3';
  midiPorts: string[];
  latencyMs: number | null;
  device: string;
  updated: number;
}

export interface PlayedNote {
  /** Song tick when played (null when the song wasn't playing). */
  tick: number | null;
  /** ms since the listen began. */
  time: number;
  pitch: number;
  velocity: number;
  /** Length in ms (null if still held when the listen ended). */
  length: number | null;
  port: string;
}

/**
 * A creation rendering a piece itself, on the host, through the creation runner (`pnpm runner`): the
 * game's own sound of the song as it is in the studio, brought back as an audio track.
 */
export interface RenderJob {
  id: string;
  project: string;
  creation: string;
  piece: string;
  title: string;
  state: 'waiting' | 'running' | 'done' | 'failed';
  started: number;
  finished: number | null;
  /** The last lines the renderer printed. */
  lines: string[];
  error: string | null;
}

interface Client {
  ws: WebSocket;
  role: 'editor' | 'remote' | 'agent' | 'runner';
  name: string;
  state: EditorState | null;
  /** The song this studio was last brought up to date about (on joining, or opening another). */
  caughtUp: string | null;
}

export type Answer = { ok: boolean; revision?: number; error?: string } & Record<string, unknown>;

interface Pending {
  resolve: (v: Answer) => void;
  timer: NodeJS.Timeout;
}

interface Listener {
  notes: PlayedNote[];
  start: number;
  held: Map<number, PlayedNote>;
}

export class Live {
  private clients = new Set<Client>();
  private pending = new Map<string, Pending>();
  private listeners = new Set<Listener>();
  private counter = 0;
  readonly renders = new Map<string, RenderJob>();
  /**
   * What a studio missed while it wasn't connected (a newer save of its song): asked when it joins or
   * opens another song, so a dropped connection never leaves it showing an old version.
   */
  latestRevision: (project: string) => number | null = () => null;

  attach(ws: WebSocket): void {
    const client: Client = { ws, role: 'remote', name: 'device', state: null, caughtUp: null };
    this.clients.add(client);
    ws.on('message', (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      this.onMessage(client, msg);
    });
    ws.on('close', () => {
      this.clients.delete(client);
      if (client.role === 'editor') this.toRemotes({ type: 'studio-gone', name: client.name });
      this.broadcastPeers();
    });
  }

  private onMessage(client: Client, msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'hello':
        client.role =
          msg.role === 'editor' || msg.role === 'agent' || msg.role === 'runner'
            ? (msg.role as Client['role'])
            : 'remote';
        client.name = typeof msg.name === 'string' ? msg.name.slice(0, 80) : client.role;
        this.broadcastPeers();
        // a remote arriving sees every open studio at once
        if (client.role === 'remote') {
          for (const c of this.clients) {
            if (c.role === 'editor' && c.state) this.send(client, { type: 'studio', name: c.name, state: c.state });
          }
        }
        break;
      case 'state':
        if (client.role === 'editor') {
          client.state = { ...(msg.state as EditorState), updated: Date.now() };
          this.toRemotes({ type: 'studio', name: client.name, state: client.state });
          const project = client.state.project;
          if (project && client.caughtUp !== project) {
            client.caughtUp = project;
            const latest = this.latestRevision(project);
            if (latest !== null && latest > client.state.revision) {
              this.send(client, { type: 'saved', project, revision: latest });
            }
            // a render of this song under way (or just finished) carries on showing
            for (const job of this.renders.values()) {
              if (job.project === project && (job.finished === null || Date.now() - job.finished < 60_000)) {
                this.send(client, { type: 'render-status', job });
              }
            }
          }
        }
        break;
      case 'meters':
        if (client.role === 'editor') this.toRemotes({ type: 'meters', name: client.name, levels: msg.levels });
        break;
      case 'command': {
        // a remote's button or fader: to the studio it chose, or the one most recently active
        const name = typeof msg.studio === 'string' ? msg.studio : null;
        const target = (name && [...this.clients].find((c) => c.role === 'editor' && c.name === name)) || this.editor();
        if (!target) {
          this.send(client, { type: 'notice', text: 'No studio is open. Open HO[LO] on the computer first.' });
          break;
        }
        const { type: _t, studio: _s, ...command } = msg;
        this.send(target, { type: 'command', ...command, from: client.name });
        break;
      }
      case 'ack': {
        const p = this.pending.get(String(msg.id));
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(String(msg.id));
          const { type: _t, id: _i, ...rest } = msg;
          p.resolve({ ...rest, ok: msg.ok === true });
        }
        break;
      }
      case 'midi': {
        // a device on the network: every open studio hears it (and so does a listening AI, once)
        const data = Array.isArray(msg.data) ? (msg.data as number[]) : [];
        const playing = this.editor()?.state;
        this.recordPlayed([
          {
            status: data[0] ?? 0,
            d1: data[1] ?? 0,
            d2: data[2] ?? 0,
            tick: playing?.playing ? playing.tick : null,
            port: client.name,
          },
        ]);
        for (const c of this.clients) {
          if (c.role === 'editor' && c !== client) {
            this.send(c, { type: 'midi', port: `${client.name}`, data: msg.data, sent: msg.sent });
          }
        }
        break;
      }
      case 'render-progress':
      case 'render-done':
      case 'render-failed': {
        if (client.role !== 'runner') break;
        const job = this.renders.get(String(msg.id));
        if (!job) break;
        if (msg.type === 'render-progress') {
          job.state = 'running';
          job.lines = [...job.lines, String(msg.line ?? '')].slice(-12);
        } else {
          job.state = msg.type === 'render-done' ? 'done' : 'failed';
          job.finished = Date.now();
          if (msg.type === 'render-failed') job.error = String(msg.error ?? 'The render failed');
        }
        this.tell({ type: 'render-status', job }, job.project);
        break;
      }
      case 'played':
        // a studio reports what was played on its own device; notes from the network are counted below
        if (client.role === 'editor' && Array.isArray(msg.events)) this.recordPlayed(msg.events as unknown[]);
        break;
    }
  }

  private recordPlayed(events: unknown[]): void {
    if (!this.listeners.size) return;
    for (const e of events) {
      const ev = e as { status: number; d1: number; d2: number; tick: number | null; port: string };
      const kind = ev.status & 0xf0;
      for (const l of this.listeners) {
        const now = Date.now() - l.start;
        if (kind === 0x90 && ev.d2 > 0) {
          const note: PlayedNote = {
            tick: ev.tick,
            time: now,
            pitch: ev.d1,
            velocity: ev.d2,
            length: null,
            port: ev.port,
          };
          l.notes.push(note);
          l.held.set(ev.d1, note);
        } else if (kind === 0x80 || kind === 0x90) {
          const note = l.held.get(ev.d1);
          if (note) {
            note.length = now - note.time;
            l.held.delete(ev.d1);
          }
        }
      }
    }
  }

  private send(c: Client, msg: unknown): void {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }

  private broadcastPeers(): void {
    const peers = [...this.clients].map((c) => ({ role: c.role, name: c.name }));
    for (const c of this.clients) if (c.role !== 'agent') this.send(c, { type: 'peers', peers });
  }

  private toRemotes(msg: Record<string, unknown>): void {
    for (const c of this.clients) if (c.role === 'remote') this.send(c, msg);
  }

  /** The open studio's latest report (the most recently active one if several are open). */
  editor(project?: string): Client | null {
    let best: Client | null = null;
    for (const c of this.clients) {
      if (c.role !== 'editor') continue;
      if (project && c.state?.project !== project) continue;
      if (!best || (c.state?.updated ?? 0) > (best.state?.updated ?? 0)) best = c;
    }
    return best;
  }

  state(): { editor: boolean; state: EditorState | null; peers: { role: string; name: string }[] } {
    const e = this.editor();
    return {
      editor: e !== null,
      state: e?.state ?? null,
      peers: [...this.clients].map((c) => ({ role: c.role, name: c.name })),
    };
  }

  /** Ask an open studio to do something and wait for its answer. */
  request(editor: Client, msg: Record<string, unknown>, timeoutMs = 8000) {
    const id = `r${++this.counter}`;
    return new Promise<Answer>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'The studio did not answer in time' });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.send(editor, { ...msg, id });
    });
  }

  /** Tell every open studio something (no answer expected). */
  tell(msg: Record<string, unknown>, project?: string): number {
    let n = 0;
    for (const c of this.clients) {
      if (c.role !== 'editor' || (project && c.state?.project !== project)) continue;
      this.send(c, msg);
      n++;
    }
    return n;
  }

  /** Notes from a network MIDI device (an iPhone's keyboard, a Mac): every open studio hears them. */
  networkMidi(from: string, data: number[]): void {
    const playing = this.editor()?.state;
    const port = `${from} (network)`;
    this.recordPlayed([
      { status: data[0] ?? 0, d1: data[1] ?? 0, d2: data[2] ?? 0, tick: playing?.playing ? playing.tick : null, port },
    ]);
    for (const c of this.clients) if (c.role === 'editor') this.send(c, { type: 'midi', port, data, sent: Date.now() });
  }

  /** Whether a creation runner is connected (only it can run a creation's renderer). */
  runner(): boolean {
    return [...this.clients].some((c) => c.role === 'runner');
  }

  /** Hand a render to the runner; the studio hears how it goes. */
  render(job: RenderJob): boolean {
    const runner = [...this.clients].find((c) => c.role === 'runner');
    if (!runner) return false;
    this.renders.set(job.id, job);
    // keep the last few
    for (const id of [...this.renders.keys()].slice(0, -20)) this.renders.delete(id);
    this.send(runner, { type: 'render', id: job.id, creation: job.creation, piece: job.piece, project: job.project });
    this.tell({ type: 'render-status', job }, job.project);
    return true;
  }

  /** Collect what is played in the studio for a while. */
  async listen(ms: number): Promise<PlayedNote[]> {
    const l: Listener = { notes: [], start: Date.now(), held: new Map() };
    this.listeners.add(l);
    this.tell({ type: 'listening', ms });
    await new Promise((r) => setTimeout(r, ms));
    this.listeners.delete(l);
    return l.notes;
  }
}
