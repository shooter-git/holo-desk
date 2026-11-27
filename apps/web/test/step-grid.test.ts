/** The Step Grid's arithmetic: pages of bars, the strip, drags, the swing a part has, and what offers each edit. */
import { heldOf, missingStepEdits, readSteps, STEP_EDITS, stepOps, stepSize, stepsIn } from '@holo/agent/edits';
import { applyOps, newProject, newRegion, newTrack, PPQ, type Project, type Track } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { isKitNow, noteViewFor, shownNoteView } from '../src/app/note-view.ts';
import {
  dragKind,
  pageAt,
  pageBars,
  pageBy,
  STUDIO_STEP_EDITS,
  stepsBetween,
  stripBars,
  swingNamed,
  swingOf,
  velocityDragged,
} from '../src/ui/step-grid.ts';

const BAR = PPQ * 4;
const S = PPQ / 4;

function song(): { project: Project; drums: Track; keys: Track } {
  const project = newProject('Grid');
  const drums = newTrack('Drums', { type: 'synth', preset: 'Drum Synth' });
  const r = newRegion(0, BAR * 4, 'Beat');
  r.notes = [
    { t: 0, d: S, p: 36, v: 127 },
    { t: BAR * 2 + S * 6, d: S, p: 38, v: 64 },
  ];
  drums.regions = [r];
  const keys = newTrack('Keys', { type: 'synth', preset: 'Soft Keys' });
  project.tracks = [drums, keys];
  return { project, drums, keys };
}

describe('how many bars a page shows', () => {
  it('is as many of 1, 2 or 4 as leave a step wide enough to press', () => {
    expect(pageBars(1150, 16, 0, false)).toBe(4);
    expect(pageBars(700, 16, 0, false)).toBe(2);
    expect(pageBars(280, 16, 0, true)).toBe(1);
    expect(pageBars(700, 16, 0, true)).toBe(2);
    // never none: a narrow phone still has its bar
    expect(pageBars(120, 32, 0, true)).toBe(1);
  });

  it('is the number chosen, when that many fit', () => {
    expect(pageBars(1150, 16, 1, false)).toBe(1);
    expect(pageBars(1150, 16, 2, false)).toBe(2);
    expect(pageBars(300, 16, 4, true)).toBe(1);
    // (a number that isn't offered is as many as fit)
    expect(pageBars(1150, 16, 3, false)).toBe(4);
  });
});

describe('the page a place is on', () => {
  const { project } = song();

  it('is counted from the song’s first bar, in pages of that many bars', () => {
    expect(pageAt(project.meter, 0, 4)).toEqual({ bar: 1, from: 0, to: BAR * 4 });
    expect(pageAt(project.meter, BAR * 5 + 7, 4)).toEqual({ bar: 5, from: BAR * 4, to: BAR * 8 });
    expect(pageAt(project.meter, BAR * 5 + 7, 1)).toEqual({ bar: 6, from: BAR * 5, to: BAR * 6 });
    expect(pageAt(project.meter, BAR * 3, 2).bar).toBe(3);
  });

  it('turns forward and back, and never before the first', () => {
    const p = pageAt(project.meter, BAR * 4, 2);
    expect(pageBy(project.meter, p, 2, 1).bar).toBe(7);
    expect(pageBy(project.meter, p, 2, -1).bar).toBe(3);
    expect(pageBy(project.meter, pageAt(project.meter, 0, 2), 2, -1).bar).toBe(1);
  });

  it('follows the meter', () => {
    const waltz = [{ tick: 0, num: 3, den: 4 }];
    expect(pageAt(waltz, PPQ * 7, 2)).toEqual({ bar: 3, from: PPQ * 6, to: PPQ * 12 });
  });
});

describe('the strip of bars', () => {
  it('has every bar through the last played and the page past the one shown, each with what’s played in its quarters', () => {
    const { drums, project } = song();
    const bars = stripBars(project.meter, heldOf(drums), BAR * 2);
    expect(bars.map((b) => b.bar)).toEqual([1, 2, 3]);
    expect(bars[0]?.parts).toEqual([1, 0, 0, 0]);
    expect(bars[1]?.parts).toEqual([0, 0, 0, 0]);
    expect(bars[2]?.parts[1]).toBeCloseTo(64 / 127, 5);
    expect(stripBars(project.meter, heldOf(drums), BAR * 8).at(-1)?.bar).toBe(8);
    // (an empty part still has its first bar, to write in)
    expect(stripBars(project.meter, [], 0).map((b) => b.bar)).toEqual([1]);
    expect(stripBars(project.meter, [], BAR * 1000, 16)).toHaveLength(16);
  });
});

describe('a press on a step', () => {
  it('reads a drag up or down as how hard, and one along the row as painting', () => {
    expect(dragKind(1, 2, 4)).toBeNull();
    expect(dragKind(1, -9, 4)).toBe('velocity');
    expect(dragKind(9, 2, 4)).toBe('along');
  });

  it('turns the drag into a velocity: up is harder, within 1 to 127', () => {
    expect(velocityDragged(100, 0)).toBe(100);
    expect(velocityDragged(100, -10)).toBe(111);
    expect(velocityDragged(100, 40)).toBe(56);
    expect([velocityDragged(100, -500), velocityDragged(100, 500)]).toEqual([127, 1]);
  });

  it('counts the steps a drag crossed, either way', () => {
    expect(stepsBetween(2, 5)).toEqual([2, 3, 4, 5]);
    expect(stepsBetween(5, 2)).toEqual([5, 4, 3, 2]);
    expect(stepsBetween(3, 3)).toEqual([3]);
  });
});

describe('the swing a part has', () => {
  it('is read from where its off-steps are, and named by the nearest the grid offers', () => {
    const { project, drums } = song();
    const hats = applyOps(
      project,
      stepOps({ project, track: drums, from: 0, to: BAR, size: S }, [
        { edit: 'fill', pitch: 42, every: 1 },
        { edit: 'swing', amount: 0.5 },
      ]),
    ).tracks[0] as Track;
    const steps = stepsIn(project.meter, 0, BAR, S);
    const amount = swingOf(readSteps(heldOf(hats), steps, BAR).values(), steps, S);
    expect(amount).toBeCloseTo(0.5, 2);
    expect(swingNamed(amount).name).toBe('Medium');
    // straight, and a grid that doesn't swing
    expect(swingOf(readSteps(heldOf(drums), steps, BAR).values(), steps, S)).toBe(0);
    const triplets = stepsIn(project.meter, 0, BAR, stepSize('1/8T'));
    expect(swingOf(readSteps(heldOf(hats), triplets, BAR).values(), triplets, stepSize('1/8T'))).toBe(0);
    expect(swingNamed(0.02).name).toBe('Straight');
  });
});

describe('the studio offers every Step Grid edit', () => {
  it('has a control for each edit in STEP_EDITS, by name, and none for an edit there isn’t', () => {
    expect(missingStepEdits(Object.keys(STUDIO_STEP_EDITS))).toEqual([]);
    const known = new Set<string>(STEP_EDITS.map((e) => e.name));
    for (const [edit, controls] of Object.entries(STUDIO_STEP_EDITS)) {
      expect(known.has(edit), edit).toBe(true);
      expect(controls.length, edit).toBeGreaterThan(0);
    }
  });

  it('would miss an edit added to STEP_EDITS without a control', () => {
    expect(missingStepEdits(Object.keys(STUDIO_STEP_EDITS).filter((e) => e !== 'euclid'))).toEqual(['euclid']);
  });
});

describe('which view a track’s notes are in', () => {
  const { project, drums, keys } = song();

  it('is the Step Grid only for a kit: any other track shows its Piano Roll', () => {
    expect([isKitNow(drums), isKitNow(keys), isKitNow(null)]).toEqual([true, false, false]);
    expect(noteViewFor('steps', drums)).toBe('steps');
    expect(noteViewFor('steps', keys)).toBe('roll');
    expect(noteViewFor('score', keys)).toBe('score');
    expect(shownNoteView({ noteView: 'steps', project, selectedTrack: drums.id })).toBe('steps');
    expect(shownNoteView({ noteView: 'steps', project, selectedTrack: keys.id })).toBe('roll');
    expect(shownNoteView({ noteView: 'steps', project, selectedTrack: null })).toBe('roll');
    expect(shownNoteView({ noteView: 'roll', project, selectedTrack: drums.id })).toBe('roll');
  });

  it('doesn’t take a sampled instrument for a kit before its map is known', () => {
    const kit = newTrack('Kit', { type: 'sampler', pack: 'pk', name: 'Studio Kit' });
    expect(isKitNow(kit)).toBe(false);
  });
});
