/**
 * The Score: the selected track's part, or every track as a full score, engraved as you'd read it
 * and kept in step with the song. Click a note to select it (the Piano Roll selects it too; Shift
 * adds), click anywhere else in a bar to put the playhead there; the playhead follows as it plays.
 *
 * Editing, as in a notation program: drag a note up or down the staff (a finger holds it a moment
 * first, so a swipe still scrolls), drag a box over notes with a mouse, and a right click or a long
 * press opens the menu for what's there. The keys and a touch screen's tools are in editing.ts.
 *
 * Writing (the Write button, or Shift+N): a caret on a staff takes letters, digits, a MIDI keyboard
 * and clicks on the staff (a note where you click), with a row of tools above the music.
 */
import { clefAt, keyAlters, type ScoreDoc, staffPlace, toMEI, writtenKeyAt } from '@holo/score';
import type { Note } from '@holo/session';
import { PenLine, Printer, ScanLine, ZoomIn, ZoomOut } from 'lucide-react';
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { apply, ensureAudio, locate } from '../app/actions.ts';
import { setKeyScope } from '../app/keys.ts';
import { isPhone, useLayout } from '../app/layout.ts';
import { store, useApp } from '../app/store.ts';
import { engine } from '../audio/engine.ts';
import { midi } from '../audio/midi.ts';
import { useFrame, useMedia, useSize } from '../ui/frame.ts';
import { capture, type Gesture, isMenuPress, LONG_PRESS_MS } from '../ui/gesture.ts';
import { openMenu } from '../ui/menu.tsx';
import { UndoRedo } from '../ui/UndoRedo.tsx';
import { UprightBar } from '../ui/UprightBar.tsx';
import { entry, scoreOf } from './doc.ts';
import { DraggedNotes, halfSpaceAt, nameAfter } from './drag.ts';
import {
  editState,
  hearMoved,
  moveNotes,
  noteItems,
  type StaffSpot,
  scoreKey,
  selectionIn,
  setAdding,
  spotItems,
} from './editing.ts';
import { buildIndex, placeOf, type ScoreIndex, tickAt } from './layout-index.ts';
import { Palette } from './Palette.tsx';
import { SelectionBar } from './SelectionBar.tsx';
import { renderScore } from './verovio.ts';

const ZOOM_RANGE: [number, number] = [20, 120];

/**
 * The click that ends a drag or a long press is the gesture's: let it go by (it would select, or put
 * the playhead there, or press an item of a menu that has just opened under the finger).
 */
function swallowClick(): void {
  const stop = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    done();
  };
  const done = () => {
    window.removeEventListener('click', stop, true);
    window.clearTimeout(timer);
  };
  window.addEventListener('click', stop, true);
  const timer = window.setTimeout(done, 400);
}

export function ScoreBar() {
  const all = useApp((s) => s.scoreAll);
  const zoom = useApp((s) => s.scoreZoom);
  const write = useApp((s) => s.scoreWrite);
  const trackName = useApp((s) => s.project?.tracks.find((t) => t.id === s.selectedTrack)?.name ?? '');
  const selected = useApp((s) =>
    s.project?.tracks.some((t) => t.id === s.selectedTrack && t.kind === 'instrument') ? s.selectedTrack : null,
  );
  const layout = useLayout();
  const phone = isPhone(layout);
  const concert = useApp((s) => !!s.project?.score?.concert);
  // (only a song with a transposing part has a choice to make)
  const transposes = useApp((s) => !!s.project && (concert || scoreOf(s.project).parts.some((p) => p.tr)));
  const zoomBy = (f: number) =>
    store.set({ scoreZoom: Math.round(Math.max(ZOOM_RANGE[0], Math.min(ZOOM_RANGE[1], zoom * f))) });
  const print = () => store.set({ printView: { what: all ? 'score' : (selected ?? 'score') } });
  const scan = () => store.set({ scanView: { id: null } });
  const toggleConcert = () => {
    const p = store.get().project;
    if (!p) return;
    const { concert: _, ...rest } = p.score ?? {};
    const score = concert ? rest : { ...rest, concert: true };
    apply(
      [{ op: 'setProject', patch: { score: Object.keys(score).length ? score : null } }],
      concert ? 'Score: transposed' : 'Score: concert pitch',
    );
  };
  const parts = (
    <div className="seg">
      <button
        type="button"
        className={`btn${all ? '' : ' on'}`}
        title="The selected track's part"
        onClick={() => store.set({ scoreAll: false })}
      >
        Part
      </button>
      <button
        type="button"
        className={`btn${all ? ' on' : ''}`}
        title="Every track, as a full score"
        onClick={() => store.set({ scoreAll: true })}
      >
        Full score
      </button>
    </div>
  );
  const writeButton = (
    <button
      type="button"
      className={`btn${write ? ' on' : ''}`}
      title={
        write ? 'Stop writing (Esc)' : 'Write notes: type letters, play a MIDI keyboard, or click on a staff (Shift N)'
      }
      aria-pressed={write}
      onClick={() => store.set({ scoreWrite: !write })}
    >
      <PenLine />
      {!phone && 'Write'}
    </button>
  );
  if (layout === 'phone-portrait') {
    // upright, the bar keeps the part and writing; printing, scanning, concert pitch and the size are behind ⋯
    return (
      <UprightBar
        more={() => [
          { label: 'Print…', onSelect: print },
          { label: 'Scan…', onSelect: scan },
          ...(transposes ? [{ label: 'Concert pitch', checked: concert, onSelect: toggleConcert }] : []),
          'sep',
          { label: 'Larger', onSelect: () => zoomBy(1 / 0.85) },
          { label: 'Smaller', onSelect: () => zoomBy(0.85) },
        ]}
      >
        {parts}
        {writeButton}
      </UprightBar>
    );
  }
  return (
    <>
      {!phone && <span className="title view-title">Score</span>}
      {!all && (
        <span className="muted" style={{ whiteSpace: 'nowrap' }}>
          {trackName}
        </span>
      )}
      {parts}
      {writeButton}
      <button type="button" className="btn" title="Print the score or its parts, or save them as a PDF" onClick={print}>
        <Printer />
        {!phone && 'Print'}
      </button>
      <button type="button" className="btn" title="Scan sheet music: photos or PDFs read into this song" onClick={scan}>
        <ScanLine />
        {!phone && 'Scan'}
      </button>
      {transposes && (
        <button
          type="button"
          className={`btn${concert ? ' on' : ''}`}
          title={
            concert
              ? 'Concert pitch: every part as it sounds. Click for the parts as their players read them'
              : 'Transposed: each part as its player reads it. Click for concert pitch'
          }
          aria-pressed={concert}
          onClick={toggleConcert}
        >
          {phone ? 'C' : 'Concert'}
        </button>
      )}
      <span className="grow" />
      {/* a phone has them in its control bar or side rail, on the same screen */}
      {!phone && <UndoRedo group="seg pane-undo" />}
      <button type="button" className="btn ghost icon" title="Smaller" onClick={() => zoomBy(0.85)}>
        <ZoomOut />
      </button>
      <button type="button" className="btn ghost icon" title="Larger" onClick={() => zoomBy(1 / 0.85)}>
        <ZoomIn />
      </button>
    </>
  );
}

/** The notes each drawn id stands for: a notehead its note, a chord all of its notes. */
function notesById(doc: ScoreDoc): Map<string, { track: string; notes: Note[] }> {
  const out = new Map<string, { track: string; notes: Note[] }>();
  for (const [id, ref] of doc.refs) out.set(id, { track: ref.track, notes: [ref.note] });
  for (const part of doc.parts) {
    // (a tab staff's frets are the same notes)
    for (const staff of part.tab ? [...part.staves, part.tab] : part.staves) {
      for (const b of staff.bars) {
        for (const v of b.voices) {
          for (const e of v.events) {
            if (e.kind === 'chord') out.set(e.id, { track: part.track, notes: e.heads.map((h) => h.ref.note) });
          }
        }
      }
    }
  }
  return out;
}

/** A staff by its number in the score: its part's track and its number in the part. */
function staffAt(doc: ScoreDoc, n: number): { track: string; local: number; clefs: [number, string][] } | null {
  for (const part of doc.parts) {
    for (const s of part.staves) if (s.n === n) return { track: part.track, local: s.local, clefs: s.clefs };
  }
  return null;
}

/** Played together (within a few milliseconds): one chord. */
const CHORD_MS = 45;

export function Score() {
  const project = useApp((s) => s.project);
  const selectedTrack = useApp((s) => s.selectedTrack);
  const all = useApp((s) => s.scoreAll);
  const zoom = useApp((s) => s.scoreZoom);
  const selected = useApp((s) => s.selectedNotes);
  const write = useApp((s) => s.scoreWrite);
  // a touch screen has the selected notes' tools under the music (a mouse has the menu and the keys)
  const coarse = useMedia('(pointer: coarse)');
  const layout = useLayout();
  const touchTools = coarse || isPhone(layout);
  const box = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const caretEl = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const boxEl = useRef<HTMLDivElement>(null);
  const index = useRef<ScoreIndex>({ bars: [] });
  const size = useSize(box);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const caret = useSyncExternalStore(
    (fn) => entry.subscribe(fn),
    () => entry.state,
  );

  const track = project?.tracks.find((t) => t.id === selectedTrack);
  const part = !all && track?.kind === 'instrument' ? track.id : null;
  const doc = useMemo(() => (project && (all || part) ? scoreOf(project) : null), [project, all, part]);
  const ids = useMemo(() => (doc ? notesById(doc) : new Map()), [doc]);
  // a narrow screen leaves the parts' names out: the music needs the width
  const narrow = size.w > 0 && size.w < 600;
  const mei = useMemo(() => (doc ? toMEI(doc, { credits: false, labels: !narrow }) : null), [doc, narrow]);

  useEffect(() => {
    // the width inside a scrollbar, which the box's own size counts
    const width = Math.min(size.w, box.current?.clientWidth ?? size.w);
    if (!mei || width < 60) return;
    let live = true;
    renderScore(mei, {
      scale: zoom,
      pageWidth: Math.round(((width - 2) * 100) / zoom),
      pageHeight: 60000,
      adjustPageHeight: true,
      breaks: 'auto',
      header: 'none',
      footer: 'none',
      pageMarginTop: 30,
      pageMarginBottom: 30,
      // room on the left for the longest part name (a fifth of the width at most)
      pageMarginLeft: narrow
        ? 30
        : Math.min(30 + Math.max(0, ...(doc?.parts.map((p) => p.name.length) ?? [0])) * 22, ((width - 2) * 20) / zoom),
      pageMarginRight: 30,
    })
      .then((pages) => {
        if (!live || !pages) return;
        setSvg(pages[0] ?? '');
        setError(null);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [mei, doc, narrow, size.w, zoom]);

  // where everything landed, once it's on the page
  const [placed, setPlaced] = useState(0);
  useLayoutEffect(() => {
    if (page.current && doc && svg) {
      index.current = buildIndex(page.current, doc);
      setPlaced((n) => n + 1);
    }
  }, [svg, doc]);

  // the selection, shared with the Piano Roll
  useLayoutEffect(() => {
    const el = page.current;
    if (!el || !doc || !svg) return;
    for (const n of el.querySelectorAll('.sel')) n.classList.remove('sel');
    if (!selected.length) return;
    const chosen = new Set(selected);
    for (const [id, ref] of doc.refs) if (chosen.has(ref.note)) el.querySelector(`[id="${id}"]`)?.classList.add('sel');
  }, [selected, svg, doc]);
  // nothing selected here: a tap selects one note again
  useEffect(() => {
    if (!doc || !selectionIn(doc, selected).length) setAdding(false);
  }, [doc, selected]);

  // writing: start at the selected note or the playhead, on the part shown; keys and MIDI come here
  useEffect(() => {
    if (!write || !doc) {
      if (!write) entry.stop();
      return;
    }
    if (!entry.state || !doc.parts.some((p) => p.track === entry.state?.track)) {
      const p = store.get().project;
      const sel = store.get().selectedNotes[0];
      let at = Math.max(0, engine.positionTick());
      if (p && sel) {
        for (const t of p.tracks) for (const r of t.regions) if (r.notes.includes(sel)) at = r.start + sel.t;
      }
      entry.start(doc, selectedTrack, at);
    }
  }, [write, doc, selectedTrack]);
  // the Score takes keys first while it's open (copy and paste, and writing's or editing's keys)
  useEffect(() => {
    setKeyScope(scoreKey);
    return () => setKeyScope(null);
  }, []);
  useEffect(() => {
    if (!write) return;
    let chord: number[] = [];
    let timer = 0;
    const off = midi.onEvent((e) => {
      const on = (e.status & 0xf0) === 0x90 && e.d2 > 0;
      if (!on) return;
      chord.push(e.d1);
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const notes = [...new Set(chord)].sort((a, b) => a - b);
        chord = [];
        entry.pitches(notes);
      }, CHORD_MS);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [write]);
  // leaving the Score stops writing (and selecting more)
  useEffect(
    () => () => {
      store.set({ scoreWrite: false });
      setAdding(false);
    },
    [],
  );

  // the caret: where the next note goes, on its staff
  // biome-ignore lint/correctness/useExhaustiveDependencies: redrawn when the page is placed again
  useLayoutEffect(() => {
    const el = caretEl.current;
    if (!el) return;
    if (!caret || !doc) {
      el.style.display = 'none';
      return;
    }
    const at = placeOf(index.current, caret.tick);
    const part = doc.parts.find((p) => p.track === caret.track);
    const n = part?.staves[caret.staff - 1]?.n;
    const bars = index.current.bars;
    let bar = bars[0];
    for (const b of bars) if (b.bar.start <= caret.tick) bar = b;
    const staff = bar?.staves.find((s) => s.n === n);
    if (!at || !staff || !bar) {
      el.style.display = 'none';
      return;
    }
    const past = caret.tick >= bar.bar.start + bar.bar.length;
    const x = past ? bar.right + 6 : at.x - 4;
    el.style.display = '';
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(staff.top) - 10}px)`;
    el.style.height = `${Math.round(staff.bottom - staff.top) + 20}px`;
  }, [caret, doc, placed]);

  // the playhead, and keeping it in view while it plays
  useFrame(() => {
    const c = cursor.current;
    const b = box.current;
    if (!c || !b) return;
    const at = placeOf(index.current, Math.max(0, engine.positionTick()));
    if (!at) {
      c.style.display = 'none';
      return;
    }
    c.style.display = '';
    c.style.transform = `translate(${Math.round(at.x) - 1}px, ${Math.round(at.top) - 8}px)`;
    c.style.height = `${Math.round(at.bottom - at.top) + 16}px`;
    const s = store.get();
    if (s.playing && s.follow) {
      const above = at.top - 24 < b.scrollTop;
      const below = at.bottom + 24 > b.scrollTop + b.clientHeight;
      if (above || below) b.scrollTop = Math.max(0, at.top - 32);
    }
  });

  /** The staff nearest a place on the page, in the bar there: its bar, its lines, and its part's track and number. */
  const staffNear = (x: number, y: number) => {
    const bar = index.current.bars.find((b) => x >= b.left && x <= b.right && y >= b.top - 60 && y <= b.bottom + 60);
    const staff = bar?.staves.reduce((best, s) => {
      const d = (v: { top: number; bottom: number }) => (y < v.top ? v.top - y : y > v.bottom ? y - v.bottom : 0);
      return !best || d(s) < d(best) ? s : best;
    }, bar?.staves[0]);
    const where = staff && doc ? staffAt(doc, staff.n) : null;
    return bar && staff && where ? { bar, staff, where } : null;
  };

  /** A place on a staff, from a place on the page (the menus' "here"). */
  const spotAt = (clientX: number, clientY: number): StaffSpot | null => {
    const el = page.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    const tick = tickAt(index.current, x, y);
    const near = staffNear(x, y);
    return tick !== null && near ? { track: near.where.track, staff: near.where.local, tick } : null;
  };

  // a click: a note selects it (and plays it); while writing, a click on a staff writes a note there;
  // anywhere else in a bar puts the playhead there
  const click = useRef<(e: MouseEvent) => void>(() => {});
  click.current = (e: MouseEvent) => {
    const el = page.current;
    const p = store.get().project;
    if (!el || !doc || !p) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const hit = (e.target as Element).closest('g.note, g.chord');
    const found = hit ? ids.get(hit.getAttribute('id') ?? '') : undefined;
    const adding = e.shiftKey || editState().adding;
    if (found) {
      const current = store.get().selectedNotes;
      const next = adding
        ? found.notes.every((n: Note) => current.includes(n))
          ? current.filter((n) => !found.notes.includes(n))
          : [...current, ...found.notes.filter((n: Note) => !current.includes(n))]
        : found.notes;
      store.set({ selectedNotes: next, selectedTrack: found.track });
      void ensureAudio().then(() => {
        for (const n of found.notes) engine.audition(found.track, n.p, n.v, 400);
      });
      // while writing, the caret moves to the note (the next one goes after it)
      if (write && entry.state) {
        const note = found.notes[0] as Note;
        for (const t of p.tracks) {
          for (const reg of t.regions) {
            if (!reg.notes.includes(note)) continue;
            const at = reg.start + note.t;
            const place = doc.parts
              .flatMap((pt) => pt.staves.map((s) => ({ pt, s })))
              .find(({ s }) =>
                s.bars.some((b) =>
                  b.voices.some((v) =>
                    v.events.some((ev) => ev.kind === 'chord' && ev.heads.some((h) => h.ref.note === note)),
                  ),
                ),
              );
            entry.place({ track: t.id, staff: place?.s.local ?? 1, voice: entry.state.voice, tick: at });
          }
        }
      }
      return;
    }
    const tick = tickAt(index.current, x, y);
    if (tick === null) return;
    if (write && entry.state) {
      // which staff, and which line or space on it
      const near = staffNear(x, y);
      if (!near) return;
      const { bar, staff, where } = near;
      const len = entry.length();
      const at = bar.bar.start + Math.max(0, Math.floor((tick - bar.bar.start) / len + 0.25)) * len;
      const half = (staff.bottom - staff.top) / 8;
      const steps = Math.round((y - staff.top) / half);
      const place = staffPlace(clefAt(where.clefs, at), steps);
      const alter = keyAlters(writtenKeyAt(p, doc, where.track, at))[place.step] ?? 0;
      store.set({ selectedTrack: where.track });
      entry.noteAt({ track: where.track, staff: where.local, voice: entry.state.voice, tick: at }, { ...place, alter });
      return;
    }
    locate(tick);
    // (selecting more, a tap beside the notes keeps them)
    if (!editState().adding) store.set({ selectedNotes: [] });
  };

  // pressing on the page: a note dragged up or down the staff (a mouse as it moves, a finger once it's
  // held: a finger that moves first scrolls the page), a box drawn with a mouse beside the notes, a
  // finger held still for the menu
  const gesture = useRef<Gesture | null>(null);
  /** A finger is holding a note: the page doesn't scroll under it. */
  const holding = useRef(false);
  /** Fingers down on the page now (a second one is a pinch or a scroll, not a press). */
  const fingers = useRef(new Set<number>());
  const lastPointer = useRef('mouse');
  useEffect(() => () => gesture.current?.abort(), []);

  const showTip = (text: string, clientX: number, clientY: number, touch: boolean) => {
    const t = tip.current;
    const sheet = page.current?.parentElement;
    const view = box.current;
    if (!t || !sheet || !view) return;
    const r = sheet.getBoundingClientRect();
    t.textContent = text;
    t.style.display = text ? '' : 'none';
    // above a finger (which would cover it), beside a mouse; beside the finger too where the music's
    // top edge (or the writing tools pinned there) leaves no room above it
    const top = Math.max(
      view.getBoundingClientRect().top,
      view.querySelector('.score-palette')?.getBoundingClientRect().bottom ?? 0,
    );
    let x = clientX + (touch ? -18 : 16);
    let y = clientY - (touch ? 64 : 30);
    if (y < top + 4) {
      x = clientX + (touch ? 36 : 16);
      y = Math.max(top + 4, clientY - 14);
    }
    t.style.transform = `translate(${Math.round(x - r.left)}px, ${Math.round(y - r.top)}px)`;
  };
  const hideTip = () => {
    if (tip.current) tip.current.style.display = 'none';
  };

  const pressNote = (e: ReactPointerEvent<HTMLDivElement>, found: { track: string; notes: Note[] }, touch: boolean) => {
    const el = page.current;
    const p = store.get().project;
    if (!el || !doc || !p) return;
    const r = el.getBoundingClientRect();
    const half = halfSpaceAt(index.current, e.clientX - r.left, e.clientY - r.top);
    const drums = !!doc.parts.find((x) => x.track === found.track)?.drums;
    const held = found.notes[0] as Note;
    const spot = spotAt(e.clientX, e.clientY);
    let drag: DraggedNotes | null = null;
    let lifted = false;
    let timer = 0;
    // what a drag moves: the selection when it holds this note, else this note (or chord, by its stem)
    const lift = () => {
      lifted = true;
      const sel = store.get().selectedNotes;
      const inSel = found.notes.every((n) => sel.includes(n));
      const moving = inSel ? selectionIn(doc, sel) : found.notes;
      if (!inSel) store.set({ selectedNotes: moving, selectedTrack: found.track });
      if (!drums) drag = new DraggedNotes(el, doc, moving, e.clientY, half, touch);
    };
    const end = () => {
      window.clearTimeout(timer);
      holding.current = false;
      drag?.drop();
      hideTip();
      if (gesture.current === g) gesture.current = null;
    };
    const g = capture(e, {
      lazy: true,
      onMove: (ev, gg) => {
        if (!lifted) {
          // a finger that moves before it's held is scrolling; a mouse lifts the note as it moves
          if (touch || !gg.moved) return;
          lift();
        }
        if (drag?.follow(ev.clientY)) {
          showTip(nameAfter(p, doc, held, drag.steps), ev.clientX, ev.clientY, touch);
          hearMoved(found.track, drag.notes, drag.steps);
        }
      },
      onUp: (ev, gg) => {
        const steps = drag?.steps ?? 0;
        const moving = drag?.notes ?? [];
        const wasLifted = lifted;
        end();
        // a tap: the click selects the note
        if (!wasLifted) return;
        swallowClick();
        if (steps) moveNotes(moving, steps);
        else if (touch && !gg.moved) openMenu(ev.clientX, ev.clientY, noteItems(doc, spot, touchTools, false));
      },
      onAbort: end,
    });
    gesture.current = g;
    if (touch) {
      timer = window.setTimeout(() => {
        if (gesture.current !== g || g.moved) return;
        lift();
        holding.current = true;
        navigator.vibrate?.(10);
        hearMoved(found.track, drag?.notes ?? found.notes, 0);
        if (drag) showTip(nameAfter(p, doc, held, 0), e.clientX, e.clientY, true);
      }, LONG_PRESS_MS);
    }
  };

  /** A finger held still beside the notes: the menu for that place. */
  const pressSpot = (e: ReactPointerEvent<HTMLDivElement>) => {
    const spot = spotAt(e.clientX, e.clientY);
    if (!spot) return;
    let timer = 0;
    const end = () => {
      window.clearTimeout(timer);
      if (gesture.current === g) gesture.current = null;
    };
    const g = capture(e, { lazy: true, onUp: end, onAbort: end });
    gesture.current = g;
    timer = window.setTimeout(() => {
      if (gesture.current !== g || g.moved) return;
      const at = g.last;
      g.abort();
      navigator.vibrate?.(10);
      swallowClick();
      openMenu(at.clientX, at.clientY, spotItems(spot, false));
    }, LONG_PRESS_MS);
  };

  /** A mouse dragged beside the notes: a box, and the notes in it selected (with Shift, added). */
  const pressBox = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = page.current;
    const b = boxEl.current;
    if (!el || !b) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const add = e.shiftKey;
    const rect = (ev: PointerEvent) => ({
      left: Math.min(x0, ev.clientX),
      right: Math.max(x0, ev.clientX),
      top: Math.min(y0, ev.clientY),
      bottom: Math.max(y0, ev.clientY),
    });
    const end = () => {
      b.style.display = 'none';
      if (gesture.current === g) gesture.current = null;
    };
    const g = capture(e, {
      lazy: true,
      threshold: 4,
      onMove: (ev, gg) => {
        if (!gg.moved) return;
        const sheet = el.parentElement?.getBoundingClientRect();
        if (!sheet) return;
        const r = rect(ev);
        b.style.display = '';
        b.style.transform = `translate(${Math.round(r.left - sheet.left)}px, ${Math.round(r.top - sheet.top)}px)`;
        b.style.width = `${Math.round(r.right - r.left)}px`;
        b.style.height = `${Math.round(r.bottom - r.top)}px`;
      },
      onUp: (ev, gg) => {
        end();
        if (!gg.moved) return;
        swallowClick();
        const r = rect(ev);
        const picked = new Set<Note>(add ? store.get().selectedNotes : []);
        let track: string | null = null;
        for (const head of el.querySelectorAll('g.note')) {
          const h = head.getBoundingClientRect();
          if (h.right < r.left || h.left > r.right || h.bottom < r.top || h.top > r.bottom) continue;
          const found = ids.get(head.getAttribute('id') ?? '');
          if (!found) continue;
          track ??= found.track;
          for (const n of found.notes) picked.add(n);
        }
        store.set({ selectedNotes: [...picked], ...(track ? { selectedTrack: track } : {}) });
      },
      onAbort: end,
    });
    gesture.current = g;
  };

  const press = (e: ReactPointerEvent<HTMLDivElement>) => {
    lastPointer.current = e.pointerType;
    const touch = e.pointerType === 'touch';
    if (touch) {
      const id = e.pointerId;
      fingers.current.add(id);
      const gone = (ev: PointerEvent) => {
        if (ev.pointerId !== id) return;
        fingers.current.delete(id);
        window.removeEventListener('pointerup', gone);
        window.removeEventListener('pointercancel', gone);
      };
      window.addEventListener('pointerup', gone);
      window.addEventListener('pointercancel', gone);
    }
    // a second finger ends the first one's press
    gesture.current?.abort();
    if (fingers.current.size > 1 || isMenuPress(e) || e.button !== 0) return;
    const hit = (e.target as Element).closest('g.note, g.chord');
    const found = hit ? ids.get(hit.getAttribute('id') ?? '') : undefined;
    if (found) pressNote(e, found, touch);
    else if (touch) pressSpot(e);
    else pressBox(e);
  };

  /** A right click: the menu for the note there (selected, if it wasn't), or for the place. */
  const contextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    // (a finger held still has its own menu, from the press)
    if (lastPointer.current === 'touch' || !doc) return;
    const hit = (e.target as Element).closest('g.note, g.chord');
    const found = hit ? ids.get(hit.getAttribute('id') ?? '') : undefined;
    const spot = spotAt(e.clientX, e.clientY);
    if (found) {
      const sel = store.get().selectedNotes;
      if (!found.notes.every((n: Note) => sel.includes(n)))
        store.set({ selectedNotes: found.notes, selectedTrack: found.track });
      openMenu(e.clientX, e.clientY, noteItems(doc, spot, touchTools));
    } else if (spot) openMenu(e.clientX, e.clientY, spotItems(spot));
  };

  useEffect(() => {
    const el = page.current;
    if (!el) return;
    const on = (e: MouseEvent) => click.current(e);
    // a finger holding a note keeps the page still (one that moves before then scrolls it, as ever)
    const still = (e: TouchEvent) => {
      if (holding.current && e.cancelable) e.preventDefault();
    };
    el.addEventListener('click', on);
    el.addEventListener('touchmove', still, { passive: false });
    return () => {
      el.removeEventListener('click', on);
      el.removeEventListener('touchmove', still);
    };
  });

  if (!project) return <div className="score" />;
  if (!all && !part) {
    return (
      <div className="score empty">
        <p>Select an instrument track to see its part, or show the full score.</p>
      </div>
    );
  }

  return (
    <div className={`score${write ? ' writing' : ''}${touchTools ? ' touch-tools' : ''}`} ref={box}>
      {write && <Palette entry={entry} />}
      <div className="score-sheet">
        {/* the engraving is drawn here from the song itself (its text escaped into the MEI) */}
        <div
          className="score-page"
          ref={page}
          onPointerDown={press}
          onContextMenu={contextMenu}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Verovio's SVG of this song
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <div className="score-cursor" ref={cursor} />
        <div className="score-caret" ref={caretEl} />
        <div className="score-box" ref={boxEl} style={{ display: 'none' }} />
        <div className="score-drag-tip" ref={tip} style={{ display: 'none' }} />
      </div>
      {error && <p className="score-note bad">The score couldn’t be drawn: {error}</p>}
      {!svg && !error && <p className="score-note">Engraving…</p>}
      {touchTools && doc && svg && <SelectionBar doc={doc} />}
    </div>
  );
}
