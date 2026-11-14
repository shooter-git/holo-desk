import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import { decodeWav } from '@holo/engine';
import { decodeInput } from '@holo/music';
import { newProject, newRegion, type Project, writeMidi } from '@holo/session';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Attachments,
  MAX_ATTACHMENT,
  MAX_AUDIO,
  MAX_TEXT,
  maxSize,
  musicXmlText,
  sniff,
  tooBigText,
} from '../src/agent/attachments.ts';
import { Importer, type ImporterKit, studioFile } from '../src/agent/import/importer.ts';
import type { AgentJob } from '../src/agent/jobs.ts';
import { permissionFollowUp } from '../src/agent/prompt.ts';
import { buildApp } from '../src/app.ts';
import { readableWav, sweepAudio } from '../src/audio-files.ts';
import type { Answer } from '../src/live.ts';
import { agentWorld, auth, type Msg, waitFor } from './agent-fakes.ts';

const FIXTURES = resolve(import.meta.dirname, '../../../packages/music/test/fixtures');

let close: (() => Promise<void>) | null = null;
const scratch: string[] = [];
afterEach(async () => {
  await close?.();
  close = null;
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'holo-import-'));
  scratch.push(dir);
  return dir;
};

// ---- files made here ----

/** A 16-bit PCM WAV of these channels. */
function wav16(channels: number[][], rate: number): Buffer {
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const b = Buffer.alloc(44 + frames * count * 2);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + frames * count * 2, 4);
  b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(count, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * count * 2, 28);
  b.writeUInt16LE(count * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(frames * count * 2, 40);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < count; c++)
      b.writeInt16LE(Math.round((channels[c]?.[i] ?? 0) * 32767), 44 + (i * count + c) * 2);
  return b;
}

/** A 16-bit AIFF of these channels (its rate an integer, as an 80-bit float). */
function aiff16(channels: number[][], rate: number): Buffer {
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const data = frames * count * 2;
  const b = Buffer.alloc(12 + 26 + 16 + data);
  b.write('FORM', 0, 'latin1');
  b.writeUInt32BE(b.length - 8, 4);
  b.write('AIFFCOMM', 8, 'latin1');
  b.writeUInt32BE(18, 16);
  b.writeUInt16BE(count, 20);
  b.writeUInt32BE(frames, 22);
  b.writeUInt16BE(16, 26);
  const e = Math.floor(Math.log2(rate));
  b.writeUInt16BE(16383 + e, 28);
  b.writeUInt32BE(rate * 2 ** (31 - e), 30);
  b.write('SSND', 38, 'latin1');
  b.writeUInt32BE(8 + data, 42);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < count; c++)
      b.writeInt16BE(Math.round((channels[c]?.[i] ?? 0) * 32767), 54 + (i * count + c) * 2);
  return b;
}

const ramp = (n: number, scale = 1) => Array.from({ length: n }, (_, i) => (((i % 100) - 50) / 50) * scale * 0.5);

/** A zip of these files, stored (an .mxl). */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let at = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const n = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(at, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    at += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(at, 16);
  return Buffer.concat([...locals, dir, end]);
}

/** A score of two parts (a violin's two bars, a cello's), in 3/4. */
const SCORE = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Violin</part-name></score-part>
    <score-part id="P2"><part-name>Cello</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1"><attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
      <note><pitch><step>E</step><octave>5</octave></pitch><duration>3</duration><type>half</type><dot/></note></measure>
    <measure number="2"><note><pitch><step>D</step><octave>5</octave></pitch><duration>3</duration><type>half</type><dot/></note></measure>
  </part>
  <part id="P2">
    <measure number="1"><attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time><clef><sign>F</sign><line>4</line></clef></attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>3</duration><type>half</type><dot/></note></measure>
    <measure number="2"><note><pitch><step>G</step><octave>2</octave></pitch><duration>3</duration><type>half</type><dot/></note></measure>
  </part>
</score-partwise>
`;
const CONTAINER =
  '<?xml version="1.0"?><container><rootfiles><rootfile full-path="strings.musicxml"/></rootfiles></container>';
const MXL = zip({ 'META-INF/container.xml': CONTAINER, 'strings.musicxml': SCORE });
const utf16be = (text: string) => {
  const le = Buffer.from(text, 'utf16le');
  for (let i = 0; i < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1] as number, le[i] as number];
  return le;
};
const MP3 = Buffer.concat([Buffer.from('ID3\x04\0\0\0\0\0\0'), Buffer.alloc(200, 0x55)]);

async function setup() {
  const w = await agentWorld();
  close = w.close;
  const upload = (query: Record<string, string>, data: Buffer, as: string | null = w.token) =>
    w.app.inject({
      method: 'POST',
      url: `/api/agent/attachments?${new URLSearchParams({ project: w.s.id, ...query }).toString()}`,
      headers: { 'content-type': 'application/octet-stream', ...(as ? auth(as) : {}) },
      payload: data,
    });
  const attach = async (name: string, type: string, data: Buffer, as = w.token) => {
    const res = await upload({ name, type }, data, as);
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { id: string }).id;
  };
  const audioDir = join(w.dataDir, 'audio', w.s.id);
  return { ...w, upload, attach, audioDir };
}

describe('what may be attached', () => {
  it('takes AIFF, compressed MusicXML and UTF-16 MusicXML, each checked', () => {
    const aiff = aiff16([ramp(10)], 44100);
    expect(sniff('audio/aiff', aiff)).toBeNull();
    expect(sniff('audio/aiff', Buffer.concat([Buffer.from('FORM\0\0\0\0AIFC'), Buffer.alloc(8)]))).toBeNull();
    expect(sniff('audio/aiff', wav16([ramp(10)], 44100))).not.toBeNull();

    expect(sniff('application/vnd.recordare.musicxml', MXL)).toBeNull();
    // a zip with no score in it, or not a zip at all
    expect(sniff('application/vnd.recordare.musicxml', zip({ 'notes.txt': 'hi' }))).not.toBeNull();
    expect(sniff('application/vnd.recordare.musicxml', Buffer.from(SCORE))).not.toBeNull();
    expect(sniff('application/vnd.recordare.musicxml', MXL.subarray(0, MXL.length - 22))).not.toBeNull();

    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SCORE, 'utf16le')]);
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(SCORE)]);
    for (const data of [le, be, Buffer.from(SCORE, 'utf16le'), utf16be(SCORE)]) {
      expect(sniff('application/vnd.recordare.musicxml+xml', data)).toBeNull();
      expect(musicXmlText(data)).toBe(SCORE);
    }
    expect(musicXmlText(Buffer.from(`﻿${SCORE}`))).toBe(SCORE);
    // UTF-16 that isn't a score, and odd bytes that aren't UTF-16
    expect(sniff('application/vnd.recordare.musicxml+xml', Buffer.from('<html></html>', 'utf16le'))).not.toBeNull();
    expect(sniff('application/vnd.recordare.musicxml+xml', Buffer.from([0xff, 0xfe, 0x3c]))).not.toBeNull();
  });

  it('lets a recording be 200 MB, anything else 25 (a text 100 KB)', () => {
    expect(maxSize('audio/wav')).toBe(MAX_AUDIO);
    expect(maxSize('audio/aiff')).toBe(200 * 1024 * 1024);
    expect(maxSize('audio/mpeg')).toBe(MAX_AUDIO);
    expect(maxSize('audio/midi')).toBe(MAX_ATTACHMENT);
    expect(maxSize('application/vnd.recordare.musicxml')).toBe(MAX_ATTACHMENT);
    expect(maxSize('image/png')).toBe(MAX_ATTACHMENT);
    expect(maxSize('text/plain')).toBe(MAX_TEXT);
    expect(tooBigText('audio/flac')).toBe('A recording is 200 MB at most');
    expect(tooBigText('audio/midi')).toBe('A file is 25 MB at most');
  });

  it('streams a file to disk, cut off past its limit', async () => {
    const dir = tmp();
    const kept = new Attachments(dir);
    async function* pieces(n: number, size: number) {
      for (let i = 0; i < n; i++) yield Buffer.alloc(size, i);
    }
    const got = await kept.receive(pieces(4, 1000), 4000);
    expect(got?.size).toBe(4000);
    expect(kept.head(got?.id ?? '', 1500)).toEqual(Buffer.concat([Buffer.alloc(1000, 0), Buffer.alloc(500, 1)]));
    // not an attachment until it's kept
    expect(kept.get(got?.id ?? '')).toBeNull();
    kept.keep(got?.id ?? '', 'dev_a', 'prj_a', 'x.wav', 'audio/wav', 4000);
    expect(kept.file(got?.id ?? '')).toBe(join(dir, got?.id ?? '', 'data'));
    // one byte over: nothing is left of it
    expect(await kept.receive(pieces(4, 1000), 3999)).toBeNull();
    expect(readdirSync(dir)).toEqual([got?.id]);
  });

  it('takes a long recording through the route, and the new types, as their first bytes say', async () => {
    const { upload, attach } = await setup();
    // past the 25 MB a picture may be, a recording goes in
    const long = wav16([new Array(13 * 1024 * 1024).fill(0)], 48000);
    expect(long.length).toBeGreaterThan(MAX_ATTACHMENT);
    const id = await attach('long take.wav', 'audio/wav', long);
    expect(id).toMatch(/^att_/);
    await attach('take.aif', 'audio/aiff', aiff16([ramp(100)], 44100));
    await attach('strings.mxl', 'application/vnd.recordare.musicxml', MXL);
    await attach('utf16.musicxml', 'application/vnd.recordare.musicxml+xml', Buffer.from(SCORE, 'utf16le'));
    expect(
      (await upload({ name: 'x.mxl', type: 'application/vnd.recordare.musicxml' }, Buffer.from(SCORE))).statusCode,
    ).toBe(415);
    expect((await upload({ name: 'x.aif', type: 'audio/aiff' }, MP3)).statusCode).toBe(415);
    // too big, by what it says it is: not read at all
    const res = await upload(
      { name: 'big.mid', type: 'audio/midi' },
      Buffer.concat([Buffer.from('MThd'), Buffer.alloc(MAX_ATTACHMENT)]),
    );
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'A file is 25 MB at most' });
  });
});

describe('a file’s bytes, for the studio', () => {
  it('go to the device that sent it, or the device whose running job may read it', async () => {
    const w = await setup();
    const id = await w.attach('song.mp3', 'audio/mpeg', MP3);
    const get = (as: string | null, which = id) =>
      w.app.inject({ method: 'GET', url: `/api/agent/attachments/${which}/data`, headers: as ? auth(as) : {} });
    const mine = await get(w.token);
    expect(mine.statusCode).toBe(200);
    expect(mine.headers['content-type']).toBe('audio/mpeg');
    expect(mine.headers['cache-control']).toBe('no-store');
    expect(mine.rawPayload.equals(MP3)).toBe(true);
    expect((await get(null)).statusCode).toBe(401);
    expect((await get(w.token, 'att_000000000000')).statusCode).toBe(404);
    expect((await get(w.token, '..%2F..%2Fetc')).statusCode).toBe(404);

    // another device: not until a job of its own may read it (a later request on the song's thread)
    const phone = await w.admit(w.token);
    expect((await get(phone.token)).statusCode).toBe(403);
    const first = await w.start({ project: w.s.id, text: 'Put this on a track', attachments: [id] });
    w.run.say({ type: 'agent-done', job: first.job });
    await waitFor(() => w.status(w.desk, first.job)?.state === 'done');
    expect((await get(phone.token)).statusCode).toBe(403);
    w.desk.close();
    w.studio(phone.token, w.s.id, 'phone');
    const theirs = await w.start({ project: w.s.id, text: 'And again' }, phone.token);
    expect((await get(phone.token)).statusCode).toBe(200);
    w.run.say({ type: 'agent-done', job: theirs.job });
  });

  it('give a job a score as UTF-8 text, from UTF-16 or an .mxl', async () => {
    const w = await setup();
    const mxl = await w.attach('strings.mxl', 'application/vnd.recordare.musicxml', MXL);
    const utf16 = await w.attach('utf16.musicxml', 'application/vnd.recordare.musicxml+xml', utf16be(SCORE));
    const { job, token } = await w.start({ project: w.s.id, text: 'Read these', attachments: [mxl, utf16] });
    for (const id of [mxl, utf16]) {
      const got = (await w.tool(job, token, 'GET', `/attachments/${id}`)).json() as { data: string };
      expect(Buffer.from(got.data, 'base64').toString('utf8')).toBe(SCORE);
    }
  });
});

describe('importing an attachment', () => {
  it('copies a WAV the engine reads, as it is (its rate and channels kept)', async () => {
    const w = await setup();
    const data = wav16([ramp(4410), ramp(4410, 0.5)], 44100);
    const id = await w.attach('take.wav', 'audio/wav', data);
    const { job, token } = await w.start({ project: w.s.id, text: 'Put it in', attachments: [id] });
    const res = await w.tool(job, token, 'POST', '/import', { attachment: id });
    expect(res.statusCode, res.body).toBe(200);
    const got = res.json() as { file: { id: string } };
    expect(got).toEqual({
      done: true,
      kind: 'audio',
      how: 'copied',
      file: { id: expect.stringMatching(/^aud_[a-z0-9]+$/), name: 'take.wav', seconds: 0.1, rate: 44100, channels: 2 },
    });
    expect(readdirSync(w.audioDir)).toEqual([`${got.file.id}.wav`]);
    expect(readFileSync(join(w.audioDir, `${got.file.id}.wav`)).equals(data)).toBe(true);
    // asked again in the same job: the same file
    expect((await w.tool(job, token, 'POST', '/import', { attachment: id })).json()).toEqual(got);
    expect(readdirSync(w.audioDir)).toHaveLength(1);
  });

  it('makes FLAC and AIFF WAV, the same samples', async () => {
    const w = await setup();
    const flac = await w.attach('stems.flac', 'audio/flac', readFileSync(join(FIXTURES, 'stereo16-ls.flac')));
    const channels = [ramp(2000), ramp(2000, -1)];
    const aiff = await w.attach('take.aiff', 'audio/aiff', aiff16(channels, 48000));
    const { job, token } = await w.start({ project: w.s.id, text: 'Both', attachments: [flac, aiff] });
    const reference = decodeInput(new Uint8Array(readFileSync(join(FIXTURES, 'stereo16-ls.wav'))));
    const one = (await w.tool(job, token, 'POST', '/import', { attachment: flac })).json() as {
      how: string;
      file: { id: string; rate: number; channels: number };
    };
    expect(one).toMatchObject({ how: 'converted', file: { rate: reference.rate, channels: 2, name: 'stems.flac' } });
    const back = decodeWav(new Uint8Array(readFileSync(join(w.audioDir, `${one.file.id}.wav`))));
    expect(back.rate).toBe(reference.rate);
    expect(back.channels.map((c) => [...c])).toEqual(reference.channels.map((c) => [...c]));

    const two = (await w.tool(job, token, 'POST', '/import', { attachment: aiff })).json() as {
      file: { id: string; seconds: number };
    };
    expect(two).toMatchObject({ how: 'converted', file: { rate: 48000, channels: 2, seconds: 2000 / 48000 } });
    const aiffBack = decodeWav(new Uint8Array(readFileSync(join(w.audioDir, `${two.file.id}.wav`))));
    expect(aiffBack.channels[1]?.[3]).toBeCloseTo(Math.round((channels[1]?.[3] ?? 0) * 32767) / 32768, 6);
    // only WAV in the song's folder
    expect(readdirSync(w.audioDir).every((f) => /^aud_[a-z0-9]+\.wav$/.test(f))).toBe(true);
  });

  it('hands an MP3 to the studio, which uploads it as WAV; its answer is checked', async () => {
    const w = await setup();
    const id = await w.attach('song.mp3', 'audio/mpeg', MP3);
    const { job, token } = await w.start({ project: w.s.id, text: 'Import the MP3', attachments: [id] });
    const asked: Msg[] = [];
    let answer: (msg: Msg) => Msg = () => ({ ok: false, error: 'This browser can’t read song.mp3' });
    w.desk.answer = (msg) => {
      if (msg.type !== 'agent-import-audio') return { ok: true };
      asked.push(msg);
      return answer(msg);
    };
    const refused = await w.tool(job, token, 'POST', '/import', { attachment: id });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'This browser can’t read song.mp3' });
    expect(asked[0]).toMatchObject({ project: w.s.id, attachment: id, name: 'song.mp3' });

    // a file that isn't the song's
    answer = () => ({ ok: true, file: { id: 'aud_nosuchfile', seconds: 3, rate: 48000, channels: 2 } });
    expect((await w.tool(job, token, 'POST', '/import', { attachment: id })).statusCode).toBe(502);
    // as the studio does it: the bytes uploaded as WAV through the song's files
    answer = () => {
      mkdirSync(w.audioDir, { recursive: true });
      writeFileSync(join(w.audioDir, 'aud_fromstudio1.wav'), wav16([ramp(480)], 48000));
      return { ok: true, file: { id: 'aud_fromstudio1', name: 'song.wav', seconds: 0.01, rate: 48000, channels: 1 } };
    };
    const res = await w.tool(job, token, 'POST', '/import', { attachment: id });
    expect(res.json()).toEqual({
      done: true,
      kind: 'audio',
      how: 'studio',
      file: { id: 'aud_fromstudio1', name: 'song.mp3', seconds: 0.01, rate: 48000, channels: 1 },
    });
    expect(asked).toHaveLength(3);
  });

  it('reads a MIDI file or a score (.mxl too) as a song to merge, and refuses a picture', async () => {
    const w = await setup();
    const src = newProject('groove');
    const r = newRegion(0, 3840);
    r.notes = [{ t: 0, d: 960, p: 40, v: 100 }];
    (src.tracks[0] as Project['tracks'][number]).regions = [r];
    const midi = await w.attach('groove.mid', 'audio/midi', Buffer.from(writeMidi(src)));
    const mxl = await w.attach('strings.mxl', 'application/vnd.recordare.musicxml', MXL);
    const png = await w.attach(
      'page.png',
      'image/png',
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const other = await w.song('Other');
    const elsewhere = await w.attach('other.mid', 'audio/midi', Buffer.from(writeMidi(src)));
    const { job, token } = await w.start({ project: w.s.id, text: 'Bring these in', attachments: [midi, mxl, png] });
    const read = async (id: string) => w.tool(job, token, 'POST', '/import', { attachment: id });

    const m = (await read(midi)).json() as { kind: string; format: string; song: Project };
    expect(m).toMatchObject({ done: true, kind: 'notes', format: 'midi', name: 'groove.mid' });
    expect(m.song.tracks[0]?.regions[0]?.notes.map((n) => n.p)).toEqual([40]);
    const s = (await read(mxl)).json() as { format: string; song: Project };
    expect(s.format).toBe('musicxml');
    expect(s.song.tracks.map((t) => t.name)).toEqual(['Violin', 'Cello']);
    expect(s.song.meter[0]).toMatchObject({ num: 3, den: 4 });

    const pic = await read(png);
    expect(pic.statusCode).toBe(415);
    expect(pic.json()).toEqual({
      error: 'page.png is a picture: a recording, a MIDI file or a MusicXML score can be imported',
    });
    // not this request's (attached for another song), not an id
    expect((await read(elsewhere)).statusCode).toBe(403);
    expect((await read('att_000000000000')).statusCode).toBe(404);
    expect((await w.tool(job, token, 'POST', '/import', { attachment: '../x' })).statusCode).toBe(400);
    expect(other.id).not.toBe(w.s.id);
  });
});

describe('a conversion that takes longer than a call', () => {
  it('answers not done, and the same call again waits on for the same conversion', async () => {
    const dir = tmp();
    const attachments = new Attachments(join(dir, 'attachments'));
    const a = attachments.add('dev_a', 'prj_song', 'long.mp3', 'audio/mpeg', MP3);
    let reply: (answer: Answer) => void = () => undefined;
    let asked = 0;
    const kit = {
      attachments,
      dataDir: dir,
      jobs: { mayRead: () => true, studio: () => ({}), studioBack: async () => ({}) },
      live: {
        request: () => {
          asked++;
          return new Promise<Answer>((ok) => {
            reply = ok;
          });
        },
      },
    } as unknown as ImporterKit;
    const importer = new Importer(kit, 20);
    const job = { view: { id: 'agj_000000000001', project: 'prj_song' } } as unknown as AgentJob;
    expect(await importer.import(job, a.id)).toEqual({ done: false, line: 'The studio is still converting long.mp3' });
    expect(await importer.import(job, a.id)).toMatchObject({ done: false });
    expect(asked).toBe(1);
    mkdirSync(join(dir, 'audio', 'prj_song'), { recursive: true });
    writeFileSync(join(dir, 'audio', 'prj_song', 'aud_long000001.wav'), wav16([ramp(10)], 48000));
    reply({ ok: true, file: { id: 'aud_long000001', seconds: 600, rate: 48000, channels: 2 } });
    expect(await importer.import(job, a.id)).toMatchObject({
      done: true,
      how: 'studio',
      file: { id: 'aud_long000001' },
    });
    expect(asked).toBe(1);
    importer.close();
  });

  it('checks what the studio says it kept', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'aud_there000001.wav'), 'x');
    const a = { name: 'x.mp3' };
    const file = { id: 'aud_there000001', seconds: 2, rate: 44100, channels: 2 };
    expect(studioFile({ ok: true, file }, a, dir)).toEqual({ ...file, name: 'x.mp3' });
    const status = (answer: Answer) => {
      try {
        studioFile(answer, a, dir);
      } catch (err) {
        return (err as { status: number }).status;
      }
      return 200;
    };
    expect(status({ ok: false, error: 'The studio did not answer in time' })).toBe(504);
    expect(status({ ok: false, error: 'This browser can’t read x.mp3' })).toBe(409);
    expect(status({ ok: true, file: { ...file, id: '../../etc/passwd' } })).toBe(502);
    expect(status({ ok: true, file: { ...file, rate: 44100.5 } })).toBe(502);
    expect(status({ ok: true, file: { ...file, id: 'aud_elsewhere01' } })).toBe(502);
  });
});

describe('a song’s FLAC and AIFF files', () => {
  async function app(dataDir: string) {
    const built = await buildApp({
      port: 47898,
      host: '127.0.0.1',
      dataDir,
      creationsDir: null,
      webDir: join(dataDir, 'no-web'),
      repoDir: resolve(import.meta.dirname, '../../..'),
      networkMidi: null,
    });
    close = () => built.app.close();
    return built;
  }

  it('are made WAV as they’re sent (the same id), so a render reads them; the CLI’s answer is as before', async () => {
    const dataDir = join(tmp(), 'data');
    const { app: server } = await app(dataDir);
    const song = (
      await server.inject({ method: 'POST', url: '/api/projects', payload: newProject('S') as object })
    ).json() as Project;
    const send = (name: string, body: Buffer) =>
      server.inject({
        method: 'POST',
        url: `/api/projects/${song.id}/files?name=${encodeURIComponent(name)}`,
        headers: { 'content-type': 'application/x-holo-audio' },
        payload: body,
      });
    const flac = readFileSync(join(FIXTURES, 'stereo16-ls.flac'));
    const reference = decodeInput(new Uint8Array(readFileSync(join(FIXTURES, 'stereo16-ls.wav'))));
    const res = await send('stem.flac', flac);
    expect(res.statusCode).toBe(201);
    const up = res.json() as { id: string; name: string; seconds: number; rate: number; channels: number };
    expect(up).toEqual({
      id: expect.stringMatching(/^aud_/),
      name: 'stem.flac',
      seconds: (reference.channels[0]?.length ?? 0) / reference.rate,
      rate: reference.rate,
      channels: 2,
    });
    const dir = join(dataDir, 'audio', song.id);
    expect(readdirSync(dir)).toEqual([`${up.id}.wav`]);
    const got = await server.inject({ method: 'GET', url: `/api/projects/${song.id}/files/${up.id}` });
    expect(got.headers['content-type']).toBe('audio/wav');
    expect(decodeWav(new Uint8Array(got.rawPayload)).channels.map((c) => [...c])).toEqual(
      reference.channels.map((c) => [...c]),
    );
    const aiff = (await send('take.aif', aiff16([ramp(300)], 22050))).json() as { id: string; rate: number };
    expect(aiff.rate).toBe(22050);
    expect(existsSync(join(dir, `${aiff.id}.wav`))).toBe(true);
    expect((await send('broken.flac', Buffer.from('fLaC not really'))).statusCode).toBe(415);
    // a WAV is kept as it came
    const wav = wav16([ramp(100)], 44100);
    const plain = (await send('x.wav', wav)).json() as { id: string; seconds: number };
    expect(readFileSync(join(dir, `${plain.id}.wav`)).equals(wav)).toBe(true);
    expect(readdirSync(dir).every((f) => f.endsWith('.wav'))).toBe(true);
  });

  it('kept before, are made WAV once as the server starts, replacing them', async () => {
    const dataDir = join(tmp(), 'data');
    const dir = join(dataDir, 'audio', 'prj_old');
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(FIXTURES, 'stereo16-ls.flac'), join(dir, 'aud_flac000001.flac'));
    writeFileSync(join(dir, 'aud_aiff000001.aif'), aiff16([ramp(64), ramp(64)], 44100));
    writeFileSync(join(dir, 'aud_aiff000002.AIFF'), aiff16([ramp(64)], 44100));
    writeFileSync(join(dir, 'aud_broken0001.flac'), 'fLaC broken');
    writeFileSync(join(dir, '.aud_half000001.wav.part'), 'half');
    writeFileSync(join(dir, 'aud_keep000001.wav'), wav16([ramp(10)], 44100));
    const { services } = await app(dataDir);
    expect(await services.audioSwept).toBe(3);
    expect(readdirSync(dir).sort()).toEqual([
      'aud_aiff000001.wav',
      'aud_aiff000002.wav',
      'aud_broken0001.flac',
      'aud_flac000001.wav',
      'aud_keep000001.wav',
    ]);
    expect(readableWav(readFileSync(join(dir, 'aud_aiff000001.wav')), 64 * 8 + 44)).toMatchObject({
      rate: 44100,
      channels: 2,
      frames: 64,
    });
    // once done, there's nothing more to do
    const warned: string[] = [];
    expect(await sweepAudio(dataDir, (l) => warned.push(l))).toBe(0);
    expect(warned).toEqual([expect.stringContaining("aud_broken0001.flac couldn't be made WAV")]);
  });

  it('says which WAVs the engine reads', () => {
    const pcm = wav16([ramp(10)], 44100);
    expect(readableWav(pcm, pcm.length)).toEqual({ rate: 44100, channels: 1, frames: 10, seconds: 10 / 44100 });
    const adpcm = Buffer.from(pcm);
    adpcm.writeUInt16LE(2, 20);
    expect(readableWav(adpcm, adpcm.length)).toBeNull();
    const rf64 = Buffer.from(pcm);
    rf64.write('RF64', 0, 'latin1');
    expect(readableWav(rf64, rf64.length)).toBeNull();
  });
});

describe('asking for a bounce or the creation’s render', () => {
  it('is a permission the route takes (a render only for a creation’s song), and the follow-up says it', async () => {
    const w = await setup();
    const { job, token } = await w.start({ project: w.s.id, text: 'How loud is it?' });
    const ask = (body: Msg) => w.tool(job, token, 'POST', '/permission', body);
    const wrong = await ask({ kind: 'mixdown', detail: 'x' });
    expect(wrong.json()).toEqual({
      error: 'kind is install-pack, send-creation, bounce, render, screen, photo or microphone',
    });
    const render = await ask({ kind: 'render', detail: 'To hear the game’s own sound' });
    expect(render.statusCode).toBe(400);
    expect(render.json()).toEqual({ error: 'This song didn’t come from a creation, so there’s none to render it' });
    expect((await ask({ kind: 'bounce', detail: 'To measure the mix' })).json()).toEqual({ ok: true });
    w.run.say({ type: 'agent-done', job });
    await waitFor(() => w.status(w.desk, job)?.state === 'awaiting');
    expect(w.status(w.desk, job)?.permission).toEqual({ kind: 'bounce', detail: 'To measure the mix' });
    const granted = await w.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${job}/permission`,
      headers: auth(w.token),
      payload: { grant: true, result: 'Bounced 0:42 of the song, kept with it as bounces/x/y.wav' },
    });
    const next = (granted.json() as { job: string }).job;
    const followUp = w.run.got('agent-run').find((m) => m.job === next) as Msg & { prompt: string };
    expect(followUp.prompt).toContain('You asked to bounce the song: To measure the mix');
    expect(followUp.prompt).toContain('Bounced 0:42 of the song');
    w.run.say({ type: 'agent-done', job: next });
    await waitFor(() => w.status(w.desk, next)?.state === 'done');

    // a creation's song may ask for its render
    const theirs = { ...(w.services.store.get(w.s.id) as Project) };
    theirs.origin = { creation: 'my-game', piece: 'theme', exportedAt: new Date().toISOString() };
    await w.save(theirs);
    const again = await w.start({ project: w.s.id, text: 'Hear it in the game' });
    expect(
      (await w.tool(again.job, again.token, 'POST', '/permission', { kind: 'render', detail: 'To hear it' })).json(),
    ).toEqual({ ok: true });
    expect(permissionFollowUp({ kind: 'render', detail: 'To hear it' }, 'Rendered', 'Hear it')).toContain(
      'You asked to hear the song as its creation renders it: To hear it',
    );
  });
});
