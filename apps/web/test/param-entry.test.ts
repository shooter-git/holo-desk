import type { ParamDef } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { entryText, parseParam } from '../src/ui/param-entry.ts';

const hz: ParamDef = { id: 'f', name: 'Freq', min: 20, max: 20000, default: 1000, unit: 'Hz', scale: 'log' };
const db: ParamDef = { id: 'g', name: 'Gain', min: -18, max: 18, default: 0, unit: 'dB' };
const sec: ParamDef = { id: 'r', name: 'Release', min: 0.01, max: 4, default: 0.2, unit: 's', scale: 'log' };
const ms: ParamDef = { id: 'a', name: 'Attack', min: 0.1, max: 200, default: 10, unit: 'ms', scale: 'log' };
const pct: ParamDef = { id: 'm', name: 'Mix', min: 0, max: 100, default: 50, unit: '%', step: 1 };
const ratio: ParamDef = { id: 'x', name: 'Ratio', min: 1, max: 20, default: 3, unit: ':1' };
const pan: ParamDef = { id: 'pan', name: 'Pan', min: -64, max: 64, default: 0, step: 1, unit: 'LR' };
const style: ParamDef = {
  id: 's',
  name: 'Style',
  min: 0,
  max: 3,
  default: 0,
  step: 1,
  options: ['Rock', 'Funk', 'Jazz', 'Ballad'],
};
const mic: ParamDef = { id: 'mic', name: 'Room', min: -60, max: 6, default: 0, unit: 'dB', offAtMin: true };

describe('a value typed for a setting', () => {
  it('a number alone is in the setting’s unit', () => {
    expect(parseParam(hz, '2500')).toBe(2500);
    expect(parseParam(db, '-6')).toBe(-6);
    expect(parseParam(db, '+3.5')).toBe(3.5);
    expect(parseParam(ratio, '4')).toBe(4);
  });

  it('takes the unit as it’s shown, and a comma for the point', () => {
    expect(parseParam(hz, '2.5 kHz')).toBe(2500);
    expect(parseParam(hz, '2,5k')).toBe(2500);
    expect(parseParam(hz, '440 Hz')).toBe(440);
    expect(parseParam(db, '-6.0 dB')).toBe(-6);
    expect(parseParam(pct, '45%')).toBe(45);
    expect(parseParam(ratio, '4.0:1')).toBe(4);
  });

  it('goes between seconds and milliseconds', () => {
    expect(parseParam(sec, '250 ms')).toBe(0.25);
    expect(parseParam(sec, '1.5')).toBe(1.5);
    expect(parseParam(ms, '0.1 s')).toBe(100);
    expect(parseParam(ms, '12 ms')).toBe(12);
  });

  it('keeps to the range and the steps', () => {
    expect(parseParam(hz, '5')).toBe(20);
    expect(parseParam(hz, '99k')).toBe(20000);
    expect(parseParam(pct, '33.6')).toBe(34);
  });

  it('reads a pan as it’s written', () => {
    expect(parseParam(pan, 'L20')).toBe(-20);
    expect(parseParam(pan, 'r 15')).toBe(15);
    expect(parseParam(pan, 'c')).toBe(0);
    expect(parseParam(pan, 'Center')).toBe(0);
    expect(parseParam(pan, '-30')).toBe(-30);
    expect(parseParam(pan, 'L99')).toBe(-64);
  });

  it('a choice by its name, or the start of it', () => {
    expect(parseParam(style, 'jazz')).toBe(2);
    expect(parseParam(style, 'Ba')).toBe(3);
    expect(parseParam(style, 'polka')).toBeNull();
  });

  it('off, for what goes off at its lowest', () => {
    expect(parseParam(mic, 'off')).toBe(-60);
    expect(parseParam(db, 'off')).toBeNull();
  });

  it('isn’t one when it’s empty or not a number', () => {
    expect(parseParam(hz, '')).toBeNull();
    expect(parseParam(hz, '  ')).toBeNull();
    expect(parseParam(hz, 'loud')).toBeNull();
  });
});

describe('what the field starts with', () => {
  it('is the plain number, to four figures', () => {
    expect(entryText(hz, 1608.5067144095572)).toBe('1609');
    expect(entryText(hz, 440)).toBe('440');
    expect(entryText(db, -6)).toBe('-6');
    expect(entryText(sec, 0.25)).toBe('0.25');
  });

  it('is a choice’s name, and Off at the lowest of what goes off', () => {
    expect(entryText(style, 2)).toBe('Jazz');
    expect(entryText(mic, -60)).toBe('Off');
  });

  it('comes back to the same value', () => {
    for (const [p, v] of [
      [hz, 2500],
      [db, -4.5],
      [sec, 0.25],
      [pct, 45],
      [style, 1],
    ] as const)
      expect(parseParam(p, entryText(p, v))).toBe(v);
  });
});
