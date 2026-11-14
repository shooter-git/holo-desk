/**
 * The Notes view's clipboard (AudioNotes.tsx): a note copied (Ctrl+C, the menu's Copy) to paste its
 * sound onto others (Ctrl+V, `paste`) or its edits (Ctrl+Shift+V, `copy-settings`), in its own region
 * or another. It's in memory, this tab's own, and holds the note as its region keeps it: where its
 * sound is in the recording, its length, its pitch and unvoiced start as found, and its edits, with the
 * recording it's from. The edits take it as their `source`, so it pastes the same wherever it goes.
 *
 * With several notes selected, the first is copied (one sound to paste; one note's edits). A sound
 * pastes within its own recording only: between recordings comes in a later version. Edits paste onto
 * any notes.
 */
import type { AudioNote, AudioNotes } from '@holo/session';

export interface CopiedNote {
  /** The recording it's from (its file's id), the region, and its number there (from 1). */
  file: string;
  region: string;
  number: number;
  note: AudioNote;
  /** How many notes were selected when it was copied (the first of them is this one). */
  of: number;
}

let held: CopiedNote | null = null;

/** The note last copied, or null. */
export const copiedNote = (): CopiedNote | null => held;

/** Nothing copied (a new song, a test). */
export function clearCopied(): void {
  held = null;
}

/** The first of the notes selected in a region, copied (null when none of them is a note there). */
export function copyNotes(
  file: string,
  region: string,
  notes: AudioNotes,
  selected: readonly number[],
): CopiedNote | null {
  const chosen = [...new Set(selected)].filter((i) => notes.n[i]).sort((a, b) => a - b);
  const first = chosen[0];
  if (first === undefined) return null;
  held = { file, region, number: first + 1, note: { ...(notes.n[first] as AudioNote) }, of: chosen.length };
  return held;
}

/** What the bar says once it's copied: "Copied note 5" ("…, the first of 3 selected"). */
export function copiedText(c: CopiedNote): string {
  return `Copied note ${c.number}${c.of > 1 ? `, the first of ${c.of} selected` : ''}`;
}

/** Why the note copied can't give its sound to notes of a recording (its file's id): nothing copied, or another recording's; null when it can. */
export function pasteRefusal(c: CopiedNote | null, file: string): string | null {
  if (!c) return 'Copy a note first (Ctrl+C)';
  if (c.file !== file)
    return 'The note copied is from another recording: a sound pastes within its own recording (between recordings comes later)';
  return null;
}

/** Why the note copied can't give its edits: nothing copied; null when it can (onto any notes). */
export function settingsRefusal(c: CopiedNote | null): string | null {
  return c ? null : 'Copy a note first (Ctrl+C)';
}
