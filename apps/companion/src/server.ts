/**
 * HO[LO] Engine's main thread: a WebSocket on 127.0.0.1 the studio finds by itself, relaying the
 * studio's messages to the render thread (and the threads that render ahead, ahead.ts) and its
 * answers back. One studio at a time: the newest one to connect has the sound.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { MessageChannel, type Worker } from 'node:worker_threads';
import {
  COMPANION_PORT,
  decodeMessage,
  encodeMessage,
  type FromCompanion,
  privateHost,
  type ToCompanion,
} from '@holo/engine/companion';
import { type WebSocket, WebSocketServer } from 'ws';
import { AheadRelay, aheadThreads } from './ahead.ts';
import { memoryPath } from './memory.ts';
import type { RenderData } from './render.ts';
import type { ToRenderer } from './renderer.ts';

export const VERSION = '0.1.1';

export interface Options {
  port: number;
  /** Shared mode always (exclusive mode stops other apps playing sound). */
  shared: boolean;
  /** No sound device: the null backend (tests, or a computer without one). */
  nullAudio: boolean;
  /** Origins allowed besides HO[LO]'s usual kinds (localhost, private addresses, *.ts.net, *.local). */
  origins: string[];
  /** Threads to render the song ahead on (0: the render thread plays it all); null: by the cores there are. */
  threads: number | null;
}

/** The threads HO[LO] Engine starts: the one that renders for the device, and those that render ahead. */
export interface Threads {
  render(data: RenderData, transfer: MessageChannel['port2'][]): Worker;
  ahead(): Worker;
}

export function parseArgs(argv: string[]): Options | 'help' | 'version' {
  const o: Options = {
    port: Number(process.env.HOLO_ENGINE_PORT ?? COMPANION_PORT),
    shared: process.env.HOLO_ENGINE_SHARED === '1',
    nullAudio: false,
    origins: (process.env.HOLO_ENGINE_ORIGINS ?? '').split(',').filter(Boolean),
    threads: process.env.HOLO_ENGINE_THREADS ? Number(process.env.HOLO_ENGINE_THREADS) : null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--help' || a === '-h') return 'help';
    if (a === '--version' || a === '-v') return 'version';
    if (a === '--shared') o.shared = true;
    else if (a === '--null-audio') o.nullAudio = true;
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--origin') o.origins.push(String(argv[++i]));
    else if (a === '--threads') o.threads = Number(argv[++i]);
  }
  if (o.threads !== null && !(o.threads >= 0)) o.threads = null;
  return o;
}

export const HELP = `HO[LO] Engine ${VERSION}: HO[LO] Desk's sound and MIDI, native, on the device you play on.

Start it, then open HO[LO] Desk in the browser: the studio finds it by itself and plays through it.

  --shared        share the sound device with other apps (otherwise WASAPI exclusive mode on Windows)
  --port <n>      listen on 127.0.0.1:<n> (${COMPANION_PORT})
  --origin <url>  also allow a studio served from this origin (a public address, say)
  --threads <n>   render the song ahead on n more threads (0: one thread plays it all; the cores but
                  two, at most six, unless said)
  --null-audio    no sound device (testing)
`;

/** A studio served from this computer, the local network or a tailnet comes in as it is; others must be named. */
export function originAllowed(origin: string | undefined, extra: readonly string[] = []): boolean {
  if (!origin) return true; // not a browser: something on this computer, which could do anything anyway
  if (extra.includes(origin)) return true;
  try {
    return privateHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

type FromRenderer = FromCompanion | { type: 'log'; line: string };

export function run(
  o: Options,
  addon: string,
  threads: Threads,
  log: (line: string) => void = (line) => console.log(line),
): Promise<{ close(): Promise<void>; port: number }> {
  const doorbell = new SharedArrayBuffer(4);
  const bell = new Int32Array(doorbell);
  const channel = new MessageChannel();
  const worker = threads.render(
    {
      addon,
      port: channel.port2,
      doorbell,
      nullAudio: o.nullAudio,
      shared: o.shared,
      memoryPath: o.nullAudio ? null : memoryPath(),
    },
    [channel.port2],
  );
  worker.on('error', (err) => {
    log(`The render thread stopped: ${err.stack ?? err.message}`);
    process.exitCode = 1;
  });
  let client: WebSocket | null = null;

  const toRenderer = (msg: ToRenderer, transfer: ArrayBuffer[] = []) => {
    try {
      channel.port1.postMessage(msg, transfer);
    } catch {
      channel.port1.postMessage(msg); // a buffer that can't be moved is copied
    }
    Atomics.add(bell, 0, 1);
    Atomics.notify(bell, 0);
  };

  const toStudio = (msg: FromCompanion) => {
    if (client && client.readyState === client.OPEN) client.send(encodeMessage(msg));
  };
  const ahead = aheadThreads(o.threads);
  const relay = new AheadRelay(ahead, threads.ahead, toRenderer, (message) => {
    log(message);
    toStudio({ type: 'error', message });
  });
  log(
    ahead
      ? `Songs render ahead on ${ahead} more thread${ahead === 1 ? '' : 's'}`
      : 'Songs play on the render thread alone',
  );

  channel.port1.on('message', (msg: FromRenderer) => {
    if (msg.type === 'log') return log(msg.line);
    if (msg.type === 'device') relay.rate = msg.device.rate;
    toStudio(msg);
  });

  const http = createServer((req, res) => {
    // a plain answer for anyone checking it's here (browsers asking first included)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ name: 'HO[LO] Engine', version: VERSION, studio: client !== null }));
    void req;
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 ** 31 - 1 });
  http.on('upgrade', (req: IncomingMessage, socket, head) => {
    const origin = req.headers.origin;
    if (!originAllowed(origin, o.origins)) {
      log(`Refused a studio from ${origin}: start HO[LO] Engine with --origin ${origin} to allow it`);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.binaryType = 'arraybuffer';
      ws.send(encodeMessage({ type: 'hello', version: VERSION, platform: process.platform } satisfies FromCompanion));
      ws.on('message', (data: ArrayBuffer, binary: boolean) => {
        if (!binary) return; // a studio only sends binary frames
        let msg: ToCompanion;
        try {
          msg = decodeMessage(data) as ToCompanion;
        } catch (err) {
          log(`A message from the studio couldn’t be read: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        if (client !== ws) {
          // a studio takes the companion over by asking for the sound; anything else connecting waits
          if (msg.type !== 'open') return;
          if (client) {
            client.send(encodeMessage({ type: 'replaced' } satisfies FromCompanion));
            client.close(4000, 'Another studio took HO[LO] Engine');
            relay.receive({ type: 'close' });
          }
          client = ws;
          log(`Studio connected${origin ? ` (${origin})` : ''}`);
        }
        relay.receive(msg, [data]);
      });
      ws.on('close', () => {
        if (client !== ws) return;
        client = null;
        log('Studio gone: the sound device and MIDI are free again');
        relay.receive({ type: 'close' });
      });
    });
  });

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(o.port, '127.0.0.1', () => {
      const address = http.address();
      const port = typeof address === 'object' && address ? address.port : o.port;
      log(`HO[LO] Engine ${VERSION} is waiting for the studio on 127.0.0.1:${port}: open HO[LO] Desk in the browser.`);
      resolve({
        port,
        close: async () => {
          for (const ws of wss.clients) ws.terminate();
          await new Promise<void>((r) => http.close(() => r()));
          await relay.close();
          await worker.terminate();
        },
      });
    });
  });
}
