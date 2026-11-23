/**
 * The selected notes' tools on a touch screen, over the bottom of the music where a thumb is: a sharp,
 * flat or natural, a value, a tap that adds to the selection (a touch screen's Shift), delete, and the
 * rest (copy and paste, steps, semitones and octaves) in the menu a long press on a note opens too. A
 * held note is dragged up and down. With nothing selected but notes copied, it offers the paste.
 */
import type { ScoreDoc } from '@holo/score';
import { ClipboardPaste, Ellipsis, ListPlus, Trash2 } from 'lucide-react';
import { useMemo, useSyncExternalStore } from 'react';
import { deleteSelection } from '../app/actions.ts';
import { store, useApp } from '../app/store.ts';
import { openMenuAt } from '../ui/menu.tsx';
import { entry } from './doc.ts';
import {
  accidentalSelection,
  lengthItems,
  noteItems,
  noteValueOf,
  onDrums,
  paste,
  selectionIn,
  setAdding,
  sharedAccidental,
  sharedLength,
  spotOf,
  useEditState,
} from './editing.ts';
import { NoteIcon } from './Palette.tsx';

const ACCIDENTALS: [number, string, string][] = [
  [1, '♯', 'Sharp'],
  [-1, '♭', 'Flat'],
  [0, '♮', 'Natural'],
];

const NAMES: Record<number, string> = {
  1: 'whole',
  2: 'half',
  4: 'quarter',
  8: 'eighth',
  16: 'sixteenth',
  32: 'thirty-second',
};

export function SelectionBar({ doc }: { doc: ScoreDoc }) {
  const selected = useApp((s) => s.selectedNotes);
  const { clip, adding } = useEditState();
  // (typing lyrics or a chord symbol, the keyboard is up and the bar would be under it)
  const typingWords = useSyncExternalStore(
    (fn) => entry.subscribe(fn),
    () => !!entry.state?.text,
  );
  const notes = useMemo(() => selectionIn(doc, selected), [doc, selected]);
  if (typingWords || (!notes.length && !clip)) return null;

  if (!notes.length) {
    return (
      <div className="score-selbar-dock">
        <div className="score-selbar" role="toolbar" aria-label="Copied notes">
          <button type="button" className="btn" title="Paste the copied notes at the playhead" onClick={() => paste()}>
            <ClipboardPaste />
            Paste
          </button>
        </div>
      </div>
    );
  }

  const drums = onDrums(doc, notes);
  const alter = sharedAccidental(doc, notes);
  const value = noteValueOf(sharedLength(notes));
  const more = (el: Element) => {
    const first = notes[0] ? spotOf(notes[0]) : null;
    openMenuAt(el, [
      ...noteItems(doc, first ? { ...first, staff: 1 } : null, true, false),
      'sep',
      { label: 'Select none', onSelect: () => store.set({ selectedNotes: [] }) },
    ]);
  };
  return (
    <div className="score-selbar-dock">
      <div className="score-selbar" role="toolbar" aria-label="Selected notes">
        {!drums && (
          <div className="seg">
            {ACCIDENTALS.map(([a, glyph, name]) => (
              <button
                key={a}
                type="button"
                // (lit for a sharp or a flat: a plain note's natural would be lit nearly always)
                className={`btn icon${a !== 0 && alter === a ? ' on' : ''}`}
                title={name}
                aria-label={name}
                aria-pressed={a !== 0 && alter === a}
                onClick={() => accidentalSelection(a)}
              >
                <span className="glyph">{glyph}</span>
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="btn"
          title="Value"
          aria-label={`Value${value ? `: ${value.dotted ? 'dotted ' : ''}${NAMES[value.value] ?? ''}` : ''}`}
          onClick={(e) => openMenuAt(e.currentTarget, lengthItems(notes, false))}
        >
          <NoteIcon value={value?.value ?? 4} />
          {value?.dotted && <span className="glyph">•</span>}▾
        </button>
        <button
          type="button"
          className={`btn icon${adding ? ' on' : ''}`}
          title={adding ? 'Taps select one note again' : 'Select more: a tap adds a note, or takes it out'}
          aria-label="Select more"
          aria-pressed={adding}
          onClick={() => setAdding(!adding)}
        >
          <ListPlus />
        </button>
        <button
          type="button"
          className="btn icon"
          title={notes.length > 1 ? 'Delete the notes' : 'Delete the note'}
          aria-label="Delete"
          onClick={deleteSelection}
        >
          <Trash2 />
        </button>
        <button
          type="button"
          className="btn icon"
          title="More"
          aria-label="More"
          onClick={(e) => more(e.currentTarget)}
        >
          <Ellipsis />
        </button>
      </div>
    </div>
  );
}
