import { describe, expect, it } from 'vitest';
import { loadConfig, OMR_IMAGE } from '../src/config.ts';
import { type Docker, dockerEngines, type Ran } from '../src/omr-docker.ts';

const ok = (out = ''): Ran => ({ code: 0, out: Buffer.from(out), err: '' });
const failed = (err: string, extra: Partial<Ran> = {}): Ran => ({ code: 1, out: Buffer.alloc(0), err, ...extra });
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A stand-in for the docker command: what each call asked, answered by `answer`. */
function fakeDocker(answer: (args: string[], input?: Buffer) => Ran | Promise<Ran>): {
  run: Docker;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args, { input }) => {
      calls.push(args);
      return answer(args, input);
    },
  };
}

describe('the engines a server runs itself', () => {
  it('are on by default without Docker, at the address given, or off when set empty', () => {
    expect(loadConfig({}, false)).toMatchObject({ omrUrl: null, omrImage: OMR_IMAGE });
    expect(loadConfig({ HOLO_OMR_IMAGE: 'my/omr:1' }, false)).toMatchObject({ omrImage: 'my/omr:1' });
    expect(loadConfig({ HOLO_OMR_URL: 'http://omr:8070/' }, false)).toMatchObject({
      omrUrl: 'http://omr:8070',
      omrImage: null,
    });
    expect(loadConfig({ HOLO_OMR_URL: '' }, false)).toMatchObject({ omrUrl: null, omrImage: null });
    // in a container it wasn't given them for, it doesn't try to run Docker
    expect(loadConfig({}, true)).toMatchObject({ omrUrl: null, omrImage: null, omrUnset: true });
  });

  it('start in a container with no network the first time they are asked for, then read through it', async () => {
    let running = false;
    const { run, calls } = fakeDocker((args, input) => {
      if (args[0] === 'version') return ok('29.0.0');
      if (args[0] === 'inspect') return running ? ok('true') : failed('No such object');
      if (args[0] === 'run') {
        running = true;
        return ok('abc123');
      }
      if (args[0] === 'exec' && args.includes('/health')) return ok(JSON.stringify({ engines: ['audiveris', 'homr'] }));
      if (args[0] === 'exec' && args.includes('/read'))
        return ok(JSON.stringify({ readings: [{ engine: 'homr', musicxml: `<score>${input?.length}</score>` }] }));
      return ok();
    });
    const engines = dockerEngines('ghcr.io/x/holo-desk:omr-stable', '/data/a', run);
    expect(await engines.status()).toEqual({ available: false, engines: [], why: 'starting' });
    for (let i = 0; i < 10; i++) await settle();
    expect(await engines.status()).toEqual({ available: true, engines: ['audiveris', 'homr'] });
    const started = calls.find((c) => c[0] === 'run') ?? [];
    expect(started).toEqual(expect.arrayContaining(['--network', 'none', '--rm', 'ghcr.io/x/holo-desk:omr-stable']));
    const readings = await engines.read(Buffer.from('a page'), 'image/png');
    expect(readings).toEqual([{ engine: 'homr', musicxml: '<score>6</score>' }]);
    const read = calls.find((c) => c.includes('/read')) ?? [];
    expect(read.slice(0, 2)).toEqual(['exec', '-i']);
    expect(read.at(-1)).toBe('image/png');
    await engines.close?.();
    expect(calls.at(-1)?.slice(0, 2)).toEqual(['rm', '-f']);
  });

  it('use the container a server left running, named for its data folder', async () => {
    const { run, calls } = fakeDocker((args) => {
      if (args[0] === 'inspect') return ok('true\n');
      if (args[0] === 'exec') return ok(JSON.stringify({ engines: ['homr'] }));
      return ok();
    });
    const a = dockerEngines('img', '/data/a', run);
    await a.status();
    for (let i = 0; i < 10; i++) await settle();
    expect(await a.status()).toEqual({ available: true, engines: ['homr'] });
    expect(calls.some((c) => c[0] === 'run')).toBe(false);
    const name = calls.find((c) => c[0] === 'inspect')?.at(-1);
    expect(name).toMatch(/^holo-omr-[0-9a-f]{10}$/);
    // another studio's data folder: another container
    const b = fakeDocker(() => ok());
    await dockerEngines('img', '/data/b', b.run).status();
    for (let i = 0; i < 10; i++) await settle();
    expect(b.calls.find((c) => c[0] === 'inspect')?.at(-1)).not.toBe(name);
  });

  it('say so when there is no Docker, and look again a minute later', async () => {
    const { run, calls } = fakeDocker((args) =>
      args[0] === 'version' ? failed('spawn docker ENOENT', { code: -1, missing: true }) : ok(),
    );
    const engines = dockerEngines('img', '/data/a', run);
    await engines.status();
    for (let i = 0; i < 5; i++) await settle();
    expect(await engines.status()).toEqual({
      available: false,
      engines: [],
      why: 'no-docker',
      detail: 'Docker isn’t installed',
    });
    expect(calls.filter((c) => c[0] === 'version')).toHaveLength(1);
  });

  it('say what went wrong when the image would not start', async () => {
    const { run } = fakeDocker((args) => {
      if (args[0] === 'inspect') return failed('No such object');
      if (args[0] === 'run') return failed('Unable to find image\nError response from daemon: pull access denied');
      return ok();
    });
    const engines = dockerEngines('img', '/data/a', run);
    await engines.status();
    for (let i = 0; i < 10; i++) await settle();
    expect(await engines.status()).toMatchObject({
      available: false,
      why: 'unreachable',
      detail: 'Error response from daemon: pull access denied',
    });
  });

  it('stop a first pull when the server stops, and leave nothing running', async () => {
    let release = () => {};
    let pulling: AbortSignal | undefined;
    const calls: string[][] = [];
    const run: Docker = async (args, { signal }) => {
      calls.push(args);
      if (args[0] === 'inspect') return failed('No such object');
      if (args[0] === 'run') {
        pulling = signal;
        return new Promise<Ran>((r) => (release = () => r(ok('id'))));
      }
      return ok();
    };
    const engines = dockerEngines('img', '/data/a', run);
    await engines.status();
    for (let i = 0; i < 5; i++) await settle();
    await engines.close?.();
    // the pull is stopped, and whatever it made is removed
    expect(pulling?.aborted).toBe(true);
    expect(calls.at(-1)?.slice(0, 2)).toEqual(['rm', '-f']);
    // (a docker that finished anyway: removed too, and nothing's asked of it)
    release();
    for (let i = 0; i < 5; i++) await settle();
    expect(calls.at(-1)?.slice(0, 2)).toEqual(['rm', '-f']);
    expect(calls.some((c) => c[0] === 'exec')).toBe(false);
  });
});
