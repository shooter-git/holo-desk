import { newProject, newRegion, newTrack, PPQ, readMidi, writeMidi } from '@holo/session';
import { describe, expect, it } from 'vitest';
import {
  classify,
  encodeWav,
  fitImage,
  fitMeta,
  imageType,
  MAX_ATTACHMENT,
  MAX_META,
  MAX_TEXT,
  midiMeta,
} from '../src/app/attach.ts';

const file = (name: string, type = '', size = 1000) => ({ name, type, size });

describe('what may go with a request', () => {
  it('takes pictures, recordings, MIDI, MusicXML and text, by their ending first', () => {
    expect(classify(file('page.jpg', 'image/jpeg'))).toEqual({ kind: 'image', type: null });
    expect(classify(file('take.wav', 'audio/x-wav'))).toEqual({ kind: 'audio', type: 'audio/wav' });
    expect(classify(file('take.m4a', ''))).toEqual({ kind: 'audio', type: 'audio/mp4' });
    expect(classify(file('tune.mid', 'audio/mid'))).toEqual({ kind: 'midi', type: 'audio/midi' });
    // a system that calls a MIDI file something else: its ending says what it is
    expect(classify(file('tune.midi', 'application/octet-stream'))).toEqual({ kind: 'midi', type: 'audio/midi' });
    expect(classify(file('score.musicxml', 'application/xml'))).toEqual({
      kind: 'score',
      type: 'application/vnd.recordare.musicxml+xml',
    });
    expect(classify(file('notes.txt', 'text/plain'))).toEqual({ kind: 'text', type: 'text/plain' });
    // a picture pasted from the clipboard has no ending
    expect(classify(file('', 'image/png'))).toEqual({ kind: 'image', type: null });
  });

  it('turns away other kinds, and files too big, saying why', () => {
    expect(classify(file('song.pdf', 'application/pdf'))).toHaveProperty('error');
    expect(classify(file('score.mxl', 'application/vnd.recordare.musicxml'))).toHaveProperty('error');
    expect(classify(file('take.wav', 'audio/wav', MAX_ATTACHMENT + 1))).toEqual({
      error: 'take.wav is 25 MB: 25 MB at most',
    });
    expect(classify(file('long.txt', 'text/plain', MAX_TEXT + 1))).toHaveProperty('error');
    expect(classify(file('empty.wav', 'audio/wav', 0))).toEqual({ error: 'empty.wav is empty' });
    // a big photo is fine: it's drawn again smaller before it goes
    expect(classify(file('huge.jpg', 'image/jpeg', 40 * 1024 * 1024))).toEqual({ kind: 'image', type: null });
  });
});

describe('a picture drawn again', () => {
  it('is no bigger than 2048 on its long side, its shape kept, never made bigger', () => {
    expect(fitImage(4032, 3024)).toEqual({ w: 2048, h: 1536 });
    expect(fitImage(3024, 4032)).toEqual({ w: 1536, h: 2048 });
    expect(fitImage(2880, 1800)).toEqual({ w: 2048, h: 1280 });
    expect(fitImage(800, 600)).toEqual({ w: 800, h: 600 });
    expect(fitImage(2048, 10)).toEqual({ w: 2048, h: 10 });
    expect(fitImage(100_000, 1)).toEqual({ w: 2048, h: 1 });
  });

  it('is a PNG for a screenshot, a JPEG for a photo', () => {
    expect(imageType('screenshot', 'image/jpeg')).toBe('image/png');
    expect(imageType('photo', 'image/png')).toBe('image/jpeg');
    expect(imageType('file', 'image/png')).toBe('image/png');
    expect(imageType('file', 'image/webp')).toBe('image/jpeg');
  });
});

describe('what was measured', () => {
  it('fits the host’s limit: its notes shortened until it does', () => {
    const notes = Array.from({ length: 20_000 }, (_, i) => [i / 10, 0.1, 60 + (i % 12), 90]);
    const fitted = fitMeta({ seconds: 2000, notes });
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(MAX_META);
    expect(fitted.seconds).toBe(2000);
    expect(fitted.notesCut).toBe(true);
    expect((fitted.notes as unknown[]).length).toBeGreaterThan(1000);
    const small = { seconds: 3, notes: [[0, 1, 60, 90]] };
    expect(fitMeta(small)).toBe(small);
  });

  it('reads a MIDI file’s notes at HO[LO]’s PPQ', () => {
    const p = newProject('Tune');
    const t = newTrack('Lead', { type: 'synth', preset: 'Soft Keys' });
    const r = newRegion(0, 4 * PPQ);
    r.notes = [
      { t: 0, d: PPQ, p: 60, v: 100 },
      { t: PPQ, d: PPQ / 2, p: 64, v: 90 },
    ];
    t.regions.push(r);
    p.tracks = [t];
    const meta = midiMeta(readMidi(writeMidi(p)));
    expect(meta.ppq).toBe(PPQ);
    expect(meta.meter).toBe('4/4');
    expect((meta.notes as number[][]).map((n) => n.slice(0, 4))).toEqual([
      [0, PPQ, 60, 100],
      [PPQ, PPQ / 2, 64, 90],
    ]);
  });
});

describe('a recording as a WAV file', () => {
  it('has a 16-bit mono header and its samples', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]), 44100);
    const text = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
    const view = new DataView(wav.buffer);
    expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([0, 32767, -32768]);
  });
});
