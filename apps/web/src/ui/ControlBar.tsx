/** The control bar: views, the transport, the display (position, time, tempo, signature, key) and status. */
import { formatBarBeat, KEYS, type MeterPoint, tickToSeconds } from '@holo/session';
import {
  Bot,
  Circle,
  FastForward,
  Keyboard,
  Library,
  Maximize2,
  Metronome,
  Minimize2,
  PanelLeft,
  Piano,
  Play,
  Redo2,
  Repeat,
  Rewind,
  Settings,
  SkipBack,
  SlidersVertical,
  Smartphone,
  Square,
  Undo2,
  Usb,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  apply,
  beginGesture,
  endGesture,
  gestureChange,
  locate,
  moveBars,
  redo,
  stop,
  toggleCycle,
  toggleFullscreen,
  toggleMetronome,
  togglePlay,
  toggleRecord,
  undo,
} from '../app/actions.ts';
import { TYPING_PORT } from '../app/keys.ts';
import { isPhone, useLayout } from '../app/layout.ts';
import { store, useApp, useShow } from '../app/store.ts';
import { engine } from '../audio/engine.ts';
import { midi } from '../audio/midi.ts';
import { startDrag, Wordmark } from './controls.tsx';
import { useFrame } from './frame.ts';
import { openMenuAt } from './menu.tsx';
import { ViewMenu } from './ViewMenu.tsx';

/** "9 1 1 7" as "  9 1 1   7": every digit keeps its place while the song plays. */
function padPosition(text: string): string {
  const [bar = '', beat = '', div = '', tick] = text.split(' ');
  const head = `${bar.padStart(3)} ${beat} ${div}`;
  return tick === undefined ? head : `${head} ${tick.padStart(3)}`;
}

function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rest.toFixed(1).padStart(4, '0')}`;
}

const SIGNATURES: [number, number, number[]?][] = [
  [4, 4],
  [4, 4, [3, 3, 2]],
  [3, 4],
  [2, 4],
  [5, 4],
  [6, 8],
  [7, 8, [2, 2, 3]],
  [9, 8],
  [12, 8],
];

export function Lcd({ compact = false }: { compact?: boolean }) {
  const project = useApp((s) => s.project);
  const showTime = useShow('barTime');
  const showSig = useShow('barSig');
  const showKey = useShow('barKey');
  const pos = useRef<HTMLSpanElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const [editingTempo, setEditingTempo] = useState(false);
  useFrame(() => {
    const p = store.get().project;
    if (!p) return;
    const tick = engine.positionTick();
    if (pos.current) {
      const text = padPosition(tick < 0 ? `-${formatBarBeat(p.meter, 0)}` : formatBarBeat(p.meter, tick, !compact));
      if (pos.current.textContent !== text) pos.current.textContent = text;
    }
    if (time.current) {
      const text = formatTime(tickToSeconds(p.tempo, Math.max(0, tick)));
      if (time.current.textContent !== text) time.current.textContent = text;
    }
  });
  if (!project) return <div className="lcd" />;
  const bpm = project.tempo[0]?.bpm ?? 120;
  const m = project.meter[0] as MeterPoint;
  const setBpm = (v: number) => {
    const tempo = project.tempo.map((t, i) =>
      i === 0 ? { ...t, bpm: Math.round(Math.max(20, Math.min(400, v)) * 100) / 100 } : t,
    );
    return [{ op: 'setProject' as const, patch: { tempo } }];
  };
  return (
    <section className={`lcd${compact ? ' compact' : ''}`} aria-label="Song position and tempo">
      <div
        onDoubleClick={() => locate(0)}
        title="Position (bar, beat, division, tick). Double-click: go to the beginning"
      >
        <span className="value pos" ref={pos} />
        <span className="caption">{compact ? 'position' : 'bar beat div tick'}</span>
      </div>
      {!compact && showTime && (
        <div className="lcd-time" title="Time">
          <span className="value small time" ref={time} />
          <span className="caption">time</span>
        </div>
      )}
      <div
        className="editable"
        title="Tempo: drag up or down, double-click to type"
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).tagName === 'INPUT') return;
          let v = store.get().project?.tempo[0]?.bpm ?? 120;
          beginGesture('Tempo');
          startDrag(e, {
            onMove: (dx, dy, ev) => {
              v += (dx - dy) * (ev.shiftKey ? 0.05 : 0.5);
              gestureChange(setBpm(v));
            },
            onEnd: endGesture,
          });
        }}
        onDoubleClick={() => setEditingTempo(true)}
      >
        {editingTempo ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: the field appears because it was double-clicked
            autoFocus
            defaultValue={String(bpm)}
            inputMode="decimal"
            aria-label="Tempo"
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setEditingTempo(false);
            }}
            onBlur={(e) => {
              const v = Number(e.currentTarget.value);
              if (v > 0 && v !== bpm) apply(setBpm(v), 'Tempo');
              setEditingTempo(false);
            }}
          />
        ) : (
          <span className="value tempo">{bpm % 1 ? bpm.toFixed(2) : bpm}</span>
        )}
        <span className="caption">tempo</span>
      </div>
      {showSig && (
        <div
          className="editable"
          style={{ cursor: 'pointer' }}
          title="Time signature"
          onClick={(e) =>
            openMenuAt(e.currentTarget, [
              { heading: 'Time signature' },
              ...SIGNATURES.map(([num, den, groups]) => ({
                label: `${num}/${den}${groups ? ` (${groups.join('+')})` : ''}`,
                checked: m.num === num && m.den === den && String(m.groups ?? '') === String(groups ?? ''),
                onSelect: () =>
                  apply(
                    [
                      {
                        op: 'setProject',
                        patch: {
                          meter: [{ tick: 0, num, den, ...(groups ? { groups } : {}) }, ...project.meter.slice(1)],
                        },
                      },
                    ],
                    'Time Signature',
                  ),
              })),
            ])
          }
        >
          <span className="value small sig">
            {m.num}/{m.den}
          </span>
          <span className="caption">{m.groups ? m.groups.join('+') : 'sig'}</span>
        </div>
      )}
      {!compact && showKey && (
        <div
          className="lcd-key"
          style={{ cursor: 'pointer' }}
          title="Key"
          onClick={(e) =>
            openMenuAt(e.currentTarget, [
              {
                label: 'No key',
                checked: !project.key,
                onSelect: () => apply([{ op: 'setProject', patch: { key: null } }], 'Key'),
              },
              { heading: 'Major' },
              ...KEYS.map((k) => ({
                label: `${k} major`,
                checked: project.key === `${k} major`,
                onSelect: () => apply([{ op: 'setProject', patch: { key: `${k} major` } }], 'Key'),
              })),
              { heading: 'Minor' },
              ...KEYS.map((k) => ({
                label: `${k} minor`,
                checked: project.key === `${k} minor`,
                onSelect: () => apply([{ op: 'setProject', patch: { key: `${k} minor` } }], 'Key'),
              })),
            ])
          }
        >
          <span className="value small key">{project.key ?? '—'}</span>
          <span className="caption">key</span>
        </div>
      )}
    </section>
  );
}

export function TransportButtons({ minimal = false }: { minimal?: boolean }) {
  const playing = useApp((s) => s.playing);
  const recording = useApp((s) => s.recording);
  const cycle = useApp((s) => s.project?.cycle.on ?? false);
  return (
    <div className="transport">
      {!minimal && (
        <>
          <button type="button" className="btn tp-nav" title="Go to the beginning (Return)" onClick={() => locate(0)}>
            <SkipBack />
          </button>
          <button type="button" className="btn tp-nav" title="Back a bar (,)" onClick={() => moveBars(-1)}>
            <Rewind />
          </button>
          <button type="button" className="btn tp-nav" title="Forward a bar (.)" onClick={() => moveBars(1)}>
            <FastForward />
          </button>
        </>
      )}
      <button type="button" className="btn" title="Stop (Space). Again: back to the beginning" onClick={() => stop()}>
        <Square fill="currentColor" />
      </button>
      <button
        type="button"
        className={`btn play${playing ? ' on' : ''}`}
        title="Play (Space)"
        onClick={() => void togglePlay()}
      >
        <Play fill="currentColor" />
      </button>
      <button
        type="button"
        className={`btn rec${recording ? ' on' : ''}`}
        title="Record (R)"
        onClick={() => void toggleRecord()}
      >
        <Circle fill="currentColor" />
      </button>
      <button type="button" className={`btn cycle${cycle ? ' on' : ''}`} title="Cycle (C)" onClick={toggleCycle}>
        <Repeat />
      </button>
    </div>
  );
}

function SaveDot() {
  const state = useApp((s) => s.saveState);
  const cls = state === 'saved' ? 'ok' : state === 'saving' || state === 'dirty' ? 'busy' : 'bad';
  const text = {
    saved: 'Saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    offline: 'Offline: will save when the server answers',
    conflict: 'Changed elsewhere',
    error: 'Couldn’t save',
  }[state];
  return <span className={`status-dot ${cls}`} title={text} role="img" aria-label={text} />;
}

function MidiLight() {
  const dot = useRef<HTMLSpanElement>(null);
  useFrame((now) => {
    let last = 0;
    for (const t of midi.lastActivity.values()) last = Math.max(last, t);
    const on = now - last < 90;
    if (dot.current) dot.current.className = `status-dot ${on ? 'flash' : store.get().midiStatus === 'on' ? 'ok' : ''}`;
  });
  return <span ref={dot} className="status-dot" />;
}

/** The audio thread's load (HO[LO] Engine's render thread's, when it plays), and the workers' when the song renders ahead, in words. */
export function dspSummary(d: ReturnType<typeof engine.dsp>): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const audio =
    `${engine.remote ? 'HO[LO] Engine’s render thread' : 'the audio thread'} ${pct(d.load)} of each ${engine.remote ? 'period' : 'block'}'s time` +
    (d.fine ? ` (peak ${pct(d.peak)}), ${d.overloads} overload${d.overloads === 1 ? '' : 's'}` : '');
  if (!d.ahead) return audio;
  const n = d.ahead.loads.length;
  return (
    `${audio}; the song plays ahead on ${n} more thread${n === 1 ? '' : 's'} (${d.ahead.loads.map(pct).join(', ')})` +
    (d.ahead.stalls
      ? `, which kept it waiting ${d.ahead.stalls} time${d.ahead.stalls === 1 ? '' : 's'} while playing`
      : '')
  );
}

/** How hard the audio thread is working: the share of each block's time the engine takes. */
export function loadColor(share: number, overloaded: boolean): string {
  if (overloaded || share >= 0.85) return 'var(--danger, #ff6b6b)';
  if (share >= 0.6) return 'var(--warn, #ffb74d)';
  return 'var(--ok, #7ee08a)';
}

function DspMeter() {
  const bar = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLButtonElement>(null);
  const seen = useRef({ overloads: 0, at: 0 });
  useFrame((now) => {
    const d = engine.dsp();
    // rendering ahead: the song keeps up while the busiest worker does (and the audio thread)
    const busiest = Math.max(0, ...(d.ahead?.loads ?? []));
    const load = Math.max(d.load, busiest);
    // an overrun (or a block the workers weren't ready with) lights the meter red for a few seconds
    const overloads = d.overloads + (d.ahead?.stalls ?? 0);
    if (overloads > seen.current.overloads) seen.current = { overloads, at: now };
    else if (overloads < seen.current.overloads) seen.current = { overloads, at: 0 };
    const hot = now - seen.current.at < 3000 && seen.current.at > 0;
    const shown = Math.max(load, d.peak);
    if (bar.current) {
      bar.current.style.width = `${Math.min(100, Math.round(shown * 100))}%`;
      bar.current.style.background = loadColor(shown, hot);
    }
    if (text.current) text.current.textContent = `${Math.round(load * 100)}%`;
    if (box.current) box.current.title = `DSP load: ${dspSummary(d)}. Audio & MIDI settings`;
  });
  return (
    <button ref={box} type="button" className="btn dsp-meter" onClick={() => store.set({ dialog: 'settings' })}>
      <span className="dsp-label">DSP</span>
      <span className="dsp-track">
        <span ref={bar} className="dsp-bar" />
      </span>
      <span ref={text} className="dsp-value mono">
        0%
      </span>
    </button>
  );
}

export function ControlBar() {
  const layout = useLayout();
  const phone = isPhone(layout);
  const title = useApp((s) => s.project?.title ?? '');
  const metronome = useApp((s) => s.metronome);
  const editor = useApp((s) => s.editor);
  const inspector = useApp((s) => s.inspector);
  const library = useApp((s) => s.library);
  const typing = useApp((s) => s.typing);
  const ports = useApp((s) => s.midiPorts.filter((p) => p.source === 'device').length);
  const agent = useApp((s) => s.peers.some((p) => p.role === 'agent'));
  const canUndo = useApp((s) => s.undo.length > 0);
  const canRedo = useApp((s) => s.redo.length > 0);
  const remotes = useApp((s) => s.peers.filter((p) => p.role === 'remote').length);
  const show = useApp((s) => s.show);
  const [full, setFull] = useState(() => document.fullscreenElement !== null);
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  if (phone) {
    return (
      <div className="control-bar">
        <div className="left">
          <div className="brand">
            <span className="mark" title="About HO[LO] Desk" onClick={() => store.set({ dialog: 'about' })}>
              <Wordmark />
            </span>
            <span className="title" onClick={() => store.set({ dialog: 'projects' })}>
              {title}
            </span>
            <SaveDot />
          </div>
        </div>
        <div className="right">
          <button type="button" className="btn ghost icon" title="Undo" disabled={!canUndo} onClick={undo}>
            <Undo2 />
          </button>
          <button type="button" className="btn ghost icon" title="Redo" disabled={!canRedo} onClick={redo}>
            <Redo2 />
          </button>
          <button
            type="button"
            className={`btn ghost icon${metronome ? ' on' : ''}`}
            title="Metronome"
            onClick={toggleMetronome}
          >
            <Metronome />
          </button>
          <ViewMenu />
          <button
            type="button"
            className="btn ghost icon"
            title="Settings"
            onClick={() => store.set({ dialog: 'settings' })}
          >
            <Settings />
          </button>
        </div>
      </div>
    );
  }

  const touch = layout === 'tablet';
  return (
    <div className="control-bar">
      <div className="left">
        <div className="brand">
          <span className="mark" title="About HO[LO] Desk" onClick={() => store.set({ dialog: 'about' })}>
            <Wordmark desk />
          </span>
          <span className="title" title="Songs (open, new, import)" onClick={() => store.set({ dialog: 'projects' })}>
            {title}
          </span>
          <SaveDot />
        </div>
        <div className="seg">
          <button
            type="button"
            className={`btn icon${library ? ' on' : ''}`}
            title="Library (Y)"
            onClick={() => store.set({ library: !library })}
          >
            <Library />
          </button>
          <button
            type="button"
            className={`btn icon${inspector ? ' on' : ''}`}
            title="Inspector (I)"
            onClick={() => store.set({ inspector: !inspector })}
          >
            <PanelLeft />
          </button>
        </div>
        {touch && (
          <div className="seg">
            <button type="button" className="btn icon" title="Undo" disabled={!canUndo} onClick={undo}>
              <Undo2 />
            </button>
            <button type="button" className="btn icon" title="Redo" disabled={!canRedo} onClick={redo}>
              <Redo2 />
            </button>
          </div>
        )}
      </div>
      <div className="hstack" style={{ gap: 10 }}>
        <TransportButtons minimal={!show.barNav} />
        <Lcd />
        {show.barMetronome && (
          <button
            type="button"
            className={`btn icon${metronome ? ' on' : ''}`}
            title="Metronome (K)"
            onClick={toggleMetronome}
          >
            <Metronome />
          </button>
        )}
      </div>
      <div className="right">
        <div className="seg">
          <button
            type="button"
            className={`btn icon${editor === 'piano' ? ' on' : ''}`}
            title="Piano Roll (P)"
            onClick={() => store.set({ editor: editor === 'piano' ? null : 'piano' })}
          >
            <Piano />
          </button>
          <button
            type="button"
            className={`btn icon${editor === 'mixer' ? ' on' : ''}`}
            title="Mixer (X)"
            onClick={() => store.set({ editor: editor === 'mixer' ? null : 'mixer' })}
          >
            <SlidersVertical />
          </button>
        </div>
        {show.barTyping && (
          <button
            type="button"
            className={`btn icon cb-optional${typing ? ' on' : ''}`}
            title="Musical Typing (Ctrl K)"
            onClick={() => {
              store.set({ typing: !typing });
              midi.addVirtualPort(TYPING_PORT, 'typing');
            }}
          >
            <Keyboard />
          </button>
        )}
        {show.barMidi && (
          <button
            type="button"
            className="btn"
            title={`MIDI: ${ports} device${ports === 1 ? '' : 's'}`}
            onClick={() => store.set({ dialog: 'settings' })}
          >
            <Usb />
            <MidiLight />
          </button>
        )}
        {show.barDsp && !phone && <DspMeter />}
        {agent && (
          <span className="btn ghost icon" title="The AI is connected" style={{ color: 'var(--ai)' }}>
            <Bot />
          </span>
        )}
        {show.barRemote && (
          <button
            type="button"
            className={`btn icon ghost${remotes ? ' on' : ''}`}
            title={remotes ? `Remote: ${remotes} connected` : 'Control from your phone (HO[LO] Remote)'}
            onClick={() => store.set({ dialog: 'remote' })}
          >
            <Smartphone />
          </button>
        )}
        {show.barFullscreen && (
          <button
            type="button"
            className="btn icon ghost cb-optional"
            title="Full screen (Ctrl Shift F)"
            onClick={toggleFullscreen}
          >
            {full ? <Minimize2 /> : <Maximize2 />}
          </button>
        )}
        <ViewMenu />
        <button
          type="button"
          className="btn icon ghost cb-optional"
          title="Audio & MIDI settings"
          onClick={() => store.set({ dialog: 'settings' })}
        >
          <Settings />
        </button>
      </div>
    </div>
  );
}
