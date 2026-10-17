/**
 * The Audio Editor (Logic's Audio Track editor): one audio region large, with the rest of its
 * recording faded around it. Drag its edges to trim, Alt-drag the end to time-stretch, drag the
 * corner squares for fades; gain, fades and stretch can be typed in the bar.
 */
import {
  type AudioClip,
  type ParamDef,
  type Project,
  type Region,
  secondsToTick,
  type Track,
  ticksPerBar,
  ticksPerBeat,
  tickToBarBeat,
  tickToSeconds,
} from '@holo/session';
import { Upload, ZoomIn, ZoomOut } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  apply,
  beginGesture,
  endGesture,
  gestureChange,
  locate,
  normalizeRegion,
  secondsBetween,
} from '../app/actions.ts';
import { isPhone, useLayout } from '../app/layout.ts';
import { store, useApp } from '../app/store.ts';
import { engine } from '../audio/engine.ts';
import { audioFiles } from '../audio/files.ts';
import { Knob } from './controls.tsx';
import { alpha, prepare, useFrame, useSize } from './frame.ts';
import { chooseAudioFiles, inputLabel } from './Tracks.tsx';
import { gridStep, Viewport } from './view.ts';
import { drawClipWave, drawFades, fadeTo, fileSpan, setStretch, trimEnd, trimStart } from './wave.ts';

export const audioView = new Viewport(120);

const GAIN: ParamDef = { id: 'gain', name: 'Gain', min: -24, max: 24, default: 0, step: 0.1, unit: 'dB' };
const HANDLE = 9;

type Grab = 'start' | 'end' | 'fadeIn' | 'fadeOut';

/** The audio region the editor shows: the selected one on this track, else the one at the playhead, else the first. */
function shownRegion(track: Track | null, selected: string[]): Region | null {
  if (track?.kind !== 'audio') return null;
  const audio = track.regions.filter((r) => r.audio);
  const chosen = audio.find((r) => selected.includes(r.id));
  if (chosen) return chosen;
  const at = engine.positionTick();
  return audio.find((r) => at >= r.start && at < r.start + r.length) ?? audio[0] ?? null;
}

export function useAudioRegion(): { project: Project | null; track: Track | null; region: Region | null } {
  const project = useApp((s) => s.project);
  const trackId = useApp((s) => s.selectedTrack);
  const selected = useApp((s) => s.selectedRegions);
  const track = project?.tracks.find((t) => t.id === trackId) ?? null;
  return { project, track, region: shownRegion(track, selected) };
}

export function AudioEditor() {
  const { project, track, region } = useAudioRegion();
  const box = useRef<HTMLDivElement>(null);
  const rulerBox = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const rulerCanvas = useRef<HTMLCanvasElement>(null);
  const size = useSize(box);
  const rulerSize = useSize(rulerBox);
  const dirty = useRef(true);
  const preview = useRef<{ start: number; length: number; audio: AudioClip } | null>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    dirty.current = true;
  });
  useEffect(() => audioView.subscribe(() => (dirty.current = true)), []);
  useEffect(() => audioFiles.subscribe(() => (dirty.current = true)), []);

  // a region opens: the whole recording in view
  // biome-ignore lint/correctness/useExhaustiveDependencies: refits when the region changes, not on every edit
  useLayoutEffect(() => {
    if (!project || !region?.audio || !size.w) return;
    const [a, b] = fileSpan(project, region, region.audio);
    const from = Math.min(a, region.start);
    const to = Math.max(Number.isFinite(b) ? b : region.start + region.length, region.start + region.length);
    const span = Math.max(240, to - from);
    audioView.zoom = Math.max(4, Math.min(4000, ((size.w * 0.9) / span) * 960));
    audioView.x = Math.max(0, from - (size.w * 0.05) / audioView.pxPerTick);
    audioView.emit();
  }, [region?.id, size.w > 0]);

  useFrame(() => {
    const p = store.get().project;
    if (!p) return;
    if (dirty.current) {
      dirty.current = false;
      const ctx = prepare(canvas.current, size.w, size.h);
      if (ctx) draw(ctx, p, track, region, preview.current, size.w, size.h);
      const rctx = prepare(rulerCanvas.current, rulerSize.w, rulerSize.h);
      if (rctx) drawRuler(rctx, p, rulerSize.w, rulerSize.h);
    }
    const octx = prepare(overlay.current, size.w, size.h);
    if (octx) {
      octx.clearRect(0, 0, size.w, size.h);
      const x = Math.round(audioView.tickToX(Math.max(0, engine.positionTick()))) + 0.5;
      if (x >= 0 && x <= size.w) {
        octx.fillStyle = store.get().recording ? '#ff4f5e' : '#ffffff';
        octx.fillRect(x - 0.5, 0, 1.5, size.h);
      }
    }
  });

  if (!project || !track) return <div className="audio-ed empty">Select a track.</div>;
  if (!region?.audio) {
    return (
      <div className="audio-ed empty">
        <div className="vstack" style={{ alignItems: 'center', gap: 10 }}>
          <span>
            {track.name} has no recordings yet. Arm it (R) and record from {inputLabel(track)}, or bring in a file.
          </span>
          <button type="button" className="btn" onClick={() => chooseAudioFiles()}>
            <Upload /> Import audio file…
          </button>
        </div>
      </div>
    );
  }
  const clip = region.audio;
  const m = project.meter[0] ?? { tick: 0, num: 4, den: 4 };
  const snapTo = (tick: number, free: boolean) => {
    if (free) return Math.round(tick);
    const step = gridStep(audioView.pxPerTick, 14, ticksPerBeat(m), ticksPerBar(m));
    return Math.round(tick / step) * step;
  };

  const grabAt = (x: number, y: number): Grab | null => {
    const shown = preview.current ?? { start: region.start, length: region.length, audio: clip };
    const x0 = audioView.tickToX(shown.start);
    const x1 = audioView.tickToX(shown.start + shown.length);
    const s0 = tickToSeconds(project.tempo, shown.start);
    const total = secondsBetween(project, shown.start, shown.start + shown.length);
    const fx = (sec: number) => audioView.tickToX(secondsToTick(project.tempo, s0 + sec));
    if (y < 22) {
      if (Math.abs(x - fx(shown.audio.fadeIn)) < HANDLE + 2 && x < (x0 + x1) / 2) return 'fadeIn';
      if (Math.abs(x - fx(total - shown.audio.fadeOut)) < HANDLE + 2 && x > (x0 + x1) / 2) return 'fadeOut';
    }
    if (Math.abs(x - x0) < HANDLE) return 'start';
    if (Math.abs(x - x1) < HANDLE) return 'end';
    return null;
  };

  const commit = (next: { start: number; length: number; audio: AudioClip }, label: string) => {
    if (next.start === region.start && next.length === region.length && next.audio === clip) return;
    apply(
      [
        {
          op: 'updateRegion',
          track: track.id,
          region: region.id,
          patch: { start: next.start, length: next.length, audio: next.audio },
        },
      ],
      label,
    );
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    store.set({ selectedRegions: [region.id] });
    const grab = grabAt(x, y);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    let lx = e.clientX;
    let label = '';
    const move = (ev: PointerEvent) => {
      const tick = audioView.xToTick(ev.clientX - rect.left);
      const free = ev.ctrlKey || ev.metaKey;
      if (grab === 'start') {
        preview.current = trimStart(project, region, clip, snapTo(tick, free));
        label = 'Trim Region';
      } else if (grab === 'end') {
        const stretch = ev.altKey;
        const r = trimEnd(project, region, clip, snapTo(tick, free) - region.start, stretch);
        preview.current = { start: region.start, ...r };
        label = stretch ? 'Time Stretch' : 'Trim Region';
      } else if (grab) {
        preview.current = {
          start: region.start,
          length: region.length,
          audio: fadeTo(project, region, clip, grab, tick),
        };
        label = 'Fade';
      } else {
        // empty space: drag to scroll
        audioView.scrollBy(lx - ev.clientX, 0);
        lx = ev.clientX;
      }
      dirty.current = true;
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      const next = preview.current;
      preview.current = null;
      dirty.current = true;
      if (next) commit(next, label);
      else if (!grab && Math.abs(ev.clientX - startX) < 4)
        locate(snapTo(audioView.xToTick(ev.clientX - rect.left), true));
      bump((n) => n + 1);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.buttons) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const grab = grabAt(e.clientX - rect.left, e.clientY - rect.top);
    e.currentTarget.style.cursor =
      grab === 'start' || grab === 'end'
        ? e.altKey && grab === 'end'
          ? 'col-resize'
          : 'ew-resize'
        : grab
          ? 'crosshair'
          : 'grab';
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) audioView.zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - rect.left, 4, 4000);
    else audioView.scrollBy(e.deltaX || e.deltaY, 0);
  };

  return (
    <div className="audio-ed">
      <div
        className="cell ruler-cell"
        ref={rulerBox}
        onPointerDown={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          locate(snapTo(audioView.xToTick(e.clientX - rect.left), false));
        }}
        onWheel={onWheel}
      >
        <canvas ref={rulerCanvas} />
      </div>
      <div className="cell" ref={box} onPointerDown={onDown} onPointerMove={onMove} onWheel={onWheel}>
        <canvas ref={canvas} />
        <canvas ref={overlay} style={{ pointerEvents: 'none' }} />
      </div>
    </div>
  );
}

function draw(
  ctx: CanvasRenderingContext2D,
  project: Project,
  track: Track | null,
  region: Region | null,
  preview: { start: number; length: number; audio: AudioClip } | null,
  w: number,
  h: number,
): void {
  const m = project.meter[0] ?? { tick: 0, num: 4, den: 4 };
  const beat = ticksPerBeat(m);
  const bar = ticksPerBar(m);
  ctx.fillStyle = '#101216';
  ctx.fillRect(0, 0, w, h);
  const step = gridStep(audioView.pxPerTick, 14, beat, bar);
  for (let t = Math.floor(audioView.x / step) * step; t < audioView.xToTick(w); t += step) {
    const x = Math.round(audioView.tickToX(t)) + 0.5;
    ctx.fillStyle = t % bar === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.03)';
    ctx.fillRect(x, 0, 1, h);
  }
  const clip0 = region?.audio;
  if (!region || !clip0 || !track) return;
  const shown = preview ?? { start: region.start, length: region.length, audio: clip0 };
  const r = { start: shown.start, length: shown.length };
  const clip = shown.audio;
  const color = track.color;
  const top = 6;
  const height = h - 12;
  // dB guides: -6 and -12 below full scale
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  for (const db of [-6, -12]) {
    const a = 10 ** (db / 20) * (height / 2 - 2);
    ctx.fillRect(0, top + height / 2 - a, w, 1);
    ctx.fillRect(0, top + height / 2 + a, w, 1);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(0, Math.round(top + height / 2), w, 1);
  // the whole recording, faded, so a trim shows what it hid
  const [fa, fb] = fileSpan(project, r, clip);
  const style = { y: top, h: height, canvasWidth: w };
  drawClipWave(ctx, project, r, clip, audioView, {
    ...style,
    from: fa,
    to: Number.isFinite(fb) ? fb : r.start + r.length,
    color: 'rgba(160,170,184,0.28)',
    shaped: false,
  });
  // the region itself
  const x0 = audioView.tickToX(r.start);
  const x1 = audioView.tickToX(r.start + r.length);
  ctx.fillStyle = alpha(color, 0.14);
  ctx.fillRect(x0, 0, x1 - x0, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, 0, x1 - x0, h);
  ctx.clip();
  ctx.fillStyle = '#101216';
  ctx.globalAlpha = 0.6;
  ctx.fillRect(x0, top, x1 - x0, height);
  ctx.globalAlpha = 1;
  ctx.fillStyle = alpha(color, 0.14);
  ctx.fillRect(x0, 0, x1 - x0, h);
  const loaded = drawClipWave(ctx, project, r, clip, audioView, {
    ...style,
    from: r.start,
    to: r.start + r.length,
    color: '#f2f5f8',
    shaped: true,
  });
  drawFades(ctx, project, r, clip, audioView, top, height);
  ctx.restore();
  if (!loaded) {
    ctx.fillStyle = '#7d8796';
    ctx.font = '600 12px Inter Variable, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('Loading the recording…', Math.max(12, x0 + 12), h / 2);
  }
  // edges and fade handles
  ctx.fillStyle = color;
  ctx.fillRect(x0 - 1, 0, 2, h);
  ctx.fillRect(x1 - 1, 0, 2, h);
  ctx.fillRect(x0, h / 2 - 14, 5, 28);
  ctx.fillRect(x1 - 5, h / 2 - 14, 5, 28);
  const s0 = tickToSeconds(project.tempo, r.start);
  const total = secondsBetween(project, r.start, r.start + r.length);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#0b0d10';
  for (const sec of [clip.fadeIn, total - clip.fadeOut]) {
    const x = audioView.tickToX(secondsToTick(project.tempo, s0 + sec));
    ctx.fillRect(x - 4, 2, 8, 8);
    ctx.strokeRect(x - 4 + 0.5, 2.5, 7, 7);
  }
  ctx.fillStyle = 'rgba(242,245,248,0.85)';
  ctx.font = '600 11px Inter Variable, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  const facts = [
    region.name || 'Audio',
    clip.gain ? `${clip.gain > 0 ? '+' : ''}${clip.gain.toFixed(1)} dB` : '',
    clip.stretch !== 1 ? `${Math.round(clip.stretch * 1000) / 10}%` : '',
  ].filter(Boolean);
  ctx.fillText(facts.join('  ·  '), Math.max(8, x0 + 10), 14);
}

function drawRuler(ctx: CanvasRenderingContext2D, project: Project, w: number, h: number): void {
  const m = project.meter[0] ?? { tick: 0, num: 4, den: 4 };
  const beat = ticksPerBeat(m);
  const bar = ticksPerBar(m);
  ctx.fillStyle = '#1b1e23';
  ctx.fillRect(0, 0, w, h);
  ctx.font = '600 10.5px Inter Variable, system-ui, sans-serif';
  const step = gridStep(audioView.pxPerTick, 7, beat, bar);
  const labels = Math.max(beat, gridStep(audioView.pxPerTick, 40, beat, bar));
  for (let t = Math.floor(audioView.x / step) * step; t < audioView.xToTick(w); t += step) {
    const x = Math.round(audioView.tickToX(t)) + 0.5;
    const isBar = t % bar === 0;
    ctx.fillStyle = isBar ? '#7d8796' : '#454c57';
    ctx.fillRect(x, isBar ? h - 11 : h - 5, 1, isBar ? 11 : 5);
    if (t % labels === 0) {
      const bb = tickToBarBeat(project.meter, t);
      ctx.fillStyle = isBar ? '#c3cad4' : '#7d8796';
      ctx.fillText(isBar ? String(bb.bar) : `${bb.bar}.${bb.beat}`, x + 3, h - 4);
    }
  }
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, h - 1, w, 1);
}

/** A number typed in, committed on Enter or leaving the field. */
export function NumberBox({
  value,
  onCommit,
  label,
  unit,
  width = 58,
  min,
  max,
}: {
  value: number;
  onCommit: (v: number) => void;
  label: string;
  unit: string;
  width?: number;
  min: number;
  max: number;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const done = () => {
    const v = Number(text);
    if (Number.isFinite(v) && v !== value) onCommit(Math.max(min, Math.min(max, v)));
    else setText(String(value));
  };
  return (
    <label className="hstack" style={{ gap: 4 }} title={label}>
      <span className="label">{label}</span>
      <input
        className="input mono"
        inputMode="decimal"
        aria-label={label}
        value={text}
        style={{ width, height: 24 }}
        onChange={(e) => setText(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setText(String(value));
            e.currentTarget.blur();
          }
          e.stopPropagation();
        }}
      />
      <span className="muted">{unit}</span>
    </label>
  );
}

export function AudioEditorBar() {
  const { project, track, region } = useAudioRegion();
  const layout = useLayout();
  const phone = isPhone(layout);
  const clip = region?.audio;
  const update = (audio: AudioClip, label: string, patch: Partial<Region> = {}) => {
    if (!track || !region) return;
    apply([{ op: 'updateRegion', track: track.id, region: region.id, patch: { ...patch, audio } }], label);
  };
  return (
    <>
      {!phone && <span className="title">Audio Editor</span>}
      <span className="muted" style={{ whiteSpace: 'nowrap' }}>
        {track?.name ?? ''}
      </span>
      {project && track && region && clip && (
        <>
          <div className="hstack" style={{ gap: 4 }}>
            <Knob
              def={GAIN}
              value={clip.gain}
              size={26}
              compact
              label="Region gain"
              color={track.color}
              onBegin={() => beginGesture('Region Gain')}
              onChange={(gain) =>
                gestureChange([
                  {
                    op: 'updateRegion',
                    track: track.id,
                    region: region.id,
                    patch: { audio: { ...clip, gain: Math.round(gain * 10) / 10 } },
                  },
                ])
              }
              onEnd={endGesture}
            />
            <span className="mono" style={{ minWidth: 52 }}>
              {clip.gain > 0 ? '+' : ''}
              {clip.gain.toFixed(1)} dB
            </span>
          </div>
          <NumberBox
            label="Fade in"
            unit="ms"
            value={Math.round(clip.fadeIn * 1000)}
            min={0}
            max={60000}
            onCommit={(v) => update({ ...clip, fadeIn: v / 1000 }, 'Fade')}
          />
          <NumberBox
            label="Fade out"
            unit="ms"
            value={Math.round(clip.fadeOut * 1000)}
            min={0}
            max={60000}
            onCommit={(v) => update({ ...clip, fadeOut: v / 1000 }, 'Fade')}
          />
          <NumberBox
            label="Stretch"
            unit="%"
            value={Math.round(clip.stretch * 1000) / 10}
            min={25}
            max={400}
            onCommit={(v) => {
              const next = setStretch(project, region, clip, v / 100);
              if (next.audio) update(next.audio, 'Time Stretch', { length: next.length });
            }}
          />
          <button
            type="button"
            className="btn"
            title="Set the gain so the loudest peak reaches −1 dB"
            onClick={() => normalizeRegion(track.id, region.id)}
          >
            Normalize
          </button>
        </>
      )}
      <span className="grow" />
      <button
        type="button"
        className="btn ghost icon"
        title="Zoom out"
        onClick={() => audioView.zoomAt(0.7, 0, 4, 4000)}
      >
        <ZoomOut />
      </button>
      <button
        type="button"
        className="btn ghost icon"
        title="Zoom in"
        onClick={() => audioView.zoomAt(1.4, 0, 4, 4000)}
      >
        <ZoomIn />
      </button>
    </>
  );
}
