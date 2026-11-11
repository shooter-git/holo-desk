/**
 * The Origin and Host guard. HO[LO] has no accounts, and any page open in a browser on this computer
 * (or on a device that reaches it) could open the live channel and pose as the runner or a studio, or
 * call the agent's routes. A browser always says which site a page came from (the Origin header), so
 * a WebSocket upgrade, or a request to `/api/agent/*`, that comes from a site other than HO[LO]'s own
 * kinds is refused.
 *
 * A request with no Origin passes the Origin check: it isn't from a page in a browser but from
 * something on a computer (the `holo` command, the runner, curl), which could do anything there anyway.
 * So the terminal's way of working is untouched.
 *
 * Whatever its Origin, the request must also be for one of HO[LO]'s own names (its Host). A site can
 * point its name at 127.0.0.1 once a page of its is open ("DNS rebinding"); its page's requests are
 * then same-origin, and a same-origin GET carries no Origin at all, but its Host is still that site's
 * name.
 */
import type { FastifyInstance } from 'fastify';

/**
 * Whether a host is this computer, the local network or a tailnet. A copy of HO[LO] Engine's
 * `privateHost` (packages/engine/src/companion.ts, which apps/companion/src/server.ts's
 * `originAllowed` uses), kept here so that what the server trusts doesn't change when the engine's
 * check for its own studios does.
 */
export function privateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/\.(ts\.net|local|lan|home\.arpa|internal)$/.test(host)) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b < 32) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b < 128)
    );
  }
  return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}

/**
 * A name with no dots: this machine's own name on its network, as `pnpm lan` serves it. No public
 * site can have one, so no page can be pointed at it from outside.
 */
function bareName(hostname: string): boolean {
  return /^[a-z0-9-]+$/i.test(hostname);
}

/** What a Host header may hold: a name or address, and a port (nothing a URL could read as more). */
const HOST = /^[a-z0-9.\-[\]:]+$/i;

/**
 * Whether a request is for one of HO[LO]'s own names: this computer, the local network (a private
 * address, a .local name, the machine's bare name), a tailnet, or a name HOLO_ALLOWED_HOSTS gives.
 * Tailscale Serve and `pnpm lan`'s Caddy keep the name the browser asked for; the Vite dev server
 * (no changeOrigin) keeps 127.0.0.1:47810; the holo command and the runner ask for 127.0.0.1.
 */
export function hostAllowed(host: string | undefined, allowedHosts: readonly string[] = []): boolean {
  if (!host || !HOST.test(host)) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  return privateHost(hostname) || bareName(hostname) || allowedHosts.some((e) => entryName(e) === hostname);
}

/** The name in an entry of HOLO_ALLOWED_HOSTS (a host, host:port or an origin), as a URL writes it. */
function entryName(entry: string): string | null {
  const e = entry.trim().replace(/\/+$/, '');
  if (!e) return null;
  try {
    return new URL(e.includes('://') ? e : `http://${e}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Whether a request carrying this Origin may go on. Allowed: no Origin at all (not a browser); the
 * request's own Host (the studio served by this server, or through a proxy that keeps the Host, as
 * Tailscale Serve and `pnpm lan`'s Caddy do); this computer, the local network (the machine's bare
 * name included) and tailnets on any port (the Vite dev server on :47810 proxies to the server); and
 * the hosts in HOLO_ALLOWED_HOSTS, each a host name (any port), a host and port, or an origin
 * (`https://holo.example.com`).
 */
export function originAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowedHosts: readonly string[] = [],
): boolean {
  // not a browser: something on a computer, which could do anything anyway
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    // "null" (a sandboxed frame, a file) and anything else unreadable
    return false;
  }
  // only sites: an extension's or another scheme's origin is never let in
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (listed(url, allowedHosts)) return true;
  if (host && HOST.test(host)) {
    try {
      if (new URL(`${url.protocol}//${host}`).host === url.host) return true;
    } catch {
      // not a host
    }
  }
  return privateHost(url.hostname) || bareName(url.hostname);
}

/** Whether an origin is one HOLO_ALLOWED_HOSTS names. */
function listed(url: URL, allowedHosts: readonly string[]): boolean {
  const bare = (h: string) => h.replace(/^\[|\]$/g, '');
  for (const raw of allowedHosts) {
    const entry = raw.trim().toLowerCase().replace(/\/+$/, '');
    if (!entry) continue;
    if (entry.includes('://')) {
      try {
        if (new URL(entry).origin === url.origin) return true;
      } catch {
        // not an origin
      }
    } else if (entry === url.host || bare(entry) === bare(url.hostname)) return true;
  }
  return false;
}

/** The paths the guard covers: the live channel and everything of the agent's. */
export function guardedPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return path === '/api/live' || path === '/api/agent' || path.startsWith('/api/agent/');
}

/**
 * Refuses (403) a WebSocket upgrade, or a request to the live channel or the agent's routes, that
 * comes from another site or is for a name that isn't HO[LO]'s. Registered before the routes, so it
 * covers routes added later (all of `/api/agent/*`). Each refusal is reported once, saying how to
 * allow it.
 */
export function guard(
  app: FastifyInstance,
  allowedHosts: readonly string[],
  log: (line: string) => void = (line) => console.warn(line),
): void {
  const told = new Set<string>();
  app.addHook('onRequest', async (req, reply) => {
    const upgrade = req.headers.upgrade?.toLowerCase() === 'websocket';
    // the route it matched as well as the path asked for, so no spelling of a path slips past
    if (!upgrade && !guardedPath(req.url) && !guardedPath(req.routeOptions.url ?? '')) return;
    const { host, origin } = req.headers;
    const refuse = (line: string) => {
      if (!told.has(line) && told.size < 100) {
        told.add(line);
        log(line);
      }
      return reply.code(403).send({ error: 'Only HO[LO] Desk’s own pages may use its live channel and agent' });
    };
    if (!hostAllowed(host, allowedHosts)) {
      return refuse(
        host
          ? `Refused a request for ${host.slice(0, 200)}: if HO[LO] is reached by that name, add it to HOLO_ALLOWED_HOSTS`
          : 'Refused a request that named no host',
      );
    }
    if (!originAllowed(origin, host, allowedHosts)) {
      return refuse(
        `Refused a page from ${String(origin).slice(0, 200)}: add its host to HOLO_ALLOWED_HOSTS to allow it`,
      );
    }
  });
}
