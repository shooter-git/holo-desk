/**
 * Notices outside HO[LO] (Settings › Agent, "Tell me outside HO[LO]"; docs/agent.md). Off by default,
 * set per device. When a request a device asked ends, or stops to ask for its OK, while HO[LO] isn't
 * in front on that device, a short notice goes to that device, and only that one, through its
 * browser's push service (Web Push, RFC 8030): encrypted so only the device can read it (RFC 8291,
 * aes128gcm) and signed with HO[LO]'s own key (VAPID, RFC 8292; `pushKey` in keys.ts). Written with
 * node:crypto alone.
 *
 * A push service is handed the encrypted notice (about 200 bytes: the song's name and what happened)
 * and sees the host's address, when and how big, the browser installation it's for, and the key and
 * project URL HO[LO] signs with; never what the notice says (SECURITY.md). Only the push services of
 * Apple, Google, Mozilla and Microsoft are sent to (`allowedEndpoint`).
 */
import { createCipheriv, createECDH, createHash, ECDH, hkdfSync, randomBytes, sign } from 'node:crypto';
import type { Live } from '../live.ts';
import { isHidden, type JobView } from './jobs.ts';
import type { PushKey } from './keys.ts';
import type { AgentStore, PushMode, PushRow } from './store.ts';

/** What a notice says it's from. */
export const NOTICE_TITLE = 'HO[LO] Desk';
/** "Long runs": a reply that took longer than this. */
export const LONG_MS = 60_000;
/** The VAPID subject: HO[LO]'s project page (a push service's contact for the sender), never an address. */
export const VAPID_SUBJECT = 'https://github.com/shooter-git/holo-desk';
/** How long a VAPID token is good for (RFC 8292 allows up to 24 hours). */
const VAPID_LIFE_S = 12 * 3600;
/** How long a push service keeps a notice for a device that's off (12 hours). */
const TTL_S = 43_200;
/** One record: a notice is far smaller. */
const RECORD = 4096;
/** The most a notice says, before it's encrypted (a push service takes 4096 bytes with the header). */
const MAX_PLAINTEXT = 3000;
/** How long a push service has to answer. */
const SEND_MS = 10_000;
/** A song's name in a notice: at most this many characters. */
const MAX_NAME = 60;

/** The push services HO[LO] sends to: Google's (Chrome, Edge on Android), Apple's, Mozilla's and Microsoft's. */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^(?:[a-z0-9-]+\.)+push\.apple\.com$/,
  /^(?:[a-z0-9-]+\.)+push\.services\.mozilla\.com$/,
  /^(?:[a-z0-9-]+\.)+notify\.windows\.com$/,
];

/**
 * Whether a subscription's endpoint is one HO[LO] sends to: https on 443, at most 1000 characters, no
 * user or password, on one of the push services' hosts. What a device says its endpoint is goes no
 * further than this, so nothing on the host's network, or anywhere else, can be made a target.
 */
export function allowedEndpoint(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 1000) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  // (443 is https's own, so the URL drops it: any other port is left in)
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password) return false;
  return PUSH_HOSTS.some((host) => host.test(u.hostname));
}

/** base64url (padding allowed), decoded; null for anything else. */
function b64url(v: unknown, max = 200): Buffer | null {
  if (typeof v !== 'string' || v.length > max || !/^[A-Za-z0-9_-]+={0,2}$/.test(v)) return null;
  return Buffer.from(v.replace(/=+$/, ''), 'base64url');
}

/**
 * A subscription as a browser gives it (`PushSubscription.toJSON()`), checked: an allowed endpoint, a
 * P-256 public key (65 bytes, uncompressed, a point on the curve) and a 16-byte auth secret. The keys
 * come back as base64url without padding; or why it isn't one.
 */
export function checkSubscription(v: unknown): Pick<PushRow, 'endpoint' | 'p256dh' | 'auth'> | string {
  const why = 'subscription is {endpoint, keys:{p256dh, auth}}, as the browser gives it';
  if (typeof v !== 'object' || v === null) return why;
  const s = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } | null };
  if (!allowedEndpoint(s.endpoint))
    return 'subscription.endpoint isn’t a push service HO[LO] sends to (Apple’s, Google’s, Mozilla’s or Microsoft’s, over https)';
  if (typeof s.keys !== 'object' || s.keys === null) return why;
  const p256dh = b64url(s.keys.p256dh);
  if (p256dh?.length !== 65 || p256dh[0] !== 4) return 'subscription.keys.p256dh is a P-256 public key';
  try {
    ECDH.convertKey(p256dh, 'prime256v1');
  } catch {
    return 'subscription.keys.p256dh is a P-256 public key';
  }
  const auth = b64url(s.keys.auth);
  if (auth?.length !== 16) return 'subscription.keys.auth is 16 bytes';
  return { endpoint: s.endpoint, p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') };
}

/**
 * A notice encrypted for a device (RFC 8291, aes128gcm): only the device, with its private key and
 * auth secret, can read it. A new key pair and salt each time; `salt` and `asPrivate` are for the
 * RFC's own example (the tests).
 */
export function encrypt(
  sub: Pick<PushRow, 'p256dh' | 'auth'>,
  plaintext: Uint8Array,
  o: { salt?: Uint8Array; asPrivate?: Uint8Array } = {},
): Buffer {
  const uaPublic = Buffer.from(sub.p256dh, 'base64url');
  const auth = Buffer.from(sub.auth, 'base64url');
  const ecdh = createECDH('prime256v1');
  if (o.asPrivate) ecdh.setPrivateKey(Buffer.from(o.asPrivate));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const salt = o.salt ? Buffer.from(o.salt) : randomBytes(16);
  const hkdf = (key: Buffer, by: Buffer, info: Buffer, length: number) =>
    Buffer.from(hkdfSync('sha256', key, by, info, length));
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\x00'), uaPublic, asPublic]);
  const ikm = hkdf(secret, auth, keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\x00'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\x00'), 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // one record, the last: the plaintext, then its delimiter (0x02)
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.from([2])), cipher.final()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed, cipher.getAuthTag()]);
}

/**
 * The VAPID token for an endpoint (RFC 8292): an ES256 JWT for the push service's origin, good for 12
 * hours, naming HO[LO]'s project page; and the Authorization header that carries it with the key.
 */
export function vapid(endpoint: string, key: PushKey, now = Date.now()): { token: string; authorization: string } {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + VAPID_LIFE_S, sub: VAPID_SUBJECT };
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part(claims)}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  const token = `${unsigned}.${signature.toString('base64url')}`;
  return { token, authorization: `vapid t=${token}, k=${key.publicKey.toString('base64url')}` };
}

/** A song's notices share a topic, so a push service holds only the latest for a device that's off. */
export function topic(project: string): string {
  return createHash('sha256').update(project).digest('base64url').slice(0, 22);
}

/** How a send went: taken, the subscription gone (404, 410: the browser let it go), or not. */
export type Sent = 'ok' | 'gone' | 'failed';

export interface SendOptions {
  key: PushKey;
  fetch?: typeof fetch;
  /** The song's topic (`topic`). */
  topic?: string;
  now?: number;
  timeoutMs?: number;
  /** Where a failure is said, once. */
  log?: (line: string) => void;
}

/**
 * Send a notice to a device's push service. A failure is said once (`log`) and changes nothing else:
 * no retry, no other device's notice held up.
 */
export async function send(
  sub: Pick<PushRow, 'endpoint' | 'p256dh' | 'auth'>,
  payload: string,
  o: SendOptions,
): Promise<Sent> {
  const log = o.log ?? ((line: string) => console.warn(line));
  if (!allowedEndpoint(sub.endpoint)) {
    log('A notice wasn’t sent: its subscription isn’t a push service HO[LO] sends to');
    return 'failed';
  }
  const host = new URL(sub.endpoint).hostname;
  try {
    const plaintext = Buffer.from(payload, 'utf8');
    if (plaintext.length > MAX_PLAINTEXT) throw new Error('the notice is too long');
    const res = await (o.fetch ?? fetch)(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapid(sub.endpoint, o.key, o.now).authorization,
        ttl: String(TTL_S),
        urgency: 'normal',
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ...(o.topic ? { topic: o.topic } : {}),
      },
      body: encrypt(sub, plaintext),
      // (a push service answers itself: it's never followed elsewhere)
      redirect: 'error',
      signal: AbortSignal.timeout(o.timeoutMs ?? SEND_MS),
    });
    // (what it says is in its status)
    void res.body?.cancel().catch(() => undefined);
    if (res.status === 404 || res.status === 410) return 'gone';
    if (res.ok) return 'ok';
    log(`A notice wasn’t taken by ${host}: it answered ${res.status}`);
    return 'failed';
  } catch (err) {
    log(`A notice couldn’t be sent to ${host}: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }
}

/** What a notice says: from HO[LO] Desk, the song and what happened, and the turn a tap opens. */
export interface Notice {
  title: string;
  body: string;
  project: string;
  job: string;
}

/** A song's name as a notice gives it: one line, at most 60 characters. */
function songName(title: string): string {
  const name = title
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return 'A song';
  return name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1).trimEnd()}…` : name;
}

/**
 * The notice a job's ending gives, by the device's mode; null for none. Both modes: a wait for the
 * user's OK. Every reply: done or failed. Long runs: done or failed after more than a minute. Never
 * one for a request that was cancelled (the user stopped it, or left it).
 */
export function notice(
  job: Pick<JobView, 'id' | 'project' | 'state' | 'started' | 'finished'>,
  mode: PushMode,
  title: string,
): Notice | null {
  let what: string;
  if (job.state === 'awaiting') what = 'it needs your OK to go on.';
  else if (job.state === 'done' || job.state === 'failed') {
    // (this turn's own time: what follows an OK is a job of its own, begun at the click (Jobs.permit),
    // so the wait for the OK never counts)
    const took = (job.finished ?? Date.now()) - job.started;
    if (mode === 'long' && !(took > LONG_MS)) return null;
    what = job.state === 'done' ? 'a reply is ready.' : 'the request stopped.';
  } else return null;
  return { title: NOTICE_TITLE, body: `${songName(title)}: ${what}`, project: job.project, job: job.id };
}

/** What a bounce the host made tells the device that asked for it: the song, and that it's ready or failed. */
export interface BounceNotice {
  title: string;
  body: string;
  /** (Not `project` and `job`: a service worker from before bounces had notices would take it for the agent's.) */
  kind: 'bounce';
  song: string;
}

/** A bounce as its notice needs it (host-bounce.ts's job). */
export interface BounceEnded {
  project: string;
  name: string;
  state: string;
  started: number;
  finished: number | null;
  seconds: number | null;
}

/**
 * The notice a host bounce's ending gives, by the device's mode; null for none. Every reply: done or
 * failed. Long runs: one that took more than a minute. It says which song and no more: why one
 * failed is said in the studio (a notice carries nothing from the song).
 */
export function bounceNotice(job: BounceEnded, mode: PushMode): BounceNotice | null {
  if (job.state !== 'done' && job.state !== 'failed') return null;
  const took = (job.finished ?? Date.now()) - job.started;
  if (mode === 'long' && !(took > LONG_MS)) return null;
  const s = Math.max(0, Math.round(job.seconds ?? 0));
  const length = s > 0 ? ` (${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')})` : '';
  const what = job.state === 'done' ? `the bounce is ready${length}.` : 'the bounce failed.';
  return { title: NOTICE_TITLE, body: `${songName(job.name)}: ${what}`, kind: 'bounce', song: job.project };
}

export interface NotifyOptions {
  agentStore: AgentStore;
  live: Live;
  /** The push key (made the first time it's needed). */
  key: () => PushKey;
  /** A song's name (null: it's gone). */
  title: (project: string) => string | null;
  /** A device's name, for the log. */
  deviceName: (device: string) => string | null;
}

/**
 * Sends the notices (jobs.onJobEnd). Each ending of a request on a device with notices on is kept as
 * unseen (its badge), unless it was cancelled; then, when the device's mode wants one, the notice goes,
 * unless HO[LO] is in front on that device (`inFront`). It runs on its own, and nothing it meets is
 * the job's trouble.
 */
export class Notify {
  private readonly o: NotifyOptions;
  /** How push services are reached (a test's fake). */
  fetch: typeof fetch = (input, init) => fetch(input, init);
  /** Where a send is said, and a failure. */
  log: (line: string) => void = (line) => console.log(line);
  warn: (line: string) => void = (line) => console.warn(line);
  /** How long a studio in view has to say it's in front. */
  frontMs = 1500;
  private readonly sending = new Set<Promise<void>>();

  constructor(options: NotifyOptions) {
    this.o = options;
  }

  attach(jobs: { onJobEnd: (fn: (job: { view: JobView }) => void) => void }): void {
    jobs.onJobEnd((job) => this.ended(job.view));
  }

  /** The notices on their way, sent (or not). */
  async idle(): Promise<void> {
    while (this.sending.size) await Promise.all([...this.sending]);
  }

  /** A job ended: kept as unseen, and its notice sent if one is due. Never throws. */
  ended(job: JobView): void {
    try {
      if (job.state !== 'done' && job.state !== 'failed' && job.state !== 'awaiting') return;
      const sub = this.o.agentStore.push(job.device);
      if (!sub) return;
      // (kept now, before the studio that shows it can say it's seen it)
      this.o.agentStore.addUnseen(job.id, job.device, job.project, job.finished ?? Date.now());
      const n = notice(job, sub.mode, this.o.title(job.project) ?? '');
      if (!n) return;
      this.go(sub, () => ({ ...n, unseen: this.o.agentStore.unseen(sub.device) }), topic(n.project));
    } catch (err) {
      this.warn(`A notice failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * A bounce the host made for a device has ended: its notice, if the device has notices on and its
   * mode wants one. With the agent turned off there is none (its notices are the agent's setting).
   * Nothing is kept as unseen: the badge counts the agent's replies. Never throws.
   */
  bounced(job: BounceEnded, device: string): void {
    try {
      if (!this.o.agentStore.settings().enabled) return;
      const sub = this.o.agentStore.push(device);
      if (!sub) return;
      const n = bounceNotice(job, sub.mode);
      // (a topic of its own: it doesn't take the place of the agent's notice for that song, waiting for a device that's off)
      if (n) this.go(sub, () => n, topic(`bounce:${job.project}`));
    } catch (err) {
      this.warn(`A notice failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A notice on its way (`idle` waits for it). */
  private go(sub: PushRow, say: () => unknown, topicOf: string): void {
    const going: Promise<void> = this.deliver(sub, say, topicOf)
      .catch((err: unknown) => this.warn(`A notice failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => this.sending.delete(going));
    this.sending.add(going);
  }

  private async deliver(sub: PushRow, say: () => unknown, topicOf: string): Promise<void> {
    if (await this.inFront(sub.device)) return;
    // (turned off, or subscribed again, while it looked)
    const now = this.o.agentStore.push(sub.device);
    if (!now || now.endpoint !== sub.endpoint) return;
    const payload = JSON.stringify(say());
    const result = await send(now, payload, {
      key: this.o.key(),
      fetch: this.fetch,
      topic: topicOf,
      log: this.warn,
    });
    const who = this.o.deviceName(sub.device) ?? 'a device';
    if (result === 'ok') this.log(`A notice went to ${who}`);
    else if (result === 'gone') {
      if (this.o.agentStore.push(sub.device)?.endpoint === now.endpoint) this.o.agentStore.removePush(sub.device);
      this.log(`${who}’s browser ended its notices: they’re off there until it turns them on again`);
    }
  }

  /**
   * Whether HO[LO] is in front on a device: one of its studios says its page is in view, and answers
   * so now. A page its browser froze (a phone in another app) may still say it's in view, but can't
   * answer, so it doesn't hold the notice back.
   */
  async inFront(device: string): Promise<boolean> {
    const shown = this.o.live.studiosOf(device).filter((c) => !isHidden(c));
    if (!shown.length) return false;
    const answers = await Promise.all(
      shown.map((c) => this.o.live.request(c, { type: 'agent-front' }, this.frontMs, true)),
    );
    return answers.some((a) => a.ok && a.front === true);
  }
}
