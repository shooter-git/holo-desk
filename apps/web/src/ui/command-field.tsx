/**
 * The field the bar and the page share: what's typed finds the studio's commands, tracks and markers
 * (the list under it in the bar, over it in the page), and with the agent on it takes requests too
 * ("Ask the agent"), with files dropped or pasted on it (each a small chip). Up and Down choose a row,
 * Enter runs it, Escape closes; Backspace in an empty field takes the last file off.
 *
 * In the bar it's one line; in the page it grows with what's typed, to six lines, and Shift Enter
 * starts a new one.
 */
import { AudioLines, FileMusic, FileText, Image as ImageIcon, Music, X } from 'lucide-react';
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { openTurn, playheadTick } from '../app/actions.ts';
import {
  agent,
  agentCommands,
  ask,
  askScan,
  conversation,
  type Exchange,
  exchange,
  isLive,
  isOn,
  loadThread,
  newConversation,
  requestContext,
  songRequests,
  useAgent,
} from '../app/agent.ts';
import { type AttachmentKind, classify, MAX_FILES, type Ready, ready } from '../app/attach.ts';
import { ACTIONS, barStateOf } from '../app/bar-actions.ts';
import { barRows, type Command, type Extra } from '../app/commands.ts';
import { arrowsChooseRows, shownLines } from '../app/fields.ts';
import { isPhone, isTouch, useLayout } from '../app/layout.ts';
import { closeBar, store, useApp } from '../app/store.ts';
import { closeMenu } from './menu.tsx';
import { Slash } from './slash.tsx';

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

/**
 * What's typed and the files going with it, while the bar is open: kept as it changes form (the window
 * crossing between a desktop's layout and a tablet's swaps the bar for the page), let go as it closes.
 */
let draft: { query: string; chips: Chip[] } = { query: '', chips: [] };

/** How many lines a field's words take as it shows them (a one-line input, one). */
function linesOf(el: HTMLInputElement | HTMLTextAreaElement): number {
  if (!(el instanceof HTMLTextAreaElement)) return 1;
  const s = getComputedStyle(el);
  const padding = Number.parseFloat(s.paddingTop) + Number.parseFloat(s.paddingBottom);
  return shownLines(el.scrollHeight, padding || 0, Number.parseFloat(s.lineHeight));
}

/** Where the field is: the bar's one line, or the page's field that grows. */
export type FieldMode = 'bar' | 'page';

/** The field's state and what it does, for the field, the list and what holds them. */
export interface CommandFieldState {
  mode: FieldMode;
  /** The agent is on for this device. */
  on: boolean;
  project: string | null;
  /** The song's last exchange (the bar shows it under the field). */
  ex: Exchange | null;
  /** Something is typed. */
  typed: boolean;
  /** The exchange stands in for the list (nothing typed). */
  talking: boolean;
  /** A request runs on the song. */
  busy: boolean;
  query: string;
  setQuery: (q: string) => void;
  chips: Chip[];
  takeOff: (key: number) => void;
  /** A file turned away, said under the field (no toast). */
  note: string;
  dropping: boolean;
  rows: Command[];
  /** The chosen row. */
  at: number;
  setActive: (i: number) => void;
  run: (c: Command) => void;
  onKey: (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onPaste: (e: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onDrop: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  placeholder: string;
  field: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  list: RefObject<HTMLDivElement | null>;
  id: string;
}

/**
 * What the bar held: what's typed and the row chosen, the files going with the next request, the rows
 * found, and the keys. As it opens, a menu left open closes, the field takes the keys (on a touch
 * screen the page leaves them when there's a conversation to read, so no keyboard comes up over it),
 * a reply that came while it was closed has been seen, and the song's conversation is read afresh; as
 * it closes, the keyboard goes back to where it was.
 */
export function useCommandField({ mode }: { mode: FieldMode }): CommandFieldState {
  const app = useApp((s) => s);
  const a = useAgent((x) => x);
  const layout = useLayout();
  const phone = isPhone(layout);
  const [query, setQueryState] = useState(() => (store.get().bar ? draft.query : ''));
  const [active, setActive] = useState(0);
  const [chips, setChips] = useState<Chip[]>(() => (store.get().bar ? draft.chips : []));
  const [note, setNote] = useState('');
  const [dropping, setDropping] = useState(false);
  const field = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const playhead = playheadTick();
  const state = barStateOf(app, playhead, phone);
  const project = app.project?.id ?? null;
  const on = isOn(a);
  const ex = exchange(a, project);
  const typed = query.trim() !== '';
  // with nothing typed, the song's last exchange stands in for the list
  const talking = on && ex !== null && !typed;
  const context = () => requestContext(app, playhead, phone);
  const busy = Object.values(a.jobs).some((j) => j.project === project && isLive(j.state));
  const agentRows = agentCommands(
    {
      on,
      project,
      scan: app.scanView?.id ?? null,
      busy,
      // this device's requests on other songs: each a row that opens its song at it
      elsewhere: songRequests(a, project),
    },
    {
      scan: (task, scan) => project && void askScan(task, scan, project, context()),
      reset: () => project && void newConversation(project).catch(() => undefined),
      open: (r) => openTurn(r.project, r.job),
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
  const onDragLeave = (e: DragEvent) => {
    if (e.currentTarget === e.target) setDropping(false);
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
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
      setQueryState('');
      setActive(0);
    }
  };

  useEffect(() => {
    // a menu left open would keep the arrow keys; the keyboard comes back to where it was when the bar closes
    closeMenu();
    const was = document.activeElement;
    const song = store.get().project?.id ?? null;
    // (on a touch screen the page has a conversation to read first: no keyboard comes up over it. One
    // not read yet counts as one, unless the agent is off and there's only the search)
    const now = agent.get();
    const read = now.thread?.project === song;
    const toRead = isOn(now) && (!read || conversation(now, song).length > 0);
    if (mode === 'bar' || !isTouch() || !toRead) field.current?.focus({ preventScroll: true });
    // the song's reply that came while it was closed has been seen; its conversation is read afresh
    agent.dispatch({ type: 'seen', project: song });
    if (song) void loadThread(song);
    return () => {
      if (was instanceof HTMLElement && was.isConnected) was.focus({ preventScroll: true });
      // closed: what was typed goes with it (still open, the bar is changing form, and it's kept)
      if (!store.get().bar) draft = { query: '', chips: [] };
    };
  }, [mode]);

  // another song opened under it (from the Songs dialog, or a row of the bar's): that song's reply is
  // seen now, and its conversation read
  const shown = useRef(project);
  useEffect(() => {
    if (project === shown.current) return;
    shown.current = project;
    agent.dispatch({ type: 'seen', project });
    if (project) void loadThread(project);
  }, [project]);

  useEffect(() => {
    draft = { query, chips };
  }, [query, chips]);

  // the chosen row stays in sight where the list scrolls (a phone on its side, with its keyboard up)
  // biome-ignore lint/correctness/useExhaustiveDependencies: run when the chosen row or the rows change, read from the page
  useEffect(() => {
    list.current?.querySelector('.hl')?.scrollIntoView({ block: 'nearest' });
  }, [at, query]);

  const onKey = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    // the page's list is over the field, its first row nearest: Up goes on to the next. Its field grows:
    // there the arrows choose rows only while the list shows and the words are on one line, and move the
    // caret otherwise
    const caret = mode === 'page' && !arrowsChooseRows(rows.length, linesOf(e.currentTarget));
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !caret) {
      const next = (e.key === 'ArrowDown') === (mode === 'bar');
      if (rows.length) setActive((at + (next ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === 'Enter' && !(mode === 'page' && e.shiftKey)) {
      const row = rows[at];
      if (row) run(row);
    } else if (e.key === 'Escape') closeBar();
    // Backspace in an empty field takes the last file off
    else if (e.key === 'Backspace' && !query && chips.length) setChips((all) => all.slice(0, -1));
    // the keyboard stays in the bar's field, unless the exchange under it has a button to reach (the
    // page's conversation, over it, always may have)
    else if (e.key !== 'Tab' || talking || mode === 'page') return;
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

  return {
    mode,
    on,
    project,
    ex,
    typed,
    talking,
    busy,
    query,
    setQuery: (q) => {
      setQueryState(q);
      setActive(0);
    },
    chips,
    takeOff: (key) => setChips((all) => all.filter((x) => x.key !== key)),
    note,
    dropping,
    rows,
    at,
    setActive,
    run,
    onKey,
    onPaste,
    onDrop,
    onDragOver,
    onDragLeave,
    placeholder,
    field,
    list,
    id,
  };
}

/**
 * The field: the slash, the files going with the request, then what's typed. In the bar one line; in
 * the page (`multiline`), it grows with the words to six lines and then scrolls.
 */
export function CommandField({
  f,
  multiline = false,
  onFocus,
  onBlur,
}: {
  f: CommandFieldState;
  multiline?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const box = f.field as RefObject<HTMLTextAreaElement | null>;
  // the page's field is as tall as its words, to its most (six lines, or three on a phone on its side
  // with its keyboard up: the style's max-height)
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again as the words change
  useLayoutEffect(() => {
    const el = box.current;
    if (!multiline || !el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [multiline, f.query]);
  const common = {
    role: 'combobox',
    'aria-label': f.on ? 'Ask, or search commands' : 'Search commands',
    'aria-expanded': f.rows.length > 0,
    'aria-controls': `${f.id}-list`,
    'aria-activedescendant': f.rows.length ? `${f.id}-${f.at}` : undefined,
    'aria-autocomplete': 'list',
    // a phone held upright has room for the start of it beside the selection's words
    placeholder: f.placeholder,
    autoComplete: 'off',
    // with the agent on, what's typed is mostly a request: the keyboard corrects and capitalises
    // it as it does a message, and its key says Send. A command is still found by its first
    // letters (a correction only comes at a word's end, and case doesn't count)
    autoCorrect: f.on ? 'on' : 'off',
    autoCapitalize: f.on ? 'sentences' : 'off',
    spellCheck: f.on,
    enterKeyHint: f.on ? 'send' : undefined,
    value: f.query,
    onKeyDown: f.onKey,
    onPaste: f.onPaste,
    onFocus,
    onBlur,
  } as const;
  return (
    <div className={`field${f.chips.length ? ' has-chips' : ''}`}>
      <Slash />
      {f.chips.map((c) => {
        const Icon = CHIP_ICON[c.kind];
        return (
          <span key={c.key} className="att" title={c.name}>
            <Icon aria-hidden="true" />
            <span className="att-name">{c.name}</span>
            <button type="button" className="att-x" aria-label={`Take ${c.name} off`} onClick={() => f.takeOff(c.key)}>
              <X aria-hidden="true" />
            </button>
          </span>
        );
      })}
      {multiline ? (
        <textarea ref={box} rows={1} {...common} onChange={(e) => f.setQuery(e.target.value)} />
      ) : (
        <input
          ref={f.field as RefObject<HTMLInputElement | null>}
          type="text"
          {...common}
          onChange={(e) => f.setQuery(e.target.value)}
        />
      )}
    </div>
  );
}

/** The rows found: under the bar's field; over the page's (`upward`), the first nearest it. */
export function CommandList({ f, upward = false }: { f: CommandFieldState; upward?: boolean }) {
  return (
    <div
      ref={f.list}
      className={`list${upward ? ' upward' : ''}`}
      role="listbox"
      id={`${f.id}-list`}
      aria-label="Commands"
    >
      {f.rows.map((c, i) => (
        <div
          key={c.id}
          id={`${f.id}-${i}`}
          className={`item${i === f.at ? ' hl' : ''}`}
          role="option"
          aria-selected={i === f.at}
          tabIndex={-1}
          // the field keeps the keyboard (and a phone its keyboard) when a row is pressed
          onPointerDown={(e) => e.preventDefault()}
          onPointerMove={() => i !== f.at && f.setActive(i)}
          onClick={() => f.run(c)}
        >
          <span className="title">{c.title}</span>
          {c.keys ? <span className="hint keys">{c.keys}</span> : c.note && <span className="hint">{c.note}</span>}
        </div>
      ))}
    </div>
  );
}
