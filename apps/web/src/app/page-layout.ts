/**
 * Where the agent's conversation and the command search go, by the studio's layout (app/layout.ts). A
 * desktop has the bar, a card that drops from the top (Ctrl /). Everywhere else it's the page
 * (ui/TalkPage.tsx): on a phone held upright, a panel between the control bar and the transport; on a
 * phone on its side and on a tablet, a sheet down the right edge, with the studio live beside it.
 * A window the user opens (a plugin's, an instrument's) goes over it, beside the sheet where there's
 * room.
 */
import { type Layout, layoutNow } from './layout.ts';
import { type AppState, closeBar } from './store.ts';

/** Whether the page stands in for the bar here (everything but a desktop). */
export const usesPage = (layout: Layout): boolean => layout !== 'desktop';

/** Whether the page, open, covers the studio's panes: on a phone held upright (on a sheet it's beside them). */
export const pageCovers = (layout: Layout): boolean => layout === 'phone-portrait';

/**
 * Whether the studio's panes are out of sight under the page, so they needn't be drawn: open on a
 * phone held upright, and not held to see through it.
 */
export const paneCovered = (layout: Layout, open: boolean, peek: boolean): boolean =>
  open && !peek && pageCovers(layout);

/**
 * Whether a go or a command from the conversation (a reply's button) closes it, so what it did shows:
 * the bar does, and the page where it covers the studio. A sheet stays, with the studio beside it.
 */
export const closesForStudio = (layout: Layout): boolean => layout === 'desktop' || pageCovers(layout);

/** A reply's go or command ran: the bar, or the page where it covers the studio, closes so the studio shows. */
export function closeForStudio(layout: Layout = layoutNow()): void {
  if (closesForStudio(layout)) closeBar();
}

/** The studio's windows: a plugin's, an instrument's, a channel's stage. */
export type Windows = Pick<AppState, 'plugin' | 'synth' | 'stage'>;

/**
 * Whether a window was opened between two states of the studio (or another put in one's place): the
 * page goes under it, so what the user just opened shows whole (a phone's window is a sheet over the
 * whole width; a tablet's floats, and may reach under the sheet).
 */
export function windowOpened(was: Windows, now: Windows): boolean {
  return (
    (!!now.plugin && now.plugin !== was.plugin) ||
    (!!now.synth && now.synth !== was.synth) ||
    (!!now.stage && now.stage !== was.stage)
  );
}

/** The least room kept round a floating window. */
const WINDOW_MARGIN = 8;

/**
 * Where a floating window `width` wide opens across a screen `screen` wide: in the middle, or, with
 * the page's sheet open from `sheet` (its left edge) and room for it beside, in the middle of what the
 * sheet leaves, so neither covers the other. Without the room it opens in the middle, over the sheet.
 */
export function windowLeft(width: number, screen: number, sheet: number | null): number {
  if (sheet !== null && sheet >= width + 2 * WINDOW_MARGIN) return Math.round((sheet - width) / 2);
  return Math.max(WINDOW_MARGIN, screen / 2 - width / 2);
}
