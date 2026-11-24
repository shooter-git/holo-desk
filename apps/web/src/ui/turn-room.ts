/**
 * The room a short conversation leaves on the page (ui/TalkPage.tsx) goes to its earlier turns: a turn
 * whose line cuts its request or its reply short shows more lines of them, the turn nearest the newest
 * first, for as long as the conversation still fits the page without scrolling. A conversation longer
 * than the page keeps every earlier turn to a line, as do turns that already say all they have on one.
 *
 * What's measured is the page as it is (the thread's height, each line's words), never the device; the
 * CSS draws them (.talk-row[data-roomy], --you-lines and --said-lines, styles/app.css).
 */
import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';

/** The most lines a turn's request, and its reply's start, are given. */
export const YOU_MOST = 3;
export const SAID_MOST = 6;
/** How many earlier turns are looked at, from the newest back: more than a page with room to spare holds. */
const TURNS_MOST = 8;

/**
 * An earlier turn as measured: how tall it is as a line (`fold`), how many lines its request and its
 * reply's start take when they're given the most (`you`, `said`: 0 for a turn with no reply to show),
 * how tall a line of each is, and `rest`: what an opened-out turn has besides its lines (its padding,
 * and the gap between the two).
 */
export interface TurnSize {
  fold: number;
  rest: number;
  you: number;
  said: number;
  youLine: number;
  saidLine: number;
}

/** The lines a turn is given: of its request, and of its reply's start. */
export interface TurnLines {
  you: number;
  said: number;
}

/**
 * Share `spare` px among turns, the nearest the newest first: each is opened out (its request over its
 * reply's start, a line of each), then given lines of the reply until it's whole, then of the request,
 * while there's room. null for a turn left as a line: the first there's no room to open out, and every
 * one after it.
 */
export function shareRoom(turns: readonly TurnSize[], spare: number): (TurnLines | null)[] {
  const out: (TurnLines | null)[] = [];
  let left = spare;
  let full = false;
  for (const t of turns) {
    const height = (you: number, said: number) => t.rest + you * t.youLine + said * t.saidLine;
    let you = Math.min(1, t.you);
    let said = Math.min(1, t.said);
    if (full || !(you + said) || height(you, said) - t.fold > left) {
      full = true;
      out.push(null);
      continue;
    }
    while (said < t.said && height(you, said + 1) - t.fold <= left) said++;
    while (you < t.you && height(you + 1, said) - t.fold <= left) you++;
    left -= Math.max(0, height(you, said) - t.fold);
    out.push({ you, said });
  }
  return out;
}

const ROWS = '.talk-turn:not(.open) > .talk-row';

/** A row back to a line. */
function fold(row: HTMLElement): void {
  row.removeAttribute('data-roomy');
  row.style.removeProperty('--you-lines');
  row.style.removeProperty('--said-lines');
}

/**
 * What the thread holds that isn't its earlier turns' lines, with the room it has and what those lines
 * say: when none of it has changed, the lines are as they should be.
 */
function stateOf(thread: HTMLElement, body: HTMLElement, rows: readonly HTMLElement[]): string {
  let lines = 0;
  let words = '';
  for (const row of rows) {
    lines += row.offsetHeight;
    words += `${row.textContent?.length ?? 0},`;
  }
  return `${thread.clientWidth}x${thread.clientHeight}:${body.offsetHeight - lines}:${words}`;
}

/**
 * Give the earlier turns of a thread the room it has to spare (none while `on` is false): they're
 * folded to a line each and measured, those cut short are opened out whole and measured again (two
 * layouts, neither drawn), and then each gets its lines. Returns the state it left the thread in, and
 * does nothing when the thread is still in the state `was`.
 */
export function fitTurns(thread: HTMLElement, on: boolean, was = ''): string {
  const body = thread.firstElementChild as HTMLElement | null;
  if (!body) return '';
  const rows = [...thread.querySelectorAll<HTMLElement>(ROWS)].reverse();
  // (read again once it's done: heights are whole pixels here, so a line opened out can move it by one)
  const state = () => `${on ? '' : 'off:'}${stateOf(thread, body, rows)}`;
  if (state() === was) return was;
  for (const row of thread.querySelectorAll<HTMLElement>('.talk-row[data-roomy]')) fold(row);
  if (!on || !rows.length) return state();
  const spare = thread.clientHeight - body.offsetHeight;
  if (spare < 1) return state();
  // the turns a line cuts short, nearest the newest first: up to the first that says all it has
  const cut: { row: HTMLElement; you: HTMLElement; said: HTMLElement | null; fold: number }[] = [];
  for (const row of rows.slice(0, TURNS_MOST)) {
    const you = row.querySelector<HTMLElement>('.you');
    const said = row.querySelector<HTMLElement>('.said');
    if (!you) continue;
    const short = you.scrollWidth > you.clientWidth + 1 || (said ? said.scrollWidth > said.clientWidth + 1 : false);
    if (short) cut.push({ row, you, said, fold: row.getBoundingClientRect().height });
  }
  if (!cut.length) return state();
  for (const { row } of cut) {
    row.setAttribute('data-roomy', '');
    row.style.setProperty('--you-lines', String(YOU_MOST));
    row.style.setProperty('--said-lines', String(SAID_MOST));
  }
  const sizes = cut.map(({ row, you, said, fold }): TurnSize => {
    const lineOf = (el: HTMLElement) => Number.parseFloat(getComputedStyle(el).lineHeight) || 1;
    const youLine = lineOf(you);
    const saidLine = said ? lineOf(said) : 1;
    const youHigh = you.getBoundingClientRect().height;
    const saidHigh = said?.textContent ? said.getBoundingClientRect().height : 0;
    return {
      fold,
      rest: row.getBoundingClientRect().height - youHigh - saidHigh,
      you: Math.max(1, Math.round(youHigh / youLine)),
      said: Math.round(saidHigh / saidLine),
      youLine,
      saidLine,
    };
  });
  shareRoom(sizes, spare).forEach((lines, i) => {
    const row = cut[i]?.row;
    if (!row) return;
    if (!lines) fold(row);
    else {
      row.style.setProperty('--you-lines', String(lines.you));
      row.style.setProperty('--said-lines', String(lines.said));
    }
  });
  // (a line of words is a fraction of a pixel tall: should that have put it a hair over, the last
  // turn opened out goes back to a line)
  for (let i = cut.length - 1; i >= 0 && thread.scrollHeight > thread.clientHeight; i--) {
    const row = cut[i]?.row;
    if (row?.hasAttribute('data-roomy')) fold(row);
  }
  return state();
}

/**
 * Keep a thread's earlier turns in the room it has: as the page renders (a turn comes, opens or
 * closes), as the thread or what it holds changes size (a reply growing, the keyboard, a phone
 * turned), and once a font still loading has come. Each time it's measured only when something it
 * depends on has changed.
 */
export function useTurnRoom(thread: RefObject<HTMLElement | null>, on: boolean): void {
  const was = useRef('');
  // (after every render: what a render changed is read from the page)
  useLayoutEffect(() => {
    if (thread.current) was.current = fitTurns(thread.current, on, was.current);
  });
  useEffect(() => {
    const el = thread.current;
    const body = el?.firstElementChild;
    if (!el) return;
    let frame = 0;
    // (in the next frame: laid out in the observer's own call, the new heights would be ones it misses)
    const again = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        was.current = fitTurns(el, on, was.current);
      });
    };
    const watch = new ResizeObserver(again);
    watch.observe(el);
    if (body) watch.observe(body);
    const fonts = () => {
      was.current = '';
      again();
    };
    document.fonts?.addEventListener('loadingdone', fonts);
    return () => {
      watch.disconnect();
      cancelAnimationFrame(frame);
      document.fonts?.removeEventListener('loadingdone', fonts);
    };
  }, [thread, on]);
}
