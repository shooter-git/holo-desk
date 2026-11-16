/**
 * The Notes view's clipboard (note-clipboard.ts): the first note selected copied, with the recording
 * it's from, and pasted as the edits take it (`source`): its sound within its recording only, its
 * edits onto any notes. Synthetic notes only.
 */
import { type AudioNote, type AudioNotes, noteEdit, parseAudioNotes } from '@holo/session';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearCopied,
  copiedNote,
  copiedText,
  copyNotes,
  pasteRefusal,
  settingsRefusal,
} from '../src/ui/note-clipboard.ts';

/** A line: E4 tuned onto its semitone and quieter, G4 with a consonant, a breath, A4. */
const notes = parseAudioNotes({
  mode: 'mono',
  v: 1,
  n: [
    { t: 1, d: 0.5, p: 64.2, to: 64, g: -4 },
    { t: 1.6, d: 0.4, p: 67, u: 0.04 },
    { t: 2.2, d: 0.2, p: null },
    { t: 2.6, d: 0.6, p: 69.3 },
  ],
}) as AudioNotes;

beforeEach(() => clearCopied());

describe('the Notes view’s clipboard', () => {
  it('copies the first note selected, with its recording, region and number, and says so', () => {
    expect(copiedNote()).toBeNull();
    const c = copyNotes('aud_take', 'rgn_a', notes, [3, 1]);
    expect(c).toEqual({ file: 'aud_take', region: 'rgn_a', number: 2, note: notes.n[1], of: 2 });
    expect(copiedNote()).toBe(c);
    expect(copiedText(c as NonNullable<typeof c>)).toBe('Copied note 2, the first of 2 selected');
    expect(copiedText(copyNotes('aud_take', 'rgn_a', notes, [0]) as NonNullable<typeof c>)).toBe('Copied note 1');
    // (a copy of the note, not the region's own object)
    expect(copiedNote()?.note).not.toBe(notes.n[0]);
    // nothing selected that's a note: nothing copied, the clipboard kept
    expect(copyNotes('aud_take', 'rgn_a', notes, [9])).toBeNull();
    expect(copiedNote()?.number).toBe(1);
  });

  it('pastes a sound within its own recording only, and edits onto any notes', () => {
    expect(pasteRefusal(null, 'aud_take')).toMatch(/^Copy a note first/);
    expect(settingsRefusal(null)).toMatch(/^Copy a note first/);
    const c = copyNotes('aud_take', 'rgn_a', notes, [1]);
    expect(pasteRefusal(c, 'aud_take')).toBeNull();
    expect(pasteRefusal(c, 'aud_other')).toMatch(/another recording/);
    expect(settingsRefusal(c)).toBeNull();
  });

  it('gives the edits the note itself, so it pastes the same in another region of the recording', () => {
    const c = copyNotes('aud_take', 'rgn_a', notes, [1]) as NonNullable<ReturnType<typeof copiedNote>>;
    // another region's notes: a later stretch of the same recording
    const there = parseAudioNotes({
      mode: 'mono',
      v: 1,
      n: [
        { t: 8, d: 0.3, p: 60.1, to: 60 },
        { t: 9, d: 0.5, p: 62 },
      ],
    }) as AudioNotes;
    const sound = noteEdit('paste')?.apply(there, [0], {}, { source: c.note }) as AudioNotes;
    // (tuned onto its semitone, it plays the G4 pasted on its own: already on it)
    expect(sound.n[0]).toEqual({ t: 8, d: 0.3, p: 67, u: 0.04, s: 1.6 } satisfies AudioNote);
    const first = copyNotes('aud_take', 'rgn_a', notes, [0]) as NonNullable<ReturnType<typeof copiedNote>>;
    const settings = noteEdit('copy-settings')?.apply(there, [1], {}, { source: first.note }) as AudioNotes;
    expect(settings.n[1]).toEqual({ t: 9, d: 0.5, p: 62, g: -4 });
  });
});
