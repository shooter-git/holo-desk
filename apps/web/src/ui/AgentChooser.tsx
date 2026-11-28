/**
 * On the agent's page: the line in its header that says what the song's conversation runs with and
 * what's left of that account's usage, and the chooser it opens ("Continue this conversation with"):
 * the harnesses that are ready as buttons, the model and effort to run the one picked with, and
 * Continue. Under a request that failed, Continue carries that request on with what's picked;
 * otherwise it's what the song's next request runs with. Either way it's this song's own choice from
 * then on (the other songs follow Settings › Agent), until it's changed here, "As in Settings" is
 * picked, or the conversation is started over. The words and the rules are ui/agent-chooser.ts's.
 */
import { useEffect, useState } from 'react';
import {
  conversation,
  type Exchange,
  HARNESS_NAME,
  type HarnessId,
  loadSettings,
  lookAtHarnesses,
  serverNow,
  setChoice,
  showChooser,
  tryAgain,
  useAgent,
} from '../app/agent.ts';
import {
  asksFirst,
  canMove,
  choiceOf,
  chooserFor,
  chooserNote,
  type Offer,
  offers,
  runsLine,
  runsNow,
  toPick,
} from './agent-chooser.ts';
import { caution, choices, effortsFor, runsWith, shown } from './harness-row.ts';

/** A model's name as a harness takes it (as Settings › Agent checks what's typed). */
const MODEL = /^[A-Za-z0-9][\w.:\-[\]=]{0,79}$/;

/**
 * The header's line. A press opens the chooser under the conversation (and puts it away again); not
 * while a request works on the song, when nothing of it can change. Nothing shows until the host has
 * said what it runs with.
 */
export function RunsLine({ project, busy }: { project: string; busy: boolean }) {
  const a = useAgent((s) => s);
  const known = a.settings !== null;
  // what the host has of its harnesses, when this page hasn't heard yet
  useEffect(() => {
    if (!known) void loadSettings().catch(() => undefined);
  }, [known]);
  // and their limits read again if that was a while ago (the host sees to how often), as the page opens
  useEffect(() => {
    void lookAtHarnesses().catch(() => undefined);
  }, []);
  const runs = runsNow(a, project);
  if (!runs) return null;
  const line = runsLine(runs, { now: serverNow() }, conversation(a, project).at(-1) ?? null);
  const open = a.choosing === project;
  return (
    <button
      type="button"
      className="talk-runs"
      title="What this song’s conversation runs with"
      aria-expanded={open}
      disabled={busy}
      onClick={() => showChooser(open ? null : project)}
    >
      {line.text}
      {line.usage && (
        <>
          {' · '}
          <span className={line.usage.warn ? 'warn' : undefined}>{line.usage.text}</span>
        </>
      )}
    </button>
  );
}

/** "Continue with…" under a failed reply, where there's something to continue with. */
export function MoveButton({ ex, project }: { ex: Exchange; project: string }) {
  const a = useAgent((s) => s);
  if (!canMove(offers(a, project, ex, { now: serverNow() }), ex)) return null;
  return (
    <button type="button" className="btn" onClick={() => showChooser(project)}>
      Continue with…
    </button>
  );
}

/** A menu's empty choice, short enough for half a phone's width: "Medium (default)", or what it is when the harness doesn't say. */
const byDefault = (value: string | null | undefined, unknown: string) =>
  value ? `${shown(value)} (default)` : unknown;

/** The model and effort the picked harness runs with: its own lists, its defaults named where it says them. */
function RunWith({
  offer,
  onChange,
}: {
  offer: Offer;
  /** `bad`: what's typed for the model isn't a model's name (nothing is sent until it is). */
  onChange: (model: string, effort: string, bad?: boolean) => void;
}) {
  const { h, model, effort } = offer;
  const [typed, setTyped] = useState(model);
  const must = !!h.mustChoose;
  const models = choices(h.models ?? [], model, h.aliases);
  const own = effortsFor(h, model);
  const efforts = choices(own ?? [], effort);
  return (
    <div className="talk-choose-run">
      {h.models?.length ? (
        <select
          className="select"
          aria-label="Model"
          value={model}
          // an effort the new model doesn't take goes with the old one
          onChange={(e) => {
            const next = e.target.value;
            onChange(next, !effort || effortsFor(h, next)?.includes(effort) ? effort : '');
          }}
        >
          <option value="" disabled={must}>
            {must ? 'Choose a model' : byDefault(h.defaultModel, `${h.name}’s default`)}
          </option>
          {models.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="input"
          aria-label="Model"
          placeholder={must ? 'Type a model’s name' : byDefault(h.defaultModel, `${h.name}’s default`)}
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            const next = e.target.value.trim();
            const fine = next === '' || MODEL.test(next);
            onChange(fine ? next : model, effort, !fine);
          }}
        />
      )}
      {own?.length ? (
        <select className="select" aria-label="Effort" value={effort} onChange={(e) => onChange(model, e.target.value)}>
          <option value="" disabled={must}>
            {must ? 'Choose an effort' : byDefault(runsWith(h, model, '').effort, 'Default effort')}
          </option>
          {efforts.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

/**
 * The chooser. `ex`: the failed exchange Continue carries on (the conversation's last, asked from this
 * device); without one, what's picked is what the song's next request runs with.
 */
export function Chooser({ project, ex }: { project: string; ex: Exchange | null }) {
  const known = useAgent((s) => s.settings !== null);
  // (nothing to offer until the host's harnesses are known: it's on its way)
  return known ? <Choosing project={project} ex={ex} /> : null;
}

function Choosing({ project, ex }: { project: string; ex: Exchange | null }) {
  const a = useAgent((s) => s);
  const now = serverNow();
  // (with nothing to carry the failed request on with, it's the chooser for the song's next requests)
  const { o, carries } = chooserFor(a, project, ex, { now });
  const carried = carries ? ex : null;
  const [picked, setPicked] = useState<HarnessId | 'settings' | null>(o.selected);
  const [edits, setEdits] = useState<Partial<Record<HarnessId, { model: string; effort: string; bad?: boolean }>>>({});
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const offer = o.ready.find((r) => r.h.id === picked);
  const edit = offer ? edits[offer.h.id] : undefined;
  const pick: Offer | 'settings' | null =
    picked === 'settings'
      ? o.settings
        ? 'settings'
        : null
      : offer
        ? { ...offer, ...(edit ? { model: edit.model, effort: edit.effort } : {}) }
        : null;
  const missing = edit?.bad ? 'That isn’t a model’s name' : toPick(pick);
  const note = chooserNote(pick && pick !== 'settings' ? pick : null, o.notes, { now });
  // a harness whose vendor doesn't support it here asks first (picked by name, or as what Settings
  // says), unless the conversation already runs with it
  const asks = asksFirst(pick, o, runsNow(a, project));
  const warning = asks ? caution({ id: asks }) : null;

  const go = async () => {
    if (!pick) return;
    const choice = choiceOf(pick);
    setBusy(true);
    setError('');
    try {
      if (carried) {
        // (a refusal shows as the reply, as a request's does)
        showChooser(null);
        await tryAgain(carried, project, choice);
      } else {
        await setChoice(project, choice);
        showChooser(null);
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of the page's own controls, not a form's fieldset
    <div className="talk-choose" role="group" aria-label="Continue this conversation with">
      <div className="talk-choose-title">Continue this conversation with</div>
      {o.ready.length > 0 || o.settings ? (
        <div className="seg talk-choose-seg">
          {o.ready.map((r) => (
            <button
              key={r.h.id}
              type="button"
              className={`btn${picked === r.h.id ? ' on' : ''}`}
              aria-pressed={picked === r.h.id}
              onClick={() => {
                setPicked(r.h.id);
                setAsking(false);
              }}
            >
              {r.h.name}
            </button>
          ))}
          {o.settings && (
            <button
              type="button"
              className={`btn${picked === 'settings' ? ' on' : ''}`}
              aria-pressed={picked === 'settings'}
              onClick={() => {
                setPicked('settings');
                setAsking(false);
              }}
            >
              As in Settings
            </button>
          )}
        </div>
      ) : (
        <div className="talk-choose-note">No harness on the host is ready: Settings › Agent says what each needs.</div>
      )}
      {pick && pick !== 'settings' && (
        <RunWith
          key={pick.h.id}
          offer={pick}
          onChange={(model, effort, bad) =>
            setEdits((was) => ({ ...was, [pick.h.id]: { model, effort, ...(bad ? { bad } : {}) } }))
          }
        />
      )}
      {pick === 'settings' && o.settings && (
        <div className="talk-choose-note">Settings › Agent: {o.settings.text}.</div>
      )}
      {note && <div className={`talk-choose-note${note.warn ? ' warn' : ''}`}>{note.text}</div>}
      {error && (
        <div className="talk-choose-note warn" role="alert">
          {error}
        </div>
      )}
      {asking && warning ? (
        <div className="talk-choose-ask" role="alertdialog" aria-label={`Use ${HARNESS_NAME[asks as HarnessId]}?`}>
          <span>
            {warning.text}{' '}
            <a href={warning.link} target="_blank" rel="noopener noreferrer">
              {warning.source}
            </a>
          </span>
          <div className="btns">
            <button type="button" className="btn ghost" onClick={() => setAsking(false)}>
              Not now
            </button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void go()}>
              Use it anyway
            </button>
          </div>
        </div>
      ) : (
        <div className="btns">
          {missing && pick && <span className="grow bar-line">{missing}</span>}
          <button type="button" className="btn ghost" onClick={() => showChooser(null)}>
            Not now
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || missing !== null}
            onClick={() => (warning ? setAsking(true) : void go())}
          >
            {carried ? 'Continue' : 'Use for this song'}
          </button>
        </div>
      )}
    </div>
  );
}
