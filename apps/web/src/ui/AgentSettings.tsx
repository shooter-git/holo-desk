/**
 * Settings › Agent: Off or On, and, once this device is allowed, Claude Code, Codex, Cursor and
 * Antigravity as the host has them (each installed or not, with its version, sign-in and update, and the one the agent
 * runs with), its model and effort, what it asks first and never does, and the devices allowed to use
 * it. Off is the default, and then this section is all there is of it.
 *
 * Turning it on from a device that isn't allowed yet: the first device pairs with a code from the host
 * (`pnpm holo pair` prints one any time, with a link that opens this filled in; a keyed runner prints
 * one too); a later one asks to join, and a device that's allowed approves it. With no allowed device
 * at hand, a later one can pair with a code too.
 */
import { useEffect, useState } from 'react';
import {
  AgentError,
  answerRequest,
  askToJoin,
  type HarnessInfo,
  harnessAction,
  isOn,
  loadDevices,
  loadSettings,
  lookAtHarnesses,
  lookForHarnesses,
  pair,
  pollJoin,
  refreshAgent,
  removeDevice,
  runnerProblem,
  sendLoginCode,
  setSettings,
  startPairing,
  useAgent,
} from '../app/agent.ts';
import { device } from '../app/live.ts';
import { takePairCode } from '../app/pair-link.ts';
import {
  caution,
  choices,
  defaultLabel,
  effortsFor,
  harnessRow,
  installQuestion,
  inUse,
  runsWith,
  runsWithText,
  toChoose,
} from './harness-row.ts';

/**
 * Where turning it on has got to, on a device not allowed yet. `code`: a code from the host is asked for
 * (with the request to join it took the place of, withdrawn once paired; `prefill`, a pairing link's).
 * Only `code` and `asking` are on their way: the others light Off.
 */
type Step =
  | { kind: 'idle' }
  | { kind: 'code'; request?: string; prefill?: string }
  | { kind: 'asking'; id: string; secret: string; code: string }
  | { kind: 'off' }
  | { kind: 'denied' }
  | { kind: 'lapsed' }
  | { kind: 'lost' };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The model and effort names the harnesses take (sent as `--opt=value`, so nothing that reads as more). */
const MODEL = /^[A-Za-z0-9][\w.:\-[\]=]{0,79}$/;

export function AgentSettings() {
  const on = useAgent(isOn);
  const allowed = useAgent((a) => !!a.info?.allowed);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refreshAgent().then((info) => {
      // opened by a pairing link: its code, ready to pair (a device allowed already has no use for it)
      const code = takePairCode();
      if (code && info && !info.allowed) setStep({ kind: 'code', prefill: code });
    });
  }, []);
  // once on for this device: its settings and devices (the devices list keeps up by itself after)
  useEffect(() => {
    if (!on) return;
    setStep({ kind: 'idle' });
    setError('');
    void loadSettings().catch((err) => setError(message(err)));
    void loadDevices().catch(() => undefined);
  }, [on]);

  // asking to join: the request is looked at 2 s after each answer, until it's answered or lapses
  useEffect(() => {
    if (step.kind !== 'asking') return;
    let timer = 0;
    let stopped = false;
    const look = () => {
      timer = window.setTimeout(async () => {
        try {
          const state = await pollJoin(step.id, step.secret);
          if (stopped) return;
          if (state !== 'pending') {
            setStep(state === 'approved' ? { kind: 'idle' } : { kind: state });
            return;
          }
        } catch {
          // the host is away for a moment (or didn't say yet that this device is in): asked again
        }
        if (!stopped) look();
      }, 2000);
    };
    look();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [step]);

  const doing = async (work: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try {
      await work();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const starting = step.kind === 'code' || step.kind === 'asking';
  const turnOn = () => {
    if (on || starting) return;
    void doing(async () => {
      const info = await refreshAgent();
      if (!info) throw new Error('Can’t reach HO[LO]’s host');
      if (info.allowed) await setSettings({ enabled: true });
      else if (info.pairing) {
        // a keyed runner prints a code (one that still works is kept); without one, holo pair does
        await startPairing();
        setStep({ kind: 'code' });
      } else if (info.enabled) {
        const r = await askToJoin(device());
        setStep({ kind: 'asking', ...r });
      } else setStep({ kind: 'off' });
    });
  };

  const turnOff = () => {
    if (allowed) void doing(() => setSettings({ enabled: false }));
    else {
      setStep({ kind: 'idle' });
      setError('');
    }
  };

  return (
    <section className="vstack agent-settings">
      <div className="label">Agent</div>
      <div className="hstack" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div className="seg">
          <button type="button" className={`btn${!on && !starting ? ' on' : ''}`} disabled={busy} onClick={turnOff}>
            Off
          </button>
          <button type="button" className={`btn${on || starting ? ' on' : ''}`} disabled={busy} onClick={turnOn}>
            On
          </button>
        </div>
        {!on && !starting && <span className="muted">Off: no agent, and nothing in HO[LO] mentions one.</span>}
      </div>
      {!on && <Joining step={step} setStep={setStep} doing={doing} busy={busy} />}
      {error && (
        <div className="agent-error" role="alert">
          {error}
        </div>
      )}
      {on && <Allowed />}
    </section>
  );
}

/**
 * Turning it on from a device not allowed yet: a code from the host, or asking an allowed device. With
 * no allowed device at hand (waiting, lapsed, or the agent off), a code is offered quietly too.
 */
function Joining({
  step,
  setStep,
  doing,
  busy,
}: {
  step: Step;
  setStep: (s: Step) => void;
  doing: (work: () => Promise<void>) => Promise<void>;
  busy: boolean;
}) {
  const [code, setCode] = useState('');
  const keyed = useAgent((a) => !!a.info?.runner.keyed);
  const prefill = step.kind === 'code' ? step.prefill : undefined;
  useEffect(() => {
    if (prefill) setCode(prefill);
  }, [prefill]);
  const codeLink = (request?: string) => (
    <div className="hstack agent-alt">
      <span className="muted">No allowed device at hand?</span>
      <button
        type="button"
        className="btn ghost"
        disabled={busy}
        onClick={() =>
          void doing(async () => {
            await startPairing();
            setCode('');
            setStep(request ? { kind: 'code', request } : { kind: 'code' });
          })
        }
      >
        Use a pairing code
      </button>
    </div>
  );
  if (step.kind === 'code') {
    const send = () =>
      void doing(async () => {
        await pair(code, device());
        // paired instead: the request to join goes from the allowed devices' lists
        if (step.request) await answerRequest(step.request, false).catch(() => undefined);
      });
    return (
      <div className="agent-join">
        <label htmlFor="agent-code">
          {prefill ? 'The code from the pairing link: press Pair' : 'Enter the pairing code from the host'}
        </label>
        <div className="hstack">
          <input
            id="agent-code"
            className="input agent-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && code.length === 6 && !busy) send();
            }}
          />
          <button type="button" className="btn primary" disabled={busy || code.length !== 6} onClick={send}>
            Pair
          </button>
          {keyed && (
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() =>
                void doing(async () => {
                  setCode('');
                  await startPairing(true);
                })
              }
            >
              New code
            </button>
          )}
        </div>
        <span className="muted">
          {prefill ? 'If it has expired: on' : 'On'} the computer HO[LO] runs on, run{' '}
          <span className="mono">pnpm holo pair</span>: it prints a code, and a link (with a QR code) that fills it in
          here.{keyed && !prefill ? ' The runner there printed one just now too.' : ''} A code works once, for 10
          minutes.
        </span>
      </div>
    );
  }
  if (step.kind === 'asking') {
    return (
      <div className="agent-join" aria-live="polite">
        <span>
          Waiting for a device that’s allowed to approve this one, in its Settings › Agent. Both show the code{' '}
          <b className="mono agent-pair">{step.code}</b>
        </span>
        <div>
          <button type="button" className="btn ghost" onClick={() => setStep({ kind: 'idle' })}>
            Cancel
          </button>
        </div>
        {codeLink(step.id)}
      </div>
    );
  }
  if (step.kind === 'denied') return <div className="agent-join muted">That device said no.</div>;
  const why =
    step.kind === 'off'
      ? 'The agent is off: turn it on from a device that’s allowed to use it.'
      : step.kind === 'lapsed'
        ? 'The request lapsed: turn it on to ask again.'
        : step.kind === 'lost'
          ? 'It was approved, but the answer didn’t reach this device: turn it on to ask again.'
          : null;
  if (!why) return null;
  return (
    <div className="agent-join">
      <span className="muted">{why}</span>
      {codeLink()}
    </div>
  );
}

/** The agent on, for this device: how it runs, what it may do, and who may use it. */
function Allowed() {
  const settings = useAgent((a) => a.settings);
  const runner = useAgent((a) => a.info?.runner);
  // opened: a runner that looked at its harnesses an hour ago or more looks again, quietly (new
  // versions' models and efforts); what's known shows meanwhile, and the new list comes by itself
  useEffect(() => {
    void lookAtHarnesses().catch(() => undefined);
  }, []);
  if (!settings) return <div className="muted">Reading the agent’s settings…</div>;
  const listed = settings.harnesses;
  const current = inUse(listed, settings.harness);
  // harnesses a runner listed before it went (or one that can't take the agent's jobs connected)
  const problem = listed.length ? runnerProblem(runner) : null;
  return (
    <>
      {problem && (
        <div className="agent-error" role="status">
          {problem}
        </div>
      )}
      <div className="agent-grid">
        <span className="agent-key">Harness</span>
        {listed.length ? (
          <Harnesses listed={listed} current={current} />
        ) : (
          <div className="hstack" style={{ flexWrap: 'wrap' }}>
            <span className="muted">
              {runner?.keyed ? 'The runner hasn’t said yet which harnesses the host has.' : runnerProblem(runner)}
            </span>
            {runner?.keyed && <LookAgain />}
          </div>
        )}
        {current && <HarnessRows harness={current} model={settings.model} effort={settings.effort} />}
        <span className="agent-key">Asks first</span>
        <span>
          Before installing a pack, sending the song to its creation, or using the screen, the camera or the microphone
        </span>
        <span className="agent-key">Never</span>
        <span>HO[LO] Desk’s code, holo-packs, or any other file on this computer</span>
        <span className="agent-key">Devices</span>
        <Devices />
      </div>
      <p className="muted agent-foot">
        Runs on this computer as you, with your own sign-in. HO[LO] holds no key. Everything the agent changes in a song
        can be undone.
      </p>
    </>
  );
}

/** Ask the runner to look for the harnesses again (one installed in a terminal, say). */
function LookAgain() {
  return (
    <button
      type="button"
      className="btn ghost agent-look"
      onClick={() => void lookForHarnesses().catch(() => undefined)}
    >
      Look again
    </button>
  );
}

/**
 * Claude Code, Codex, Cursor and Antigravity, a row each, installed or not: its version, sign-in and
 * update, and the one the agent runs with; one that isn't on the host offers Install.
 */
function Harnesses({ listed, current }: { listed: HarnessInfo[]; current: HarnessInfo | null }) {
  return (
    <div className="vstack agent-harness-list">
      <div className="list boxed agent-harnesses">
        {listed.map((h) => (
          <HarnessRow key={h.id} harness={h} current={h === current} />
        ))}
      </div>
      <LookAgain />
    </div>
  );
}

/**
 * A harness, plainly (harness-row.ts): "Not installed" and Install; or its version, "Signed in" or
 * Sign in, "Up to date" or Update to x.y, and "In use" or Use. Install and Update ask first, and so do
 * Sign in and Use for a harness its vendor doesn't support HO[LO] running (`caution`). Under it, a
 * sign-in, an update or an install under way, and why one can't be used yet.
 */
function HarnessRow({ harness: h, current }: { harness: HarnessInfo; current: boolean }) {
  const event = useAgent((a) => a.harness[h.id]);
  const [confirm, setConfirm] = useState<null | 'update' | 'install' | 'login' | 'use'>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const v = harnessRow(h, event, current);
  const act = (action: 'login' | 'update' | 'install') => {
    setError('');
    void harnessAction(h.id, action).catch((err: unknown) => setError(message(err)));
  };
  const question = installQuestion(h);
  const warning = caution(h);
  // another harness takes its own models: theirs start from its default
  const use = () =>
    void setSettings({ harness: h.id, model: '', effort: '' }).catch((err: unknown) => setError(message(err)));
  return (
    <div className="list-item still agent-harness">
      <span className="strong">{h.name}</span>
      {v.label && <span className={v.version ? 'muted mono' : 'muted'}>{v.label}</span>}
      <span className="grow" />
      <span className="agent-cell">
        {v.signIn === 'signed-in' ? (
          <span className="muted" title={h.account}>
            Signed in
          </span>
        ) : v.signIn ? (
          <button
            type="button"
            className="btn"
            disabled={v.signIn.busy || confirm !== null}
            onClick={() => (warning ? setConfirm('login') : act('login'))}
          >
            Sign in
          </button>
        ) : null}
      </span>
      <span className="agent-cell agent-update">
        {v.install ? (
          <button
            type="button"
            className="btn"
            disabled={v.install.busy || confirm !== null}
            onClick={() => setConfirm('install')}
          >
            {v.install.busy ? 'Installing…' : 'Install'}
          </button>
        ) : v.update === 'up-to-date' ? (
          <span className="muted">Up to date</span>
        ) : v.update ? (
          <button
            type="button"
            className="btn"
            disabled={v.update.busy || confirm !== null}
            onClick={() => setConfirm('update')}
          >
            Update to {v.update.latest}
          </button>
        ) : null}
      </span>
      <span className="agent-cell agent-use">
        {v.use === 'in-use' ? (
          <span className="muted">In use</span>
        ) : v.use === 'use' ? (
          <button
            type="button"
            className="btn ghost"
            aria-label={`Use ${h.name}`}
            disabled={confirm !== null}
            onClick={() => (warning ? setConfirm('use') : use())}
          >
            Use
          </button>
        ) : null}
      </span>
      {v.note && <span className="agent-more muted">{v.note}</span>}
      {confirm === 'install' && (
        <div className="agent-more hstack agent-confirm" role="alertdialog" aria-label={`Install ${h.name}?`}>
          <span className="grow">
            {question.text} (<code className="mono agent-command">{question.command}</code>).
          </span>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              setConfirm(null);
              act('install');
            }}
          >
            Install
          </button>
          <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>
            Not now
          </button>
        </div>
      )}
      {warning && (confirm === 'login' || confirm === 'use') && (
        <div
          className="agent-more hstack agent-confirm"
          role="alertdialog"
          aria-label={confirm === 'login' ? `Sign in to ${h.name}?` : `Use ${h.name}?`}
        >
          <span className="grow">
            {warning.text}{' '}
            <a href={warning.link} target="_blank" rel="noopener noreferrer">
              {warning.source}
            </a>
          </span>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              const what = confirm;
              setConfirm(null);
              if (what === 'login') act('login');
              else use();
            }}
          >
            {confirm === 'login' ? 'Sign in anyway' : 'Use it anyway'}
          </button>
          <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>
            Not now
          </button>
        </div>
      )}
      {confirm === 'update' && (
        <div className="agent-more hstack agent-confirm" role="alertdialog" aria-label={`Update ${h.name}?`}>
          <span className="grow">This updates the {h.name} your terminal uses too.</span>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              setConfirm(null);
              act('update');
            }}
          >
            Update
          </button>
          <button type="button" className="btn ghost" onClick={() => setConfirm(null)}>
            Not now
          </button>
        </div>
      )}
      {v.progress?.line && <span className="agent-more muted">{v.progress.line}</span>}
      {v.progress?.error && <span className="agent-more agent-error">{v.progress.error}</span>}
      {error && <span className="agent-more agent-error">{error}</span>}
      {v.signin && (
        <div className="agent-more vstack">
          {v.signin.url && (
            <div className="agent-signin">
              <a className="btn" href={v.signin.url} target="_blank" rel="noopener noreferrer">
                Open the sign-in page
              </a>
              <span className="muted">
                {v.signin.code ? (
                  <>
                    and enter <b className="mono">{v.signin.code}</b>
                  </>
                ) : v.signin.askCode ? (
                  'then paste the code it shows here'
                ) : (
                  'on any device'
                )}
              </span>
            </div>
          )}
          {v.signin.askCode && v.signin.waiting && (
            <div className="agent-signin">
              <input
                className="input"
                aria-label="The code the sign-in page showed"
                placeholder="The code the page showed"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <button
                type="button"
                className="btn primary"
                disabled={!code.trim()}
                onClick={() =>
                  void sendLoginCode(h.id, code.trim()).then(
                    () => setCode(''),
                    (err: unknown) => setError(message(err)),
                  )
                }
              >
                Send
              </button>
            </div>
          )}
          {v.signin.line && <span className="muted">{v.signin.line}</span>}
          {v.signin.error && <span className="agent-error">{v.signin.error}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * The model and effort the agent runs the harness with: the harness's own lists, as the runner last
 * read them; one saved that it no longer offers shows as such (a run uses its default instead). Each
 * default names what it is when the harness has said, and Requests use says what a run uses now. A
 * harness that lists no defaults (Claude Code) has none to pick: both are chosen, or it doesn't run.
 * Only what needs saying is said: no line under a picker unless what's saved is no longer offered.
 */
function HarnessRows({ harness: h, model, effort }: { harness: HarnessInfo; model: string; effort: string }) {
  const [typed, setTyped] = useState(model);
  useEffect(() => setTyped(model), [model]);
  const models = choices(h.models ?? [], model, h.aliases);
  // the efforts of the model a run uses (each model's own, when the harness says them)
  const own = effortsFor(h, model);
  const efforts = choices(own ?? [], effort);
  const modelGone = models.some((c) => c.gone);
  // a model that takes no effort has none to be gone
  const effortGone = !!own?.length && efforts.some((c) => c.gone);
  // offered with other models, not with this one
  const notThisModel = effortGone && !!h.efforts?.includes(effort);
  const must = !!h.mustChoose;
  const modelDefault = must ? 'Choose a model' : defaultLabel(h, h.defaultModel ?? null);
  // the default effort of the model a run uses
  const effortDefault = must ? 'Choose an effort' : defaultLabel(h, runsWith(h, model, '').effort);
  const gone = must
    ? `${h.name} no longer offers it: choose another`
    : `${h.name} no longer offers it, so it uses its default`;
  return (
    <>
      <span className="agent-key">Model</span>
      <div className="hstack" style={{ flexWrap: 'wrap', gap: 10 }}>
        {h.models?.length ? (
          <select
            className="select agent-select"
            aria-label="Model"
            value={model}
            // an effort the new model doesn't take goes with the old one
            onChange={(e) => {
              const next = e.target.value;
              const keeps = !effort || !!effortsFor(h, next)?.includes(effort);
              void setSettings({ model: next, ...(keeps ? {} : { effort: '' }) }).catch(() => undefined);
            }}
          >
            <option value="" disabled={must}>
              {modelDefault}
            </option>
            {models.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input agent-select"
            aria-label="Model"
            placeholder={must ? 'Type a model’s name' : modelDefault}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={() => {
              const next = typed.trim();
              if (next !== model && (next === '' || MODEL.test(next)))
                void setSettings({ model: next }).catch(() => setTyped(model));
              else setTyped(model);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        )}
        {modelGone && <span className="muted">{gone}</span>}
      </div>
      {own?.length || effortGone ? (
        <>
          <span className="agent-key">Effort</span>
          <div className="hstack" style={{ flexWrap: 'wrap', gap: 10 }}>
            <select
              className="select agent-select"
              aria-label="Effort"
              value={effort}
              onChange={(e) => void setSettings({ effort: e.target.value }).catch(() => undefined)}
            >
              <option value="" disabled={must}>
                {effortDefault}
              </option>
              {efforts.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            {effortGone && (
              <span className="muted">
                {notThisModel
                  ? must
                    ? 'This model doesn’t take it: choose another'
                    : 'This model doesn’t take it, so it uses its own'
                  : gone}
              </span>
            )}
          </div>
        </>
      ) : own ? (
        <>
          <span className="agent-key">Effort</span>
          <span className="muted">Comes with the model</span>
        </>
      ) : null}
      <span className="agent-key">Requests use</span>
      <span aria-live="polite" className={toChoose(h, model, effort) ? 'agent-attention' : undefined}>
        {runsWithText(h, model, effort)}
      </span>
    </>
  );
}

/** The devices allowed to use the agent (this one marked), and those asking to join. */
function Devices() {
  const list = useAgent((a) => a.devices);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState('');
  if (!list) return <span className="muted">…</span>;
  const act = (work: Promise<void>) =>
    work.then(
      () => setError(''),
      (err: unknown) => setError(err instanceof AgentError ? err.message : String(err)),
    );
  return (
    <div className="vstack">
      <div className="list boxed agent-devices">
        {list.devices.map((d) => (
          <div key={d.id} className={`list-item${removing === d.id ? ' agent-ask' : ''}`} style={{ cursor: 'default' }}>
            {removing === d.id ? (
              <>
                <span className="grow">
                  Remove <b>{d.name}</b>? {d.current ? 'This device' : 'It'} can’t use the agent until it’s allowed
                  again.
                </span>
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => {
                    setRemoving(null);
                    void act(removeDevice(d.id));
                  }}
                >
                  Remove
                </button>
                <button type="button" className="btn ghost" onClick={() => setRemoving(null)}>
                  Keep it
                </button>
              </>
            ) : (
              <>
                <span className="strong">{d.name}</span>
                {d.current && <span className="meta">this device</span>}
                <span className="grow" />
                <button
                  type="button"
                  className="btn ghost"
                  aria-label={`Remove ${d.name}`}
                  onClick={() => setRemoving(d.id)}
                >
                  Remove
                </button>
              </>
            )}
          </div>
        ))}
        {list.requests.map((r) => (
          <div key={r.id} className="list-item agent-ask" style={{ cursor: 'default' }}>
            <span className="strong">{r.name}</span>
            <span className="meta">
              asks to join, showing <b className="mono">{r.code}</b>
            </span>
            <span className="grow" />
            <button type="button" className="btn primary" onClick={() => void act(answerRequest(r.id, true))}>
              Approve
            </button>
            <button type="button" className="btn ghost" onClick={() => void act(answerRequest(r.id, false))}>
              Deny
            </button>
          </div>
        ))}
      </div>
      <span className="muted">A new device asks here first.</span>
      {error && <span className="agent-error">{error}</span>}
    </div>
  );
}
