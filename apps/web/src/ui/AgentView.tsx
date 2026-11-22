/**
 * What a reply shows under its sentence in the bar or the page: the blocks the agent composed (the format is
 * @holo/agent/view), drawn with the studio's own pieces (its buttons, switches, rows, sliders and
 * canvases, in its own colours) and nothing of a colour of its own. Words are shown as words, never
 * as markup. What a click does is app/agent-view.ts's: each is something the user could do themselves.
 *
 * The view is checked again here before it's drawn; one that doesn't pass shows nothing. Its dock (a
 * few of its controls again) is drawn compact, in one row, for a phone's tray: DockView.
 */
import {
  type Action,
  type Binding,
  type Block,
  bindingInfo,
  bindingText,
  type Cell,
  checkDock,
  checkView,
  type ListItem,
  type Point,
  type Span,
  type View,
} from '@holo/agent/view';
import { barToTick, firstBar, type Project } from '@holo/session';
import { ChevronRight, Play, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  askNext,
  commandInfo,
  goTo,
  keepVersion,
  notesIn,
  placedNotes,
  playBars,
  runCommand,
  setBinding,
  setRecordingNoteLister,
  slide,
  slideEnd,
  slideStart,
  spanGo,
  usePlaying,
  versionSong,
  versionWords,
} from '../app/agent-view.ts';
import { closeForStudio } from '../app/page-layout.ts';
import { useApp } from '../app/store.ts';
import { recordingNotes } from '../audio/notes.ts';
import { editableNotes } from './AudioNotes.tsx';
import { dbToFader, faderToDb } from './controls.tsx';
import { prepare, useFrame, useSize } from './frame.ts';
import { centredRange, drawMiniNotes, type MiniNote, rangeOf } from './mini-notes.ts';
import { drawClipWave } from './wave.ts';

// a go to a recording's notes, and its notes drawn small, number them as the Notes view does
setRecordingNoteLister((song, region) =>
  region.audio
    ? (editableNotes(song, region, region.audio, recordingNotes.of(song.id, region.audio.file))?.n ?? null)
    : null,
);

/** What a block's controls share: the view (its versions), the job it came with, and whether a request is running. */
interface Ctx {
  view: View;
  job: string;
  busy: boolean;
  /** A line under the view saying why a click did nothing (a version no longer kept, a track gone). */
  say: (why: string) => void;
}

/**
 * What a click does, run, and what the bar does after: it closes for a go or a command, so the studio
 * shows (the page too where it covers the studio; a sheet stays beside it).
 */
async function run(ctx: Ctx, action: Action, key: string): Promise<void> {
  let why: string | null = null;
  if ('play' in action) why = await playBars(ctx.view, action.play, key);
  else if ('go' in action) {
    why = goTo(action.go);
    if (!why) closeForStudio();
  } else if ('set' in action) {
    if (!setBinding(action.set, action.value)) why = 'That setting is gone from the song';
  } else if ('keep' in action) {
    if (!(await keepVersion(ctx.view, action.keep))) why = 'That version isn’t kept any more';
  } else if ('command' in action) {
    if (!runCommand(action.command)) why = 'The studio can’t do that just now';
  } else if (!ctx.busy) askNext(action.ask);
  ctx.say(why ?? '');
}

/** What a click will do, in the studio's own words, for a button's title (and its words, for a command or a request). */
function actionWords(action: Action, song: Project | null): { title?: string; label?: string } {
  if ('set' in action && song) {
    const info = bindingInfo(song, action.set);
    return info ? { title: `${info.channel}: ${info.name} → ${bindingText(info, action.value)}` } : {};
  }
  if ('keep' in action) return { title: `Makes ${versionWords(action.keep)} the song again (one step to undo)` };
  if ('command' in action) {
    const c = commandInfo(action.command);
    return c ? { label: c.title } : {};
  }
  if ('ask' in action) return { label: action.ask, title: 'Asks the agent this' };
  return {};
}

/** Whether an action can be clicked now. */
function actionReady(ctx: Ctx, action: Action): boolean {
  if ('ask' in action) return !ctx.busy;
  if ('command' in action) return commandInfo(action.command)?.available ?? false;
  return true;
}

/**
 * A control's words: what its action says (a command's title, a request's words), or its own label; in
 * a dock (`compact`) always its own short label, the action's words going in its title.
 */
function controlWords(
  words: { title?: string; label?: string },
  label: string,
  compact: boolean,
): { title?: string; shown: string } {
  if (!compact) return { title: words.title, shown: words.label ?? label };
  return { title: words.title ?? (words.label !== label ? words.label : undefined), shown: label };
}

function ActionButton({
  ctx,
  label,
  action,
  at,
  on,
  compact = false,
}: {
  ctx: Ctx;
  label: string;
  action: Action;
  at: string;
  on?: boolean;
  compact?: boolean;
}) {
  const song = useApp((s) => s.project);
  const playing = usePlaying();
  const key = `${ctx.job}:${at}`;
  const words = controlWords(actionWords(action, song), label, compact);
  const isPlay = 'play' in action;
  const live = isPlay && playing === key;
  return (
    <button
      type="button"
      className={`btn small${on || live ? ' on' : ''}`}
      title={words.title}
      disabled={!actionReady(ctx, action)}
      aria-pressed={isPlay ? live : on}
      onClick={() => void run(ctx, action, key)}
    >
      {isPlay && (live ? <Square size={11} aria-hidden="true" /> : <Play size={11} aria-hidden="true" />)}
      <span>{words.shown}</span>
    </button>
  );
}

/** A two-or-more-way switch: the option last clicked stays lit (an A/B, the original against the new). */
function Choice({
  ctx,
  options,
  at,
  compact = false,
}: {
  ctx: Ctx;
  options: { label: string; do: Action }[];
  at: string;
  compact?: boolean;
}) {
  const [lit, setLit] = useState<number | null>(null);
  const playing = usePlaying();
  const song = useApp((s) => s.project);
  return (
    <div className="seg">
      {options.map((o, i) => {
        const key = `${ctx.job}:${at}.${i}`;
        const words = controlWords(actionWords(o.do, song), o.label, compact);
        const on = 'play' in o.do ? playing === key : lit === i;
        return (
          <button
            key={i}
            type="button"
            className={`btn small${on ? ' on' : ''}`}
            aria-pressed={on}
            title={words.title}
            disabled={!actionReady(ctx, o.do)}
            onClick={() => {
              setLit(i);
              void run(ctx, o.do, key);
            }}
          >
            {'play' in o.do &&
              (playing === key ? <Square size={11} aria-hidden="true" /> : <Play size={11} aria-hidden="true" />)}
            <span>{words.shown}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---- settings ----

/** A binding's slider travel (0–1) for a value, and back, as its kind of setting travels. */
function travel(
  info: NonNullable<ReturnType<typeof bindingInfo>>,
  min: number,
  max: number,
): { to: (v: number) => number; from: (u: number) => number } {
  if (info.scale === 'fader') {
    const a = dbToFader(min);
    const b = dbToFader(max);
    return {
      to: (v) => (dbToFader(v) - a) / (b - a),
      from: (u) => faderToDb(a + u * (b - a)),
    };
  }
  if (info.scale === 'log' && min > 0)
    return { to: (v) => Math.log(v / min) / Math.log(max / min), from: (u) => min * (max / min) ** u };
  return { to: (v) => (v - min) / (max - min), from: (u) => min + u * (max - min) };
}

const STEPS = 1000;

/** A setting on a slider: heard at once while it moves, one undo step a drag (or a burst of keys). */
function Slider({ b, label, min, max }: { b: Binding; label?: string; min?: number; max?: number }) {
  const song = useApp((s) => s.project);
  const info = song ? bindingInfo(song, b) : null;
  // a gesture under way (one undo step), and whether a pointer holds the slider
  const held = useRef(false);
  const pressed = useRef(false);
  const idle = useRef(0);
  // (the bar closing mid-burst still ends its step, so the gesture never holds the agent's changes back)
  useEffect(
    () => () => {
      window.clearTimeout(idle.current);
      if (held.current) {
        held.current = false;
        slideEnd();
      }
    },
    [],
  );
  if (info?.kind !== 'number') return null;
  // a fader's own range runs down to silence: a slider's starts at -60 dB unless the agent said
  const lo = min ?? (info.scale === 'fader' ? -60 : info.min);
  const hi = max ?? info.max;
  const t = travel(info, lo, hi);
  const pos = Math.round(Math.min(1, Math.max(0, t.to(info.value))) * STEPS);
  const begin = () => {
    window.clearTimeout(idle.current);
    if (!held.current) {
      held.current = true;
      slideStart(b);
    }
  };
  const end = () => {
    window.clearTimeout(idle.current);
    pressed.current = false;
    if (held.current) {
      held.current = false;
      slideEnd();
    }
  };
  /** The slider moved to a position (of STEPS): heard at once; keys and the wheel make one step a burst. */
  const moveTo = (at: number) => {
    begin();
    let v = t.from(at / STEPS);
    if (info.step) v = Math.round(v / info.step) * info.step;
    slide(b, v);
    if (!pressed.current) idle.current = window.setTimeout(end, 400);
  };
  return (
    <label className="v-slider">
      <span className="v-label">{label ?? info.name}</span>
      <input
        type="range"
        min={0}
        max={STEPS}
        value={pos}
        aria-valuetext={bindingText(info, info.value)}
        onPointerDown={() => {
          pressed.current = true;
          begin();
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onBlur={end}
        onChange={(e) => moveTo(Number(e.currentTarget.value))}
        onKeyDown={(e) => {
          // a key moves it a hundredth of its travel (a page key, a tenth), not a thousandth
          const by = { ArrowRight: 10, ArrowUp: 10, ArrowLeft: -10, ArrowDown: -10, PageUp: 100, PageDown: -100 }[
            e.key
          ];
          if (by === undefined) return;
          e.preventDefault();
          moveTo(Math.min(STEPS, Math.max(0, pos + by)));
        }}
      />
      <span className="v-value">{bindingText(info, info.value)}</span>
    </label>
  );
}

function Toggle({ ctx, b, label }: { ctx: Ctx; b: Binding; label?: string }) {
  const song = useApp((s) => s.project);
  const info = song ? bindingInfo(song, b) : null;
  if (info?.kind !== 'switch') return null;
  const on = info.value >= 0.5;
  return (
    <button
      type="button"
      className={`btn small${on ? ' on' : ''}`}
      aria-pressed={on}
      title={`${info.channel}: ${info.name}`}
      onClick={() => {
        if (!setBinding(b, on ? 0 : 1)) ctx.say('That setting is gone from the song');
      }}
    >
      {label ?? info.name}
    </button>
  );
}

// ---- pictures ----

/** A colour of the studio's theme, read from the page. */
const token = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

const CHART_H = 96;

function Chart({
  ctx,
  points,
  kind = 'line',
  unit,
  min,
  max,
  ref: refLine,
}: {
  ctx: Ctx;
  points: Point[];
  kind?: 'line' | 'bars' | 'dots';
  unit?: string;
  min?: number;
  max?: number;
  ref?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const { w } = useSize(box);
  const [hover, setHover] = useState<number | null>(null);
  const xs = points.map((p, i) => p.x ?? i);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const lo = min ?? Math.min(...ys, ...(refLine !== undefined ? [refLine] : []));
  const hi = max ?? Math.max(...ys, ...(refLine !== undefined ? [refLine] : []));
  const span = hi - lo || 1;
  const pad = 6;
  const px = (x: number) => pad + (x1 === x0 ? (w - 2 * pad) / 2 : ((x - x0) / (x1 - x0)) * (w - 2 * pad));
  const py = (y: number) => pad + (1 - (Math.min(hi, Math.max(lo, y)) - lo) / span) * (CHART_H - 2 * pad);
  useEffect(() => {
    const c = prepare(canvas.current, w, CHART_H);
    if (!c) return;
    c.clearRect(0, 0, w, CHART_H);
    const accent = token('--accent', '#4c8dff');
    const line = token('--line-2', 'rgba(255,255,255,0.14)');
    if (refLine !== undefined) {
      c.strokeStyle = line;
      c.lineWidth = 1;
      c.setLineDash([3, 3]);
      c.beginPath();
      c.moveTo(pad, py(refLine) + 0.5);
      c.lineTo(w - pad, py(refLine) + 0.5);
      c.stroke();
      c.setLineDash([]);
    }
    c.fillStyle = accent;
    c.strokeStyle = accent;
    if (kind === 'bars') {
      const base = py(refLine ?? Math.max(lo, Math.min(hi, 0)));
      const bw = Math.max(2, Math.min(18, (w - 2 * pad) / points.length - 2));
      points.forEach((p, i) => {
        const x = px(xs[i] as number) - bw / 2;
        const y = py(p.y);
        c.globalAlpha = hover === i ? 1 : 0.75;
        c.fillRect(x, Math.min(y, base), bw, Math.max(1, Math.abs(base - y)));
      });
      c.globalAlpha = 1;
    } else {
      if (kind === 'line' && points.length > 1) {
        c.lineWidth = 1.5;
        c.beginPath();
        points.forEach((p, i) => {
          const x = px(xs[i] as number);
          if (i === 0) c.moveTo(x, py(p.y));
          else c.lineTo(x, py(p.y));
        });
        c.stroke();
      }
      points.forEach((p, i) => {
        c.beginPath();
        c.arc(px(xs[i] as number), py(p.y), hover === i ? 4 : kind === 'dots' ? 3 : 2, 0, Math.PI * 2);
        c.fill();
      });
    }
  });
  const nearest = (clientX: number): number | null => {
    const r = canvas.current?.getBoundingClientRect();
    if (!r || !points.length) return null;
    const x = clientX - r.left;
    let best = 0;
    for (let i = 1; i < points.length; i++)
      if (Math.abs(px(xs[i] as number) - x) < Math.abs(px(xs[best] as number) - x)) best = i;
    return best;
  };
  const shown = hover !== null ? points[hover] : undefined;
  return (
    <div className="v-chart" ref={box}>
      <canvas
        ref={canvas}
        onPointerMove={(e) => setHover(nearest(e.clientX))}
        onPointerLeave={() => setHover(null)}
        onClick={(e) => {
          const i = nearest(e.clientX);
          const go = i !== null ? points[i]?.go : undefined;
          if (go) void run(ctx, { go }, `chart:${i}`);
        }}
        style={{ cursor: shown?.go ? 'pointer' : 'default' }}
        aria-label={`A chart of ${points.length} values${unit ? ` in ${unit}` : ''}`}
      />
      <div className="v-chart-note">
        {shown
          ? `${shown.label ? `${shown.label}: ` : ''}${Math.round(shown.y * 100) / 100}${unit ? ` ${unit}` : ''}`
          : ' '}
      </div>
    </div>
  );
}

const SPAN_H = 44;

/** A few bars of a track drawn small, as the song is or as a version had it: notes, or a recording's waveform. */
function SpanView({ ctx, span, wave }: { ctx: Ctx; span: Span; wave: boolean }) {
  const now = useApp((s) => s.project);
  const [version, setVersion] = useState<Project | null | undefined>(span.version ? undefined : null);
  useEffect(() => {
    if (span.version) void versionSong(ctx.view, span.version).then(setVersion);
  }, [ctx.view, span.version]);
  const song = version ?? (span.version ? null : now);
  const box = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const { w } = useSize(box);
  const drawn = useRef<{ key: string; song: Project | null }>({ key: '', song: null });
  const track = song?.tracks.find((t) => t.id === span.track);
  const from = song ? barToTick(song.meter, Math.max(span.from, firstBar(song.meter))) : 0;
  const to = song ? barToTick(song.meter, span.to) : 0;
  const notes = useMemo(() => {
    if (!song || !track || wave) return [];
    return notesIn(song, track.id, from, to).notes.map((n) => {
      const r = track.regions.find((x) => x.notes.includes(n));
      return { t: (r?.start ?? 0) + n.t - from, d: n.d, p: n.p };
    });
  }, [song, track, from, to, wave]);
  // drawn again until a recording's peaks have come (and whenever what it shows changes)
  useFrame(() => {
    if (!song || !track || w <= 0) return;
    const key = `${w}:${track.id}:${from}:${to}`;
    if (drawn.current.key === key && drawn.current.song === song) return;
    const c = prepare(canvas.current, w, SPAN_H);
    if (!c) return;
    c.clearRect(0, 0, w, SPAN_H);
    c.fillStyle = token('--bg-2', 'rgba(255,255,255,0.04)');
    c.fillRect(0, 0, w, SPAN_H);
    const color = token('--text', '#e8ebef');
    let done = true;
    if (wave) {
      const view = {
        tickToX: (t: number) => ((t - from) / (to - from)) * w,
        xToTick: (x: number) => from + (x / w) * (to - from),
      };
      for (const r of track.regions) {
        if (!r.audio || r.start >= to || r.start + r.length <= from) continue;
        const style = {
          from: Math.max(from, r.start),
          to: Math.min(to, r.start + r.length),
          y: 2,
          h: SPAN_H - 4,
          color,
          shaped: true,
          canvasWidth: w,
        };
        if (!drawClipWave(c, song, r, r.audio, view, style)) done = false;
      }
    } else if (track.kind === 'audio') {
      // a recording's notes: where each plays now, and (faint) where it was sung when an edit moved it
      const sung: MiniNote[] = [];
      const played: MiniNote[] = [];
      for (const r of track.regions) {
        if (!r.audio || r.start >= to || r.start + r.length <= from) continue;
        const placed = placedNotes(song, r);
        if (!placed) {
          done = false;
          continue;
        }
        for (const n of placed) {
          if (n.end <= from || n.start >= to) continue;
          const at = { t: n.start - from, d: n.end - n.start };
          played.push({ ...at, p: n.pitch });
          if (Math.abs(n.pitch - n.sung) >= 0.05) sung.push({ ...at, p: n.sung });
        }
      }
      const range = centredRange(rangeOf([...played, ...sung]));
      const area = { x: 0, y: 4, w, h: SPAN_H - 8 };
      c.fillStyle = color;
      c.globalAlpha = 0.3;
      drawMiniNotes(c, sung, to - from, area, range);
      c.globalAlpha = 1;
      drawMiniNotes(c, played, to - from, area, range);
    } else {
      c.fillStyle = color;
      drawMiniNotes(c, notes, to - from, { x: 0, y: 4, w, h: SPAN_H - 8 }, centredRange(rangeOf(notes)));
    }
    if (done) drawn.current = { key, song };
  });
  if (version === undefined) return <div className="v-span muted">…</div>;
  if (!song || !track)
    return (
      <div className="v-span muted">
        {span.version ? 'That version isn’t kept any more' : 'That track is gone from the song'}
      </div>
    );
  return (
    <button
      type="button"
      className="v-span"
      ref={box}
      title={`${track.name}, bars ${span.from}–${span.to - 1}${span.version ? `, as ${versionWords(span.version)} has it` : ''}${track.kind === 'audio' && !wave ? ': its notes, faint where they were sung before an edit moved them' : ''}`}
      onClick={() => now && void run(ctx, { go: spanGo(now, track.id, span.from, !wave) }, 'span')}
    >
      <canvas ref={canvas} />
    </button>
  );
}

// ---- blocks ----

function CellView({ ctx, cell, at }: { ctx: Ctx; cell: Cell; at: string }) {
  if (typeof cell === 'string' || typeof cell === 'number') return <>{cell}</>;
  return <BlockView ctx={ctx} block={cell} at={at} />;
}

/** Rows, as a menu's: one with "do" is pressed. */
function ListView({ ctx, items, at }: { ctx: Ctx; items: ListItem[]; at: string }) {
  const song = useApp((s) => s.project);
  const playing = usePlaying();
  return (
    <div className="v-list">
      {items.map((it, i) => {
        const words = it.do ? actionWords(it.do, song) : {};
        const detail = it.detail ?? (it.do && 'ask' in it.do ? it.do.ask : undefined);
        const key = `${ctx.job}:${at}.${i}`;
        const plays = !!it.do && 'play' in it.do;
        const live = plays && playing === key;
        const body = (
          <>
            {/* a row that plays shows it as a button does; one that does something else, a chevron:
                without a pointer to hover with, nothing else says a row can be pressed */}
            {plays && (live ? <Square size={11} aria-hidden="true" /> : <Play size={11} aria-hidden="true" />)}
            <span className="title">{it.text}</span>
            {detail && <span className="hint">{detail}</span>}
            {it.do && !plays && <ChevronRight size={13} className="go" aria-hidden="true" />}
          </>
        );
        return it.do ? (
          <button
            key={i}
            type="button"
            className={`item${live ? ' on' : ''}`}
            title={words.title}
            aria-pressed={plays ? live : undefined}
            disabled={!actionReady(ctx, it.do)}
            onClick={() => it.do && void run(ctx, it.do, key)}
          >
            {body}
          </button>
        ) : (
          <div key={i} className="item static">
            {body}
          </div>
        );
      })}
    </div>
  );
}

function BlockView({ ctx, block: b, at }: { ctx: Ctx; block: Block; at: string }) {
  if ('text' in b) return <div className={`v-text${b.quiet ? ' quiet' : ''}`}>{b.text}</div>;
  if ('row' in b)
    return (
      <div className="v-row">
        {b.row.map((c, i) => (
          <BlockView key={i} ctx={ctx} block={c} at={`${at}.${i}`} />
        ))}
      </div>
    );
  if ('group' in b)
    return (
      <div className="v-group">
        {b.title && <div className="v-title">{b.title}</div>}
        {b.group.map((c, i) => (
          <BlockView key={i} ctx={ctx} block={c} at={`${at}.${i}`} />
        ))}
      </div>
    );
  if ('list' in b) return <ListView ctx={ctx} items={b.list} at={at} />;
  if ('table' in b)
    return (
      <div className="v-table">
        <table>
          {b.table.head && (
            <thead>
              <tr>
                {b.table.head.map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {b.table.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} className={typeof cell === 'number' ? 'num' : undefined}>
                    <CellView ctx={ctx} cell={cell} at={`${at}.${r}.${c}`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  if ('button' in b) return <ActionButton ctx={ctx} label={b.button} action={b.do} at={at} />;
  if ('choice' in b) return <Choice ctx={ctx} options={b.choice} at={at} />;
  if ('slider' in b) return <Slider b={b.slider} label={b.label} min={b.min} max={b.max} />;
  if ('toggle' in b) return <Toggle ctx={ctx} b={b.toggle} label={b.label} />;
  if ('chart' in b)
    return <Chart ctx={ctx} points={b.chart} kind={b.kind} unit={b.unit} min={b.min} max={b.max} ref={b.ref} />;
  if ('notes' in b) return <SpanView ctx={ctx} span={b.notes} wave={false} />;
  if ('wave' in b) return <SpanView ctx={ctx} span={b.wave} wave />;
  return null;
}

/** A reply's view, under its sentence. Nothing when it doesn't pass the check. */
export function AgentView({ view, job, busy }: { view: View; job: string; busy: boolean }) {
  const [why, setWhy] = useState('');
  const checked = useMemo(() => checkView(view.blocks, true), [view]);
  if (!checked.ok) return null;
  const ctx: Ctx = { view, job, busy, say: setWhy };
  return (
    <div className="agent-view">
      {checked.blocks.map((b, i) => (
        <BlockView key={i} ctx={ctx} block={b} at={String(i)} />
      ))}
      {why && (
        <div className="v-why" role="status">
          {why}
        </div>
      )}
    </div>
  );
}

/**
 * A reply's dock, compact, for the tray: its buttons, choices and toggles in one row, each with its own
 * short label, run as the view's are (a version plays, one is kept, a setting set, a command run, a go
 * taken, as the page's rules have it). Nothing when there's none, or it doesn't pass the check.
 */
export function DockView({ view, job, busy }: { view: View; job: string; busy: boolean }) {
  const [why, setWhy] = useState('');
  const checked = useMemo(() => (view.dock ? checkDock(view.dock, true) : null), [view]);
  if (!checked?.ok) return null;
  const ctx: Ctx = { view, job, busy, say: setWhy };
  return (
    <div className="dock-view">
      {checked.blocks.map((b, i) => {
        // (its own keys: a take playing from the tray isn't the page's button playing)
        const at = `dock.${i}`;
        if ('button' in b) return <ActionButton key={i} ctx={ctx} label={b.button} action={b.do} at={at} compact />;
        if ('choice' in b) return <Choice key={i} ctx={ctx} options={b.choice} at={at} compact />;
        if ('toggle' in b) return <Toggle key={i} ctx={ctx} b={b.toggle} label={b.label} />;
        return null;
      })}
      {why && (
        <span className="v-why" role="status">
          {why}
        </span>
      )}
    </div>
  );
}
