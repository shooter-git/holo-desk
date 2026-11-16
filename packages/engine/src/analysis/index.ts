/**
 * Measuring audio (`@holo/engine/analysis`): a line's pitch and notes (pitch.ts), a take's notes on the
 * timeline (take.ts), loudness and peaks (loudness.ts), where the sound sits in frequency
 * (spectrum.ts), a plugin run on its own (effect.ts), and clicks one sound has that another hasn't
 * (clicks.ts). Plain functions over samples, the same in the studio and on the host.
 */
export * from './clicks.ts';
export * from './effect.ts';
export * from './loudness.ts';
export * from './pitch.ts';
export * from './spectrum.ts';
export * from './take.ts';
