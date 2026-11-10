/**
 * A new scan: photos or PDFs picked (or a photo taken), each page's corners set (guessed, then
 * dragged), the music found on it, and the scan sent to the host. Used by the studio's Scan window
 * and by a phone's Remote (it needs nothing of the studio's own).
 */
import type { FoundSystem, Point, Scan } from '@holo/score';
import { Camera, FileUp, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSize } from '../../ui/frame.ts';
import { listScans, type PickedPage, type PreparedPage, preparePage, readPages, saveScan } from './client.ts';

export interface NewScanProps {
  project: { id: string; title: string } | null;
  track: string | null;
  notify: (text: string) => void;
  onClose: () => void;
  onSaved: (scan: Scan) => void;
  /** Open an earlier scan of the song (the studio's review). */
  onOpen?: (id: string) => void;
}

export function NewScan({ project, track, notify, onClose, onSaved, onOpen }: NewScanProps) {
  const [pages, setPages] = useState<PickedPage[]>([]);
  const [prepared, setPrepared] = useState<(PreparedPage | null)[]>([]);
  const [current, setCurrent] = useState(0);
  const [enhance, setEnhance] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [earlier, setEarlier] = useState<Awaited<ReturnType<typeof listScans>>>([]);
  const camera = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (project) void listScans(project.id).then(setEarlier, () => setEarlier([]));
  }, [project]);
  // pictures made for showing go when the window does
  useEffect(
    () => () => {
      for (const p of pages) URL.revokeObjectURL(p.url);
    },
    [pages],
  );

  const pick = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy('Reading the pages…');
    try {
      const more = await readPages(list);
      if (!more.length) notify('Those aren’t photos or PDFs');
      setPages((p) => [...p, ...more]);
      setPrepared((p) => [...p, ...more.map(() => null)]);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const find = async () => {
    const out: (PreparedPage | null)[] = [];
    for (const [i, p] of pages.entries()) {
      setBusy(`Finding the music on page ${i + 1} of ${pages.length}…`);
      try {
        out.push(await preparePage(p, enhance));
      } catch (e) {
        out.push(null);
        notify(`Page ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setPrepared(out);
    setBusy(null);
  };

  const save = async () => {
    if (!project) return;
    const ready = prepared.filter((p): p is PreparedPage => !!p);
    setBusy('Sending the scan…');
    try {
      const scan = await saveScan(project.id, track, pages[0]?.name.replace(/\.[a-z0-9]+$/i, '') ?? 'Scan', ready);
      onSaved(scan);
      setPages([]);
      setPrepared([]);
      setBusy(null);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const systems = prepared.reduce((n, p) => n + (p?.systems.length ?? 0), 0);
  const bars = prepared.reduce(
    (n, p) => n + (p?.systems.reduce((m, s) => m + Math.max(0, s.bars.length - 1), 0) ?? 0),
    0,
  );
  const page = pages[current];
  const done = prepared[current];
  const found = prepared.some(Boolean);

  return (
    <>
      <header className="scan-bar">
        <span className="title">Scan sheet music</span>
        <span className="muted">into “{project?.title}”</span>
        <span className="grow" />
        <button type="button" className="btn ghost icon" title="Close" onClick={onClose}>
          <X />
        </button>
      </header>
      <div className="scan-body">
        {!pages.length ? (
          <div className="scan-start">
            <p>
              Photograph each page straight on, in good light, the whole page in the picture. A PDF reads best of all.
            </p>
            <div className="scan-actions">
              <button type="button" className="btn primary big" onClick={() => camera.current?.click()}>
                <Camera /> Take a photo
              </button>
              <button type="button" className="btn big" onClick={() => files.current?.click()}>
                <FileUp /> Choose photos or PDFs
              </button>
            </div>
            {onOpen && earlier.length > 0 && (
              <div className="scan-earlier">
                <h3>Scans of this song</h3>
                {earlier.map((s) => (
                  <button key={s.id} type="button" className="btn" onClick={() => onOpen(s.id)}>
                    {s.title} · {s.pages} page{s.pages === 1 ? '' : 's'} · {s.progress.approved ?? 0} approved
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="scan-pages">
            <nav className="scan-thumbs" aria-label="Pages">
              {pages.map((p, i) => (
                <button
                  key={p.url}
                  type="button"
                  className={`thumb${i === current ? ' on' : ''}`}
                  onClick={() => setCurrent(i)}
                >
                  <img src={p.url} alt={`Page ${i + 1}`} />
                  <span>{prepared[i] ? `${prepared[i]?.systems.length} systems` : `Page ${i + 1}`}</span>
                </button>
              ))}
              <button type="button" className="btn" onClick={() => files.current?.click()}>
                + Add
              </button>
            </nav>
            {page && !done && (
              <Corners
                page={page}
                onChange={(corners) => {
                  setPages((ps) => ps.map((p, i) => (i === current ? { ...p, corners } : p)));
                  setPrepared((ps) => ps.map((p, i) => (i === current ? null : p)));
                }}
              />
            )}
            {page && done && (
              <Found page={done} onRedo={() => setPrepared((ps) => ps.map((p, i) => (i === current ? null : p)))} />
            )}
          </div>
        )}
        {busy && <p className="scan-busy">{busy}</p>}
      </div>
      {pages.length > 0 && (
        <footer className="scan-bar">
          <label className="check">
            <input type="checkbox" checked={enhance} onChange={(e) => setEnhance(e.target.checked)} /> Enhance (faint or
            gray pages)
          </label>
          <span className="grow" />
          {found && (
            <span className="muted">
              {systems} system{systems === 1 ? '' : 's'}, about {bars} bars
            </span>
          )}
          <button type="button" className="btn" disabled={!!busy} onClick={() => void find()}>
            Find the music
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!!busy || !found || !systems}
            onClick={() => void save()}
          >
            Save and read
          </button>
        </footer>
      )}
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          void pick(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={files}
        type="file"
        accept="image/*,application/pdf"
        multiple
        hidden
        onChange={(e) => {
          void pick(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** A page with its four corners to drag onto the page's own corners. */
function Corners({ page, onChange }: { page: PickedPage; onChange: (c: [Point, Point, Point, Point]) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const size = useSize(box);
  const scale = Math.min((size.w - 24) / page.w, (size.h - 24) / page.h) || 0.1;
  const svg = useRef<SVGSVGElement>(null);
  const drag = (i: number) => (e: React.PointerEvent) => {
    const el = svg.current;
    if (!el) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(page.w, (ev.clientX - r.left) / scale));
      const y = Math.max(0, Math.min(page.h, (ev.clientY - r.top) / scale));
      onChange(page.corners.map((c, k): Point => (k === i ? [x, y] : c)) as [Point, Point, Point, Point]);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const r = 14 / scale;
  return (
    <div className="scan-stage" ref={box}>
      <div className="scan-photo" style={{ width: page.w * scale, height: page.h * scale }}>
        <img src={page.url} alt="The page" draggable={false} />
        <svg ref={svg} viewBox={`0 0 ${page.w} ${page.h}`} aria-label="Drag the corners onto the page's corners">
          <polygon points={page.corners.map((c) => c.join(',')).join(' ')} className="scan-quad" />
          {page.corners.map((c, i) => (
            <circle key={i} cx={c[0]} cy={c[1]} r={r} className="scan-corner" onPointerDown={drag(i)} />
          ))}
        </svg>
      </div>
      <p className="scan-tip">Drag the corners onto the page’s corners, then Find the music.</p>
    </div>
  );
}

/** A straightened page with the systems and bar lines found on it. */
function Found({ page, onRedo }: { page: PreparedPage; onRedo: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const size = useSize(box);
  const url = useMemo(() => URL.createObjectURL(page.page), [page]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const scale = Math.min((size.w - 24) / page.w, (size.h - 24) / page.h) || 0.1;
  return (
    <div className="scan-stage" ref={box}>
      <div className="scan-photo" style={{ width: page.w * scale, height: page.h * scale }}>
        <img src={url} alt="The page, straightened" draggable={false} />
        <svg viewBox={`0 0 ${page.w} ${page.h}`} aria-hidden="true">
          {page.systems.map((s: FoundSystem, k) => (
            <g key={k} className="scan-system">
              <rect x={s.left} y={s.top} width={s.right - s.left} height={s.bottom - s.top} />
              {s.bars.map((x) => (
                <line key={x} x1={x} x2={x} y1={s.staves[0]?.lines[0]} y2={s.staves.at(-1)?.lines[4]} />
              ))}
              <text x={s.left + 6} y={s.top + page.space * 2}>
                {k + 1}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <p className="scan-tip">
        {page.systems.length
          ? `${page.systems.length} systems found. `
          : 'No staves found: set the corners closer to the page, or try Enhance. '}
        <button type="button" className="btn ghost" onClick={onRedo}>
          Adjust the corners
        </button>
      </p>
    </div>
  );
}
