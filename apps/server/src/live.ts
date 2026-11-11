/**
 * The live channel: the open studio (the "editor"), remotes (a phone by the instruments, running
 * HO[LO] Remote) and the AI's command line all meet here. The editor reports what it's doing
 * (playhead, tracks, selection), and remotes see it as it changes, with the studio's levels; the AI's
 * changes are sent to the editor, which applies them as undoable steps and saves; a remote's commands
 * (play, record, faders…) and the notes it plays go straight to the studio it controls.
 */
import type { WebSocket } from 'ws';
import { sameKey } from './agent/keys.ts';

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

/**
 * What a runner can do: renders, the agent's jobs. (An older runner also says what it had for Scan's
 * old AI buttons, `ai`: that's left out.)
 */
export interface RunnerCaps {
  render: boolean;
  /** It runs the in-app agent's jobs (it says which harnesses it has in a `harnesses` message). */
  agent: boolean;
}

export interface LiveClient {
  ws: WebSocket;
  role: 'editor' | 'remote' | 'agent' | 'runner';
  caps?: RunnerCaps;
  /** A runner that said the runner key: the only kind handed the agent's jobs. */
  keyed?: boolean;
  name: string;
  state: EditorState | null;
  /** The song this studio was last brought up to date about (on joining, or opening another). */
  caughtUp: string | null;
  /** A studio on a device allowed to use the agent (its hello carried the device's token): that device. */
  device: string | null;
}
type Client = LiveClient;

/**
 * The agent's part of the live channel (agent/jobs.ts): the devices' studios, and the runners that
 * run its jobs. Set once the agent is set up; until then nothing of the agent's is accepted.
 */
export interface AgentHooks {
  /** The device an agent token belongs to (null: no device, or not allowed). */
  device(token: string): string | null;
  /** A message for the agent: from a runner (`harnesses`, `agent-*`) or a studio (`history`). */
  message(client: LiveClient, msg: Record<string, unknown>): void;
  /** A studio on an allowed device reported its state; `was` is the song it had open before. */
  state(client: LiveClient, was: string | null): void;
  /** A runner with the key, able to run the agent's jobs, said hello. */
  runner(client: LiveClient): void;
  /** A connection closed. */
  gone(client: LiveClient): void;
}

/** The messages of the agent's that the live channel hands to it. */
const AGENT_MESSAGES = new Set([
  'harnesses',
  'agent-progress',
  'agent-session',
  'agent-done',
  'agent-failed',
  'agent-harness',
  'history',
]);

export type Answer = { ok: boolean; revision?: number; error?: string } & Record<string, unknown>;

/** What `request` answers when the studio doesn't in time. */
export const NO_ANSWER = 'The studio did not answer in time';

interface Pending {
  resolve: (v: Answer) => void;
  timer: NodeJS.Timeout;
  /** Only the connection asked may answer. */
  client: Client;
}

interface Listener {
  notes: PlayedNote[];
  start: number;
  held: Map<number, PlayedNote>;
  /**
   * Only what these studios report they played (the agent listens to the studio that asked); null:
   * everything, from every studio and the network, as the holo command's listen hears it.
   */
  from: ((c: Client) => boolean) | null;
  /** Told after each note on or off it took in: how many are held, and how many it has. */
  heard: ((held: number, notes: number) => void) | null;
}

export interface LiveOptions {
  /** The runner key (agent/keys.ts); with none, no runner is handed the agent's jobs. */
  key?: string | null;
  /** Where the server's own notices go (a runner without the key, say). */
  log?: (line: string) => void;
}

export class Live {
  private clients = new Set<Client>();
  private pending = new Map<string, Pending>();
  private listeners = new Set<Listener>();
  private counter = 0;
  private readonly key: string | null;
  private readonly log: (line: string) => void;
  /** Notices already given (each once). */
  private told = new Set<string>();
  readonly renders = new Map<string, RenderJob>();
  /**
   * What a studio missed while it wasn't connected (a newer save of its song): asked when it joins or
   * opens another song, so a dropped connection never leaves it showing an old version.
   */
  latestRevision: (project: string) => number | null = () => null;
  /** The in-app agent (agent/jobs.ts), once it's set up. */
  agent: AgentHooks | null = null;

  constructor(options: LiveOptions = {}) {
    this.key = options.key ?? null;
    this.log = options.log ?? ((line) => console.warn(line));
  }

  attach(ws: WebSocket): void {
    const client: Client = { ws, role: 'remote', name: 'device', state: null, caughtUp: null, device: null };
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
      this.agent?.gone(client);
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
        if (client.role === 'runner') {
          client.caps = runnerCaps(msg.caps);
          client.keyed = this.keyed(msg.key);
        } else client.keyed = false;
        // a studio on a device allowed to use the agent (each hello says it again, or it's no longer one)
        client.device =
          client.role === 'editor' && typeof msg.agentToken === 'string' && msg.agentToken.length <= 200
            ? (this.agent?.device(msg.agentToken) ?? null)
            : null;
        this.broadcastPeers();
        if (client.role === 'runner' && client.keyed && client.caps?.agent) this.agent?.runner(client);
        // a remote arriving sees every open studio at once
        if (client.role === 'remote') {
          for (const c of this.clients) {
            if (c.role === 'editor' && c.state) this.send(client, { type: 'studio', name: c.name, state: c.state });
          }
        }
        break;
      case 'state':
        if (client.role === 'editor') {
          const was = client.state?.project ?? null;
          client.state = { ...(msg.state as EditorState), updated: Date.now() };
          if (client.device) this.agent?.state(client, was);
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
        if (p && p.client === client) {
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
        if (client.role === 'editor' && Array.isArray(msg.events)) this.recordPlayed(msg.events as unknown[], client);
        break;
      default:
        // (anything else goes unheard: an old runner's word on Scan's AI jobs, `job-*`, among it)
        if (typeof msg.type === 'string' && AGENT_MESSAGES.has(msg.type)) this.agent?.message(client, msg);
    }
  }

  /** What was played, for those listening: `from` is the studio that reported it (null: from the network). */
  private recordPlayed(events: unknown[], from: Client | null = null): void {
    if (!this.listeners.size) return;
    const told = new Set<Listener>();
    for (const e of events) {
      const ev = e as { status: number; d1: number; d2: number; tick: number | null; port: string };
      const kind = ev.status & 0xf0;
      for (const l of this.listeners) {
        if (l.from && (!from || !l.from(from))) continue;
        if (l.heard) told.add(l);
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
    for (const l of told) l.heard?.(l.held.size, l.notes.length);
  }

  private send(c: Client, msg: unknown): void {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }

  /** Send one connection a message (the agent's: a runner its job, a studio its status). */
  sendTo(c: Client, msg: Record<string, unknown>): void {
    this.send(c, msg);
  }

  /** The studios open on an allowed device (its connections that said its token). */
  studiosOf(device: string): Client[] {
    return [...this.clients].filter((c) => c.role === 'editor' && c.device === device);
  }

  /** The device's studio with a song open (the most recently active one if several are), or null. */
  studioFor(device: string, project: string): Client | null {
    let best: Client | null = null;
    for (const c of this.studiosOf(device)) {
      if (c.state?.project !== project) continue;
      if (!best || (c.state?.updated ?? 0) > (best.state?.updated ?? 0)) best = c;
    }
    return best;
  }

  /** Tell the studios on allowed devices something (those `which` picks, or all). */
  toDevices(msg: Record<string, unknown>, which: (c: Client) => boolean = () => true): number {
    let n = 0;
    for (const c of this.clients) {
      if (c.role !== 'editor' || !c.device || !which(c)) continue;
      this.send(c, msg);
      n++;
    }
    return n;
  }

  /** A device was removed: its studios lose the agent at once, and hear so. */
  downgrade(device: string): void {
    for (const c of this.studiosOf(device)) {
      c.device = null;
      this.send(c, { type: 'agent-removed' });
    }
  }

  /** The open studios (every device's, allowed to use the agent or not). */
  studios(): Client[] {
    return [...this.clients].filter((c) => c.role === 'editor');
  }

  /** Whether a runner is connected, and whether one said the key. */
  runners(): { connected: boolean; keyed: boolean } {
    return { connected: this.runner(), keyed: this.keyedRunners().length > 0 };
  }

  /** The runners the agent's jobs may go to: keyed ones that run them. */
  agentRunners(): Client[] {
    return this.keyedRunners().filter((c) => c.caps?.agent);
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
        resolve({ ok: false, error: NO_ANSWER });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, client: editor });
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

  /**
   * Whether a runner's hello carries the runner key. One without it still renders; the server says
   * once why it gets no agent jobs.
   */
  private keyed(given: unknown): boolean {
    if (this.key !== null && typeof given === 'string' && given.length <= 256 && sameKey(given, this.key)) return true;
    this.tellOnce(
      given === undefined || given === null || given === ''
        ? 'A runner without the key connected: restart it with the current HO[LO] to use the agent'
        : 'A runner with the wrong key connected: it reads runner.key in HO[LO]’s data folder (or HOLO_RUNNER_KEY), so check its HOLO_DATA_DIR',
    );
    return false;
  }

  private tellOnce(line: string): void {
    if (this.told.has(line)) return;
    this.told.add(line);
    this.log(line);
  }

  /** The runners that may be handed the agent's jobs. */
  keyedRunners(): Client[] {
    return [...this.clients].filter((c) => c.role === 'runner' && c.keyed);
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

  /**
   * Collect what some studios report they play (those `from` picks), until the returned function is
   * called: it gives the notes. `heard` is told after each note on or off (the agent's listening ends
   * on a quiet spell). Nothing is told to the studios: the agent says so itself.
   */
  collect(from: (c: Client) => boolean, heard: (held: number, notes: number) => void): () => PlayedNote[] {
    const l: Listener = { notes: [], start: Date.now(), held: new Map(), from, heard };
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
      return l.notes;
    };
  }

  /** Collect what is played in the studio for a while. */
  async listen(ms: number): Promise<PlayedNote[]> {
    const l: Listener = { notes: [], start: Date.now(), held: new Map(), from: null, heard: null };
    this.listeners.add(l);
    this.tell({ type: 'listening', ms });
    await new Promise((r) => setTimeout(r, ms));
    this.listeners.delete(l);
    return l.notes;
  }
}

/** A runner's word on what it can do, checked (anything else it says, an old runner's `ai`, is left out). */
function runnerCaps(v: unknown): RunnerCaps {
  const caps = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  return { render: caps.render !== false, agent: caps.agent === true };
}
