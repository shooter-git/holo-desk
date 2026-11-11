import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Attachments, metaSummary, sniff } from '../src/agent/attachments.ts';
import { agentWorld, auth, type Msg, waitFor } from './agent-fakes.ts';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await close?.();
  close = null;
});

async function setup() {
  const w = await agentWorld();
  close = w.close;
  /** Send a file for a song, as the studio does. */
  const upload = (
    as: string | null,
    query: Record<string, string>,
    data: Buffer,
    contentType = 'application/octet-stream',
  ) =>
    w.app.inject({
      method: 'POST',
      url: `/api/agent/attachments?${new URLSearchParams(query).toString()}`,
      headers: { 'content-type': contentType, ...(as ? auth(as) : {}) },
      payload: data,
    });
  const attach = async (query: Record<string, string>, data: Buffer, as = w.token) => {
    const res = await upload(as, query, data);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { id: string; name: string; type: string; size: number };
  };
  return { ...w, upload, attach };
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const riff = (kind: string) =>
  Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from(kind), Buffer.alloc(8)]);
const MUSICXML = Buffer.from(
  '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise>\n<score-partwise version="4.0"><part-list/></score-partwise>\n',
);

describe('what a file says it is', () => {
  it('is what its first bytes are', () => {
    expect(sniff('image/png', PNG)).toBeNull();
    expect(sniff('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBeNull();
    expect(sniff('image/webp', riff('WEBP'))).toBeNull();
    expect(sniff('audio/wav', riff('WAVE'))).toBeNull();
    expect(sniff('audio/x-wav', riff('WAVE'))).toBeNull();
    expect(sniff('audio/flac', Buffer.from('fLaC\0\0\0\x22'))).toBeNull();
    expect(sniff('audio/mpeg', Buffer.from('ID3\x04\0\0'))).toBeNull();
    expect(sniff('audio/mpeg', Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBeNull();
    expect(sniff('audio/ogg', Buffer.from('OggS\0\x02'))).toBeNull();
    expect(sniff('audio/mp4', Buffer.from('\0\0\0\x20ftypM4A '))).toBeNull();
    expect(sniff('audio/midi', Buffer.from('MThd\0\0\0\x06'))).toBeNull();
    expect(sniff('text/plain', Buffer.from('Verse: C Am F G\n'))).toBeNull();
    expect(sniff('application/vnd.recordare.musicxml+xml', MUSICXML)).toBeNull();

    expect(sniff('image/png', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toMatch(/isn't a image\/png/);
    expect(sniff('image/webp', riff('WAVE'))).not.toBeNull();
    expect(sniff('audio/wav', riff('WEBP'))).not.toBeNull();
    expect(sniff('audio/midi', PNG)).not.toBeNull();
    expect(sniff('audio/mpeg', Buffer.from('not an mp3'))).not.toBeNull();
    expect(sniff('text/plain', Buffer.from([0x66, 0x6f, 0xc3, 0x28]))).toMatch(/UTF-8/);
    expect(sniff('text/plain', Buffer.from('a\0b'))).not.toBeNull();
    expect(sniff('application/vnd.recordare.musicxml+xml', Buffer.from('<html><body>hi</body></html>'))).not.toBeNull();
    expect(sniff('application/vnd.recordare.musicxml+xml', PNG)).not.toBeNull();
    expect(sniff('image/png', Buffer.alloc(0))).toMatch(/empty/);
  });

  it('says what was measured in a few words', () => {
    expect(metaSummary({ tempo: 96.456, key: 'D minor', notes: [1, 2, 3], ok: true, nested: { a: 1 } })).toBe(
      'tempo 96.46, key D minor, notes: 3, ok yes',
    );
    expect(metaSummary(null)).toBe('');
    expect(metaSummary([1, 2])).toBe('');
  });
});

describe('sending a file', () => {
  it('keeps it for its device and song, checking its type, its size and who sends it', async () => {
    const world = await setup();
    const { upload, attach, s, token, app, dataDir } = world;
    const got = await attach({ project: s.id, name: 'page one.png', type: 'image/png' }, PNG);
    expect(got).toEqual({
      id: expect.stringMatching(/^att_[0-9a-f]{12}$/),
      name: 'page one.png',
      type: 'image/png',
      size: PNG.length,
    });
    const folder = join(dataDir, 'agent', 'attachments', got.id);
    expect(existsSync(join(folder, 'data'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(folder).mode & 0o777).toBe(0o700);
      expect(statSync(join(folder, 'data')).mode & 0o777).toBe(0o600);
    }
    // whatever the body's content type says, the type asked for is what's checked
    expect(
      (await upload(token, { project: s.id, name: 'p.png', type: 'image/png' }, PNG, 'image/png')).statusCode,
    ).toBe(200);
    expect(
      (await upload(token, { project: s.id, name: 'x.wav', type: 'audio/wav' }, PNG, 'audio/wav')).statusCode,
    ).toBe(415);

    expect((await upload(null, { project: s.id, name: 'p.png', type: 'image/png' }, PNG)).statusCode).toBe(401);
    expect((await upload(token, { project: s.id, name: 'p.pdf', type: 'application/pdf' }, PNG)).statusCode).toBe(415);
    expect((await upload(token, { project: s.id, name: 'p.jpg', type: 'image/jpeg' }, PNG)).statusCode).toBe(415);
    expect((await upload(token, { project: 'prj_nosuchsong', name: 'p.png', type: 'image/png' }, PNG)).statusCode).toBe(
      404,
    );
    expect((await upload(token, { project: s.id, name: '', type: 'image/png' }, PNG)).statusCode).toBe(400);
    expect((await upload(token, { project: s.id, name: 'p.png', type: 'image/png' }, Buffer.alloc(0))).statusCode).toBe(
      400,
    );
    const text = await upload(
      token,
      { project: s.id, name: 'big.txt', type: 'text/plain' },
      Buffer.alloc(100 * 1024 + 1, 0x61),
    );
    expect(text.statusCode).toBe(413);
    const huge = Buffer.concat([PNG, Buffer.alloc(25 * 1024 * 1024)]);
    expect((await upload(token, { project: s.id, name: 'huge.png', type: 'image/png' }, huge)).statusCode).toBe(413);

    // what the browser measured: the sending device's alone, a JSON object of at most 64 KB
    const meta = (as: string, payload: unknown) =>
      app.inject({
        method: 'PUT',
        url: `/api/agent/attachments/${got.id}/meta`,
        headers: auth(as),
        payload: payload as object,
      });
    expect((await meta(token, { width: 1200, height: 1600 })).json()).toEqual({ ok: true });
    expect((await meta(token, [1, 2])).statusCode).toBe(400);
    expect((await meta(token, { big: 'x'.repeat(70 * 1024) })).statusCode).toBe(413);
    const phone = await world.admit(token);
    expect((await meta(phone.token, { width: 1 })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/agent/attachments/att_000000000000/meta',
          headers: auth(token),
          payload: {},
        })
      ).statusCode,
    ).toBe(404);

    // with the agent off, nothing is taken
    await app.inject({ method: 'PUT', url: '/api/agent/settings', headers: auth(token), payload: { enabled: false } });
    const off = await upload(token, { project: s.id, name: 'p.png', type: 'image/png' }, PNG);
    expect(off.statusCode).toBe(409);
    expect(off.json()).toMatchObject({ reason: 'off' });
  });
});

describe('a request’s attachments', () => {
  it('may be only the device’s own, for that song; the prompt lists them, and only their jobs read them', async () => {
    const { attach, ask, start, tool, s, token, admit, studio, song, app, run, desk, status } = await setup();
    const photo = await attach({ project: s.id, name: 'Page "one".png', type: 'image/png' }, PNG);
    await app.inject({
      method: 'PUT',
      url: `/api/agent/attachments/${photo.id}/meta`,
      headers: auth(token),
      payload: { width: 1200, height: 1600 },
    });
    const take = await attach({ project: s.id, name: 'take.wav', type: 'audio/wav' }, riff('WAVE'));
    const unused = await attach({ project: s.id, name: 'lyrics.txt', type: 'text/plain' }, Buffer.from('La la la'));
    const other = await song('Other');
    const elsewhere = await attach({ project: other.id, name: 'other.png', type: 'image/png' }, PNG);
    const phone = await admit(token);
    studio(phone.token, s.id, 'phone');
    const phones = await attach({ project: s.id, name: 'phone.png', type: 'image/png' }, PNG, phone.token);

    // another device's, another song's, a made-up one: refused
    for (const id of [phones.id, elsewhere.id, 'att_000000000000']) {
      const res = await ask({ project: s.id, text: 'Read this', attachments: [id] });
      expect(res.statusCode, id).toBe(400);
    }
    expect((await ask({ project: s.id, text: 'Read this', attachments: ['../../etc/passwd'] })).statusCode).toBe(400);

    const {
      job,
      token: jobToken,
      run: sent,
    } = await start({
      project: s.id,
      text: 'Write down this page, and what I sang',
      attachments: [photo.id, take.id],
    });
    expect(sent.prompt).toContain(
      [
        '## Attachments (read them with attachment_get)',
        `- ${photo.id}: "Page “one“.png" (image/png, ${PNG.length} bytes); measured: width 1200, height 1600`,
        `- ${take.id}: "take.wav" (audio/wav, 20 bytes)`,
      ].join('\n'),
    );
    expect(sent.prompt.indexOf('## Attachments')).toBeLessThan(sent.prompt.indexOf('## The request'));

    const read = (id: string, as = jobToken, of = job) => tool(of, as, 'GET', `/attachments/${id}`);
    expect((await read(photo.id)).json()).toEqual({
      name: 'Page "one".png',
      type: 'image/png',
      size: PNG.length,
      meta: { width: 1200, height: 1600 },
      data: PNG.toString('base64'),
    });
    // a recording: what was measured, not the audio
    expect((await read(take.id)).json()).toEqual({ name: 'take.wav', type: 'audio/wav', size: 20, meta: null });
    // not this request's, or not this song's
    expect((await read(unused.id)).statusCode).toBe(403);
    expect((await read(elsewhere.id)).statusCode).toBe(403);
    expect((await read('att_000000000000')).statusCode).toBe(404);

    // a later request on the same conversation may read what an earlier one attached
    run.say({ type: 'agent-done', job });
    await waitFor(() => status(desk, job)?.state === 'done');
    expect((await read(photo.id)).statusCode).toBe(403);
    const next = await start({ project: s.id, text: 'Now the second line', attachments: [unused.id] });
    expect((await read(photo.id, next.token, next.job)).statusCode).toBe(200);
    expect((await read(unused.id, next.token, next.job)).json()).toMatchObject({
      type: 'text/plain',
      data: Buffer.from('La la la').toString('base64'),
    });
    expect((await read(phones.id, next.token, next.job)).statusCode).toBe(403);
  });

  it('come with the user’s click too: a screenshot goes to the follow-up', async () => {
    const { attach, start, tool, s, token, app, run, desk, status } = await setup();
    const first = await start({ project: s.id, text: 'Look at my mixer' });
    await tool(first.job, first.token, 'POST', '/permission', { kind: 'screen', detail: 'To see the mixer' });
    run.say({ type: 'agent-done', job: first.job });
    await waitFor(() => status(desk, first.job)?.state === 'awaiting');
    const shot = await attach({ project: s.id, name: 'Screenshot.png', type: 'image/png' }, PNG);
    const granted = await app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${first.job}/permission`,
      headers: auth(token),
      payload: { grant: true, result: 'Shared the screen', attachments: [shot.id] },
    });
    const { job } = granted.json() as { job: string };
    const followUp = run.got('agent-run').find((m) => m.job === job) as Msg & { token: string; prompt: string };
    expect(followUp.prompt).toContain(`- ${shot.id}: "Screenshot.png" (image/png`);
    expect((await tool(job, followUp.token, 'GET', `/attachments/${shot.id}`)).json()).toMatchObject({
      data: PNG.toString('base64'),
    });
  });
});

describe('keeping attachments', () => {
  it('lets them go after a week: no longer read, and cleared from the data folder', async () => {
    const { attach, start, tool, s } = await setup();
    const photo = await attach({ project: s.id, name: 'page.png', type: 'image/png' }, PNG);
    const { job, token } = await start({ project: s.id, text: 'Read this page', attachments: [photo.id] });
    expect((await tool(job, token, 'GET', `/attachments/${photo.id}`)).statusCode).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60 * 1000);
    expect((await tool(job, token, 'GET', `/attachments/${photo.id}`)).statusCode).toBe(404);
  });

  it('sweeps a week-old one (and leftovers) away, now and every hour', () => {
    const dir = mkdtempSync(join(tmpdir(), 'holo-attachments-'));
    try {
      let now = 1_000_000;
      const kept = new Attachments(dir, () => now);
      const old = kept.add('dev_a', 'prj_a', 'old.png', 'image/png', PNG);
      now += 6 * 24 * 60 * 60 * 1000;
      const fresh = kept.add('dev_a', 'prj_a', 'fresh.png', 'image/png', PNG);
      expect(kept.sweep()).toBe(0);
      now += 24 * 60 * 60 * 1000;
      expect(kept.get(old.id)).toBeNull();
      expect(kept.sweep()).toBe(1);
      expect(existsSync(join(dir, old.id))).toBe(false);
      expect(kept.get(fresh.id)).toMatchObject({ name: 'fresh.png', device: 'dev_a', project: 'prj_a' });
      expect(kept.data(fresh.id)?.equals(PNG)).toBe(true);
      expect(kept.get('../etc')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
