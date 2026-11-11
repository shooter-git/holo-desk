import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readRunnerKey, runnerKeyFile } from '../src/runner-key.ts';

const repo = mkdtempSync(join(tmpdir(), 'holo-runner-key-test-'));
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const KEY = 'ab'.repeat(32);

describe('the runner reading its key', () => {
  it('finds it in the data folder as the server does: HOLO_DATA_DIR from the repository, ./data by default', () => {
    expect(runnerKeyFile(repo, {})).toBe(join(repo, 'data', 'runner.key'));
    expect(runnerKeyFile(repo, { HOLO_DATA_DIR: 'elsewhere/data' })).toBe(
      join(repo, 'elsewhere', 'data', 'runner.key'),
    );
    expect(runnerKeyFile(repo, { HOLO_DATA_DIR: '/srv/holo' })).toBe(join('/srv/holo', 'runner.key'));
  });

  it('reads the key the server made', () => {
    expect(readRunnerKey(repo, {})).toBeNull();
    mkdirSync(join(repo, 'data'));
    writeFileSync(join(repo, 'data', 'runner.key'), `${KEY}\n`, { mode: 0o600 });
    expect(readRunnerKey(repo, {})).toBe(KEY);
    expect(readRunnerKey(repo, { HOLO_DATA_DIR: 'nowhere' })).toBeNull();
    writeFileSync(join(repo, 'data', 'runner.key'), '\n');
    expect(readRunnerKey(repo, {})).toBeNull();
  });

  it('takes HOLO_RUNNER_KEY first', () => {
    expect(readRunnerKey(repo, { HOLO_RUNNER_KEY: ` ${'cd'.repeat(32)} `, HOLO_DATA_DIR: 'nowhere' })).toBe(
      'cd'.repeat(32),
    );
    expect(readRunnerKey(repo, { HOLO_RUNNER_KEY: '', HOLO_DATA_DIR: 'nowhere' })).toBeNull();
  });
});
