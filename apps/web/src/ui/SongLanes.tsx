/**
 * The Arrangement and Chords lanes, under the tracks' ruler (View switches each on).
 *
 * - **Arrangement**: the song's sections, a block from each marker to the next. Drag a block to move
 *   its bars (everything in them: the `arrange` operation), Alt-drag to copy them; drag the line
 *   between two blocks to move the marker; double-click to rename; the menu (a right click, or a tap
 *   on a touch screen) has the rest. A finger holds a block, then drags it, so a swipe still scrolls.
 * - **Chords**: the song's chord symbols, the ones the Score writes over its staves. Click one to
 *   change it, an empty beat to write one there, and drag one to another beat.
 *
 * Nothing is kept for either beyond the song's own `markers` and `chords`.
 */
import { chordOps, moveChordOps, type Section, sections } from '@holo/agent/edits';
import { type ChordMark, type Marker, meterAt, type Project, ticksPerBar } from '@holo/session';
import { Plus } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from 'react';
import { addSectionAt, addSectionAtPlayhead, apply, playheadTick } from '../app/actions.ts';
import { store, useApp } from '../app/store.ts';
import { alpha, movePlayhead, prepare, roundRect, useFrame, useSize } from './frame.ts';
import { isMenuPress, LONG_PRESS_MS, useWheel } from './gesture.ts';
import {
  barStart,
  beatStart,
  chordAt,
  chordsShown,
  chordWidth,
  dropPlace,
  edgeAt,
  edgePlace,
  type LaneRows,
  laneAt,
  lanesHeight,
  sectionAt,
  sectionColor,
} from './lanes.ts';
import { type MenuEntry, openMenu } from './menu.tsx';
import { TouchPan, type Viewport } from './view.ts';

const FONT = '600 10.5px Inter Variable, system-ui, sans-serif';
const FONT_TOUCH = '600 12px Inter Variable, system-ui, sans-serif';
/** How near a marker's line a mouse grabs it, pixels. */
const EDGE = 5;

type Drag =
  | { kind: 'section'; section: Section; grab: number; tick: number; place: number | null; copy: boolean }
  | { kind: 'edge'; section: Section; at: number }
  | { kind: 'chord'; chord: ChordMark; at: number };

type Edit =
  | { kind: 'section'; marker: string; tick: number; text: string }
  | { kind: 'chord'; tick: number; text: string };

/** Asked of the lanes from outside (the + in their head): start naming this marker. */
let renameAsked: ((marker: string) => void) | null = null;

/** The lanes' names, left of them: the heads column's foot. */
export function SongLaneHeads({ rows, short }: { rows: LaneRows; short: boolean }) {
  return (
    <div className={`lane-heads${short ? ' short' : ''}`} style={{ height: lanesHeight(rows) }}>
      {rows.arrangement && (
        <div className="lane-head" style={{ height: rows.row }}>
          {!short && <span className="name">Arrangement</span>}
          <button
            type="button"
            className="btn ghost icon lane-add"
            title="Add a section at the playhead’s bar"
            aria-label="Add a section at the playhead"
            onClick={() => {
              const id = addSectionAtPlayhead();
              if (id) renameAsked?.(id);
            }}
          >
            <Plus />
          </button>
        </div>
      )}
      {rows.chords && (
        <div className="lane-head" style={{ height: rows.row }}>
          <span className="name">{short ? 'Chd' : 'Chords'}</span>
        </div>
      )}
    </div>
  );
}

export function SongLanes({
  view,
  rows,
  onWheel,
}: {
  view: Viewport;
  rows: LaneRows;
  onWheel: (e: WheelEvent, dx: number, dy: number) => void;
}) {
  const project = useApp((s) => s.project);
  const markers = project?.markers;
  const chords = project?.chords;
  const meter = project?.meter;
  const tracks = project?.tracks;
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const size = useSize(box);
  const dirty = useRef(true);
  const drag = useRef<Drag | null>(null);
  const lastClick = useRef({ at: 0, x: 0 });
  const [edit, setEdit] = useState<Edit | null>(null);
  const editing = useRef<Edit | null>(null);
  editing.current = edit;
  const touchRows = rows.row > 24;

  // biome-ignore lint/correctness/useExhaustiveDependencies: what the lanes draw from; any of it changing redraws them
  useEffect(() => {
    dirty.current = true;
  }, [markers, chords, meter, tracks, rows.arrangement, rows.chords, rows.row, size, edit]);
  useEffect(
    () =>
      view.subscribe(() => {
        dirty.current = true;
      }),
    [view],
  );
  useWheel(box, onWheel);

  const startRename = useCallback((marker: string) => {
    const m = store.get().project?.markers.find((x) => x.id === marker);
    if (m) setEdit({ kind: 'section', marker: m.id, tick: m.tick, text: m.name });
  }, []);
  useEffect(() => {
    renameAsked = startRename;
    return () => {
      if (renameAsked === startRename) renameAsked = null;
    };
  }, [startRename]);
  // what's there is selected as it opens, to be typed over (not again at each letter typed)
  const editKey = edit ? `${edit.kind}:${edit.kind === 'section' ? edit.marker : edit.tick}` : '';
  useEffect(() => {
    if (editKey) input.current?.select();
  }, [editKey]);

  /** Where the field for what's typed at a tick sits: at its place, kept inside the lanes. */
  const entryX = (tick: number) => Math.max(2, Math.min(size.w - 150, view.tickToX(tick) + 2));

  // ---- drawing ----

  const draw = (p: Project) => {
    const w = size.w;
    const h = lanesHeight(rows);
    const ctx = prepare(canvas.current, w, h, true);
    if (!ctx) return;
    const d = drag.current;
    ctx.fillStyle = '#15181c';
    ctx.fillRect(0, 0, w, h);
    ctx.font = touchRows ? FONT_TOUCH : FONT;
    ctx.textBaseline = 'middle';
    let top = 0;
    if (rows.arrangement) {
      const list = sections(p);
      const row = rows.row;
      const block = (s: Section, x0: number, x1: number, ghost: boolean) => {
        if (x1 < 0 || x0 > w) return;
        const color = sectionColor(list, s);
        ctx.globalAlpha = !ghost && d?.kind === 'section' && d.section.id === s.id && !d.copy ? 0.35 : 1;
        if (ghost) {
          // (the block in hand covers what it's over: its name isn't read through another's)
          ctx.fillStyle = '#15181c';
          roundRect(ctx, x0 + 1, top + 2, Math.max(3, x1 - x0 - 2), row - 5, 4);
          ctx.fill();
        }
        ctx.fillStyle = alpha(color, ghost ? 1 : 0.85);
        roundRect(ctx, x0 + 1, top + 2, Math.max(3, x1 - x0 - 2), row - 5, 4);
        ctx.fill();
        if (!s.whole) {
          // its marker (or the next) sits inside a bar: its bars can't be moved until it's on a bar line
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = '#f6c453';
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, top, Math.max(0, x1 - x0 - 4), row);
        ctx.clip();
        const tx = Math.max(x0, ghost ? x0 : 0) + 7;
        const name = s.name || (s.marker ? 'Section' : '');
        ctx.fillStyle = '#0b0d10';
        ctx.fillText(name, tx, top + row / 2 - 0.5);
        const bars = Math.round((s.to - s.from) / ticksPerBar(meterAt(p.meter, s.from)));
        ctx.fillStyle = 'rgba(11,13,16,0.6)';
        ctx.fillText(
          `${bars} bar${bars === 1 ? '' : 's'}`,
          tx + ctx.measureText(name).width + (name ? 8 : 0),
          top + row / 2 - 0.5,
        );
        ctx.restore();
        ctx.globalAlpha = 1;
      };
      for (const s of list) block(s, view.tickToX(s.from), view.tickToX(s.to), false);
      if (!list.length) {
        ctx.fillStyle = '#6d7584';
        ctx.fillText(
          touchRows
            ? 'No sections yet: tap a bar to start one'
            : 'No sections yet: double-click a bar, or + at the left, starts one',
          8,
          top + row / 2,
        );
      }
      if (d?.kind === 'section') {
        // the block under the pointer, and the line where it would land
        const x0 = view.tickToX(d.tick - d.grab);
        block(d.section, x0, x0 + (d.section.to - d.section.from) * view.pxPerTick, true);
        if (d.place !== null) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(Math.round(view.tickToX(d.place)) - 1, top, 2, row - 1);
        }
      }
      if (d?.kind === 'edge') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(Math.round(view.tickToX(d.at)) - 1, top, 2, row - 1);
      }
      ctx.fillStyle = '#0b0d10';
      ctx.fillRect(0, top + row - 1, w, 1);
      top += row;
    }
    if (rows.chords) {
      const row = rows.row;
      const from = view.xToTick(0);
      const to = view.xToTick(w);
      // a faint line at each bar, where there's room for them
      const bar = ticksPerBar(p.meter[0] ?? { tick: 0, num: 4, den: 4 });
      if (bar * view.pxPerTick >= 14) {
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        for (let t = Math.max(0, Math.floor(from / bar) * bar); t < to; t += bar)
          ctx.fillRect(Math.round(view.tickToX(t)), top + 3, 1, row - 7);
      }
      for (const c of chordsShown(p.chords, view.pxPerTick)) {
        if (c.tick > to || (c.tick - from) * view.pxPerTick < -chordWidth(c.symbol)) continue;
        const moving = d?.kind === 'chord' && d.chord.tick === c.tick;
        const editingIt = edit?.kind === 'chord' && edit.tick === c.tick;
        if (editingIt) continue;
        ctx.fillStyle = moving ? 'rgba(216,222,232,0.35)' : '#d8dee8';
        ctx.fillText(c.symbol, view.tickToX(c.tick) + 6, top + row / 2 - 0.5);
      }
      if (d?.kind === 'chord') {
        const x = view.tickToX(d.at);
        ctx.fillStyle = 'rgba(92,184,255,0.18)';
        roundRect(ctx, x + 1, top + 2, chordWidth(d.chord.symbol), row - 5, 4);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillText(d.chord.symbol, x + 6, top + row / 2 - 0.5);
      }
      if (!p.chords.length && !edit) {
        ctx.fillStyle = '#6d7584';
        ctx.fillText(
          touchRows ? 'No chords yet: tap a beat to write one' : 'No chords yet: click a beat to write one',
          8,
          top + row / 2,
        );
      }
      ctx.fillStyle = '#0b0d10';
      ctx.fillRect(0, top + row - 1, w, 1);
    }
  };

  useFrame(() => {
    const p = store.get().project;
    if (!p) return;
    if (dirty.current) {
      dirty.current = false;
      draw(p);
      // what's being typed stays over its place as the view moves
      const e = editing.current;
      if (e && input.current) {
        input.current.style.transform = `translateX(${entryX(e.tick)}px)`;
      }
    }
    movePlayhead(
      playhead.current,
      Math.round(view.tickToX(Math.max(0, playheadTick()))),
      size.w,
      store.get().recording,
    );
  });

  // ---- edits ----

  const song = () => store.get().project;

  const rename = (marker: string, name: string) => {
    const p = song();
    const text = name.trim();
    const m = p?.markers.find((x) => x.id === marker);
    if (!p || !m || !text || text === m.name) return;
    apply(
      [
        {
          op: 'setProject',
          patch: { markers: p.markers.map((x) => (x === m ? { ...x, name: text.slice(0, 60) } : x)) },
        },
      ],
      'Rename Section',
    );
  };

  const commit = (e: Edit | null) => {
    const p = song();
    if (!e || !p) return;
    if (e.kind === 'section') rename(e.marker, e.text);
    else apply(chordOps(p, e.tick, e.text), e.text.trim() ? 'Chord' : 'Remove Chord');
  };

  const close = (keep: boolean) => {
    if (keep) commit(editing.current);
    setEdit(null);
  };

  const addSection = (tick: number) => {
    const id = addSectionAt(tick);
    if (id) startRename(id);
  };

  const arrange = (edit: 'move' | 'copy' | 'delete', s: Section, at: number | undefined, label: string) => {
    if (!s.whole) return;
    apply([{ op: 'arrange', edit, from: s.from, to: s.to, ...(at !== undefined ? { at } : {}) }], label);
  };

  const sectionMenu = (x: number, y: number, s: Section, tick: number) => {
    const p = song();
    if (!p) return;
    const list = sections(p);
    const i = list.findIndex((q) => q.id === s.id);
    const before = list[i - 1];
    const after = list[i + 1];
    const name = s.name || 'this section';
    const here = barStart(p.meter, tick);
    const entries: MenuEntry[] = [{ heading: s.name || 'Before the first marker' }];
    if (s.marker) entries.push({ label: 'Rename', onSelect: () => startRename((s.marker as Marker).id) });
    else entries.push({ label: 'Name this section', onSelect: () => addSection(0) });
    if (here > s.from && here < s.to) entries.push({ label: 'Split here', onSelect: () => addSection(here) });
    if (s.whole) {
      entries.push('sep');
      entries.push({ label: 'Repeat', onSelect: () => arrange('copy', s, s.to, `Repeat ${name}`) });
      if (before?.whole)
        entries.push({ label: 'Move earlier', onSelect: () => arrange('move', s, before.from, `Move ${name}`) });
      if (after?.whole)
        entries.push({ label: 'Move later', onSelect: () => arrange('move', s, after.to, `Move ${name}`) });
      entries.push('sep');
      entries.push({
        label: 'Delete the section and its bars',
        onSelect: () => arrange('delete', s, undefined, `Delete ${name}`),
      });
    } else if (s.marker) {
      const m = s.marker;
      entries.push({
        label: 'Move the marker to the bar line',
        onSelect: () =>
          apply(
            [
              {
                op: 'setProject',
                patch: { markers: p.markers.map((x) => (x === m ? { ...x, tick: barStart(p.meter, m.tick) } : x)) },
              },
            ],
            'Move Marker',
          ),
      });
    }
    if (s.marker && s.from > 0) {
      const m = s.marker;
      entries.push({
        label: 'Remove the marker (its bars stay)',
        onSelect: () =>
          apply([{ op: 'setProject', patch: { markers: p.markers.filter((x) => x !== m) } }], 'Remove Marker'),
      });
    }
    openMenu(x, y, entries);
  };

  const chordMenu = (x: number, y: number, c: ChordMark) => {
    openMenu(x, y, [
      { heading: c.symbol },
      { label: 'Change', onSelect: () => setEdit({ kind: 'chord', tick: c.tick, text: c.symbol }) },
      {
        label: 'Remove',
        onSelect: () => {
          const p = song();
          if (p) apply(chordOps(p, c.tick, ''), 'Remove Chord');
        },
      },
    ]);
  };

  // ---- the pointer ----

  /** What's under a point of the lanes. */
  const hit = (clientX: number, clientY: number, touch: boolean) => {
    const rect = (box.current as HTMLElement).getBoundingClientRect();
    const p = song();
    const x = clientX - rect.left;
    const tick = Math.max(0, view.xToTick(x));
    const lane = laneAt(rows, clientY - rect.top);
    if (!p || !lane) return null;
    if (lane === 'arrangement') {
      const list = sections(p);
      const edge = touch ? null : edgeAt(list, tick, EDGE / view.pxPerTick);
      return { lane, tick, section: sectionAt(list, tick), edge, chord: null };
    }
    return { lane, tick, section: null, edge: null, chord: chordAt(p.chords, tick, view.pxPerTick) };
  };

  const dragTo = (ev: PointerEvent) => {
    const d = drag.current;
    const p = song();
    if (!d || !p) return;
    const rect = (box.current as HTMLElement).getBoundingClientRect();
    const tick = Math.max(0, view.xToTick(ev.clientX - rect.left));
    if (d.kind === 'section') {
      d.tick = tick;
      d.copy = ev.altKey;
      // a copy may land where the section already is (right after itself is a repeat)
      d.place = dropPlace(sections(p), d.section, tick - d.grab + (d.section.to - d.section.from) / 2);
      if (d.copy && d.place === null)
        d.place = tick < (d.section.from + d.section.to) / 2 ? d.section.from : d.section.to;
    } else if (d.kind === 'edge') d.at = edgePlace(sections(p), d.section, p.meter, tick);
    else d.at = beatStart(p.meter, tick);
    dirty.current = true;
  };

  const drop = () => {
    const d = drag.current;
    drag.current = null;
    dirty.current = true;
    const p = song();
    if (!d || !p) return;
    if (d.kind === 'section') {
      if (d.place === null) return;
      const name = d.section.name || 'the section';
      arrange(d.copy ? 'copy' : 'move', d.section, d.place, `${d.copy ? 'Copy' : 'Move'} ${name}`);
    } else if (d.kind === 'edge') {
      const m = d.section.marker;
      if (!m || d.at === m.tick) return;
      apply(
        [{ op: 'setProject', patch: { markers: p.markers.map((x) => (x.id === m.id ? { ...x, tick: d.at } : x)) } }],
        'Move Marker',
      );
    } else apply(moveChordOps(p, d.chord.tick, d.at), 'Move Chord');
  };

  const onDown = (e: ReactPointerEvent) => {
    if (e.button === 1 || !song()) return;
    if (editing.current) close(true);
    const touch = e.pointerType === 'touch';
    const at = hit(e.clientX, e.clientY, touch);
    if (!at) return;
    if (isMenuPress(e)) {
      e.preventDefault();
      if (at.section) sectionMenu(e.clientX, e.clientY, at.section, at.tick);
      else if (at.chord) chordMenu(e.clientX, e.clientY, at.chord);
      return;
    }
    const el = e.currentTarget as HTMLElement;
    const id = e.pointerId;
    try {
      el.setPointerCapture(id);
    } catch {
      // the pointer may already be gone
    }
    const x0 = e.clientX;
    const y0 = e.clientY;
    let last: PointerEvent = e.nativeEvent;
    let mode: 'wait' | 'drag' | 'pan' = 'wait';
    const pan = touch ? new TouchPan(view, 'x', () => 0, e.nativeEvent) : null;
    // what a drag of this would move: a marker's line, a whole section, a chord
    const begin = (): boolean => {
      if (at.edge) drag.current = { kind: 'edge', section: at.edge, at: at.edge.from };
      else if (at.section?.whole)
        drag.current = {
          kind: 'section',
          section: at.section,
          grab: at.tick - at.section.from,
          tick: at.tick,
          place: null,
          copy: false,
        };
      else if (at.chord) drag.current = { kind: 'chord', chord: at.chord, at: at.chord.tick };
      else return false;
      mode = 'drag';
      dragTo(last);
      return true;
    };
    const timer = touch
      ? window.setTimeout(() => {
          if (mode === 'wait' && begin()) navigator.vibrate?.(10);
        }, LONG_PRESS_MS)
      : 0;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      last = ev;
      const far = Math.hypot(ev.clientX - x0, ev.clientY - y0);
      if (mode === 'wait') {
        if (touch && far > 10) {
          window.clearTimeout(timer);
          mode = 'pan';
        } else if (!touch && far > 3 && !begin()) mode = 'pan';
      }
      if (mode === 'pan') pan?.move(ev);
      else if (mode === 'drag') dragTo(ev);
    };
    const done = () => {
      window.clearTimeout(timer);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      done();
      if (mode === 'drag') drop();
      else if (mode === 'pan') pan?.end(ev.timeStamp);
      else tap(at, ev, touch);
    };
    const cancel = () => {
      done();
      drag.current = null;
      dirty.current = true;
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
  };

  const tap = (at: NonNullable<ReturnType<typeof hit>>, ev: PointerEvent, touch: boolean) => {
    const p = song();
    if (!p) return;
    if (at.lane === 'chords') {
      if (at.chord) setEdit({ kind: 'chord', tick: at.chord.tick, text: at.chord.symbol });
      else setEdit({ kind: 'chord', tick: beatStart(p.meter, at.tick), text: '' });
      return;
    }
    if (touch) {
      // a finger: a tap on a section is its menu (a hold, then a drag, moves it); on a song with none, the first
      if (at.section) sectionMenu(ev.clientX, ev.clientY, at.section, at.tick);
      else addSection(at.tick);
      return;
    }
    // a mouse: a double click names a section, or starts one where there's none
    const again = ev.timeStamp - lastClick.current.at < 400 && Math.abs(ev.clientX - lastClick.current.x) < 6;
    lastClick.current = { at: again ? 0 : ev.timeStamp, x: ev.clientX };
    if (!again) return;
    if (at.section?.marker) startRename(at.section.marker.id);
    else addSection(at.section ? 0 : at.tick);
  };

  /** A mouse over the lanes: what a press there would take hold of. */
  const onHover = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'mouse' || e.buttons || drag.current) return;
    const at = hit(e.clientX, e.clientY, false);
    (e.currentTarget as HTMLElement).style.cursor = !at
      ? ''
      : at.edge
        ? 'col-resize'
        : at.lane === 'chords'
          ? 'text'
          : at.section?.whole
            ? 'grab'
            : '';
  };

  const editTop = edit?.kind === 'chord' && rows.arrangement ? rows.row : 0;
  return (
    <div
      className="song-lanes"
      ref={box}
      style={{ height: lanesHeight(rows) }}
      onPointerDown={onDown}
      onPointerMove={onHover}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvas} />
      <div ref={playhead} className="playhead" />
      {edit && (
        <input
          ref={input}
          className="input lane-entry"
          // (in its place from the first paint: the tap that opened it gives it the keyboard only if it's under it)
          style={{ top: editTop + 1, height: rows.row - 3, transform: `translateX(${entryX(edit.tick)}px)` }}
          value={edit.text}
          maxLength={edit.kind === 'chord' ? 24 : 60}
          placeholder={edit.kind === 'chord' ? 'Dm7, G7/B…' : 'Section'}
          aria-label={edit.kind === 'chord' ? 'Chord symbol' : 'Section name'}
          // biome-ignore lint/a11y/noAutofocus: it opens because it was asked for, to be typed in
          autoFocus
          spellCheck={false}
          autoCapitalize={edit.kind === 'chord' ? 'off' : 'words'}
          autoCorrect="off"
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setEdit({ ...edit, text: e.currentTarget.value })}
          onBlur={() => close(true)}
          onKeyDown={(e) => {
            // (the studio's own keys stay out of what's being typed)
            e.stopPropagation();
            if (e.key === 'Escape') close(false);
            else if (e.key === 'Enter') close(true);
            else if (e.key === 'Tab' && edit.kind === 'chord') {
              // on to the next bar (Shift: the one before), what was typed kept
              e.preventDefault();
              const p = song();
              if (!p) return;
              commit(edit);
              const bar = ticksPerBar(meterAt(p.meter, edit.tick));
              const next = Math.max(0, barStart(p.meter, edit.tick) + (e.shiftKey ? -bar : bar));
              const there = (song() ?? p).chords.find((c) => c.tick === next);
              setEdit({ kind: 'chord', tick: next, text: there?.symbol ?? '' });
              view.reveal(next, size.w);
            }
          }}
        />
      )}
    </div>
  );
}
