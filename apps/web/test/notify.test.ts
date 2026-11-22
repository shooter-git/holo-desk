import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as NotifyModule from '../src/app/notify.ts';
import type { SupportFacts } from '../src/app/notify.ts';

let N: typeof NotifyModule;

beforeAll(async () => {
  // (the studio's modules read the browser's storage as they load)
  const items = new Map<string, string>();
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
