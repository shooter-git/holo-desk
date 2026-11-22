/**
 * The bar (Ctrl /, the slash button in the control bar, or a swipe down on a phone's top bar): the
 * studio's commands, tracks and markers, found by name, and the agent's conversation. On a desktop
 * it's one of the studio's menus with a field on top (the same glass, rows, blue highlight and key
 * hints), so nothing looks bolted on. While it's open the field has the keys: Up and Down choose, Enter
 * runs, Escape closes, and the studio's shortcuts wait. A press outside closes it too, and on a touch
 * screen a swipe up (ui/bar-swipe.ts). The song plays on.
 *
 * With the agent on for this device, the field takes requests too: what's typed can be sent ("Ask the
 * agent"), with files dropped or pasted on it (each a small chip), and under the field is the song's
 * last exchange, the request then the reply, with at most the button it needs (Stop, Done while it
 * listens, a permission, Copy brief). A screenshot or a photo it asks for is shown here before it
 * leaves. Nothing else in the studio shows the agent.
 *
 * On a phone or a tablet the same opens as the page (ui/TalkPage.tsx), with the song's whole
 * conversation: every opener only sets `bar`, and which one shows is the layout's (app/page-layout.ts).
 */
import { useEffect, useRef } from 'react';
import { useLayout } from '../app/layout.ts';
import { usesPage } from '../app/page-layout.ts';
import { closeBar, openBar, useApp } from '../app/store.ts';
import { useShownRoom, useSwipeUpToClose } from './bar-swipe.ts';
import { CommandField, CommandList, useCommandField } from './command-field.tsx';
import { TalkPage } from './TalkPage.tsx';
import { Talk } from './talk.tsx';

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

function BarPanel() {
  const f = useCommandField({ mode: 'bar' });
  const scrim = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  useShownRoom(scrim);
  useSwipeUpToClose(card);
  const { ex, project, talking, busy } = f;

  return (
    // a press outside closes the bar and goes no further, as a menu's does
    <div ref={scrim} className="bar-scrim" onPointerDown={(e) => e.target === e.currentTarget && closeBar()}>
      <div
        ref={card}
        className={`bar convo${f.dropping ? ' dropping' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Commands"
        onDragOver={f.onDragOver}
        onDragLeave={f.onDragLeave}
        onDrop={f.onDrop}
      >
        <CommandField f={f} />
        {f.note && (
          <div className="bar-note" role="status">
            {f.note}
          </div>
        )}
        {talking && ex && project && <Talk ex={ex} project={project} busy={busy} />}
        <CommandList f={f} />
      </div>
    </div>
  );
}

export function Bar() {
  const open = useApp((s) => s.bar);
  const page = usesPage(useLayout());
  useSwipeDown();
  if (!open) return null;
  return page ? <TalkPage /> : <BarPanel />;
}
