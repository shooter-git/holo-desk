/**
 * The Score: the selected track's part, or every track as a full score, engraved as you'd read it
 * and kept in step with the song. Click a note to select it (the Piano Roll selects it too), click
 * anywhere else in a bar to put the playhead there; the playhead follows as it plays.
 *
 * Writing (the Write button, or Shift+N): a caret on a staff takes letters, digits, a MIDI keyboard
 * and clicks on the staff (a note where you click), with a row of tools above the music.
 */
import { clefAt, keyAlters, notate, type ScoreDoc, staffPlace, toMEI, writtenKeyAt } from '@holo/score';
import type { Note, Project } from '@holo/session';
import { PenLine, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ensureAudio, locate } from '../app/actions.ts';
import { setKeyScope } from '../app/keys.ts';
import { isPhone, useLayout } from '../app/layout.ts';
import { store, useApp } from '../app/store.ts';
import { engine } from '../audio/engine.ts';
import { midi } from '../audio/midi.ts';
import { useFrame, useSize } from '../ui/frame.ts';
import { Entry } from './entry.ts';
import { buildIndex, placeOf, type ScoreIndex, tickAt } from './layout-index.ts';
import { Palette } from './Palette.tsx';
import { renderScore } from './verovio.ts';

const ZOOM_RANGE: [number, number] = [20, 120];

/** The score as laid out now: shared by the drawing and the writing, made again only when the song changes. */
let cached: { project: Project; key: string; doc: ScoreDoc } | null = null;

function scoreOf(project: Project): ScoreDoc {
  const s = store.get();
  const track = project.tracks.find((t) => t.id === s.selectedTrack);
  const part = !s.scoreAll && track?.kind === 'instrument' ? track.id : null;
  const key = s.scoreAll ? '*' : (part ?? '');
  if (cached && cached.project === project && cached.key === key) return cached.doc;
  const doc = notate(project, s.scoreAll || !part ? {} : { tracks: [part] });
  cached = { project, key, doc };
  return doc;
}

const entry = new Entry(scoreOf);

export function ScoreBar() {
  const all = useApp((s) => s.scoreAll);
  const zoom = useApp((s) => s.scoreZoom);
  const write = useApp((s) => s.scoreWrite);
  const trackName = useApp((s) => s.project?.tracks.find((t) => t.id === s.selectedTrack)?.name ?? '');
  const phone = isPhone(useLayout());
  const zoomBy = (f: number) =>
    store.set({ scoreZoom: Math.round(Math.max(ZOOM_RANGE[0], Math.min(ZOOM_RANGE[1], zoom * f))) });
  return (
    <>
      {!phone && <span className="title">Score</span>}
      {!all && (
        <span className="muted" style={{ whiteSpace: 'nowrap' }}>
          {trackName}
        </span>
      )}
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
      <button
        type="button"
        className={`btn${write ? ' on' : ''}`}
        title={
          write
            ? 'Stop writing (Esc)'
            : 'Write notes: type letters, play a MIDI keyboard, or click on a staff (Shift N)'
        }
        aria-pressed={write}
        onClick={() => store.set({ scoreWrite: !write })}
      >
        <PenLine />
        {!phone && 'Write'}
      </button>
      <span className="grow" />
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
    for (const staff of part.staves) {
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
  const box = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const caretEl = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    if (!write) return;
    setKeyScope((e) => entry.key_(e));
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
      setKeyScope(null);
      off();
      clearTimeout(timer);
    };
  }, [write]);
  // leaving the Score stops writing
  useEffect(() => () => store.set({ scoreWrite: false }), []);

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
    if (found) {
      const current = store.get().selectedNotes;
      const next = e.shiftKey
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
      const bar = index.current.bars.find((b) => x >= b.left && x <= b.right && y >= b.top - 60 && y <= b.bottom + 60);
      const staff = bar?.staves.reduce((best, s) => {
        const d = (v: { top: number; bottom: number }) => (y < v.top ? v.top - y : y > v.bottom ? y - v.bottom : 0);
        return !best || d(s) < d(best) ? s : best;
      }, bar?.staves[0]);
      const where = staff ? staffAt(doc, staff.n) : null;
      if (!bar || !staff || !where) return;
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
    store.set({ selectedNotes: [] });
  };
  useEffect(() => {
    const el = page.current;
    if (!el) return;
    const on = (e: MouseEvent) => click.current(e);
    el.addEventListener('click', on);
    return () => el.removeEventListener('click', on);
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
    <div className={`score${write ? ' writing' : ''}`} ref={box}>
      {write && <Palette entry={entry} />}
      <div className="score-sheet">
        {/* the engraving is drawn here from the song itself (its text escaped into the MEI) */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Verovio's SVG of this song */}
        <div className="score-page" ref={page} dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="score-cursor" ref={cursor} />
        <div className="score-caret" ref={caretEl} />
      </div>
      {error && <p className="score-note bad">The score couldn’t be drawn: {error}</p>}
      {!svg && !error && <p className="score-note">Engraving…</p>}
    </div>
  );
}
