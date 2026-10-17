/**
 * What HO[LO] Engine remembers about each sound device: how deep a buffer it needed to play cleanly
 * (the device's period as a multiple of its shortest, and the frames kept in hand), and whether it
 * had to be shared. The next time the device is opened, and the next launch, start there, with
 * nothing for anyone to set. A small JSON file in the engine's own settings folder.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Depth } from '@holo/engine/companion';

export interface DeviceEntry {
  /** The device's period as a multiple of its shortest: 1, 2 or 4. */
  depth: Depth;
  /** The cushion level that held (1: one period in hand; each step a block more). */
  level: number;
  /** Shared rather than exclusive, after exclusive mode kept failing. */
  shared: boolean;
}

export interface DeviceMemory {
  /** Where it's kept, for the log. */
  readonly where: string;
  get(key: string): DeviceEntry | null;
  set(key: string, entry: DeviceEntry): void;
  /** The device opened last: a guess for the next open, before the device is named. */
  last(): string | null;
  setLast(key: string): void;
}

/** The engine's settings folder for this user, where the operating system keeps such things. */
export function memoryPath(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32')
    return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'HOLO Engine', 'devices.json');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'HOLO Engine', 'devices.json');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'holo-engine', 'devices.json');
}

interface Stored {
  version: 1;
  last: string | null;
  devices: Record<string, DeviceEntry>;
}

function isDepth(x: unknown): x is Depth {
  return x === 1 || x === 2 || x === 4;
}

function entry(x: unknown): DeviceEntry | null {
  if (!x || typeof x !== 'object') return null;
  const e = x as Record<string, unknown>;
  if (!isDepth(e.depth)) return null;
  const level = typeof e.level === 'number' && e.level >= 1 && e.level <= 8 ? Math.round(e.level) : 1;
  return { depth: e.depth, level, shared: e.shared === true };
}

/** The memory as a file: read once, written whenever something changes (rarely, and little). */
export function fileMemory(path: string = memoryPath()): DeviceMemory {
  let stored: Stored | null = null;
  const load = (): Stored => {
    if (stored) return stored;
    stored = { version: 1, last: null, devices: {} };
    try {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Stored>;
        if (raw && typeof raw === 'object' && raw.devices && typeof raw.devices === 'object') {
          for (const [key, value] of Object.entries(raw.devices)) {
            const e = entry(value);
            if (e) stored.devices[key] = e;
          }
          if (typeof raw.last === 'string' && raw.last in stored.devices) stored.last = raw.last;
        }
      }
    } catch {
      // an unreadable file is as good as none: it's only a memory
    }
    return stored;
  };
  const save = () => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(load(), null, 1)}\n`);
    } catch {
      // nowhere to write (a read-only folder): the engine still works, it just won't remember
    }
  };
  return {
    where: path,
    get: (key) => load().devices[key] ?? null,
    set: (key, e) => {
      const s = load();
      const was = s.devices[key];
      if (was && was.depth === e.depth && was.level === e.level && was.shared === e.shared) return;
      s.devices[key] = { ...e };
      save();
    },
    last: () => load().last,
    setLast: (key) => {
      const s = load();
      if (s.last === key) return;
      s.last = key;
      save();
    },
  };
}

/** A memory for this run only (tests, and the null sound device). */
export function inMemory(): DeviceMemory {
  const devices = new Map<string, DeviceEntry>();
  let last: string | null = null;
  return {
    where: '',
    get: (key) => devices.get(key) ?? null,
    set: (key, e) => {
      devices.set(key, { ...e });
    },
    last: () => last,
    setLast: (key) => {
      last = key;
    },
  };
}
