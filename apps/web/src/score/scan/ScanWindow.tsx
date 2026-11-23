/**
 * Scanning sheet music into the song: photos or PDFs picked, each page's corners set (guessed, then
 * dragged), the music found on it, and the scan saved; then the review, a system at a time: its strip
 * from the page above the bars written from it, for you to approve. The recognition engines (on by
 * default) read it in or check what was written; while they can't, the review says why. The agent can
 * read it too, from the bar: the window covers the studio, so its header carries the studio's own
 * Commands button (on a phone or a tablet the page opens over the review, under that header).
 */
import { notate, type Scan, type ScanSystem, toMEI } from '@holo/score';
import { Check, Play, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apply, locate, saveSoon, togglePlay } from '../../app/actions.ts';
import { store, toast, useApp } from '../../app/store.ts';
import { BarButton } from '../../ui/ControlBar.tsx';
import { useFocusInside } from '../../ui/focus-inside.ts';
import { renderEach } from '../verovio.ts';
import { compareEngines, getScan, type OmrStatus, omrStatus, readWithEngines, setSystem } from './client.ts';
import { NewScan } from './NewScan.tsx';

export default function ScanWindow() {
  const view = useApp((s) => s.scanView);
  const box = useRef<HTMLDivElement>(null);
  useFocusInside(box);
  if (!view) return null;
  return (
    <div ref={box} className="scan-window" role="dialog" aria-modal="true" aria-label="Scan sheet music" tabIndex={-1}>
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

/** Why the recognition engines can't read the scan in now, in a line under the review's title. */
function enginesAway(o: OmrStatus | null): string {
  if (!o) return 'Looking for the recognition engines…';
  if (o.why === 'starting') return 'Getting the recognition engines ready (the first time, a download of a few GB)…';
  if (o.why === 'off') return 'The recognition engines are turned off where HO[LO] runs (pnpm omr on turns them on).';
  if (o.why === 'no-docker') return 'The recognition engines need Docker on the computer HO[LO] runs on.';
  return 'The recognition engines aren’t answering yet.';
}

/** How far the review has got, in what there is: "3 approved · 4 to read". */
function progress(counts: Record<string, number>): string {
  const parts = [
    counts.approved && `${counts.approved} approved`,
    counts.checked && `${counts.checked} checked`,
    counts.read && `${counts.read} read`,
    counts.new && `${counts.new} to read`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No systems found';
}

function Review({ id }: { id: string }) {
  const project = useApp((s) => s.project);
  const tick = useApp((s) => s.scanTick);
  const [scan, setScan] = useState<Scan | null>(null);
  const [omr, setOmr] = useState<OmrStatus | null>(null);
  const engines = omr?.available ? omr.engines : [];
  const [comparing, setComparing] = useState(false);
  /** While the engines' reading is on its way: what's happening. */
  const [reading, setReading] = useState<string | null>(null);
  const [drawn, setDrawn] = useState<string[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever the host says it changed
  useEffect(() => {
    void getScan(id).then(setScan, (e: Error) => toast(e.message, 'error'));
  }, [id, tick]);
  // the engines: asked again every 15 s, or every 3 s while they're getting ready (asking starts them
  // where the server runs them itself)
  useEffect(() => {
    let live = true;
    let t = 0;
    const check = () => {
      void omrStatus()
        .catch((): OmrStatus => ({ available: false, engines: [], why: 'unreachable' }))
        .then((o) => {
          if (!live) return;
          setOmr(o);
          t = window.setTimeout(check, o.why === 'starting' ? 3000 : 15_000);
        });
    };
    check();
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, []);

  // Escape closes the review, as the other windows do: everything in it is kept as it's made. The bar
  // or the page open over it closes first (heard before the studio's keys are: app/keys.ts closes it).
  // (A new scan keeps the key from closing it: its pages and their corners would be lost.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = store.get();
      if (e.key === 'Escape' && s.dialog === null && !s.bar) close();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
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
  // the engines' reading of the systems not read yet, written into the song as one undo step; only
  // then is each system marked as far as it got
  const readIn = async () => {
    if (scan.project !== store.get().project?.id) {
      toast('Open this scan’s song first', 'error');
      return;
    }
    if (store.get().saveState === 'conflict') {
      toast('Choose which version of the song to keep first', 'error');
      return;
    }
    setReading('Reading…');
    try {
      // the host works it out from the song as saved: what's here is saved first
      if ((await saveSoon(0)) === null) {
        toast('The song couldn’t be saved, so nothing was read in', 'error');
        return;
      }
      const before = store.get().project;
      const r = await readWithEngines(scan.id, () => setReading('The engines are reading…'));
      if (!r.ops.length) {
        const why = r.errors[0] ?? r.warnings[0];
        toast(why ? `The engines found nothing to write in (${why})` : 'Every system is read already', 'info', 8000);
        return;
      }
      const now = store.get();
      if (now.project !== before || now.serverRevision !== r.revision) {
        toast('The song changed while the engines read it: read it in again', 'error', 8000);
        return;
      }
      if (!apply(r.ops, r.label)) return;
      for (const sys of r.systems) {
        await setSystem(scan.id, sys.page, sys.system, {
          state: sys.state,
          ...(sys.written ? { written: sys.written } : {}),
          flags: sys.flags ?? [],
        });
      }
      const read = r.systems.filter((x) => x.state === 'read').length;
      const left = r.systems.length - read;
      toast(
        `Read ${read} system${read === 1 ? '' : 's'} into the song${
          left ? ` (${left} not: see the flags)` : ''
        }: listen, then check them against the page`,
        'info',
        8000,
      );
      if (r.warnings.length) toast(r.warnings.join('; '), 'info', 10_000);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setReading(null);
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
      <header className="scan-bar review">
        <span className="scan-heading">
          <span className="title">{scan.title}</span>
          <span className="muted">{progress(counts)}</span>
        </span>
        <span className="scan-tools">
          {engines.length === 0 ? (
            <span className="muted scan-away" role="status">
              {enginesAway(omr)}
            </span>
          ) : (
            <>
              {/* (once every system is read, there's nothing left for it) */}
              {(!!counts.new || reading !== null) && (
                <button
                  type="button"
                  className="btn primary"
                  disabled={reading !== null || comparing}
                  title={`${engines.join(' and ')} read each page, and what they read of the systems not read yet is written into the song (one undo step)`}
                  onClick={() => void readIn()}
                >
                  {reading ?? 'Read with the recognition engines'}
                </button>
              )}
              {systems.some(({ s }) => s.written) && (
                <button
                  type="button"
                  className="btn"
                  disabled={comparing || reading !== null || !counts.read}
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
              )}
            </>
          )}
        </span>
        <span className="scan-end">
          {/* the studio's commands (the bar, or a phone's page): the window covers its control bar */}
          <BarButton />
          <button type="button" className="btn ghost icon" title="Close" onClick={close}>
            <X />
          </button>
        </span>
      </header>
      <div className="scan-review">
        {systems.length > 0 && !systems.some(({ s }) => s.written) && (
          <p className="muted scan-guide">
            Each system goes into the song when it’s read in. Then listen to it, check it against the page, and approve
            it.
          </p>
        )}
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
              {/* (approving is for what's been written: before then there's nothing to approve) */}
              {s.written && (
                <button
                  type="button"
                  className={`btn${s.state === 'approved' ? ' on' : ''}`}
                  onClick={() =>
                    void setSystem(scan.id, page, s.k, { state: s.state === 'approved' ? 'checked' : 'approved' })
                  }
                >
                  <Check /> {s.state === 'approved' ? 'Approved' : 'Approve'}
                </button>
              )}
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
