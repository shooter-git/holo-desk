/**
 * Edits the studio and the agent make the same way: each is worked out here once, and the studio's
 * control and the agent's tool both call it. Plain functions of the song (it imports only
 * @holo/session), so it runs in the browser, on the host and in the `holo` command alike.
 */
export * from './chords.ts';
export * from './pitch.ts';
export * from './sections.ts';
export * from './stems.ts';
export * from './steps.ts';
export * from './timing.ts';
