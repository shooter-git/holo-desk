/**
 * The tray, on a phone (app/tray.ts): the dock of a reply that has been read (a few of its view's
 * controls), in one row of the studio's own layout, so it covers nothing: above the transport held
 * upright, at the foot of the content column on its side. Its controls do what the view's do. ^ opens
 * the page; ×, or a swipe across it either way, puts it away, and the next request takes it.
 *
 * Hidden, it's nothing at all: no listeners, timers or observers until it shows.
 */
import type { View } from '@holo/agent/view';
import { ChevronUp, X } from 'lucide-react';
import { type RefObject, useEffect, useRef } from 'react';
import { useAgent } from '../app/agent.ts';
import type { Layout } from '../app/layout.ts';
import { openBar, useApp } from '../app/store.ts';
import { dismiss, trayFor, useKept } from '../app/tray.ts';
import { DockView } from './AgentView.tsx';
import { along, closes, drawnToward, judgeToward, reducedMotion, speedToward, type Toward } from './bar-swipe.ts';
import { canScroll } from './page-swipe.ts';

/** How long the tray takes to come back, or to go on and away (the style's transitions, the same). */
const BACK_MS = 180;
const AWAY_MS = 180;

/** Whether what's under a finger, up to the tray, can still scroll the way it's going: then the swipe is the scroll's. */
function scrolls(target: EventTarget | null, tray: HTMLElement, toward: Toward): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== tray; el = el.parentElement)
    if (canScroll(el, toward)) return true;
  return false;
}

/**
 * A swipe across the tray, either way, puts it away: it goes with the finger, and let go far enough,
 * or flicked, it goes on out of sight; otherwise it comes back. The rules are the bar's and the page's
 * (ui/bar-swipe.ts): a finger held still first is a press, one going up or down is the browser's, one
 * that would scroll the row is the row's, and a tap is a tap.
 */
function useSwipeAway(ref: RefObject<HTMLElement | null>, slide: RefObject<HTMLElement | null>, job: string): void {
  useEffect(() => {
    const tray = ref.current;
    const row = slide.current;
    if (!tray || !row) return;
    let from: { x: number; y: number; at: number; target: EventTarget | null } | null = null;
    let toward: Toward | null = null;
    let moves: { x: number; y: number; at: number }[] = [];
    let timer = 0;
    // the click a swipe ends with goes nowhere (a swipe that began on a button doesn't press it)
    let quietUntil = 0;

    const place = (state: 'drag' | 'back' | 'away' | null, d = 0) => {
      if (state) row.dataset.swipe = state;
      else delete row.dataset.swipe;
      row.style.setProperty('--swipe-x', `${d}px`);
    };
    const back = () => {
      if (reducedMotion()) {
        place(null);
        return;
      }
      place('back');
      timer = window.setTimeout(() => place(null), BACK_MS);
    };
    const away = (side: Toward) => {
      if (reducedMotion()) {
        dismiss(job);
        return;
      }
      const w = tray.getBoundingClientRect().width;
      place('away', side === 'left' ? -w - 8 : w + 8);
      timer = window.setTimeout(() => dismiss(job), AWAY_MS);
    };

    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      // a second finger ends a swipe, and the tray comes back
      if (toward) back();
      toward = null;
      from = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY, at: e.timeStamp, target: e.target } : null;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!from || !t || e.touches.length !== 1) return;
      const dx = t.clientX - from.x;
      const dy = t.clientY - from.y;
      if (!toward) {
        const side: Toward = dx < 0 ? 'left' : 'right';
        const said = judgeToward(dx, dy, e.timeStamp - from.at, side);
        if (!said) return;
        if (said === 'pass' || scrolls(from.target, tray, side)) {
          from = null;
          return;
        }
        toward = side;
        moves = [{ x: from.x, y: from.y, at: from.at }];
        window.clearTimeout(timer);
      }
      if (e.cancelable) e.preventDefault();
      moves.push({ x: t.clientX, y: t.clientY, at: e.timeStamp });
      if (moves.length > 16) moves.shift();
      place('drag', drawnToward(dx, toward));
    };
    const end = (e: TouchEvent) => {
      const was = from;
      const side = toward;
      from = null;
      toward = null;
      if (!was || !side) return;
      quietUntil = performance.now() + 300;
      const last = moves[moves.length - 1];
      const gone = last ? along(last.x - was.x, last.y - was.y, side) : 0;
      // (a touch the browser took back is let go of where it was)
      if (e.type === 'touchend' && closes(gone, speedToward(moves, e.timeStamp, side))) away(side);
      else back();
    };
    const click = (e: MouseEvent) => {
      if (performance.now() >= quietUntil) return;
      e.preventDefault();
      e.stopPropagation();
    };

    tray.addEventListener('touchstart', start, { passive: true });
    tray.addEventListener('touchmove', move, { passive: false });
    tray.addEventListener('touchend', end, { passive: true });
    tray.addEventListener('touchcancel', end, { passive: true });
    tray.addEventListener('click', click, true);
    return () => {
      window.clearTimeout(timer);
      tray.removeEventListener('touchstart', start);
      tray.removeEventListener('touchmove', move);
      tray.removeEventListener('touchend', end);
      tray.removeEventListener('touchcancel', end);
      tray.removeEventListener('click', click, true);
    };
  }, [ref, slide, job]);
}

function TrayRow({ job, view }: { job: string; view: View }) {
  const tray = useRef<HTMLElement>(null);
  const slide = useRef<HTMLDivElement>(null);
  useSwipeAway(tray, slide, job);
  return (
    <section ref={tray} className="tray convo" aria-label="The agent's reply, at hand">
      <div ref={slide} className="tray-slide">
        <div className="tray-row">
          {/* (nothing works on the song while the tray shows: it's gone for a request) */}
          <DockView view={view} job={job} busy={false} />
        </div>
        <button
          type="button"
          className="btn ghost icon"
          title="Put this away"
          aria-label="Put this away"
          onClick={() => dismiss(job)}
        >
          <X />
        </button>
        <button
          type="button"
          className="btn ghost icon"
          title="Open the conversation"
          aria-label="Open the conversation"
          onClick={() => openBar()}
        >
          <ChevronUp />
        </button>
      </div>
    </section>
  );
}

/** The tray where it goes in a phone's layout: nothing unless it shows. */
export function Tray({ layout }: { layout: Layout }) {
  const project = useApp((s) => s.project?.id ?? null);
  const open = useApp((s) => s.bar);
  const read = useKept();
  const ex = trayFor(
    useAgent((a) => a),
    project,
    read,
    layout,
    open,
  );
  if (!ex?.job || !ex.view) return null;
  return <TrayRow key={ex.job} job={ex.job} view={ex.view} />;
}
