/**
 * Which view an instrument track's notes are in. The Step Grid is a kit's view: a track played by
 * pitch (or a kit whose pads aren't known yet) shows its Piano Roll, whatever was last chosen, and
 * goes back to the grid when a kit is selected again.
 */
import { playsHits } from '@holo/agent/edits';
import type { Instrument, Track } from '@holo/session';
import { useEffect, useState } from 'react';
import { type InstrumentMap, instrumentManifest, instrumentManifestNow } from '../audio/pack-files.ts';
import type { AppState, NoteView } from './store.ts';

/** The pack and name of an instrument that has a map to say what its keys are. */
function mapped(instrument: Instrument | null | undefined): { pack: string; name: string } | null {
  return instrument?.type === 'sampler' || instrument?.type === 'performance'
    ? { pack: instrument.pack, name: instrument.name }
    : null;
}

/** An instrument's map as far as it's known now (null for a synth, or one not fetched yet). */
export function kitMapNow(instrument: Instrument | null | undefined): InstrumentMap | null {
  const m = mapped(instrument);
  return m ? instrumentManifestNow(m.pack, m.name) : null;
}

/** Whether a track is a kit, as far as is known now. */
export const isKitNow = (track: Pick<Track, 'kind' | 'instrument'> | null | undefined): boolean =>
  track?.kind === 'instrument' && playsHits(track.instrument, kitMapNow(track.instrument));

/** The view a track's notes are shown in, given what was chosen. */
export function noteViewFor(chosen: NoteView, track: Pick<Track, 'kind' | 'instrument'> | null | undefined): NoteView {
  return chosen === 'steps' && !isKitNow(track) ? 'roll' : chosen;
}

/** The view the selected track's notes are shown in. */
export function shownNoteView(s: Pick<AppState, 'noteView' | 'project' | 'selectedTrack'>): NoteView {
  if (s.noteView !== 'steps') return s.noteView;
  return noteViewFor(
    s.noteView,
    s.project?.tracks.find((t) => t.id === s.selectedTrack),
  );
}

/** An instrument's map, fetched if it hasn't been (null until it comes, and for a synth). */
export function useKitMap(instrument: Instrument | null | undefined): InstrumentMap | null {
  const m = mapped(instrument);
  const pack = m?.pack ?? '';
  const name = m?.name ?? '';
  const [, come] = useState(0);
  useEffect(() => {
    if (!pack || instrumentManifestNow(pack, name)) return;
    let live = true;
    instrumentManifest(pack, name).then(
      () => live && come((n) => n + 1),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [pack, name]);
  return pack ? instrumentManifestNow(pack, name) : null;
}
