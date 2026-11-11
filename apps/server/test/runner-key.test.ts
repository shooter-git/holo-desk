import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runnerKey, sameKey } from '../src/agent/keys.ts';

const work = mkdtempSync(join(tmpdir(), 'holo-key-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('the runner key', () => {
  it('is made once, in the data folder (made if need be), readable only by its owner', () => {
    const dir = join(work, 'new', 'data');
    const key = runnerKey(dir);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'runner.key')).mode & 0o777).toBe(0o600);
    // the same one from then on
    expect(runnerKey(dir)).toBe(key);
    expect(runnerKey(join(work, 'other'))).not.toBe(key);
  });

  it('keeps one already there, closing its permissions, and replaces a damaged one', () => {
    const dir = join(work, 'kept');
    const key = runnerKey(dir);
    const file = join(dir, 'runner.key');
    writeFileSync(file, `${'0f'.repeat(32)}\n`, { mode: 0o644 });
    expect(runnerKey(dir)).toBe('0f'.repeat(32));
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, '');
    const fresh = runnerKey(dir);
    expect(fresh).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh).not.toBe(key);
    expect(runnerKey(dir)).toBe(fresh);
  });

  it('compares keys whatever their lengths', () => {
    const key = 'ab'.repeat(32);
    expect(sameKey(key, key)).toBe(true);
    expect(sameKey('ab'.repeat(31), key)).toBe(false);
    expect(sameKey(`${key}0`, key)).toBe(false);
    expect(sameKey('', key)).toBe(false);
  });
});
