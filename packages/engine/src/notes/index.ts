/**
 * A recording's notes (`@holo/engine/notes`): finding them to edit them, the curves they're drawn
 * with, and what kind of recording it is (detect.ts); and what their edits make of the pitch, the
 * formant and the level, drawn as they're rendered (curve.ts). It needs nothing else of the engine,
 * so a worker can load it alone.
 */

export { editedPitch, formantShift, noteGain, type PitchTrack, pitchSpan, targetShift } from './curve.ts';
export {
  classifyRecording,
  DETECT_V,
  detectNotes,
  type NoteCurves,
  noteCurves,
  noteShape,
  notesAndCurves,
  type RecordingKind,
} from './detect.ts';
