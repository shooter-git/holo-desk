/**
 * What a reply shows under its sentence in the studio's bar (its "view"): blocks the agent composes
 * (text, rows, groups, lists, tables, buttons, switches, sliders, toggles, charts, a few bars of
 * notes, a waveform) whose controls act on the open song. They can play some bars (of a version of
 * the song), go somewhere in the studio, set a setting, keep a version, run one of the studio's own
 * commands, or send a next request. Nothing here is a use case: what the agent shows is its own
 * composition of these pieces.
 *
 * A closed format: plain text and these pieces only, no markup, links or script, every action one
 * the user could take with a click. The agent writes it in the song's own names (tools/present.ts
 * resolves them to ids); the server checks it again and keeps it with the turn; the studio checks it
 * once more and draws it (apps/web/src/ui/AgentView.tsx). It imports only @holo/session, so it runs
 * in a browser too.
 */
import { type Channel, formatParam, type Op, type ParamDef, type Plugin, type Project, pluginDef } from '@holo/session';

// ---- the format ----

/** The studio's views a go can bring in front. */
/**
 * `notes`: a recording's notes in the Audio Editor's Notes view (a MIDI track's in the Piano Roll).
 * `steps`: a kit's part in the Step Grid (a track that isn't a kit shows its Piano Roll).
 */
export const VIEW_NAMES = ['tracks', 'editor', 'notes', 'mixer', 'score', 'steps'] as const;
export type ViewName = (typeof VIEW_NAMES)[number];

/**
 * A place in the studio: a bar (the playhead goes there), a track (selected), a region (selected,
 * opened in the editor), some notes (selected in the editor), a view, a plugin's window.
 */
export interface Go {
  bar?: number;
  /** A track's id (resolved), or a bus's or "master" for a plugin or the mixer. */
  track?: string;
  region?: string;
  /**
   * Notes of `track` from one position to another ("12", "12.3"), of one pitch (MIDI) or all: a MIDI
   * track's selected in the Piano Roll, a recording's in the Audio Editor's Notes view.
   */
  notes?: { from: number | string; to: number | string; pitch?: number | string };
  view?: ViewName;
  /** A plugin of `track`'s (its id, resolved): its window opens. */
  plugin?: string;
}

/** Bars `from` to `to` (not played) of a version of the song, or of the song as it is; `solo`: only these tracks. */
export interface Play {
  from: number;
  to: number;
  version?: string;
  solo?: string[];
}

/**
 * A setting of a channel: `track` is a track's, a bus's id or "master" (resolved), and `param` one
 * of volume, pan, mute, solo, send:<bus id>, fx:<plugin id>:<param id>, on:<plugin id> (the plugin
 * on, 1, or bypassed, 0).
 */
export interface Binding {
  track: string;
  param: string;
}

export type Action =
  | { play: Play }
  | { go: Go }
  | { set: Binding; value: number }
  | { keep: string }
  | { command: string }
  | { ask: string };

export interface ListItem {
  text: string;
  detail?: string;
  do?: Action;
}

export interface Point {
  y: number;
  x?: number;
  label?: string;
  go?: Go;
}

/** Bars `from` to `to` (not included) of a track, as the song is or as a version had it. */
export interface Span {
  track: string;
  from: number;
  to: number;
  version?: string;
}

export const CHART_KINDS = ['line', 'bars', 'dots'] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export type Block =
  | { text: string; quiet?: boolean }
  | { row: Block[] }
  | { group: Block[]; title?: string }
  | { list: ListItem[] }
  | { table: { head?: string[]; rows: Cell[][] } }
  | { button: string; do: Action }
  | { choice: { label: string; do: Action }[] }
  | { slider: Binding; label?: string; min?: number; max?: number }
  | { toggle: Binding; label?: string }
  | { chart: Point[]; kind?: ChartKind; unit?: string; min?: number; max?: number; ref?: number }
  | { notes: Span }
  | { wave: Span };

/** A table's cell: words, a number, or a small block (text, a button, a slider or a toggle). */
export type Cell = string | number | Block;

/**
 * A turn's view as it's kept and drawn: its blocks, the revision of the song each version names, and
 * its dock: a few of its controls again, in one row a phone keeps at hand once the reply has been read
 * (apps/web/src/ui/Tray.tsx).
 */
export interface View {
  blocks: Block[];
  versions: Record<string, number>;
  dock?: Block[];
}

/**
 * The versions every turn has: the song before the request, and as the reply left it; and, after the
 * conversation's first request, the song before the previous request (to compare an earlier change).
 */
export const BEFORE = 'before';
export const AFTER = 'after';
export const PREVIOUS = 'previous';

export const KINDS = [
  'text',
  'row',
  'group',
  'list',
  'table',
  'button',
  'choice',
  'slider',
  'toggle',
  'chart',
  'notes',
  'wave',
] as const;
export type Kind = (typeof KINDS)[number];

export const blockKind = (b: Block): Kind => KINDS.find((k) => k in b) as Kind;

// ---- limits ----

export const LIMITS = {
  /** Blocks at the top. */
  top: 24,
  /** Blocks in all, list items and table rows included. */
  pieces: 80,
  /** Rows and groups inside each other (a table's cell counts as a level). */
  depth: 3,
  /** The view as JSON, in characters. */
  size: 10_000,
  listItems: 24,
  tableRows: 24,
  tableColumns: 6,
  choices: 6,
  points: 256,
  solo: 16,
  text: 400,
  label: 60,
  title: 80,
  detail: 160,
  ask: 300,
  cell: 80,
  unit: 12,
  ref: 120,
  versions: 8,
  /** A dock's controls: each button and toggle, and each option of a choice, is one. */
  dock: 5,
  /** A dock's labels, in characters. */
  dockLabel: 20,
} as const;

/** A version's name: a few words of the agent's (not "before" or "after", which every turn has). */
export const VERSION_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .,'’()+#&/–—-]{0,39}$/u;

/** The settings a resolved binding names. */
const RESOLVED_PARAM = /^(volume|pan|mute|solo|send:[^:\s]+|fx:[^:\s]+:[^:\s]+|on:[^:\s]+)$/;

// ---- checking it ----

export type ViewCheck = { ok: true; blocks: Block[] } | { ok: false; error: string };

class Bad extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A view's blocks checked: their kinds, fields, lengths and counts, and nothing but plain values.
 * `strict` (what the server and the studio check) also wants references resolved: settings as
 * volume, fx:ID:PARAM…, and pitches as numbers. Every problem is said with where it is
 * (`view[2].row[0]`), so the agent can fix it.
 */
export function checkView(input: unknown, strict = false): ViewCheck {
  let pieces = 0;

  const fail = (at: string, why: string): never => {
    throw new Bad(`${at}: ${why}`);
  };
  const fields = (at: string, o: Record<string, unknown>, allowed: readonly string[]) => {
    for (const k of Object.keys(o))
      if (!allowed.includes(k)) fail(at, `"${k}" isn't one of its fields (${allowed.join(', ')})`);
  };
  const text = (at: string, v: unknown, max: number, what = 'text'): string => {
    if (typeof v !== 'string') fail(at, `${what} must be words in quotes`);
    const s = v as string;
    if (!s.trim()) fail(at, `${what} is empty`);
    if (s.length > max) fail(at, `${what} is ${s.length} characters; at most ${max}`);
    return s;
  };
  const optText = (at: string, v: unknown, max: number, what: string) =>
    v === undefined ? undefined : text(at, v, max, what);
  const number = (at: string, v: unknown, what: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(at, `${what} must be a number`);
    return v as number;
  };
  const optNumber = (at: string, v: unknown, what: string) => (v === undefined ? undefined : number(at, v, what));
  const bar = (at: string, v: unknown, what: string): number => {
    const n = number(at, v, what);
    if (!Number.isInteger(n) || n < 0 || n > 100_000) fail(at, `${what} must be a bar number`);
    return n;
  };
  const ref = (at: string, v: unknown, what: string): string => text(at, v, LIMITS.ref, what);
  const position = (at: string, v: unknown, what: string): number | string => {
    if (typeof v === 'number') return bar(at, v, what);
    if (typeof v !== 'string' || !/^\d{1,5}(\.\d{1,2}){0,3}$/.test(v.trim()))
      fail(at, `${what} must be a bar or a position, e.g. 12 or "12.3"`);
    return (v as string).trim();
  };
  const pitch = (at: string, v: unknown): number | string => {
    if (typeof v === 'number') {
      if (!Number.isInteger(v) || v < 0 || v > 127) fail(at, 'pitch must be a MIDI note (0–127)');
      return v;
    }
    if (strict) fail(at, 'pitch must be a MIDI note number');
    return text(at, v, 8, 'pitch');
  };
  const version = (at: string, v: unknown): string => {
    const s = text(at, v, 40, 'version');
    if (s !== BEFORE && s !== AFTER && s !== PREVIOUS && !VERSION_NAME.test(s))
      fail(at, `"${s}" isn't a version's name`);
    return s;
  };

  const binding = (at: string, v: unknown): Binding => {
    if (!isObject(v)) fail(at, 'a setting is {"track": …, "param": …}');
    const o = v as Record<string, unknown>;
    fields(at, o, ['track', 'param']);
    const track = ref(at, o.track, 'track');
    const param = ref(at, o.param, 'param');
    if (strict && !RESOLVED_PARAM.test(param)) fail(at, `"${param}" isn't a resolved setting`);
    return { track, param };
  };

  const go = (at: string, v: unknown): Go => {
    if (!isObject(v)) fail(at, 'go is an object, e.g. {"bar": 12}');
    const o = v as Record<string, unknown>;
    fields(at, o, ['bar', 'track', 'region', 'notes', 'view', 'plugin']);
    const out: Go = {};
    if (o.bar !== undefined) out.bar = bar(at, o.bar, 'bar');
    if (o.track !== undefined) out.track = ref(at, o.track, 'track');
    if (o.region !== undefined) out.region = ref(at, o.region, 'region');
    if (o.plugin !== undefined) out.plugin = ref(at, o.plugin, 'plugin');
    if (o.view !== undefined) {
      if (!VIEW_NAMES.includes(o.view as ViewName)) fail(at, `view is one of ${VIEW_NAMES.join(', ')}`);
      out.view = o.view as ViewName;
    }
    if (o.notes !== undefined) {
      if (!isObject(o.notes)) fail(at, 'notes is {"from": …, "to": …, "pitch"?: …}');
      const n = o.notes as Record<string, unknown>;
      fields(`${at}.notes`, n, ['from', 'to', 'pitch']);
      out.notes = {
        from: position(`${at}.notes`, n.from, 'from'),
        to: position(`${at}.notes`, n.to, 'to'),
        ...(n.pitch !== undefined ? { pitch: pitch(`${at}.notes`, n.pitch) } : {}),
      };
    }
    if ((out.notes || out.plugin) && !out.track) fail(at, `say the "track" of the ${out.notes ? 'notes' : 'plugin'}`);
    if (!Object.keys(out).length) fail(at, 'go says where: a bar, a track, a region, notes, a view or a plugin');
    return out;
  };

  const action = (at: string, v: unknown): Action => {
    if (!isObject(v)) fail(at, 'do is an action, e.g. {"play": {"from": 9, "to": 17}}');
    const o = v as Record<string, unknown>;
    const kinds = ['play', 'go', 'set', 'keep', 'command', 'ask'].filter((k) => k in o);
    if (kinds.length !== 1) fail(at, 'do is one of play, go, set, keep, command or ask');
    const kind = kinds[0] as string;
    if (kind === 'set') {
      fields(at, o, ['set', 'value']);
      return { set: binding(`${at}.set`, o.set), value: number(at, o.value, 'value') };
    }
    fields(at, o, [kind]);
    switch (kind) {
      case 'play': {
        const p = o.play;
        if (!isObject(p)) fail(at, 'play is {"from": bar, "to": bar, "version"?, "solo"?}');
        const q = p as Record<string, unknown>;
        fields(`${at}.play`, q, ['from', 'to', 'version', 'solo']);
        const from = bar(`${at}.play`, q.from, 'from');
        const to = bar(`${at}.play`, q.to, 'to');
        if (to <= from) fail(`${at}.play`, '"to" comes after "from" (it is where playing stops)');
        const out: Play = { from, to };
        if (q.version !== undefined) out.version = version(`${at}.play`, q.version);
        if (q.solo !== undefined) {
          if (!Array.isArray(q.solo) || !q.solo.length) fail(`${at}.play`, 'solo is a list of tracks');
          const solo = q.solo as unknown[];
          if (solo.length > LIMITS.solo) fail(`${at}.play`, `solo has at most ${LIMITS.solo} tracks`);
          out.solo = solo.map((t, i) => ref(`${at}.play.solo[${i}]`, t, 'track'));
        }
        return { play: out };
      }
      case 'go':
        return { go: go(`${at}.go`, o.go) };
      case 'keep':
        return { keep: version(at, o.keep) };
      case 'command':
        return { command: text(at, o.command, 60, 'command') };
      default:
        return { ask: text(at, o.ask, LIMITS.ask, 'ask') };
    }
  };

  const span = (at: string, v: unknown): Span => {
    if (!isObject(v)) fail(at, 'it is {"track": …, "from": bar, "to": bar}');
    const o = v as Record<string, unknown>;
    fields(at, o, ['track', 'from', 'to', 'version']);
    const from = bar(at, o.from, 'from');
    const to = bar(at, o.to, 'to');
    if (to <= from) fail(at, '"to" comes after "from"');
    if (to - from > 64) fail(at, 'at most 64 bars');
    return {
      track: ref(at, o.track, 'track'),
      from,
      to,
      ...(o.version !== undefined ? { version: version(at, o.version) } : {}),
    };
  };

  const block = (at: string, v: unknown, depth: number, inCell = false): Block => {
    if (++pieces > LIMITS.pieces) fail(at, `a view has at most ${LIMITS.pieces} pieces in all`);
    if (depth > LIMITS.depth) fail(at, `rows, groups and tables' cells go at most ${LIMITS.depth} deep`);
    if (!isObject(v)) fail(at, `a block is an object, e.g. {"text": "…"}; the kinds: ${KINDS.join(', ')}`);
    const o = v as Record<string, unknown>;
    const kinds = KINDS.filter((k) => k in o);
    if (kinds.length > 1) fail(at, `one kind a block (${kinds.join(' and ')})`);
    if (!kinds.length) {
      // a kind written as "type" (as other formats do) is the likeliest slip: say so
      const typed = typeof o.type === 'string' ? o.type : null;
      fail(
        at,
        typed
          ? `a block's kind is its key, not "type": {"${typed}": …}, not {"type": "${typed}", …}; the kinds: ${KINDS.join(', ')}`
          : `a block's kind is its key, e.g. {"text": "…"}; the kinds: ${KINDS.join(', ')}`,
      );
    }
    const kind = kinds[0] as Kind;
    if (inCell && !['text', 'button', 'slider', 'toggle'].includes(kind))
      fail(at, 'a table cell holds words, a number, text, a button, a slider or a toggle');
    const children = (key: string): Block[] => {
      const list = o[key];
      if (!Array.isArray(list) || !list.length) fail(at, `${key} is a list of blocks`);
      return (list as unknown[]).map((c, i) => block(`${at}.${key}[${i}]`, c, depth + 1));
    };
    switch (kind) {
      case 'text':
        fields(at, o, ['text', 'quiet']);
        if (o.quiet !== undefined && typeof o.quiet !== 'boolean') fail(at, 'quiet is true or false');
        return { text: text(at, o.text, LIMITS.text), ...(o.quiet === true ? { quiet: true } : {}) };
      case 'row':
        fields(at, o, ['row']);
        return { row: children('row') };
      case 'group': {
        fields(at, o, ['group', 'title']);
        const title = optText(at, o.title, LIMITS.title, 'title');
        return { group: children('group'), ...(title ? { title } : {}) };
      }
      case 'list': {
        fields(at, o, ['list']);
        if (!Array.isArray(o.list) || !o.list.length) fail(at, 'list is a list of {"text", "detail"?, "do"?}');
        const items = o.list as unknown[];
        if (items.length > LIMITS.listItems) fail(at, `a list has at most ${LIMITS.listItems} items`);
        return {
          list: items.map((item, i) => {
            const where = `${at}.list[${i}]`;
            if (++pieces > LIMITS.pieces) fail(where, `a view has at most ${LIMITS.pieces} pieces in all`);
            if (!isObject(item)) fail(where, 'an item is {"text", "detail"?, "do"?}');
            const it = item as Record<string, unknown>;
            fields(where, it, ['text', 'detail', 'do']);
            const detail = optText(where, it.detail, LIMITS.detail, 'detail');
            return {
              text: text(where, it.text, LIMITS.title),
              ...(detail ? { detail } : {}),
              ...(it.do !== undefined ? { do: action(`${where}.do`, it.do) } : {}),
            };
          }),
        };
      }
      case 'table': {
        fields(at, o, ['table']);
        if (!isObject(o.table)) fail(at, 'table is {"head"?: [...], "rows": [[...], ...]}');
        const t = o.table as Record<string, unknown>;
        fields(`${at}.table`, t, ['head', 'rows']);
        let head: string[] | undefined;
        if (t.head !== undefined) {
          if (!Array.isArray(t.head) || !t.head.length) fail(`${at}.table`, 'head is a list of words');
          // (a column of buttons or sliders may have no heading)
          head = (t.head as unknown[]).map((h, i) =>
            h === '' ? '' : text(`${at}.table.head[${i}]`, h, 40, 'a heading'),
          );
        }
        if (!Array.isArray(t.rows) || !t.rows.length) fail(`${at}.table`, 'rows is a list of rows');
        const rows = t.rows as unknown[];
        if (rows.length > LIMITS.tableRows) fail(`${at}.table`, `at most ${LIMITS.tableRows} rows`);
        const width = head?.length;
        return {
          table: {
            ...(head ? { head } : {}),
            rows: rows.map((row, r) => {
              const where = `${at}.table.rows[${r}]`;
              if (++pieces > LIMITS.pieces) fail(where, `a view has at most ${LIMITS.pieces} pieces in all`);
              if (!Array.isArray(row) || !row.length) fail(where, 'a row is a list of cells');
              const cells = row as unknown[];
              if (cells.length > LIMITS.tableColumns) fail(where, `at most ${LIMITS.tableColumns} columns`);
              if (width !== undefined && cells.length > width)
                fail(where, `${cells.length} cells under ${width} headings`);
              return cells.map((c, i): Cell => {
                const cell = `${where}[${i}]`;
                if (typeof c === 'number') return number(cell, c, 'a cell');
                if (typeof c === 'string') {
                  if (c.length > LIMITS.cell) fail(cell, `a cell's words are at most ${LIMITS.cell} characters`);
                  return c;
                }
                return block(cell, c, depth + 1, true);
              });
            }),
          },
        };
      }
      case 'button':
        fields(at, o, ['button', 'do']);
        if (o.do === undefined) fail(at, 'a button needs "do"');
        return { button: text(at, o.button, LIMITS.label, 'its label'), do: action(`${at}.do`, o.do) };
      case 'choice': {
        fields(at, o, ['choice']);
        if (!Array.isArray(o.choice) || o.choice.length < 2)
          fail(at, 'choice is a list of at least two {"label", "do"}');
        const options = o.choice as unknown[];
        if (options.length > LIMITS.choices) fail(at, `a choice has at most ${LIMITS.choices} options`);
        return {
          choice: options.map((c, i) => {
            const where = `${at}.choice[${i}]`;
            if (!isObject(c)) fail(where, 'an option is {"label", "do"}');
            const opt = c as Record<string, unknown>;
            fields(where, opt, ['label', 'do']);
            if (opt.do === undefined) fail(where, 'an option needs "do"');
            return { label: text(where, opt.label, LIMITS.label, 'its label'), do: action(`${where}.do`, opt.do) };
          }),
        };
      }
      case 'slider': {
        fields(at, o, ['slider', 'label', 'min', 'max']);
        const label = optText(at, o.label, LIMITS.label, 'its label');
        const min = optNumber(at, o.min, 'min');
        const max = optNumber(at, o.max, 'max');
        if (min !== undefined && max !== undefined && max <= min) fail(at, 'max is above min');
        return {
          slider: binding(`${at}.slider`, o.slider),
          ...(label ? { label } : {}),
          ...(min !== undefined ? { min } : {}),
          ...(max !== undefined ? { max } : {}),
        };
      }
      case 'toggle': {
        fields(at, o, ['toggle', 'label']);
        const label = optText(at, o.label, LIMITS.label, 'its label');
        return { toggle: binding(`${at}.toggle`, o.toggle), ...(label ? { label } : {}) };
      }
      case 'chart': {
        fields(at, o, ['chart', 'kind', 'unit', 'min', 'max', 'ref']);
        if (!Array.isArray(o.chart) || !o.chart.length)
          fail(at, 'chart is a list of points {"y", "x"?, "label"?, "go"?}');
        const points = o.chart as unknown[];
        if (points.length > LIMITS.points) fail(at, `a chart has at most ${LIMITS.points} points`);
        if (o.kind !== undefined && !CHART_KINDS.includes(o.kind as ChartKind))
          fail(at, `kind is one of ${CHART_KINDS.join(', ')}`);
        const unit = optText(at, o.unit, LIMITS.unit, 'unit');
        const min = optNumber(at, o.min, 'min');
        const max = optNumber(at, o.max, 'max');
        const refLine = optNumber(at, o.ref, 'ref');
        if (min !== undefined && max !== undefined && max <= min) fail(at, 'max is above min');
        return {
          chart: points.map((p, i) => {
            const where = `${at}.chart[${i}]`;
            if (typeof p === 'number') return { y: number(where, p, 'y') };
            if (!isObject(p)) fail(where, 'a point is {"y", "x"?, "label"?, "go"?} or a number');
            const q = p as Record<string, unknown>;
            fields(where, q, ['y', 'x', 'label', 'go']);
            const label = optText(where, q.label, LIMITS.title, 'label');
            const x = optNumber(where, q.x, 'x');
            return {
              y: number(where, q.y, 'y'),
              ...(x !== undefined ? { x } : {}),
              ...(label ? { label } : {}),
              ...(q.go !== undefined ? { go: go(`${where}.go`, q.go) } : {}),
            };
          }),
          ...(o.kind !== undefined ? { kind: o.kind as ChartKind } : {}),
          ...(unit ? { unit } : {}),
          ...(min !== undefined ? { min } : {}),
          ...(max !== undefined ? { max } : {}),
          ...(refLine !== undefined ? { ref: refLine } : {}),
        };
      }
      case 'notes':
        fields(at, o, ['notes']);
        return { notes: span(`${at}.notes`, o.notes) };
      case 'wave':
        fields(at, o, ['wave']);
        return { wave: span(`${at}.wave`, o.wave) };
    }
  };

  try {
    if (!Array.isArray(input) || !input.length) throw new Bad('view: a list of blocks, e.g. [{"text": "…"}]');
    if (input.length > LIMITS.top) throw new Bad(`view: at most ${LIMITS.top} blocks at the top`);
    const blocks = input.map((b, i) => block(`view[${i}]`, b, 1));
    const size = JSON.stringify(blocks).length;
    if (size > LIMITS.size) throw new Bad(`view: ${size} characters as JSON; at most ${LIMITS.size}`);
    return { ok: true, blocks };
  } catch (err) {
    if (err instanceof Bad) return { ok: false, error: err.message };
    throw err;
  }
}

/** A go checked on its own (finish's `go`), the same way as one in a view. */
export function checkGo(input: unknown, strict = false): { ok: true; go: Go } | { ok: false; error: string } {
  const r = checkView([{ list: [{ text: 'go', do: { go: input } }] }], strict);
  if (!r.ok) return { ok: false, error: r.error.replace(/^view\[0\]\.list\[0\]\.do\.go/, 'go') };
  const item = (r.blocks[0] as { list: ListItem[] }).list[0] as ListItem;
  return { ok: true, go: (item.do as { go: Go }).go };
}

// ---- a dock ----

/** What a dock holds: controls only. */
export const DOCK_KINDS = ['button', 'choice', 'toggle'] as const;

/** Why a dock without a view is refused, said the same by the agent's tool and the server. */
export const DOCK_NEEDS_VIEW = "a dock repeats a few of the view's controls: give the view too";

/**
 * A dock checked: its blocks as a view's are (problems said at `dock[1]…`), then buttons, choices and
 * toggles only, at most LIMITS.dock controls (each button, toggle or option of a choice is one), each
 * label at most LIMITS.dockLabel characters. Their actions are any a view's can be.
 */
export function checkDock(input: unknown, strict = false): ViewCheck {
  const r = checkView(input, strict);
  if (!r.ok) return { ok: false, error: r.error.replace(/^view/, 'dock') };
  let controls = 0;
  for (const [i, b] of r.blocks.entries()) {
    const kind = blockKind(b);
    if (!(DOCK_KINDS as readonly string[]).includes(kind))
      return { ok: false, error: `dock[${i}]: a dock holds ${DOCK_KINDS.join(', ')} blocks only, not ${kind}` };
    const labels: [string, string | undefined][] =
      'button' in b
        ? [[`dock[${i}]`, b.button]]
        : 'choice' in b
          ? b.choice.map((c, j): [string, string] => [`dock[${i}].choice[${j}]`, c.label])
          : [[`dock[${i}]`, 'toggle' in b ? b.label : undefined]];
    controls += labels.length;
    for (const [at, label] of labels)
      if (label !== undefined && label.length > LIMITS.dockLabel)
        return {
          ok: false,
          error: `${at}: its label is ${label.length} characters; a dock's are at most ${LIMITS.dockLabel}`,
        };
  }
  if (controls > LIMITS.dock)
    return {
      ok: false,
      error: `dock: ${controls} controls; at most ${LIMITS.dock} (each button, toggle or option of a choice is one)`,
    };
  return r;
}

// ---- going through it ----

/** What a view refers to, each kind of reference mapped (the agent resolves names, the studio reads them). */
export interface RefMap {
  track?: (name: string, role: 'span' | 'go' | 'solo') => string;
  binding?: (b: Binding) => Binding;
  go?: (g: Go) => Go;
  version?: (name: string) => string;
  command?: (id: string) => string;
}

/** The blocks with every reference passed through `map` (the same shape otherwise). */
export function mapRefs(blocks: readonly Block[], map: RefMap): Block[] {
  const id = <T>(x: T) => x;
  const track = map.track ?? id;
  const version = map.version ?? id;
  const goOf = (g: Go): Go => (map.go ? map.go(g) : g);
  const bind = (b: Binding): Binding => (map.binding ? map.binding(b) : b);
  const act = (a: Action): Action => {
    if ('play' in a)
      return {
        play: {
          ...a.play,
          ...(a.play.version !== undefined ? { version: version(a.play.version) } : {}),
          ...(a.play.solo ? { solo: a.play.solo.map((t) => track(t, 'solo')) } : {}),
        },
      };
    if ('go' in a) return { go: goOf(a.go) };
    if ('set' in a) return { set: bind(a.set), value: a.value };
    if ('keep' in a) return { keep: version(a.keep) };
    if ('command' in a) return { command: map.command ? map.command(a.command) : a.command };
    return a;
  };
  const span = (s: Span): Span => ({
    ...s,
    track: track(s.track, 'span'),
    ...(s.version !== undefined ? { version: version(s.version) } : {}),
  });
  const block = (b: Block): Block => {
    if ('row' in b) return { row: b.row.map(block) };
    if ('group' in b) return { ...b, group: b.group.map(block) };
    if ('list' in b) return { list: b.list.map((it) => (it.do ? { ...it, do: act(it.do) } : it)) };
    if ('table' in b)
      return {
        table: {
          ...b.table,
          rows: b.table.rows.map((r) => r.map((c) => (typeof c === 'object' ? block(c) : c))),
        },
      };
    if ('button' in b) return { ...b, do: act(b.do) };
    if ('choice' in b) return { choice: b.choice.map((c) => ({ ...c, do: act(c.do) })) };
    if ('slider' in b) return { ...b, slider: bind(b.slider) };
    if ('toggle' in b) return { ...b, toggle: bind(b.toggle) };
    if ('chart' in b) return { ...b, chart: b.chart.map((p) => (p.go ? { ...p, go: goOf(p.go) } : p)) };
    if ('notes' in b) return { notes: span(b.notes) };
    if ('wave' in b) return { wave: span(b.wave) };
    return b;
  };
  return blocks.map(block);
}

/** Every version a view names, once each. */
export function viewVersions(blocks: readonly Block[]): string[] {
  const seen = new Set<string>();
  mapRefs(blocks, {
    version: (v) => {
      seen.add(v);
      return v;
    },
  });
  return [...seen];
}

/** Every command a view runs, once each. */
export function viewCommands(blocks: readonly Block[]): string[] {
  const seen = new Set<string>();
  mapRefs(blocks, {
    command: (c) => {
      seen.add(c);
      return c;
    },
  });
  return [...seen];
}

// ---- a binding: what it is, its value, and how it's set ----

/** What a resolved binding names, now: its words, range, kind and value. Null when it's gone from the song. */
export interface BindingInfo {
  /** The channel's name ("Vocal", "the master") and the setting's ("Volume", "Pitch Correction: Speed"). */
  channel: string;
  name: string;
  min: number;
  max: number;
  unit: string;
  /** A number to slide, an on/off, or one of some options. */
  kind: 'number' | 'switch' | 'options';
  /** How a slider travels: a fader's law (volume, sends), even in octaves (log), or straight. */
  scale: 'fader' | 'log' | 'lin';
  options?: string[];
  step?: number;
  value: number;
  /** The plugin parameter's own definition, when it's one. */
  def?: ParamDef;
}

/** A channel by its id: a track's, a bus's, or the master's. */
export function channelOf(project: Project, id: string): { channel: Channel; name: string; isTrack: boolean } | null {
  if (id === 'master') return { channel: project.master, name: 'the master', isTrack: false };
  const track = project.tracks.find((t) => t.id === id);
  if (track) return { channel: track.channel, name: track.name, isTrack: true };
  const bus = project.buses.find((b) => b.id === id);
  return bus ? { channel: bus.channel, name: bus.name, isTrack: false } : null;
}

/** A plugin of a channel's (its inserts, or a track's MIDI effects), by id. */
function pluginOf(project: Project, target: string, id: string): Plugin | undefined {
  const ch = channelOf(project, target);
  return (
    ch?.channel.inserts.find((p) => p.id === id) ??
    project.tracks.find((t) => t.id === target)?.midiFx.find((p) => p.id === id)
  );
}

export function bindingInfo(project: Project, b: Binding): BindingInfo | null {
  const ch = channelOf(project, b.track);
  if (!ch) return null;
  const c = ch.channel;
  const base = { channel: ch.name };
  if (b.param === 'volume')
    return { ...base, name: 'Volume', min: -144, max: 6, unit: 'dB', kind: 'number', scale: 'fader', value: c.volume };
  if (b.param === 'pan')
    return { ...base, name: 'Pan', min: -1, max: 1, unit: '', kind: 'number', scale: 'lin', value: c.pan };
  if (b.param === 'mute' || b.param === 'solo') {
    if (b.param === 'solo' && !ch.isTrack) return null;
    return {
      ...base,
      name: b.param === 'mute' ? 'Mute' : 'Solo',
      min: 0,
      max: 1,
      unit: '',
      kind: 'switch',
      scale: 'lin',
      value: c[b.param] ? 1 : 0,
    };
  }
  if (b.param.startsWith('send:')) {
    const bus = b.param.slice(5);
    const send = c.sends.find((s) => s.bus === bus);
    if (!send) return null;
    const name = project.buses.find((x) => x.id === bus)?.name ?? 'bus';
    return {
      ...base,
      name: `Send to ${name}`,
      min: -144,
      max: 6,
      unit: 'dB',
      kind: 'number',
      scale: 'fader',
      value: send.level,
    };
  }
  const on = /^on:([^:]+)$/.exec(b.param);
  if (on) {
    const plugin = pluginOf(project, b.track, on[1] as string);
    if (!plugin) return null;
    return {
      ...base,
      name: pluginDef(plugin.type)?.name ?? plugin.type,
      min: 0,
      max: 1,
      unit: '',
      kind: 'switch',
      scale: 'lin',
      value: plugin.bypass ? 0 : 1,
    };
  }
  const fx = /^fx:([^:]+):([^:]+)$/.exec(b.param);
  if (fx) {
    const plugin = pluginOf(project, b.track, fx[1] as string);
    const def = plugin && pluginDef(plugin.type);
    const p = def?.params.find((x) => x.id === fx[2]);
    if (!plugin || !def || !p) return null;
    const value = Math.min(p.max, Math.max(p.min, plugin.params[p.id] ?? p.default));
    return {
      ...base,
      name: `${def.name}: ${p.name}`,
      min: p.min,
      max: p.max,
      unit: p.unit ?? '',
      kind: p.options ? (p.options.length === 2 ? 'switch' : 'options') : 'number',
      scale: p.scale === 'log' && p.min > 0 ? 'log' : 'lin',
      ...(p.options ? { options: p.options } : {}),
      ...(p.step ? { step: p.step } : {}),
      value,
      def: p,
    };
  }
  return null;
}

/** A value of a binding's in words: "−6.0 dB", "L 20", "On", an option's name. */
export function bindingText(info: BindingInfo, value: number): string {
  if (info.def) return formatParam(info.def, value);
  if (info.kind === 'switch') return value >= 0.5 ? 'On' : 'Off';
  if (info.unit === 'dB') return value <= -144 ? '−∞ dB' : `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
  if (info.name === 'Pan') {
    const lr = Math.round(value * 64);
    return lr === 0 ? 'Center' : `${lr < 0 ? 'L' : 'R'} ${Math.abs(lr)}`;
  }
  return String(Math.round(value * 100) / 100);
}

/** The ops that set a binding to a value (clamped to its range). Empty when it's gone from the song. */
export function bindingOps(project: Project, b: Binding, value: number): Op[] {
  const info = bindingInfo(project, b);
  if (!info || !Number.isFinite(value)) return [];
  const v = Math.min(info.max, Math.max(info.min, info.step ? Math.round(value / info.step) * info.step : value));
  const target = b.track;
  if (b.param === 'volume' || b.param === 'pan') return [{ op: 'updateChannel', target, patch: { [b.param]: v } }];
  if (b.param === 'mute' || b.param === 'solo')
    return [{ op: 'updateChannel', target, patch: { [b.param]: v >= 0.5 } }];
  if (b.param.startsWith('send:')) {
    const bus = b.param.slice(5);
    const ch = channelOf(project, target);
    if (!ch) return [];
    return [
      {
        op: 'updateChannel',
        target,
        patch: { sends: ch.channel.sends.map((s) => (s.bus === bus ? { ...s, level: v } : s)) },
      },
    ];
  }
  const on = /^on:([^:]+)$/.exec(b.param);
  if (on) return [{ op: 'updatePlugin', target, plugin: on[1] as string, patch: { bypass: v < 0.5 } }];
  const fx = /^fx:([^:]+):([^:]+)$/.exec(b.param);
  if (fx)
    return [
      {
        op: 'updatePlugin',
        target,
        plugin: fx[1] as string,
        patch: { params: { [fx[2] as string]: info.kind === 'number' ? v : Math.round(v) } },
      },
    ];
  return [];
}
