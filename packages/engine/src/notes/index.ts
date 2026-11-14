/**
 * A recording's notes (`@holo/engine/notes`): finding them to edit them, the curves they're drawn
 * with, and what kind of recording it is (detect.ts). It needs nothing else of the engine, so a
 * worker can load it alone.
 */
export {
  classifyRecording,
  DETECT_V,
  detectNotes,
  type NoteCurves,
  noteCurves,
  type RecordingKind,
} from './detect.ts';
