import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain script, without types
import {
  copyHere,
  copyNote,
  followCheckout,
  followsOmr,
  goesForward,
  lingerNote,
  omrImage,
  omrOn,
  PREVIOUS,
  plainValue,
  runnerPath,
  runnerUnit,
  startNew,
} from '../update.mjs';

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

describe('lingerNote', () => {
  it('says the service carries on by itself when linger is on', () => {
    const note = lingerNote('the runner', { linger: true, user: 'ana' });
    expect(note).toBe('Linger is on, so the runner keeps running after you log out and starts at boot.');
    expect(note).not.toContain('loginctl');
  });

  it('gives the command to turn it on when linger is off, or unknown', () => {
    const off = lingerNote('the timer', { linger: false, user: 'ana' });
    expect(off).toMatch(/^Linger is off, so the timer stops when you log out/);
    expect(off).toContain('sudo loginctl enable-linger ana');
    const unknown = lingerNote('the runner', { linger: null, user: 'ana' });
    expect(unknown).toMatch(/^Without linger, the runner stops when you log out/);
    expect(unknown).toContain('sudo loginctl enable-linger ana');
  });
});

describe('the recognition engines', () => {
  it('are on unless turned off', () => {
    expect(omrOn({})).toBe(true);
    expect(omrOn({ HOLO_OMR_URL: 'http://omr:8070' })).toBe(true);
    expect(omrOn({ HOLO_OMR_URL: '' })).toBe(false);
    expect(omrOn({ HOLO_OMR_REPLICAS: '0' })).toBe(false);
  });

  it('follow the studio’s channel, unless their image was built here', () => {
    expect(omrImage('stable', 'ghcr.io/o/holo-desk')).toBe('ghcr.io/o/holo-desk:omr-stable');
    expect(omrImage('main', 'ghcr.io/o/holo-desk')).toBe('ghcr.io/o/holo-desk:omr-main');
    expect(followsOmr(undefined, 'ghcr.io/o/holo-desk')).toBe(true);
    expect(followsOmr('ghcr.io/o/holo-desk:omr-main', 'ghcr.io/o/holo-desk')).toBe(true);
    expect(followsOmr('holo-omr:local', 'ghcr.io/o/holo-desk')).toBe(false);
  });
});

/** What `startNew` is given, with what it did written down: the version started answers or not, as told. */
function starting(o: { answers: boolean[]; tags?: boolean; heard?: boolean; busy?: boolean; up?: (string | null)[] }) {
  const did: string[] = [];
  const env: Record<string, string> = {};
  const answers = [...o.answers];
  // (each start in turn: null goes well, words are what Docker said of one that didn't)
  const ups = [...(o.up ?? [])];
  return {
    did,
    env,
    d: {
      heard: async () => o.heard ?? true,
      copy: async () => {
        did.push('copy');
      },
      ...(o.busy === undefined ? {} : { busy: async () => o.busy as boolean }),
      before: () => {
        did.push('before');
      },
      tag: (id: string) => {
        did.push(`tag ${id}`);
        return o.tags ?? true;
      },
      up: () => {
        did.push(`up ${env.HOLO_IMAGE ?? 'new'}`);
        const wrong = ups.shift();
        if (wrong) throw new Error(wrong);
      },
      answers: async (image: string | null) => {
        did.push(`answers? ${image}`);
        return answers.shift() ?? false;
      },
      imageId: () => 'sha256:new',
      setEnv: (key: string, value: string) => {
        env[key] = value;
      },
      log: (line: string) => {
        did.push(`log ${line}`);
      },
    },
  };
}

describe('starting a new version', () => {
  it('copies the database, keeps the version before at hand, then starts it', async () => {
    const s = starting({ answers: [true] });
    expect(await startNew(s.d, 'repo:stable', 'sha256:old')).toBe('started');
    expect(s.did).toEqual(['copy', 'tag sha256:old', 'before', 'up new', 'answers? sha256:new']);
    expect(s.env).toEqual({});
  });

  it('goes back to the version before when the new one doesn’t answer, and notes which didn’t start', async () => {
    const s = starting({ answers: [false, true] });
    expect(await startNew(s.d, 'repo:stable', 'sha256:old')).toBe('back');
    expect(s.env).toEqual({
      HOLO_IMAGE: PREVIOUS,
      HOLO_ROLLED_BACK_FROM: 'sha256:new',
      HOLO_ROLLED_BACK_IMAGE: 'repo:stable',
    });
    expect(s.did.filter((l) => !l.startsWith('log '))).toEqual([
      'copy',
      'tag sha256:old',
      'before',
      'up new',
      'answers? sha256:new',
      `up ${PREVIOUS}`,
      'answers? sha256:old',
    ]);
    expect(s.did.at(-1)).toMatch(/^log HO\[LO\] is back on the version before/);
  });

  it('says so when the version before doesn’t answer either', async () => {
    const s = starting({ answers: [false, false] });
    expect(await startNew(s.d, 'repo:stable', 'sha256:old')).toBe('down');
    expect(s.env.HOLO_IMAGE).toBe(PREVIOUS);
  });

  it('changes nothing when there’s no version to go back to (nothing ran, or it couldn’t be kept)', async () => {
    const none = starting({ answers: [false] });
    expect(await startNew(none.d, 'repo:stable', null)).toBe('down');
    expect(none.env).toEqual({});
    expect(none.did.some((l) => l.startsWith('tag '))).toBe(false);
    const kept = starting({ answers: [false], tags: false });
    expect(await startNew(kept.d, 'repo:stable', 'sha256:old')).toBe('down');
    expect(kept.env).toEqual({});
    expect(kept.did.filter((l) => l.startsWith('up '))).toEqual(['up new']);
  });

  it('never undoes a version on a guess: where HO[LO] couldn’t be heard before, the new one isn’t judged by its silence', async () => {
    const s = starting({ answers: [false], heard: false });
    expect(await startNew(s.d, 'repo:stable', 'sha256:old')).toBe('started');
    expect(s.env).toEqual({});
    expect(s.did.some((l) => l.startsWith('answers?'))).toBe(false);
    expect(s.did.at(-1)).toMatch(/^log HO\[LO\] couldn’t be heard from here before this update/);
    // (a first start, or HO[LO] stopped on purpose: nothing was running to be heard, and nothing is said)
    const first = starting({ answers: [], heard: false });
    expect(await startNew(first.d, 'repo:stable', null)).toBe('started');
    expect(first.did.some((l) => l.startsWith('log '))).toBe(false);
  });

  it('goes back when the new version can’t be started at all, heard before or not', async () => {
    for (const heard of [true, false]) {
      const s = starting({ answers: [true], heard, up: ['exec format error'] });
      expect(await startNew(s.d, 'repo:stable', 'sha256:old')).toBe('back');
      expect(s.env).toMatchObject({ HOLO_IMAGE: PREVIOUS, HOLO_ROLLED_BACK_FROM: 'sha256:new' });
      expect(s.did.some((l) => /^log The new version couldn’t be started \(exec format error\)/.test(l))).toBe(true);
      expect(s.did.filter((l) => l.startsWith('up '))).toEqual(['up new', `up ${PREVIOUS}`]);
    }
    const stuck = starting({ answers: [], up: ['no such image', 'no such image'] });
    expect(await startNew(stuck.d, 'repo:stable', 'sha256:old')).toBe('down');
    const none = starting({ answers: [], up: ['exec format error'] });
    expect(await startNew(none.d, 'repo:stable', null)).toBe('down');
    expect(none.env).toEqual({});
  });

  it('starts nothing when HO[LO] became busy while the copy was made', async () => {
    const s = starting({ answers: [true], busy: true });
    expect(await startNew(s.d, 'repo:stable', 'sha256:old')).toBe('waiting');
    expect(s.did).toEqual(['copy']);
    const free = starting({ answers: [true], busy: false });
    expect(await startNew(free.d, 'repo:stable', 'sha256:old')).toBe('started');
  });

  it('reads .env’s values as compose does: without their quotes or a comment after them', () => {
    expect(plainValue('"47800"')).toBe('47800');
    expect(plainValue("'/srv/holo data'")).toBe('/srv/holo data');
    expect(plainValue('47800 # the studio')).toBe('47800');
    expect(plainValue('  ./data  ')).toBe('./data');
    expect(plainValue(undefined)).toBe('');
  });

  it('goes forward again only to another version than the one that didn’t start', () => {
    const values = { HOLO_IMAGE: PREVIOUS, HOLO_ROLLED_BACK_FROM: 'sha256:bad' };
    expect(goesForward(values, 'sha256:bad')).toBe(false);
    expect(goesForward(values, 'sha256:newer')).toBe(true);
    expect(goesForward(values, null)).toBe(false);
  });
});

describe('the copy of the songs’ database', () => {
  it('is said as it went', () => {
    expect(copyNote(200, { file: 'backups/holo-1.2.3-20310506T070809Z.db', size: 3 * 1024 ** 2 })).toBe(
      'The songs’ database was copied first: backups/holo-1.2.3-20310506T070809Z.db (3 MB)',
    );
    expect(copyNote(507, { need: 3 * 1024 ** 3, free: 200 * 1024 ** 2 })).toBe(
      'No room for a copy of the songs’ database (it needs 3.0 GB, 200 MB are free): updating without one',
    );
    expect(copyNote(200, { file: 'backups/a.db', size: 118_784 })).toMatch(/\(116 KB\)$/);
    expect(copyNote(404, null)).toMatch(/can’t copy its database yet/);
    expect(copyNote(403, null)).toMatch(/runner key/);
    expect(copyNote(500, null)).toMatch(/answered 500/);
  });

  it('is made from here when the server doesn’t answer: whole, in the data folder’s backups', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'holo-copy-'));
    made.push(dir);
    expect(await copyHere(dir)).toBeNull();
    const db = new DatabaseSync(join(dir, 'holo.db'));
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE songs (title TEXT); INSERT INTO songs VALUES ('Lantern Sketch')");
    const note = await copyHere(dir, new Date(Date.UTC(2031, 4, 6, 7, 8, 9)));
    db.close();
    expect(note).toMatch(/^The songs’ database was copied first: backups.holo-before-update-20310506T070809Z\.db/);
    expect(readdirSync(join(dir, 'backups'))).toEqual(['holo-before-update-20310506T070809Z.db']);
    const copy = new DatabaseSync(join(dir, 'backups', 'holo-before-update-20310506T070809Z.db'), { readOnly: true });
    expect(copy.prepare('SELECT title FROM songs').all()).toEqual([{ title: 'Lantern Sketch' }]);
    copy.close();
  });

  it('isn’t made from here without room for it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'holo-copy-'));
    made.push(dir);
    new DatabaseSync(join(dir, 'holo.db')).close();
    expect(await copyHere(dir, new Date(), 1024)).toMatch(/^No room for a copy/);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  });
});
