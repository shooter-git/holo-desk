import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** The engines' image CI publishes, for a server that runs them itself. */
export const OMR_IMAGE = 'ghcr.io/shooter-git/holo-desk:omr-stable';

/** Settings come from the environment (.env when run by hand, the compose file in Docker). */
export interface Config {
  port: number;
  host: string;
  dataDir: string;
  creationsDir: string | null;
  webDir: string;
  /** HO[LO]'s own folder (its engine's sources: what experiences' pinned engines are measured against). */
  repoDir: string;
  /** HO[LO] as a network MIDI session (RTP-MIDI: an iPhone's USB MIDI, a Mac's network MIDI). */
  networkMidi: { port: number; host: string } | null;
  /**
   * The recognition engines, which read scanned sheet music into songs: where they answer (in Docker,
   * their own container), or null.
   */
  omrUrl?: string | null;
  /**
   * Run without Docker and given no address: the engines' image, which the server runs itself in a
   * container of its own (with no network) the first time a scan wants it. Null: it doesn't.
   */
  omrImage?: string | null;
  /**
   * Sites besides HO[LO]'s usual kinds (this computer, the local network, a tailnet) whose pages may
   * use the live channel and the agent: host names, host:port, or origins (HOLO_ALLOWED_HOSTS).
   */
  allowedHosts?: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, inContainer = existsSync('/.dockerenv')): Config {
  const root = resolve(import.meta.dirname, '../../..');
  return {
    port: Number(env.HOLO_PORT ?? 47800),
    // on this machine only; other devices come through Tailscale Serve (HTTPS)
    host: env.HOLO_HOST ?? '127.0.0.1',
    dataDir: resolve(root, env.HOLO_DATA_DIR ?? './data'),
    creationsDir: env.HOLO_CREATIONS_DIR ? resolve(root, env.HOLO_CREATIONS_DIR) : null,
    webDir: resolve(root, env.HOLO_WEB_DIR ?? 'apps/web/dist'),
    repoDir: root,
    // a studio served from a public name of your own, say (comma-separated)
    allowedHosts: (env.HOLO_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    ...omr(env, inContainer),
    // off unless asked for: it listens on UDP (in Docker, where it's published decides who reaches it)
    networkMidi:
      env.HOLO_NETWORK_MIDI === 'on'
        ? { port: Number(env.HOLO_NETWORK_MIDI_PORT ?? 5004), host: env.HOLO_NETWORK_MIDI_HOST ?? '0.0.0.0' }
        : null,
  };
}

/**
 * The recognition engines, on unless turned off: HOLO_OMR_URL is where they answer (Docker's compose
 * file sets their container's), and set empty they're off (pnpm omr off). Not set at all, a server run
 * without Docker runs them itself, from HOLO_OMR_IMAGE (in a container of its own, when the computer
 * has Docker); one in a container it wasn't given them for goes without.
 */
function omr(env: NodeJS.ProcessEnv, inContainer: boolean): Pick<Config, 'omrUrl' | 'omrImage'> {
  const url = env.HOLO_OMR_URL;
  if (url !== undefined) return { omrUrl: url.trim().replace(/\/$/, '') || null, omrImage: null };
  if (inContainer) return { omrUrl: null, omrImage: null };
  return { omrUrl: null, omrImage: env.HOLO_OMR_IMAGE?.trim() || OMR_IMAGE };
}
