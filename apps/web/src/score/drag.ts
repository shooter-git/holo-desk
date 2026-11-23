/**
 * A note dragged up or down the Score: the drawn notes it moves follow the pointer a line or space at
 * a time (nothing is written until the drag ends, as one undo step), with a tip naming where the note
 * it holds would land. A finger moves further for each step than a mouse does, so it can stop on one.
 */
import { keyAlters, placesOf, type ScoreDoc, writtenKeyAt } from '@holo/score';
import type { Note, Project } from '@holo/session';
import type { ScoreIndex } from './layout-index.ts';

/** How far a finger moves for a line or space, at least (a staff's own is a few pixels on a phone). */
const FINGER_STEP_PX = 14;

const LETTERS = 'CDEFGAB';
const SIGNS: Record<number, string> = { [-2]: '𝄫', [-1]: '♭', 0: '', 1: '♯', 2: '𝄪' };

/** Half a staff space, in page pixels, on the staff nearest a point (a line or space is one). */
export function halfSpaceAt(index: ScoreIndex, x: number, y: number): number {
  const bar =
    index.bars.find((b) => x >= b.left && x <= b.right && y >= b.top - 80 && y <= b.bottom + 80) ?? index.bars[0];
  const staff = bar?.staves.reduce<{ top: number; bottom: number } | null>((best, s) => {
    const d = (v: { top: number; bottom: number }) => (y < v.top ? v.top - y : y > v.bottom ? y - v.bottom : 0);
    return !best || d(s) < d(best) ? s : best;
  }, null);
  return staff ? Math.max(1, (staff.bottom - staff.top) / 8) : 4;
}

export class DraggedNotes {
  readonly notes: readonly Note[];
  private els: { el: SVGGraphicsElement; scale: number; was: string | null }[] = [];
  private half: number;
  private stepPx: number;
  private y0: number;
  steps = 0;

  /** `half`: half a staff space on the page; `touch`: a finger drags. */
  constructor(page: HTMLElement, doc: ScoreDoc, notes: readonly Note[], y0: number, half: number, touch: boolean) {
    this.notes = notes;
    this.half = half;
    this.stepPx = touch ? Math.max(half, FINGER_STEP_PX) : half;
    this.y0 = y0;
    const moving = new Set(notes);
    const heads = new Set<Element>();
    for (const [id, ref] of doc.refs) {
      if (!moving.has(ref.note)) continue;
      const el = page.querySelector(`[id="${id}"]`);
      if (el) heads.add(el);
    }
    // a chord whose notes all move moves whole, with its stem; else just the heads that move
    const els = new Set<Element>();
    for (const head of heads) {
      const chord = head.parentElement?.closest('g.chord');
      const all = chord ? [...chord.querySelectorAll('g.note')] : [];
      els.add(chord && all.length && all.every((n) => heads.has(n)) ? chord : head);
    }
    for (const el of els) {
      const g = el as SVGGraphicsElement;
      const m = g.getScreenCTM?.();
      this.els.push({ el: g, scale: m?.d ? Math.abs(m.d) : 1, was: g.getAttribute('transform') });
    }
  }

  /** The pointer is at `y`: true when that's a step further (the notes are drawn there). */
  follow(y: number): boolean {
    const steps = Math.round((this.y0 - y) / this.stepPx);
    if (steps === this.steps) return false;
    this.steps = steps;
    const dy = -steps * this.half;
    for (const { el, scale, was } of this.els) {
      el.setAttribute('transform', `${was ?? ''} translate(0 ${dy / scale})`.trim());
    }
    return true;
  }

  /** The notes drawn where they were. */
  drop(): void {
    for (const { el, was } of this.els) {
      if (was === null) el.removeAttribute('transform');
      else el.setAttribute('transform', was);
    }
  }
}

/** How a note would be written `steps` lines and spaces from where it is (in its key): "F♯5". */
export function nameAfter(project: Project, doc: ScoreDoc, note: Note, steps: number): string {
  const at = placesOf(doc).get(note);
  if (!at) return '';
  const index = at.written.octave * 7 + at.written.step + steps;
  const step = ((index % 7) + 7) % 7;
  let tick = 0;
  for (const t of project.tracks) for (const r of t.regions) if (r.notes.includes(note)) tick = r.start + note.t;
  const alter = steps === 0 ? at.written.alter : (keyAlters(writtenKeyAt(project, doc, at.track, tick))[step] ?? 0);
  return `${LETTERS[step]}${SIGNS[alter] ?? ''}${Math.floor(index / 7)}`;
}
