/**
 * The page: the bar, on a phone or a tablet (app/page-layout.ts). It holds the open song's whole
 * conversation with the agent, newest at the bottom beside the field, and the command search: what's
 * typed finds the studio's commands, tracks and markers in a list over the field, as the bar does.
 *
 * Where it goes:
 *  - a phone held upright: a solid panel between the control bar and the transport, which stay in
 *    sight and in reach (the panes under it rest, unseen: App.tsx);
 *  - a phone on its side: a sheet down the right edge, under the transport row, the studio live beside
 *    it; while typing it widens across the column, over the keyboard, and the newest turn folds to a
 *    line;
 *  - a tablet: a sheet a third of the width, under the control bar, beside the studio.
 *
 * Earlier turns are a line each, opened with a tap; the newest is whole. While a request works its
 * turn says what it's on, how long it has worked, and Stop. Done closes it, and so does a swipe down
 * from its header (held upright) or to the right (a sheet); held still, the header lets the studio
 * show through (ui/page-swipe.ts). A tab closes it on a phone held upright, and a reply's go or command
 * does where it covers the studio. The song plays on.
 */
import { ChevronRight } from 'lucide-react';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { conversation, type Exchange, loadThread, useAgent } from '../app/agent.ts';
import { type Layout, useLayout } from '../app/layout.ts';
import { pageCovers } from '../app/page-layout.ts';
import { closeBar, useApp } from '../app/store.ts';
import { atEnd, useShownRoom } from './bar-swipe.ts';
import { CommandField, CommandList, useCommandField } from './command-field.tsx';
import { useHoldToSeeThrough, useSwipeToClose } from './page-swipe.ts';
import { TalkBody } from './talk.tsx';

/**
 * Where the studio's parts the page keeps clear of are, as the room's --studio-top (the control bar's
 * foot, or the transport row's on a phone on its side), --studio-bottom (the transport's top, from the
 * foot of the screen, on a phone held upright) and --studio-left (the content column's left edge, on
 * a phone on its side): measured while it's open, and again as they or the window change.
 */
function usePageRoom(room: RefObject<HTMLElement | null>, layout: Layout): void {
  useLayoutEffect(() => {
    const el = room.current;
    if (!el) return;
    const sideways = layout === 'phone-landscape';
    const top = document.querySelector(sideways ? '.phone-transport.top' : '.app > .control-bar');
    const dock = layout === 'phone-portrait' ? document.querySelector('.phone-dock .phone-transport') : null;
    const column = sideways ? document.querySelector('.phone-main') : null;
    const fit = () => {
      // (rounded away from what it keeps clear of: not a pixel over the control bar or the transport)
      const px = (n: number) => `${Math.max(0, Math.ceil(n - 0.01))}px`;
      el.style.setProperty('--studio-top', px(top?.getBoundingClientRect().bottom ?? 0));
      el.style.setProperty('--studio-bottom', px(dock ? window.innerHeight - dock.getBoundingClientRect().top : 0));
      el.style.setProperty('--studio-left', px(column?.getBoundingClientRect().left ?? 0));
    };
    fit();
    const watch = new ResizeObserver(fit);
    for (const part of [top, dock, column]) if (part) watch.observe(part);
    window.addEventListener('resize', fit);
    return () => {
      watch.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [room, layout]);
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

export function TalkPage() {
  const layout = useLayout();
  const f = useCommandField({ mode: 'page' });
  const talk = conversation(
    useAgent((a) => a),
    f.project,
  );
  const title = useApp((s) => s.project?.title ?? '');
  const turn = useApp((s) => s.barTurn);
  // a dialog over the studio is over the page too: it takes no keys or taps from behind it
  const under = useApp((s) => s.dialog !== null || s.printView !== null || s.scanView !== null);
  const room = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set(turn ? [turn] : []));
  const covers = pageCovers(layout);
  const sideways = layout === 'phone-landscape';
  // typing on a phone on its side: across the column, over the keyboard
  const wide = sideways && focused;
  useShownRoom(room);
  usePageRoom(room, layout);
  useSwipeToClose(covers ? head : page, page, covers ? 'down' : 'right');
  useHoldToSeeThrough(head, page);

  const { project, busy } = f;
  const newest = talk[talk.length - 1];
  const earlier = talk.slice(0, -1);
  const newestKey = newest ? keyOf(newest) : '';

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

  // the thread keeps to its newest turn while it's at the foot (a reply growing, a view drawn, the
  // keyboard coming up), and opens there; scrolled back, it stays where it's put
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
    <div ref={room} className="talk-room" inert={under}>
      <section
        ref={page}
        className={`talk-page convo${f.dropping ? ' dropping' : ''}`}
        role="dialog"
        aria-modal={covers ? 'true' : undefined}
        aria-label="Commands"
        data-wide={wide ? '' : undefined}
        onDragOver={f.onDragOver}
        onDragLeave={f.onDragLeave}
        onDrop={f.onDrop}
      >
        <div ref={head} className="talk-head">
          {covers && <span className="talk-grip" aria-hidden="true" />}
          <span className="talk-song">{title}</span>
          <button type="button" className="btn ghost" onClick={closeBar}>
            Done
          </button>
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
