/**
 * Notices outside HO[LO], on this device (Settings › Agent, "Tell me outside HO[LO]"; docs/agent.md).
 * Off by default. On, the host sends this device a short notice when a request it asked ends, or
 * stops for its OK, while HO[LO] isn't in front here (Long runs: only replies that took over a
 * minute; Every reply: all of them), and the service worker shows it (sw-template.js).
 *
 * Here: whether this browser can have them (`notifySupport`), turning them on (the browser's
 * permission, asked on the click, then its push subscription, made for the host's key and given to
 * the host) and off, giving the host the browser's subscription again when it changed, and the Home
 * Screen badge: the replies this device asked for that no device has seen yet. An iPhone or iPad has
 * them only from HO[LO] added to its Home Screen, which keeps its own storage, so it's allowed as a
 * device of its own.
 */
import { useEffect } from 'react';
import { agent, call, isOn } from './agent.ts';

export type NotifyMode = 'off' | 'long' | 'every';

/** Whether this browser can have notices: yes, not without HTTPS or the Home Screen, not at all, or blocked. */
export type NotifySupport = 'ok' | 'https' | 'home-screen' | 'unsupported' | 'blocked';

/** This device's notices, as the host has them (`GET /api/agent/push`). */
export interface PushView {
  /** The host's public key (base64url), which a subscription is made for. */
  key: string;
  mode: NotifyMode;
  endpoint?: string;
  /** Replies this device asked for that no device has seen: its badge. */
  unseen: number;
}

/** What `notifySupport` goes by. */
export interface SupportFacts {
  /** A secure page (HTTPS, or this computer). */
  secure: boolean;
  /** A service worker to show them (a production build's). */
  sw: boolean;
  push: boolean;
  ios: boolean;
  /** Opened from the Home Screen (or installed). */
  standalone: boolean;
  permission: NotificationPermission | 'unsupported';
}

export function notifySupport(f: SupportFacts): NotifySupport {
  if (!f.secure) return 'https';
  // (Safari on an iPhone or iPad has push only in a Home Screen web app)
  if (f.ios && !f.standalone) return 'home-screen';
  if (!f.sw || !f.push || f.permission === 'unsupported') return 'unsupported';
  if (f.permission === 'denied') return 'blocked';
  return 'ok';
}

/** An iPhone, iPad or iPod (an iPad's Safari says it's a Mac, with a touch screen). */
export function isIosLike(ua: string = navigator.userAgent, touchPoints: number = navigator.maxTouchPoints ?? 0) {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
}

/** What Settings › Agent says under the choice, for each kind of support; null for none. */
export function supportHint(s: NotifySupport): string | null {
  switch (s) {
    case 'https':
      return 'Needs HO[LO] opened over HTTPS: on your tailnet (pnpm tailnet on) or your local network (pnpm lan on).';
    case 'home-screen':
      return 'On iPhone and iPad: add HO[LO] to the Home Screen, open it there and allow it as a device, then turn this on.';
    case 'unsupported':
      return 'This browser can’t show HO[LO]’s notices.';
    case 'blocked':
      return 'Notices are blocked for HO[LO] in this browser’s settings: allow them there, then turn this on.';
    case 'ok':
      return null;
  }
}

/** This browser, as `notifySupport` reads it. */
export function supportFacts(): SupportFacts {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    secure: window.isSecureContext,
    // (the service worker is a production build's: a development server has none)
    sw: import.meta.env.PROD && 'serviceWorker' in navigator,
    push: 'PushManager' in window,
    ios: isIosLike(),
    standalone: window.matchMedia?.('(display-mode: standalone)').matches || nav.standalone === true,
    permission: 'Notification' in window ? Notification.permission : 'unsupported',
  };
}

/** The badge on HO[LO]'s Home Screen icon (where the browser has one): the unseen replies, or none. */
function badge(n: number): void {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    const done = n > 0 ? nav.setAppBadge?.(n) : nav.clearAppBadge?.();
    done?.catch(() => undefined);
  } catch {
    // (no badge here)
  }
}

/** What the host last said of this device's notices (null: not asked yet). */
let known: PushView | null = null;

function keep(view: PushView): PushView {
  known = view;
  return view;
}

export async function getPush(): Promise<PushView> {
  return keep(await call<PushView>('GET', '/api/agent/push'));
}

function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const b64 = key.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Whether a subscription was made for the host's key (one made for an earlier key gets nothing). */
function forKey(sub: PushSubscription, key: string): boolean {
  const had = sub.options.applicationServerKey;
  if (!had) return false;
  const a = new Uint8Array(had);
  const b = keyBytes(key);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The service worker, once it's in charge (null: none, as on a development server). */
async function worker(waitMs = 10_000): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  const timeout = new Promise<null>((done) => setTimeout(() => done(null), waitMs));
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

/** The browser's subscription for the host's key: the one it has, or a new one (the old let go). */
async function subscription(reg: ServiceWorkerRegistration, key: string): Promise<PushSubscription> {
  let sub = await reg.pushManager.getSubscription();
  if (sub && !forKey(sub, key)) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  return sub ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
}

const put = async (mode: 'long' | 'every', sub: PushSubscription) =>
  keep(await call<PushView>('PUT', '/api/agent/push', { mode, subscription: sub.toJSON() }));

/**
 * Turn notices on (or change when they come). Call it from the click itself: the browser asks its
 * permission first, and Safari asks only from a click. `key`: the host's, when it's known already.
 */
export async function subscribe(mode: 'long' | 'every', key = known?.key): Promise<PushView> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted')
    throw new Error(
      permission === 'denied'
        ? 'Notices are blocked for HO[LO] in this browser’s settings: allow them there, then try again'
        : 'Notices weren’t allowed',
    );
  const hostKey = key ?? (await getPush()).key;
  const reg = await worker();
  if (!reg) throw new Error('HO[LO]’s service worker isn’t running here: reload the page and try again');
  return put(mode, await subscription(reg, hostKey));
}

/** Turn notices off: the browser's subscription goes, then the host's copy (and this device's unseen replies). */
export async function unsubscribe(): Promise<PushView> {
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  await sub?.unsubscribe().catch(() => false);
  const view = keep(await call<PushView>('DELETE', '/api/agent/push'));
  badge(0);
  return view;
}

/**
 * HO[LO] opened (or came back in front): the badge as the host counts it now (a reply seen on another
 * device since), and, with notices on, the browser's subscription given to the host again if it
 * changed or went (a browser may renew it, or let it go with the site's data).
 */
export async function syncPush(): Promise<void> {
  const view = await getPush();
  badge(view.unseen);
  if (view.mode === 'off' || notifySupport(supportFacts()) !== 'ok' || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return;
  const sub = await subscription(reg, view.key);
  if (sub.endpoint !== view.endpoint) await put(view.mode, sub);
}

/** The open song's conversation was seen here: its replies count as unseen on no device, and the badge says so. */
export async function markSeenOnHost(project: string): Promise<void> {
  if (!isOn(agent.get())) return;
  try {
    const r = await call<{ unseen: number }>('POST', '/api/agent/seen', { project });
    badge(r.unseen);
    if (known) known = { ...known, unseen: r.unseen };
  } catch {
    // (the host away a moment: the next look counts it)
  }
}

/**
 * A conversation shown (the page, the bar): seen on the host as it opens, and again as a reply ends
 * while it's open (`ended`: the newest turn's job once it has ended, else null).
 */
export function useSeenOnHost(project: string | null, ended: string | null): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: a reply ending (`ended`) is seen again
  useEffect(() => {
    if (project) void markSeenOnHost(project);
  }, [project, ended]);
}

/** At most this often does coming back in front ask the host for the badge. */
const LOOK_MS = 10_000;

/** Once the agent is on for this device, and as HO[LO] comes back in front: `syncPush`. */
export function installNotices(): void {
  let looked = 0;
  const look = () => {
    if (!isOn(agent.get()) || Date.now() - looked < LOOK_MS) return;
    looked = Date.now();
    void syncPush().catch(() => undefined);
  };
  let on = isOn(agent.get());
  if (on) look();
  agent.subscribe(() => {
    const now = isOn(agent.get());
    if (now && !on) look();
    on = now;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && known?.mode !== 'off') look();
  });
}
