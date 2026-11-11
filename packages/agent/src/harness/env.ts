/**
 * The environment a harness runs with: an allowlist, never the runner's whole environment. Only what
 * a program needs to start and reach the network (home, path, language, terminal, temporary folder,
 * the XDG folders, proxies and certificate authorities), plus that harness's own sign-in variables,
 * plus the switches each adapter sets (docs/agent-harnesses.md). Nothing else the user has set,
 * other tools' keys included, reaches it; never the ssh agent (`SSH_*`). Git, whoever runs it, never
 * uses ssh or the user's own git config (GIT_ENV), and PATH loses the package managers' script folders.
 */
import { posix, win32 } from 'node:path';
import type { HarnessId } from './types.ts';

/** Every harness gets these, when they're set. */
const COMMON: readonly RegExp[] = [
  /^(HOME|PATH|LANG|LANGUAGE|TERM|TMPDIR|TZ|USER|LOGNAME)$/,
  /^LC_[A-Z]+$/,
  /^XDG_[A-Z_]+$/,
  /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|https?_proxy|all_proxy|no_proxy)$/,
  /^(NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/,
];

/** On Windows, what programs can't start without (names there are case-insensitive). */
const WINDOWS: readonly RegExp[] = [
  /^(SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|HOMEDRIVE|HOMEPATH|TEMP|TMP|USERNAME)$/i,
];

/** Each harness's own sign-in (and where it keeps it). */
export const AUTH_ENV: Record<HarnessId, RegExp> = {
  claude: /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR)$/,
  codex: /^(OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|CODEX_HOME)$/,
  cursor: /^(CURSOR_API_KEY|CURSOR_AUTH_TOKEN)$/,
};

/** Set for every Claude Code run: no self-update, none of claude.ai's connectors, no CLAUDE.md. */
export const CLAUDE_ENV: Readonly<Record<string, string>> = {
  DISABLE_AUTOUPDATER: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
};

/**
 * Git as a harness may run it (Cursor fetches its plugins with `git fetch`). ssh reads the real
 * `~/.ssh` and talks to the user's agent whatever HOME says, so git never runs it: `false` stands in
 * for ssh and fails at once. GitHub's ssh addresses are rewritten to anonymous https, so public
 * repositories still come. No system or global git config (the user's credential helpers and URL
 * rewrites), and no asking for a name or password at a terminal.
 */
export const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_SSH_COMMAND: 'false',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_0: 'git@github.com:',
  GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf',
  GIT_CONFIG_VALUE_1: 'ssh://git@github.com/',
};

/** Never passed on, whatever sets them: the ssh agent's socket and the rest of ssh's variables. */
const NEVER = /^SSH_/i;

/** A package's scripts folder (node_modules/.bin), or the one pnpm and npm put node-gyp in. */
const SCRIPTS = /(^|[\\/])node_modules[\\/]\.bin[\\/]?$|[\\/]node-gyp-bin[\\/]?$/i;

/**
 * The folders of PATH a harness keeps: absolute ones, but not a package's scripts (`pnpm runner` puts
 * the repository's `node_modules/.bin` first, and pnpm its `node-gyp-bin`). An empty or relative entry
 * would be looked up in the harness's workspace.
 */
export function harnessPath(path: string, platform: NodeJS.Platform = process.platform): string {
  const win = platform === 'win32';
  const sep = win ? ';' : ':';
  return path
    .split(sep)
    .filter((dir) => dir && (win ? win32 : posix).isAbsolute(dir) && !SCRIPTS.test(dir))
    .join(sep);
}

/** Whether a variable may reach a harness. */
export function allowed(harness: HarnessId, name: string, platform: NodeJS.Platform = process.platform): boolean {
  if (COMMON.some((re) => re.test(name)) || AUTH_ENV[harness].test(name)) return true;
  return platform === 'win32' && WINDOWS.some((re) => re.test(name));
}

/** The allowlisted part of an environment. */
export function baseEnv(
  harness: HarnessId,
  from: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) if (v !== undefined && allowed(harness, k, platform)) out[k] = v;
  return out;
}

/**
 * The environment for a harness: the allowlist, then its own switches (which win), then git's (which
 * nothing undoes). PATH is cleaned, and no `SSH_*` variable is passed, whatever sets it.
 */
export function harnessEnv(
  harness: HarnessId,
  extra: Readonly<Record<string, string>>,
  from: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const out: Record<string, string> = { ...baseEnv(harness, from, platform), ...extra, ...GIT_ENV };
  for (const k of Object.keys(out)) {
    if (NEVER.test(k)) delete out[k];
    else if (k.toUpperCase() === 'PATH') out[k] = harnessPath(out[k] ?? '', platform);
  }
  return out;
}
