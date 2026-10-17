/** The tracks area: track headers, the ruler with the cycle range, and the regions on a timeline. */
import {
  type AudioClip,
  automationTargets,
  barToTick,
  DIVISIONS,
  findLane,
  type Instrument,
  meterAt,
  type Op,
  type Project,
  quantize,
  type Region,
  SYNTH_PRESETS,
  type Track,
  ticksPerBar,
  ticksPerBeat,
  tickToBarBeat,
} from '@holo/session';
import {
  Activity,
  AudioLines,
  Drum,
  Eraser,
  Headphones,
  Mic,
  MousePointer2,
  Music,
  Pencil,
  Piano,
  Plus,
  Waves,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  addAudioTrack,
  addTrack,
  apply,
  createRegionAt,
  deleteSelection,
  deleteTrack,
  findRegion,
  importAudio,
  liveTakes,
  locate,
  normalizeRegion,
  quantizeSelection,
  repeatRegions,
  selectTrack,
  setCycle,
  songLength,
  splitAtPlayhead,
  takeLinkedTick,
  updateChannel,
  updateTrack,
} from '../app/actions.ts';
import { isPhone, isTouch, useLayout } from '../app/layout.ts';
import { store, useApp } from '../app/store.ts';
import { engine } from '../audio/engine.ts';
import { audioFiles } from '../audio/files.ts';
import { library } from '../audio/samples.ts';
import {
  denorm,
  drawLanes,
  formatValue,
  type LanePreview,
  laneGeometry,
  norm,
  pointAt,
  targetOf,
} from './automation.ts';
import { alpha, prepare, roundRect, useFrame, useSize } from './frame.ts';
import { type MenuEntry, openMenu, openMenuAt } from './menu.tsx';
import { gridStep, Viewport } from './view.ts';
import { drawClipWave, drawFades, fadeTo, trimEnd, trimStart } from './wave.ts';

export const tracksView = new Viewport(store.get().zoom);

function instrumentIcon(i: Instrument) {
  if (i.type === 'synth' && i.preset === 'Drum Synth') return <Drum />;
  if (i.type === 'synth' && /Bass|Lead|Pluck|Pad/.test(i.preset)) return <Waves />;
  if (i.type === 'synth') return <Piano />;
  if (i.type === 'sampler' || i.type === 'performance') return <Music />;
  if (i.type === 'glass') return <Waves />;
  return <AudioLines />;
}

export function instrumentLabel(i: Instrument): string {
  if (i.type === 'sampler' || i.type === 'performance') {
    const pack = library.packs.find((p) => p.id === i.pack);
    const title = pack?.instruments.find((x) => x.name === i.name)?.title ?? i.name;
    // played as its creation plays it: a whole part, planned
    return i.type === 'performance' ? `${title} (Performance)` : title;
  }
  if (i.type === 'synth') return i.preset;
  if (i.type === 'glass') return i.line ? 'Glass Line' : 'Glass';
  return 'No instrument';
}

/** The menu of instruments to put on a track (or a new one). */
export function instrumentMenu(onPick: (i: Instrument) => void): MenuEntry[] {
  const entries: MenuEntry[] = [{ heading: 'Built-in' }];
  for (const preset of SYNTH_PRESETS)
    entries.push({ label: preset, onSelect: () => onPick({ type: 'synth', preset }) });
  for (const pack of library.packs) {
    entries.push({ heading: pack.name });
    for (const inst of pack.instruments) {
      entries.push({
        label: inst.title,
        hint: inst.category,
        onSelect: () => onPick({ type: 'sampler', pack: pack.id, name: inst.name }),
      });
    }
  }
  return entries;
}

export function newTrackMenu(): MenuEntry[] {
  return [
    { heading: 'New track' },
    { label: 'Keys', hint: 'Soft Keys', onSelect: () => addTrack({ type: 'synth', preset: 'Soft Keys' }) },
    {
      label: 'Drums',
      hint: 'Drum Synth (GM pads)',
      onSelect: () => addTrack({ type: 'synth', preset: 'Drum Synth' }, 'Drums'),
    },
    { label: 'Bass', hint: 'Analog Bass', onSelect: () => addTrack({ type: 'synth', preset: 'Analog Bass' }) },
    { label: 'Pad', hint: 'Warm Pad', onSelect: () => addTrack({ type: 'synth', preset: 'Warm Pad' }) },
    'sep',
    { label: 'Choose an instrument…', onSelect: () => store.set({ library: true, mobileTab: 'library' }) },
    'sep',
    { label: 'Audio', hint: 'record a voice or an instrument', onSelect: () => addAudioTrack() },
    { label: 'Import audio file…', hint: 'or drop files on the tracks', onSelect: () => chooseAudioFiles() },
  ];
}

/** Pick audio files from this device, into the song at the playhead. */
export function chooseAudioFiles(): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'audio/*,.wav,.flac,.mp3,.ogg,.aif,.aiff,.m4a';
  input.multiple = true;
  input.onchange = () => {
    const files = [...(input.files ?? [])];
    const s = store.get();
    const target = s.project?.tracks.find((t) => t.id === s.selectedTrack && t.kind === 'audio');
    if (files.length) void importAudio(files, target?.id);
  };
  input.click();
}

/** "Input 1", "Input 1-2". */
export function inputLabel(track: Track): string {
  const i = track.audioInput ?? { input: 0, channels: 1 };
  return i.channels === 2 ? `Input ${i.input + 1}-${i.input + 2}` : `Input ${i.input + 1}`;
}

// ---- track headers ----

/** Which setting a track's automation lane shows (● marks the ones that have automation). */
function LaneSelect({ track }: { track: Track }) {
  const project = useApp((s) => s.project);
  const param = useApp((s) => s.autoParam[track.id] ?? 'volume');
  if (!project) return null;
  const targets = automationTargets(project, track.channel);
  const lane = findLane(track.channel, param);
  return (
    <div className="hstack" style={{ gap: 4 }} onPointerDown={(e) => e.stopPropagation()}>
      <select
        className="select"
        value={param}
        aria-label={`Automation shown for ${track.name}`}
        style={{ height: 22, fontSize: 10.5, padding: '0 18px 0 4px', minWidth: 0, flex: 1 }}
        onChange={(e) => store.set((s) => ({ autoParam: { ...s.autoParam, [track.id]: e.target.value } }))}
      >
        {targets.map((t) => (
          <option key={t.param} value={t.param}>
            {findLane(track.channel, t.param)?.points.length ? '● ' : ''}
            {t.name}
          </option>
        ))}
      </select>
      {lane && (
        <button
          type="button"
          className={`chip${lane.mode === 'read' ? ' on' : ''}`}
          style={lane.mode === 'read' ? { background: '#ffd166', color: '#1c1505' } : undefined}
          title={
            lane.mode === 'read'
              ? 'Read: the automation plays (click to turn it off)'
              : 'Off: the automation is kept but not played'
          }
          onClick={() =>
            apply(
              [
                {
                  op: 'setAutomation',
                  target: track.id,
                  param,
                  points: lane.points,
                  mode: lane.mode === 'read' ? 'off' : 'read',
                },
              ],
              'Automation Mode',
            )
          }
        >
          {lane.mode === 'read' ? 'R' : 'off'}
        </button>
      )}
    </div>
  );
}

function TrackRow({ track, top, height, selected }: { track: Track; top: number; height: number; selected: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const automationView = useApp((s) => s.automationView);
  const show = useApp((s) => s.show);
  const touch = isTouch();
  const compact = height < 44;
  const menu = (x: number, y: number) =>
    openMenu(x, y, [
      { label: 'Rename', onSelect: () => setRenaming(true) },
      track.kind === 'audio'
        ? { label: 'Import audio file…', onSelect: () => chooseAudioFiles() }
        : {
            label: 'Instrument…',
            onSelect: () =>
              openMenu(
                x,
                y,
                instrumentMenu((i) =>
                  apply([{ op: 'updateTrack', track: track.id, patch: { instrument: i } }], 'Instrument'),
                ),
              ),
          },
      {
        label: track.armed ? 'Disarm' : 'Arm for recording',
        onSelect: () => updateTrack(track.id, { armed: !track.armed }, 'Arm'),
      },
      'sep',
      { label: 'Delete track', onSelect: () => deleteTrack(track.id) },
    ]);
  return (
    <div
      className={`track-row${selected ? ' selected' : ''}${show.trackIcons ? '' : ' no-icon'}`}
      style={{ top, height }}
      onPointerDown={() => selectTrack(track.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        menu(e.clientX, e.clientY);
      }}
    >
      <div
        className="swatch"
        style={{ background: track.color, boxShadow: selected ? `0 0 10px ${track.color}` : undefined }}
      />
      {show.trackIcons && (
        <div className="ico" style={{ color: track.color }}>
          {track.kind === 'audio' ? <Mic /> : instrumentIcon(track.instrument)}
        </div>
      )}
      <div style={{ minWidth: 0 }} onDoubleClick={() => setRenaming(true)}>
        {renaming ? (
          <input
            className="input"
            // biome-ignore lint/a11y/noAutofocus: shown because the name was double-clicked
            autoFocus
            defaultValue={track.name}
            style={{ height: 22, width: '100%' }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setRenaming(false);
              e.stopPropagation();
            }}
            onBlur={(e) => {
              const name = e.currentTarget.value.trim();
              if (name && name !== track.name) updateTrack(track.id, { name }, 'Rename');
              setRenaming(false);
            }}
          />
        ) : (
          <>
            <div className="name">{track.name}</div>
            {!compact && !automationView && show.trackSub && (
              <div className="sub">
                {track.kind === 'audio' ? inputLabel(track) : instrumentLabel(track.instrument)}
                {track.origin?.edited ? ' · edited' : ''}
              </div>
            )}
            {automationView && !touch && <LaneSelect track={track} />}
          </>
        )}
      </div>
      {automationView && touch ? (
        // on touch screens the lane's picker takes the buttons' row while automation shows
        <div className="chips" style={{ minWidth: 0 }}>
          <LaneSelect track={track} />
        </div>
      ) : !show.trackButtons ? (
        <span />
      ) : (
        <div className="chips" onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            className={`chip mute${track.channel.mute ? ' on' : ''}`}
            title="Mute (M)"
            onClick={() => updateChannel(track.id, { mute: !track.channel.mute }, 'Mute')}
          >
            M
          </button>
          <button
            type="button"
            className={`chip solo${track.channel.solo ? ' on' : ''}`}
            title="Solo (S)"
            onClick={() => updateChannel(track.id, { solo: !track.channel.solo }, 'Solo')}
          >
            S
          </button>
          <button
            type="button"
            className={`chip rec${track.armed ? ' on' : ''}`}
            title={
              track.kind === 'audio'
                ? 'Record-arm: the input is recorded here'
                : 'Record-arm: live MIDI is recorded here'
            }
            onClick={() => updateTrack(track.id, { armed: !track.armed }, 'Arm')}
          >
            R
          </button>
          {track.kind === 'audio' && (
            <button
              type="button"
              className={`chip mon${track.audioInput?.monitor ? ' on' : ''}`}
              title="Input monitoring: hear the input through the track (wear headphones)"
              onClick={() =>
                updateTrack(
                  track.id,
                  {
                    audioInput: {
                      ...(track.audioInput ?? { input: 0, channels: 1, monitor: false }),
                      monitor: !track.audioInput?.monitor,
                    },
                  },
                  'Input Monitoring',
                )
              }
            >
              <Headphones />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---- drawing ----

interface Draw {
  project: Project;
  selectedTrack: string | null;
  selectedRegions: Set<string>;
  trackHeight: number;
  w: number;
  h: number;
  drag: DragPreview | null;
  /** The automation view: each track's chosen setting, and a lane being dragged. */
  automation: { params: Record<string, string>; preview: LanePreview | null } | null;
}

interface RegionPreview {
  start: number;
  length: number;
  trackIndex: number;
  /** An audio region trimmed, stretched or faded. */
  audio?: AudioClip;
}

interface DragPreview {
  regions: Map<string, RegionPreview>;
  marquee?: { x0: number; y0: number; x1: number; y1: number };
}

function drawTimeline(ctx: CanvasRenderingContext2D, d: Draw): void {
  const { project, w, h, trackHeight } = d;
  const v = tracksView;
  const m = project.meter[0] ?? { tick: 0, num: 4, den: 4 };
  const beat = ticksPerBeat(m);
  const bar = ticksPerBar(m);
  ctx.fillStyle = '#121418';
  ctx.fillRect(0, 0, w, h);

  // lanes
  project.tracks.forEach((t, i) => {
    const y = i * trackHeight - v.y;
    if (y > h || y + trackHeight < 0) return;
    ctx.fillStyle = t.id === d.selectedTrack ? '#1a1e24' : i % 2 ? '#131519' : '#14171b';
    ctx.fillRect(0, y, w, trackHeight);
    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(0, y + trackHeight - 1, w, 1);
  });

  // cycle band
  if (project.cycle.on) {
    const x0 = v.tickToX(project.cycle.start);
    const x1 = v.tickToX(project.cycle.end);
    ctx.fillStyle = 'rgba(246, 196, 83, 0.05)';
    ctx.fillRect(x0, 0, x1 - x0, h);
  }

  // grid
  const step = gridStep(v.pxPerTick, 14, beat, bar);
  const first = Math.floor(v.x / step) * step;
  for (let t = first; store.get().show.gridLines && t < v.xToTick(w); t += step) {
    const x = Math.round(v.tickToX(t)) + 0.5;
    ctx.fillStyle = t % bar === 0 ? 'rgba(255,255,255,0.075)' : 'rgba(255,255,255,0.03)';
    ctx.fillRect(x, 0, 1, h);
  }

  // regions
  const pxPerTick = v.pxPerTick;
  project.tracks.forEach((t, i) => {
    for (const r of t.regions) {
      const moved = d.drag?.regions.get(r.id);
      const start = moved?.start ?? r.start;
      const length = moved?.length ?? r.length;
      const row = moved?.trackIndex ?? i;
      const x = v.tickToX(start);
      const rw = length * pxPerTick;
      if (x > w || x + rw < 0) continue;
      const y = row * trackHeight - v.y + 2;
      const rh = trackHeight - 5;
      if (y > h || y + rh < 0) continue;
      const audio = moved?.audio ?? r.audio;
      const shown = moved ? { ...r, start, length, ...(audio ? { audio } : {}) } : r;
      drawRegion(ctx, shown, t.color, x, y, rw, rh, d.selectedRegions.has(r.id), !!moved, project, w);
    }
  });

  // live recording
  for (const take of liveTakes().values()) {
    const i = project.tracks.findIndex((t) => t.id === take.track);
    if (i < 0) continue;
    const y = i * trackHeight - v.y + 2;
    const now = engine.positionTick();
    const start = Math.min(...take.notes.map((n) => n.t), now);
    const x = v.tickToX(start);
    ctx.fillStyle = 'rgba(255, 79, 94, 0.28)';
    roundRect(ctx, x, y, Math.max(4, v.tickToX(now) - x), trackHeight - 5, 4);
    ctx.fill();
    ctx.fillStyle = '#ffd9dc';
    for (const n of take.notes) {
      const end = n.d > 1 ? n.t + n.d : now;
      const ny = y + trackHeight - 8 - ((n.p % 48) / 48) * (trackHeight - 12);
      ctx.fillRect(v.tickToX(n.t), ny, Math.max(2, (end - n.t) * pxPerTick), 2);
    }
  }

  if (d.automation) drawLanes(ctx, project, v, trackHeight, w, d.automation.params, d.automation.preview);

  if (d.drag?.marquee) {
    const mq = d.drag.marquee;
    ctx.fillStyle = 'rgba(92,184,255,0.1)';
    ctx.strokeStyle = 'rgba(92,184,255,0.7)';
    ctx.lineWidth = 1;
    ctx.fillRect(Math.min(mq.x0, mq.x1), Math.min(mq.y0, mq.y1), Math.abs(mq.x1 - mq.x0), Math.abs(mq.y1 - mq.y0));
    ctx.strokeRect(
      Math.min(mq.x0, mq.x1) + 0.5,
      Math.min(mq.y0, mq.y1) + 0.5,
      Math.abs(mq.x1 - mq.x0),
      Math.abs(mq.y1 - mq.y0),
    );
  }
}

function drawRegion(
  ctx: CanvasRenderingContext2D,
  r: Region,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
  selected: boolean,
  dragging: boolean,
  project: Project,
  canvasWidth: number,
): void {
  const base = r.muted ? '#5d6470' : color;
  const show = store.get().show;
  const header = show.regionNames ? Math.min(15, h * 0.32) : 0;
  ctx.save();
  roundRect(ctx, x + 0.5, y + 0.5, Math.max(3, w - 1), h, 4);
  ctx.clip();
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, alpha(base, selected ? 0.62 : 0.42));
  g.addColorStop(1, alpha(base, selected ? 0.48 : 0.3));
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h + 1);
  ctx.fillStyle = alpha(base, selected ? 0.95 : 0.78);
  ctx.fillRect(x, y, w, header);
  if (w > 26 && header >= 10) {
    ctx.fillStyle = '#0b0d10';
    ctx.font = '600 10.5px Inter Variable, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      r.name || (r.audio ? 'Audio' : r.notes.length ? `${r.notes.length} notes` : 'MIDI'),
      x + 5,
      y + header / 2 + 0.5,
    );
  }
  if (r.audio && show.regionContents) drawWave(ctx, project, r, r.audio, x, y + header, w, h - header, canvasWidth);
  // the notes, scaled to the region's own range
  if (r.notes.length && show.regionContents) {
    let lo = 127;
    let hi = 0;
    for (const n of r.notes) {
      if (n.p < lo) lo = n.p;
      if (n.p > hi) hi = n.p;
    }
    const span = Math.max(12, hi - lo + 1);
    const top = y + header + 3;
    const avail = h - header - 6;
    const pxPerTick = w / r.length;
    ctx.fillStyle = r.muted ? '#9aa1ab' : '#f2f5f8';
    for (const n of r.notes) {
      if (n.t >= r.length) continue;
      const nx = x + n.t * pxPerTick;
      const nw = Math.max(1.5, Math.min(n.d, r.length - n.t) * pxPerTick - 0.5);
      const ny = top + (1 - (n.p - lo + 0.5) / span) * avail;
      ctx.fillRect(nx, ny - 1, nw, Math.max(1.5, Math.min(3, avail / span)));
    }
  }
  ctx.restore();
  ctx.lineWidth = selected ? 1.5 : 1;
  ctx.strokeStyle = selected ? '#ffffff' : alpha(base, 0.95);
  if (dragging) ctx.setLineDash([4, 3]);
  roundRect(ctx, x + 0.5, y + 0.5, Math.max(3, w - 1), h, 4);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** An audio region's waveform as the song plays it (offset, stretch, gain and fades), and its fades. */
function drawWave(
  ctx: CanvasRenderingContext2D,
  project: Project,
  r: Region,
  clip: AudioClip,
  x: number,
  y: number,
  w: number,
  h: number,
  canvasWidth: number,
): void {
  const color = r.muted ? 'rgba(220,226,234,0.55)' : 'rgba(242,245,248,0.92)';
  const style = { from: r.start, to: r.start + r.length, y, h, color, shaped: true, canvasWidth };
  if (!drawClipWave(ctx, project, r, clip, tracksView, style)) return;
  drawFades(ctx, project, r, clip, tracksView, y, h);
  if (Math.abs(clip.stretch - 1) > 1e-4 && w > 60) {
    ctx.fillStyle = 'rgba(11,13,16,0.75)';
    ctx.font = '600 9.5px Inter Variable, system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${Math.round(clip.stretch * 100)}%`, x + 5, y + h - 2);
  }
}

function drawRuler(ctx: CanvasRenderingContext2D, project: Project, w: number, h: number): void {
  const v = tracksView;
  const m = project.meter[0] ?? { tick: 0, num: 4, den: 4 };
  const beat = ticksPerBeat(m);
  const bar = ticksPerBar(m);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#20242a');
  g.addColorStop(1, '#191c21');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // cycle strip (top half)
  const c = project.cycle;
  const x0 = v.tickToX(c.start);
  const x1 = v.tickToX(c.end);
  ctx.fillStyle = c.on ? 'rgba(246,196,83,0.9)' : 'rgba(246,196,83,0.22)';
  roundRect(ctx, x0, 2, Math.max(2, x1 - x0), h / 2 - 4, 3);
  ctx.fill();
  // bar numbers and ticks
  const step = gridStep(v.pxPerTick, 7, beat, bar);
  const labelEvery = gridStep(v.pxPerTick, 34, bar, bar);
  ctx.font = '600 10.5px Inter Variable, system-ui, sans-serif';
  ctx.textBaseline = 'alphabetic';
  for (let t = Math.floor(v.x / step) * step; t < v.xToTick(w); t += step) {
    const x = Math.round(v.tickToX(t)) + 0.5;
    const isBar = t % bar === 0;
    ctx.fillStyle = isBar ? '#7d8796' : '#454c57';
    ctx.fillRect(x, isBar ? h - 12 : h - 5, 1, isBar ? 12 : 5);
    if (isBar && t % labelEvery === 0) {
      ctx.fillStyle = '#b4bcc8';
      ctx.fillText(String(tickToBarBeat(project.meter, t).bar), x + 3, h - 3);
    }
  }
  // markers
  for (const mk of store.get().show.markers ? project.markers : []) {
    const x = v.tickToX(mk.tick);
    if (x < -100 || x > w) continue;
    ctx.fillStyle = '#c792ff';
    ctx.fillRect(x, 0, 1.5, h);
    ctx.fillText(mk.name, x + 4, 11);
  }
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, h - 1, w, 1);
}

// ---- the component ----

const EDGE = 7;
type Edge = 'left' | 'right' | 'fadeIn' | 'fadeOut';

export function TracksArea() {
  const layout = useLayout();
  const phone = isPhone(layout);
  const project = useApp((s) => s.project);
  const selectedTrack = useApp((s) => s.selectedTrack);
  const selectedRegionsList = useApp((s) => s.selectedRegions);
  const trackHeight = useApp((s) => (isTouch() ? Math.max(66, s.trackHeight) : s.trackHeight));
  const tool = useApp((s) => s.tool);
  const automationView = useApp((s) => s.automationView);
  const lanePreview = useRef<LanePreview | null>(null);
  const laneTip = useRef<HTMLDivElement>(null);
  const playing = useApp((s) => s.playing);
  const follow = useApp((s) => s.follow);
  // what the View menu shows: a change redraws the timeline
  useApp((s) => s.show);

  const timelineBox = useRef<HTMLDivElement>(null);
  const rulerBox = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const rulerCanvas = useRef<HTMLCanvasElement>(null);
  const size = useSize(timelineBox);
  const rulerSize = useSize(rulerBox);
  const drag = useRef<DragPreview | null>(null);
  const [, redrawList] = useState(0);
  const dirty = useRef(true);

  const selectedRegions = useMemo(() => new Set(selectedRegionsList), [selectedRegionsList]);

  const redraw = () => {
    dirty.current = true;
  };

  // anything that renders this component may change the picture
  useEffect(() => {
    dirty.current = true;
  });

  // waveforms arrive after the regions
  useEffect(
    () =>
      audioFiles.subscribe(() => {
        dirty.current = true;
      }),
    [],
  );

  useEffect(
    () =>
      tracksView.subscribe(() => {
        dirty.current = true;
        redrawList((n) => n + 1);
      }),
    [],
  );

  useLayoutEffect(() => {
    const z = store.get().zoom;
    if (tracksView.zoom !== z) tracksView.zoom = z;
  }, []);

  // a link to a bar: start the view a bar before it
  useEffect(() => {
    if (!project) return;
    const at = takeLinkedTick();
    if (at !== null) {
      tracksView.x = Math.max(0, at - ticksPerBar(project.meter[0] ?? { num: 4, den: 4 }));
      tracksView.emit();
    }
  }, [project]);

  useFrame(() => {
    const p = store.get().project;
    if (!p) return;
    const tick = engine.positionTick();
    if (store.get().playing && follow && !drag.current) tracksView.follow(tick, size.w);
    if (liveTakes().size) dirty.current = true;
    if (dirty.current) {
      dirty.current = false;
      const ctx = prepare(canvas.current, size.w, size.h);
      if (ctx)
        drawTimeline(ctx, {
          project: p,
          selectedTrack,
          selectedRegions,
          trackHeight,
          w: size.w,
          h: size.h,
          drag: drag.current,
          automation: store.get().automationView
            ? { params: store.get().autoParam, preview: lanePreview.current }
            : null,
        });
      const rctx = prepare(rulerCanvas.current, rulerSize.w, rulerSize.h);
      if (rctx) drawRuler(rctx, p, rulerSize.w, rulerSize.h);
    }
    // the playhead, on its own layer
    const octx = prepare(overlay.current, size.w, size.h);
    if (octx) {
      octx.clearRect(0, 0, size.w, size.h);
      const x = Math.round(tracksView.tickToX(Math.max(0, tick))) + 0.5;
      if (x >= 0 && x <= size.w) {
        const rec = store.get().recording;
        octx.fillStyle = rec ? '#ff4f5e' : '#ffffff';
        octx.shadowColor = rec ? 'rgba(255,79,94,0.8)' : 'rgba(255,255,255,0.6)';
        octx.shadowBlur = 6;
        octx.fillRect(x - 0.5, 0, 1.5, size.h);
        octx.shadowBlur = 0;
      }
    }
  });

  // two-finger pinch zoom on touch screens
  const pinch = useRef(new Map<number, { x: number; y: number }>());
  const lastTap = useRef(0);

  if (!project) return <div className="tracks" />;
  const m = project.meter[0] ?? { tick: 0, num: 4, den: 4 };
  const bar = ticksPerBar(m);
  const snapTicks = () => (tracksView.pxPerTick * bar > 160 ? ticksPerBeat(m) : bar);
  const maxScrollY = Math.max(0, project.tracks.length * trackHeight - size.h + 60);

  /**
   * What's under the pointer. Region edges resize; an audio region's left edge trims its start, and
   * its top corners (the name bar) drag its fades.
   */
  const hit = (
    x: number,
    y: number,
  ): { track: Track; index: number; region: Region | null; edge: Edge | null } | null => {
    const index = Math.floor((y + tracksView.y) / trackHeight);
    const track = project.tracks[index];
    if (!track) return null;
    const tick = tracksView.xToTick(x);
    for (let i = track.regions.length - 1; i >= 0; i--) {
      const r = track.regions[i] as Region;
      if (tick >= r.start && tick <= r.start + r.length) {
        const left = tracksView.tickToX(r.start);
        const right = tracksView.tickToX(r.start + r.length);
        const top = index * trackHeight - tracksView.y + 2;
        const inHeader = y - top < Math.min(15, (trackHeight - 5) * 0.32) + 2;
        let edge: Edge | null = null;
        if (r.length * tracksView.pxPerTick > EDGE * 3) {
          if (right - x < EDGE) edge = r.audio && inHeader ? 'fadeOut' : 'right';
          else if (r.audio && x - left < EDGE) edge = inHeader ? 'fadeIn' : 'left';
        }
        return { track, index, region: r, edge };
      }
    }
    return { track, index, region: null, edge: null };
  };

  const regionMenu = (x: number, y: number, region: Region, track: Track) =>
    openMenu(x, y, [
      {
        label: region.audio ? 'Open in Audio Editor' : 'Open in Piano Roll',
        hint: 'double-click',
        onSelect: () => openInEditor(track.id, region.id),
      },
      { label: 'Split at playhead', hint: 'Ctrl T', onSelect: splitAtPlayhead },
      { label: 'Repeat', hint: 'Ctrl R', onSelect: repeatRegions },
      region.audio
        ? { label: 'Normalize', hint: 'loudest peak to −1 dB', onSelect: () => normalizeRegion(track.id, region.id) }
        : { label: 'Quantize', hint: 'Q', onSelect: quantizeSelection },
      {
        label: region.muted ? 'Unmute' : 'Mute',
        onSelect: () =>
          apply(
            [{ op: 'updateRegion', track: track.id, region: region.id, patch: { muted: !region.muted } }],
            'Mute Region',
          ),
      },
      {
        label: 'Rename…',
        onSelect: () => {
          const name = window.prompt('Region name', region.name);
          if (name !== null)
            apply([{ op: 'updateRegion', track: track.id, region: region.id, patch: { name } }], 'Rename Region');
        },
      },
      { label: 'Loop cycle to region', onSelect: () => setCycle(region.start, region.start + region.length) },
      'sep',
      { label: 'Delete', hint: 'Delete', onSelect: deleteSelection },
    ]);

  const openInEditor = (trackId: string, regionId: string) => {
    store.set({ selectedTrack: trackId, selectedRegions: [regionId], editor: 'piano', mobileTab: 'editor' });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const h = hit(x, y);
    const touch = e.pointerType === 'touch';
    const now = performance.now();
    const doubleTap = now - lastTap.current < 320;
    lastTap.current = now;
    if (automationView && h) {
      onLane(e, x, y, h.track, h.index, doubleTap);
      return;
    }
    if (e.button === 2) {
      if (h?.region) {
        if (!selectedRegions.has(h.region.id)) store.set({ selectedRegions: [h.region.id], selectedTrack: h.track.id });
        regionMenu(e.clientX, e.clientY, h.region, h.track);
      }
      return;
    }
    if (!h) {
      store.set({ selectedRegions: [] });
      if (touch) panDrag(e);
      return;
    }
    selectTrack(h.track.id);
    if (!h.region) {
      if (tool === 'pencil' || (doubleTap && !touch) || (touch && doubleTap)) {
        createRegionAt(h.track.id, tracksView.xToTick(x));
        return;
      }
      store.set({ selectedRegions: [] });
      if (touch) panDrag(e);
      else marqueeDrag(e, x, y);
      return;
    }
    const region = h.region;
    if (tool === 'eraser') {
      apply([{ op: 'removeRegion', track: h.track.id, region: region.id }], 'Delete Region');
      return;
    }
    if (doubleTap) {
      openInEditor(h.track.id, region.id);
      return;
    }
    let selection = selectedRegionsList;
    if (e.shiftKey) {
      selection = selectedRegions.has(region.id)
        ? selection.filter((id) => id !== region.id)
        : [...selection, region.id];
    } else if (!selectedRegions.has(region.id)) selection = [region.id];
    store.set({ selectedRegions: selection });
    if (h.edge === 'right') resizeDrag(e, region, h.track, e.altKey && !!region.audio);
    else if (h.edge === 'left') trimStartDrag(e, region, h.track);
    else if (h.edge === 'fadeIn' || h.edge === 'fadeOut') fadeDrag(e, region, h.track, h.edge);
    else moveDrag(e, selection, h.index, e.altKey);
  };

  /** Automation: add a point (click), move one (drag), delete one (double-click or its menu). */
  const onLane = (e: ReactPointerEvent, x: number, y: number, track: Track, index: number, doubleTap: boolean) => {
    selectTrack(track.id);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const target = targetOf(project, track, store.get().autoParam[track.id] ?? 'volume');
    const lane = findLane(track.channel, target.param);
    const points = (lane?.points ?? []).map((p): [number, number] => [p[0], p[1]]);
    const g = laneGeometry(index, trackHeight, tracksView.y);
    const toY = (v: number) => g.top + (1 - norm(track.channel, target, v)) * g.height;
    const fromY = (py: number) => denorm(track.channel, target, 1 - (py - g.top) / g.height);
    const hit = pointAt(points, x, y, tracksView, toY, e.pointerType === 'touch' ? 16 : 10);
    const commit = (pts: [number, number][], label: string) =>
      apply([{ op: 'setAutomation', target: track.id, param: target.param, points: pts }], label);
    if (e.button === 2) {
      openMenu(e.clientX, e.clientY, [
        ...(hit >= 0
          ? [
              {
                label: 'Delete point',
                onSelect: () =>
                  commit(
                    points.filter((_, i) => i !== hit),
                    'Delete Point',
                  ),
              },
            ]
          : []),
        {
          label: `Clear ${target.name} automation`,
          disabled: !points.length,
          onSelect: () => commit([], 'Clear Automation'),
        },
      ]);
      return;
    }
    if (hit >= 0 && doubleTap) {
      commit(
        points.filter((_, i) => i !== hit),
        'Delete Point',
      );
      return;
    }
    const grid = DIVISIONS[store.get().grid] ?? 240;
    let working = points;
    let at = hit;
    if (at < 0) {
      const tick = Math.max(0, quantize(tracksView.xToTick(x), grid));
      at = working.findIndex((p) => p[0] > tick);
      if (at < 0) at = working.length;
      working = [...working.slice(0, at), [tick, fromY(y)], ...working.slice(at)];
    }
    const show = (px: number, py: number, v: number) => {
      const tip = laneTip.current;
      if (!tip) return;
      tip.style.display = 'block';
      tip.style.left = `${px + 12}px`;
      tip.style.top = `${py - 26}px`;
      tip.textContent = `${target.name}: ${formatValue(target, v)}`;
    };
    lanePreview.current = { track: track.id, param: target.param, points: working };
    show(x, y, (working[at] as [number, number])[1]);
    redraw();
    capture(
      e,
      (ev) => {
        const px = ev.clientX - rect.left;
        const py = ev.clientY - rect.top;
        const lo = at > 0 ? (working[at - 1] as [number, number])[0] : 0;
        const hi = at < working.length - 1 ? (working[at + 1] as [number, number])[0] : Number.POSITIVE_INFINITY;
        const raw = ev.shiftKey ? Math.round(tracksView.xToTick(px)) : quantize(tracksView.xToTick(px), grid);
        const tick = Math.max(lo, Math.min(hi, Math.max(0, raw)));
        const v = fromY(py);
        working = working.map((p, i): [number, number] => (i === at ? [tick, v] : p));
        lanePreview.current = { track: track.id, param: target.param, points: working };
        show(px, py, v);
        redraw();
      },
      () => {
        if (laneTip.current) laneTip.current.style.display = 'none';
        lanePreview.current = null;
        redraw();
        commit(working, hit >= 0 ? 'Move Automation Point' : 'Add Automation Point');
      },
    );
  };

  const capture = (e: ReactPointerEvent, onMove: (ev: PointerEvent) => void, onUp: (ev: PointerEvent) => void) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => onMove(ev);
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      onUp(ev);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const panDrag = (e: ReactPointerEvent) => {
    let lx = e.clientX;
    let ly = e.clientY;
    capture(
      e,
      (ev) => {
        tracksView.scrollBy(lx - ev.clientX, ly - ev.clientY, maxScrollY);
        lx = ev.clientX;
        ly = ev.clientY;
      },
      () => undefined,
    );
  };

  const marqueeDrag = (e: ReactPointerEvent, x0: number, y0: number) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    capture(
      e,
      (ev) => {
        drag.current = {
          regions: new Map(),
          marquee: { x0, y0, x1: ev.clientX - rect.left, y1: ev.clientY - rect.top },
        };
        redraw();
      },
      () => {
        const mq = drag.current?.marquee;
        drag.current = null;
        redraw();
        if (!mq) return;
        const t0 = tracksView.xToTick(Math.min(mq.x0, mq.x1));
        const t1 = tracksView.xToTick(Math.max(mq.x0, mq.x1));
        const r0 = Math.floor((Math.min(mq.y0, mq.y1) + tracksView.y) / trackHeight);
        const r1 = Math.floor((Math.max(mq.y0, mq.y1) + tracksView.y) / trackHeight);
        const ids: string[] = [];
        project.tracks.forEach((t, i) => {
          if (i < r0 || i > r1) return;
          for (const r of t.regions) if (r.start < t1 && r.start + r.length > t0) ids.push(r.id);
        });
        store.set({ selectedRegions: ids });
      },
    );
  };

  const moveDrag = (e: ReactPointerEvent, ids: string[], fromRow: number, copy: boolean) => {
    const startX = e.clientX;
    const startY = e.clientY;
    const snap = snapTicks();
    let moved = false;
    const originals = ids.map((id) => findRegion(project, id)).filter((x): x is NonNullable<typeof x> => !!x);
    capture(
      e,
      (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        const dTick = quantize(dx / tracksView.pxPerTick, snap);
        const dRow = Math.round(dy / trackHeight);
        const preview = new Map<string, { start: number; length: number; trackIndex: number }>();
        for (const { track, region } of originals) {
          const row = Math.max(0, Math.min(project.tracks.length - 1, project.tracks.indexOf(track) + dRow));
          preview.set(region.id, { start: Math.max(0, region.start + dTick), length: region.length, trackIndex: row });
        }
        drag.current = { regions: preview };
        redraw();
      },
      () => {
        const preview = drag.current?.regions;
        drag.current = null;
        redraw();
        if (!moved || !preview) return;
        const ops: Op[] = originals.flatMap(({ track, region }): Op[] => {
          const p = preview.get(region.id);
          if (!p) return [];
          const to = project.tracks[p.trackIndex] ?? track;
          if (copy)
            return [
              {
                op: 'addRegion' as const,
                track: to.id,
                region: {
                  ...structuredClone(region),
                  id: `rgn_${Math.random().toString(36).slice(2, 12)}`,
                  start: p.start,
                },
              },
            ];
          if (p.start === region.start && to.id === track.id) return [];
          return [{ op: 'moveRegion' as const, from: track.id, to: to.id, region: region.id, start: p.start }];
        });
        if (ops.length) apply(ops, copy ? 'Copy Regions' : 'Move Regions');
        void fromRow;
      },
    );
  };

  /** The right edge: longer or shorter; on an audio region with Alt, time-stretched (Logic's Option-drag). */
  const resizeDrag = (e: ReactPointerEvent, region: Region, track: Track, stretch: boolean) => {
    const startX = e.clientX;
    const snap = snapTicks();
    const clip = region.audio;
    const trackIndex = project.tracks.indexOf(track);
    capture(
      e,
      (ev) => {
        const length = Math.max(snap, quantize(region.length + (ev.clientX - startX) / tracksView.pxPerTick, snap));
        const next: RegionPreview = clip
          ? { start: region.start, trackIndex, ...trimEnd(project, region, clip, length, stretch) }
          : { start: region.start, length, trackIndex };
        drag.current = { regions: new Map([[region.id, next]]) };
        redraw();
      },
      () => {
        const p = drag.current?.regions.get(region.id);
        drag.current = null;
        redraw();
        if (!p) return;
        const stretched = !!p.audio && p.audio.stretch !== clip?.stretch;
        if (p.length === region.length && !stretched) return;
        apply(
          [
            {
              op: 'updateRegion',
              track: track.id,
              region: region.id,
              patch: p.audio ? { length: p.length, audio: p.audio } : { length: p.length },
            },
          ],
          stretched ? 'Time Stretch' : 'Resize Region',
        );
      },
    );
  };

  /** An audio region's left edge: starts later (or earlier, as far as the recording goes). */
  const trimStartDrag = (e: ReactPointerEvent, region: Region, track: Track) => {
    const clip = region.audio;
    if (!clip) return;
    const startX = e.clientX;
    const snap = snapTicks();
    const trackIndex = project.tracks.indexOf(track);
    capture(
      e,
      (ev) => {
        const start = quantize(region.start + (ev.clientX - startX) / tracksView.pxPerTick, snap);
        drag.current = { regions: new Map([[region.id, { trackIndex, ...trimStart(project, region, clip, start) }]]) };
        redraw();
      },
      () => {
        const p = drag.current?.regions.get(region.id);
        drag.current = null;
        redraw();
        if (!p?.audio || p.start === region.start) return;
        apply(
          [
            {
              op: 'updateRegion',
              track: track.id,
              region: region.id,
              patch: { start: p.start, length: p.length, audio: p.audio },
            },
          ],
          'Trim Region',
        );
      },
    );
  };

  /** Dragging a fade's corner. */
  const fadeDrag = (e: ReactPointerEvent, region: Region, track: Track, which: 'fadeIn' | 'fadeOut') => {
    const clip = region.audio;
    if (!clip) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const trackIndex = project.tracks.indexOf(track);
    capture(
      e,
      (ev) => {
        const audio = fadeTo(project, region, clip, which, tracksView.xToTick(ev.clientX - rect.left));
        drag.current = {
          regions: new Map([[region.id, { start: region.start, length: region.length, trackIndex, audio }]]),
        };
        redraw();
      },
      () => {
        const p = drag.current?.regions.get(region.id);
        drag.current = null;
        redraw();
        if (!p?.audio) return;
        apply([{ op: 'updateRegion', track: track.id, region: region.id, patch: { audio: p.audio } }], 'Fade');
      },
    );
  };

  // ruler: top half sets or moves the cycle, bottom half moves the playhead
  const onRulerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const tick = tracksView.xToTick(x);
    const snap = snapTicks();
    if (y > rect.height / 2) {
      locate(quantize(tick, ticksPerBeat(m)));
      capture(
        e,
        (ev) => locate(quantize(tracksView.xToTick(ev.clientX - rect.left), ticksPerBeat(m))),
        () => undefined,
      );
      return;
    }
    const c = project.cycle;
    const x0 = tracksView.tickToX(c.start);
    const x1 = tracksView.tickToX(c.end);
    const mode = Math.abs(x - x0) < 8 ? 'start' : Math.abs(x - x1) < 8 ? 'end' : x > x0 && x < x1 ? 'move' : 'new';
    const anchor = quantize(tick, snap);
    let next = { start: c.start, end: c.end };
    capture(
      e,
      (ev) => {
        const t = quantize(tracksView.xToTick(ev.clientX - rect.left), snap);
        if (mode === 'start') next = { start: Math.min(t, c.end - snap), end: c.end };
        else if (mode === 'end') next = { start: c.start, end: Math.max(t, c.start + snap) };
        else if (mode === 'move') {
          const d = t - anchor;
          next = { start: Math.max(0, c.start + d), end: Math.max(snap, c.end + d) };
        } else next = { start: Math.min(anchor, t), end: Math.max(anchor + snap, t) };
        // live preview without an undo step per pixel
        store.set({ project: { ...project, cycle: { on: true, ...next } } });
        redraw();
      },
      () => {
        store.set({ project });
        if (mode === 'new' && next.start === c.start && next.end === c.end) {
          apply([{ op: 'setProject', patch: { cycle: { ...c, on: !c.on } } }], 'Cycle');
          return;
        }
        setCycle(next.start, next.end);
      },
    );
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      tracksView.zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - rect.left, 3, 600);
      store.set({ zoom: tracksView.zoom });
    } else if (e.shiftKey) tracksView.scrollBy(e.deltaY || e.deltaX, 0, maxScrollY);
    else tracksView.scrollBy(e.deltaX, e.deltaY, maxScrollY);
  };

  const onTouchPointer = (e: ReactPointerEvent) => {
    if (e.pointerType !== 'touch') return;
    pinch.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };

  const headerWidth = phone ? 150 : layout === 'tablet' ? 210 : 230;
  const end = songLength(project);

  return (
    <div className="tracks" style={{ ['--headers' as string]: `${headerWidth}px` }}>
      <div className="tracks-toolbar">
        <button
          type="button"
          className="btn icon"
          title="New track (Alt Ctrl N)"
          onClick={(e) => openMenuAt(e.currentTarget, newTrackMenu())}
        >
          <Plus />
        </button>
        {!phone && (
          <div className="seg tool-seg">
            {(
              [
                ['pointer', <MousePointer2 key="p" />, 'Pointer'],
                ['pencil', <Pencil key="c" />, 'Pencil: click to make a region'],
                ['eraser', <Eraser key="e" />, 'Eraser'],
              ] as const
            ).map(([t, icon, title]) => (
              <button
                key={t}
                type="button"
                className={`btn icon${tool === t ? ' on' : ''}`}
                title={title}
                onClick={() => store.set({ tool: t })}
              >
                {icon}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className={`btn icon${automationView ? ' on' : ''}`}
          style={
            automationView ? { background: 'linear-gradient(180deg, #ffe08a, #ffd166)', color: '#1c1505' } : undefined
          }
          title="Automation (A): draw how volume, pan, sends and plugins move"
          onClick={() => store.set({ automationView: !automationView })}
        >
          <Activity />
        </button>
        <span className="grow" />
        <button
          type="button"
          className="btn ghost icon"
          title="Zoom out (Ctrl wheel)"
          onClick={() => {
            tracksView.zoomAt(0.7, 0, 3, 600);
            store.set({ zoom: tracksView.zoom });
          }}
        >
          <ZoomOut />
        </button>
        {!phone && (
          <button
            type="button"
            className="btn ghost icon"
            title="Zoom in"
            onClick={() => {
              tracksView.zoomAt(1.4, 0, 3, 600);
              store.set({ zoom: tracksView.zoom });
            }}
          >
            <ZoomIn />
          </button>
        )}
      </div>
      <div
        className="ruler"
        ref={rulerBox}
        onPointerDown={onRulerDown}
        onWheel={onWheel}
        title="Top: drag to set the cycle. Bottom: click to move the playhead"
      >
        <canvas ref={rulerCanvas} />
      </div>
      <div className="track-list" onWheel={(e) => tracksView.scrollBy(0, e.deltaY, maxScrollY)}>
        {project.tracks.map((t, i) => (
          <TrackRow
            key={t.id}
            track={t}
            top={i * trackHeight - tracksView.y}
            height={trackHeight}
            selected={t.id === selectedTrack}
          />
        ))}
        <button
          type="button"
          className="btn ghost"
          style={{ position: 'absolute', left: 8, top: project.tracks.length * trackHeight - tracksView.y + 8 }}
          onClick={(e) => openMenuAt(e.currentTarget, newTrackMenu())}
        >
          <Plus /> New track
        </button>
      </div>
      <div
        className="timeline"
        ref={timelineBox}
        onPointerDown={(e) => {
          onTouchPointer(e);
          if (pinch.current.size >= 2) return;
          onPointerDown(e);
        }}
        onPointerMove={(e) => {
          const pts = pinch.current;
          if (e.pointerType === 'touch' && pts.size === 2 && pts.has(e.pointerId)) {
            const [a, b] = [...pts.values()] as [{ x: number; y: number }, { x: number; y: number }];
            const before = Math.abs(a.x - b.x);
            pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
            const [c, d] = [...pts.values()] as [{ x: number; y: number }, { x: number; y: number }];
            const after = Math.abs(c.x - d.x);
            if (before > 20 && after > 20) {
              const rect = e.currentTarget.getBoundingClientRect();
              tracksView.zoomAt(after / before, (c.x + d.x) / 2 - rect.left, 3, 600);
              store.set({ zoom: tracksView.zoom });
            }
          } else if (e.pointerType !== 'touch') {
            const rect = e.currentTarget.getBoundingClientRect();
            const h = hit(e.clientX - rect.left, e.clientY - rect.top);
            e.currentTarget.style.cursor =
              h?.edge === 'fadeIn' || h?.edge === 'fadeOut'
                ? 'crosshair'
                : h?.edge
                  ? e.altKey && h.region?.audio && h.edge === 'right'
                    ? 'col-resize'
                    : 'ew-resize'
                  : tool === 'pencil' && !h?.region
                    ? 'copy'
                    : 'default';
          }
        }}
        onPointerUp={(e) => pinch.current.delete(e.pointerId)}
        onPointerCancel={(e) => pinch.current.delete(e.pointerId)}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(e) => {
          const files = [...e.dataTransfer.files];
          if (!files.length) return;
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          const h = hit(e.clientX - rect.left, e.clientY - rect.top);
          const tick = Math.max(0, quantize(tracksView.xToTick(e.clientX - rect.left), snapTicks()));
          void importAudio(files, h?.track.kind === 'audio' ? h.track.id : null, tick);
        }}
      >
        <canvas ref={canvas} />
        <canvas ref={overlay} style={{ pointerEvents: 'none' }} />
        <div ref={laneTip} className="lane-tip" />
        {project.tracks.every((t) => t.regions.length === 0) && (
          <div className="empty-hint">
            <div>
              {isTouch()
                ? 'Double-tap a lane to make a region,'
                : 'Double-click a lane (or use the pencil) to make a region,'}
              <br />
              press <kbd>R</kbd> and play your keyboard to record, or drop audio files here.
            </div>
          </div>
        )}
      </div>
      <span hidden>
        {end}
        {playing ? 1 : 0}
        {barToTick(project.meter, 1)}
        {meterAt(project.meter, 0).num}
        {DIVISIONS['1/4']}
      </span>
    </div>
  );
}
