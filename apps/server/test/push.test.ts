import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { pushKey } from '../src/agent/keys.ts';
import {
  allowedEndpoint,
  bounceNotice,
  checkSubscription,
  encrypt,
  LONG_MS,
  notice,
  send,
  topic,
  VAPID_SUBJECT,
  vapid,
} from '../src/agent/push.ts';
import { AgentStore } from '../src/agent/store.ts';
import { agentWorld, auth, type FakeSocket, type Msg, waitFor } from './agent-fakes.ts';

const work = mkdtempSync(join(tmpdir(), 'holo-push-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const b64 = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');

describe('encrypting a notice (RFC 8291)', () => {
  // RFC 8291, section 5 and Appendix A, copied from the RFC's text
  const rfc = {
    plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
    asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV- JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    header: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
             mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8`,
    ciphertext: `8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs
                 bI_0LpXMuGvnzQ`,
    body: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
           mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
           pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
  };

  it('gives the RFC’s example byte for byte', () => {
    const plaintext = b64(rfc.plaintext);
    expect(plaintext.toString('utf8')).toBe('When I grow up, I want to be a watermelon');
    const sub = { p256dh: b64(rfc.uaPublic).toString('base64url'), auth: rfc.auth };
    const body = encrypt(sub, plaintext, { salt: b64(rfc.salt), asPrivate: b64(rfc.asPrivate) });
    expect(body.subarray(0, 86).toString('base64url')).toBe(b64(rfc.header).toString('base64url'));
    expect(body.subarray(86).toString('base64url')).toBe(b64(rfc.ciphertext).toString('base64url'));
    expect(body.toString('base64url')).toBe(b64(rfc.body).toString('base64url'));
    expect(body.length).toBe(144);
    // (the sender's public key in the header is the RFC's)
    expect(body.subarray(21, 86).equals(b64(rfc.asPublic))).toBe(true);
  });

  it('makes a new key and salt each time, and the device reads it', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const sub = { p256dh: ua.getPublicKey().toString('base64url'), auth: b64(rfc.auth).toString('base64url') };
    const a = encrypt(sub, Buffer.from('{"body":"Song: a reply is ready."}'));
    const b = encrypt(sub, Buffer.from('{"body":"Song: a reply is ready."}'));
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, ua.getPrivateKey(), b64(rfc.auth)).toString()).toBe('{"body":"Song: a reply is ready."}');
  });
});

/** What a device does with a notice (RFC 8291): its private key and auth secret read it. */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20] ?? 0;
  const asPublic = body.subarray(21, 21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const h = (key: Buffer, by: Buffer, info: string | Buffer, n: number) =>
    Buffer.from(hkdfSync('sha256', key, by, info, n));
  const ikm = h(secret, auth, Buffer.concat([Buffer.from('WebPush: info\x00'), uaPublic, asPublic]), 32);
  const cek = h(ikm, salt, 'Content-Encoding: aes128gcm\x00', 16);
  const nonce = h(ikm, salt, 'Content-Encoding: nonce\x00', 12);
  const rest = body.subarray(21 + idlen);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(rest.subarray(rest.length - 16));
  const out = Buffer.concat([decipher.update(rest.subarray(0, rest.length - 16)), decipher.final()]);
  expect(out.at(-1)).toBe(2);
  return out.subarray(0, -1);
}

describe('the VAPID token (RFC 8292)', () => {
  it('is an ES256 JWT for the push service, good for 12 hours, naming the project, that verifies', () => {
    const key = pushKey(join(work, 'vapid'));
    const now = Date.UTC(2026, 10, 22, 12, 0, 0);
    const { token, authorization } = vapid('https://web.push.apple.com/QGuQyavXut--abc?x=1', key, now);
    const [h, p, s] = token.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as { aud: string; exp: number; sub: string };
    expect(claims.aud).toBe('https://web.push.apple.com');
    expect(claims.sub).toBe(VAPID_SUBJECT);
    expect(claims.sub).toMatch(/^https:\/\//);
    expect(claims.exp - now / 1000).toBeGreaterThan(0);
    expect(claims.exp - now / 1000).toBeLessThanOrEqual(24 * 3600);
    expect(Buffer.from(s, 'base64url').length).toBe(64);
    // checked with the public key the header names, as a push service does
    expect(authorization).toBe(`vapid t=${token}, k=${key.publicKey.toString('base64url')}`);
    const k = Buffer.from(authorization.split('k=')[1] as string, 'base64url');
    expect(k.length).toBe(65);
    expect(k[0]).toBe(4);
    const pub = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: k.subarray(1, 33).toString('base64url'),
        y: k.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: pub, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    );
    expect(ok).toBe(true);
    // a token for one push service isn't another's
    const other = vapid('https://fcm.googleapis.com/fcm/send/x', key, now).token.split('.')[1] as string;
    expect(JSON.parse(Buffer.from(other, 'base64url').toString()).aud).toBe('https://fcm.googleapis.com');
  });
});

describe('the push key', () => {
  it('is made once, in the data folder, readable only by its owner, and the same one after', () => {
    const dir = join(work, 'new', 'data');
    const key = pushKey(dir);
    expect(key.publicKey.length).toBe(65);
    expect(key.publicKey[0]).toBe(4);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'push.key')).mode & 0o777).toBe(0o600);
    expect(pushKey(dir).publicKey.equals(key.publicKey)).toBe(true);
    expect(pushKey(join(work, 'other')).publicKey.equals(key.publicKey)).toBe(false);
  });

  it('closes the permissions of one already there, and replaces a damaged one', () => {
    const dir = join(work, 'kept');
    const key = pushKey(dir);
    const file = join(dir, 'push.key');
    writeFileSync(file, `${JSON.stringify(key.privateKey.export({ format: 'jwk' }))}\n`, { mode: 0o644 });
    expect(pushKey(dir).publicKey.equals(key.publicKey)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, '{"kty":"EC"}');
    const fresh = pushKey(dir);
    expect(fresh.publicKey.equals(key.publicKey)).toBe(false);
    expect(pushKey(dir).publicKey.equals(fresh.publicKey)).toBe(true);
  });
});

describe('the push services HO[LO] sends to', () => {
  it('takes only https on 443, on Apple’s, Google’s, Mozilla’s and Microsoft’s push hosts', () => {
    for (const url of [
      'https://fcm.googleapis.com/fcm/send/dGVzdA:APA91b',
      'https://fcm.googleapis.com/wp/abc',
      'https://web.push.apple.com/QGuQyavXut',
      'https://api.push.apple.com/3/device/x',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
      'https://fcm.googleapis.com:443/fcm/send/x',
    ])
      expect(allowedEndpoint(url), url).toBe(true);
    for (const url of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com:8443/fcm/send/x',
      'https://evil.fcm.googleapis.com/x',
      'https://push.apple.com/x',
      'https://push.apple.com.evil.example/x',
      'https://webpush.apple.com/x',
      'https://web.push.apple.com./x',
      'https://user:pw@web.push.apple.com/x', // scan-secrets: allow (a URL's user and password, not an address)
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://[::1]/x',
      'https://holo.example.ts.net/api/projects',
      'https://notify.windows.com/x',
      'file:///etc/passwd',
      `https://fcm.googleapis.com/${'x'.repeat(1000)}`,
      'not a url',
      42,
      null,
    ])
      expect(allowedEndpoint(url), String(url)).toBe(false);
  });

  it('checks a subscription’s keys: a P-256 point, and a 16-byte secret', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const p256dh = ua.getPublicKey().toString('base64url');
    const authKey = Buffer.alloc(16, 7).toString('base64url');
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
    expect(checkSubscription({ endpoint, keys: { p256dh, auth: authKey } })).toEqual({
      endpoint,
      p256dh,
      auth: authKey,
    });
    // padding is taken, and dropped
    expect(checkSubscription({ endpoint, keys: { p256dh, auth: `${authKey}==` } })).toMatchObject({ auth: authKey });
    const refused = [
      { endpoint: 'https://example.com/push', keys: { p256dh, auth: authKey } },
      { endpoint, keys: { p256dh: ua.getPublicKey(undefined, 'compressed').toString('base64url'), auth: authKey } },
      {
        endpoint,
        keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), auth: authKey },
      },
      { endpoint, keys: { p256dh: `${p256dh}AA`, auth: authKey } },
      { endpoint, keys: { p256dh, auth: Buffer.alloc(15).toString('base64url') } },
      { endpoint, keys: { p256dh, auth: Buffer.alloc(17).toString('base64url') } },
      { endpoint, keys: { p256dh: 'not+base64/url', auth: authKey } },
      { endpoint, keys: null },
      { endpoint },
      null,
    ];
    for (const s of refused) expect(typeof checkSubscription(s), JSON.stringify(s)).toBe('string');
  });
});

/** A device's subscription, with the keys to read what's sent to it. */
function device(endpoint = 'https://fcm.googleapis.com/fcm/send/abc123') {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const secret = Buffer.alloc(16, 9);
  return {
    subscription: {
      endpoint,
      keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: secret.toString('base64url') },
    },
    row: { endpoint, p256dh: ua.getPublicKey().toString('base64url'), auth: secret.toString('base64url') },
    read: (body: Uint8Array) => JSON.parse(decrypt(Buffer.from(body), ua.getPrivateKey(), secret).toString()) as Msg,
  };
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** A push service: what it was sent, and the status it answers with (or what it throws). */
function pushService(answer: number | Error = 201) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: init.body as Uint8Array });
    if (answer instanceof Error) throw answer;
    return new Response(null, { status: answer });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

describe('sending a notice', () => {
  const key = pushKey(join(work, 'send'));

  it('posts it encrypted, signed, with a day’s half to live and the song’s topic', async () => {
    const d = device();
    const service = pushService(201);
    const said: string[] = [];
    const sent = await send(d.row, '{"body":"Song: a reply is ready."}', {
      key,
      fetch: service.fetch,
      topic: topic('prj_abc'),
      log: (l) => said.push(l),
    });
    expect(sent).toBe('ok');
    expect(said).toEqual([]);
    const call = service.calls[0] as Call;
    expect(call.url).toBe(d.row.endpoint);
    expect(call.headers).toMatchObject({
      ttl: '43200',
      urgency: 'normal',
      'content-encoding': 'aes128gcm',
      topic: topic('prj_abc'),
    });
    expect(call.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    expect(topic('prj_abc')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(topic('prj_abc')).not.toBe(topic('prj_abd'));
    expect(d.read(call.body)).toEqual({ body: 'Song: a reply is ready.' });
  });

  it('says gone for 404 and 410, and failed (once, in the log) for anything else', async () => {
    const d = device();
    for (const [answer, result] of [
      [200, 'ok'],
      [202, 'ok'],
      [404, 'gone'],
      [410, 'gone'],
      [500, 'failed'],
      [403, 'failed'],
      [429, 'failed'],
      [new Error('getaddrinfo ENOTFOUND'), 'failed'],
    ] as const) {
      const said: string[] = [];
      const service = pushService(answer);
      expect(await send(d.row, '{}', { key, fetch: service.fetch, log: (l) => said.push(l) }), String(answer)).toBe(
        result,
      );
      expect(said.length, String(answer)).toBe(result === 'failed' ? 1 : 0);
    }
  });

  it('never sends to a host that isn’t a push service’s', async () => {
    const service = pushService(201);
    const said: string[] = [];
    const row = { ...device().row, endpoint: 'https://127.0.0.1/hook' };
    expect(await send(row, '{}', { key, fetch: service.fetch, log: (l) => said.push(l) })).toBe('failed');
    expect(service.calls).toEqual([]);
    expect(said.length).toBe(1);
  });
});

describe('what a notice says', () => {
  const job = (state: string, took: number) => ({
    id: 'agj_000000000001',
    project: 'prj_1',
    state: state as 'done',
    started: 1_000_000,
    finished: 1_000_000 + took,
  });
  it('follows the device’s mode: long runs, every reply, a wait for an OK, never a cancel', () => {
    const table: [string, number, 'long' | 'every', string | null][] = [
      ['done', 5_000, 'every', 'Fog Song: a reply is ready.'],
      ['done', 5_000, 'long', null],
      ['done', LONG_MS, 'long', null],
      ['done', LONG_MS + 1, 'long', 'Fog Song: a reply is ready.'],
      ['failed', 5_000, 'every', 'Fog Song: the request stopped.'],
      ['failed', 5_000, 'long', null],
      ['failed', 120_000, 'long', 'Fog Song: the request stopped.'],
      ['awaiting', 5_000, 'long', 'Fog Song: it needs your OK to go on.'],
      ['awaiting', 5_000, 'every', 'Fog Song: it needs your OK to go on.'],
      ['cancelled', 5_000, 'every', null],
      ['cancelled', 120_000, 'long', null],
      ['running', 120_000, 'every', null],
    ];
    for (const [state, took, mode, body] of table) {
      const n = notice(job(state, took), mode, 'Fog Song');
      expect(n?.body ?? null, `${state} ${took} ${mode}`).toBe(body);
      if (n) expect(n).toMatchObject({ title: 'HO[LO] Desk', project: 'prj_1', job: 'agj_000000000001' });
    }
  });
  it('names the song on one line, at most 60 characters', () => {
    expect(notice(job('done', 1), 'every', '  Two\n lines\t ')?.body).toBe('Two lines: a reply is ready.');
    expect(notice(job('done', 1), 'every', '')?.body).toBe('A song: a reply is ready.');
    const long = notice(job('done', 1), 'every', 'x'.repeat(200))?.body ?? '';
    expect(long).toBe(`${'x'.repeat(59)}…: a reply is ready.`);
  });
});

describe('what a bounce’s notice says', () => {
  const bounce = (
    state: string,
    took: number,
    more: { name?: string; seconds?: number | null; stems?: boolean } = {},
  ) => ({
    project: 'prj_1',
    name: more.name ?? 'Lantern Sketch',
    state,
    started: 1_000_000,
    finished: 1_000_000 + took,
    seconds: more.seconds === undefined ? 247 : more.seconds,
    ...(more.stems ? { stems: true } : {}),
  });

  it('says a song’s stems are ready, or failed, by the song’s name', () => {
    const stems = { name: 'Lantern Sketch (stems)', stems: true };
    expect(bounceNotice(bounce('done', 500_000, stems), 'every')?.body).toBe('Lantern Sketch: the stems are ready.');
    expect(bounceNotice(bounce('failed', 500_000, stems), 'every')?.body).toBe('Lantern Sketch: the stems failed.');
  });

  it('is that the bounce is ready, with its length, or that it failed: which song, and no more', () => {
    expect(bounceNotice(bounce('done', 500_000), 'every')).toEqual({
      title: 'HO[LO] Desk',
      body: 'Lantern Sketch: the bounce is ready (4:07).',
      kind: 'bounce',
      song: 'prj_1',
    });
    expect(bounceNotice(bounce('failed', 500_000), 'every')?.body).toBe('Lantern Sketch: the bounce failed.');
    // (a length nobody knows, and one that rounds up to the minute)
    expect(bounceNotice(bounce('done', 500_000, { seconds: null }), 'every')?.body).toBe(
      'Lantern Sketch: the bounce is ready.',
    );
    expect(bounceNotice(bounce('done', 500_000, { seconds: 59.6 }), 'every')?.body).toBe(
      'Lantern Sketch: the bounce is ready (1:00).',
    );
  });

  it('follows the device’s mode: every one, or only one that took more than a minute', () => {
    expect(bounceNotice(bounce('done', 5_000), 'every')).not.toBeNull();
    expect(bounceNotice(bounce('done', 5_000), 'long')).toBeNull();
    expect(bounceNotice(bounce('done', LONG_MS), 'long')).toBeNull();
    expect(bounceNotice(bounce('done', LONG_MS + 1), 'long')).not.toBeNull();
    expect(bounceNotice(bounce('failed', LONG_MS + 1), 'long')).not.toBeNull();
    // (not one that's still waiting or being made)
    expect(bounceNotice(bounce('running', LONG_MS + 1), 'every')).toBeNull();
  });

  it('names the song on one line, at most 60 characters, however long the bounce was named', () => {
    const told = bounceNotice(bounce('done', 500_000, { name: `A\nvery ${'long '.repeat(120)}name` }), 'every');
    expect(told?.body).toMatch(/^A very long .{0,60}…: the bounce is ready \(4:07\)\.$/);
    expect(JSON.stringify(told).length).toBeLessThan(250);
  });
});

describe('a device’s unseen replies', () => {
  it('keeps the newest 50 a device asked for; a song seen anywhere counts on none', () => {
    const s = new AgentStore(new DatabaseSync(':memory:'));
    for (let i = 0; i < 60; i++)
      s.addUnseen(`agj_${String(i).padStart(12, '0')}`, 'dev_a', i % 2 ? 'prj_1' : 'prj_2', i);
    s.addUnseen('agj_b00000000001', 'dev_b', 'prj_1', 1);
    expect(s.unseen('dev_a')).toBe(50);
    expect(s.unseen('dev_b')).toBe(1);
    s.seenSong('prj_1');
    expect(s.unseen('dev_a')).toBe(25);
    expect(s.unseen('dev_b')).toBe(0);
    // notices off: its unseen replies go too
    s.setPush({
      device: 'dev_a',
      endpoint: 'https://fcm.googleapis.com/x',
      p256dh: 'p',
      auth: 'a',
      mode: 'long',
      added: 1,
    });
    s.removePush('dev_a');
    expect(s.unseen('dev_a')).toBe(0);
    expect(s.push('dev_a')).toBeNull();
  });
  it('lets another device with the same subscription go (the same browser, paired again)', () => {
    const s = new AgentStore(new DatabaseSync(':memory:'));
    const row = { endpoint: 'https://fcm.googleapis.com/x', p256dh: 'p', auth: 'a', mode: 'long' as const, added: 1 };
    s.setPush({ ...row, device: 'dev_old' });
    s.setPush({ ...row, device: 'dev_new', mode: 'every' });
    expect(s.push('dev_old')).toBeNull();
    expect(s.push('dev_new')).toMatchObject({ mode: 'every' });
  });
});

describe('the routes, and the notices a device gets', () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  async function world() {
    const w = await agentWorld();
    close = w.close;
    const service = pushService(201);
    const said: string[] = [];
    w.services.notify.fetch = service.fetch;
    w.services.notify.log = (l) => said.push(l);
    w.services.notify.warn = (l) => said.push(l);
    w.services.notify.frontMs = 50;
    const push = (method: 'GET' | 'PUT' | 'DELETE', payload?: Msg, as = w.token) =>
      w.app.inject({ method, url: '/api/agent/push', headers: auth(as), ...(payload ? { payload } : {}) });
    const seen = (project: string, as = w.token) =>
      w.app.inject({ method: 'POST', url: '/api/agent/seen', headers: auth(as), payload: { project } });
    /** Run a request on the song to its end: done, failed, awaiting or cancelled; `took`, how long it ran. */
    const runTo = async (end: 'done' | 'failed' | 'awaiting' | 'cancelled', took = 1000, as = w.token) => {
      const { job, token } = await w.start({ project: w.s.id, text: 'A bass line' }, as);
      const kept = w.services.jobs.get(job);
      if (kept) kept.view.started -= took;
      if (end === 'awaiting') {
        const asked = await w.tool(job, token, 'POST', '/permission', {
          kind: 'install-pack',
          detail: 'Install the strings',
          pack: 'vsco2',
        });
        expect(asked.statusCode, asked.body).toBe(200);
      }
      if (end === 'cancelled')
        await w.app.inject({ method: 'POST', url: `/api/agent/jobs/${job}/cancel`, headers: auth(as) });
      else if (end === 'failed') w.run.say({ type: 'agent-failed', job, error: 'It broke' });
      else w.run.say({ type: 'agent-done', job, reply: 'Done.' });
      await waitFor(() => {
        const state = w.services.jobs.get(job)?.view.state;
        return state !== 'waiting' && state !== 'running';
      });
      await w.services.notify.idle();
      return job;
    };
    const unseenRows = () =>
      w.services.store.database.prepare('SELECT job, device, project FROM agent_unseen ORDER BY at').all() as {
        job: string;
        device: string;
        project: string;
      }[];
    return { ...w, service, said, push, seen, runTo, unseenRows };
  }

  /** The studio answers agent-front: in front (true), not (false), or not at all (null). */
  const front = (studio: FakeSocket, answer: boolean | null) => {
    const plain = studio.answer;
    studio.answer = (msg) =>
      msg.type === 'agent-front' ? (answer === null ? null : { ok: true, front: answer }) : (plain?.(msg) ?? null);
  };

  it('answers a device’s own notices: its key, its mode, its subscription and its unseen count', async () => {
    const w = await world();
    const d = device();
    // no key is made until a device subscribes (asks for it): a studio starting, or Settings, makes none
    const empty = await w.push('GET');
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ key: null, mode: 'off', unseen: 0 });
    expect(existsSync(join(w.dataDir, 'push.key'))).toBe(false);
    const asked = await w.app.inject({ method: 'GET', url: '/api/agent/push?key=1', headers: auth(w.token) });
    const view = asked.json() as { key: string; mode: string; unseen: number };
    expect(view).toEqual({ key: expect.any(String), mode: 'off', unseen: 0 });
    expect(Buffer.from(view.key, 'base64url').length).toBe(65);
    expect(existsSync(join(w.dataDir, 'push.key'))).toBe(true);
    // the same key each time from then on, asked for or not (and the same one push.key holds)
    expect((await w.push('GET')).json().key).toBe(view.key);
    expect(pushKey(w.dataDir).publicKey.toString('base64url')).toBe(view.key);

    const on = await w.push('PUT', { mode: 'long', subscription: d.subscription });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toEqual({ key: view.key, mode: 'long', endpoint: d.subscription.endpoint, unseen: 0 });
    expect((await w.push('PUT', { mode: 'every', subscription: d.subscription })).json()).toMatchObject({
      mode: 'every',
    });
    // another device's notices are its own
    const phone = await w.admit(w.token);
    expect((await w.push('GET', undefined, phone.token)).json()).toMatchObject({ mode: 'off' });
    const off = await w.push('DELETE');
    expect(off.json()).toEqual({ key: view.key, mode: 'off', unseen: 0 });
  });

  it('takes only a push service’s endpoint, and keys of the right lengths', async () => {
    const w = await world();
    const d = device();
    const bad = async (payload: Msg) => {
      const res = await w.push('PUT', payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    };
    await bad({ mode: 'long', subscription: { ...d.subscription, endpoint: 'https://127.0.0.1:47800/api/projects' } });
    await bad({ mode: 'long', subscription: { ...d.subscription, endpoint: 'http://fcm.googleapis.com/fcm/send/x' } });
    await bad({ mode: 'long', subscription: { ...d.subscription, keys: { ...d.subscription.keys, auth: 'AAAA' } } });
    await bad({
      mode: 'long',
      subscription: {
        ...d.subscription,
        keys: { ...d.subscription.keys, p256dh: Buffer.alloc(65, 4).toString('base64url') },
      },
    });
    await bad({ mode: 'off', subscription: d.subscription });
    await bad({ mode: 'every' });
    expect((await w.push('GET')).json()).toMatchObject({ mode: 'off' });
    // and only an allowed device's
    expect((await w.app.inject({ method: 'GET', url: '/api/agent/push' })).statusCode).toBe(401);
  });

  it('reads and turns off a device’s notices with the agent off; nothing else of them answers then', async () => {
    const w = await world();
    await w.push('PUT', { mode: 'long', subscription: device().subscription });
    await w.app.inject({
      method: 'PUT',
      url: '/api/agent/settings',
      headers: auth(w.token),
      payload: { enabled: false },
    });
    expect((await w.push('GET')).json()).toMatchObject({ mode: 'long' });
    expect((await w.push('PUT', { mode: 'every', subscription: device().subscription })).statusCode).toBe(409);
    expect((await w.seen(w.s.id)).statusCode).toBe(409);
    expect((await w.push('DELETE')).json()).toMatchObject({ mode: 'off' });
  });

  it('sends nothing, and keeps nothing, for a device that hasn’t turned notices on', async () => {
    const w = await world();
    await w.runTo('done', 120_000);
    expect(w.service.calls).toEqual([]);
    expect(w.unseenRows()).toEqual([]);
  });

  it('tells the device that asked of a long run, a wait for its OK and a failure; a short one only with Every reply', async () => {
    const w = await world();
    const d = device();
    await w.push('PUT', { mode: 'long', subscription: d.subscription });
    // a short reply: kept as unseen, no notice
    const short = await w.runTo('done', 5_000);
    expect(w.service.calls).toEqual([]);
    expect(w.unseenRows()).toEqual([{ job: short, device: w.device.id, project: w.s.id }]);
    // a long one: told
    const long = await w.runTo('done', LONG_MS + 5_000);
    expect(w.service.calls.length).toBe(1);
    const told = d.read((w.service.calls[0] as Call).body);
    expect(told).toEqual({
      title: 'HO[LO] Desk',
      body: 'Song: a reply is ready.',
      project: w.s.id,
      job: long,
      unseen: 2,
    });
    expect(JSON.stringify(told).length).toBeLessThan(250);
    expect((w.service.calls[0] as Call).headers.topic).toBe(topic(w.s.id));
    // a wait for an OK, however short
    const waiting = await w.runTo('awaiting', 2_000);
    expect(d.read((w.service.calls[1] as Call).body)).toMatchObject({
      body: 'Song: it needs your OK to go on.',
      job: waiting,
      unseen: 3,
    });
    await w.app.inject({ method: 'POST', url: `/api/agent/jobs/${waiting}/cancel`, headers: auth(w.token) });
    const failed = await w.runTo('failed', LONG_MS + 1_000);
    expect(d.read((w.service.calls[2] as Call).body)).toMatchObject({
      body: 'Song: the request stopped.',
      job: failed,
    });
    // never for a cancel, and it isn't unseen
    const before = w.unseenRows().length;
    await w.runTo('cancelled', LONG_MS + 1_000);
    expect(w.service.calls.length).toBe(3);
    expect(w.unseenRows().length).toBe(before);
    // every reply: a short one too
    await w.push('PUT', { mode: 'every', subscription: d.subscription });
    await w.runTo('done', 1_000);
    expect(w.service.calls.length).toBe(4);
    expect(w.said.filter((l) => l.startsWith('A notice went to Desk')).length).toBe(4);
  });

  it('tells a device of a bounce the host made for it, by its mode, on a topic of its own, counting nothing unseen', async () => {
    const w = await world();
    const d = device();
    await w.push('PUT', { mode: 'long', subscription: d.subscription });
    const bounce = (took: number, state = 'done') => ({
      project: w.s.id,
      name: 'Song (cycle)',
      state,
      started: Date.now() - took,
      finished: Date.now(),
      seconds: 247,
    });
    // a short one: nothing, with Long runs
    w.services.notify.bounced(bounce(5_000), w.device.id);
    await w.services.notify.idle();
    expect(w.service.calls).toEqual([]);
    // one that took minutes: told
    w.services.notify.bounced(bounce(LONG_MS + 60_000), w.device.id);
    await w.services.notify.idle();
    expect(w.service.calls.length).toBe(1);
    expect(d.read((w.service.calls[0] as Call).body)).toEqual({
      title: 'HO[LO] Desk',
      body: 'Song (cycle): the bounce is ready (4:07).',
      kind: 'bounce',
      song: w.s.id,
    });
    // (not the song's own topic: it doesn't take the place of the agent's notice waiting for a device that's off)
    expect((w.service.calls[0] as Call).headers.topic).toBe(topic(`bounce:${w.s.id}`));
    expect((w.service.calls[0] as Call).headers.topic).not.toBe(topic(w.s.id));
    expect(w.unseenRows()).toEqual([]);
    // one that failed, and a short one with Every reply
    w.services.notify.bounced(bounce(LONG_MS + 60_000, 'failed'), w.device.id);
    await w.services.notify.idle();
    expect(d.read((w.service.calls[1] as Call).body).body).toBe('Song (cycle): the bounce failed.');
    await w.push('PUT', { mode: 'every', subscription: d.subscription });
    w.services.notify.bounced(bounce(5_000), w.device.id);
    await w.services.notify.idle();
    expect(w.service.calls.length).toBe(3);
  });

  it('tells the device that asked the host for a bounce when the host has made it, and no other', async () => {
    const w = await world();
    const d = device();
    await w.push('PUT', { mode: 'every', subscription: d.subscription });
    front(w.desk, false);
    const ask = (headers: Record<string, string>) =>
      w.app.inject({
        method: 'POST',
        url: `/api/projects/${w.s.id}/bounces/host`,
        headers,
        payload: { doc: w.s, from: 0, to: 960, tail: 0, name: 'Song' },
      });
    const made = async (res: Awaited<ReturnType<typeof ask>>) => {
      expect(res.statusCode, res.body).toBe(202);
      const { id } = res.json() as { id: string };
      await waitFor(() => w.services.bounces.get(id)?.state === 'done', 30_000);
      await w.services.notify.idle();
    };
    // asked with no token: made, and nobody told
    await made(await ask({}));
    expect(w.service.calls).toEqual([]);
    // asked by the device: told, once
    await made(await ask(auth(w.token)));
    expect(w.service.calls.length).toBe(1);
    expect(d.read((w.service.calls[0] as Call).body)).toMatchObject({ kind: 'bounce', song: w.s.id });
    expect(d.read((w.service.calls[0] as Call).body).body).toMatch(/^Song: the bounce is ready/);
  }, 60_000);

  it('tells nothing of a bounce to a device without notices, one HO[LO] is in front on, or with the agent off', async () => {
    const w = await world();
    const d = device();
    const bounce = { project: w.s.id, name: 'Song', state: 'done', started: 0, finished: 500_000, seconds: 30 };
    // no notices on this device
    w.services.notify.bounced(bounce, w.device.id);
    // a device the agent doesn't know
    w.services.notify.bounced(bounce, 'dev_nosuchdevice');
    await w.services.notify.idle();
    expect(w.service.calls).toEqual([]);
    await w.push('PUT', { mode: 'every', subscription: d.subscription });
    // HO[LO] in front there, and saying so: the studio shows it
    front(w.desk, true);
    w.services.notify.bounced(bounce, w.device.id);
    await w.services.notify.idle();
    expect(w.service.calls).toEqual([]);
    front(w.desk, false);
    w.services.notify.bounced(bounce, w.device.id);
    await w.services.notify.idle();
    expect(w.service.calls.length).toBe(1);
    // the agent turned off: its notices are its setting
    const off = await w.app.inject({
      method: 'PUT',
      url: '/api/agent/settings',
      headers: auth(w.token),
      payload: { enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    w.services.notify.bounced(bounce, w.device.id);
    await w.services.notify.idle();
    expect(w.service.calls.length).toBe(1);
    expect(w.said.filter((l) => /failed/.test(l))).toEqual([]);
  });

  it('lets go of a subscription the push service says is gone, told of a bounce', async () => {
    const w = await world();
    const d = device();
    await w.push('PUT', { mode: 'every', subscription: d.subscription });
    front(w.desk, false);
    const gone = pushService(410);
    w.services.notify.fetch = gone.fetch;
    w.services.notify.bounced(
      { project: w.s.id, name: 'Song', state: 'done', started: 0, finished: 1, seconds: 1 },
      w.device.id,
    );
    await w.services.notify.idle();
    expect(gone.calls.length).toBe(1);
    expect((await w.push('GET')).json()).toMatchObject({ mode: 'off' });
  });

  it('only tells the device that asked', async () => {
    const w = await world();
    const phone = await w.admit(w.token);
    w.studio(phone.token, w.s.id, 'phone');
    const d = device();
    await w.push('PUT', { mode: 'every', subscription: d.subscription }, phone.token);
    await w.runTo('done', 120_000);
    expect(w.service.calls).toEqual([]);
    expect(w.unseenRows()).toEqual([]);
  });

  it('holds the notice back while HO[LO] is in front on that device, and only then', async () => {
    const w = await world();
    const d = device();
    await w.push('PUT', { mode: 'every', subscription: d.subscription });
    // in view, and says so: nothing sent (it's still unseen until the page shows it)
    front(w.desk, true);
    const held = await w.runTo('done');
    expect(w.service.calls).toEqual([]);
    expect(w.unseenRows().map((r) => r.job)).toEqual([held]);
    expect(w.desk.got('agent-front').length).toBe(1);
    // in view, says it isn't (its page went to the background as it was asked)
    front(w.desk, false);
    await w.runTo('done');
    expect(w.service.calls.length).toBe(1);
    // says it's in view, but its page is frozen and can't answer
    front(w.desk, null);
    await w.runTo('done');
    expect(w.service.calls.length).toBe(2);
    // hidden: not asked at all
    front(w.desk, true);
    const asked = w.desk.got('agent-front').length;
    w.desk.say({
      type: 'state',
      state: { project: w.s.id, revision: 0, tick: 0, selection: { track: null, regions: [], notes: 0 }, hidden: true },
    });
    await w.runTo('done');
    expect(w.service.calls.length).toBe(3);
    expect(w.desk.got('agent-front').length).toBe(asked);
  });

  it('lets a subscription the push service says is gone go; any other failure changes nothing', async () => {
    const w = await world();
    const d = device();
    await w.push('PUT', { mode: 'every', subscription: d.subscription });
    const failing = pushService(500);
    w.services.notify.fetch = failing.fetch;
    await w.runTo('done');
    expect(failing.calls.length).toBe(1);
    expect((await w.push('GET')).json()).toMatchObject({ mode: 'every' });
    expect(w.said.some((l) => l.includes('answered 500'))).toBe(true);
    // the browser renewed its subscription: the old one answers 410, and the host lets it go
    const gone = pushService(410);
    w.services.notify.fetch = gone.fetch;
    await w.runTo('done');
    expect(gone.calls.length).toBe(1);
    expect((await w.push('GET')).json()).toMatchObject({ mode: 'off', unseen: 0 });
    // HO[LO] opens again on that device: it gives the host the new one, with the choice it kept
    // (app/notify.ts, syncPush), and the notices go on, to the new endpoint
    const renewed = device('https://fcm.googleapis.com/fcm/send/renewed');
    const again = await w.push('PUT', { mode: 'every', subscription: renewed.subscription });
    expect(again.json()).toMatchObject({ mode: 'every', endpoint: renewed.subscription.endpoint });
    const ok = pushService(201);
    w.services.notify.fetch = ok.fetch;
    const job = await w.runTo('done');
    expect(ok.calls.map((c) => c.url)).toEqual([renewed.subscription.endpoint]);
    expect(renewed.read((ok.calls[0] as Call).body)).toMatchObject({ job, body: 'Song: a reply is ready.' });
  });

  it('times Long runs from the turn’s own start: the wait for an OK never counts', async () => {
    const w = await world();
    const d = device();
    await w.push('PUT', { mode: 'long', subscription: d.subscription });
    const asked = await w.runTo('awaiting', 2_000);
    expect(d.read((w.service.calls[0] as Call).body)).toMatchObject({
      job: asked,
      body: 'Song: it needs your OK to go on.',
    });
    // the user comes back ten minutes later and allows it
    const waited = w.services.jobs.get(asked);
    if (waited) {
      waited.view.started -= 10 * 60_000;
      waited.view.finished = (waited.view.finished ?? Date.now()) - 10 * 60_000;
    }
    const permitted = await w.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${asked}/permission`,
      headers: auth(w.token),
      payload: { grant: true, result: 'Installed the strings' },
    });
    expect(permitted.statusCode, permitted.body).toBe(200);
    const next = (permitted.json() as { job: string }).job;
    expect(next).not.toBe(asked);
    // the follow-up is a job of its own, begun at the click: a short one is no long run
    expect(Date.now() - (w.services.jobs.get(next)?.view.started ?? 0)).toBeLessThan(5_000);
    w.run.say({ type: 'agent-done', job: next, reply: 'Done.' });
    await waitFor(() => w.services.jobs.get(next)?.view.state === 'done');
    await w.services.notify.idle();
    expect(w.service.calls.length).toBe(1);
    expect(w.unseenRows().map((r) => r.job)).toEqual([asked, next]);
  });

  it('counts a song seen on any device as seen on all, and answers this device’s count', async () => {
    const w = await world();
    const phone = await w.admit(w.token);
    await w.push('PUT', { mode: 'every', subscription: device().subscription });
    await w.runTo('done');
    await w.runTo('done');
    const other = await w.song('Other');
    w.services.store.database
      .prepare('INSERT INTO agent_unseen (job, device, project, at) VALUES (?, ?, ?, ?)')
      .run('agj_0000000000aa', w.device.id, other.id, 1);
    expect((await w.push('GET')).json()).toMatchObject({ unseen: 3 });
    // seen on the phone: none of this song's count anywhere, the other song's still does
    const res = await w.seen(w.s.id, phone.token);
    expect(res.json()).toEqual({ unseen: 0 });
    expect((await w.push('GET')).json()).toMatchObject({ unseen: 1 });
    expect((await w.seen(other.id)).json()).toEqual({ unseen: 0 });
    expect((await w.seen('../nope')).statusCode).toBe(400);
  });

  it('forgets a device’s subscription and unseen replies when the device is removed', async () => {
    const w = await world();
    const phone = await w.admit(w.token);
    w.studio(phone.token, w.s.id, 'phone');
    await w.push('PUT', { mode: 'every', subscription: device().subscription }, phone.token);
    await w.runTo('done', 1000, phone.token);
    const count = (table: string) =>
      (
        w.services.store.database
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE device = ?`)
          .get(phone.device.id) as {
          n: number;
        }
      ).n;
    expect(count('agent_push')).toBe(1);
    expect(count('agent_unseen')).toBe(1);
    const removed = await w.app.inject({
      method: 'DELETE',
      url: `/api/agent/devices/${phone.device.id}`,
      headers: auth(w.token),
    });
    expect(removed.statusCode).toBe(200);
    expect(count('agent_push')).toBe(0);
    expect(count('agent_unseen')).toBe(0);
  });
});
