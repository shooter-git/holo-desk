/**
 * Scanning sheet music into the song: photos or PDFs picked, each page's corners set (guessed, then
 * dragged), the music found on it, and the scan saved; then the review, a system at a time: its strip
 * from the page above the bars written from it, for you to approve. The recognition engines, when
 * they're running, read it in or check what was written; the agent (from the bar, Ctrl /) can too.
 */
import { notate, type Scan, type ScanSystem, toMEI } from '@holo/score';
import { Check, Play, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { apply, locate, togglePlay } from '../../app/actions.ts';
import { store, toast, useApp } from '../../app/store.ts';
import { renderEach } from '../verovio.ts';
import { compareEngines, getScan, omrStatus, readWithEngines, setSystem } from './client.ts';
import { NewScan } from './NewScan.tsx';

export default function ScanWindow() {
  const view = useApp((s) => s.scanView);
  if (!view) return null;
  return (
    <div className="scan-window" role="dialog" aria-label="Scan sheet music">
      {view.id ? <Review id={view.id} /> : <StudioScan />}
    </div>
  );
}

const close = () => store.set({ scanView: null });

/** A new scan from the studio: for the open song (and the selected track), reviewed once saved. */
function StudioScan() {
  const project = useApp((s) => s.project);
  const track = useApp((s) => s.selectedTrack);
  return (
    <NewScan
      project={project ? { id: project.id, title: project.title } : null}
      track={track}
      notify={(text) => toast(text, 'error')}
      onClose={close}
      onSaved={(scan) => store.set({ scanView: { id: scan.id } })}
      onOpen={(id) => store.set({ scanView: { id } })}
    />
  );
}

// ---- reviewing a scan ----

const STATE_WORDS: Record<ScanSystem['state'], string> = {
  new: 'not read yet',
  read: 'read',
  checked: 'checked',
  approved: 'approved',
};

function Review({ id }: { id: string }) {
  const project = useApp((s) => s.project);
  const tick = useApp((s) => s.scanTick);
  const [scan, setScan] = useState<Scan | null>(null);
  const [engines, setEngines] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [reading, setReading] = useState(false);
  const [drawn, setDrawn] = useState<string[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever the host says it changed
  useEffect(() => {
    void getScan(id).then(setScan, (e: Error) => toast(e.message, 'error'));
  }, [id, tick]);
  useEffect(() => {
    const check = () => {
      void omrStatus().then(
        (o) => setEngines(o.available ? o.engines : []),
        () => setEngines([]),
      );
    };
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
  // the engines' reading of every page, written into the song as one undo step, each system marked read
  const readIn = async () => {
    if (scan.project !== store.get().project?.id) {
      toast('Open this scan’s song first', 'error');
      return;
    }
    setReading(true);
    try {
      const r = await readWithEngines(scan.id);
      if (!r.ops.length) {
        toast('The engines found nothing to write in', 'info', 6000);
        return;
      }
      if (!apply(r.ops, 'Read with the recognition engines')) return;
      for (const sys of r.systems)
        await setSystem(scan.id, sys.page, sys.system, { state: 'read', written: sys.written });
      const n = r.systems.length;
      toast(
        `Read ${n} system${n === 1 ? '' : 's'} into the song: listen, then check them against the page`,
        'info',
        8000,
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setReading(false);
    }
  };
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
        {engines.length > 0 && (
          <>
            <button
              type="button"
              className="btn primary"
              disabled={reading || comparing}
              title={`${engines.join(' and ')} read each page, and what they read is written into the song (one undo step)`}
              onClick={() => void readIn()}
            >
              {reading ? 'Reading…' : 'Read with the recognition engines'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={comparing || reading || !counts.read}
              title={`Read each page with ${engines.join(' and ')} too, and flag the bars they read differently`}
              onClick={() => {
                setComparing(true);
                void compareEngines(scan.id)
                  .then((r) =>
                    toast(
                      r.flagged
                        ? `The engines read ${r.flagged} bar${r.flagged === 1 ? '' : 's'} differently: see the flags`
                        : 'The engines agree with every bar written',
                      'info',
                      8000,
                    ),
                  )
                  .catch((e: Error) => toast(e.message, 'error'))
                  .finally(() => setComparing(false));
              }}
            >
              {comparing ? 'The engines are reading…' : 'Compare with the engines'}
            </button>
          </>
        )}
        <button type="button" className="btn ghost icon" title="Close" onClick={close}>
          <X />
        </button>
      </header>
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
