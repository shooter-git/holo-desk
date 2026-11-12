/**
 * Listening to a recording (how long and how loud it is, its tempo and, for one line, its notes): the
 * engine's analysis (`@holo/engine/analysis`; this part alone, packages/engine/src/analysis/pitch.ts),
 * which the agent's measurements on the host share. Here for the worker that runs it in the studio
 * (pitch.worker.ts).
 */
export {
  type AudioMeasure,
  downsample,
  type HeardNote,
  measure,
  midiOf,
  notesOf,
  pitchTrack,
  TRACK_RATE,
  tempoOf,
  yin,
} from '@holo/engine/analysis/pitch';
