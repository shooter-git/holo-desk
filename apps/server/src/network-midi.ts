/**
 * Network MIDI: HO[LO] as a network MIDI session (RTP-MIDI, the "Network" MIDI built into iOS and
 * macOS). An iPhone or iPad can't give a browser its USB MIDI devices, but it can send them to a
 * network session: with a MIDI routing app on the phone, the keyboard or drum pads plugged into it
 * play the studio open on another device, as any network device does.
 *
 * Two UDP ports, as Apple's sessions use: control (default 5004) and data (the next one). The phone
 * (or a Mac) invites, the session answers, they keep their clocks in step, and notes arrive as RTP
 * packets of MIDI commands. Only receiving is needed here; the recovery journal is ignored (on a
 * local network or a tailnet, a lost packet is rare, and the next note isn't held back for it).
 */
import { randomInt } from 'node:crypto';
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';

const SIGNATURE = 0xffff;
const IN = 0x494e; // invitation
const OK = 0x4f4b; // invitation accepted
const BY = 0x4259; // end of session
const CK = 0x434b; // clock sync
const PROTOCOL = 2;

export interface NetworkSession {
  /** The name the device gave its session ("iPhone", "Studio Mac"). */
  name: string;
  address: string;
  /** Its control port (where a goodbye goes). */
  controlPort: number;
  ssrc: number;
  since: number;
  /** When it was last heard from (a note or a clock sync). */
  seen: number;
  /** MIDI messages received. */
  messages: number;
}

export interface NetworkMidiOptions {
  port: number;
  host: string;
  /** What the phone's list of sessions shows. */
  name: string;
  onMidi: (from: string, message: number[]) => void;
  log?: (line: string) => void;
}

/** The MIDI messages in an RTP-MIDI packet's command list (channel and system common; SysEx skipped). */
export function parseRtpMidi(packet: Buffer): number[][] {
  if (packet.length < 13 || (packet[0] as number) >> 6 !== 2) return [];
  const csrc = (packet[0] as number) & 0x0f;
  let at = 12 + csrc * 4;
  const head = packet[at] as number;
  if (head === undefined) return [];
  const long = (head & 0x80) !== 0;
  const firstHasDelta = (head & 0x20) !== 0;
  const length = long ? ((head & 0x0f) << 8) | (packet[at + 1] ?? 0) : head & 0x0f;
  at += long ? 2 : 1;
  const end = Math.min(packet.length, at + length);
  const out: number[][] = [];
  let running = 0;
  let first = true;
  while (at < end) {
    if (!first || firstHasDelta) {
      // a delta time: up to four bytes, high bit set on all but the last
      for (let i = 0; i < 4 && at < end; i++) if (((packet[at++] as number) & 0x80) === 0) break;
    }
    first = false;
    if (at >= end) break;
    let status = packet[at] as number;
    if (status & 0x80) at++;
    else if (running) status = running;
    else break; // data with no status: the rest can't be read
    if (status === 0xf0 || status === 0xf7) {
      // SysEx (whole or a segment): skip to its end marker
      while (at < end) {
        const b = packet[at++] as number;
        if (b === 0xf7 || b === 0xf0 || b === 0xf4) break;
      }
      running = 0;
      continue;
    }
    if (status >= 0xf8) {
      out.push([status]);
      continue;
    }
    const kind = status & 0xf0;
    const count =
      status >= 0xf0
        ? status === 0xf2
          ? 2
          : status === 0xf1 || status === 0xf3
            ? 1
            : 0
        : kind === 0xc0 || kind === 0xd0
          ? 1
          : 2;
    if (at + count > end) break;
    const message = [status];
    for (let i = 0; i < count; i++) message.push((packet[at++] as number) & 0x7f);
    out.push(message);
    running = status < 0xf0 ? status : 0;
  }
  return out;
}

export class NetworkMidi {
  readonly ssrc = randomInt(1, 0xffffffff);
  private control: Socket | null = null;
  private data: Socket | null = null;
  private sessions = new Map<number, NetworkSession>();
  /** Invitations seen on the control port, waiting for the same device on the data port. */
  private invited = new Map<number, { name: string; port: number }>();
  private readonly epoch = process.hrtime.bigint();
  private readonly opts: NetworkMidiOptions;

  constructor(opts: NetworkMidiOptions) {
    this.opts = opts;
  }

  async listen(): Promise<void> {
    const bind = (port: number) =>
      new Promise<Socket>((resolve, reject) => {
        const s = createSocket({ type: 'udp4', reuseAddr: true });
        s.once('error', reject);
        s.bind(port, this.opts.host, () => {
          s.off('error', reject);
          s.on('error', (err) => this.opts.log?.(`network MIDI: ${err.message}`));
          resolve(s);
        });
      });
    this.control = await bind(this.opts.port);
    this.data = await bind(this.opts.port + 1);
    this.control.on('message', (m, r) => this.onPacket(m, r, 'control'));
    this.data.on('message', (m, r) => this.onPacket(m, r, 'data'));
  }

  close(): void {
    for (const s of this.sessions.values()) this.goodbye(s);
    this.control?.close();
    this.data?.close();
    this.control = this.data = null;
  }

  list(): NetworkSession[] {
    return [...this.sessions.values()];
  }

  /** Time in the protocol's units (100 µs) since this session started. */
  private now(): bigint {
    return (process.hrtime.bigint() - this.epoch) / 100_000n;
  }

  private onPacket(msg: Buffer, from: RemoteInfo, port: 'control' | 'data'): void {
    if (msg.length >= 4 && msg.readUInt16BE(0) === SIGNATURE) {
      this.onSession(msg, from, port);
      return;
    }
    if (port !== 'data' || msg.length < 12) return;
    const ssrc = msg.readUInt32BE(8);
    const session = this.sessions.get(ssrc);
    if (!session) return; // notes from a device that never joined
    session.seen = Date.now();
    for (const message of parseRtpMidi(msg)) {
      if (message[0] !== undefined && message[0] >= 0xf8) continue; // clock and active sensing: not for the studio
      session.messages++;
      this.opts.onMidi(session.name, message);
    }
  }

  private onSession(msg: Buffer, from: RemoteInfo, port: 'control' | 'data'): void {
    const command = msg.readUInt16BE(2);
    const socket = port === 'control' ? this.control : this.data;
    if (!socket) return;
    if (command === IN && msg.length >= 16) {
      const token = msg.readUInt32BE(8);
      const ssrc = msg.readUInt32BE(12);
      const nul = msg.indexOf(0, 16);
      const name = msg.toString('utf8', 16, nul < 0 ? msg.length : nul).trim() || from.address;
      const name8 = Buffer.from(`${this.opts.name}\0`, 'utf8');
      const reply = Buffer.alloc(16);
      reply.writeUInt16BE(SIGNATURE, 0);
      reply.writeUInt16BE(OK, 2);
      reply.writeUInt32BE(PROTOCOL, 4);
      reply.writeUInt32BE(token, 8);
      reply.writeUInt32BE(this.ssrc, 12);
      socket.send(Buffer.concat([reply, name8]), from.port, from.address);
      if (port === 'control') this.invited.set(ssrc, { name, port: from.port });
      else {
        const invite = this.invited.get(ssrc);
        this.sessions.set(ssrc, {
          name: invite?.name ?? name,
          address: from.address,
          controlPort: invite?.port ?? from.port - 1,
          ssrc,
          since: Date.now(),
          seen: Date.now(),
          messages: 0,
        });
        this.invited.delete(ssrc);
        this.opts.log?.(`network MIDI: ${name} joined from ${from.address}`);
      }
      return;
    }
    if (command === BY && msg.length >= 16) {
      const ssrc = msg.readUInt32BE(12);
      const s = this.sessions.get(ssrc);
      if (s) this.opts.log?.(`network MIDI: ${s.name} left`);
      this.sessions.delete(ssrc);
      this.invited.delete(ssrc);
      return;
    }
    if (command === CK && msg.length >= 36) {
      // clock sync: answer the first exchange with our time; a third message closes it
      const ssrc = msg.readUInt32BE(4);
      const count = msg.readUInt8(8);
      const s = this.sessions.get(ssrc);
      if (s) s.seen = Date.now();
      if (count !== 0) return;
      const reply = Buffer.from(msg.subarray(0, 36));
      reply.writeUInt32BE(this.ssrc, 4);
      reply.writeUInt8(1, 8);
      reply.writeBigUInt64BE(this.now(), 20);
      socket.send(reply, from.port, from.address);
    }
    // receiver feedback (RS) and anything else: nothing to answer
  }

  private goodbye(s: NetworkSession): void {
    if (!this.control) return;
    const msg = Buffer.alloc(16);
    msg.writeUInt16BE(SIGNATURE, 0);
    msg.writeUInt16BE(BY, 2);
    msg.writeUInt32BE(PROTOCOL, 4);
    msg.writeUInt32BE(0, 8);
    msg.writeUInt32BE(this.ssrc, 12);
    this.control.send(msg, s.controlPort, s.address);
  }
}
