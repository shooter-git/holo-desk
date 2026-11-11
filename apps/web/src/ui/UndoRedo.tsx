/**
 * Undo and Redo, wherever they're shown: the control bar, the side rail of a phone on its side, and
 * the editors' own bars. There's one history for the song, so these take back the last change
 * whichever view it was made in; the tooltip names it.
 */
import { Redo2, Undo2 } from 'lucide-react';
import { redo, undo } from '../app/actions.ts';
import { useApp } from '../app/store.ts';

/** The two buttons, in a group of their own when `group` names its class (a `seg`), bare otherwise. */
export function UndoRedo({ group, button = 'btn icon' }: { group?: string; button?: string }) {
  const canUndo = useApp((s) => s.undo.length > 0);
  const canRedo = useApp((s) => s.redo.length > 0);
  const last = useApp((s) => s.undo.at(-1)?.label);
  const next = useApp((s) => s.redo.at(-1)?.label);
  const buttons = (
    <>
      <button
        type="button"
        className={button}
        title={last ? `Undo ${last} (Ctrl Z)` : 'Undo (Ctrl Z)'}
        aria-label="Undo"
        disabled={!canUndo}
        onClick={undo}
      >
        <Undo2 />
      </button>
      <button
        type="button"
        className={button}
        title={next ? `Redo ${next} (Ctrl Shift Z)` : 'Redo (Ctrl Shift Z)'}
        aria-label="Redo"
        disabled={!canRedo}
        onClick={redo}
      >
        <Redo2 />
      </button>
    </>
  );
  return group ? <div className={group}>{buttons}</div> : buttons;
}
