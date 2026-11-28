/**
 * Where a stand-in run finds HO[LO]'s MCP server: as each harness is told of it (Claude Code in the
 * file `--mcp-config` names, Codex in its `-c mcp_servers.holo.…` settings).
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface Server {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The MCP server a Claude Code config names "holo". */
export function claudeServer(config: string): Server | null {
  try {
    const d = JSON.parse(config) as unknown;
    const holo = isObject(d) && isObject(d.mcpServers) ? d.mcpServers.holo : null;
    if (!isObject(holo) || typeof holo.command !== 'string') return null;
    return {
      command: holo.command,
      args: Array.isArray(holo.args) ? holo.args.map(String) : [],
      env: isObject(holo.env) ? Object.fromEntries(Object.entries(holo.env).map(([k, v]) => [k, String(v)])) : {},
    };
  } catch {
    return null;
  }
}

/** The `-c key=value` settings of an argv. */
function settings(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== '-c') continue;
    const kv = argv[i + 1] ?? '';
    const at = kv.indexOf('=');
    if (at > 0) out.set(kv.slice(0, at), kv.slice(at + 1));
  }
  return out;
}

/** The MCP server a Codex run's settings name "holo" (its values are TOML that is JSON too, but for the env's table). */
export function codexServer(argv: readonly string[]): Server | null {
  const c = settings(argv);
  try {
    const command = JSON.parse(c.get('mcp_servers.holo.command') ?? 'null') as unknown;
    const args = JSON.parse(c.get('mcp_servers.holo.args') ?? '[]') as unknown;
    if (typeof command !== 'string' || !Array.isArray(args)) return null;
    const env: Record<string, string> = {};
    for (const [, key, value] of (c.get('mcp_servers.holo.env') ?? '').matchAll(
      /([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*")/g,
    ))
      if (key && value) env[key] = JSON.parse(value) as string;
    return { command, args: args.map(String), env };
  } catch {
    return null;
  }
}
