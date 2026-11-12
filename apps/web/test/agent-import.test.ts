import { newProject } from '@holo/session';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as StudioModule from '../src/app/agent-studio.ts';
import type * as StoreModule from '../src/app/store.ts';

// the browser's parts the studio's import uses: fetching an attachment, decoding it, uploading a WAV
const seen = vi.hoisted(() => ({
  fetched: [] as string[],
  uploads: [] as { project: string; channels: number; rate: number; name: string }[],
  decodes: true,
}));
vi.mock('../src/app/agent.ts', () => ({
  attachmentData: async (id: string) => {
    seen.fetched.push(id);
    return new Blob([new Uint8Array([0x49, 0x44, 0x33])]);
  },
}));
vi.mock('../src/audio/engine.ts', () => ({
  engine: {
    ctx: {
      decodeAudioData: async () => {
        if (!seen.decodes) throw new Error('EncodingError');
        return { length: 4410, numberOfChannels: 2, sampleRate: 44100, getChannelData: () => new Float32Array(4410) };
      },
    },
  },
}));
vi.mock('../src/audio/files.ts', () => ({
  audioFiles: {
    uploadRecording: async (project: string, channels: Float32Array[], rate: number, name: string) => {
      seen.uploads.push({ project, channels: channels.length, rate, name });
      return {
        id: 'aud_up00000001',
        name,
        seconds: (channels[0]?.length ?? 0) / rate,
        rate,
        channels: channels.length,
      };
    },
  },
}));

let S: typeof StoreModule;
let studio: typeof StudioModule;

beforeAll(async () => {
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => items.set(k, v),
    removeItem: (k: string) => items.delete(k),
  });
  vi.stubGlobal('window', globalThis);
  S = await import('../src/app/store.ts');
  studio = await import('../src/app/agent-studio.ts');
  await import('../src/app/agent-import.ts');
});

describe('the studio’s part in importing a recording', () => {
  it('fetches the attachment, decodes it and uploads it as WAV, answering with the file', async () => {
    const song = newProject('Song');
    S.store.set({ project: song });
    const acks: [boolean, Record<string, unknown> | undefined][] = [];
    const ack = (ok: boolean, extra?: Record<string, unknown>) => acks.push([ok, extra]);
    const msg = {
      type: 'agent-import-audio',
      id: 'r1',
      project: song.id,
      attachment: 'att_0123456789ab',
      name: 'song.mp3',
    };

    expect(await studio.answerAgentRequest(msg, ack)).toBe(true);
    expect(seen.fetched).toEqual(['att_0123456789ab']);
    expect(seen.uploads).toEqual([{ project: song.id, channels: 2, rate: 44100, name: 'song.wav' }]);
    expect(acks.at(-1)).toEqual([
      true,
      { file: { id: 'aud_up00000001', name: 'song.mp3', seconds: 0.1, rate: 44100, channels: 2 } },
    ]);

    // another song open here, an odd id, a recording this browser can't read: why not
    await studio.answerAgentRequest({ ...msg, project: 'prj_other' }, ack);
    expect(acks.at(-1)).toEqual([false, { error: 'That song isn’t open in the studio' }]);
    await studio.answerAgentRequest({ ...msg, attachment: '../x' }, ack);
    expect(acks.at(-1)).toEqual([false, { error: 'No such attachment' }]);
    seen.decodes = false;
    await studio.answerAgentRequest(msg, ack);
    expect(acks.at(-1)).toEqual([false, { error: 'This browser can’t read song.mp3' }]);
    expect(seen.uploads).toHaveLength(1);
  });
});
