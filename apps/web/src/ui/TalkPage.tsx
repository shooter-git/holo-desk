/**
 * The page: the bar, on a phone or a tablet (app/page-layout.ts). It holds the open song's whole
 * conversation with the agent, from its top down (one longer than the page is at its newest turn, at
 * the foot beside the field), and the command search: what's typed finds the studio's commands, tracks
 * and markers in a list over the field, as the bar does.
 *
 * Where it goes:
 *  - a phone held upright: a solid panel between the control bar and the transport, which stay in
 *    sight and in reach (the panes under it rest, unseen: App.tsx);
 *  - a phone on its side: a sheet down the right edge, under the transport row, the studio live beside
 *    it; while typing with the keyboard up it widens across the column, over the keyboard, and the
 *    newest turn folds to a line;
 *  - a tablet: a sheet a third of the width, under the control bar, beside the studio;
 *  - a desktop with the agent on: a dock down the right side, under the control bar. It slides in and
 *    out, and where the window is wide enough the studio gives it the room, so nothing is under it
 *    (styles/app.css). It stays out while the studio is worked in: its field has the keys only while
 *    they're in it (app/keys.ts).
 *
 * Earlier turns are a line each, opened with a tap; the newest is whole. A conversation shorter than
 * the page gives the room it leaves to its earlier turns, which show more lines of themselves
 * (ui/turn-room.ts). While a request works its turn says what it's on, how long it has worked, and Stop. A window opened after it (a plugin's, an
 * instrument's) goes over it, whole: on a phone it's a sheet over everything, on a tablet it floats,
 * beside the sheet where there's room (ui/window.tsx). A press on the page brings it back over.
 *
 * Its header is a grip on a phone held upright (the song's name is in the control bar over it, and the
 * Commands button there closes it), with Done only while the keyboard is up, when the control bar may
 * be out of sight; a sheet's header is Done; a dock's is its name and a button that slides it in. A
 * swipe closes it too: down, from the header or from anywhere on a page that has nothing above to
 * scroll to (held upright), or to the right (a sheet). Held still, the header lets the studio show
 * through (ui/page-swipe.ts; not a dock's, which has nothing under it). A tab closes it on a phone held
 * upright, and a reply's go or command does where it covers the studio. The song plays on.
 */
import { ChevronRight, PanelRightClose } from 'lucide-react';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { conversation, type Exchange, loadThread, useAgent } from '../app/agent.ts';
import { type Layout, useLayout } from '../app/layout.ts';
import { useSeenOnHost } from '../app/notify.ts';
import { pageCovers, windowOpened } from '../app/page-layout.ts';
import { closeBar, store, useApp } from '../app/store.ts';
import { markSeen } from '../app/tray.ts';
import { atEnd, useShownRoom } from './bar-swipe.ts';
import { CommandField, CommandList, useCommandField } from './command-field.tsx';
import { useHoldToSeeThrough, useSwipeToClose } from './page-swipe.ts';
import { TalkBody } from './talk.tsx';
import { useTurnRoom } from './turn-room.ts';

/**
 * Where the studio's parts the page keeps clear of are, as the room's --studio-top (the control bar's
 * foot, or the transport row's on a phone on its side), --studio-bottom (the transport's top, from the
 * foot of the screen, on a phone held upright) and --studio-left (the content column's left edge, on
 * a phone on its side): measured while it's open, and again as they or the window change. Over Scan,
 * which covers them all, it keeps clear of Scan's header (where the Commands button is) instead.
 */
function usePageRoom(room: RefObject<HTMLElement | null>, layout: Layout, scan: boolean): void {
  useLayoutEffect(() => {
    const el = room.current;
    if (!el) return;
    const sideways = layout === 'phone-landscape';
    // what it keeps clear of, found again whenever Scan's window changes (its header comes once the
    // scan has loaded, and a new scan's goes when it's saved and the review takes its place)
    const parts = () => {
      const over = scan ? document.querySelector('.scan-window .scan-bar') : null;
      return {
        top: over ?? document.querySelector(sideways ? '.phone-transport.top' : '.app > .control-bar'),
        dock: !over && layout === 'phone-portrait' ? document.querySelector('.phone-dock .phone-transport') : null,
        column: !over && sideways ? document.querySelector('.phone-main') : null,
      };
    };
    let at = parts();
    const fit = () => {
      const { top, dock, column } = at;
      // (rounded away from what it keeps clear of: not a pixel over the control bar or the transport)
      const px = (n: number) => `${Math.max(0, Math.ceil(n - 0.01))}px`;
      el.style.setProperty('--studio-top', px(top?.getBoundingClientRect().bottom ?? 0));
      el.style.setProperty('--studio-bottom', px(dock ? window.innerHeight - dock.getBoundingClientRect().top : 0));
      el.style.setProperty('--studio-left', px(column?.getBoundingClientRect().left ?? 0));
    };
    const watch = new ResizeObserver(fit);
    const observe = () => {
      watch.disconnect();
      for (const part of [at.top, at.dock, at.column]) if (part) watch.observe(part);
      fit();
    };
    observe();
    // (only while Scan is up: what's added and taken away under the page then is its window's)
    const changes = scan
      ? new MutationObserver(() => {
          const now = parts();
          if (now.top === at.top && now.dock === at.dock && now.column === at.column) return;
          at = now;
          observe();
        })
      : null;
    changes?.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', fit);
    return () => {
      watch.disconnect();
      changes?.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [room, layout, scan]);
}

/**
 * Whether the page is under the studio's windows: a window opened since it opened, or pressed since,
 * shows whole over it (what the user did last is on top); a press on the page, or the keyboard going
 * into it, brings it back over them.
 */
function useBelowWindows(page: RefObject<HTMLElement | null>): boolean {
  const [below, setBelow] = useState(false);
  useEffect(() => {
    let was = store.get();
    const off = store.subscribe(() => {
      const now = store.get();
      const opened = windowOpened(was, now);
      was = now;
      if (opened) setBelow(true);
    });
    const down = (e: PointerEvent) => {
      const at = e.target as Element | null;
      if (at?.closest?.('.plugin-window, .sheet-scrim')) setBelow(true);
      else if (at?.closest?.('.talk-page')) setBelow(false);
    };
    const into = () => setBelow(false);
    const el = page.current;
    window.addEventListener('pointerdown', down, true);
    el?.addEventListener('focusin', into);
    return () => {
      off();
      window.removeEventListener('pointerdown', down, true);
      el?.removeEventListener('focusin', into);
    };
  }, [page]);
  return below;
}

/** How much room a keyboard takes before it counts as up (less is a bar of the browser's coming and going). */
const KEYBOARD_PX = 100;

/**
 * Whether a keyboard on the screen is up: it covers the foot of the page (iOS: what shows of it gets
 * shorter), or makes the page shorter than it was as the layout came (Android). A keyboard of keys, or
 * a field focused with none come up, isn't one.
 */
function useKeyboardUp(layout: Layout): boolean {
  const [up, setUp] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured afresh as the layout changes (a phone turned)
  useEffect(() => {
    const view = window.visualViewport;
    const tall = window.innerHeight;
    const fit = () =>
      setUp(
        window.innerHeight - (view?.height ?? window.innerHeight) > KEYBOARD_PX ||
          tall - window.innerHeight > KEYBOARD_PX,
      );
    fit();
    view?.addEventListener('resize', fit);
    window.addEventListener('resize', fit);
    return () => {
      view?.removeEventListener('resize', fit);
      window.removeEventListener('resize', fit);
    };
  }, [layout]);
  return up;
}

/** A turn's key in the thread: its job, or (on its way, or turned down) when it was asked. */
const keyOf = (ex: Exchange) => ex.job ?? `asked-${ex.at}`;

/** What an earlier turn's line says after its request: the reply's start, or how it stands. */
function after(ex: Exchange): string {
  if (ex.working) return ex.listening ? 'Listening' : (ex.line ?? 'Working on it');
  if (ex.permission) return ex.permission.detail || 'Waiting for your OK';
  return ex.reply?.split('\n')[0] ?? ex.label ?? '';
}

/** An earlier turn: a line (the request, then the start of the reply), opened with a tap to show it whole. */
function Turn({
  ex,
  open,
  onToggle,
  project,
  busy,
}: {
  ex: Exchange;
  open: boolean;
  onToggle: () => void;
  project: string;
  busy: boolean;
}) {
  return (
    <div className={`talk-turn${open ? ' open' : ''}`} data-turn={ex.job ?? undefined}>
      <button type="button" className="talk-row" aria-expanded={open} title={ex.label ?? undefined} onClick={onToggle}>
        <ChevronRight className="chev" aria-hidden="true" />
        <span className="you">{ex.request}</span>
        {!open && <span className="said">{after(ex)}</span>}
      </button>
      {/* (what the reply shows is drawn only for a turn that's open) */}
      {open && (
        <div className="talk">
          <TalkBody ex={ex} project={project} busy={busy} elapsed />
        </div>
      )}
    </div>
  );
}

/** `docks`: it's a desktop's dock; `leaving`, that dock closed and sliding in (it takes nothing meanwhile). */
export function TalkPage({ docks = false, leaving = false }: { docks?: boolean; leaving?: boolean }) {
  const layout = useLayout();
  const f = useCommandField({ mode: 'page' });
  const talk = conversation(
    useAgent((a) => a),
    f.project,
  );
  const turn = useApp((s) => s.barTurn);
  // a dialog over the studio is over the page too, and so is Print: it takes no keys or taps from behind
  // them (Scan is under it: the page opens over the review, from the Commands button in its header)
  const behind = useApp((s) => s.dialog !== null || s.printView !== null);
  const room = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const below = useBelowWindows(page);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set(turn ? [turn] : []));
  const covers = pageCovers(layout);
  const scanOpen = useApp((s) => s.scanView !== null);
  const sideways = layout === 'phone-landscape';
  // typing on a phone on its side, with the keyboard up: across the column, over the keyboard
  const keyboard = useKeyboardUp(layout);
  const wide = sideways && focused && keyboard;
  useShownRoom(room);
  usePageRoom(room, layout, scanOpen);
  useSwipeToClose(page, page, covers ? 'down' : 'right');
  useHoldToSeeThrough(head, page, !docks);
  // the room a short conversation leaves goes to its earlier turns (not across a phone on its side,
  // typing: the newest turn is a line there to leave the room to the field)
  useTurnRoom(thread, !wide);

  const { project, busy } = f;
  const newest = talk[talk.length - 1];
  const earlier = talk.slice(0, -1);
  const newestKey = newest ? keyOf(newest) : '';
  // seen as it opens, and as a reply ends while it's open: the badge of notices counts it no more
  useSeenOnHost(project, newest && !newest.working ? newestKey : null);

  // the newest reply, shown here with a dock: once the page closes a phone keeps that row at hand
  const docked = newest && !newest.working && newest.view?.dock?.length ? newest.job : null;
  useEffect(() => {
    if (docked) markSeen(docked);
  }, [docked]);

  // the song changed while it's open (from the Songs dialog over it): its conversation is read
  const firstSong = useRef(project);
  useEffect(() => {
    if (project && project !== firstSong.current) {
      firstSong.current = project;
      setOpened(new Set());
      void loadThread(project);
    }
  }, [project]);

  // opened for a turn: that turn shows open
  useEffect(() => {
    if (turn) setOpened((was) => (was.has(turn) ? was : new Set([...was, turn])));
  }, [turn]);

  // a thread longer than the page keeps to its newest turn while it's at the foot (a reply growing, a
  // view drawn, the keyboard coming up), and opens there; scrolled back, it stays where it's put
  const stuck = useRef(!turn);
  useEffect(() => {
    const el = thread.current;
    const body = el?.firstElementChild;
    if (!el) return;
    const keep = () => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
    };
    const scrolled = () => {
      stuck.current = atEnd(el);
    };
    const watch = new ResizeObserver(keep);
    watch.observe(el);
    if (body) watch.observe(body);
    el.addEventListener('scroll', scrolled, { passive: true });
    return () => {
      watch.disconnect();
      el.removeEventListener('scroll', scrolled);
    };
  }, []);
  // a new turn (a request just sent): to the foot
  // biome-ignore lint/correctness/useExhaustiveDependencies: run as the newest turn changes, read from the page
  useLayoutEffect(() => {
    const el = thread.current;
    if (!el || (turn && !stuck.current)) return;
    stuck.current = true;
    el.scrollTop = el.scrollHeight;
  }, [newestKey]);
  // the turn it was opened for, in sight (once the conversation is read, when it wasn't yet)
  // biome-ignore lint/correctness/useExhaustiveDependencies: run again as turns come, read from the page
  useLayoutEffect(() => {
    if (!turn) return;
    const el = thread.current?.querySelector(`[data-turn="${CSS.escape(turn)}"]`);
    if (!el) return;
    stuck.current = false;
    el.scrollIntoView({ block: 'start' });
  }, [turn, talk.length]);

  const toggle = (key: string) =>
    setOpened((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div ref={room} className="talk-room" inert={behind || leaving} data-below={below ? '' : undefined}>
      <section
        ref={page}
        className={`talk-page convo${f.dropping ? ' dropping' : ''}`}
        role="dialog"
        aria-modal={covers ? 'true' : undefined}
        aria-label="Commands"
        data-wide={wide ? '' : undefined}
        data-leaving={leaving ? '' : undefined}
        onDragOver={f.onDragOver}
        onDragLeave={f.onDragLeave}
        onDrop={f.onDrop}
      >
        <div ref={head} className="talk-head">
          {covers && <span className="talk-grip" aria-hidden="true" />}
          {/* (held upright it shows only with the keyboard up, or focused from a keyboard of keys: styles/app.css) */}
          {docks ? (
            <>
              <span className="title">HO[LO]-agent</span>
              <button
                type="button"
                className="btn icon ghost talk-done"
                title="Close (Ctrl /)"
                aria-label="Close"
                onClick={closeBar}
              >
                <PanelRightClose />
              </button>
            </>
          ) : (
            <button type="button" className="btn ghost talk-done" onClick={closeBar}>
              Done
            </button>
          )}
        </div>
        <div ref={thread} className="talk-thread">
          <div className="talk-body">
            {!newest || !project ? (
              !f.typed && (
                <p className="talk-empty">
                  {f.on ? 'Ask the agent about this song, or find a command.' : 'Find a command, a track or a marker.'}
                </p>
              )
            ) : wide ? (
              <Turn ex={newest} open={false} onToggle={() => toggle(newestKey)} project={project} busy={busy} />
            ) : (
              <>
                {earlier.length > 0 && <div className="talk-earlier">Earlier in this song</div>}
                {earlier.map((ex) => {
                  const key = keyOf(ex);
                  return (
                    <Turn
                      key={key}
                      ex={ex}
                      open={opened.has(key)}
                      onToggle={() => toggle(key)}
                      project={project}
                      busy={busy}
                    />
                  );
                })}
                <div className="talk newest" aria-live="polite" data-turn={newest.job ?? undefined}>
                  <TalkBody ex={newest} project={project} busy={busy} elapsed />
                </div>
              </>
            )}
          </div>
        </div>
        {f.note && (
          <div className="bar-note" role="status">
            {f.note}
          </div>
        )}
        {f.rows.length > 0 && <CommandList f={f} upward />}
        <CommandField f={f} multiline onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} />
      </section>
    </div>
  );
}
