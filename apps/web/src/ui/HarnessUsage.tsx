/**
 * A harness's usage, under its row in Settings › Agent (harness-usage.ts has the words and numbers):
 * how much of its account's limits is left, as its vendor reports it, and what the requests made
 * through HO[LO] used. Folded, it's the longest limit in a line (for the harness the agent runs with,
 * every limit its model counts against; named for its group of models, where there are several), or,
 * for a harness that doesn't report what's left, its plan and its counts. More unfolds the rest: every limit, by the groups of models that share one, the
 * plan, and the requests by model.
 */
import { Fragment, useEffect, useState } from 'react';
import type { HarnessInfo, UsageSum } from '../app/agent.ts';
import { type MeterView, usageView } from './harness-usage.ts';

/** The time, said again each minute: a countdown ("resets in 2 h 10 min") keeps up while Settings is open. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * One limit: its name, a bar of what's left, and in words how much and until when. The bar is for the
 * eye only: the words beside it say the same, and are what's read out.
 */
function Meter({ meter: m }: { meter: MeterView }) {
  const percent = m.left === null ? 0 : Math.round(m.left * 100);
  return (
    <div className="usage-meter" data-level={m.level}>
      <span className="usage-label">{m.label}</span>
      <span className="usage-bar" aria-hidden="true">
        {/* (a sliver still shows when under a hundredth is left) */}
        {m.left !== null && m.left > 0 && <span className="usage-fill" style={{ width: `${Math.max(percent, 2)}%` }} />}
      </span>
      {/* (in two pieces, each kept whole: how much, and until when) */}
      <span className="usage-text">
        <span className="usage-left">{m.text}</span>
        {m.when && <span className="usage-when muted">{m.when}</span>}
      </span>
    </div>
  );
}

export function HarnessUsage({
  harness: h,
  current,
  chosen,
  runs,
  usage,
}: {
  harness: HarnessInfo;
  current: boolean;
  /** For the one in use: the model chosen, and the one a request runs with. */
  chosen: string | null;
  runs: string | null;
  usage: { days: number; rows: readonly UsageSum[] } | undefined;
}) {
  const now = useMinute();
  const [asked, setAsked] = useState(false);
  const v = usageView(h, { now, current, chosen, runs, ...(usage ? { usage } : {}) });
  if (!v) return null;
  const open = v.more && asked;
  const about = [v.plan, v.none].filter(Boolean).join(' · ');
  const foot = [v.plan, v.note, v.read].filter(Boolean).join(' · ');
  return (
    <section className="agent-more agent-usage" aria-label={`${h.name}’s usage`}>
      <div className="usage-main">
        {v.summary ? (
          <div className="usage-meters">
            {open ? (
              v.groups.map((g) => (
                <Fragment key={g.key}>
                  {g.name && (
                    <div className="usage-group">
                      <span className="usage-group-name">{g.name}</span>
                      {g.inUse && <span className="muted"> · the model in use</span>}
                      {g.models && <span className="usage-models muted">{g.models}</span>}
                    </div>
                  )}
                  {g.meters.map((m) => (
                    <Meter key={m.key} meter={m} />
                  ))}
                </Fragment>
              ))
            ) : (
              <>
                {v.summaryOf && (
                  <div className="usage-group">
                    <span className="usage-group-name">{v.summaryOf}</span>
                    {v.groups[0]?.inUse && <span className="muted"> · the model in use</span>}
                  </div>
                )}
                {v.lead.map((m) => (
                  <Meter key={m.key} meter={m} />
                ))}
              </>
            )}
          </div>
        ) : (
          <div className="usage-plain">
            {(about || v.link) && (
              <span className="muted">
                {about}
                {about && v.link ? ': see ' : ''}
                {v.link && (
                  <a href={v.link.href} target="_blank" rel="noopener noreferrer">
                    {v.link.text}
                  </a>
                )}
              </span>
            )}
            {v.through && !open && (
              <span className="muted">
                Through HO[LO], last {v.through.days} days: {v.through.line}
              </span>
            )}
          </div>
        )}
        {v.more && (
          <button
            type="button"
            className="btn ghost usage-toggle"
            aria-expanded={open}
            aria-label={`${open ? 'Less' : 'More'} of ${h.name}’s usage`}
            onClick={() => setAsked(!open)}
          >
            {open ? 'Less' : 'More'}
          </button>
        )}
      </div>
      {open && v.summary && foot && <div className="usage-foot muted">{foot}</div>}
      {!open && v.noteNow && <div className="usage-foot muted">{v.noteNow}</div>}
      {open && v.through && (
        <div className="usage-through">
          <div className="usage-row usage-head muted">
            <span>Through HO[LO], last {v.through.days} days</span>
            <span>Requests</span>
            <span>Tokens in</span>
            <span>Out</span>
          </div>
          {v.through.rows.map((r) => (
            <div className="usage-row" key={r.key}>
              <span className="usage-model">{r.label}</span>
              <span className="mono">{r.requests}</span>
              <span className="mono">{r.read}</span>
              <span className="mono">{r.written}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
