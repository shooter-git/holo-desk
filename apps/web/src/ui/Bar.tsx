/**
 * The bar (Ctrl /, the search button in the control bar, or a swipe down on a phone's top bar): the
 * studio's commands, tracks and markers, found by name. It's one of the studio's menus with a field on
 * top (the same glass, rows, blue highlight and key hints), so nothing looks bolted on. While it's open
 * the field has the keys: Up and Down choose, Enter runs, Escape closes, and the studio's shortcuts
 * wait. The song plays on.
 *
 * With the agent on for this device, the field takes requests too: what's typed can be sent ("Ask the
 * agent"), with files dropped or pasted on it (each a small chip), and under the field is the song's
 * last exchange, the request then the reply, with at most the button it needs (Stop, Done while it
 * listens, a permission, Copy brief). A screenshot or a photo it asks for is shown here before it
 * leaves. Nothing else in the studio shows the agent.
 */
import { AudioLines, FileMusic, FileText, Image as ImageIcon, Music, Search, X } from 'lucide-react';
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import {
  addTrack,
  bounceSong,
  deleteSelection,
  locate,
  moveBars,
  playheadTick,
  quantizeSelection,
  redo,
  renderForAgent,
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
  agentCommands,
  allowLabel,
  ask,
  askScan,
  type BriefWarning,
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
  upload,
  useAgent,
} from '../app/agent.ts';
import {
  type AttachmentKind,
  canCaptureScreen,
  classify,
  grabScreen,
  MAX_FILES,
  type Ready,
  ready,
  record,
  redraw,
} from '../app/attach.ts';
import { type Actions, barRows, type Command, type Extra } from '../app/commands.ts';
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

/** "0:07": how long a recording has run. */
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/**
 * The one button a job's permission needs, beside the agent's reason for it (a pack's says what it
 * downloads): a click runs the studio's own code (the Library's install queue, sending the song to its
 * creation, a bounce, the creation's own render, capturing the screen, a photo, the microphone), then
 * the host hears what happened and the agent carries on. A screenshot or a photo is shown first, small,
 * with Send and Cancel: nothing leaves the device until Send.
 */
function PermissionButton({ job, permission, project }: { job: string; permission: Permission; project: string }) {
  const [busy, setBusy] = useState('');
  const [failed, setFailed] = useState('');
  const [preview, setPreview] = useState<{ file: Ready; url: string; result: string } | null>(null);
  const [recording, setRecording] = useState<{ stop: () => void; since: number } | null>(null);
  const [now, setNow] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  const install = useInstalls();
  // a phone can't capture its screen: a photo of it stands in
  const kind = permission.kind === 'screen' && !canCaptureScreen() ? 'photo' : permission.kind;
  // a pack's size, from the catalog the Library reads
  const packId = permission.kind === 'install-pack' ? (permission.pack ?? null) : null;
  useEffect(() => {
    if (packId && !installs.state.packs) void installs.load();
  }, [packId]);
  const pack = packId ? install.packs?.find((p) => p.id === packId) : undefined;
  // the creation that renders the song ("Hear it as my-game")
  const creation = useApp((s) => s.project?.origin?.creation);

  useEffect(() => {
    if (!recording) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [recording]);
  useEffect(() => () => (preview ? URL.revokeObjectURL(preview.url) : undefined), [preview]);

  const attempt = async (what: string, work: () => Promise<void>) => {
    setBusy(what);
    setFailed('');
    try {
      await work();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };
  // what was captured goes up as an attachment of the song's, and the answer carries it
  const send = (file: Ready, result: string) =>
    attempt('Sending…', async () => {
      const id = await upload(file, project);
      await permit(job, true, result, [id]);
      setPreview(null);
    });
  const shown = (file: Ready, result: string) => setPreview({ file, url: URL.createObjectURL(file.blob), result });

  const run = () => {
    if (kind === 'install-pack' && permission.pack) {
      const pack = permission.pack;
      return attempt('Installing…', async () => {
        if (!install.packs) await installs.load();
        const name = installs.pack(pack)?.name ?? pack;
        // (named, so the Library shows it in its queue, and no toast says it's in: the reply will)
        const ok = await installs.install([pack], name);
        await permit(job, true, ok ? `Installed ${name}` : `${name} couldn’t be installed`);
      });
    }
    if (kind === 'send-creation')
      return attempt('Sending…', async () => {
        const sent = await sendToCreation(true);
        await permit(
          job,
          true,
          sent ? sent.text : 'This song didn’t come from a creation, so there’s none to send it to',
        );
      });
    if (kind === 'bounce')
      return attempt('Bouncing…', async () => {
        // the song (or the cycle, when it's on), kept with it on the host, where the agent measures it
        const r = await bounceSong(false);
        if (!r) throw new Error('The bounce didn’t finish: try again');
        await permit(job, true, `Bounced ${clock(r.seconds * 1000)} of the song, kept with it as ${r.path}`);
      });
    if (kind === 'render')
      return attempt('Rendering…', async () => {
        await permit(job, true, await renderForAgent());
      });
    if (kind === 'screen')
      return attempt('Choose what to share…', async () => shown(await grabScreen(), 'Shared a screenshot'));
    if (kind === 'photo') {
      picker.current?.click();
      return;
    }
    if (kind === 'microphone')
      return attempt('Asking for the microphone…', async () => {
        const r = await record((made) => {
          setRecording(null);
          void attempt('Measuring…', async () => {
            const file = await made;
            const seconds = Math.round(Number(file.meta?.seconds ?? 0));
            await send(file, `Recorded ${seconds} s from the microphone`);
          });
        });
        setNow(Date.now());
        setRecording({ ...r, since: Date.now() });
      });
  };

  return (
    <>
      {preview && (
        <div className="shot">
          <img src={preview.url} alt="What will be sent" />
        </div>
      )}
      {busy && kind === 'install-pack' && install.job?.line ? (
        <span className="muted grow bar-line">{install.job.line}</span>
      ) : busy ? (
        <span className="muted grow bar-line">{busy}</span>
      ) : null}
      {recording && <span className="muted grow bar-line">Recording {clock(now - recording.since)}</span>}
      {failed && <span className="agent-error grow bar-line">{failed}</span>}
      {!busy && !recording && !failed && !preview && permission.detail && (
        <span className="muted grow bar-line" title={permission.detail}>
          {permission.detail}
        </span>
      )}
      {kind === 'photo' && (
        <input
          ref={picker}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f)
              void attempt('Reading the photo…', async () =>
                shown(await redraw(f, 'photo.jpg', 'image/jpeg'), 'Took a photo'),
              );
          }}
        />
      )}
      {preview ? (
        <>
          <button type="button" className="btn ghost" disabled={!!busy} onClick={() => setPreview(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!!busy}
            onClick={() => void send(preview.file, preview.result)}
          >
            Send
          </button>
        </>
      ) : recording ? (
        <button type="button" className="btn primary" onClick={() => recording.stop()}>
          Done
        </button>
      ) : (
        <button type="button" className="btn" disabled={!!busy} onClick={() => void run()}>
          {permission.kind === 'screen' && kind === 'photo'
            ? 'Take a photo instead'
            : allowLabel(permission, pack, creation)}
        </button>
      )}
    </>
  );
}

/** Why a flagged line of a brief is to be read twice. */
const WHY: Record<BriefWarning, string> = {
  command: 'runs a command',
  url: 'a link: check where it goes',
  secret: 'asks for something secret: don’t pass it on',
};

/**
 * A brief for the user's own harness, in full: the lines that run something, link somewhere or ask for
 * something secret are marked.
 */
function Brief({ text, flagged }: { text: string; flagged: Exchange['flagged'] }) {
  return (
    <div className="brief" role="document" aria-label="Brief">
      {text.split('\n').map((line, i) => {
        const flag = flagged.get(i);
        return (
          <div key={i} className={flag ? 'flag' : undefined}>
            {line || '\u00a0'}
            {flag && <span className="why">{WHY[flag] ?? WHY.command}</span>}
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
function Talk({ ex, project }: { ex: Exchange; project: string }) {
  const job = ex.job;
  const buttons = [
    ex.permission && job && ex.mine && (
      <PermissionButton key="allow" job={job} permission={ex.permission} project={project} />
    ),
    ex.brief && <CopyBrief key="brief" text={ex.brief} />,
  ].filter(Boolean);
  return (
    <div className="talk" aria-live="polite">
      <div className="you">{ex.request}</div>
      {ex.working ? (
        <div className="status">
          <span className="ring" aria-hidden="true" />
          <span className="grow bar-line">
            {ex.listening ? 'Listening: play it, then press Done' : (ex.line ?? 'Working on it')}
          </span>
          {ex.listening && job && ex.mine && (
            <button type="button" className="btn primary small" onClick={() => void doneListening(job)}>
              Done
            </button>
          )}
          {job && (
            <button type="button" className="btn ghost small" onClick={() => void stopJob(job).catch(() => undefined)}>
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

/** A file waiting to go with the next request: being made ready (a picture drawn again, a recording measured). */
interface Chip {
  key: number;
  name: string;
  kind: AttachmentKind;
  ready: Promise<Ready>;
}

const CHIP_ICON: Record<AttachmentKind, typeof ImageIcon> = {
  image: ImageIcon,
  audio: AudioLines,
  midi: Music,
  score: FileMusic,
  text: FileText,
};

let chipKey = 0;

function BarPanel() {
  const app = useApp((s) => s);
  const a = useAgent((x) => x);
  const layout = useLayout();
  const phone = isPhone(layout);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [chips, setChips] = useState<Chip[]>([]);
  // a file turned away, said under the field (no toast)
  const [note, setNote] = useState('');
  const [dropping, setDropping] = useState(false);
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
  const context = () => requestContext(app, playhead, phone);
  const agentRows = agentCommands(
    {
      on,
      project,
      scan: app.scanView?.id ?? null,
      busy: Object.values(a.jobs).some((j) => j.project === project && isLive(j.state)),
    },
    {
      scan: (task, scan) => project && void askScan(task, scan, project, context()),
      reset: () => project && void newConversation(project).catch(() => undefined),
    },
  );
  const extra: Extra =
    on && project
      ? {
          suggest: agentRows.suggest,
          commands: agentRows.commands,
          ask: (text) => ({
            id: 'ask',
            title: chips.length
              ? `Ask the agent, with ${chips.length === 1 ? 'the file' : `${chips.length} files`}`
              : 'Ask the agent',
            group: 'Agent',
            keys: '↵',
            keepOpen: true,
            run: () => {
              void ask(
                text,
                project,
                context(),
                chips.map((c) => c.ready),
              );
              setChips([]);
              setNote('');
            },
          }),
        }
      : {};
  // with the exchange showing, only what fits the window open (a scan's tasks) is offered under it
  const rows = talking ? agentRows.suggest : barRows(query, state, ACTIONS, extra);

  /** Files dropped or pasted: each a chip, made ready at once; one HO[LO] doesn't take is said why. */
  const take = (files: File[]) => {
    const room = MAX_FILES - chips.length;
    const added: Chip[] = [];
    let why = files.length > room ? `At most ${MAX_FILES} files go with one request` : '';
    for (const file of files.slice(0, Math.max(0, room))) {
      const c = classify(file);
      if ('error' in c) {
        why = c.error;
        continue;
      }
      const chip: Chip = { key: ++chipKey, name: file.name || 'pasted picture', kind: c.kind, ready: ready(file) };
      // (one that can't be read after all leaves, and says so)
      chip.ready.catch((err: Error) => {
        setChips((all) => all.filter((x) => x.key !== chip.key));
        setNote(err.message);
      });
      added.push(chip);
    }
    if (added.length) setChips((all) => [...all, ...added]);
    setNote(why);
    field.current?.focus({ preventScroll: true });
  };
  const onDrop = (e: DragEvent) => {
    setDropping(false);
    if (!on || !e.dataTransfer.files.length) return;
    e.preventDefault();
    take([...e.dataTransfer.files]);
  };
  const onDragOver = (e: DragEvent) => {
    if (!on || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dropping) setDropping(true);
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const files = [...e.clipboardData.files];
    if (!on || !files.length) return;
    e.preventDefault();
    take(files);
  };
  const at = Math.max(0, Math.min(active, rows.length - 1));

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
    // Backspace in an empty field takes the last file off
    else if (e.key === 'Backspace' && !query && chips.length) setChips((all) => all.slice(0, -1));
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
      <div
        className={`bar${dropping ? ' dropping' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Commands"
        onDragOver={onDragOver}
        onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
        onDrop={onDrop}
      >
        <div className={`field${chips.length ? ' has-chips' : ''}`}>
          <Search aria-hidden="true" />
          {chips.map((c) => {
            const Icon = CHIP_ICON[c.kind];
            return (
              <span key={c.key} className="att" title={c.name}>
                <Icon aria-hidden="true" />
                <span className="att-name">{c.name}</span>
                <button
                  type="button"
                  className="att-x"
                  aria-label={`Take ${c.name} off`}
                  onClick={() => setChips((all) => all.filter((x) => x.key !== c.key))}
                >
                  <X aria-hidden="true" />
                </button>
              </span>
            );
          })}
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
            onPaste={onPaste}
          />
        </div>
        {note && (
          <div className="bar-note" role="status">
            {note}
          </div>
        )}
        {talking && ex && project && <Talk ex={ex} project={project} />}
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
