/**
 * Export stems: what the host would make of the open song, shown before it's asked (a file for each
 * track the mix is made of, how long and how big, and why they wouldn't add up to the mix), for the
 * whole song or its cycle.
 */

import type { StemsBy } from '@holo/agent/edits';
import { Package, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { BOUNCE_TAIL, bounceClock, exportStems, type StemsRange } from '../app/actions.ts';
import { diskSize } from '../app/disk-size.ts';
import { stemsPlan } from '../app/stems.ts';
import { store, useApp } from '../app/store.ts';
import { Dialog } from './Dialogs.tsx';

export function StemsDialog() {
  const project = useApp((s) => s.project);
  const busy = useApp((s) => s.bouncing !== null);
  const [range, setRange] = useState<StemsRange>(() => (store.get().project?.cycle.on ? 'cycle' : 'song'));
  const [by, setBy] = useState<StemsBy>('tracks');
  const plan = useMemo(() => (project ? stemsPlan(project, range, BOUNCE_TAIL, by) : null), [project, range, by]);
  if (!project || !plan) return null;
  const n = plan.stems.length;
  const color = (id: string | undefined) => project.tracks.find((t) => t.id === id)?.color;
  return (
    <Dialog
      title="Export stems"
      className="stems"
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn" onClick={() => store.set({ dialog: null })}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!n || busy}
            title={busy ? 'A bounce is under way: export the stems when it’s done' : undefined}
            onClick={() => {
              store.set({ dialog: null });
              void exportStems(plan.ofCycle ? 'cycle' : 'song', true, by);
            }}
          >
            <Package /> {n ? `Export ${n === 1 ? '1 stem' : `${n} stems`}` : 'Export stems'}
          </button>
        </>
      }
    >
      <p className="stems-what">
        A 24-bit WAV for each track, with its own effects and its share of the buses it’s sent to, in one ZIP. The host
        makes it and keeps it with the song’s bounces.
      </p>
      {plan.cycle && (
        // biome-ignore lint/a11y/useSemanticElements: a pair of buttons, as the studio's other choices of two are
        <div className="seg stems-range" role="group" aria-label="What to export">
          <button
            type="button"
            className={`btn${plan.ofCycle ? '' : ' on'}`}
            aria-pressed={!plan.ofCycle}
            onClick={() => setRange('song')}
          >
            The whole song
          </button>
          <button
            type="button"
            className={`btn${plan.ofCycle ? ' on' : ''}`}
            aria-pressed={plan.ofCycle}
            onClick={() => setRange('cycle')}
          >
            The cycle, {plan.cycle}
          </button>
        </div>
      )}
      {plan.stacks && (
        // biome-ignore lint/a11y/useSemanticElements: a pair of buttons, as the studio's other choices of two are
        <div className="seg stems-range" role="group" aria-label="What each file is of">
          <button
            type="button"
            className={`btn${by === 'tracks' ? ' on' : ''}`}
            aria-pressed={by === 'tracks'}
            onClick={() => setBy('tracks')}
          >
            A file for each track
          </button>
          <button
            type="button"
            className={`btn${by === 'stacks' ? ' on' : ''}`}
            aria-pressed={by === 'stacks'}
            title="A stack’s tracks together in one file; a track in no stack has its own"
            onClick={() => setBy('stacks')}
          >
            Stacks and loose tracks
          </button>
        </div>
      )}
      {n ? (
        <>
          <div className="label stems-count">
            {n === 1 ? '1 stem' : `${n} stems`} · {bounceClock(plan.seconds)}
            {n > 1 ? ' each' : ''} · about {diskSize(plan.bytes)}
          </div>
          <ol className="stems-list" aria-label="The files in the ZIP">
            {plan.stems.map((s) => (
              <li key={s.file}>
                <span className="stem-dot" style={{ background: color(s.tracks[0]) }} aria-hidden="true" />
                <span className="stem-file">{s.file}</span>
              </li>
            ))}
          </ol>
          {plan.left > 0 && (
            <p className="muted stems-left">
              {plan.left === 1 ? '1 track is' : `${plan.left} tracks are`} in no stem: muted, switched off, or with
              nothing to play.
            </p>
          )}
        </>
      ) : (
        <p className="stems-none">Nothing in the song would be heard: no track has anything to play.</p>
      )}
      {n > 0 &&
        plan.warnings.map((w) => (
          <p key={w} className="stems-warning">
            <TriangleAlert size={14} aria-hidden="true" />
            <span>{w}</span>
          </p>
        ))}
    </Dialog>
  );
}
