// HO[LO] Desk offline. The build writes this as sw.js and fills in BUILD with its files.
//
// - The app (the page, its scripts, styles and icons) is cached when a version installs, so an
//   installed HO[LO] opens with no network. The fonts the page uses stay in the browser's own cache.
// - The page itself comes from the network whenever it answers, so a new version shows next time;
//   offline it comes from the cache. Hashed files are always served from the cache.
// - Projects (/api) are never cached here: the studio keeps its own copy while it works offline.
//   Samples (/packs) have their own cache, filled by the studio as instruments load.
const BUILD = /* BUILD */ null;
const SHELL = `holo-shell-${BUILD.version}`;

const at = (path) => new URL(path, self.registration.scope).href;
const shell = new Set(BUILD.shell.map(at));

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
  }
});
