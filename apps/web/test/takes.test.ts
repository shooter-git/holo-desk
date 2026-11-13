import type { AudioFile } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { TakeSender } from '../src/app/take-sender.ts';
import { type Shelf, type TakePlan, Takes, UploadError } from '../src/audio/takes.ts';

/** The browser's Cache, as far as takes use it. */
function shelf(): Shelf & { size: () => number } {
  const kept = new Map<string, Response>();
  return {
    put: async (key, value) => void kept.set(key, value),
    match: async (key) => kept.get(key)?.clone(),
    keys: async () => [...kept.keys()].map((url) => ({ url: `https://studio.example${url}` })),
    delete: async (key) => kept.delete(key),
    size: () => kept.size,
  };
}

const plan = (name = 'Vocal #01', project = 'prj_a'): TakePlan => ({
  project,
  track: 'trk_vocal',
  name,
  rate: 48000,
  channels: 2,
  seconds: 12.5,
  regions: [{ from: 3840, length: 9600, name, offset: 0.03 }],
});
const wav = () => new Blob([new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4])], { type: 'audio/wav' });
const fileOf = (take: TakePlan, id = 'aud_new'): AudioFile => ({
  id,
  name: `${take.name}.wav`,
  seconds: take.seconds,
  rate: take.rate,
  channels: take.channels,
});

/** A sender with a server that answers as told, and a song that is or isn't open. */
function rig(answers: (number | null | 'ok')[], open = true) {
  const store = shelf();
  const takes = new Takes(async () => store);
  const log = {
    uploads: 0,
    placed: [] as string[],
    said: [] as string[],
    saved: [] as string[],
    waits: [] as number[],
  };
  const state = { open };
  const sender = new TakeSender({
    takes,
    upload: async (take) => {
      const answer = answers[Math.min(log.uploads++, answers.length - 1)];
      if (answer === 'ok') return fileOf(take, `aud_${log.uploads}`);
      throw new UploadError(answer === null ? 'the server didn’t answer' : 'no', answer ?? null);
    },
    place: (take, file) => {
      if (!state.open) return false;
      log.placed.push(`${take.name}:${file.id}`);
      return true;
    },
    say: (text) => void log.said.push(text),
    save: (name) => void log.saved.push(name),
    wait: async (ms) => void log.waits.push(ms),
  });
  return { sender, takes, store, log, state };
}

describe('takes kept on the device', () => {
  it('come back as they were kept, oldest first, a song’s when one is named', async () => {
    const takes = new Takes(async () => shelf());
    expect(await takes.list()).toEqual([]);
    const store = shelf();
    const kept = new Takes(async () => store);
    const a = await kept.keep(plan('Vocal #01'), wav(), 1000);
    const b = await kept.keep(plan('Guitar #02', 'prj_b'), wav(), 2000);
    const c = await kept.keep(plan('Vocal #02'), wav(), 3000);
    expect((await kept.list()).map((t) => t.name)).toEqual(['Vocal #01', 'Guitar #02', 'Vocal #02']);
    expect((await kept.list('prj_a')).map((t) => t.id)).toEqual([a?.id, c?.id]);
    expect((await kept.wav(b?.id as string))?.size).toBe(8);
    await kept.forget(a?.id as string);
    expect((await kept.list('prj_a')).map((t) => t.name)).toEqual(['Vocal #02']);
  });

  it('are not kept where the device has nowhere to keep them', async () => {
    const none = new Takes(async () => null);
    expect(await none.keep(plan(), wav())).toBeNull();
    expect(await none.list()).toEqual([]);
  });
});

describe('a recorded take on its way to the song', () => {
  it('is sent, placed and forgotten here when the server answers', async () => {
    const { sender, store, log } = rig(['ok']);
    expect(await sender.record(plan(), wav())).toBe(true);
    expect(log.placed).toEqual(['Vocal #01:aud_1']);
    expect(store.size()).toBe(0);
    expect(log.said).toEqual([]);
  });

  it('is tried a few times, then kept, when the server doesn’t answer; and sent when it does', async () => {
    const { sender, takes, log } = rig([null, null, null, null, 'ok']);
    expect(await sender.record(plan(), wav())).toBe(false);
    expect(log.uploads).toBe(3);
    expect(log.waits).toEqual([700, 2500]);
    expect(log.placed).toEqual([]);
    expect((await takes.list('prj_a')).map((t) => t.name)).toEqual(['Vocal #01']);
    expect(log.said[0]).toContain('kept on this device and will be sent');
    // later, still no answer: it waits, and nothing more is said
    expect(await sender.resume('prj_a')).toBe(1);
    expect(log.said).toHaveLength(1);
    // the server is back
    expect(await sender.resume('prj_a')).toBe(0);
    expect(log.placed).toEqual(['Vocal #01:aud_5']);
    expect(await takes.list()).toEqual([]);
    // and it isn't sent again
    expect(await sender.resume('prj_a')).toBe(0);
    expect(log.uploads).toBe(5);
  });

  it('is kept, with a copy to save, when the server refuses it: once is enough to know', async () => {
    const { sender, takes, log } = rig([413]);
    expect(await sender.record(plan(), wav())).toBe(false);
    expect(log.uploads).toBe(1);
    expect(log.said[0]).toContain('wouldn’t take Vocal #01');
    expect(await takes.list('prj_a')).toHaveLength(1);
  });

  it('is placed without being sent again when its song wasn’t open as it landed', async () => {
    const { sender, takes, log, state } = rig(['ok'], false);
    expect(await sender.record(plan(), wav())).toBe(true);
    const [kept] = await takes.list('prj_a');
    expect(kept?.file?.id).toBe('aud_1');
    expect(log.placed).toEqual([]);
    state.open = true;
    expect(await sender.resume('prj_a')).toBe(0);
    expect(log.uploads).toBe(1);
    expect(log.placed).toEqual(['Vocal #01:aud_1']);
    expect(await takes.list()).toEqual([]);
  });

  it('still goes to the song from a device with nowhere to keep it, and says so plainly when it can’t', async () => {
    const said: string[] = [];
    const placed: string[] = [];
    let answer: 'ok' | null = 'ok';
    const sender = new TakeSender({
      takes: new Takes(async () => null),
      upload: async (take) => {
        if (answer === 'ok') return fileOf(take);
        throw new UploadError('the server didn’t answer', null);
      },
      place: (take) => {
        placed.push(take.name);
        return true;
      },
      say: (text) => void said.push(text),
      save: () => undefined,
      wait: async () => undefined,
    });
    expect(await sender.record(plan(), wav())).toBe(true);
    expect(placed).toEqual(['Vocal #01']);
    answer = null;
    expect(await sender.record(plan('Vocal #02'), wav())).toBe(false);
    expect(said[0]).toContain('nowhere to keep it');
  });
});
