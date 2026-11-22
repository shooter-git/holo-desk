/**
 * Where the agent's conversation and the command search go, by the studio's layout (app/layout.ts). A
 * desktop has the bar, a card that drops from the top (Ctrl /). Everywhere else it's the page
 * (ui/TalkPage.tsx): on a phone held upright, a panel between the control bar and the transport; on a
 * phone on its side and on a tablet, a sheet down the right edge, with the studio live beside it.
 */
import { type Layout, layoutNow } from './layout.ts';
import { closeBar } from './store.ts';

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
