/**
 * The bar (Ctrl /, the search button in the control bar, or a swipe down on a phone's top bar): the
 * studio's commands, tracks and markers, found by name. It's one of the studio's menus with a field on
 * top (the same glass, rows, blue highlight and key hints), so nothing looks bolted on. While it's open
 * the field has the keys: Up and Down choose, Enter runs, Escape closes, and the studio's shortcuts
 * wait. The song plays on.
 *
 * With the agent on for this device, the field takes requests too: what's typed can be sent ("Ask the
 * agent"), and under the field is the song's last exchange, the request then the reply, with at most
 * the one button it needs (Stop, a permission, Copy brief, Done). Nothing else in the studio shows it.
 */
import { Search } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import {
  addTrack,
  bounceSong,
  deleteSelection,
  locate,
  moveBars,
  playheadTick,
  quantizeSelection,
  redo,
  repeatRegions,
  saveNow,
  selectAll,
  selectTrack,
  sendToCreation,
  splitAtPlayhead,
  stop,
  toggleCycle,
  toggleFullscreen,
  toggleMetronome,
  togglePlay,
  toggleRecord,
  transposeSelection,
  undo,
  updateChannel,
} from '../app/actions.ts';
import {
  agent,
  ask,
  doneListening,
  type Exchange,
  exchange,
  isLive,
  isOn,
  loadThread,
  newConversation,
  type Permission,
  permit,
  requestContext,
  stopJob,
  useAgent,
} from '../app/agent.ts';
import { type Actions, barRows, type Command, type Extra, selectionHint } from '../app/commands.ts';
import { toggleTyping } from '../app/keys.ts';
import { isPhone, useLayout } from '../app/layout.ts';
import { closeBar, openBar, store, useApp } from '../app/store.ts';
import { installs, useInstalls } from '../audio/installs.ts';
import { closeMenu } from './menu.tsx';

/** What the bar's commands do: the same actions the keys and buttons use. */
const ACTIONS: Actions = {
  set: (patch) => store.set(patch),
  togglePlay: () => void togglePlay(),
  toggleRecord: () => void toggleRecord(),
  toggleCycle,
  toggleMetronome,
  stop,
  locate,
  moveBars,
  toggleFullscreen,
  toggleTyping,
  undo,
  redo,
  deleteSelection,
  selectAll,
  quantizeSelection,
  splitAtPlayhead,
  repeatRegions,
  transposeSelection,
  selectTrack,
  setChannel: (track, patch, label) => updateChannel(track, patch, label),
  newTrack: () => void addTrack({ type: 'synth', preset: 'Soft Keys' }),
  save: () => void saveNow(),
  bounce: () => void bounceSong(true),
};

/** How far down, and how quickly, a finger goes for a swipe that opens the bar (less is a tap or a slip). */
const SWIPE_PX = 36;
const SWIPE_MS = 600;

/**
 * On a phone held upright, a short swipe down that starts on the top bar opens the bar. It only
 * watches (nothing is held back), so a tap on the bar's buttons is still a tap.
 */
function useSwipeDown(): void {
  useEffect(() => {
    let from: { x: number; y: number; at: number } | null = null;
    let to: { x: number; y: number } | null = null;
    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      const onBar = (e.target as Element | null)?.closest?.('.phone-portrait > .control-bar');
      from = e.touches.length === 1 && t && onBar ? { x: t.clientX, y: t.clientY, at: e.timeStamp } : null;
      to = from;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (from && t) to = { x: t.clientX, y: t.clientY };
    };
    // the browser may take a moving finger for a scroll and cancel it: where it got to still counts
    const end = (e: TouchEvent) => {
      if (from && to) {
        const down = to.y - from.y;
        if (down >= SWIPE_PX && down > 1.5 * Math.abs(to.x - from.x) && e.timeStamp - from.at < SWIPE_MS) openBar();
      }
      from = null;
      to = null;
    };
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchmove', move, { passive: true });
    document.addEventListener('touchend', end, { passive: true });
    document.addEventListener('touchcancel', end, { passive: true });
    return () => {
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', end);
      document.removeEventListener('touchcancel', end);
    };
  }, []);
}

/** What a permission's one button says. */
const ALLOW: Record<Permission['kind'], string> = {
  'install-pack': 'Install it',
  'send-creation': 'Send it',
  screen: 'Share the screen',
  photo: 'Take a photo',
};

/**
 * The one button a job's permission needs: a click runs the studio's own code (the Library's install
 * queue, sending the song to its creation), then the host hears what happened and the agent carries on.
 */
function PermissionButton({ job, permission }: { job: string; permission: Permission }) {
  const [busy, setBusy] = useState(false);
  const install = useInstalls();
  const [failed, setFailed] = useState('');
  const run = async () => {
    setBusy(true);
    setFailed('');
    try {
      if (permission.kind === 'install-pack' && permission.pack) {
        if (!install.packs) await installs.load();
        const name = installs.pack(permission.pack)?.name ?? permission.pack;
        // (named, so the Library shows it in its queue, and no toast says it's in: the reply will)
        const ok = await installs.install([permission.pack], name);
        await permit(job, true, ok ? `Installed ${name}` : `${name} couldn’t be installed`);
      } else if (permission.kind === 'send-creation') {
        const sent = await sendToCreation(true);
        await permit(
          job,
          true,
          sent ? sent.text : 'This song didn’t come from a creation, so there’s none to send it to',
        );
      } else {
        // TODO(C13): capture the screen (getDisplayMedia) or take a photo, preview it, upload it as an
        // attachment of the job's, and grant with its id. Until then the agent hears it can't have one.
        await permit(job, false, 'not available yet');
      }
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const installing = busy && permission.kind === 'install-pack' ? install.job?.line : null;
  return (
    <>
      {installing && <span className="muted grow bar-line">{installing}</span>}
      {failed && <span className="agent-error grow bar-line">{failed}</span>}
      <button type="button" className="btn" disabled={busy} onClick={() => void run()}>
        {busy ? (permission.kind === 'install-pack' ? 'Installing…' : 'Sending…') : ALLOW[permission.kind]}
      </button>
    </>
  );
}

/** A brief for the user's own harness, in full: the lines that run something or link somewhere are marked. */
function Brief({ text, flagged }: { text: string; flagged: Exchange['flagged'] }) {
  return (
    <div className="brief" role="document" aria-label="Brief">
      {text.split('\n').map((line, i) => {
        const flag = flagged.get(i);
        return (
          <div key={i} className={flag ? 'flag' : undefined}>
            {line || '\u00a0'}
            {flag && <span className="why">{flag === 'url' ? 'a link: check where it goes' : 'runs a command'}</span>}
          </div>
        );
      })}
    </div>
  );
}

function CopyBrief({ text }: { text: string }) {
  const [said, setSaid] = useState('');
  return (
    <button
      type="button"
      className="btn"
      onClick={() =>
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setSaid('Copied'))
          // (a page served over plain http on the network may not write to the clipboard)
          .catch(() => setSaid('Select it above to copy'))
      }
    >
      {said || 'Copy brief'}
    </button>
  );
}

/** The song's last exchange under the field: the request, then the work going on or the reply, then its button. */
function Talk({ ex }: { ex: Exchange }) {
  const buttons = [
    ex.listening && ex.job && ex.mine && (
      <button key="done" type="button" className="btn primary" onClick={() => void doneListening(ex.job as string)}>
        Done
      </button>
    ),
    ex.permission && ex.job && ex.mine && <PermissionButton key="allow" job={ex.job} permission={ex.permission} />,
    ex.brief && <CopyBrief key="brief" text={ex.brief} />,
  ].filter(Boolean);
  return (
    <div className="talk" aria-live="polite">
      <div className="you">{ex.request}</div>
      {ex.working ? (
        <div className="status">
          <span className="ring" aria-hidden="true" />
          <span className="grow bar-line">{ex.line ?? 'Working on it'}</span>
          {ex.job && (
            <button
              type="button"
              className="btn ghost small"
              onClick={() => void stopJob(ex.job as string).catch(() => undefined)}
            >
              Stop
            </button>
          )}
        </div>
      ) : (
        ex.reply && <div className="reply">{ex.reply}</div>
      )}
      {ex.brief && <Brief text={ex.brief} flagged={ex.flagged} />}
      {buttons.length > 0 && <div className="btns">{buttons}</div>}
    </div>
  );
}

function BarPanel() {
  const app = useApp((s) => s);
  const a = useAgent((x) => x);
  const layout = useLayout();
  const phone = isPhone(layout);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const playhead = playheadTick();
  const state = { ...app, playhead, phone };
  const project = app.project?.id ?? null;
  const on = isOn(a);
  const ex = exchange(a, project);
  const typed = query.trim() !== '';
  // with nothing typed, the song's last exchange stands in for the list
  const talking = on && ex !== null && !typed;
  const extra: Extra =
    on && project
      ? {
          ask: (text) => ({
            id: 'ask',
            title: 'Ask the agent',
            group: 'Agent',
            keys: '↵',
            keepOpen: true,
            run: () => void ask(text, project, requestContext(app, playhead, phone)),
          }),
          commands: [
            {
              id: 'agent-new',
              title: 'Start a new conversation with the agent',
              group: 'Agent',
              also: 'start over reset clear forget',
              available: () => !Object.values(a.jobs).some((j) => j.project === project && isLive(j.state)),
              run: () => void newConversation(project).catch(() => undefined),
            },
          ],
        }
      : {};
  const rows = talking ? [] : barRows(query, state, ACTIONS, extra);
  const at = Math.max(0, Math.min(active, rows.length - 1));
  const hint = talking ? '' : selectionHint(state);

  const run = (c: Command) => {
    if (!c.keepOpen) closeBar();
    c.run();
    if (c.keepOpen) {
      setQuery('');
      setActive(0);
    }
  };

  useEffect(() => {
    // a menu left open would keep the arrow keys; the keyboard comes back to where it was when the bar closes
    closeMenu();
    const was = document.activeElement;
    field.current?.focus({ preventScroll: true });
    // the reply that came while it was closed has been seen; the song's conversation is read afresh
    agent.dispatch({ type: 'seen' });
    const song = store.get().project?.id;
    if (song) void loadThread(song);
    return () => {
      if (was instanceof HTMLElement && was.isConnected) was.focus({ preventScroll: true });
    };
  }, []);

  // the chosen row stays in sight where the list scrolls (a phone on its side, with its keyboard up)
  // biome-ignore lint/correctness/useExhaustiveDependencies: run when the chosen row or the rows change, read from the page
  useEffect(() => {
    list.current?.querySelector('.hl')?.scrollIntoView({ block: 'nearest' });
  }, [at, query]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (rows.length) setActive((at + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === 'Enter') {
      const row = rows[at];
      if (row) run(row);
    } else if (e.key === 'Escape') closeBar();
    // the keyboard stays in the field, unless the exchange under it has a button to reach
    else if (e.key !== 'Tab' || talking) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const placeholder = !on
    ? layout === 'phone-portrait'
      ? 'Search commands, tracks…'
      : 'Search commands, tracks, markers, sounds'
    : ex
      ? 'Reply…'
      : layout === 'phone-portrait'
        ? 'Ask, or type a command'
        : 'Ask anything, or type a command';

  return (
    // a press outside closes the bar and goes no further, as a menu's does
    <div className="bar-scrim" onPointerDown={(e) => e.target === e.currentTarget && closeBar()}>
      <div className="bar" role="dialog" aria-modal="true" aria-label="Commands">
        <div className="field">
          <Search aria-hidden="true" />
          <input
            ref={field}
            type="text"
            role="combobox"
            aria-label={on ? 'Ask, or search commands' : 'Search commands'}
            aria-expanded={rows.length > 0}
            aria-controls={`${id}-list`}
            aria-activedescendant={rows.length ? `${id}-${at}` : undefined}
            aria-autocomplete="list"
            // a phone held upright has room for the start of it beside the selection's words
            placeholder={placeholder}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
          {hint && <span className="ctx">{hint}</span>}
        </div>
        {talking && ex && <Talk ex={ex} />}
        <div ref={list} className="list" role="listbox" id={`${id}-list`} aria-label="Commands">
          {rows.map((c, i) => (
            <div
              key={c.id}
              id={`${id}-${i}`}
              className={`item${i === at ? ' hl' : ''}`}
              role="option"
              aria-selected={i === at}
              tabIndex={-1}
              // the field keeps the keyboard (and a phone its keyboard) when a row is pressed
              onPointerDown={(e) => e.preventDefault()}
              onPointerMove={() => i !== at && setActive(i)}
              onClick={() => run(c)}
            >
              <span className="title">{c.title}</span>
              {c.keys ? <span className="hint keys">{c.keys}</span> : c.note && <span className="hint">{c.note}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Bar() {
  const open = useApp((s) => s.bar);
  useSwipeDown();
  return open ? <BarPanel /> : null;
}
