/**
 * What the measuring tests share: tones, a song with a sung take in a scratch data folder (as WAV or
 * FLAC), a FLAC file written plainly (verbatim subframes, as a FLAC encoder may), and a stand-in for the
 * measuring child.
 */
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav } from '@holo/engine';
import { newAudioTrack, newProject, newRegion, PPQ, type Project, type Track } from '@holo/session';
import type { ChildLike } from '../src/agent/measure/runner.ts';

export const SR = 48000;
export const BAR = PPQ * 4;

/** A sine at a MIDI pitch (with cents), `seconds` long. */
export function tone(midi: number, seconds: number, amp = 0.3, rate = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  const hz = 440 * 2 ** ((midi - 69) / 12);
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

/** Tones placed at times (s) in `seconds` of silence: [at, length, MIDI pitch]. */
export function sung(seconds: number, notes: [number, number, number][], rate = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (const [at, length, midi] of notes) out.set(tone(midi, length, 0.3, rate), Math.round(at * rate));
  return out;
}

// ---- FLAC, written plainly ----

class BitWriter {
  bytes: number[] = [];
  private cur = 0;
  private n = 0;
  bits(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | (Math.floor(value / 2 ** i) & 1);
      if (++this.n === 8) {
        this.bytes.push(this.cur);
        this.cur = 0;
        this.n = 0;
      }
    }
  }
  align(): void {
    while (this.n) this.bits(0, 1);
  }
}

function crc(bytes: number[], from: number, poly: number, width: 8 | 16): number {
  let c = 0;
  const top = 1 << (width - 1);
  const mask = (1 << width) - 1;
  for (let i = from; i < bytes.length; i++) {
    c ^= (bytes[i] as number) << (width - 8);
    for (let b = 0; b < 8; b++) c = c & top ? ((c << 1) ^ poly) & mask : (c << 1) & mask;
  }
  return c;
}

/** A FLAC file of the samples (16-bit, independent channels, verbatim subframes, no MD5). */
export function flacOf(channels: Float32Array[], rate: number): Uint8Array {
  const bits = 16;
  const total = channels[0]?.length ?? 0;
  const block = 4096;
  const w = new BitWriter();
  for (const ch of 'fLaC') w.bits(ch.charCodeAt(0), 8);
  w.bits(1, 1);
  w.bits(0, 7);
  w.bits(34, 24);
  w.bits(block, 16);
  w.bits(block, 16);
  w.bits(0, 24);
  w.bits(0, 24);
  w.bits(rate, 20);
  w.bits(channels.length - 1, 3);
  w.bits(bits - 1, 5);
  w.bits(Math.floor(total / 2 ** 32), 4);
  w.bits(total % 2 ** 32, 32);
  for (let i = 0; i < 16; i++) w.bits(0, 8);
  for (let f = 0, at = 0; at < total; f++, at += block) {
    const n = Math.min(block, total - at);
    const start = w.bytes.length;
    w.bits(0x3ffe, 14);
    w.bits(0, 1);
    w.bits(0, 1);
    w.bits(7, 4);
    w.bits(0, 4);
    w.bits(channels.length - 1, 4);
    w.bits(0, 3);
    w.bits(0, 1);
    // the frame's number, as UTF-8 codes a character
    if (f < 0x80) w.bits(f, 8);
    else {
      w.bits(0xc0 | (f >> 6), 8);
      w.bits(0x80 | (f & 0x3f), 8);
    }
    w.bits(n - 1, 16);
    w.bits(crc(w.bytes, start, 0x07, 8), 8);
    for (const ch of channels) {
      w.bits(0, 1);
      w.bits(1, 6);
      w.bits(0, 1);
      for (let i = 0; i < n; i++) {
        const v = Math.max(-32768, Math.min(32767, Math.round((ch[at + i] as number) * 32768)));
        w.bits(v < 0 ? v + 65536 : v, 16);
      }
    }
    w.align();
    w.bits(crc(w.bytes, start, 0x8005, 16), 16);
  }
  return new Uint8Array(w.bytes);
}

// ---- a song with a take ----

/**
 * A song (120 bpm, D minor) whose "Vocals" track plays a recording from bar 2, kept in a scratch data
 * folder as WAV or FLAC: D4, F4 30 cents sharp, A4, a second apart.
 */
export function takeWorld(format: 'wav' | 'flac' = 'wav'): { dataDir: string; song: Project; vocals: Track } {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'holo-measure-')), 'data');
  const song = newProject('Measured');
  song.key = 'D minor';
  const vocals = { ...newAudioTrack('Vocals'), id: 'trk_vocals' };
  const pcm = sung(4, [
    [0.5, 0.6, 62],
    [1.5, 0.6, 65.3],
    [2.5, 0.6, 69],
  ]);
  const dir = join(dataDir, 'audio', song.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `aud_take1.${format}`), format === 'wav' ? encodeWav([pcm], SR, 'pcm24') : flacOf([pcm], SR));
  const r = { ...newRegion(BAR, BAR * 2, 'Take 1'), id: 'rgn_take1' };
  r.audio = { file: 'aud_take1', offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 };
  vocals.regions.push(r);
  song.tracks.push(vocals);
  song.files = [{ id: 'aud_take1', name: `take.${format}`, seconds: 4, rate: SR, channels: 1 }];
  return { dataDir, song, vocals };
}

// ---- a stand-in for the measuring child ----

export class FakeChild extends EventEmitter implements ChildLike {
  sent: Record<string, unknown>[] = [];
  killed = false;
  pid = undefined;
  send(msg: unknown): boolean {
    this.sent.push(msg as Record<string, unknown>);
    return true;
  }
  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit('exit'));
    return true;
  }
  /** Says something, as the child would. */
  say(msg: Record<string, unknown>): void {
    this.emit('message', msg);
  }
  /** The id of the measurement it was last asked to run. */
  get running(): string {
    return String(this.sent.at(-1)?.id);
  }
}
