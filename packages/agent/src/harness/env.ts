/**
 * The environment a harness runs with: an allowlist, never the runner's whole environment. Only what
 * a program needs to start and reach the network (home, path, language, terminal, temporary folder,
 * the XDG folders, proxies and certificate authorities), plus that harness's own sign-in variables,
 * plus the switches each adapter sets (docs/agent-harnesses.md). Nothing else the user has set,
 * other tools' keys included, reaches it.
 */
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

/** The environment for a harness: the allowlist, then its own switches (which win). */
export function harnessEnv(
  harness: HarnessId,
  extra: Readonly<Record<string, string>>,
  from: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return { ...baseEnv(harness, from, platform), ...extra };
}
