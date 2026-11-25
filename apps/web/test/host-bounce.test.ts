import { newProject } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { keepBounce, keptBounce, startHostBounce, watchHostBounce } from '../src/app/host-bounce.ts';
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
    const id = await startHostBounce(ask(), (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return json({ id: 'bnc_abc' }, 202);
    }) as typeof fetch);
    expect(id).toBe('bnc_abc');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('/api/projects/prj_one/bounces/host');
    expect(sent[0]?.init.method).toBe('POST');
    const body = JSON.parse(String(sent[0]?.init.body));
    expect(body).toMatchObject({ from: 960, to: 7680, tail: 3, name: 'Lantern Sketch (cycle)' });
    expect(body.doc).toMatchObject({ id: 'prj_one', title: 'Lantern Sketch' });
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

describe('a bounce under way, kept through a reload', () => {
  function shelf() {
    const kept = new Map<string, string>();
    return {
      kept,
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
      removeItem: (k: string) => void kept.delete(k),
    };
  }

  it('comes back as it was kept, and is gone once it’s let go', () => {
    const s = shelf();
    expect(keptBounce(s)).toBeNull();
    keepBounce({ id: 'bnc_a', name: 'Song (cycle)', download: true }, s);
    expect(keptBounce(s)).toEqual({ id: 'bnc_a', name: 'Song (cycle)', download: true });
    keepBounce(null, s);
    expect(keptBounce(s)).toBeNull();
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
      removeItem: () => undefined,
    };
    expect(() => keepBounce({ id: 'bnc_a', name: 'Song', download: false }, none)).not.toThrow();
    expect(keptBounce(none)).toBeNull();
  });
});
