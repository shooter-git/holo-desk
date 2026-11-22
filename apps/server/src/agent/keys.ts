/**
 * The runner's key: how the server knows the runner it hands the agent's jobs to is the one on this
 * computer, not a page or a program posing as it. It's made once, in the data folder, readable only
 * by its owner; the runner reads it there (or is given it as HOLO_RUNNER_KEY) and says it in its
 * hello. Renders don't need it, so a runner from before keys still renders.
 *
 * And the push key, which signs the notices a device can turn on (agent/push.ts), kept the same way.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type JsonWebKeyInput,
  type KeyObject,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY = /^[0-9a-f]{64}$/;

/** The key in `dataDir/runner.key`, made (32 random bytes as hex, mode 0600) the first time it's asked for. */
export function runnerKey(dataDir: string): string {
  const file = join(dataDir, 'runner.key');
  try {
    const key = readFileSync(file, 'utf8').trim();
    if (KEY.test(key)) {
      // made by hand, or copied with looser permissions: only its owner reads it
      chmodSync(file, 0o600);
      return key;
    }
  } catch {
    // not made yet
  }
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32).toString('hex');
  try {
    // only if no other process made it in the meantime
    writeFileSync(file, `${key}\n`, { mode: 0o600, flag: 'wx' });
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const made = readFileSync(file, 'utf8').trim();
  if (KEY.test(made)) return made;
  // an empty or damaged file: replaced
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return key;
}

/**
 * The key HO[LO] signs its notices with (VAPID, RFC 8292: agent/push.ts), as the push services know
 * it: a P-256 key pair, its public half what a device's subscription is made for. Its private half
 * as a JWK.
 */
export interface PushKey {
  privateKey: KeyObject;
  /** The public key, uncompressed (0x04 ‖ x ‖ y, 65 bytes). */
  publicKey: Buffer;
}

/** A JWK's coordinate or private value: 32 bytes as base64url. */
const COORD = /^[A-Za-z0-9_-]{43}$/;

/** A P-256 private key as a JWK, or null for anything else. */
function readPushJwk(text: string): PushKey | null {
  try {
    const jwk = JSON.parse(text) as Record<string, unknown>;
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
    if (![jwk.d, jwk.x, jwk.y].every((v) => typeof v === 'string' && COORD.test(v))) return null;
    const privateKey = createPrivateKey({ key: jwk as JsonWebKeyInput['key'], format: 'jwk' });
    const pub = createPublicKey(privateKey).export({ format: 'jwk' });
    // (x and y are the private key's own: a file with another public half is damaged)
    if (pub.x !== jwk.x || pub.y !== jwk.y) return null;
    const publicKey = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x as string, 'base64url'),
      Buffer.from(jwk.y as string, 'base64url'),
    ]);
    return { privateKey, publicKey };
  } catch {
    return null;
  }
}

/**
 * The push key in `dataDir/push.key`, made (a new P-256 key pair, its JWK, mode 0600) the first time
 * it's asked for (an allowed device's Settings › Agent reads it, to subscribe with), not as the server
 * starts. Like the runner key, one made by hand or
 * copied with looser permissions is closed to its owner, and a damaged one is replaced (subscriptions
 * made for the old one then fail until each device turns its notices on again, or opens HO[LO]).
 */
export function pushKey(dataDir: string): PushKey {
  const file = join(dataDir, 'push.key');
  try {
    const kept = readPushJwk(readFileSync(file, 'utf8'));
    if (kept) {
      chmodSync(file, 0o600);
      return kept;
    }
  } catch {
    // not made yet
  }
  mkdirSync(dataDir, { recursive: true });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const text = `${JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d })}\n`;
  try {
    // only if no other process made it in the meantime
    writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
    return readPushJwk(text) as PushKey;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const made = readPushJwk(readFileSync(file, 'utf8'));
  if (made) return made;
  // an empty or damaged file: replaced
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
  return readPushJwk(text) as PushKey;
}

/** Whether two keys are the same, in a time that says nothing about where they differ (or their lengths). */
export function sameKey(given: string, key: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(key).digest();
  return timingSafeEqual(a, b);
}
