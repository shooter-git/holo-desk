import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain script, without types
import { followCheckout, runnerPath, runnerUnit } from '../update.mjs';

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** git as a test's author (no global config needed). */
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  }).trim();

/** A remote with two releases (v1, v2), and a clone of it on main at v1. */
function world() {
  const base = mkdtempSync(join(tmpdir(), 'holo-follow-'));
  made.push(base);
  const origin = join(base, 'origin');
  git(base, 'init', '-q', '-b', 'main', origin);
  const commit = (cwd: string, file: string, text: string) => {
    writeFileSync(join(cwd, file), text);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-q', '-m', text);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  const v1 = commit(origin, 'compose.yml', 'one');
  git(origin, 'tag', 'v1');
  const clone = join(base, 'clone');
  git(base, 'clone', '-q', origin, clone);
  const v2 = commit(origin, 'compose.yml', 'two');
  git(origin, 'tag', 'v2');
  git(clone, 'fetch', '-q', '--tags', 'origin');
  return { origin, clone, v1, v2, commit };
}

describe('followCheckout', () => {
  it('moves a checkout on no branch forward, and leaves one already there', () => {
    const { clone, v1, v2 } = world();
    git(clone, 'checkout', '-q', '--detach', v1);
    expect(followCheckout(clone, 'refs/tags/v2')).toBe(v2);
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(v2);
    expect(followCheckout(clone, 'refs/tags/v2')).toBeNull();
  });

  it('never moves a branch by itself; by hand, only main, leaving the branch where it was', () => {
    const { clone, v1, v2 } = world();
    expect(followCheckout(clone, 'refs/tags/v2')).toBeNull();
    expect(git(clone, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(followCheckout(clone, 'refs/tags/v2', true)).toBe(v2);
    expect(() => git(clone, 'symbolic-ref', '-q', 'HEAD')).toThrow();
    expect(git(clone, 'rev-parse', 'main')).toBe(v1);
  });

  it('leaves any other branch, pushed and clean or not, even by hand', () => {
    const { clone, origin } = world();
    git(clone, 'checkout', '-q', '-b', 'feature', 'v1');
    git(clone, 'push', '-q', '-u', 'origin', 'feature');
    expect(followCheckout(clone, 'refs/tags/v2', true)).toBeNull();
    expect(git(clone, 'symbolic-ref', '--short', 'HEAD')).toBe('feature');
    expect(git(origin, 'rev-parse', '--verify', 'feature')).toBeTruthy();
  });

  it('counts untracked files (.env, data) as nothing', () => {
    const { clone, v1, v2 } = world();
    git(clone, 'checkout', '-q', '--detach', v1);
    writeFileSync(join(clone, '.env'), 'HOLO_PORT=47800\n');
    expect(followCheckout(clone, 'refs/tags/v2')).toBe(v2);
  });

  it('leaves a checkout with changes to its files', () => {
    const { clone, v1 } = world();
    git(clone, 'checkout', '-q', '--detach', v1);
    writeFileSync(join(clone, 'compose.yml'), 'mine');
    expect(followCheckout(clone, 'refs/tags/v2', true)).toBeNull();
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(v1);
  });

  it('leaves commits of its own, and never goes back', () => {
    const { clone, v1, v2, commit } = world();
    git(clone, 'checkout', '-q', '--detach', v1);
    const mine = commit(clone, 'notes.txt', 'my work, on no branch');
    expect(followCheckout(clone, 'refs/tags/v2', true)).toBeNull();
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(mine);
    git(clone, 'checkout', '-q', '--detach', v2);
    expect(followCheckout(clone, 'refs/tags/v1', true)).toBeNull();
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(v2);
  });

  it('does nothing for a target it doesn’t have', () => {
    const { clone, v1 } = world();
    git(clone, 'checkout', '-q', '--detach', v1);
    expect(followCheckout(clone, 'refs/tags/v9', true)).toBeNull();
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(v1);
  });
});

describe('the runner as a service', () => {
  it('keeps the PATH’s absolute folders, without a package’s scripts, node’s first', () => {
    const path = [
      '/srv/holo/node_modules/.bin',
      '/srv/holo/packages/cli/node_modules/.bin/',
      '/opt/pnpm/dist/node-gyp-bin',
      '',
      'bin',
      '/opt/tools/bin',
      '/usr/bin',
      '/opt/node/bin',
    ].join(':');
    expect(runnerPath(path, '/opt/node/bin/node')).toBe('/opt/node/bin:/opt/tools/bin:/usr/bin');
  });

  it('runs the runner from the checkout, its packages first, a % kept as one', () => {
    const unit = runnerUnit('/srv/holo 100%', '/opt/node/bin/node', '/opt/node/bin:/usr/bin', '/opt/node/bin/pnpm');
    expect(unit).toContain('WorkingDirectory=/srv/holo 100%%\n');
    expect(unit).toContain('Environment="PATH=/opt/node/bin:/usr/bin"\n');
    expect(unit).toContain(
      'ExecStartPre=-"/opt/node/bin/pnpm" install --frozen-lockfile --prefer-offline --filter @holo/cli...\n',
    );
    expect(unit).toContain(
      'ExecStart="/opt/node/bin/node" --env-file-if-exists=.env --disable-warning=ExperimentalWarning "/srv/holo 100%%/packages/cli/src/main.ts" runner\n',
    );
    expect(unit).toContain('Restart=always\n');
    expect(unit).toContain('WantedBy=default.target\n');
    // without pnpm: no install step
    expect(runnerUnit('/srv/holo', '/opt/node/bin/node', '/usr/bin', null)).not.toContain('ExecStartPre');
  });
});
