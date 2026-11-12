/**
 * Install, with fake installers only: the PATH the installer gets holds nothing but a fake `curl` (it
 * records what it was asked for and prints a fake installer script) and links to the few system tools
 * that script uses, so no real download can happen. HOME is a temporary folder.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NOT_SEEN } from '../src/harness/adapter.ts';
import { claudeHarness } from '../src/harness/claude.ts';
import { codexHarness } from '../src/harness/codex.ts';
import { cursorHarness } from '../src/harness/cursor.ts';
import type { AdapterOptions, Harness } from '../src/harness/index.ts';
import { q, REPO, type Sandbox, sandbox } from './fakes.ts';

let s: Sandbox;
afterEach(() => s?.cleanup());

const OFFICIAL = {
  claude: { make: claudeHarness, program: 'claude', curl: ['-fsSL', 'https://claude.ai/install.sh'], shell: 'bash' },
  codex: { make: codexHarness, program: 'codex', curl: ['-fsSL', 'https://chatgpt.com/codex/install.sh'], shell: 'sh' },
  cursor: { make: cursorHarness, program: 'cursor-agent', curl: ['https://cursor.com/install', '-fsS'], shell: 'bash' },
} as const;

type Id = keyof typeof OFFICIAL;

/**
 * The tools the installer may reach: a fake curl, and links to bash, sh and what the fake script uses.
 * `script` is what curl prints (the installer); `curlExit` makes the download fail.
 */
function tools(o: { script: string; curlExit?: number }): string {
  const dir = join(s.dir, 'tools');
  mkdirSync(dir, { recursive: true });
  for (const t of ['bash', 'sh', 'mkdir', 'chmod', 'cat', 'env', 'pwd'])
    for (const from of [`/bin/${t}`, `/usr/bin/${t}`])
      if (existsSync(from) && !existsSync(join(dir, t))) symlinkSync(from, join(dir, t));
  const rec = q(s.rec);
  writeFileSync(
    join(dir, 'curl'),
    `#!/bin/sh
for a in "$@"; do printf '%s\\0' "$a"; done > ${rec}/curl-argv
env -0 > ${rec}/curl-env
pwd > ${rec}/curl-cwd
${o.curlExit ? `echo "curl: (22) The requested URL returned error: 404" >&2; exit ${o.curlExit}` : `cat <<'EOF'\n${o.script}\nEOF`}
`,
  );
  chmodSync(join(dir, 'curl'), 0o755);
  writeFileSync(join(s.rec, 'installer.sh'), o.script);
  return dir;
}

/** A fake installer: says what it does, records the shell it ran in, and puts a program where it says. */
function installer(program: string, version: string, where = '$HOME/.local/bin'): string {
  return `echo "Installing ${program} ${version}"
echo "$0" > ${q(join(s.rec, 'installer-shell'))}
mkdir -p "${where}"
cat > "${where}/${program}" <<'PROG'
#!/bin/sh
case "$*" in
  --version) echo "${version}"; exit 0 ;;
esac
exit 1
PROG
chmod 755 "${where}/${program}"
echo "Installed to ${where}/${program}"`;
}

function harness(id: Id, path: string, over: Partial<AdapterOptions> = {}): Harness {
  return OFFICIAL[id].make({
    env: { ...s.env, PATH: path },
    platform: 'linux',
    root: s.root,
    repo: REPO,
    fetchText: async () => {
      throw new Error('offline');
    },
    ...over,
  });
}

const curlArgv = () => readFileSync(join(s.rec, 'curl-argv'), 'utf8').split('\0').slice(0, -1);
const curlEnv = () => readFileSync(join(s.rec, 'curl-env'), 'utf8').split('\0');

describe('Install', () => {
  for (const id of Object.keys(OFFICIAL) as Id[]) {
    it(`runs ${id}’s official installer, with the user’s own home, and finds what it put in ~/.local/bin`, async () => {
      s = sandbox();
      const { program, curl, shell } = OFFICIAL[id];
      const path = tools({ script: installer(program, '9.8.7') });
      const h = harness(id, path);
      const before = await h.info();
      expect(before).toMatchObject({ id, found: false, sealed: false });
      expect(before.installer).toMatch(/^curl /);
      const lines: string[] = [];
      await h.install((l) => lines.push(l));
      // the fixed command: the vendor's address, its own shell
      expect(curlArgv()).toEqual(curl);
      expect(readFileSync(join(s.rec, 'installer-shell'), 'utf8').trim()).toBe(shell);
      expect(lines[0]).toBe(`Installing ${program} 9.8.7`);
      // as the user's update runs: their real home, the allowlist, no ssh agent, nothing else of theirs
      const env = curlEnv();
      expect(env).toContain(`HOME=${s.home}`);
      expect(env.some((e) => e.startsWith('SSH_'))).toBe(false);
      expect(env.some((e) => e.startsWith('SECRET_OF_ANOTHER_TOOL=') || e.startsWith('GITHUB_TOKEN='))).toBe(false);
      expect(readFileSync(join(s.rec, 'curl-cwd'), 'utf8').trim()).toBe(join(s.root, '.probe'));
      expect(existsSync(join(s.home, '.local', 'bin', program))).toBe(true);
      // looked at again: found, with its version
      expect(await h.detect()).toEqual({ path: join(s.home, '.local', 'bin', program), prefix: [] });
      expect(await h.info()).toMatchObject({ id, found: true, version: '9.8.7' });
      expect((await h.info()).installer).toBeUndefined();
    });
  }

  it('is refused when the harness is installed already: no installer runs', async () => {
    s = sandbox();
    const path = tools({ script: installer('codex', '1.0.0') });
    const bin = join(s.home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\necho "codex-cli 0.167.1"\n');
    chmodSync(join(bin, 'codex'), 0o755);
    const h = harness('codex', path);
    await expect(h.install(() => undefined)).rejects.toThrow('Codex is installed already');
    expect(existsSync(join(s.rec, 'curl-argv'))).toBe(false);
  });

  it('says plainly when what it installed can’t be found by the runner', async () => {
    s = sandbox();
    const path = tools({ script: installer('cursor-agent', '2026.11.11-b912975', '$HOME/elsewhere/bin') });
    const h = harness('cursor', path);
    await expect(h.install(() => undefined)).rejects.toThrow(NOT_SEEN);
    expect(NOT_SEEN).toBe(
      'Installed in ~/.local/bin, which the runner doesn’t see: run `pnpm run runner-service on` again on the host',
    );
    expect((await h.info()).found).toBe(false);
  });

  it('fails when the download fails (pipefail), with curl’s words', async () => {
    s = sandbox();
    const path = tools({ script: installer('claude', '2.1.400'), curlExit: 22 });
    const h = harness('claude', path);
    await expect(h.install(() => undefined)).rejects.toThrow(/curl: \(22\)/);
    expect((await h.info()).found).toBe(false);
  });

  it('isn’t offered on Windows, where the installers don’t run', async () => {
    s = sandbox();
    const h = harness('claude', tools({ script: '' }), { platform: 'win32' });
    expect((await h.info()).installer).toBeUndefined();
    await expect(h.install(() => undefined)).rejects.toThrow('Linux and macOS');
    expect(existsSync(join(s.rec, 'curl-argv'))).toBe(false);
  });
});
