import { newProject } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { saveWay } from '../src/app/bounce-save.ts';
import {
  bounceTitle,
  dropBounce,
  findBounce,
  type KeptBounce,
  keepBounce,
  keptBounce,
  markBounced,
  startHostBounce,
  watchHostBounce,
} from '../src/app/host-bounce.ts';
import { bouncesOnHost } from '../src/audio/bounce-on.ts';

describe('where a device’s bounces are made', () => {
  it('is the host on a phone or a tablet and this device elsewhere, left to itself', () => {
    expect(bouncesOnHost('auto', true)).toBe(true);
    expect(bouncesOnHost('auto', false)).toBe(false);
  });

  it('is where it’s told, whatever the device', () => {
    expect(bouncesOnHost('host', false)).toBe(true);
    expect(bouncesOnHost('device', true)).toBe(false);
  });

  it('is left to itself when what was kept is nothing it knows', () => {
    expect(bouncesOnHost(undefined, true)).toBe(true);
    expect(bouncesOnHost('server', false)).toBe(false);
  });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const never = () => Promise.resolve();

describe('a bounce asked of the host', () => {
  const song = () => {
    const p = newProject('Lantern Sketch');
    p.id = 'prj_one';
    return p;
  };
  const ask = () => ({ project: song(), from: 960, to: 7680, tail: 3, name: 'Lantern Sketch (cycle)' });

  it('sends the song as the page has it, the stretch and the name, and gets a job to follow', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const job = await startHostBounce(ask(), (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return json({ id: 'bnc_abc', started: 1_700_000_000_000 }, 202);
    }) as typeof fetch);
    // (its job, and when the host began it by the host's own clock)
    expect(job).toEqual({ id: 'bnc_abc', started: 1_700_000_000_000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('/api/projects/prj_one/bounces/host');
    expect(sent[0]?.init.method).toBe('POST');
    const body = JSON.parse(String(sent[0]?.init.body));
    expect(body).toMatchObject({ from: 960, to: 7680, tail: 3, name: 'Lantern Sketch (cycle)' });
    expect(body.doc).toMatchObject({ id: 'prj_one', title: 'Lantern Sketch' });
  });

  it('sends this device’s token when the agent knows it, to be told when it’s done, and none otherwise', async () => {
    const sent: RequestInit[] = [];
    const host = (async (_url: string, init: RequestInit) => {
      sent.push(init);
      return json({ id: 'bnc_abc', started: 1 }, 202);
    }) as typeof fetch;
    await startHostBounce({ ...ask(), token: 'a'.repeat(64) }, host);
    await startHostBounce(ask(), host);
    const headers = (i: number) => (sent[i]?.headers ?? {}) as Record<string, string>;
    expect(headers(0).authorization).toBe(`Bearer ${'a'.repeat(64)}`);
    expect(Object.keys(headers(1))).toEqual(['content-type']);
    // (and never in what's sent of the song)
    expect(String(sent[0]?.body)).not.toContain('a'.repeat(64));
  });

  it.each([
    ['one from before it made bounces', () => json({ error: 'Not found' }, 404)],
    ['one with too many waiting', () => json({ error: 'The host has bounces waiting already' }, 503)],
    ['one that takes the song for something else', () => json({ ok: true }, 200)],
    ['one that answers with no job', () => json({}, 202)],
    [
      'one out of reach',
      () => {
        throw new TypeError('Failed to fetch');
      },
    ],
  ])('is not taken by %s: the device makes it', async (_name, answer) => {
    expect(await startHostBounce(ask(), (async () => answer()) as typeof fetch)).toBeNull();
  });
});

describe('a bounce the host is making, followed', () => {
  /** A host that answers each ask with the next of `answers` (the last one again after that). */
  function host(answers: (() => Response)[]) {
    const asked: string[] = [];
    const waits: number[] = [];
    const fetcher = (async (url: string) => {
      asked.push(url);
      return (answers[Math.min(asked.length, answers.length) - 1] as () => Response)();
    }) as typeof fetch;
    const wait = async (ms: number) => {
      waits.push(ms);
    };
    return { asked, waits, fetcher, wait };
  }
  const running = (line: string) => () => json({ id: 'bnc_a', state: 'running', line });

  it('says how far it has got, then gives the file', async () => {
    const h = host([
      () => json({ id: 'bnc_a', state: 'waiting', line: '' }),
      running(''),
      running('Rendering… 40%'),
      () =>
        json({
          id: 'bnc_a',
          state: 'done',
          file: '2026-01-02 03.04.05 Song.wav',
          url: '/api/projects/prj_one/bounces/2026-01-02%2003.04.05%20Song.wav',
          path: 'bounces/prj_one/2026-01-02 03.04.05 Song.wav',
          seconds: 12.5,
        }),
    ]);
    const lines: string[] = [];
    const made = await watchHostBounce('bnc_a', { onLine: (l) => lines.push(l), fetch: h.fetcher, wait: h.wait });
    expect(made).toEqual({
      state: 'done',
      file: '2026-01-02 03.04.05 Song.wav',
      url: '/api/projects/prj_one/bounces/2026-01-02%2003.04.05%20Song.wav',
      path: 'bounces/prj_one/2026-01-02 03.04.05 Song.wav',
      seconds: 12.5,
    });
    expect(lines).toEqual(['waiting its turn', 'starting', 'Rendering… 40%']);
    expect(h.asked).toEqual(Array(4).fill('/api/bounce-jobs/bnc_a'));
    expect(h.waits).toEqual([1500, 1500, 1500]);
  });

  it('says why one the host couldn’t make failed, and doesn’t call it lost', async () => {
    const h = host([() => json({ state: 'failed', error: 'No instrument vsco2/violin', lost: false })]);
    expect(await watchHostBounce('bnc_a', { fetch: h.fetcher, wait: h.wait })).toEqual({
      state: 'failed',
      error: 'No instrument vsco2/violin',
      lost: false,
    });
  });

  it('calls one lost when the host gave it up untried, or no longer knows of it', async () => {
    const closing = host([() => json({ state: 'failed', error: 'HO[LO] is closing', lost: true })]);
    expect(await watchHostBounce('bnc_a', { fetch: closing.fetcher, wait: closing.wait })).toMatchObject({
      state: 'failed',
      lost: true,
    });
    const restarted = host([running('Rendering… 10%'), () => json({ error: 'No such bounce' }, 404)]);
    expect(await watchHostBounce('bnc_a', { fetch: restarted.fetcher, wait: restarted.wait })).toMatchObject({
      state: 'failed',
      lost: true,
    });
  });

  it('asks again when the host is out of reach for a moment, for as long as it takes', async () => {
    const down = () => {
      throw new TypeError('Failed to fetch');
    };
    const h = host([
      running('Rendering… 10%'),
      down,
      () => json({ error: 'Bad gateway' }, 502),
      down,
      () => json({ state: 'done', file: 'a.wav', url: '/a.wav', path: 'bounces/p/a.wav', seconds: 1 }),
    ]);
    const lines: string[] = [];
    const made = await watchHostBounce('bnc_a', { onLine: (l) => lines.push(l), fetch: h.fetcher, wait: h.wait });
    expect(made.state).toBe('done');
    expect(h.asked).toHaveLength(5);
    expect(lines).toEqual(['Rendering… 10%']);
  });

  it('takes a bounce said done with no file as failed', async () => {
    const h = host([() => json({ state: 'done' })]);
    expect((await watchHostBounce('bnc_a', { fetch: h.fetcher, wait: never })).state).toBe('failed');
  });
});

describe('a bounce kept: under way through a reload, finished until it’s saved', () => {
  function shelf() {
    const kept = new Map<string, string>();
    return {
      kept,
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
      removeItem: (k: string) => void kept.delete(k),
    };
  }
  const one: KeptBounce = {
    id: 'bnc_a',
    project: 'prj_one',
    name: 'Song (cycle)',
    download: true,
    at: 1000,
    started: 900,
  };

  it('comes back as it was kept, and is gone once it’s let go', () => {
    const s = shelf();
    expect(keptBounce(s, 2000)).toBeNull();
    keepBounce(one, s);
    expect(keptBounce(s, 2000)).toEqual(one);
    dropBounce('bnc_a', s);
    expect(keptBounce(s, 2000)).toBeNull();
  });

  it('is marked done with where its file is, and waits there for a week and no longer', () => {
    const s = shelf();
    keepBounce(one, s);
    const done = { url: '/api/projects/prj_one/bounces/a.wav', file: 'a.wav', seconds: 247 };
    markBounced('bnc_a', done, s);
    expect(keptBounce(s, 2000)).toEqual({ ...one, done });
    const day = 24 * 3600 * 1000;
    expect(keptBounce(s, 1000 + 6 * day)?.done).toEqual(done);
    expect(keptBounce(s, 1000 + 8 * day)).toBeNull();
    // (one whose length isn't known: found among the song's bounces after the host was started again)
    markBounced('bnc_a', { url: '/x.wav', file: 'x.wav', seconds: null }, s);
    expect(keptBounce(s, 2000)?.done).toEqual({ url: '/x.wav', file: 'x.wav', seconds: null });
  });

  it('is another tab’s to mark and let go only if it’s still the one kept', () => {
    const s = shelf();
    keepBounce(one, s);
    // another bounce asked for since, from another tab
    keepBounce({ ...one, id: 'bnc_b', name: 'Another' }, s);
    markBounced('bnc_a', { url: '/a.wav', file: 'a.wav', seconds: 1 }, s);
    dropBounce('bnc_a', s);
    expect(keptBounce(s, 2000)).toMatchObject({ id: 'bnc_b', name: 'Another' });
    expect(keptBounce(s, 2000)?.done).toBeUndefined();
  });

  it('reads one kept before this, with no song or times of its own', () => {
    const s = shelf();
    s.kept.set('holo:host-bounce', JSON.stringify({ id: 'bnc_old', name: 'Old', download: true }));
    expect(keptBounce(s, 5000)).toEqual({
      id: 'bnc_old',
      project: '',
      name: 'Old',
      download: true,
      at: 5000,
      started: 5000,
    });
  });

  it('is nothing when what’s there isn’t one, or there’s nowhere to keep it', () => {
    const s = shelf();
    s.kept.set('holo:host-bounce', '{"id":7}');
    expect(keptBounce(s)).toBeNull();
    s.kept.set('holo:host-bounce', 'not json');
    expect(keptBounce(s)).toBeNull();
    const none = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => keepBounce(one, none)).not.toThrow();
    expect(() => dropBounce('bnc_a', none)).not.toThrow();
    expect(keptBounce(none)).toBeNull();
  });
});

describe('a bounce the host forgot, found among the song’s bounces', () => {
  it('names a bounce’s file as the host does', () => {
    // (the host's own cases: apps/server/test/host-bounce.test.ts)
    expect(bounceTitle('Lantern Sketch (cycle)')).toBe('Lantern Sketch (cycle)');
    expect(bounceTitle('../../etc/passwd: "x"')).toBe('....etcpasswd x');
    expect(bounceTitle('  ')).toBe('Bounce');
    expect(bounceTitle('é'.repeat(4) + 'a'.repeat(120))).toHaveLength(80);
  });

  const listed = (...files: string[]) =>
    (async () =>
      json(files.map((file) => ({ file, bytes: 1, url: `/b/${encodeURIComponent(file)}` })))) as typeof fetch;
  // the host began it at 03:04:05 (UTC) on 2 January 2026
  const started = Date.UTC(2026, 0, 2, 3, 4, 5);

  it('is the first file named exactly for it and finished since the host began it', async () => {
    const found = await findBounce(
      'prj_one',
      'Song',
      started,
      listed(
        '2026-01-02 03.20.00 Song.wav',
        '2026-01-02 03.12.40 Song.wav',
        // an earlier bounce of it, and others that only end as it does or begin as it does
        '2026-01-02 03.04.04 Song.wav',
        '2026-01-02 03.10.00 Another Song.wav',
        '2026-01-02 03.11.00 Song (cycle).wav',
      ),
    );
    expect(found).toEqual({
      file: '2026-01-02 03.12.40 Song.wav',
      url: '/b/2026-01-02%2003.12.40%20Song.wav',
      path: 'bounces/prj_one/2026-01-02 03.12.40 Song.wav',
    });
  });

  it('takes one finished in the very second it began, and a name the host had to clean', async () => {
    expect((await findBounce('prj_one', 'Song', started, listed('2026-01-02 03.04.05 Song.wav')))?.file).toBe(
      '2026-01-02 03.04.05 Song.wav',
    );
    expect((await findBounce('prj_one', 'A/B: mix?', started, listed('2026-01-02 03.09.00 AB mix.wav')))?.file).toBe(
      '2026-01-02 03.09.00 AB mix.wav',
    );
  });

  it('is nothing when the host has no such file, or can’t be asked', async () => {
    expect(await findBounce('prj_one', 'Song', started, listed('2026-01-02 03.04.04 Song.wav'))).toBeNull();
    expect(await findBounce('prj_one', 'Song', started, listed())).toBeNull();
    expect(
      await findBounce('prj_one', 'Song', started, (async () => json({ error: 'no' }, 500)) as typeof fetch),
    ).toBeNull();
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    expect(await findBounce('prj_one', 'Song', started, down)).toBeNull();
  });
});

describe('how a device saves a bounce', () => {
  const facts = { iosLike: false, standalone: false, touch: false, canShareFiles: false };

  it('is by itself on a computer, installed or not, able to share or not', () => {
    expect(saveWay(facts)).toBe('auto');
    expect(saveWay({ ...facts, standalone: true, canShareFiles: true })).toBe('auto');
  });

  it('is through the share sheet in an installed iPhone or iPad app, whatever its pointer', () => {
    expect(saveWay({ iosLike: true, standalone: true, touch: true, canShareFiles: true })).toBe('share');
    // (an iPad with a trackpad: its pointer is fine, and it's still an app with no browser around it)
    expect(saveWay({ iosLike: true, standalone: true, touch: false, canShareFiles: true })).toBe('share');
  });

  it('is from a tap on any other phone or tablet, and in an installed app that can’t share files', () => {
    expect(saveWay({ iosLike: true, standalone: false, touch: true, canShareFiles: true })).toBe('tap');
    expect(saveWay({ iosLike: true, standalone: false, touch: false, canShareFiles: true })).toBe('tap');
    expect(saveWay({ iosLike: false, standalone: true, touch: true, canShareFiles: true })).toBe('tap');
    expect(saveWay({ iosLike: true, standalone: true, touch: true, canShareFiles: false })).toBe('tap');
  });
});
