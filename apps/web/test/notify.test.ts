import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as NotifyModule from '../src/app/notify.ts';
import type { SupportFacts } from '../src/app/notify.ts';

let N: typeof NotifyModule;
/** The browser's storage, as the studio uses it. */
const items = new Map<string, string>();

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

beforeAll(async () => {
  // (the studio's modules read the browser's storage as they load)
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => items.set(k, String(v)),
    removeItem: (k: string) => items.delete(k),
  });
  vi.stubGlobal('window', globalThis);
  N = await import('../src/app/notify.ts');
});

const READY: SupportFacts = {
  secure: true,
  sw: true,
  push: true,
  ios: false,
  standalone: false,
  permission: 'default',
};

describe('whether a browser can have the agent’s notices', () => {
  it('needs HTTPS first, then (on an iPhone or iPad) the Home Screen, then push and the permission', () => {
    const cases: [Partial<SupportFacts>, NotifyModule.NotifySupport][] = [
      [{}, 'ok'],
      [{ permission: 'granted' }, 'ok'],
      [{ permission: 'denied' }, 'blocked'],
      // an Android phone or a computer, in a tab
      [{ standalone: false }, 'ok'],
      // over plain http: nothing works (a Home Screen app wouldn't either)
      [{ secure: false }, 'https'],
      [{ secure: false, ios: true }, 'https'],
      [{ secure: false, sw: false, push: false }, 'https'],
      // Safari on an iPhone, in a tab: push only from the Home Screen
      [{ ios: true, push: false }, 'home-screen'],
      [{ ios: true, permission: 'denied' }, 'home-screen'],
      [{ ios: true, standalone: true }, 'ok'],
      [{ ios: true, standalone: true, permission: 'denied' }, 'blocked'],
      // no service worker (a development server), no push, no notifications
      [{ sw: false }, 'unsupported'],
      [{ push: false }, 'unsupported'],
      [{ permission: 'unsupported' }, 'unsupported'],
      [{ ios: true, standalone: true, push: false }, 'unsupported'],
    ];
    for (const [facts, want] of cases)
      expect(N.notifySupport({ ...READY, ...facts }), JSON.stringify(facts)).toBe(want);
  });

  it('says what each needs, matching how the README names the HTTPS ways in', () => {
    expect(N.supportHint('ok')).toBeNull();
    expect(N.supportHint('https')).toMatch(/HTTPS.*pnpm tailnet on.*pnpm lan on/);
    expect(N.supportHint('home-screen')).toBe(
      'On iPhone and iPad: add HO[LO] to the Home Screen, open it there and allow it as a device, then turn this on.',
    );
    expect(N.supportHint('blocked')).toMatch(/blocked/);
    expect(N.supportHint('unsupported')).toBeTruthy();
  });

  it('knows an iPhone, an iPod and an iPad, the iPad whichever it says it is', () => {
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
    const ipadOld =
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    const mac =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
    const chromeIos =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1';
    const android =
      'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';
    const windows =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0';
    expect(N.isIosLike(iphone, 5)).toBe(true);
    expect(N.isIosLike(chromeIos, 5)).toBe(true);
    expect(N.isIosLike(ipadOld, 5)).toBe(true);
    expect(N.isIosLike('Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)', 5)).toBe(true);
    // an iPad's Safari says it's a Mac: its touch screen gives it away
    expect(N.isIosLike(mac, 5)).toBe(true);
    expect(N.isIosLike(mac, 0)).toBe(false);
    expect(N.isIosLike(android, 5)).toBe(false);
    expect(N.isIosLike(windows, 10)).toBe(false);
  });
});

// ---- keeping notices going: a renewed subscription, given to the host again as HO[LO] opens ----

/** The host's key, as the host gives it (65 bytes, base64url). */
const KEY = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
const OLD = 'https://updates.push.services.mozilla.com/wpush/v2/old';
const RENEWED = 'https://updates.push.services.mozilla.com/wpush/v2/renewed';

interface Call {
  method: string;
  url: string;
  body?: { mode: string; subscription: { endpoint: string } };
}

/** A browser subscription, made for the host's key. */
function subscriptionAt(endpoint: string) {
  return {
    endpoint,
    options: { applicationServerKey: new Uint8Array(Buffer.from(KEY, 'base64url')).buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => true),
  };
}

/**
 * This device as a browser with HO[LO]'s service worker (its push subscription at `endpoint`, or
 * none), the permission as given, and a host whose copy of the device's notices is `host`.
 */
function device(endpoint: string | null, host: { mode: string; endpoint?: string }, permission = 'granted') {
  let sub = endpoint ? subscriptionAt(endpoint) : null;
  const reg = {
    pushManager: {
      getSubscription: async () => sub,
      subscribe: vi.fn(async () => {
        sub = subscriptionAt(RENEWED);
        return sub;
      }),
    },
  };
  const calls: Call[] = [];
  vi.stubEnv('PROD', true);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', { permission, requestPermission: async () => permission });
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
    maxTouchPoints: 0,
    serviceWorker: { getRegistration: async () => reg, ready: Promise.resolve(reg) },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Call['body']) : undefined;
      calls.push({ method, url, ...(body ? { body } : {}) });
      if (method === 'PUT' && body) Object.assign(host, { mode: body.mode, endpoint: body.subscription.endpoint });
      if (method === 'DELETE') Object.assign(host, { mode: 'off', endpoint: undefined });
      const view = { key: KEY, mode: host.mode, ...(host.endpoint ? { endpoint: host.endpoint } : {}), unseen: 0 };
      return new Response(JSON.stringify(view), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  items.set('holo:agent-token', 'token');
  items.set('holo:agent-device', 'dev_me');
  return { calls, reg, puts: () => calls.filter((c) => c.method === 'PUT') };
}

/** The choice as kept on this device (as the device `as`), or none. */
const choose = (mode: string | null, as = 'dev_me') => {
  if (mode) items.set('holo:notices', JSON.stringify({ device: as, mode }));
  else items.delete('holo:notices');
};

describe('keeping a device’s notices going', () => {
  it('gives the host the renewed subscription after it let the old one go (410), with the choice kept here', async () => {
    choose('long');
    // the browser renewed it; a notice to the old one got 410, and the host deleted the device's row
    const d = device(RENEWED, { mode: 'off' });
    await N.syncPush();
    expect(d.puts()).toEqual([
      expect.objectContaining({ body: { mode: 'long', subscription: expect.objectContaining({ endpoint: RENEWED }) } }),
    ]);
    // (the key was asked for: subscribing needs it)
    expect(d.calls[0]?.url).toBe('/api/agent/push?key=1');
  });

  it('gives it again when the host has an older one, and asks nothing more once the host has it', async () => {
    choose('every');
    const host = { mode: 'every', endpoint: OLD };
    const d = device(RENEWED, host);
    await N.syncPush();
    expect(d.puts().map((c) => c.body?.subscription.endpoint)).toEqual([RENEWED]);
    const again = device(RENEWED, host);
    await N.syncPush();
    expect(again.puts()).toEqual([]);
  });

  it('subscribes the browser afresh if it has none (its site data was cleared, say), with the permission given', async () => {
    choose('long');
    const d = device(null, { mode: 'off' });
    await N.syncPush();
    expect(d.reg.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(d.puts().map((c) => c.body?.mode)).toEqual(['long']);
  });

  it('never undoes Off: turning them off clears the choice, and the next open gives the host nothing', async () => {
    choose(null);
    const host = { mode: 'off' };
    device(null, host);
    await N.subscribe('long');
    expect(N.readChoice()).toBe('long');
    expect(host).toMatchObject({ mode: 'long', endpoint: RENEWED });
    const off = device(RENEWED, host);
    await N.unsubscribe();
    expect(off.calls.map((c) => c.method)).toEqual(['DELETE']);
    expect(N.readChoice()).toBeNull();
    expect(items.has('holo:notices')).toBe(false);
    const reopened = device(RENEWED, host);
    await N.syncPush();
    expect(reopened.puts()).toEqual([]);
    expect(reopened.calls.map((c) => c.url)).toEqual(['/api/agent/push']);
  });

  it('takes no choice made as another device (this browser allowed again since), and nothing without the permission', async () => {
    choose('long', 'dev_old');
    expect(N.readChoice()).toBeNull();
    const other = device(RENEWED, { mode: 'off' });
    await N.syncPush();
    expect(other.puts()).toEqual([]);
    choose('long');
    const unallowed = device(RENEWED, { mode: 'off' }, 'default');
    await N.syncPush();
    expect(unallowed.puts()).toEqual([]);
  });

  it('keeps the host’s mode as the choice when none was kept here yet (chosen before it was)', async () => {
    choose(null);
    const d = device(RENEWED, { mode: 'every', endpoint: RENEWED });
    await N.syncPush();
    expect(d.puts()).toEqual([]);
    expect(N.readChoice()).toBe('every');
  });

  it('picks the mode: the choice kept here, else the host’s', () => {
    expect(N.wantedMode('long', 'off')).toBe('long');
    expect(N.wantedMode('long', 'every')).toBe('long');
    expect(N.wantedMode(null, 'every')).toBe('every');
    expect(N.wantedMode(null, 'off')).toBeNull();
  });
});
