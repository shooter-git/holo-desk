/**
 * The Notes view's Macros dialog: Correct Pitch, Quantize Time and Level (note edits of NOTE_EDITS, as
 * the agent's `audio_notes` and `holo notes` make them), on the notes selected, or all the region
 * plays when none are. One section per macro, its controls made from the edit's arguments
 * (note-macros.ts), so an argument added to a macro shows up here by itself.
 *
 * - **One macro at a time.** The section last touched is the one that applies; the others stand by,
 *   dim, keeping their settings. Choosing another puts the notes back as they were and previews it.
 * - **Live.** A change previews at once (`beginGesture`, `gestureChange`): the song plays it, and the
 *   Notes view draws it behind the dialog. Apply ends it as one undo step named after the macro;
 *   Cancel, Escape or a press outside put the notes back, with no step. A preview that comes to the
 *   notes as they were leaves the song as it was.
 * - **Level** needs each note's level as recorded, read from the curve the notes were found with; while
 *   that's still being found, its section says so.
 * - On a phone it's a sheet over the whole screen.
 */
import {
  type AudioClip,
  type NoteEdit,
  type NoteEditContext,
  type AudioNotes as NoteList,
  noteEdit,
} from '@holo/session';
import { useEffect, useRef, useState } from 'react';
import { beginGesture, cancelGesture, endGesture, gestureChange } from '../app/actions.ts';
import { Dialog } from './Dialogs.tsx';
import {
  type MacroControl,
  type MacroValues,
  macroArgs,
  macroControls,
  macroValues,
  meanLevel,
  NOTE_MACROS,
  valueText,
} from './note-macros.ts';

/** What the dialog works on, as it was when it opened: the region, its notes, and the notes chosen. */
export interface MacroSession {
  track: string;
  region: string;
  /** The region's recording as it was (the previewed notes go in a copy of it). */
  clip: AudioClip;
  /** The notes the macros start from, every preview again (the region's own, or those found to keep). */
  base: NoteList;
  /** The notes they work on: the selection, or all the region plays. */
  indices: number[];
  selected: boolean;
  /** The song and the region, for the key's scale and the grid. */
  ctx: NoteEditContext;
}

/** Why a macro can't be used on these notes now, or null. */
function unavailable(edit: NoteEdit, session: MacroSession, levels: readonly (number | null)[] | null): string | null {
  if (!edit.modes.includes(session.base.mode)) return 'For a line’s notes only (a voice, a solo instrument).';
  if (edit.needsLevels && !levels) return 'Reading the notes’ levels from the recording…';
  if (edit.needsLevels && !session.indices.some((i) => typeof levels?.[i] === 'number'))
    return 'These notes’ levels can’t be read from the recording.';
  return null;
}

function Control({
  c,
  value,
  onChange,
}: {
  c: MacroControl;
  value: number | string | boolean | null;
  onChange: (v: number | string | boolean | null) => void;
}) {
  if (c.kind === 'switch')
    return (
      <label className="hstack macro-row" title={c.help}>
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {c.label}
      </label>
    );
  if (c.kind === 'choice')
    return (
      <div className="vstack macro-row">
        <span className="muted" title={c.help}>
          {c.label}
        </span>
        {c.list ? (
          <select
            className="select"
            value={String(value)}
            aria-label={c.label}
            title={c.help}
            onChange={(e) => onChange(e.target.value)}
          >
            {c.values.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </select>
        ) : (
          <div className="seg" role="radiogroup" aria-label={c.label} title={c.help}>
            {c.values.map((v) => (
              // biome-ignore lint/a11y/useSemanticElements: the studio's segmented buttons, as a radio group
              <button
                key={v.value}
                type="button"
                role="radio"
                aria-checked={value === v.value}
                className={`btn${value === v.value ? ' on' : ''}`}
                onClick={() => onChange(v.value)}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  const off = value === null;
  return (
    <div className="vstack macro-row">
      <span className="hstack">
        {c.optional ? (
          <label className="hstack grow" title={c.help}>
            <input
              type="checkbox"
              checked={!off}
              aria-label={`${c.label}: set one`}
              onChange={(e) => onChange(e.target.checked ? c.start : null)}
            />
            <span className="muted">{c.label}</span>
          </label>
        ) : (
          <span className="muted grow" title={c.help}>
            {c.label}
          </span>
        )}
        <span className="mono">{valueText(c, value)}</span>
      </span>
      <input
        type="range"
        min={c.min}
        max={c.max}
        step={c.step}
        value={off ? c.start : Number(value)}
        disabled={off}
        aria-label={c.label}
        title={c.help}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="muted macro-help">{c.help}</span>
    </div>
  );
}

export function NoteMacros({
  session,
  levels,
  phone,
  onClose,
}: {
  session: MacroSession;
  /** Each note's level as recorded, by index (null while it's still being read). */
  levels: readonly (number | null)[] | null;
  phone: boolean;
  onClose: () => void;
}) {
  const macros = NOTE_MACROS.map((m) => ({ ...m, def: noteEdit(m.edit) })).filter(
    (m): m is (typeof NOTE_MACROS)[number] & { def: NoteEdit } => !!m.def,
  );
  const [controls] = useState(() => {
    const mean = levels ? meanLevel(levels, session.indices) : null;
    return Object.fromEntries(
      macros.map((m) => [m.edit, macroControls(m.def, mean === null ? {} : { target: Math.round(mean * 2) / 2 })]),
    );
  });
  const [values, setValues] = useState<Record<string, MacroValues>>(() =>
    Object.fromEntries(macros.map((m) => [m.edit, macroValues(controls[m.edit] ?? [])])),
  );
  const firstUsable = macros.find((m) => !unavailable(m.def, session, levels))?.edit ?? macros[0]?.edit ?? '';
  const [active, setActive] = useState(firstUsable);
  /** The undo step under way: the macro previewed (null: the notes are as they were). */
  const previewing = useRef<string | null>(null);
  const finished = useRef(false);

  /** A macro's result on the notes, previewed: the song changed as one gesture under its name. */
  const preview = (edit: string, vals: MacroValues) => {
    const m = macros.find((x) => x.edit === edit);
    if (!m || unavailable(m.def, session, levels)) return;
    const next = m.def.apply(session.base, session.indices, macroArgs(vals), {
      ...session.ctx,
      ...(levels ? { levels } : {}),
    });
    if (next === session.base || previewing.current !== m.name) {
      // the notes as they were (or another macro's preview put back first): no step
      if (previewing.current) cancelGesture();
      previewing.current = null;
      if (next === session.base) return;
      beginGesture(m.name);
      previewing.current = m.name;
    }
    gestureChange([
      {
        op: 'updateRegion',
        track: session.track,
        region: session.region,
        patch: { audio: { ...session.clip, notes: next } },
      },
    ]);
  };

  // what's open previews as it opens (the first macro at its settings), and is put back if the dialog goes unapplied
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, as it opens
  useEffect(() => {
    preview(active, values[active] ?? {});
    return () => {
      if (!finished.current && previewing.current) cancelGesture();
      previewing.current = null;
    };
  }, []);
  // levels read once it's open: Level's preview follows
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the levels come
  useEffect(() => {
    if (levels && active === 'level') preview(active, values[active] ?? {});
  }, [levels]);

  const choose = (edit: string) => {
    if (edit === active) return;
    setActive(edit);
    preview(edit, values[edit] ?? {});
  };
  const change = (edit: string, arg: string, v: number | string | boolean | null) => {
    const vals = { ...(values[edit] ?? {}), [arg]: v };
    setValues({ ...values, [edit]: vals });
    setActive(edit);
    preview(edit, vals);
  };
  const cancel = () => {
    finished.current = true;
    if (previewing.current) cancelGesture();
    previewing.current = null;
    onClose();
  };
  const applyIt = () => {
    finished.current = true;
    if (previewing.current) endGesture();
    previewing.current = null;
    onClose();
  };

  const count = session.indices.length;
  const scope = session.selected
    ? `On the ${count === 1 ? 'selected note' : `${count} selected notes`}`
    : `On all ${count === 1 ? '1 note' : `${count} notes`} the region plays`;
  return (
    <Dialog
      title="Macros"
      className={`macros${phone ? ' full' : ''}`}
      onClose={cancel}
      footer={
        <>
          <span className="muted grow macro-scope">{scope}</span>
          <button type="button" className="btn" onClick={cancel}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={applyIt}>
            Apply
          </button>
        </>
      }
    >
      <div className="vstack macro-list">
        {macros.map((m) => {
          const why = unavailable(m.def, session, levels);
          const on = m.edit === active;
          return (
            <section key={m.edit} className={`macro${on ? ' on' : ''}`} aria-label={m.name}>
              <button
                type="button"
                className="macro-head"
                aria-pressed={on}
                disabled={!!why}
                onClick={() => choose(m.edit)}
              >
                <span className="strong">{m.name}</span>
                <span className="muted">{m.def.summary}</span>
              </button>
              {why ? (
                <p className="muted macro-why">{why}</p>
              ) : (
                (controls[m.edit] ?? []).map((c) => (
                  <Control
                    key={c.arg}
                    c={c}
                    value={values[m.edit]?.[c.arg] ?? null}
                    onChange={(v) => change(m.edit, c.arg, v)}
                  />
                ))
              )}
            </section>
          );
        })}
      </div>
    </Dialog>
  );
}
