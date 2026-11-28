/**
 * A harness's usage in its row in Settings › Agent (harness-usage.ts has the words and numbers): how
 * much of its account's limits is left, as its vendor reports it, and what the requests made through
 * HO[LO] used. Folded, the row says one thing at its end (UsageBrief: the limit that counts, or a few
 * words); opened, all of it (HarnessUsage): every limit, by the groups of models that share one, the
 * plan, and the requests by model. A harness that doesn't report what's left has its plan and its page.
 */
import { Fragment, useEffect, useState } from 'react';
import type { Brief, MeterView, UsageView } from './harness-usage.ts';

/** The time, said again each minute: a countdown ("resets in 2 h 10 min") keeps up while Settings is open. */
export function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** A bar of what's left, for the eye only: the words beside it say the same, and are what's read out. */
function Bar({ meter: m }: { meter: MeterView }) {
  const percent = m.left === null ? 0 : Math.round(m.left * 100);
  return (
    <span className="usage-bar" aria-hidden="true">
      {/* (a sliver still shows when under a hundredth is left) */}
      {m.left !== null && m.left > 0 && <span className="usage-fill" style={{ width: `${Math.max(percent, 2)}%` }} />}
    </span>
  );
}

/** One limit: its name, a bar of what's left, and in words how much and until when. */
function Meter({ meter: m }: { meter: MeterView }) {
  return (
    <div className="usage-meter" data-level={m.level}>
      <span className="usage-label">{m.label}</span>
      <Bar meter={m} />
      {/* (in two pieces, each kept whole: how much, and until when) */}
      <span className="usage-text">
        <span className="usage-left">{m.text}</span>
        {m.when && <span className="usage-when muted">{m.when}</span>}
      </span>
    </div>
  );
}

/** A folded row's end: the limit that counts (its name, a small bar, what's left), or a few words. */
export function UsageBrief({ brief: b }: { brief: Brief }) {
  if ('text' in b) return <span className="harness-brief muted">{b.text}</span>;
  return (
    <span className="harness-brief" data-level={b.meter.level}>
      <span className="muted">{b.meter.label}</span>
      <Bar meter={b.meter} />
      <span className="usage-left">{b.meter.text}</span>
    </span>
  );
}

export function HarnessUsage({ name, view: v }: { name: string; view: UsageView }) {
  const about = [v.plan, v.none].filter(Boolean).join(' · ');
  const foot = [v.plan, v.note, v.read].filter(Boolean).join(' · ');
  return (
    <section className="harness-under harness-usage" aria-label={`${name}’s usage`}>
      {v.summary ? (
        <>
          <div className="usage-meters">
            {v.groups.map((g) => (
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
            ))}
          </div>
          {foot && <div className="usage-foot muted">{foot}</div>}
        </>
      ) : (
        (about || v.link) && (
          <div className="usage-plain muted">
            {about}
            {about && v.link ? ': see ' : ''}
            {v.link && (
              <a href={v.link.href} target="_blank" rel="noopener noreferrer">
                {v.link.text}
              </a>
            )}
          </div>
        )
      )}
      {v.through && (
        <>
          <div className="usage-through-name muted">Through HO[LO], last {v.through.days} days</div>
          <div className="usage-through">
            <div className="usage-row usage-head muted">
              <span>Model</span>
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
        </>
      )}
    </section>
  );
}
