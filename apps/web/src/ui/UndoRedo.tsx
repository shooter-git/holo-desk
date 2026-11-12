/**
 * Undo and Redo, wherever they're shown: the control bar, the side rail of a phone on its side, and
 * the editors' own bars. There's one history for the song, so these take back the last change
 * whichever view it was made in; the tooltip names it. A right-click or a long press on either opens
 * the whole history, and a change picked there takes the song straight back, or forward, to it.
 */
import { Redo2, Undo2 } from 'lucide-react';
import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useRef } from 'react';
import { redo, travelTo, undo } from '../app/actions.ts';
import { store, useApp } from '../app/store.ts';
import { LONG_PRESS_MS } from './gesture.ts';
import { historyMenu } from './history-menu.ts';
import { openMenuAt } from './menu.tsx';

/** The two buttons, in a group of their own when `group` names its class (a `seg`), bare otherwise. */
export function UndoRedo({ group, button = 'btn icon' }: { group?: string; button?: string }) {
  const canUndo = useApp((s) => s.undo.length > 0);
  const canRedo = useApp((s) => s.redo.length > 0);
  const last = useApp((s) => s.undo.at(-1)?.label);
  const next = useApp((s) => s.redo.at(-1)?.label);
  /** A finger on a button: once it has rested long enough the history opens, and lifting it isn't a click. */
  const held = useRef<{ timer: number; fired: boolean } | null>(null);

  const letGo = () => {
    if (held.current) clearTimeout(held.current.timer);
  };
  const handlers = (from: 'undo' | 'redo', act: () => void) => {
    const show = (el: Element) => openMenuAt(el, historyMenu(store.get(), from, travelTo));
    return {
      onClick: () => {
        const press = held.current;
        held.current = null;
        if (!press?.fired) act();
      },
      onContextMenu: (e: ReactMouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        const press = held.current;
        // a long press can bring both this and the timer (Android): the history opens once
        if (press?.fired) return;
        letGo();
        if (press) press.fired = true;
        show(e.currentTarget);
      },
      onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
        letGo();
        held.current = null;
        if (e.pointerType !== 'touch') return;
        const el = e.currentTarget;
        const press = {
          fired: false,
          timer: window.setTimeout(() => {
            press.fired = true;
            navigator.vibrate?.(10);
            show(el);
          }, LONG_PRESS_MS),
        };
        held.current = press;
      },
      onPointerUp: letGo,
      onPointerCancel: letGo,
      onPointerLeave: letGo,
    };
  };

  const buttons = (
    <>
      <button
        type="button"
        className={button}
        title={last ? `Undo ${last} (Ctrl Z). Right-click for the history` : 'Undo (Ctrl Z)'}
        aria-label="Undo"
        disabled={!canUndo}
        {...handlers('undo', undo)}
      >
        <Undo2 />
      </button>
      <button
        type="button"
        className={button}
        title={next ? `Redo ${next} (Ctrl Shift Z). Right-click for the history` : 'Redo (Ctrl Shift Z)'}
        aria-label="Redo"
        disabled={!canRedo}
        {...handlers('redo', redo)}
      >
        <Redo2 />
      </button>
    </>
  );
  return group ? <div className={group}>{buttons}</div> : buttons;
}
