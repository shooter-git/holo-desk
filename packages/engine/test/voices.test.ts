import { describe, expect, it } from 'vitest';
import { Instrument, type Voice } from '../src/instrument.ts';
import { Synth } from '../src/synth.ts';

const SR = 48000;

/** A voice that only says what was done to it: cut voices fade over a few blocks, as real ones do. */
class Probe implements Voice {
  sustained = false;
  released = false;
  done = false;
  age = 0;
  cuts = 0;
  private fading = -1;
  readonly key: number;
  constructor(key: number) {
    this.key = key;
  }
  release(): void {
    this.released = true;
  }
  kill(): void {
    this.cuts++;
    if (this.fading < 0) this.fading = 3;
  }
  render(): void {
    if (this.fading > 0 && --this.fading === 0) this.done = true;
  }
}

class Probes extends Instrument {
  readonly made: Probe[] = [];
  constructor(max: number) {
    super(SR);
    this.maxVoices = max;
  }
  protected startVoice(key: number): Voice {
    const v = new Probe(key);
    this.made.push(v);
    return v;
  }
  /** The voices still sounding as notes: not finished, and not cut. */
  get sounding(): number[] {
    return this.made.filter((v) => !v.done && v.cuts === 0).map((v) => v.key);
  }
}

const block = (i: Instrument) => i.render(new Float32Array(128), new Float32Array(128), 0, 128);

describe('voices past the notes at once', () => {
  it('cut each old voice once, so a chord bigger than the voices keeps its latest notes', () => {
    const s = new Probes(4);
    const chord = [48, 52, 55, 59, 62, 65, 69, 72];
    for (const k of chord) s.noteOn(k, 100);
    expect(s.sounding).toEqual([62, 65, 69, 72]);
    expect(s.made.map((v) => v.cuts)).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
  });

  it('cut a let-go note before a held one, and the oldest of each first', () => {
    const s = new Probes(3);
    s.noteOn(60, 100);
    s.noteOn(64, 100);
    s.noteOn(67, 100);
    s.noteOff(64);
    s.noteOn(70, 100);
    expect(s.sounding).toEqual([60, 67, 70]);
    s.noteOn(72, 100);
    expect(s.sounding).toEqual([67, 70, 72]);
  });

  it('reuse the places of voices that have finished fading', () => {
    const s = new Probes(4);
    for (let round = 0; round < 50; round++) {
      for (const k of [48, 52, 55, 59, 62, 65]) s.noteOn(k + (round % 5), 100);
      for (let b = 0; b < 4; b++) block(s);
    }
    // never more places than the notes at once plus one burst's worth fading out: the list doesn't grow
    expect((s as unknown as { voices: Voice[] }).voices.length).toBeLessThanOrEqual(4 + 6);
    expect(s.sounding).toHaveLength(4);
  });

  it('keeps a synth to its voices, however many notes a chord asks for', () => {
    const s = new Synth(SR, 'Soft Keys');
    const max = s.maxVoices;
    for (let k = 30; k < 30 + max * 2; k++) s.noteOn(k, 100);
    // the cut ones fade over a few milliseconds, then only the latest notes sound
    for (let b = 0; b < 40; b++) block(s);
    expect(s.active).toBe(max);
  });
});
