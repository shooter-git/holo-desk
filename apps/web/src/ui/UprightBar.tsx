/**
 * An editor's bar on a phone held upright: the track it edits, the editor's tools, and ⋯ for the
 * rest. All of them side by side are wider than the phone, so what is used less (the other view,
 * the editor's actions, zoom, which two fingers do too) goes behind ⋯. The track is a chip that
 * lists the song's tracks: another one is edited from here, without going back to the Tracks tab.
 */
import { ChevronDown, Ellipsis } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { selectTrack } from '../app/actions.ts';
import { store, useApp } from '../app/store.ts';
import { type MenuEntry, openMenuAt } from './menu.tsx';
import { useScrollCue } from './scroll-cue.ts';

/** The track being edited; pressed, every track, to edit another. */
function TrackChip() {
  const name = useApp((s) => s.project?.tracks.find((t) => t.id === s.selectedTrack)?.name ?? null);
  const color = useApp((s) => s.project?.tracks.find((t) => t.id === s.selectedTrack)?.color ?? null);
  const none = useApp((s) => !s.project?.tracks.length);
  const open = (el: Element) => {
    const s = store.get();
    openMenuAt(el, [
      { heading: 'Edit track' },
      ...(s.project?.tracks ?? []).map(
        (t): MenuEntry => ({
          label: t.name,
          color: t.color,
          checked: t.id === s.selectedTrack,
          // (a long song's list opens on the track being edited)
          focus: t.id === s.selectedTrack,
          onSelect: () => selectTrack(t.id),
        }),
      ),
    ]);
  };
  return (
    <button
      type="button"
      className="btn track-chip"
      title={name === null ? 'Pick a track to edit' : `Editing ${name}: pick another track`}
      aria-haspopup="menu"
      disabled={none}
      onClick={(e) => open(e.currentTarget)}
    >
      {color && <span className="swatch" style={{ background: color }} />}
      <span className={`name${name === null ? ' muted' : ''}`}>{name ?? 'No track'}</span>
      <ChevronDown />
    </button>
  );
}

/** Piano Roll or Score for an instrument track, Wave or Notes for an audio track's recording. */
function viewEntries(): MenuEntry[] {
  const s = store.get();
  const audio = s.project?.tracks.find((t) => t.id === s.selectedTrack)?.kind === 'audio';
  if (audio) {
    return [
      { heading: 'View' },
      { label: 'Wave', checked: s.audioMode === 'wave', onSelect: () => store.set({ audioMode: 'wave' }) },
      { label: 'Notes', checked: s.audioMode === 'notes', onSelect: () => store.set({ audioMode: 'notes' }) },
    ];
  }
  return [
    { heading: 'View' },
    { label: 'Piano Roll', checked: s.noteView === 'roll', onSelect: () => store.set({ noteView: 'roll' }) },
    { label: 'Score', checked: s.noteView === 'score', onSelect: () => store.set({ noteView: 'score' }) },
  ];
}

/**
 * The chip, the tools, ⋯. The chip gives up its name's room first; past its least, the tools scroll
 * between it and ⋯ (with an edge that fades) rather than either of them leaving the screen. `more`
 * is what ⋯ adds under the views, made as it opens: an entry can open a menu of its own at `at`.
 */
export function UprightBar({ more, children }: { more: (at: Element) => MenuEntry[]; children: ReactNode }) {
  const tools = useRef<HTMLDivElement>(null);
  useScrollCue(tools, 'x');
  return (
    <>
      <TrackChip />
      <div className="upright-tools" ref={tools}>
        {children}
      </div>
      <button
        type="button"
        className="btn icon upright-more"
        title="More: the other view, and what the bar has no room for"
        aria-label="More"
        aria-haspopup="menu"
        onClick={(e) => {
          const at = e.currentTarget;
          const own = more(at);
          openMenuAt(at, [...viewEntries(), ...(own.length ? (['sep'] as const) : []), ...own]);
        }}
      >
        <Ellipsis />
      </button>
    </>
  );
}
