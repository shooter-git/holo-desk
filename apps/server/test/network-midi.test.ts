import { createSocket, type Socket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { NetworkMidi, parseRtpMidi } from '../src/network-midi.ts';

/** An RTP-MIDI packet: the 12-byte RTP header, then the command list. */
function rtp(ssrc: number, list: number[], z = false): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt8(0x80, 0);
  head.writeUInt8(0x61, 1);
  head.writeUInt16BE(1, 2);
  head.writeUInt32BE(1000, 4);
  head.writeUInt32BE(ssrc, 8);
  const len = list.length;
  const section = len > 15 ? [0x80 | (z ? 0x20 : 0) | (len >> 8), len & 0xff] : [(z ? 0x20 : 0) | len];
  return Buffer.concat([head, Buffer.from([...section, ...list])]);
}

describe('RTP-MIDI packets', () => {
  it('reads notes, running status and delta times', () => {
    // note on C4, then (delta 0) running-status E4, then (delta 10) note off C4
    const msgs = parseRtpMidi(rtp(7, [0x90, 60, 100, 0x00, 64, 90, 0x0a, 0x80, 60, 0]));
    expect(msgs).toEqual([
      [0x90, 60, 100],
      [0x90, 64, 90],
      [0x80, 60, 0],
    ]);
  });
  it('reads a long list with a delta before the first command, and skips SysEx', () => {
    const list = [0x00, 0xf0, 0x7e, 0x7f, 0x09, 0x01, 0xf7, 0x00, 0xb0, 64, 127, 0x81, 0x00, 0xe0, 0, 0x50];
    const msgs = parseRtpMidi(rtp(7, [...list, 0x00, 0xc0, 5, 0x00, 0xd0, 30], true));
    expect(msgs).toEqual([
      [0xb0, 64, 127],
      [0xe0, 0, 0x50],
      [0xc0, 5],
      [0xd0, 30],
    ]);
  });
});

describe('a network MIDI session', () => {
  let server: NetworkMidi | null = null;
  const sockets: Socket[] = [];
  afterEach(() => {
    server?.close();
    for (const s of sockets.splice(0)) s.close();
  });

  const udp = () =>
    new Promise<Socket>((ok) => {
      const s = createSocket('udp4');
      s.bind(0, '127.0.0.1', () => ok(s));
      sockets.push(s);
    });
  const reply = (s: Socket) => new Promise<Buffer>((ok) => s.once('message', (m) => ok(m)));
  const invitation = (ssrc: number, name: string) => {
    const b = Buffer.alloc(16);
    b.writeUInt16BE(0xffff, 0);
    b.writeUInt16BE(0x494e, 2);
    b.writeUInt32BE(2, 4);
    b.writeUInt32BE(0x1234, 8);
    b.writeUInt32BE(ssrc, 12);
    return Buffer.concat([b, Buffer.from(`${name}\0`)]);
  };

  it('accepts an iPhone, keeps time with it, and passes on what it plays', async () => {
    const port = 47000 + Math.floor(Math.random() * 1000) * 2;
    const heard: [string, number[]][] = [];
    server = new NetworkMidi({ port, host: '127.0.0.1', name: 'HO[LO] Desk', onMidi: (f, m) => heard.push([f, m]) });
    await server.listen();
    const control = await udp();
    const data = await udp();
    const ssrc = 0xabcdef01;

    control.send(invitation(ssrc, 'iPhone'), port, '127.0.0.1');
    const ok1 = await reply(control);
    expect(ok1.readUInt16BE(2)).toBe(0x4f4b);
    expect(ok1.readUInt32BE(8)).toBe(0x1234);
    expect(ok1.toString('utf8', 16, ok1.length - 1)).toBe('HO[LO] Desk');
    data.send(invitation(ssrc, 'iPhone'), port + 1, '127.0.0.1');
    expect((await reply(data)).readUInt16BE(2)).toBe(0x4f4b);
    expect(server.list().map((s) => s.name)).toEqual(['iPhone']);

    // clock sync: the session answers with its own time
    const ck = Buffer.alloc(36);
    ck.writeUInt16BE(0xffff, 0);
    ck.writeUInt16BE(0x434b, 2);
    ck.writeUInt32BE(ssrc, 4);
    ck.writeUInt8(0, 8);
    ck.writeBigUInt64BE(123456n, 12);
    data.send(ck, port + 1, '127.0.0.1');
    const ck2 = await reply(data);
    expect(ck2.readUInt8(8)).toBe(1);
    expect(ck2.readBigUInt64BE(12)).toBe(123456n);

    data.send(rtp(ssrc, [0x99, 36, 110, 0x00, 0x89, 36, 0]), port + 1, '127.0.0.1');
    data.send(rtp(0x5555, [0x90, 60, 100]), port + 1, '127.0.0.1'); // a stranger: ignored
    await new Promise((ok) => setTimeout(ok, 50));
    expect(heard).toEqual([
      ['iPhone', [0x99, 36, 110]],
      ['iPhone', [0x89, 36, 0]],
    ]);

    const bye = invitation(ssrc, '').subarray(0, 16);
    bye.writeUInt16BE(0x4259, 2);
    control.send(bye, port, '127.0.0.1');
    await new Promise((ok) => setTimeout(ok, 50));
    expect(server.list()).toEqual([]);
  });
});
