/**
 * The Score: the selected track's part, or every track as a full score, engraved as you'd read it
 * and kept in step with the song. Click a note to select it (the Piano Roll selects it too), click
 * anywhere else in a bar to put the playhead there; the playhead follows as it plays.
 */
import { notate, type ScoreDoc, toMEI } from '@holo/score';
import type { Note } from '@holo/session';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ensureAudio, locate } from '../app/actions.ts';
import { isPhone, useLayout } from '../app/layout.ts';
import { store, useApp } from '../app/store.ts';
import { engine } from '../audio/engine.ts';
import { useFrame, useSize } from '../ui/frame.ts';
import { buildIndex, placeOf, type ScoreIndex, tickAt } from './layout-index.ts';
import { renderScore } from './verovio.ts';

const ZOOM_RANGE: [number, number] = [20, 120];

export function ScoreBar() {
  const all = useApp((s) => s.scoreAll);
  const zoom = useApp((s) => s.scoreZoom);
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

export function Score() {
  const project = useApp((s) => s.project);
  const selectedTrack = useApp((s) => s.selectedTrack);
  const all = useApp((s) => s.scoreAll);
  const zoom = useApp((s) => s.scoreZoom);
  const selected = useApp((s) => s.selectedNotes);
  const box = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const index = useRef<ScoreIndex>({ bars: [] });
  const size = useSize(box);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);

  const track = project?.tracks.find((t) => t.id === selectedTrack);
  const part = !all && track?.kind === 'instrument' ? track.id : null;
  const doc = useMemo(
    () => (project && (all || part) ? notate(project, all ? {} : { tracks: [part as string] }) : null),
    [project, all, part],
  );
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
  useLayoutEffect(() => {
    if (page.current && doc && svg) index.current = buildIndex(page.current, doc);
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

  // a click: a note selects it (and plays it); anywhere else in a bar puts the playhead there
  const click = useRef<(e: MouseEvent) => void>(() => {});
  click.current = (e: MouseEvent) => {
    const el = page.current;
    if (!el || !doc) return;
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
      return;
    }
    const r = el.getBoundingClientRect();
    const tick = tickAt(index.current, e.clientX - r.left, e.clientY - r.top);
    if (tick !== null) {
      locate(tick);
      store.set({ selectedNotes: [] });
    }
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
    <div className="score" ref={box}>
      <div className="score-sheet">
        {/* the engraving is drawn here from the song itself (its text escaped into the MEI) */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Verovio's SVG of this song */}
        <div className="score-page" ref={page} dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="score-cursor" ref={cursor} />
      </div>
      {error && <p className="score-note bad">The score couldn’t be drawn: {error}</p>}
      {!svg && !error && <p className="score-note">Engraving…</p>}
    </div>
  );
}
