/**
 * Print: the score on pages, as they'll come out of the printer (or into a PDF, with the browser's
 * Save as PDF): the full score, one part, or every part one after another. A part's long rests are
 * counted in one bar. The paper, its orientation and the staff size are the song's page setup, kept
 * with it; a new system or page starts where the score says (the Score's menu).
 */
import { notate, type ScoreDoc, toMEI } from '@holo/score';
import type { Project, ScoreSettings } from '@holo/session';
import { Printer, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { apply } from '../app/actions.ts';
import { store, useApp } from '../app/store.ts';
import { renderScore } from './verovio.ts';

type Page = NonNullable<ScoreSettings['page']>;
type Size = NonNullable<Page['size']>;

/** Paper in millimeters, portrait. */
const PAPER: Record<Size, [number, number, string]> = {
  letter: [215.9, 279.4, 'Letter'],
  a4: [210, 297, 'A4'],
  a3: [297, 420, 'A3'],
  tabloid: [279.4, 431.8, 'Tabloid'],
};

/** Staff heights (mm) to choose from: small, as most parts are printed, large. */
const STAVES: [number, string][] = [
  [6, 'Small'],
  [7, 'Medium'],
  [8, 'Large'],
];

interface Setup {
  size: Size;
  landscape: boolean;
  staff: number;
}

const setupOf = (p: Project): Setup => ({
  size: p.score?.page?.size ?? (navigator.language.startsWith('en-US') ? 'letter' : 'a4'),
  landscape: p.score?.page?.landscape ?? false,
  staff: p.score?.page?.staff ?? 7,
});

/** Verovio's page, in its units (tenths of a millimeter at 100%). */
function options(setup: Setup, names: boolean): Record<string, unknown> {
  const [w, h] = PAPER[setup.size];
  const [pw, ph] = setup.landscape ? [h, w] : [w, h];
  return {
    scale: 100,
    pageWidth: Math.round(pw * 10),
    pageHeight: Math.round(ph * 10),
    // half a staff space: a staff is four spaces high
    unit: (setup.staff * 10) / 8,
    pageMarginTop: 120,
    pageMarginBottom: 140,
    pageMarginLeft: names ? 160 : 120,
    pageMarginRight: 120,
    adjustPageHeight: false,
    // the systems laid out by width, and a new one wherever the score asks for one
    breaks: 'smart',
    breaksSmartSb: 0,
    header: 'auto',
    footer: 'none',
    svgViewBox: true,
  };
}

/** A score's pages: a new page where the score asks for one (each run of bars engraved on its own). */
async function pagesOf(doc: ScoreDoc, setup: Setup, part: string | null): Promise<string[]> {
  const starts = [0, ...doc.bars.flatMap((b, i) => (i > 0 && b.break === 'page' ? [i] : []))];
  const out: string[] = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k] as number;
    const to = starts[k + 1] ?? doc.bars.length;
    const mei = toMEI(doc, {
      from,
      to,
      credits: from === 0,
      labels: !part,
      multiRest: !!part,
      ...(part ? { heading: part } : {}),
    });
    const pages = await renderScore(mei, options(setup, !part), true, 'print');
    if (!pages) throw new Error('stale');
    out.push(...pages);
  }
  return out;
}

export default function PrintWindow() {
  const project = useApp((s) => s.project);
  const what = useApp((s) => s.printView?.what ?? 'score');
  const [sheets, setSheets] = useState<{ label: string; pages: string[] }[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const setup = useMemo(() => (project ? setupOf(project) : null), [project]);
  const parts = useMemo(
    () =>
      project ? project.tracks.filter((t) => t.kind === 'instrument' && t.regions.some((r) => r.notes.length)) : [],
    [project],
  );

  useEffect(() => {
    if (!project || !setup) return;
    let live = true;
    setBusy(true);
    const groups: { label: string; tracks: string[] | null; part: string | null }[] =
      what === 'score'
        ? [{ label: 'Full score', tracks: null, part: null }]
        : (what === 'parts' ? parts : parts.filter((t) => t.id === what)).map((t) => ({
            label: t.score?.name ?? t.name,
            tracks: [t.id],
            part: t.score?.name ?? t.name,
          }));
    (async () => {
      const out: { label: string; pages: string[] }[] = [];
      for (const g of groups) {
        const doc = notate(project, g.tracks ? { tracks: g.tracks } : {});
        out.push({ label: g.label, pages: await pagesOf(doc, setup, g.part) });
        if (!live) return;
      }
      if (live) {
        setSheets(out);
        setError(null);
      }
    })()
      .catch((e: Error) => live && e.message !== 'stale' && setError(e.message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [project, setup, what, parts]);

  // Escape closes, as the other windows do
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') store.set({ printView: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!project || !setup) return null;
  const change = (patch: Partial<Setup>) => {
    const page: Page = { ...(project.score?.page ?? {}), ...patch };
    apply([{ op: 'setProject', patch: { score: { ...(project.score ?? {}), page } } }], 'Score: page setup');
  };
  const [w, h] = PAPER[setup.size];
  const [pw, ph] = setup.landscape ? [h, w] : [w, h];
  const total = sheets.reduce((n, s) => n + s.pages.length, 0);

  return createPortal(
    <div className="print-window" role="dialog" aria-label="Print">
      <style>{`@page { size: ${pw}mm ${ph}mm; margin: 0; }`}</style>
      <header className="scan-bar">
        <span className="title">Print</span>
        <select
          className="input"
          value={what}
          aria-label="What to print"
          onChange={(e) => store.set({ printView: { what: e.target.value } })}
        >
          <option value="score">Full score</option>
          {parts.length > 1 && <option value="parts">Every part, one after another</option>}
          {parts.map((t) => (
            <option key={t.id} value={t.id}>
              Part: {t.score?.name ?? t.name}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={setup.size}
          aria-label="Paper"
          onChange={(e) => change({ size: e.target.value as Size })}
        >
          {Object.entries(PAPER).map(([k, [, , name]]) => (
            <option key={k} value={k}>
              {name}
            </option>
          ))}
        </select>
        <div className="seg">
          <button
            type="button"
            className={`btn${setup.landscape ? '' : ' on'}`}
            aria-pressed={!setup.landscape}
            onClick={() => change({ landscape: false })}
          >
            Portrait
          </button>
          <button
            type="button"
            className={`btn${setup.landscape ? ' on' : ''}`}
            aria-pressed={setup.landscape}
            onClick={() => change({ landscape: true })}
          >
            Landscape
          </button>
        </div>
        <div className="seg" title="Staff size">
          {STAVES.map(([mm, name]) => (
            <button
              key={mm}
              type="button"
              className={`btn${setup.staff === mm ? ' on' : ''}`}
              title={`Staves ${mm} mm high`}
              aria-pressed={setup.staff === mm}
              onClick={() => change({ staff: mm })}
            >
              {name}
            </button>
          ))}
        </div>
        <span className="grow" />
        <span className="muted">{busy ? 'Engraving…' : `${total} page${total === 1 ? '' : 's'}`}</span>
        <button
          type="button"
          className="btn primary"
          disabled={busy || !total}
          title="Print, or choose Save as PDF in the printer list"
          onClick={() => window.print()}
        >
          <Printer /> Print or save as PDF
        </button>
        <button
          type="button"
          className="btn ghost icon"
          title="Close (Esc)"
          aria-label="Close"
          onClick={() => store.set({ printView: null })}
        >
          <X />
        </button>
      </header>
      <div className="print-sheets">
        {error && <p className="print-error">The score couldn’t be engraved: {error}</p>}
        {sheets.map((group) =>
          group.pages.map((svg, i) => (
            <div
              key={`${group.label}-${i}`}
              className="print-sheet"
              style={{ aspectRatio: `${pw} / ${ph}` }}
              title={`${group.label}, page ${i + 1}`}
            >
              {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the engraver's own drawing of the song */}
              <div className="print-svg" dangerouslySetInnerHTML={{ __html: svg }} />
              {group.pages.length > 1 && <span className="print-number">{i + 1}</span>}
            </div>
          )),
        )}
      </div>
    </div>,
    document.body,
  );
}
