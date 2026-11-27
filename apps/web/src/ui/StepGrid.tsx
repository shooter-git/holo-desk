/**
 * The Step Grid: a kit's part as a drum machine shows it. A row for each piece of the kit, a step
 * for each division of the bar, a page of bars at a time. Tap a step to light it, drag along a row
 * to paint or erase, drag a lit step up or down for how hard it's hit. A lit step is a note of the
 * track (edits/steps.ts): nothing here is kept that the Piano Roll doesn't show too.
 */
import {
  type Cell,
  heldOf,
  kitRows,
  levelOf,
  readSteps,
  STEP_GRIDS,
  STEP_LEVELS,
  STEP_VELOCITY,
  type Step,
  type StepContext,
  type StepEdit,
  type StepRowName,
  stepLine,
  stepOps,
  stepPreview,
  stepRows,
  stepSize,
  stepsIn,
  swings,
} from '@holo/agent/edits';
import { meterAt, type Project, type Track, ticksPerBar } from '@holo/session';
import { ChevronLeft, ChevronRight, Ellipsis } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { apply, ensureAudio, locate } from '../app/actions.ts';
import { isPhone, useLayout } from '../app/layout.ts';
import { useKitMap } from '../app/note-view.ts';
import { store, toast, useApp } from '../app/store.ts';
import { engine } from '../audio/engine.ts';
import { useFrame, useMedia, useSize } from './frame.ts';
import { isMenuPress } from './gesture.ts';
import { type MenuEntry, openMenu, openMenuAt } from './menu.tsx';
import { padsFor } from './pads.ts';
import {
  dragKind,
  type Page,
  pageAt,
  pageBars,
  pageBy,
  SWINGS,
  stepsBetween,
  stepView,
  stripBars,
  swingNamed,
  swingOf,
  useStepPage,
  velocityDragged,
} from './step-grid.ts';
import { UndoRedo } from './UndoRedo.tsx';
import { UprightBar } from './UprightBar.tsx';

/** How long a finger rests on a step before it holds it (then: up and down for how hard, or let go for the levels). */
const HOLD_MS = 320;

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A step struck, or a pad's name as it plays: a short swell (nothing, where motion is to be spared). */
function swell(el: Element | null, big = 1.22): void {
  if (!el || reducedMotion() || typeof el.animate !== 'function') return;
  el.animate(
    [
      { transform: `scale(${big})`, filter: 'brightness(1.7)' },
      { transform: 'scale(1)', filter: 'brightness(1)' },
    ],
    { duration: 240, easing: 'cubic-bezier(.2,.8,.3,1)' },
  );
}

/** The selected track, when it's one the grid can show. */
function useGridTrack(): { project: Project; track: Track } | null {
  const project = useApp((s) => s.project);
  const id = useApp((s) => s.selectedTrack);
  const track = project?.tracks.find((t) => t.id === id);
  return project && track && track.kind === 'instrument' ? { project, track } : null;
}

/** The kit's rows by name: its own pads, its sounds, or General MIDI's drums. */
function useKit(track: Track | null): StepRowName[] {
  const map = useKitMap(track?.instrument);
  const middleC = useApp((s) => s.middleC);
  const inst = track?.instrument;
  return useMemo(() => {
    if (map?.pads?.length) return kitRows(map.pads.map((p) => ({ key: p.key, name: p.name })));
    // sounds with no names of their own: the pads the Play tab shows for them
    if (map && map.pitched === false)
      return padsFor(inst, map, { wide: false, octave: 3, middleC }).pads.map((p) => ({ note: p.note, name: p.name }));
    return kitRows(null);
  }, [map, inst, middleC]);
}

/** The edits made on the selected track over a stretch of bars, as one undo step. */
function runSteps(edits: StepEdit | StepEdit[], label: string, span?: { from: number; to: number }): boolean {
  const s = store.get();
  const track = s.project?.tracks.find((t) => t.id === s.selectedTrack);
  if (!s.project || !track) return false;
  const size = stepSize(s.stepGrid);
  const from = span?.from ?? stepView.from;
  const to = span?.to ?? pageAt(s.project.meter, from, stepView.bars).to;
  try {
    const ops = stepOps({ project: s.project, track, from, to, size }, edits);
    if (!ops.length) return false;
    return apply(ops, label) !== null;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
    return false;
  }
}

/** The bars a part runs over, whole: what a swing is set on (every bar of it, not the page alone). */
function partSpan(project: Project, track: Track): { from: number; to: number } | null {
  const regions = track.regions.filter((r) => !r.audio && r.notes.length);
  if (!regions.length) return null;
  const start = Math.min(...regions.map((r) => r.start));
  const end = Math.max(...regions.map((r) => r.start + r.length));
  const first = pageAt(project.meter, start, 1);
  const last = pageAt(project.meter, Math.max(start, end - 1), 1);
  return { from: first.from, to: last.to };
}

interface Press {
  pointer: number;
  touch: boolean;
  pitch: number;
  name: string;
  start: number;
  last: number;
  x0: number;
  y0: number;
  /** The row as it was when pressed: which of its steps were lit. */
  base: boolean[];
  /** Whether the step pressed was lit, and how hard. */
  lit: boolean;
  v0: number;
  mode: 'undecided' | 'paint' | 'erase' | 'velocity';
  /** A finger has rested on it: up and down is how hard, and letting go opens the levels. */
  held: boolean;
  moved: boolean;
  /** The steps the drag has dealt with. */
  done: Set<number>;
  edits: StepEdit[];
  timer: number;
}

export function StepGrid() {
  const layout = useLayout();
  const phone = isPhone(layout);
  const touch = useMedia('(pointer: coarse)');
  const sel = useGridTrack();
  const project = sel?.project ?? null;
  const track = sel?.track ?? null;
  const grid = useApp((s) => s.stepGrid);
  const chosenBars = useApp((s) => s.stepBars);
  const all = useApp((s) => s.stepAll);
  const follow = useApp((s) => s.follow);
  const playing = useApp((s) => s.playing);
  const kit = useKit(track);

  const body = useRef<HTMLDivElement>(null);
  const rowsBox = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const light = useRef<HTMLDivElement>(null);
  const size = useSize(body);
  const names = phone ? 106 : 148;
  const stepTicks = stepSize(grid);
  const meter = project?.meter ?? [];

  /** Rows that have been shown stay while the track is open: putting a row's last step out doesn't take the row away. */
  const [kept, setKept] = useState<Set<number>>(() => new Set());
  /** A row being typed as a line. */
  const [typing, setTyping] = useState<{ pitch: number; name: string; text: string } | null>(null);
  const typedAway = useRef(false);
  /** The step under the arrow keys. */
  const [cursor, setCursor] = useState<{ pitch: number; i: number } | null>(null);

  // ---- the page ----
  /** A tick on the page shown (the page is the one of `bars` bars that holds it). */
  const [anchor, setAnchor] = useState(0);
  const perBar = project ? Math.ceil(ticksPerBar(meterAt(meter, anchor)) / stepTicks - 1e-9) : 16;
  const bars = pageBars(Math.max(0, size.w - names - 12), perBar, chosenBars, touch);
  const page: Page = useMemo(() => pageAt(meter, anchor, bars), [meter, anchor, bars]);
  useEffect(() => stepView.set(page.from, bars), [page.from, bars]);

  // a track opens at the playhead, or at its selected or first region
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the track changes, not on every edit
  useLayoutEffect(() => {
    if (!track) return;
    const at = engine.positionTick();
    const s = store.get();
    const first = track.regions.find((r) => s.selectedRegions.includes(r.id)) ?? track.regions[0];
    setAnchor(at > 0 ? at : (first?.start ?? 0));
    setKept(new Set());
    setTyping(null);
  }, [track?.id]);

  // ---- the part ----
  const regions = track?.regions;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the regions are the part; the track's faders aren't
  const held = useMemo(() => (track ? heldOf(track) : []), [regions]);
  const steps = useMemo(() => stepsIn(meter, page.from, page.to, stepTicks), [meter, page, stepTicks]);
  /** The edits of a drag under way: shown as they'd be, made when it's let go. */
  const [pending, setPending] = useState<StepEdit[] | null>(null);
  const ctx: StepContext | null = useMemo(
    () => (project && track ? { project, track, from: page.from, to: page.to, size: stepTicks } : null),
    [project, track, page, stepTicks],
  );
  const shown = useMemo(() => {
    if (!ctx || !pending?.length) return held;
    try {
      return stepPreview(ctx, pending);
    } catch {
      return held;
    }
  }, [ctx, pending, held]);
  const rows = useMemo(() => readSteps(shown, steps, page.to), [shown, steps, page.to]);

  const played = useMemo(() => {
    const out = new Set(kept);
    for (const h of shown) for (const n of h.notes) out.add(Math.round(n.p));
    return out;
  }, [shown, kept]);
  // (the kit's first few pieces always have a row: a part of kick and snare still has its hats in reach)
  const list = useMemo(() => stepRows(kit, played, all, true), [kit, played, all]);
  useEffect(() => {
    if (list.every((r) => kept.has(r.note))) return;
    setKept((was) => new Set([...was, ...list.map((r) => r.note)]));
  }, [list, kept]);

  const barsStrip = useMemo(
    () => stripBars(meter, held, page.to + (page.to - page.from)),
    [meter, held, page.from, page.to],
  );

  // ---- playing: the page follows, a light runs along the steps, and what's struck swells ----
  const lastPlayPage = useRef(-1);
  const lastTick = useRef(Number.NaN);
  const lit = useRef(-2);
  const press = useRef<Press | null>(null);
  useFrame(() => {
    if (!project || !steps.length) return;
    const s = store.get();
    const tick = engine.positionTick();
    if (follow && !press.current) {
      const jumped = !Number.isNaN(lastTick.current) && Math.abs(tick - lastTick.current) > stepTicks * 4;
      const there = pageAt(meter, tick, bars).from;
      // playback turns the page as it leaves it; a locate shows where it landed
      if ((s.playing && there !== lastPlayPage.current) || (jumped && there !== page.from)) {
        lastPlayPage.current = there;
        if (there !== page.from) setAnchor(tick);
      }
    }
    lastTick.current = tick;
    let i = -1;
    if (tick >= page.from && tick < page.to) {
      i = steps.length - 1;
      while (i > 0 && (steps[i] as Step).tick > tick) i--;
    }
    const key = s.playing ? i : -1 - (i + 1) * 2;
    if (key === lit.current) return;
    lit.current = key;
    const el = light.current;
    const box = rowsBox.current;
    if (!el || !box) return;
    const cell = i >= 0 ? box.querySelector<HTMLElement>(`.step-ruler [data-i="${i}"]`) : null;
    if (!cell) {
      el.style.opacity = '0';
      return;
    }
    const a = cell.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    el.style.opacity = '1';
    el.style.width = `${a.width}px`;
    el.style.transform = `translateX(${a.left - b.left}px)`;
    el.classList.toggle('s-idle', !s.playing);
    if (!s.playing) return;
    for (const pip of box.querySelectorAll(`.step.s-lit[data-i="${i}"] .pip`)) {
      swell(pip);
      swell(pip.closest('.step-row')?.querySelector('.step-name-text') ?? null, 1.08);
    }
  });
  // (the light is placed again when the page or its size changes)
  // biome-ignore lint/correctness/useExhaustiveDependencies: what moves the steps under the light
  useEffect(() => {
    lit.current = -2;
  }, [page.from, bars, size.w, list.length, playing, grid]);

  // the strip keeps the page in sight
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the page turns
  useEffect(() => {
    strip.current?.querySelector('.strip-bar.s-on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [page.from]);

  // ---- hearing ----
  const hear = (pitch: number, v: number) => {
    if (!track) return;
    void ensureAudio().then(() => engine.audition(track.id, pitch, v, 160));
  };

  // ---- pressing steps ----
  const cellOf = (pitch: number, i: number): Cell | undefined => rows.get(pitch)?.[i];
  const stepUnder = (x: number, y: number, pitch: number): number | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.step');
    if (!el || Number(el.dataset.p) !== pitch) return null;
    return Number(el.dataset.i);
  };
  const [bubble, setBubble] = useState<{ x: number; y: number; v: number } | null>(null);

  const levelsMenu = (x: number, y: number, pitch: number, name: string, i: number) => {
    const cell = cellOf(pitch, i);
    const now = cell?.notes.length ? levelOf(cell.v) : null;
    const entries: MenuEntry[] = [
      { heading: `${name}, step ${(steps[i] as Step).index + 1}` },
      ...[...STEP_LEVELS].reverse().map(
        (l): MenuEntry => ({
          label: l.name,
          hint: String(l.v),
          checked: now === l,
          onSelect: () => {
            if (runSteps({ edit: 'set', pitch, step: i, v: l.v }, `${name}: ${l.name.toLowerCase()}`)) hear(pitch, l.v);
          },
        }),
      ),
      ...(now
        ? ([
            'sep',
            {
              label: 'Put it out',
              onSelect: () => void runSteps({ edit: 'clear', pitch, step: i }, `${name}: step out`),
            },
          ] as MenuEntry[])
        : []),
    ];
    openMenu(x, y, entries);
  };

  const finish = (p: Press, made: boolean) => {
    window.clearTimeout(p.timer);
    press.current = null;
    setBubble(null);
    if (!made || !p.edits.length) {
      setPending(null);
      return;
    }
    const label =
      p.mode === 'velocity' ? `${p.name}: how hard` : p.edits.length > 1 ? `${p.name}: steps` : `${p.name}: step`;
    runSteps(p.edits, label);
    setPending(null);
  };

  const onDown = (e: ReactPointerEvent) => {
    const el = (e.target as Element).closest<HTMLElement>('.step');
    if (!el || !ctx || press.current) return;
    const pitch = Number(el.dataset.p);
    const i = Number(el.dataset.i);
    const name = list.find((r) => r.note === pitch)?.name ?? 'Step';
    const cell = cellOf(pitch, i);
    const isLit = !!cell?.notes.length;
    if (isMenuPress(e)) {
      e.preventDefault();
      levelsMenu(e.clientX, e.clientY, pitch, name, i);
      return;
    }
    if (e.button !== 0) return;
    const isTouch = e.pointerType === 'touch';
    const p: Press = {
      pointer: e.pointerId,
      touch: isTouch,
      pitch,
      name,
      start: i,
      last: i,
      x0: e.clientX,
      y0: e.clientY,
      base: steps.map((_, k) => !!cellOf(pitch, k)?.notes.length),
      lit: isLit,
      v0: cell?.v || STEP_VELOCITY,
      mode: 'undecided',
      held: false,
      moved: false,
      done: new Set(),
      edits: [],
      timer: 0,
    };
    press.current = p;
    setCursor({ pitch, i });
    try {
      rowsBox.current?.setPointerCapture(e.pointerId);
    } catch {
      // (the pointer may be gone already)
    }
    if (!isTouch && !isLit) {
      // a mouse lights the step as it lands, and it sounds
      p.mode = 'paint';
      p.done.add(i);
      p.edits = [{ edit: 'set', pitch, step: i, v: STEP_VELOCITY }];
      setPending(p.edits);
      hear(pitch, STEP_VELOCITY);
    }
    if (isTouch)
      p.timer = window.setTimeout(() => {
        if (press.current !== p || p.moved) return;
        p.held = true;
        navigator.vibrate?.(8);
        if (p.lit) {
          p.mode = 'velocity';
          setBubble({ x: p.x0, y: p.y0, v: p.v0 });
        }
      }, HOLD_MS);
  };

  const along = (p: Press, to: number) => {
    for (const i of stepsBetween(p.last, to)) {
      if (p.done.has(i)) continue;
      p.done.add(i);
      // (by the row as it was pressed: what the drag has lit since isn't in it)
      const was = p.base[i] === true;
      if (p.mode === 'paint' && !was) {
        p.edits = [...p.edits, { edit: 'set', pitch: p.pitch, step: i, v: STEP_VELOCITY }];
        hear(p.pitch, STEP_VELOCITY);
      } else if (p.mode === 'erase' && was) p.edits = [...p.edits, { edit: 'clear', pitch: p.pitch, step: i }];
    }
    p.last = to;
    setPending(p.edits);
  };

  const onMove = (e: ReactPointerEvent) => {
    const p = press.current;
    if (!p || e.pointerId !== p.pointer) return;
    const dx = e.clientX - p.x0;
    const dy = e.clientY - p.y0;
    if (p.mode === 'velocity') {
      p.moved = p.moved || Math.abs(dy) > 3;
      const v = velocityDragged(p.v0, dy);
      p.edits = [{ edit: 'set', pitch: p.pitch, step: p.start, v }];
      setPending(p.edits);
      setBubble({ x: e.clientX, y: e.clientY, v });
      return;
    }
    if (p.mode === 'undecided') {
      const kind = dragKind(dx, dy, p.touch ? 9 : 4);
      if (!kind) return;
      p.moved = true;
      window.clearTimeout(p.timer);
      if (p.lit && kind === 'velocity' && !p.touch) {
        p.mode = 'velocity';
        onMove(e);
        return;
      }
      if (kind !== 'along') return;
      p.mode = p.lit ? 'erase' : 'paint';
      p.done.clear();
      along(p, p.start);
    }
    const to = stepUnder(e.clientX, e.clientY, p.pitch);
    if (to !== null && to !== p.last) along(p, to);
  };

  const onUp = (e: ReactPointerEvent) => {
    const p = press.current;
    if (!p || e.pointerId !== p.pointer) return;
    if (p.mode === 'undecided' || (p.mode === 'velocity' && !p.moved)) {
      // a tap: a lit step goes out, a dark one is lit; a finger that rested on it is shown the levels
      if (p.held) {
        finish(p, false);
        levelsMenu(e.clientX, e.clientY, p.pitch, p.name, p.start);
        return;
      }
      p.edits = p.lit
        ? [{ edit: 'clear', pitch: p.pitch, step: p.start }]
        : [{ edit: 'set', pitch: p.pitch, step: p.start, v: STEP_VELOCITY }];
      if (!p.lit) hear(p.pitch, STEP_VELOCITY);
    } else if (p.mode === 'velocity') hear(p.pitch, velocityDragged(p.v0, e.clientY - p.y0));
    finish(p, true);
  };

  const onCancel = (e: ReactPointerEvent) => {
    const p = press.current;
    if (p && e.pointerId === p.pointer) finish(p, false);
  };

  // a finger resting on a step holds the page still under it (its up and down is how hard, not a scroll)
  useEffect(() => {
    const el = rowsBox.current;
    if (!el) return;
    const still = (ev: TouchEvent) => {
      const p = press.current;
      if (p && (p.held || p.mode === 'paint' || p.mode === 'erase') && ev.cancelable) ev.preventDefault();
    };
    el.addEventListener('touchmove', still, { passive: false });
    return () => el.removeEventListener('touchmove', still);
  }, []);
  useEffect(
    () => () => {
      if (press.current) window.clearTimeout(press.current.timer);
    },
    [],
  );

  // ---- the keyboard: a step under the arrows ----
  const turn = (by: number) => setAnchor(pageBy(meter, page, bars, by).from);
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !list.length || !steps.length) return;
    const r = Math.max(
      0,
      list.findIndex((x) => x.note === cursor?.pitch),
    );
    const i = Math.min(steps.length - 1, cursor?.i ?? 0);
    const row = list[r] as StepRowName;
    const at = (nr: number, ni: number) => setCursor({ pitch: (list[nr] as StepRowName).note, i: ni });
    const isLit = !!cellOf(row.note, i)?.notes.length;
    const level = STEP_LEVELS[Number(e.key) - 1];
    if (e.key === 'ArrowRight') {
      if (i + 1 < steps.length) at(r, i + 1);
      else {
        turn(1);
        at(r, 0);
      }
    } else if (e.key === 'ArrowLeft') {
      if (i > 0) at(r, i - 1);
      else if (page.from > pageBy(meter, page, bars, -1).from) {
        turn(-1);
        at(r, steps.length - 1);
      }
    } else if (e.key === 'ArrowDown') at(Math.min(list.length - 1, r + 1), i);
    else if (e.key === 'ArrowUp') at(Math.max(0, r - 1), i);
    else if (e.key === 'Enter') {
      if (isLit) runSteps({ edit: 'clear', pitch: row.note, step: i }, `${row.name}: step`);
      else if (runSteps({ edit: 'set', pitch: row.note, step: i, v: STEP_VELOCITY }, `${row.name}: step`))
        hear(row.note, STEP_VELOCITY);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (isLit) runSteps({ edit: 'clear', pitch: row.note, step: i }, `${row.name}: step`);
    } else if (level && !e.shiftKey) {
      if (runSteps({ edit: 'set', pitch: row.note, step: i, v: level.v }, `${row.name}: ${level.name.toLowerCase()}`))
        hear(row.note, level.v);
    } else if (e.key === 'PageDown') turn(1);
    else if (e.key === 'PageUp') turn(-1);
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (!cursor) at(r, i);
  };

  // ---- a row's menu, and a row typed as a line ----
  const rowMenu = (at: Element, row: StepRowName) => {
    const cells = rows.get(row.note);
    const beat = Math.max(1, Math.round(steps.filter((s) => s.bar === steps[0]?.bar && s.beat).length));
    const perBeat = Math.max(1, Math.round(perBar / beat));
    const fill = (every: number, offset: number, label: string): MenuEntry => ({
      label,
      onSelect: () =>
        void runSteps({ edit: 'fill', pitch: row.note, every, offset }, `${row.name}: ${label.toLowerCase()}`),
    });
    const spread = (hits: number): MenuEntry => ({
      label: `Spread ${hits} hits over each bar`,
      onSelect: () => void runSteps({ edit: 'euclid', pitch: row.note, hits }, `${row.name}: ${hits} hits spread`),
    });
    openMenuAt(at, [
      { heading: row.name },
      fill(1, 0, 'Every step'),
      fill(2, 0, 'Every other step'),
      fill(perBeat, 0, 'On the beats'),
      fill(perBeat, Math.floor(perBeat / 2), 'Off the beats'),
      'sep',
      ...[3, 5, 7].filter((n) => n < perBar).map(spread),
      'sep',
      {
        label: 'A step later',
        onSelect: () => void runSteps({ edit: 'shift', pitch: row.note, by: 1 }, `${row.name}: later`),
      },
      {
        label: 'A step earlier',
        onSelect: () => void runSteps({ edit: 'shift', pitch: row.note, by: -1 }, `${row.name}: earlier`),
      },
      'sep',
      {
        label: 'Hit harder',
        onSelect: () => void runSteps({ edit: 'velocity', pitch: row.note, by: 12 }, `${row.name}: harder`),
      },
      {
        label: 'Hit softer',
        onSelect: () => void runSteps({ edit: 'velocity', pitch: row.note, by: -12 }, `${row.name}: softer`),
      },
      {
        label: 'Vary how hard',
        onSelect: () =>
          void runSteps(
            { edit: 'humanize', pitch: row.note, amount: 14, seed: Math.floor(Math.random() * 1e6) + 1 },
            `${row.name}: varied`,
          ),
      },
      'sep',
      {
        label: 'Type the row…',
        hint: 'x o g .',
        onSelect: () => {
          typedAway.current = false;
          setTyping({ pitch: row.note, name: row.name, text: cells ? stepLine(cells) : '.'.repeat(steps.length) });
        },
      },
      {
        label: 'Clear the row',
        onSelect: () => void runSteps({ edit: 'clear-row', pitch: row.note }, `${row.name}: cleared`),
      },
    ]);
  };
  const writeTyped = () => {
    if (!typing) return;
    if (typedAway.current) {
      typedAway.current = false;
      return;
    }
    if (typing.text.trim())
      runSteps({ edit: 'write', pitch: typing.pitch, pattern: typing.text }, `${typing.name}: written`);
    setTyping(null);
  };

  if (!project || !track) return <div className="steps" />;
  const drummer = track.midiFx.some((p) => p.type === 'drummer' && !p.bypass);
  const empty = !held.some((h) => h.notes.length);
  const color = track.color;
  // the steps bar by bar: each bar is a group of its own, a little apart from the last
  const groups: { bar: number; cells: { s: Step; i: number }[] }[] = [];
  steps.forEach((s, i) => {
    if (s.index === 0 || !groups.length) groups.push({ bar: s.bar, cells: [] });
    groups.at(-1)?.cells.push({ s, i });
  });
  const barStyle = (n: number): CSSProperties => ({ flex: n, gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` });
  let beatNo = 0;
  const beatOf = steps.map((s) => {
    if (s.index === 0) beatNo = 0;
    if (s.beat) beatNo++;
    return beatNo;
  });
  const cellClass = (s: Step) => `${s.beat ? ' s-beat' : ''}${s.alt ? ' s-alt' : ''}`;

  return (
    <div
      className={`steps${touch ? ' s-touch' : ''}`}
      style={{ '--c': color, '--names': `${names}px` } as CSSProperties}
    >
      <div className="steps-top">
        <button
          type="button"
          className="btn ghost icon"
          title="The page before (Page Up)"
          aria-label="The page before"
          disabled={page.from <= pageBy(meter, page, bars, -1).from}
          onClick={() => turn(-1)}
        >
          <ChevronLeft />
        </button>
        <div className="steps-strip" ref={strip} role="tablist" aria-label="The part, bar by bar">
          {barsStrip.map((b) => {
            const on = b.from >= page.from && b.from < page.to;
            return (
              <button
                key={b.bar}
                type="button"
                role="tab"
                aria-selected={on}
                className={`strip-bar${on ? ' s-on' : ''}`}
                title={`Bar ${b.bar}`}
                aria-label={`Bar ${b.bar}${b.parts.some((v) => v > 0) ? '' : ', empty'}`}
                onClick={() => setAnchor(b.from)}
              >
                <span className="strip-no">{b.bar}</span>
                <span className="strip-parts" aria-hidden="true">
                  {b.parts.map((v, q) => (
                    <i
                      key={q}
                      style={{ opacity: v ? 0.35 + v * 0.65 : undefined }}
                      className={v ? 's-hit' : undefined}
                    />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="btn ghost icon"
          title="The next page (Page Down)"
          aria-label="The next page"
          onClick={() => turn(1)}
        >
          <ChevronRight />
        </button>
      </div>
      <div className="steps-body" ref={body}>
        <div
          className="steps-rows"
          ref={rowsBox}
          role="application"
          aria-label={`${track.name}: steps, bars ${page.bar} to ${page.bar + bars - 1}. Arrows move, Enter lights a step or puts it out, 1 to 4 set how hard`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the grid takes the arrows
          tabIndex={0}
          onKeyDown={onKey}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onCancel}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="step-row step-ruler">
            <div className="step-head">
              <span className="step-page">
                {bars === 1 ? `Bar ${page.bar}` : `Bars ${page.bar}–${page.bar + bars - 1}`}
              </span>
            </div>
            <div className="step-cells">
              {groups.map((g) => (
                <div className="step-bar" key={g.bar} style={barStyle(g.cells.length)}>
                  {g.cells.map(({ s, i }) => (
                    <button
                      key={s.tick}
                      type="button"
                      tabIndex={-1}
                      data-i={i}
                      className={`step-tick${cellClass(s)}`}
                      title="Move the playhead here"
                      aria-label={`Step ${s.index + 1}: move the playhead here`}
                      onClick={() => locate(s.tick)}
                    >
                      {s.beat ? s.index === 0 && bars > 1 ? <b>{pageAt(meter, s.tick, 1).bar}</b> : beatOf[i] : ''}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
          {list.map((row) => {
            const cells = rows.get(row.note);
            const isTyping = typing?.pitch === row.note;
            return (
              <div className="step-row" key={row.note}>
                <div className="step-head">
                  <button
                    type="button"
                    className="step-name"
                    title={`Play ${row.name}`}
                    aria-label={`Play ${row.name}`}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      hear(row.note, STEP_VELOCITY);
                      swell(e.currentTarget.querySelector('.step-name-text'), 1.1);
                    }}
                  >
                    <span className="step-name-text">{row.name}</span>
                  </button>
                  <button
                    type="button"
                    className="btn ghost icon step-more"
                    title={`${row.name}: fill, spread, shift, clear`}
                    aria-label={`${row.name}: pattern tools`}
                    aria-haspopup="menu"
                    onClick={(e) => rowMenu(e.currentTarget, row)}
                  >
                    <Ellipsis />
                  </button>
                </div>
                {isTyping ? (
                  <input
                    className="input step-typed mono"
                    value={typing.text}
                    // biome-ignore lint/a11y/noAutofocus: the field opened for typing into
                    autoFocus
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    aria-label={`${row.name}, a character a step: X accent, x hit, o soft, g ghost, . none`}
                    onChange={(e) => setTyping({ ...typing, text: e.target.value })}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') writeTyped();
                      else if (e.key === 'Escape') {
                        typedAway.current = true;
                        setTyping(null);
                      }
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onBlur={writeTyped}
                  />
                ) : (
                  <div className="step-cells">
                    {groups.map((g) => (
                      <div className="step-bar" key={g.bar} style={barStyle(g.cells.length)}>
                        {g.cells.map(({ s, i }) => {
                          const cell = cells?.[i];
                          const on = !!cell?.notes.length;
                          const off = on ? Math.max(-0.45, Math.min(0.45, (cell?.offset ?? 0) / stepTicks)) : 0;
                          const here = cursor?.pitch === row.note && cursor.i === i;
                          return (
                            <div
                              key={s.tick}
                              data-p={row.note}
                              data-i={i}
                              className={`step${cellClass(s)}${on ? ` s-lit lv-${levelOf(cell?.v ?? 0).id}` : ''}${here ? ' s-cur' : ''}`}
                              style={
                                on
                                  ? ({
                                      '--v': ((cell?.v ?? 0) / 127).toFixed(3),
                                      '--off': off.toFixed(3),
                                    } as CSSProperties)
                                  : undefined
                              }
                            >
                              {on && (
                                <span className="pip">{(cell?.notes.length ?? 0) > 1 ? cell?.notes.length : ''}</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <div className="steps-light" ref={light} aria-hidden="true" />
        </div>
        {(drummer || empty) && (
          <p className="steps-note muted">
            {drummer
              ? 'The Session Drummer plays this track: its hits aren’t notes, so there are none to show. Steps you light play along with it.'
              : 'Tap a step to light it, drag along a row to paint. A pad’s name plays it.'}
          </p>
        )}
        {list.length < kit.length && !all && (
          <button type="button" className="btn ghost steps-all" onClick={() => store.set({ stepAll: true })}>
            All {kit.length} pads
          </button>
        )}
      </div>
      {bubble && (
        <div className="step-bubble" style={{ left: bubble.x, top: bubble.y }} aria-hidden="true">
          <b>{bubble.v}</b>
          <span>{levelOf(bubble.v).name}</span>
        </div>
      )}
    </div>
  );
}

/** The Step Grid's bar: the step, the swing, how many bars a page, every pad or those played, and the page's tools. */
export function StepGridBar() {
  const layout = useLayout();
  const phone = isPhone(layout);
  const sel = useGridTrack();
  const grid = useApp((s) => s.stepGrid);
  const chosenBars = useApp((s) => s.stepBars);
  const all = useApp((s) => s.stepAll);
  const from = useStepPage();
  const project = sel?.project ?? null;
  const track = sel?.track ?? null;
  const size = stepSize(grid);

  // the swing the part has, read from where its off-steps are
  const regions = track?.regions;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the regions are the part
  const swing = useMemo(() => {
    if (!project || !track || !swings(size)) return 0;
    const span = partSpan(project, track);
    if (!span) return 0;
    const steps = stepsIn(project.meter, span.from, span.to, size);
    return swingOf(readSteps(heldOf(track), steps, span.to).values(), steps, size);
  }, [regions, project?.meter, size]);
  const swingNow = swingNamed(swing);

  const setSwing = (amount: number, name: string) => {
    if (!project || !track) return;
    const span = partSpan(project, track);
    if (!span) {
      toast('There are no steps to swing yet');
      return;
    }
    runSteps({ edit: 'swing', amount }, amount ? `Swing: ${name.toLowerCase()}` : 'Swing: straight', span);
  };
  const swingEntries = (): MenuEntry[] => [
    { heading: 'Swing: how late every other step falls' },
    ...SWINGS.map(
      (s): MenuEntry => ({
        label: s.name,
        hint: s.amount ? `${Math.round(s.amount * 100)} %` : '',
        checked: swing > 0.02 ? s === swingNow : s.amount === 0,
        onSelect: () => setSwing(s.amount, s.name),
      }),
    ),
  ];
  const barsEntries = (): MenuEntry[] => [
    { heading: 'Bars a page' },
    { label: 'As many as fit', checked: chosenBars === 0, onSelect: () => store.set({ stepBars: 0 }) },
    ...[1, 2, 4].map(
      (n): MenuEntry => ({
        label: n === 1 ? '1 bar' : `${n} bars`,
        checked: chosenBars === n,
        onSelect: () => store.set({ stepBars: n }),
      }),
    ),
  ];
  const pageEntries = (): MenuEntry[] => {
    if (!project || from < 0) return [];
    const to = pageAt(project.meter, from, stepView.bars).to;
    const length = to - from;
    return [
      { heading: 'This page' },
      {
        label: 'Copy to the next page',
        onSelect: () => void runSteps({ edit: 'copy', to }, 'Steps copied to the next page'),
      },
      {
        label: 'Copy to the next three pages',
        onSelect: () => void runSteps({ edit: 'copy', to, times: 3 }, 'Steps copied to the next three pages'),
      },
      'sep',
      { label: 'Everything a step later', onSelect: () => void runSteps({ edit: 'shift', by: 1 }, 'Steps: later') },
      {
        label: 'Everything a step earlier',
        onSelect: () => void runSteps({ edit: 'shift', by: -1 }, 'Steps: earlier'),
      },
      {
        label: 'Vary how hard',
        onSelect: () =>
          void runSteps({ edit: 'humanize', amount: 14, seed: Math.floor(Math.random() * 1e6) + 1 }, 'Steps: varied'),
      },
      'sep',
      {
        label: 'Clear the page',
        onSelect: () => void runSteps({ edit: 'clear-row' }, length ? 'Steps: page cleared' : 'Steps cleared'),
      },
    ];
  };
  const grids = (
    <select
      className="select"
      value={grid}
      title="The step: how the bar is divided"
      aria-label="Step"
      onChange={(e) => store.set({ stepGrid: e.target.value })}
    >
      {STEP_GRIDS.map((g) => (
        <option key={g} value={g}>
          {g}
        </option>
      ))}
    </select>
  );
  const swingButton = (
    <button
      type="button"
      className={`btn step-swing${swing > 0.02 ? ' on' : ''}`}
      title={swings(size) ? 'Swing: every other step falls late' : 'A triplet grid has no off-steps to swing'}
      aria-haspopup="menu"
      disabled={!swings(size)}
      onClick={(e) => openMenuAt(e.currentTarget, swingEntries())}
    >
      Swing{swing > 0.02 ? ` ${Math.round(swing * 100)}` : ''}
    </button>
  );
  const allEntry: MenuEntry = {
    label: 'Every pad of the kit',
    checked: all,
    onSelect: () => store.set({ stepAll: !all }),
  };
  if (layout === 'phone-portrait') {
    return (
      <UprightBar more={() => [allEntry, 'sep', ...barsEntries(), 'sep', ...pageEntries()]}>
        {grids}
        {swingButton}
      </UprightBar>
    );
  }
  return (
    <>
      {!phone && <span className="title view-title">Step Grid</span>}
      <span className="muted" style={{ whiteSpace: 'nowrap' }}>
        {track?.name ?? ''}
      </span>
      {grids}
      {swingButton}
      <button
        type="button"
        className={`btn${all ? ' on' : ''}`}
        title="A row for every pad of the kit, or only those the part plays"
        aria-pressed={all}
        onClick={() => store.set({ stepAll: !all })}
      >
        All pads
      </button>
      <span className="grow" />
      {!phone && <UndoRedo group="seg pane-undo" />}
      <button
        type="button"
        className="btn ghost icon"
        title="The page: copy it on, shift it, clear it; bars a page"
        aria-label="Page tools"
        aria-haspopup="menu"
        onClick={(e) => openMenuAt(e.currentTarget, [...pageEntries(), 'sep', ...barsEntries()])}
      >
        <Ellipsis />
      </button>
    </>
  );
}
