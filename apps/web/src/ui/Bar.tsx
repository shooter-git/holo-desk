/**
 * The bar (Ctrl /, the search button in the control bar, or a swipe down on a phone's top bar): the
 * studio's commands, tracks and markers, found by name. It's one of the studio's menus with a field on
 * top (the same glass, rows, blue highlight and key hints), so nothing looks bolted on. While it's open
 * the field has the keys: Up and Down choose, Enter runs, Escape closes, and the studio's shortcuts
 * wait. The song plays on.
 */
import { Search } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import {
  addTrack,
  bounceSong,
  deleteSelection,
  locate,
  moveBars,
  playheadTick,
  quantizeSelection,
  redo,
  repeatRegions,
  saveNow,
  selectAll,
  selectTrack,
  splitAtPlayhead,
  stop,
  toggleCycle,
  toggleFullscreen,
  toggleMetronome,
  togglePlay,
  toggleRecord,
  transposeSelection,
  undo,
  updateChannel,
} from '../app/actions.ts';
import { type Actions, barRows, type Command, selectionHint } from '../app/commands.ts';
import { toggleTyping } from '../app/keys.ts';
import { isPhone, useLayout } from '../app/layout.ts';
import { closeBar, openBar, store, useApp } from '../app/store.ts';
import { closeMenu } from './menu.tsx';

/** What the bar's commands do: the same actions the keys and buttons use. */
const ACTIONS: Actions = {
  set: (patch) => store.set(patch),
  togglePlay: () => void togglePlay(),
  toggleRecord: () => void toggleRecord(),
  toggleCycle,
  toggleMetronome,
  stop,
  locate,
  moveBars,
  toggleFullscreen,
  toggleTyping,
  undo,
  redo,
  deleteSelection,
  selectAll,
  quantizeSelection,
  splitAtPlayhead,
  repeatRegions,
  transposeSelection,
  selectTrack,
  setChannel: (track, patch, label) => updateChannel(track, patch, label),
  newTrack: () => void addTrack({ type: 'synth', preset: 'Soft Keys' }),
  save: () => void saveNow(),
  bounce: () => void bounceSong(true),
};

/** How far down, and how quickly, a finger goes for a swipe that opens the bar (less is a tap or a slip). */
const SWIPE_PX = 36;
const SWIPE_MS = 600;

/**
 * On a phone held upright, a short swipe down that starts on the top bar opens the bar. It only
 * watches (nothing is held back), so a tap on the bar's buttons is still a tap.
 */
function useSwipeDown(): void {
  useEffect(() => {
    let from: { x: number; y: number; at: number } | null = null;
    let to: { x: number; y: number } | null = null;
    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      const onBar = (e.target as Element | null)?.closest?.('.phone-portrait > .control-bar');
      from = e.touches.length === 1 && t && onBar ? { x: t.clientX, y: t.clientY, at: e.timeStamp } : null;
      to = from;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (from && t) to = { x: t.clientX, y: t.clientY };
    };
    // the browser may take a moving finger for a scroll and cancel it: where it got to still counts
    const end = (e: TouchEvent) => {
      if (from && to) {
        const down = to.y - from.y;
        if (down >= SWIPE_PX && down > 1.5 * Math.abs(to.x - from.x) && e.timeStamp - from.at < SWIPE_MS) openBar();
      }
      from = null;
      to = null;
    };
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchmove', move, { passive: true });
    document.addEventListener('touchend', end, { passive: true });
    document.addEventListener('touchcancel', end, { passive: true });
    return () => {
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', end);
      document.removeEventListener('touchcancel', end);
    };
  }, []);
}

function run(c: Command): void {
  closeBar();
  c.run();
}

function BarPanel() {
  const app = useApp((s) => s);
  const layout = useLayout();
  const phone = isPhone(layout);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const state = { ...app, playhead: playheadTick(), phone };
  const rows = barRows(query, state, ACTIONS);
  const at = Math.max(0, Math.min(active, rows.length - 1));
  const hint = selectionHint(state);

  useEffect(() => {
    // a menu left open would keep the arrow keys; the keyboard comes back to where it was when the bar closes
    closeMenu();
    const was = document.activeElement;
    field.current?.focus({ preventScroll: true });
    return () => {
      if (was instanceof HTMLElement && was.isConnected) was.focus({ preventScroll: true });
    };
  }, []);

  // the chosen row stays in sight where the list scrolls (a phone on its side, with its keyboard up)
  // biome-ignore lint/correctness/useExhaustiveDependencies: run when the chosen row or the rows change, read from the page
  useEffect(() => {
    list.current?.querySelector('.hl')?.scrollIntoView({ block: 'nearest' });
  }, [at, query]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (rows.length) setActive((at + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === 'Enter') {
      const row = rows[at];
      if (row) run(row);
    } else if (e.key === 'Escape') closeBar();
    // the keyboard stays in the field (there's nothing else in the bar to reach)
    else if (e.key !== 'Tab') return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    // a press outside closes the bar and goes no further, as a menu's does
    <div className="bar-scrim" onPointerDown={(e) => e.target === e.currentTarget && closeBar()}>
      <div className="bar" role="dialog" aria-modal="true" aria-label="Commands">
        <div className="field">
          <Search aria-hidden="true" />
          <input
            ref={field}
            type="text"
            role="combobox"
            aria-label="Search commands"
            aria-expanded={rows.length > 0}
            aria-controls={`${id}-list`}
            aria-activedescendant={rows.length ? `${id}-${at}` : undefined}
            aria-autocomplete="list"
            // a phone held upright has room for the start of it beside the selection's words
            placeholder={
              layout === 'phone-portrait' ? 'Search commands, tracks…' : 'Search commands, tracks, markers, sounds'
            }
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
          {hint && <span className="ctx">{hint}</span>}
        </div>
        <div ref={list} className="list" role="listbox" id={`${id}-list`} aria-label="Commands">
          {rows.map((c, i) => (
            <div
              key={c.id}
              id={`${id}-${i}`}
              className={`item${i === at ? ' hl' : ''}`}
              role="option"
              aria-selected={i === at}
              tabIndex={-1}
              // the field keeps the keyboard (and a phone its keyboard) when a row is pressed
              onPointerDown={(e) => e.preventDefault()}
              onPointerMove={() => i !== at && setActive(i)}
              onClick={() => run(c)}
            >
              <span className="title">{c.title}</span>
              {c.keys ? <span className="hint keys">{c.keys}</span> : c.note && <span className="hint">{c.note}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Bar() {
  const open = useApp((s) => s.bar);
  useSwipeDown();
  return open ? <BarPanel /> : null;
}
