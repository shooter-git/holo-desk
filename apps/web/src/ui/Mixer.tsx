/** The mixer: a channel strip per track, then the buses and the master; and the plugin windows. */
import { bandsResponse, peqBands } from '@holo/engine';
import {
  type Bus,
  type Channel,
  type Op,
  type ParamDef,
  PEQ_BANDS,
  PEQ_TYPES,
  PLUGINS,
  type Plugin,
  type PluginDef,
  paramValue,
  pluginDef,
  type Seat,
  SPACE_FILE,
  SPACE_NAMES,
  type Stage,
  type Track,
} from '@holo/session';
import { Headphones, Power, X } from 'lucide-react';
import { memo, type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  addBusWithSend,
  addPlugin,
  apply,
  beginGesture,
  endGesture,
  gestureChange,
  selectTrack,
  setInstrument,
  updateChannel,
  updateTrack,
} from '../app/actions.ts';
import { isPhone, useLayout } from '../app/layout.ts';
import { store, useApp } from '../app/store.ts';
import { engine } from '../audio/engine.ts';
import { library } from '../audio/samples.ts';
import { Fader, formatDb, Knob, Meter, PanKnob, startDrag, TAP } from './controls.tsx';
import { prepare, useFrame, useSize } from './frame.ts';
import { openMenu, openMenuAt } from './menu.tsx';
import { inputLabel, instrumentLabel, instrumentMenu } from './Tracks.tsx';

function pluginsOf(kind: 'audio' | 'midi'): PluginDef[] {
  return PLUGINS.filter((p) => p.kind === kind);
}

function addPluginMenu(el: Element, target: string, slot: 'inserts' | 'midiFx'): void {
  const defs = pluginsOf(slot === 'midiFx' ? 'midi' : 'audio');
  const cats = [...new Set(defs.map((d) => d.category))];
  openMenuAt(
    el,
    cats.flatMap((c) => [
      { heading: c },
      ...defs
        .filter((d) => d.category === c)
        .map((d) => ({ label: d.name, hint: '', onSelect: () => addPlugin(target, d.type, slot) })),
    ]),
  );
}

function PluginSlot({ target, plugin }: { target: string; plugin: Plugin }) {
  const def = pluginDef(plugin.type);
  const open = () => store.set({ plugin: { target, id: plugin.id } });
  const menu = (x: number, y: number) =>
    openMenu(x, y, [
      { label: 'Open', onSelect: open },
      {
        label: plugin.bypass ? 'Turn on' : 'Bypass',
        onSelect: () =>
          apply([{ op: 'updatePlugin', target, plugin: plugin.id, patch: { bypass: !plugin.bypass } }], 'Bypass'),
      },
      { label: 'Move up', onSelect: () => movePlugin(target, plugin.id, -1) },
      { label: 'Move down', onSelect: () => movePlugin(target, plugin.id, 1) },
      'sep',
      { label: 'Remove', onSelect: () => apply([{ op: 'removePlugin', target, plugin: plugin.id }], 'Remove Plugin') },
    ]);
  return (
    <div
      className={`slot filled${plugin.bypass ? ' bypass' : ''}`}
      title={`${def?.name ?? plugin.type}${plugin.bypass ? ' (bypassed)' : ''}: click to open, right-click for more`}
      onClick={open}
      onContextMenu={(e) => {
        e.preventDefault();
        menu(e.clientX, e.clientY);
      }}
    >
      <button
        type="button"
        className="slot-power"
        tabIndex={-1}
        title="Bypass"
        aria-label={plugin.bypass ? 'Turn on' : 'Bypass'}
        onClick={(e) => {
          e.stopPropagation();
          apply([{ op: 'updatePlugin', target, plugin: plugin.id, patch: { bypass: !plugin.bypass } }], 'Bypass');
        }}
      >
        <Power size={10} />
      </button>
      <span className="grow">{def?.name ?? plugin.type}</span>
    </div>
  );
}

function movePlugin(target: string, id: string, by: number): void {
  const p = store.get().project;
  if (!p) return;
  const list =
    target === 'master'
      ? p.master.inserts
      : (p.buses.find((b) => b.id === target)?.channel.inserts ?? [
          ...(p.tracks.find((t) => t.id === target)?.channel.inserts ?? []),
          ...(p.tracks.find((t) => t.id === target)?.midiFx ?? []),
        ]);
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return;
  apply([{ op: 'movePlugin', target, plugin: id, index: Math.max(0, i + by) }], 'Move Plugin');
}

interface StripProps {
  id: string;
  kind: 'track' | 'bus' | 'master';
  name: string;
  color: string;
  channel: Channel;
  track?: Track;
  selected?: boolean;
}

const NO_BUSES: Bus[] = [];

/**
 * One channel strip. Memoised: a song's edits leave the other strips' channel and track
 * objects as they were, so only the strip that changed is drawn again.
 */
export const Strip = memo(function Strip({ id, kind, name, color, channel, track, selected }: StripProps) {
  const buses = useApp((s) => s.project?.buses ?? NO_BUSES);
  const show = useApp((s) => s.show);
  const set = (patch: Partial<Channel>) => gestureChange([{ op: 'updateChannel', target: id, patch }]);
  // the fader takes whatever height is left; the slots above scroll when the strip is short
  const faderBox = useRef<HTMLDivElement>(null);
  const faderHeight = Math.max(56, useSize(faderBox).h - 2);
  // a tap on the strip selects its track; a scroll, a fader drag or a right-click doesn't
  const press = useRef<{ x: number; y: number } | null>(null);
  return (
    <section
      className={`strip ${kind}${selected ? ' selected' : ''}`}
      onPointerDown={(e) => {
        press.current = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
      }}
      onPointerUp={(e) => {
        const p = press.current;
        press.current = null;
        if (p && kind === 'track' && Math.hypot(e.clientX - p.x, e.clientY - p.y) < TAP) selectTrack(id);
      }}
      aria-label={`${name} channel strip`}
    >
      <div className="strip-top">
        {track?.kind === 'audio' && show.stripInstrument && (
          <div className="section">
            <span className="label">Input</span>
            <div
              className={`slot instrument${track.audioInput?.monitor ? ' monitoring' : ''}`}
              title="The input it records (the Inspector chooses it)"
            >
              <span className="grow">{inputLabel(track)}</span>
              {track.audioInput?.monitor && <Headphones size={12} />}
            </div>
          </div>
        )}
        {track && track.kind !== 'audio' && show.stripInstrument && (
          <div className="section">
            <span className="label">Instrument</span>
            <div
              className="slot instrument"
              title="Instrument: click to change"
              onClick={(e) =>
                openMenuAt(
                  e.currentTarget,
                  instrumentMenu((i) => setInstrument(id, i)),
                )
              }
            >
              <span className="grow">{instrumentLabel(track.instrument)}</span>
            </div>
          </div>
        )}
        {track && track.kind !== 'audio' && show.stripMidiFx && (
          <div className="section">
            <span className="label">MIDI FX</span>
            {track.midiFx.map((p) => (
              <PluginSlot key={p.id} target={id} plugin={p} />
            ))}
            <div
              className="slot empty"
              title="Add a MIDI effect"
              onClick={(e) => addPluginMenu(e.currentTarget, id, 'midiFx')}
            >
              +
            </div>
          </div>
        )}
        {show.stripAudioFx && (
          <div className="section">
            <span className="label">Audio FX</span>
            {channel.inserts.map((p) => (
              <PluginSlot key={p.id} target={id} plugin={p} />
            ))}
            <div
              className="slot empty"
              title="Add an effect"
              onClick={(e) => addPluginMenu(e.currentTarget, id, 'inserts')}
            >
              +
            </div>
          </div>
        )}
        {kind !== 'master' && show.stripSends && (
          <div className="section">
            <span className="label">Sends</span>
            {channel.sends.map((s) => {
              const bus = buses.find((b) => b.id === s.bus);
              return (
                <div
                  key={s.bus}
                  className="slot send drag"
                  title={`Send to ${bus?.name ?? 'bus'}: drag to set the level, right-click for more`}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    let level = s.level;
                    beginGesture('Send Level');
                    startDrag(e, {
                      onMove: (dx, dy) => {
                        level = Math.max(-60, Math.min(6, level + (dx - dy) * 0.25));
                        gestureChange([
                          {
                            op: 'updateChannel',
                            target: id,
                            patch: {
                              sends: channel.sends.map((x) =>
                                x.bus === s.bus ? { ...x, level: Math.round(level * 10) / 10 } : x,
                              ),
                            },
                          },
                        ]);
                      },
                      onEnd: endGesture,
                    });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openMenu(e.clientX, e.clientY, [
                      {
                        label: s.pre ? 'Post-fader' : 'Pre-fader',
                        onSelect: () =>
                          updateChannel(
                            id,
                            { sends: channel.sends.map((x) => (x.bus === s.bus ? { ...x, pre: !x.pre } : x)) },
                            'Send',
                          ),
                      },
                      {
                        label: 'Remove send',
                        onSelect: () =>
                          updateChannel(id, { sends: channel.sends.filter((x) => x.bus !== s.bus) }, 'Remove Send'),
                      },
                    ]);
                  }}
                >
                  <span className="grow">{bus?.name ?? 'No bus'}</span>
                  <span className="mono">{formatDb(s.level)}</span>
                </div>
              );
            })}
            <div
              className="slot empty"
              title="Send to a bus"
              onClick={(e) =>
                openMenuAt(e.currentTarget, [
                  ...buses
                    .filter((b) => b.id !== id && !channel.sends.some((s) => s.bus === b.id))
                    .map((b) => ({
                      label: b.name,
                      onSelect: () =>
                        updateChannel(
                          id,
                          { sends: [...channel.sends, { bus: b.id, level: -12, pre: false }] },
                          'Add Send',
                        ),
                    })),
                  'sep' as const,
                  {
                    label: 'New bus…',
                    // the bus and its send are one step, so undo takes both back together
                    onSelect: () => addBusWithSend(id, `Bus ${buses.length + 1}`, -12),
                  },
                ])
              }
            >
              +
            </div>
          </div>
        )}
      </div>
      {kind !== 'master' && show.stripStage && (
        <div className="section">
          <span className="label">Stage</span>
          {channel.stage ? (
            <div
              className="slot send drag"
              title="Stage: drag to move it nearer or further back, click for its seats, right-click for more"
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                const stage = channel.stage as Stage;
                let d = stage.distance;
                // a tap opens the seats; the distance only moves once the finger has clearly dragged
                let tx = 0;
                let ty = 0;
                let moved = false;
                beginGesture('Distance');
                startDrag(e, {
                  onMove: (dx, dy) => {
                    tx += dx;
                    ty += dy;
                    if (!moved && Math.hypot(tx, ty) < TAP) return;
                    moved = true;
                    d = Math.max(0, Math.min(1, d + (dx - dy) * 0.004));
                    gestureChange([
                      {
                        op: 'updateChannel',
                        target: id,
                        patch: { stage: { ...stage, distance: Math.round(d * 1000) / 1000 } },
                      },
                    ]);
                  },
                  onEnd: (cancelled) => {
                    endGesture();
                    // a scroll that began on the slot is cancelled by the browser: not a tap
                    if (!moved && !cancelled) store.set({ stage: id });
                  },
                });
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu(e.clientX, e.clientY, [
                  { label: 'Seats…', onSelect: () => store.set({ stage: id }) },
                  {
                    label: 'Take it off the stage',
                    onSelect: () => updateChannel(id, { stage: null }, 'Remove Stage'),
                  },
                ]);
              }}
            >
              <span className="grow">Distance</span>
              <span className="mono">{Math.round(channel.stage.distance * 100)}%</span>
            </div>
          ) : (
            <div
              className="slot empty"
              title="Put it on a stage: a near and a far seat, each with its own rooms, and a distance between them"
              onClick={() => {
                updateChannel(id, { stage: newStage() }, 'Stage');
                store.set({ stage: id });
              }}
            >
              +
            </div>
          )}
        </div>
      )}
      {kind !== 'master' && show.stripOutput && (
        <select
          className="select strip-output"
          value={channel.output || 'master'}
          aria-label="Output"
          title="Output"
          onChange={(e) => updateChannel(id, { output: e.target.value }, 'Output')}
        >
          <option value="master">Stereo Out</option>
          {buses
            .filter((b) => b.id !== id)
            .map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
        </select>
      )}
      <div className={`strip-pan${show.stripPan ? '' : ' off'}`}>
        <PanKnob
          value={channel.pan}
          onBegin={() => beginGesture('Pan')}
          onEnd={endGesture}
          onChange={(v) => set({ pan: v })}
        />
      </div>
      <div className="db-readout">{formatDb(channel.volume)}</div>
      <div className="strip-fader" ref={faderBox}>
        <Fader
          db={channel.volume}
          height={faderHeight}
          label={`${name} volume`}
          onBegin={() => beginGesture('Volume')}
          onEnd={endGesture}
          onChange={(v) => set({ volume: v })}
        />
        <Meter id={id} height={Math.max(40, faderHeight - 8)} width={12} />
      </div>
      <div className="strip-chips">
        {kind !== 'master' && (
          <>
            <button
              type="button"
              className={`chip mute${channel.mute ? ' on' : ''}`}
              onClick={() => updateChannel(id, { mute: !channel.mute }, 'Mute')}
            >
              M
            </button>
            {kind === 'track' && (
              <button
                type="button"
                className={`chip solo${channel.solo ? ' on' : ''}`}
                onClick={() => updateChannel(id, { solo: !channel.solo }, 'Solo')}
              >
                S
              </button>
            )}
          </>
        )}
        {track && (
          <button
            type="button"
            className={`chip rec${track.armed ? ' on' : ''}`}
            onClick={() => updateTrack(id, { armed: !track.armed }, 'Arm')}
          >
            R
          </button>
        )}
      </div>
      <div className="strip-name" style={{ background: color }} title={name}>
        {name}
      </div>
    </section>
  );
});

/** The editor pane's height the mixer wants at least: its slots, a fader and the name, all in view. */
const MIXER_PANE = 420;

export function Mixer() {
  // the slices are stable while something else changes, so an edit redraws one strip, not the row
  const tracks = useApp((s) => s.project?.tracks);
  const buses = useApp((s) => s.project?.buses);
  const master = useApp((s) => s.project?.master);
  const selected = useApp((s) => s.selectedTrack);
  const phone = isPhone(useLayout());
  // in the editor pane (not a phone's own tab) the mixer opens tall enough to use
  useEffect(() => {
    if (phone) return;
    store.set((s) => ({ editorHeight: Math.max(s.editorHeight, Math.min(MIXER_PANE, window.innerHeight - 180)) }));
  }, [phone]);
  if (!tracks || !buses || !master) return null;
  return (
    <div className="mixer">
      {tracks.map((t) => (
        <Strip
          key={t.id}
          id={t.id}
          kind="track"
          name={t.name}
          color={t.color}
          channel={t.channel}
          track={t}
          selected={t.id === selected}
        />
      ))}
      {buses.map((b) => (
        <Strip key={b.id} id={b.id} kind="bus" name={b.name} color={b.color} channel={b.channel} />
      ))}
      <Strip id="master" kind="master" name="Stereo Out" color="#e9d8b4" channel={master} />
    </div>
  );
}

// ---- plugin windows ----

/** The EQ's curve: the same filters as the engine, evaluated across the spectrum. */
function eqResponse(params: Record<string, number>, freqs: Float64Array, sr = 48000): Float64Array {
  const v = (id: string) => paramValue('eq', params, id);
  const out = new Float64Array(freqs.length);
  const bands: { kind: string; f: number; q: number; g: number; order?: number }[] = [];
  if (v('hpOn') >= 0.5) bands.push({ kind: 'hp', f: v('hpFreq'), q: Math.SQRT1_2, g: 0, order: 2 });
  bands.push({ kind: 'ls', f: v('lsFreq'), q: Math.SQRT1_2, g: v('lsGain') });
  bands.push({ kind: 'pk', f: v('b1Freq'), q: v('b1Q'), g: v('b1Gain') });
  bands.push({ kind: 'pk', f: v('b2Freq'), q: v('b2Q'), g: v('b2Gain') });
  bands.push({ kind: 'pk', f: v('b3Freq'), q: v('b3Q'), g: v('b3Gain') });
  bands.push({ kind: 'hs', f: v('hsFreq'), q: Math.SQRT1_2, g: v('hsGain') });
  if (v('lpOn') >= 0.5) bands.push({ kind: 'lp', f: v('lpFreq'), q: Math.SQRT1_2, g: 0, order: 2 });
  for (const b of bands) {
    const w0 = (2 * Math.PI * b.f) / sr;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * b.q);
    const A = 10 ** (b.g / 40);
    let b0 = 1;
    let b1 = 0;
    let b2 = 0;
    let a0 = 1;
    let a1 = 0;
    let a2 = 0;
    if (b.kind === 'pk') {
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
    } else if (b.kind === 'ls' || b.kind === 'hs') {
      const s = 2 * Math.sqrt(A) * alpha;
      const sign = b.kind === 'ls' ? 1 : -1;
      b0 = A * (A + 1 - sign * (A - 1) * cos + s);
      b1 = sign * 2 * A * (A - 1 - sign * (A + 1) * cos);
      b2 = A * (A + 1 - sign * (A - 1) * cos - s);
      a0 = A + 1 + sign * (A - 1) * cos + s;
      a1 = -sign * 2 * (A - 1 + sign * (A + 1) * cos);
      a2 = A + 1 + sign * (A - 1) * cos - s;
    } else if (b.kind === 'hp') {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
    } else {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
    }
    freqs.forEach((f, i) => {
      const w = (2 * Math.PI * f) / sr;
      const cr = (x: number) => Math.cos(x);
      const sr2 = (x: number) => Math.sin(x);
      const nr = b0 + b1 * cr(-w) + b2 * cr(-2 * w);
      const ni = b1 * sr2(-w) + b2 * sr2(-2 * w);
      const dr = a0 + a1 * cr(-w) + a2 * cr(-2 * w);
      const di = a1 * sr2(-w) + a2 * sr2(-2 * w);
      const mag = Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
      out[i] = (out[i] as number) + 20 * Math.log10(mag) * (b.order ?? 1);
    });
  }
  out.forEach((v2, i) => {
    out[i] = v2 + v('output');
  });
  return out;
}

/** Parametric EQ's bands, each in its own colour (the curve's handles and the strip below it). */
const PEQ_COLORS = ['#ff7a7a', '#ffaa5c', '#ffd75e', '#7ee08a', '#4fd6c0', '#5cb8ff', '#a58bff', '#ff8cc6'];
/** The band types a gain means something for: Low Shelf, Bell, High Shelf. */
const PEQ_GAINED = new Set([2, 3, 6]);

/** Either EQ's curve, in dB, from the coefficients its engine runs. */
function curveOf(type: string, params: Record<string, number>, freqs: Float64Array, sr: number): Float64Array {
  if (type !== 'peq') return eqResponse(params, freqs, sr);
  const out = paramValue('peq', params, 'output');
  return bandsResponse(peqBands(params), freqs, sr).map((v) => v + out);
}

const EQ_H = 150;
const eqX = (f: number, width: number) => (Math.log(f / 20) / Math.log(1000)) * width;
const eqY = (db: number) => EQ_H / 2 - (db / 24) * (EQ_H / 2 - 8);

/** Where a Parametric EQ's band handles sit on its curve (a cut's, notch's or band pass's on the 0 dB line). */
function peqHandles(type: string, params: Record<string, number>, width: number) {
  const out: { band: number; x: number; y: number; on: boolean }[] = [];
  if (type !== 'peq') return out;
  for (let b = 1; b <= PEQ_BANDS; b++) {
    const kind = Math.round(paramValue('peq', params, `t${b}`));
    const gain = PEQ_GAINED.has(kind) ? paramValue('peq', params, `g${b}`) : 0;
    out.push({ band: b, x: eqX(paramValue('peq', params, `f${b}`), width), y: eqY(gain), on: kind > 0 });
  }
  return out;
}

function EqDisplay({
  type = 'eq',
  params,
  width,
  onBand,
}: {
  type?: string;
  params: Record<string, number>;
  width: number;
  /** A Parametric EQ's band handle dragged: its new frequency and gain. */
  onBand?: { begin: (band: number) => void; move: (band: number, freq: number, gain: number) => void; end: () => void };
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const h = EQ_H;
  useLayoutEffect(() => {
    const ctx = prepare(ref.current, width, h);
    if (!ctx) return;
    const n = 220;
    const freqs = new Float64Array(n).map((_, i) => 20 * 1000 ** (i / (n - 1)));
    const resp = curveOf(type, params, freqs, engine.sampleRate);
    const x = (f: number) => eqX(f, width);
    const y = eqY;
    ctx.fillStyle = '#07090b';
    ctx.fillRect(0, 0, width, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x(f)) + 0.5, 0);
      ctx.lineTo(Math.round(x(f)) + 0.5, h);
      ctx.stroke();
    }
    for (const d of [-12, 0, 12]) {
      ctx.strokeStyle = d === 0 ? 'rgba(92,184,255,0.25)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y(d)) + 0.5);
      ctx.lineTo(width, Math.round(y(d)) + 0.5);
      ctx.stroke();
    }
    ctx.fillStyle = '#4f7d8c';
    ctx.font = '600 9.5px Inter Variable, system-ui, sans-serif';
    for (const [f, label] of [
      [100, '100'],
      [1000, '1k'],
      [10000, '10k'],
    ] as const)
      ctx.fillText(label, x(f) + 3, h - 4);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(92,184,255,0.35)');
    g.addColorStop(1, 'rgba(92,184,255,0.02)');
    ctx.beginPath();
    resp.forEach((db, i) => {
      const px = (i / (n - 1)) * width;
      const py = y(Math.max(-30, Math.min(30, db)));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.strokeStyle = '#a6ecff';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(166,236,255,0.6)';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.lineTo(width, h / 2);
    ctx.lineTo(0, h / 2);
    ctx.fillStyle = g;
    ctx.fill();
    for (const hd of peqHandles(type, params, width)) {
      if (!hd.on) continue;
      ctx.beginPath();
      ctx.arc(hd.x, hd.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = PEQ_COLORS[hd.band - 1] ?? '#fff';
      ctx.fill();
      ctx.strokeStyle = '#07090b';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#07090b';
      ctx.font = '700 9.5px Inter Variable, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(hd.band), hd.x, hd.y + 3.5);
      ctx.textAlign = 'start';
    }
  }, [params, width, type]);
  return (
    <canvas
      ref={ref}
      style={{ display: 'block', width, height: h, cursor: onBand ? 'pointer' : undefined, touchAction: 'none' }}
      onPointerDown={(e) => {
        if (!onBand) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        let best: { band: number; x: number; y: number } | null = null;
        let dist = 14;
        for (const hd of peqHandles(type, params, width)) {
          const d = Math.hypot(hd.x - px, hd.y - py);
          if (hd.on && d < dist) {
            best = hd;
            dist = d;
          }
        }
        if (!best) return;
        const band = best;
        let bx = band.x;
        let by = band.y;
        startDrag(e, {
          onStart: () => onBand.begin(band.band),
          onMove: (dx, dy) => {
            bx = Math.max(0, Math.min(width, bx + dx));
            by = Math.max(8, Math.min(h - 8, by + dy));
            const freq = 20 * 1000 ** (bx / width);
            const gain = ((h / 2 - by) / (h / 2 - 8)) * 24;
            onBand.move(band.band, Math.round(freq * 10) / 10, Math.round(gain * 10) / 10);
          },
          onEnd: onBand.end,
        });
      }}
    />
  );
}

/** Parametric EQ's eight bands, side by side: each one's type, and its frequency, gain and Q. */
function PeqBands({
  def,
  params,
  change,
  set,
}: {
  def: PluginDef;
  params: Record<string, number>;
  change: (param: string, value: number) => void;
  set: (param: string, value: number, label: string) => void;
}) {
  const param = (id: string) => def.params.find((p) => p.id === id);
  return (
    <div className="peq-bands">
      {Array.from({ length: PEQ_BANDS }, (_, i) => {
        const b = i + 1;
        const kind = Math.round(paramValue('peq', params, `t${b}`));
        const on = kind > 0;
        return (
          <div key={b} className={`peq-band${on ? '' : ' off'}`}>
            <span className="peq-num" style={{ background: PEQ_COLORS[i] }}>
              {b}
            </span>
            <select
              className="select"
              value={kind}
              aria-label={`Band ${b} type`}
              onChange={(e) => set(`t${b}`, Number(e.target.value), `Band ${b} Type`)}
            >
              {PEQ_TYPES.map((t, k) => (
                <option key={t} value={k}>
                  {t}
                </option>
              ))}
            </select>
            {(['f', 'g', 'q'] as const).map((k) => {
              const p = param(`${k}${b}`);
              if (!p) return null;
              const dim = !on || (k === 'g' && !PEQ_GAINED.has(kind));
              return (
                <div key={k} className={`peq-knob${dim ? ' dim' : ''}`}>
                  <Knob
                    def={p}
                    value={paramValue('peq', params, p.id)}
                    size={30}
                    label={k === 'f' ? 'Freq' : k === 'g' ? 'Gain' : 'Q'}
                    onBegin={() => beginGesture(`Parametric EQ: ${p.name}`)}
                    onEnd={endGesture}
                    onChange={(v) => change(p.id, v)}
                    color={PEQ_COLORS[i]}
                  />
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function GainReduction({ target, plugin }: { target: string; plugin: string }) {
  const bar = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  // this plugin's own reduction, not the channel's deepest (a gate beside a compressor would show)
  useEffect(() => engine.watchPlugin(target, plugin), [target, plugin]);
  // written to a tenth of a dB, and only when that changes: a steady reading costs no layout
  const shown = useRef(Number.NaN);
  useFrame(() => {
    const gr = Math.round(engine.pluginGr(target) * 10) / 10;
    if (gr === shown.current) return;
    shown.current = gr;
    if (bar.current) bar.current.style.width = `${Math.min(100, (-gr / 30) * 100)}%`;
    if (text.current) text.current.textContent = `${gr.toFixed(1)} dB`;
  });
  return (
    <div className="gr">
      <div className="gr-head">
        <span className="label gr-label">Gain reduction</span>
        <span ref={text} className="mono gr-value" />
      </div>
      <div className="gr-track">
        <div ref={bar} className="gr-bar" />
      </div>
    </div>
  );
}

/** The window's size, so a floating window stays on screen when it changes (a window resized, a phone turned). */
function useViewport(): { w: number; h: number } {
  const [v, setV] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () =>
      setV((s) =>
        s.w === window.innerWidth && s.h === window.innerHeight ? s : { w: window.innerWidth, h: window.innerHeight },
      );
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('orientationchange', on);
    };
  }, []);
  return v;
}

/**
 * A plugin's or a stage's window: it floats where it was put (its header drags it), and on a
 * phone it is a sheet up from the bottom, with a scrim behind it that closes it. Keyed by what
 * it shows, so a new one opens centred and takes the keyboard; closing gives the keyboard back.
 */
function Floating({
  width,
  phone,
  className,
  label,
  header,
  onClose,
  children,
}: {
  width: number;
  phone: boolean;
  className?: string;
  label: string;
  header: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const vp = useViewport();
  const win = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => ({
    x: Math.max(8, window.innerWidth / 2 - width / 2),
    y: Math.max(60, window.innerHeight / 2 - 220),
  }));
  useEffect(() => {
    const before = document.activeElement;
    win.current?.focus({ preventScroll: true });
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  // kept on screen however the window was left (a smaller window, a phone turned)
  const left = Math.max(0, Math.min(vp.w - 120, pos.x));
  const top = Math.max(0, Math.min(vp.h - 40, pos.y));
  return (
    <>
      {phone && <button type="button" className="sheet-scrim" aria-label="Close" tabIndex={-1} onClick={onClose} />}
      <div
        ref={win}
        className={`plugin-window${phone ? ' sheet' : ''}${className ? ` ${className}` : ''}`}
        style={phone ? undefined : { left, top, width }}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          onClose();
        }}
      >
        <header
          onPointerDown={(e) => {
            if (phone || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
            const el = win.current;
            if (!el) return;
            // the window follows the pointer as a transform, and its place is kept once it's let go
            let tx = 0;
            let ty = 0;
            startDrag(e, {
              onMove: (dx, dy) => {
                tx += dx;
                ty += dy;
                el.style.transform = `translate(${tx}px, ${ty}px)`;
              },
              onEnd: () => {
                el.style.transform = '';
                setPos({ x: left + tx, y: top + ty });
              },
            });
          }}
        >
          {header}
        </header>
        <div className="plugin-body">{children}</div>
      </div>
    </>
  );
}

export function PluginWindow() {
  const open = useApp((s) => s.plugin);
  const project = useApp((s) => s.project);
  const layout = useLayout();
  const phone = isPhone(layout);
  const vp = useViewport();
  if (!open || !project) return null;
  const { target, id } = open;
  const owner =
    target === 'master'
      ? { name: 'Stereo Out', list: project.master.inserts }
      : (() => {
          const bus = project.buses.find((b) => b.id === target);
          if (bus) return { name: bus.name, list: bus.channel.inserts };
          const t = project.tracks.find((x) => x.id === target);
          return t ? { name: t.name, list: [...t.midiFx, ...t.channel.inserts] } : null;
        })();
  const plugin = owner?.list.find((p) => p.id === id);
  const def = plugin ? pluginDef(plugin.type) : undefined;
  if (!owner || !plugin || !def) return null;
  // Parametric EQ's eight bands want more room than a row of knobs
  const width = phone ? vp.w : plugin.type === 'peq' ? 600 : 460;
  const change = (param: string, value: number) =>
    gestureChange([{ op: 'updatePlugin', target, plugin: id, patch: { params: { [param]: value } } } satisfies Op]);
  const close = () => store.set({ plugin: null });
  return (
    <Floating
      key={id}
      width={width}
      phone={phone}
      label={def.name}
      onClose={close}
      header={
        <>
          <button
            type="button"
            className={`btn icon power${plugin.bypass ? '' : ' on'}`}
            title={plugin.bypass ? 'Turn on' : 'Bypass'}
            aria-label={plugin.bypass ? 'Turn on' : 'Bypass'}
            onClick={() =>
              apply([{ op: 'updatePlugin', target, plugin: id, patch: { bypass: !plugin.bypass } }], 'Bypass')
            }
          >
            <Power />
          </button>
          <span className="name">{def.name}</span>
          <span className="muted">{owner.name}</span>
          <button type="button" className="btn ghost icon" title="Close" aria-label="Close" onClick={close}>
            <X />
          </button>
        </>
      }
    >
      {plugin.type === 'eq' && (
        <div className="display">
          <EqDisplay params={plugin.params} width={width - 30} />
        </div>
      )}
      {plugin.type === 'peq' && (
        <div className="display">
          <EqDisplay
            type="peq"
            params={plugin.params}
            width={width - 30}
            onBand={{
              begin: (b) => beginGesture(`Parametric EQ: Band ${b}`),
              move: (b, freq, gain) => {
                const kind = Math.round(paramValue('peq', plugin.params, `t${b}`));
                const params: Record<string, number> = { [`f${b}`]: Math.min(22000, Math.max(10, freq)) };
                if (PEQ_GAINED.has(kind)) params[`g${b}`] = Math.min(30, Math.max(-30, gain));
                gestureChange([{ op: 'updatePlugin', target, plugin: id, patch: { params } } satisfies Op]);
              },
              end: endGesture,
            }}
          />
        </div>
      )}
      {plugin.type === 'peq' && (
        <PeqBands
          def={def}
          params={plugin.params}
          change={change}
          set={(param, value, label) =>
            apply([{ op: 'updatePlugin', target, plugin: id, patch: { params: { [param]: value } } }], label)
          }
        />
      )}
      {(plugin.type === 'compressor' || plugin.type === 'limiter' || plugin.type === 'gate') && (
        <div className="display">
          <GainReduction target={target} plugin={plugin.id} />
        </div>
      )}
      {(plugin.type === 'space' || plugin.type === 'shimmer') && <SpacePicker target={target} plugin={plugin} />}
      {plugin.type === 'wow' && plugin.settings?.curve && <WowDrift target={target} plugin={plugin} />}
      <div className="face">
        {def.params
          .filter((p) => plugin.type !== 'peq' || p.id === 'output')
          .filter(
            (p) =>
              (plugin.type !== 'space' && plugin.type !== 'shimmer') || spaceKnob(plugin.type, p.id, plugin.params),
          )
          // a drift curve stands in for every generated setting
          .filter(() => plugin.type !== 'wow' || !plugin.settings?.curve)
          .map((p) =>
            p.options && p.options.length <= 3 ? (
              <div key={p.id} className="knob choice">
                <button
                  type="button"
                  className={`btn${paramValue(def.type, plugin.params, p.id) >= 0.5 ? ' on' : ''}`}
                  onClick={() =>
                    apply(
                      [
                        {
                          op: 'updatePlugin',
                          target,
                          plugin: id,
                          patch: {
                            params: {
                              [p.id]:
                                (Math.round(paramValue(def.type, plugin.params, p.id)) + 1) % (p.options?.length ?? 2),
                            },
                          },
                        },
                      ],
                      p.name,
                    )
                  }
                >
                  {p.options[Math.round(paramValue(def.type, plugin.params, p.id))]}
                </button>
                <span className="knob-label">{p.name}</span>
              </div>
            ) : (
              <Knob
                key={p.id}
                def={p}
                value={paramValue(def.type, plugin.params, p.id)}
                onBegin={() => beginGesture(`${def.name}: ${p.name}`)}
                onEnd={endGesture}
                onChange={(v) => change(p.id, v)}
                color={def.kind === 'midi' ? 'var(--ai)' : 'var(--accent)'}
              />
            ),
          )}
      </div>
      <div className="muted plugin-note">{def.description}</div>
    </Floating>
  );
}

/** A new stage: close (a little room) and far back (the hall), at the near seat; sends added in its window. */
function newStage(): Stage {
  return { distance: 0, near: { depth: 0.12, sends: [] }, far: { depth: 0.85, sends: [] } };
}

// shown in percent; the stage keeps them as 0–1
const DISTANCE: ParamDef = { id: 'distance', name: 'Distance', min: 0, max: 100, default: 0, unit: '%' };
const DEPTH: ParamDef = { id: 'depth', name: 'Depth', min: 0, max: 100, default: 50, unit: '%' };
const SEAT_SEND: ParamDef = { id: 'level', name: 'Level', min: -60, max: 6, default: -12, unit: 'dB' };

/** A stage's seats, and the distance between them. */
export function StageWindow() {
  const target = useApp((s) => s.stage);
  const project = useApp((s) => s.project);
  const layout = useLayout();
  const phone = isPhone(layout);
  if (!target || !project) return null;
  const owner = project.tracks.find((t) => t.id === target) ?? project.buses.find((b) => b.id === target) ?? null;
  const stage = owner?.channel.stage;
  if (!owner || !stage) return null;
  const setStage = (next: Stage) => gestureChange([{ op: 'updateChannel', target, patch: { stage: next } }]);
  const applyStage = (next: Stage, label: string) => updateChannel(target, { stage: next }, label);
  const seat = (which: 'near' | 'far') => {
    const s = stage[which];
    const put = (next: Seat) => ({ ...stage, [which]: next });
    const unsent = project.buses.filter((b) => b.id !== target && !s.sends.some((x) => x.bus === b.id));
    return (
      <div className="stage-seat">
        <span className="label">{which === 'near' ? 'Near seat' : 'Far seat'}</span>
        <Knob
          def={DEPTH}
          value={s.depth * 100}
          label="Depth"
          onBegin={() => beginGesture(`Stage: ${which === 'near' ? 'Near' : 'Far'} Depth`)}
          onEnd={endGesture}
          onChange={(v) => setStage(put({ ...s, depth: Math.round(v * 10) / 1000 }))}
        />
        {s.sends.map((x) => (
          <div key={x.bus} className="stage-send">
            <span className="grow">{project.buses.find((b) => b.id === x.bus)?.name ?? 'No bus'}</span>
            <Knob
              def={SEAT_SEND}
              value={x.level}
              size={30}
              compact
              onBegin={() => beginGesture('Stage: Send')}
              onEnd={endGesture}
              onChange={(v) =>
                setStage(
                  put({
                    ...s,
                    sends: s.sends.map((y) => (y.bus === x.bus ? { ...y, level: Math.round(v * 10) / 10 } : y)),
                  }),
                )
              }
            />
            <span className="mono">{formatDb(x.level)}</span>
            <button
              type="button"
              className="btn ghost icon"
              title="Remove this send"
              onClick={() =>
                applyStage(put({ ...s, sends: s.sends.filter((y) => y.bus !== x.bus) }), 'Stage: Remove Send')
              }
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn"
          disabled={!unsent.length}
          onClick={(e) =>
            openMenuAt(
              e.currentTarget,
              unsent.map((b) => ({
                label: b.name,
                onSelect: () =>
                  applyStage(put({ ...s, sends: [...s.sends, { bus: b.id, level: -12 }] }), 'Stage: Add Send'),
              })),
            )
          }
        >
          Send to a room…
        </button>
      </div>
    );
  };
  const close = () => store.set({ stage: null });
  return (
    <Floating
      key={target}
      width={460}
      phone={phone}
      className="stage-window"
      label="Stage"
      onClose={close}
      header={
        <>
          <span className="name">Stage</span>
          <span className="muted">{owner.name}</span>
          <button type="button" className="btn ghost icon" title="Close" aria-label="Close" onClick={close}>
            <X />
          </button>
        </>
      }
    >
      <div className="stage-distance">
        <span className="muted">Near</span>
        <Knob
          def={DISTANCE}
          value={stage.distance * 100}
          size={54}
          onBegin={() => beginGesture('Stage: Distance')}
          onEnd={endGesture}
          onChange={(v) => setStage({ ...stage, distance: Math.round(v * 10) / 1000 })}
        />
        <span className="muted">Far</span>
      </div>
      <div className="stage-seats">
        {seat('near')}
        {seat('far')}
      </div>
      <div className="muted plugin-note">
        Distance moves the sound between its seats at equal power (and can be automated). Depth sets a seat back: its
        direct sound darker and quieter. The seats’ sends are the sound as it reaches them, so further back is wetter.
      </div>
    </Floating>
  );
}

/** A Wow & Flutter following a drift curve in the song's files (a creation's own), and the way back to its own. */
function WowDrift({ target, plugin }: { target: string; plugin: Plugin }) {
  const files = useApp((s) => s.project?.files);
  const id = plugin.settings?.curve ?? '';
  const name = files?.find((f) => f.id === id)?.name ?? id;
  return (
    <div className="display space-picker">
      <span>
        <span className="label">Drift</span> follows the song’s curve <strong>{name}</strong>, exactly as it was made.
      </span>
      <button
        type="button"
        className="btn"
        onClick={() =>
          apply([{ op: 'updatePlugin', target, plugin: plugin.id, patch: { settings: { curve: '' } } }], 'Drift')
        }
      >
        Generate its own instead
      </button>
    </div>
  );
}

/** Space Designer's (or Shimmer's) space: a generated one, or a pack's response file. */
function SpacePicker({ target, plugin }: { target: string; plugin: Plugin }) {
  const packs = useSyncExternalStore(
    (fn) => library.subscribe(fn),
    () => library.packs,
  );
  const space = Math.round(paramValue(plugin.type, plugin.params, 'space'));
  const files = packs.flatMap((p) =>
    (p.impulses ?? []).map((i) => ({ key: `${p.id}/${i.name}`, title: i.title, pack: p.name })),
  );
  const set = (patch: { params?: Record<string, number>; settings?: Record<string, string> }, label: string) =>
    apply([{ op: 'updatePlugin', target, plugin: plugin.id, patch }], label);
  return (
    <div className="display space-picker">
      <label className="hstack">
        <span className="label">Space</span>
        <select
          className="select"
          value={space}
          onChange={(e) => set({ params: { space: Number(e.target.value) } }, 'Space')}
        >
          {SPACE_NAMES.map((n, i) => (
            <option key={n} value={i}>
              {n.replace(/\b\w/g, (c) => c.toUpperCase())}
            </option>
          ))}
          <option value={SPACE_FILE}>From a file…</option>
        </select>
      </label>
      {space >= SPACE_FILE && (
        <label className="hstack">
          <span className="label">Response</span>
          <select
            className="select"
            value={plugin.settings?.ir ?? ''}
            onChange={(e) => set({ settings: { ir: e.target.value } }, 'Impulse Response')}
          >
            <option value="">{files.length ? 'Choose a response' : 'No pack has responses yet'}</option>
            {files.map((f) => (
              <option key={f.key} value={f.key}>
                {f.title} ({f.pack})
              </option>
            ))}
          </select>
        </label>
      )}
      <span className="muted plugin-hint">
        {space >= SPACE_FILE
          ? 'A recorded or exported response, played as it is.'
          : 'Generated to a design: Variation picks another room of the same kind, Decay scales how long it rings.'}
      </span>
    </div>
  );
}

/** Space Designer's and Shimmer's knobs: the space has its own menu, and a file's response has no variation or decay. */
function spaceKnob(type: string, id: string, params: Record<string, number>): boolean {
  if (id === 'space') return false;
  const file = Math.round(paramValue(type, params, 'space')) >= SPACE_FILE;
  return !(file && (id === 'seed' || id === 'decay'));
}
