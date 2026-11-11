/**
 * Settings › Agent: Off or On, and, once this device is allowed, the harness, model and effort the
 * agent runs with, the harness's sign-in and update, what it asks first and never does, and the
 * devices allowed to use it. Off is the default, and then this section is all there is of it.
 *
 * Turning it on from a device that isn't allowed yet: the first device pairs with the code the runner
 * prints on the host; a later one asks to join, and a device that's allowed approves it.
 */
import { useEffect, useState } from 'react';
import {
  AgentError,
  answerRequest,
  askToJoin,
  type HarnessId,
  type HarnessInfo,
  harnessAction,
  isOn,
  loadDevices,
  loadSettings,
  lookForHarnesses,
  pair,
  pollJoin,
  refreshAgent,
  removeDevice,
  sendLoginCode,
  setSettings,
  startPairing,
  useAgent,
} from '../app/agent.ts';
import { device } from '../app/live.ts';

/** Where turning it on has got to, on a device not allowed yet. */
type Step =
  | { kind: 'idle' }
  | { kind: 'code' }
  | { kind: 'asking'; id: string; secret: string; code: string }
  | { kind: 'denied' }
  | { kind: 'lapsed' };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A model's or an effort's name as a menu shows it ("opus" is "Opus"). */
const shown = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** The model and effort names the harnesses take (sent as `--opt=value`, so nothing that reads as more). */
const MODEL = /^[A-Za-z0-9][\w.:\-[\]=]{0,79}$/;

export function AgentSettings() {
  const on = useAgent(isOn);
  const allowed = useAgent((a) => !!a.info?.allowed);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refreshAgent();
  }, []);
  // once on for this device: its settings and devices (the devices list keeps up by itself after)
  useEffect(() => {
    if (!on) return;
    setStep({ kind: 'idle' });
    void loadSettings().catch((err) => setError(message(err)));
    void loadDevices().catch(() => undefined);
  }, [on]);

  // asking to join: the request is looked at every 2 s until it's answered or lapses
  useEffect(() => {
    if (step.kind !== 'asking') return;
    const timer = window.setInterval(() => {
      pollJoin(step.id, step.secret)
        .then((state) => {
          if (state === 'denied' || state === 'lapsed') setStep({ kind: state });
          else if (state === 'approved') setStep({ kind: 'idle' });
        })
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
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

  const turnOn = () =>
    doing(async () => {
      const info = await refreshAgent();
      if (!info) throw new Error('Can’t reach HO[LO]’s host');
      if (info.allowed) await setSettings({ enabled: true });
      else if (info.pairing) {
        await startPairing();
        setStep({ kind: 'code' });
      } else if (info.enabled) {
        const r = await askToJoin(device());
        setStep({ kind: 'asking', ...r });
      } else throw new Error('The agent is off: turn it on from a device that’s allowed to use it');
    });

  const turnOff = () => {
    if (allowed) void doing(() => setSettings({ enabled: false }));
    else {
      setStep({ kind: 'idle' });
      setError('');
    }
  };

  const starting = step.kind !== 'idle';
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
        <span className="muted">Off: no agent, and nothing in HO[LO] mentions one.</span>
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

/** Turning it on from a device not allowed yet: the runner's code, or asking an allowed device. */
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
  if (step.kind === 'code') {
    const send = () => void doing(() => pair(code, device()));
    return (
      <div className="agent-join">
        <label htmlFor="agent-code">Enter the code the runner printed on the host</label>
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
              if (e.key === 'Enter' && code.length === 6) send();
            }}
          />
          <button type="button" className="btn primary" disabled={busy || code.length !== 6} onClick={send}>
            Pair
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() =>
              void doing(async () => {
                setCode('');
                await startPairing();
              })
            }
          >
            New code
          </button>
        </div>
        <span className="muted">It works once, for 10 minutes. The runner shows it where it runs (pnpm runner).</span>
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
      </div>
    );
  }
  if (step.kind === 'denied') return <div className="agent-join muted">That device said no.</div>;
  if (step.kind === 'lapsed')
    return <div className="agent-join muted">The request lapsed: turn it on to ask again.</div>;
  return null;
}

/** The agent on, for this device: how it runs, what it may do, and who may use it. */
function Allowed() {
  const settings = useAgent((a) => a.settings);
  const runner = useAgent((a) => a.info?.runner);
  if (!settings) return <div className="muted">Reading the agent’s settings…</div>;
  const found = settings.harnesses.filter((h) => h.found);
  const usable = found.filter((h) => h.sealed);
  const current = found.find((h) => h.id === settings.harness) ?? usable[0] ?? null;
  return (
    <>
      <div className="agent-grid">
        <span className="agent-key">Harness</span>
        {found.length ? (
          <HarnessPicker found={found} current={current} />
        ) : (
          <div className="hstack" style={{ flexWrap: 'wrap' }}>
            <span className="muted">
              {runner?.keyed
                ? 'No harness found on the host: install Claude Code, Codex or Cursor there.'
                : 'Start the runner on the host (pnpm runner): it finds Claude Code, Codex and Cursor.'}
            </span>
            {runner?.keyed && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => void lookForHarnesses().catch(() => undefined)}
              >
                Look again
              </button>
            )}
          </div>
        )}
        {current && <HarnessRows harness={current} model={settings.model} effort={settings.effort} />}
        <span className="agent-key">Asks first</span>
        <span>Before downloading a pack, importing samples, or sending a song to its creation</span>
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

function HarnessPicker({ found, current }: { found: HarnessInfo[]; current: HarnessInfo | null }) {
  // the others that could run it; those that can't say why
  const others = found.filter((h) => h !== current && h.sealed);
  const unusable = found.filter((h) => !h.sealed);
  return (
    <div className="hstack" style={{ flexWrap: 'wrap', gap: 10 }}>
      <select
        className="select agent-select"
        aria-label="Harness"
        value={current?.id ?? ''}
        onChange={(e) =>
          // another harness takes its own models: theirs start from its default
          void setSettings({ harness: e.target.value as HarnessId, model: '', effort: '' }).catch(() => undefined)
        }
      >
        {found.map((h) => (
          <option key={h.id} value={h.id} disabled={!h.sealed}>
            {h.name}
            {h.version ? ` ${h.version}` : ''}
            {!h.sealed ? ' (unavailable)' : h.signedIn === false ? ' (signed out)' : ''}
          </option>
        ))}
      </select>
      <span className="muted">
        {others.length > 0 && `Also here: ${others.map((h) => h.name).join(', ')}`}
        {unusable.map((h) => (
          <span key={h.id} className="agent-why">
            {h.name} can’t be limited to HO[LO]’s tools{h.reason ? `: ${h.reason}` : ''}
          </span>
        ))}
      </span>
    </div>
  );
}

/** The harness's model and effort, its sign-in when it's signed out, and its update when there's one. */
function HarnessRows({ harness: h, model, effort }: { harness: HarnessInfo; model: string; effort: string }) {
  const event = useAgent((a) => a.harness[h.id]);
  const [confirm, setConfirm] = useState(false);
  const [code, setCode] = useState('');
  const [typed, setTyped] = useState(model);
  useEffect(() => setTyped(model), [model]);
  const login = event?.kind === 'login' ? event : null;
  const update = event?.kind === 'update' ? event : null;
  return (
    <>
      <span className="agent-key">Model</span>
      <div className="hstack" style={{ flexWrap: 'wrap', gap: 10 }}>
        {h.models?.length ? (
          <select
            className="select agent-select"
            aria-label="Model"
            value={model}
            onChange={(e) => void setSettings({ model: e.target.value }).catch(() => undefined)}
          >
            <option value="">{h.name}’s default</option>
            {h.models.map((m) => (
              <option key={m} value={m}>
                {shown(m)}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input agent-select"
            aria-label="Model"
            placeholder={`${h.name}’s default`}
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
        <span className="muted">
          {h.models?.length ? `${h.name}’s names, or its default` : 'A model’s name, or empty for the default'}
        </span>
      </div>
      {h.efforts?.length ? (
        <>
          <span className="agent-key">Effort</span>
          <div className="hstack" style={{ flexWrap: 'wrap', gap: 10 }}>
            <select
              className="select agent-select"
              aria-label="Effort"
              value={effort}
              onChange={(e) => void setSettings({ effort: e.target.value }).catch(() => undefined)}
            >
              <option value="">{h.name}’s default</option>
              {h.efforts.map((x) => (
                <option key={x} value={x}>
                  {shown(x)}
                </option>
              ))}
            </select>
            <span className="muted">{h.efforts.join(', ')}</span>
          </div>
        </>
      ) : null}
      {h.signedIn === false && (
        <>
          <span className="agent-key">Sign-in</span>
          <div className="vstack">
            <div className="hstack" style={{ flexWrap: 'wrap', gap: 10 }}>
              <span>{h.name} is signed out on the host.</span>
              <button
                type="button"
                className="btn"
                disabled={login?.state === 'running'}
                onClick={() => void harnessAction(h.id, 'login').catch(() => undefined)}
              >
                Sign in
              </button>
            </div>
            {login?.url && (
              <span>
                Open{' '}
                <a href={login.url} target="_blank" rel="noopener noreferrer">
                  {login.url}
                </a>{' '}
                on any device to sign in{login.code ? ', with the code ' : '.'}
                {login.code && <b className="mono">{login.code}</b>}
              </span>
            )}
            {login?.ask === 'code' && login.state === 'running' && (
              <div className="hstack">
                <input
                  className="input agent-select"
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
                      () => undefined,
                    )
                  }
                >
                  Send
                </button>
              </div>
            )}
            {login?.line && <span className="muted">{login.line}</span>}
            {login?.state === 'failed' && (
              <span className="agent-error">{login.error ?? 'The sign-in didn’t finish'}</span>
            )}
          </div>
        </>
      )}
      {h.update?.available && (
        <>
          <span className="agent-key">Update</span>
          <div className="vstack">
            {!confirm ? (
              <div>
                <button
                  type="button"
                  className="btn"
                  disabled={update?.state === 'running'}
                  onClick={() => setConfirm(true)}
                >
                  Update to {h.update.latest ?? 'the latest version'}
                </button>
              </div>
            ) : (
              <div className="hstack" role="alertdialog" aria-label={`Update ${h.name}?`} style={{ flexWrap: 'wrap' }}>
                <span>This updates the {h.name} your terminal uses too.</span>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => {
                    setConfirm(false);
                    void harnessAction(h.id, 'update').catch(() => undefined);
                  }}
                >
                  Update
                </button>
                <button type="button" className="btn ghost" onClick={() => setConfirm(false)}>
                  Not now
                </button>
              </div>
            )}
            {update?.line && <span className="muted">{update.line}</span>}
            {update?.state === 'failed' && <span className="agent-error">{update.error ?? 'The update failed'}</span>}
          </div>
        </>
      )}
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
          <div key={d.id} className="list-item" style={{ cursor: 'default' }}>
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
          <div key={r.id} className="list-item agent-request" style={{ cursor: 'default' }}>
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
