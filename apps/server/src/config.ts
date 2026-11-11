import { resolve } from 'node:path';

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
  /** The recognition engines' container (pnpm omr on), when it's running: a second reader of scans. */
  omrUrl?: string | null;
  /**
   * Sites besides HO[LO]'s usual kinds (this computer, the local network, a tailnet) whose pages may
   * use the live channel and the agent: host names, host:port, or origins (HOLO_ALLOWED_HOSTS).
   */
  allowedHosts?: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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
    // off unless asked for: it listens on UDP (in Docker, where it's published decides who reaches it)
    omrUrl: env.HOLO_OMR_URL?.replace(/\/$/, '') || null,
    networkMidi:
      env.HOLO_NETWORK_MIDI === 'on'
        ? { port: Number(env.HOLO_NETWORK_MIDI_PORT ?? 5004), host: env.HOLO_NETWORK_MIDI_HOST ?? '0.0.0.0' }
        : null,
  };
}
