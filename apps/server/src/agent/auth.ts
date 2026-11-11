/**
 * Who may use the agent: the devices allowed to. The first is allowed with a 6-digit code the runner
 * prints on this computer (so whoever types it can see the computer's screen); later ones ask, and a
 * device already allowed approves them. Each holds a token (32 random bytes); the server keeps only
 * its sha256, and compares hashes in constant time. Removing a device deletes its hash: its next
 * request is refused, and its open studio loses the agent at once.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { sameKey } from './keys.ts';
import type { AgentStore, DeviceRow } from './store.ts';

/** A token as made here: 32 bytes, base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Whether two sha256 hashes (hex) are the same, in a time that says nothing about where they differ. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

/** The token in an `Authorization: Bearer …` header, if it's one of the shape HO[LO] makes. */
export function bearer(header: string | undefined): string | null {
  const m = /^Bearer (\S+)$/.exec(header ?? '');
  return m?.[1] && TOKEN.test(m[1]) ? m[1] : null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** How long a pairing code works, and how many tries it allows. */
const CODE_LIFE = 10 * MINUTE;
const CODE_TRIES = 5;
/** Failed codes in an hour that lock pairing for an hour. */
const LOCK_AFTER = 20;
/** Devices asking to join: at most this many waiting, each for this long. */
const MAX_PENDING = 5;
const REQUEST_LIFE = 10 * MINUTE;
/** The codes devices asking to join show: no 0/O or 1/I to mix up. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type PairResult =
  | { ok: true; token: string; device: { id: string; name: string } }
  | { ok: false; status: 401 | 409 | 429; error: string };

export interface AuthOptions {
  store: AgentStore;
  /** The devices or the requests changed: allowed devices hear so. */
  changed: () => void;
  /** A device was removed: its connections lose the agent, its jobs stop. */
  removed: (device: string) => void;
  now?: () => number;
}

export class Auth {
  private readonly store: AgentStore;
  private readonly changed: () => void;
  private readonly removed: (device: string) => void;
  private readonly now: () => number;
  private code: { code: string; expires: number; tries: number } | null = null;
  /** When each failed try at a code was (the last hour's). */
  private failures: number[] = [];
  private lockedUntil = 0;

  constructor(options: AuthOptions) {
    this.store = options.store;
    this.changed = options.changed;
    this.removed = options.removed;
    this.now = options.now ?? (() => Date.now());
  }

  /** The allowed device a request's `Authorization` header names, or null. */
  device(header: string | undefined): DeviceRow | null {
    const token = bearer(header);
    return token ? this.deviceFor(token) : null;
  }

  /** The allowed device a token belongs to, or null. Each device's hash is compared, whichever matches. */
  deviceFor(token: string): DeviceRow | null {
    if (!TOKEN.test(token)) return null;
    const hash = hashToken(token);
    let found: DeviceRow | null = null;
    for (const d of this.store.devices()) if (sameHash(hash, d.token_hash)) found = d;
    if (found && (found.seen === null || this.now() - found.seen > MINUTE)) this.store.seen(found.id, this.now());
    return found;
  }

  /** Whether a device is still allowed (its connection is checked again with each agent message). */
  allowed(id: string): boolean {
    return this.store.device(id) !== null;
  }

  // ---- the first device: a code printed on this computer ----

  /** Whether no device is allowed yet: a code is how the first one gets in. */
  pairable(): boolean {
    return this.store.devices().length === 0;
  }

  locked(): boolean {
    return this.now() < this.lockedUntil;
  }

  /** A new code (the one before stops working), for the runner to print. */
  startPairing(): { code: string; expires: number } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expires = this.now() + CODE_LIFE;
    this.code = { code, expires, tries: 0 };
    return { code, expires };
  }

  /** Pair with the code: the device's token, said once. */
  pair(code: string, name: string): PairResult {
    if (this.locked()) return { ok: false, status: 429, error: 'Too many wrong codes: try again in an hour' };
    if (!this.pairable())
      return { ok: false, status: 409, error: 'A device is allowed already: ask it to approve this one' };
    const current = this.code;
    if (!current) return this.fail('Ask for a code first: the runner prints it');
    if (this.now() > current.expires) {
      this.code = null;
      return this.fail('That code has expired: ask for a new one');
    }
    if (!/^\d{6}$/.test(code) || !sameKey(code, current.code)) {
      current.tries++;
      if (current.tries >= CODE_TRIES) this.code = null;
      return this.fail(
        current.tries >= CODE_TRIES
          ? 'That code isn’t right, and it no longer works: ask for a new one'
          : 'That code isn’t right',
      );
    }
    // it works once
    this.code = null;
    const token = newToken();
    const device: DeviceRow = {
      id: `dev_${randomBytes(6).toString('hex')}`,
      name,
      token_hash: hashToken(token),
      added: this.now(),
      seen: this.now(),
    };
    this.store.addDevice(device);
    this.changed();
    return { ok: true, token, device: { id: device.id, name: device.name } };
  }

  private fail(error: string): PairResult {
    const now = this.now();
    this.failures = [...this.failures.filter((t) => now - t < HOUR), now];
    if (this.failures.length >= LOCK_AFTER) {
      this.lockedUntil = now + HOUR;
      this.failures = [];
      this.code = null;
    }
    return { ok: false, status: 401, error };
  }

  // ---- later devices: they ask, an allowed device approves ----

  /** A device asks to join: its request's id, the secret it polls with, and the code both devices show. */
  ask(name: string): { id: string; secret: string; code: string } | { error: string; status: 429 } {
    this.store.dropRequests(this.now() - REQUEST_LIFE);
    if (this.store.requests().filter((r) => r.state === 'pending').length >= MAX_PENDING)
      return { status: 429, error: 'Too many devices are asking already: approve or deny them first' };
    const id = `dvr_${randomBytes(6).toString('hex')}`;
    const secret = newToken();
    const code = Array.from({ length: 4 }, () => ALPHABET[randomInt(0, ALPHABET.length)]).join('');
    this.store.addRequest({
      id,
      name,
      code,
      secret_hash: hashToken(secret),
      state: 'pending',
      token_hash: null,
      created: this.now(),
    });
    this.changed();
    return { id, secret, code };
  }

  /**
   * How a request stands, for the device that made it (with its secret; null otherwise). Once
   * approved, the token comes with the first answer, and never again.
   */
  poll(
    id: string,
    secret: string,
  ):
    | { state: 'pending' | 'denied' }
    | { state: 'approved'; token?: string; device?: { id: string; name: string } }
    | null {
    this.store.dropRequests(this.now() - REQUEST_LIFE);
    const r = this.store.request(id);
    if (!r || !TOKEN.test(secret) || !sameHash(hashToken(secret), r.secret_hash)) return null;
    if (r.state !== 'approved') return { state: r.state };
    if (r.token_hash) return { state: 'approved' };
    // made now, so it's never kept anywhere but on the device
    const token = newToken();
    const device: DeviceRow = {
      id: `dev_${randomBytes(6).toString('hex')}`,
      name: r.name,
      token_hash: hashToken(token),
      added: this.now(),
      seen: this.now(),
    };
    this.store.addDevice(device);
    this.store.setRequest(r.id, 'approved', device.token_hash);
    this.changed();
    return { state: 'approved', token, device: { id: device.id, name: device.name } };
  }

  /** Approve or deny a pending request. False when there's none of that id waiting. */
  answer(id: string, approve: boolean): boolean {
    this.store.dropRequests(this.now() - REQUEST_LIFE);
    const r = this.store.request(id);
    if (r?.state !== 'pending') return false;
    this.store.setRequest(id, approve ? 'approved' : 'denied');
    this.changed();
    return true;
  }

  /** The devices and the requests waiting, as Settings › Agent shows them (`current`: the one asking). */
  list(current: string): {
    devices: { id: string; name: string; added: number; seen: number | null; current: boolean }[];
    requests: { id: string; name: string; code: string; created: number }[];
  } {
    this.store.dropRequests(this.now() - REQUEST_LIFE);
    return {
      devices: this.store
        .devices()
        .map((d) => ({ id: d.id, name: d.name, added: d.added, seen: d.seen, current: d.id === current })),
      requests: this.store
        .requests()
        .filter((r) => r.state === 'pending')
        .map((r) => ({ id: r.id, name: r.name, code: r.code, created: r.created })),
    };
  }

  /** Remove a device: at once, its token works no more, its studio loses the agent, its jobs stop. */
  remove(id: string): boolean {
    if (!this.store.removeDevice(id)) return false;
    this.removed(id);
    this.changed();
    return true;
  }
}
