// HO[LO] Desk offline. The build writes this as sw.js and fills in BUILD with its files.
//
// - The app (the page, its scripts, styles and icons) is cached when a version installs, so an
//   installed HO[LO] opens with no network. The fonts the page uses stay in the browser's own cache.
// - The page itself comes from the network whenever it answers, so a new version shows next time;
//   offline it comes from the cache. Hashed files are always served from the cache.
// - Projects (/api) are never cached here: the studio keeps its own copy while it works offline.
//   Samples (/packs) have their own cache, filled by the studio as instruments load.
// - The agent's notices outside HO[LO] (a device turns them on in Settings › Agent: app/notify.ts)
//   arrive here as pushes from the host, and are shown, with the badge set to the unseen replies. A
//   tap brings HO[LO] up on that song with the page open at the reply.
const BUILD = /* BUILD */ null;
const SHELL = `holo-shell-${BUILD.version}`;
// big files only some devices use (the score's engraver): kept the first time they're fetched
const LAZY = 'holo-lazy';

const at = (path) => new URL(path, self.registration.scope).href;
const shell = new Set(BUILD.shell.map(at));
const lazy = new Set((BUILD.lazy ?? []).map(at));

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await Promise.all(
        [...shell].map(async (url) => {
          // a hashed file is the same file for as long as it has that name: the last version's copy
          // does, or the browser's own (the page has just loaded most of them). The page, the
          // manifests and the icons keep their names, so those are fetched afresh
          const hashed = url.includes('/assets/');
          const kept = hashed ? await caches.match(url) : undefined;
          if (kept) return cache.put(url, kept);
          const response = await fetch(new Request(url, { cache: hashed ? 'default' : 'reload' }));
          if (!response.ok) throw new Error(`${url}: ${response.status}`);
          await cache.put(url, response);
        }),
      );
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith('holo-shell-') && name !== SHELL) await caches.delete(name);
      // an older version's big files go once this one is in charge
      const kept = await caches.open(LAZY);
      for (const request of await kept.keys()) if (!lazy.has(request.url)) await kept.delete(request);
      await self.clients.claim();
    })(),
  );
});

async function fresh(url, request) {
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    if (response.ok) (await caches.open(SHELL)).put(url, response.clone());
    return response;
  } catch {
    const cached = await caches.match(url);
    if (cached) return cached;
    throw new Error('offline');
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/packs')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fresh(at('./'), request));
    return;
  }
  if (shell.has(url.href)) {
    event.respondWith(caches.match(url.href).then((hit) => hit ?? fetch(request)));
  } else if (lazy.has(url.href)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(LAZY);
        const hit = await cache.match(url.href);
        if (hit) return hit;
        const response = await fetch(request);
        if (response.ok) await cache.put(url.href, response.clone());
        return response;
      })(),
    );
  }
});

// ---- the agent's notices (apps/server/src/agent/push.ts sends them) ----

/** A song's id, and a turn's job, as HO[LO] makes them. */
const SONG = /^[\w-]{1,64}$/;
const TURN = /^agj_[0-9a-f]{12}$/;

/** What a push says, checked: from HO[LO] Desk, the song and what happened, the turn, the unseen count. */
function readNotice(event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // (not one of HO[LO]'s: shown plainly all the same)
  }
  const text = (v, max, or) => (typeof v === 'string' && v ? v.slice(0, max) : or);
  const project = typeof data.project === 'string' && SONG.test(data.project) ? data.project : null;
  const job = typeof data.job === 'string' && TURN.test(data.job) ? data.job : null;
  const query = new URLSearchParams();
  if (project) query.set('project', project);
  if (project && job) query.set('turn', job);
  const search = query.toString();
  return {
    title: text(data.title, 60, 'HO[LO] Desk'),
    body: text(data.body, 200, 'The agent has something for you.'),
    project,
    job,
    url: at(search ? `./?${search}` : './'),
    unseen: Number.isInteger(data.unseen) && data.unseen >= 0 ? data.unseen : null,
  };
}

/** The badge on HO[LO]'s Home Screen icon, where the browser has one. */
function setBadge(n) {
  const nav = self.navigator;
  if (n === null || !nav.setAppBadge) return Promise.resolve();
  return (n > 0 ? nav.setAppBadge(n) : nav.clearAppBadge()).catch(() => undefined);
}

// every push shows a notice (an iPhone allows no silent ones); a song's newest takes the place of its last
self.addEventListener('push', (event) => {
  const n = readNotice(event);
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(n.title, {
        body: n.body,
        tag: n.project ?? 'holo',
        renotify: true,
        icon: at('icons/icon-192.png'),
        data: { url: n.url, project: n.project, job: n.job },
      }),
      setBadge(n.unseen),
    ]),
  );
});

// a tap: the studio already open comes in front and opens the page at that reply; else HO[LO] opens there
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url, project, job } = event.notification.data ?? {};
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const studio = windows.find((c) => {
        const u = new URL(c.url);
        // (HO[LO] Remote, a phone driving the studio, isn't one)
        return u.origin === self.location.origin && !/^\/remote\/?$/.test(u.pathname);
      });
      if (studio) {
        await studio.focus().catch(() => undefined);
        if (project) studio.postMessage({ type: 'open-turn', project, job: job ?? null });
        return;
      }
      await self.clients.openWindow(typeof url === 'string' ? url : at('./'));
    })(),
  );
});
