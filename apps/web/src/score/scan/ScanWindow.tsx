/**
 * Scanning sheet music into the song: photos or PDFs picked, each page's corners set (guessed, then
 * dragged), the music found on it, and the scan saved; then the review, a system at a time: its strip
 * from the page above the bars written from it, with the AI to read, check or fix, and you to approve.
 */
import { type FoundSystem, notate, type Point, type Scan, type ScanSystem, toMEI } from '@holo/score';
import { Camera, Check, FileUp, Play, Sparkles, Square, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { locate, togglePlay } from '../../app/actions.ts';
import { store, toast, useApp } from '../../app/store.ts';
import { useSize } from '../../ui/frame.ts';
import { renderEach } from '../verovio.ts';
import {
  aiStatus,
  getScan,
  listScans,
  type PickedPage,
  type PreparedPage,
  preparePage,
  readPages,
  saveScan,
  setSystem,
  startAi,
  stopAi,
} from './client.ts';

export default function ScanWindow() {
  const view = useApp((s) => s.scanView);
  if (!view) return null;
  return (
    <div className="scan-window" role="dialog" aria-label="Scan sheet music">
      {view.id ? <Review id={view.id} /> : <NewScan />}
    </div>
  );
}

const close = () => store.set({ scanView: null });

// ---- a new scan ----

function NewScan() {
  const project = useApp((s) => s.project);
  const track = useApp((s) => s.selectedTrack);
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
      if (!more.length) toast('Those aren’t photos or PDFs', 'error');
      setPages((p) => [...p, ...more]);
      setPrepared((p) => [...p, ...more.map(() => null)]);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
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
        toast(`Page ${i + 1}: ${e instanceof Error ? e.message : String(e)}`, 'error');
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
      store.set({ scanView: { id: scan.id } });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
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
        <button type="button" className="btn ghost icon" title="Close" onClick={close}>
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
            {earlier.length > 0 && (
              <div className="scan-earlier">
                <h3>Scans of this song</h3>
                {earlier.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="btn"
                    onClick={() => store.set({ scanView: { id: s.id } })}
                  >
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
            grey pages)
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

// ---- reviewing a scan ----

const STATE_WORDS: Record<ScanSystem['state'], string> = {
  new: 'not read yet',
  read: 'read',
  checked: 'checked',
  approved: 'approved',
};

const MISSING: Record<string, string> = {
  'no-runner': 'Start the runner on the computer with Claude Code: pnpm runner',
  'no-claude': 'Install Claude Code on the runner’s computer and sign in once (run claude), then restart the runner',
  'no-skill': 'Run pnpm skill:install on the runner’s computer',
};

function Review({ id }: { id: string }) {
  const project = useApp((s) => s.project);
  const tick = useApp((s) => s.scanTick);
  const job = useApp((s) => (s.aiJob?.scan === id ? s.aiJob : null));
  const [scan, setScan] = useState<Scan | null>(null);
  const [ai, setAi] = useState<{ available: boolean; reason?: string } | null>(null);
  const [drawn, setDrawn] = useState<string[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever the host says it changed
  useEffect(() => {
    void getScan(id).then(setScan, (e: Error) => toast(e.message, 'error'));
  }, [id, tick]);
  useEffect(() => {
    const check = () => void aiStatus().then(setAi, () => setAi(null));
    check();
    const t = window.setInterval(check, 15_000);
    return () => window.clearInterval(t);
  }, []);

  const systems = useMemo(() => scan?.pages.flatMap((p) => p.systems.map((s) => ({ page: p.n, s }))) ?? [], [scan]);
  // the bars each system was written as, drawn as the score has them
  useEffect(() => {
    if (!project || !scan) return;
    const doc = notate(project);
    const meis = systems.map(({ s }) => {
      if (!s.written) return '';
      const from = doc.bars.findIndex((b) => b.number === s.written?.[0]);
      let to = from;
      while (to + 1 < doc.bars.length && (doc.bars[to + 1]?.number ?? 0) <= (s.written?.[1] ?? 0)) to++;
      return from >= 0 ? toMEI(doc, { from, to: to + 1, credits: false }) : '';
    });
    let live = true;
    void renderEach(
      meis.filter(Boolean),
      {
        scale: 32,
        pageWidth: 2600,
        adjustPageHeight: true,
        breaks: 'none',
        header: 'none',
        footer: 'none',
        pageMarginLeft: 20,
      },
      'review',
    ).then((svgs) => {
      if (!live) return;
      let k = 0;
      setDrawn(meis.map((m) => (m ? (svgs[k++] ?? '') : '')));
    });
    return () => {
      live = false;
    };
  }, [project, scan, systems]);

  if (!scan) return <p className="scan-busy">Opening the scan…</p>;
  const counts: Record<string, number> = {};
  for (const { s } of systems) counts[s.state] = (counts[s.state] ?? 0) + 1;
  const running = job && (job.state === 'waiting' || job.state === 'running');
  const flagged = systems.some(({ s }) => s.flags?.length);
  const run = (task: 'read' | 'check' | 'fix') =>
    void startAi(scan.id, task).catch((e: Error) => toast(e.message, 'error'));
  const goTo = (s: ScanSystem) => {
    if (!project || !s.written) return;
    const doc = notate(project);
    const bar = doc.bars.find((b) => b.number === s.written?.[0]);
    if (bar) locate(bar.start);
    store.set({ scanView: null, editor: 'piano', noteView: 'score' });
  };

  return (
    <>
      <header className="scan-bar">
        <span className="title">{scan.title}</span>
        <span className="muted">
          {counts.approved ?? 0} approved · {counts.checked ?? 0} checked · {counts.read ?? 0} read · {counts.new ?? 0}{' '}
          to read
        </span>
        <span className="grow" />
        {running ? (
          <button type="button" className="btn" onClick={() => job && void stopAi(job.id)}>
            <Square /> Stop the AI
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn primary"
              disabled={!ai?.available}
              title={
                ai?.available
                  ? 'Claude reads each system into the song'
                  : (MISSING[ai?.reason ?? ''] ?? 'The AI isn’t available')
              }
              onClick={() => run('read')}
            >
              <Sparkles /> Read with AI
            </button>
            <button
              type="button"
              className="btn"
              disabled={!ai?.available || !counts.read}
              onClick={() => run('check')}
            >
              Check with AI
            </button>
            <button type="button" className="btn" disabled={!ai?.available || !flagged} onClick={() => run('fix')}>
              Fix flagged
            </button>
          </>
        )}
        <button type="button" className="btn ghost icon" title="Close" onClick={close}>
          <X />
        </button>
      </header>
      {ai && !ai.available && (
        <p className="scan-hint">The AI buttons need: {MISSING[ai.reason ?? ''] ?? 'the runner'}.</p>
      )}
      {job && (
        <p className={`scan-job ${job.state}`}>
          AI {job.task}:{' '}
          {job.state === 'failed' ? job.error : job.state === 'done' ? job.summary : (job.lines.at(-1) ?? 'starting…')}
        </p>
      )}
      <div className="scan-review">
        {systems.map(({ page, s }, i) => (
          <section key={`${page}.${s.k}`} className={`scan-row ${s.state}`}>
            <div className="scan-row-head">
              <span className="title">
                Page {page + 1}, system {s.k + 1}
              </span>
              <span className="muted">
                {s.staves} {s.staves === 1 ? 'staff' : 'staves'} · about {Math.max(0, s.bars.length - 1)} bars ·{' '}
                {STATE_WORDS[s.state]}
                {s.written ? ` · bars ${s.written[0]}–${s.written[1]}` : ''}
              </span>
              <span className="grow" />
              {s.written && (
                <button
                  type="button"
                  className="btn ghost"
                  title="Hear it from here"
                  onClick={() => {
                    goTo(s);
                    void togglePlay();
                  }}
                >
                  <Play />
                </button>
              )}
              {s.written && (
                <button type="button" className="btn ghost" onClick={() => goTo(s)}>
                  Edit in the Score
                </button>
              )}
              <button
                type="button"
                className={`btn${s.state === 'approved' ? ' on' : ''}`}
                disabled={!s.written}
                onClick={() =>
                  void setSystem(scan.id, page, s.k, { state: s.state === 'approved' ? 'checked' : 'approved' })
                }
              >
                <Check /> {s.state === 'approved' ? 'Approved' : 'Approve'}
              </button>
            </div>
            {s.flags?.length ? (
              <ul className="scan-flags">
                {s.flags.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            ) : null}
            <img
              className="scan-strip"
              src={`/api/scans/${scan.id}/strips/${page}/${s.k}?v=${tick}`}
              alt={`System ${s.k + 1} as photographed`}
            />
            {drawn[i] ? (
              // biome-ignore lint/security/noDangerouslySetInnerHtml: Verovio's SVG of the song's own bars
              <div className="scan-written" dangerouslySetInnerHTML={{ __html: drawn[i] as string }} />
            ) : (
              <p className="muted scan-unread">{s.written ? 'Drawing…' : 'Not written into the song yet.'}</p>
            )}
          </section>
        ))}
      </div>
    </>
  );
}
