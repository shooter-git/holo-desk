/**
 * HO[LO] Remote: the phone by your instruments, driving the studio open on another device (as Logic
 * Remote drives Logic). The display, the transport, the tracks and their faders, a keyboard and pads
 * that play into the studio, and the song's markers. It plays no sound itself.
 */
import {
  barToTick,
  formatBarBeat,
  type MeterPoint,
  secondsToTick,
  type TempoPoint,
  tickToSeconds,
} from '@holo/session';
import {
  Circle,
  FastForward,
  Flag,
  Headphones,
  Metronome,
  Music2,
  Play,
  Redo2,
  Repeat,
  Rewind,
  Rows3,
  Save,
  SkipBack,
  SlidersVertical,
  Square,
  Undo2,
} from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import {
  activeStudio,
  chooseStudio,
  command,
  levels,
  optimistic,
  type StudioState,
  type StudioTrack,
  sendMidi,
  useRemote,
} from '../app/remote.ts';
import { dbToFader, Fader, faderToDb, formatDb, Wordmark } from './controls.tsx';
import { useFrame } from './frame.ts';
import { PlayPad } from './PlayPad.tsx';

type Tab = 'tracks' | 'mixer' | 'play' | 'markers';

const TABS: [Tab, string, typeof Rows3][] = [
  ['tracks', 'Tracks', Rows3],
  ['mixer', 'Mixer', SlidersVertical],
  ['play', 'Play', Music2],
  ['markers', 'Markers', Flag],
];

const DEFAULT_TEMPO: TempoPoint[] = [{ tick: 0, bpm: 120 }];
const DEFAULT_METER: MeterPoint[] = [{ tick: 0, num: 4, den: 4 }];

/** Where the studio's playhead is now: its last report, carried on at the song's tempo while it plays. */
function liveTick(s: StudioState, at: number): number {
  if (!s.playing) return s.tick;
  const tempo = s.tempo?.length ? s.tempo : [{ tick: 0, bpm: s.bpm }];
  let t = secondsToTick(tempo, tickToSeconds(tempo, Math.max(0, s.tick)) + (Date.now() - at) / 1000);
  const c = s.cycle;
  if (c.on && c.end > c.start && s.tick < c.end && t >= c.end) t = c.start + ((t - c.end) % (c.end - c.start));
  return t;
}

/** Keep the screen on while the remote is in front (the browser lets go when it's hidden). */
function useWakeLock(): void {
  useEffect(() => {
    let lock: { release(): Promise<void> } | null = null;
    const nav = navigator as Navigator & {
      wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> };
    };
    const take = () => {
      if (document.visibilityState !== 'visible' || !nav.wakeLock) return;
      nav.wakeLock
        .request('screen')
        .then((l) => {
          lock = l;
        })
        .catch(() => undefined);
    };
    take();
    document.addEventListener('visibilitychange', take);
    return () => {
      document.removeEventListener('visibilitychange', take);
      void lock?.release().catch(() => undefined);
    };
  }, []);
}

export function Remote() {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      return (localStorage.getItem('holo:remote-tab') as Tab) || 'tracks';
    } catch {
      return 'tracks';
    }
  });
  const connection = useRemote((s) => s.connection);
  const studio = useRemote((s) => activeStudio(s));
  useWakeLock();
  useEffect(() => {
    document.title = 'HO[LO] Remote';
    // a keyboard on the remote: Space plays and stops, R records
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea') || e.ctrlKey || e.metaKey) return;
      const playing = activeStudio()?.state.playing;
      if (e.code === 'Space') command(playing ? 'stop' : 'play');
      else if (e.key === 'r') command('record');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const pick = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem('holo:remote-tab', t);
    } catch {
      // remembered for this visit only
    }
  };
  return (
    <div className="remote">
      <RemoteBar />
      {studio ? (
        <>
          <section className="remote-deck">
            {!studio.state.audio && (
              <div className="remote-banner">
                <Headphones size={15} /> The studio on <b>{studio.name}</b> hasn’t started its audio. Press{' '}
                <b>Start the studio</b> there once, then play from here.
              </div>
            )}
            <RemoteLcd />
            <RemoteTransport />
          </section>
          <main className="remote-main">
            {tab === 'tracks' && <TracksTab />}
            {tab === 'mixer' && <MixerTab />}
            {tab === 'play' && <PlayTab />}
            {tab === 'markers' && <MarkersTab />}
          </main>
        </>
      ) : (
        <div className="remote-waiting">
          <Wordmark desk />
          <p>
            {connection === 'online'
              ? 'Waiting for the studio. Open HO[LO] Desk on the computer you play through; it appears here.'
              : connection === 'offline'
                ? `Can’t reach HO[LO] on ${location.host}. Trying again…`
                : 'Connecting…'}
          </p>
        </div>
      )}
      <nav className="tabbar remote-tabs" aria-label="Remote views">
        {TABS.map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? 'active' : ''}
            aria-current={tab === id}
            onClick={() => pick(id)}
          >
            <Icon />
            {label}
          </button>
        ))}
      </nav>
      <Notice />
    </div>
  );
}

function RemoteBar() {
  const connection = useRemote((s) => s.connection);
  const names = useRemote((s) => Object.keys(s.studios).sort().join('\n'));
  const studio = useRemote((s) => activeStudio(s));
  const list = names ? names.split('\n') : [];
  const s = studio?.state;
  return (
    <header className="remote-bar">
      <span className="remote-brand">
        <Wordmark />
        <span className="remote-tag">Remote</span>
      </span>
      <span className={`status-dot ${connection === 'online' ? (studio ? 'ok' : 'wait') : 'off'}`} />
      {list.length > 1 ? (
        <select
          className="select remote-picker"
          value={studio?.name ?? ''}
          aria-label="The studio to control"
          onChange={(e) => chooseStudio(e.target.value)}
        >
          {list.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      ) : (
        <span className="remote-studio" title="The studio this remote drives">
          {studio ? `${studio.state.title ?? 'Untitled'} · ${studio.name}` : ''}
        </span>
      )}
      <span className="grow" />
      {s && (
        <>
          <button
            type="button"
            className="btn ghost icon"
            title="Undo"
            disabled={!s.canUndo}
            onClick={() => command('undo')}
          >
            <Undo2 />
          </button>
          <button
            type="button"
            className="btn ghost icon"
            title="Redo"
            disabled={!s.canRedo}
            onClick={() => command('redo')}
          >
            <Redo2 />
          </button>
          <button
            type="button"
            className={`btn ghost icon${s.saveState === 'dirty' ? ' unsaved' : ''}`}
            title={s.saveState === 'dirty' ? 'Save now' : 'Saved'}
            onClick={() => command('save')}
          >
            <Save />
          </button>
        </>
      )}
    </header>
  );
}

function RemoteLcd() {
  const studio = useRemote((s) => activeStudio(s));
  const pos = useRef<HTMLSpanElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  useFrame(() => {
    const a = activeStudio();
    if (!a) return;
    const s = a.state;
    const tick = liveTick(s, a.at);
    const meter = s.meter?.length ? s.meter : DEFAULT_METER;
    const tempo = s.tempo?.length ? s.tempo : DEFAULT_TEMPO;
    const p = tick < 0 ? '1 1 1' : formatBarBeat(meter, tick);
    if (pos.current && pos.current.textContent !== p) pos.current.textContent = p;
    const sec = tickToSeconds(tempo, Math.max(0, tick));
    const t = `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`;
    if (time.current && time.current.textContent !== t) time.current.textContent = t;
  });
  if (!studio) return null;
  const s = studio.state;
  return (
    <section className={`remote-lcd lcd${s.recording ? ' recording' : ''}`} aria-label="Song position">
      <div className="pos">
        <span className="value" ref={pos} />
        <span className="caption">{s.recording ? 'recording' : s.playing ? 'playing' : 'bar beat div'}</span>
      </div>
      <div>
        <span className="value small" ref={time} />
        <span className="caption">time</span>
      </div>
      <div>
        <span className="value small">{Math.round(s.bpm * 10) / 10}</span>
        <span className="caption">tempo</span>
      </div>
      <div className="wide-only">
        <span className="value small">{s.sig}</span>
        <span className="caption">{s.key ?? 'sig'}</span>
      </div>
    </section>
  );
}

function RemoteTransport() {
  const s = useRemote((r) => activeStudio(r)?.state);
  if (!s) return null;
  return (
    <div className="remote-transport transport">
      <button type="button" className="btn" title="Go to the beginning" onClick={() => command('toStart')}>
        <SkipBack />
      </button>
      <button type="button" className="btn" title="Back a bar" onClick={() => command('back')}>
        <Rewind />
      </button>
      <button type="button" className="btn" title="Forward a bar" onClick={() => command('forward')}>
        <FastForward />
      </button>
      <button type="button" className="btn" title="Stop (twice: to the beginning)" onClick={() => command('stop')}>
        <Square />
      </button>
      <button
        type="button"
        className={`btn play${s.playing ? ' on' : ''}`}
        title="Play"
        onClick={() => command(s.playing ? 'stop' : 'play')}
      >
        <Play />
      </button>
      <button
        type="button"
        className={`btn rec${s.recording ? ' on' : ''}`}
        title="Record"
        onClick={() => command('record')}
      >
        <Circle fill="currentColor" />
      </button>
      <button
        type="button"
        className={`btn cycle${s.cycle.on ? ' on' : ''}`}
        title="Cycle"
        onClick={() => {
          optimistic((x) => ({ ...x, cycle: { ...x.cycle, on: !x.cycle.on } }));
          command('cycle');
        }}
      >
        <Repeat />
      </button>
      <button
        type="button"
        className={`btn${s.metronome ? ' on' : ''}`}
        title="Metronome"
        onClick={() => {
          optimistic((x) => ({ ...x, metronome: !x.metronome }));
          command('metronome');
        }}
      >
        <Metronome />
      </button>
    </div>
  );
}

/** A level bar for a track (or "master") from the studio's meters. */
function LevelBar({ id, vertical = false }: { id: string; vertical?: boolean }) {
  const fill = useRef<HTMLDivElement>(null);
  const shown = useRef(0);
  useFrame(() => {
    const [l = 0, r = 0] = levels.get(id) ?? [];
    // decay here as well, between the studio's updates
    const v = Math.max(l, r, shown.current * 0.9);
    shown.current = v;
    const db = v > 1e-5 ? 20 * Math.log10(v) : -90;
    const f = Math.max(0, Math.min(1, (db + 60) / 66));
    if (fill.current) {
      fill.current.style[vertical ? 'height' : 'width'] = `${f * 100}%`;
      fill.current.classList.toggle('hot', db > -1);
    }
  });
  return (
    <div className={`level${vertical ? ' vertical' : ''}`}>
      <div ref={fill} />
    </div>
  );
}

function toggle(track: StudioTrack, what: 'mute' | 'solo' | 'armed') {
  optimistic((s) => ({ ...s, tracks: s.tracks.map((t) => (t.id === track.id ? { ...t, [what]: !t[what] } : t)) }));
  command(what === 'armed' ? 'arm' : what, { track: track.id });
}

function TrackChips({ track }: { track: StudioTrack }) {
  return (
    <div className="chips" onClick={(e) => e.stopPropagation()}>
      <button type="button" className={`chip mute${track.mute ? ' on' : ''}`} onClick={() => toggle(track, 'mute')}>
        M
      </button>
      <button type="button" className={`chip solo${track.solo ? ' on' : ''}`} onClick={() => toggle(track, 'solo')}>
        S
      </button>
      <button type="button" className={`chip rec${track.armed ? ' on' : ''}`} onClick={() => toggle(track, 'armed')}>
        R
      </button>
    </div>
  );
}

/**
 * A fader a thumb can work: drag anywhere along it (not jump to where you touch), one undo step in the
 * studio per touch.
 */
function SlideFader({
  value,
  toUnit,
  fromUnit,
  format,
  onChange,
  onBegin,
  onEnd,
  color,
  center = false,
  label,
}: {
  value: number;
  toUnit: (v: number) => number;
  fromUnit: (u: number) => number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  onBegin: () => void;
  onEnd: () => void;
  color: string;
  center?: boolean;
  label: string;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const shown = local ?? value;
  const u = toUnit(shown);
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const width = el.getBoundingClientRect().width;
    const startX = e.clientX;
    const start = toUnit(value);
    let last = 0;
    onBegin();
    const move = (ev: PointerEvent) => {
      const next = fromUnit(Math.max(0, Math.min(1, start + (ev.clientX - startX) / width)));
      setLocal(next);
      const now = performance.now();
      if (now - last > 35) {
        last = now;
        onChange(next);
      }
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      onChange(fromUnit(Math.max(0, Math.min(1, start + (ev.clientX - startX) / width))));
      onEnd();
      setTimeout(() => setLocal(null), 600);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const from = center ? Math.min(0.5, u) : 0;
  const to = center ? Math.max(0.5, u) : u;
  return (
    <div
      className="slide-fader"
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(u * 100)}
      aria-valuetext={format(shown)}
      onPointerDown={down}
      style={{ ['--c' as string]: color }}
    >
      <div className="fill" style={{ left: `${from * 100}%`, width: `${(to - from) * 100}%` }} />
      <div className="thumb" style={{ left: `${u * 100}%` }} />
      <span className={`readout${u > 0.55 ? ' left' : ''}`}>{format(shown)}</span>
    </div>
  );
}

const panText = (p: number) =>
  Math.abs(p) < 0.01 ? 'C' : p < 0 ? `L${Math.round(-p * 64)}` : `R${Math.round(p * 64)}`;

function TrackControls({ track }: { track: StudioTrack }) {
  const channel = (phase: string, patch: Record<string, number>) =>
    command('channel', { target: track.id, phase, ...patch });
  return (
    <div className="remote-track-controls">
      <div className="ctl">
        <span className="label">Volume</span>
        <SlideFader
          value={track.volume}
          toUnit={dbToFader}
          fromUnit={(u) => {
            const db = faderToDb(u);
            return db > -0.25 && db < 0.25 ? 0 : Math.round(db * 10) / 10;
          }}
          format={(v) => `${formatDb(v)} dB`}
          color={track.color}
          label={`${track.name} volume`}
          onBegin={() => channel('begin', {})}
          onChange={(volume) => channel('move', { volume })}
          onEnd={() => channel('end', {})}
        />
      </div>
      <div className="ctl">
        <span className="label">Pan</span>
        <SlideFader
          value={track.pan}
          toUnit={(p) => (p + 1) / 2}
          fromUnit={(u) => {
            const p = u * 2 - 1;
            return Math.abs(p) < 0.03 ? 0 : Math.round(p * 64) / 64;
          }}
          format={panText}
          color={track.color}
          label={`${track.name} pan`}
          center
          onBegin={() => channel('begin', {})}
          onChange={(pan) => channel('move', { pan })}
          onEnd={() => channel('end', {})}
        />
      </div>
    </div>
  );
}

function TracksTab() {
  const s = useRemote((r) => activeStudio(r)?.state);
  if (!s) return null;
  if (!s.tracks.length) return <div className="remote-empty">This song has no tracks yet.</div>;
  return (
    <div className="remote-tracks">
      <p className="remote-hint">
        Tap a track to play it from here and from your keyboard (when nothing is armed, live MIDI goes to the selected
        track). <b>R</b> arms tracks to record.
      </p>
      {s.tracks.map((t) => {
        const selected = t.id === s.selection.track;
        return (
          <div
            key={t.id}
            className={`remote-track${selected ? ' selected' : ''}`}
            style={{ ['--c' as string]: t.color }}
          >
            <div
              className="row"
              onClick={() => {
                optimistic((x) => ({ ...x, selection: { ...x.selection, track: t.id } }));
                command('select', { track: t.id });
              }}
            >
              <span className="swatch" />
              <div className="names">
                <span className="name">{t.name}</span>
                <span className="sub">{t.sub}</span>
                <LevelBar id={t.id} />
              </div>
              <TrackChips track={t} />
            </div>
            {selected && <TrackControls track={t} />}
          </div>
        );
      })}
    </div>
  );
}

function MixerTab() {
  const s = useRemote((r) => activeStudio(r)?.state);
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(240);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(Math.max(120, el.getBoundingClientRect().height - 150)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (!s) return null;
  return (
    <div className="remote-mixer" ref={box}>
      {s.tracks.map((t) => (
        <MiniStrip key={t.id} track={t} height={height} selected={t.id === s.selection.track} />
      ))}
      {s.master && (
        <div className="mini-strip master">
          <span className="name">Stereo Out</span>
          <span className="db mono">{formatDb(s.master.volume)}</span>
          <div className="fader-row">
            <Fader
              db={s.master.volume}
              height={height}
              onBegin={() => command('channel', { target: 'master', phase: 'begin' })}
              onChange={(volume) => command('channel', { target: 'master', phase: 'move', volume })}
              onEnd={() => command('channel', { target: 'master', phase: 'end' })}
            />
            <LevelBar id="master" vertical />
          </div>
        </div>
      )}
    </div>
  );
}

function MiniStrip({ track, height, selected }: { track: StudioTrack; height: number; selected: boolean }) {
  const [local, setLocal] = useState<number | null>(null);
  const last = useRef(0);
  const db = local ?? track.volume;
  return (
    <div className={`mini-strip${selected ? ' selected' : ''}`} style={{ ['--c' as string]: track.color }}>
      <span className="name" onClick={() => command('select', { track: track.id })}>
        {track.name}
      </span>
      <span className="db mono">{formatDb(db)}</span>
      <div className="fader-row">
        <Fader
          db={db}
          height={height}
          onBegin={() => command('channel', { target: track.id, phase: 'begin' })}
          onChange={(volume) => {
            setLocal(volume);
            const now = performance.now();
            if (now - last.current > 35) {
              last.current = now;
              command('channel', { target: track.id, phase: 'move', volume });
            }
          }}
          onEnd={() => {
            if (local !== null) command('channel', { target: track.id, phase: 'move', volume: local });
            command('channel', { target: track.id, phase: 'end' });
            setTimeout(() => setLocal(null), 600);
          }}
        />
        <LevelBar id={track.id} vertical />
      </div>
      <TrackChips track={track} />
    </div>
  );
}

function PlayTab() {
  const s = useRemote((r) => activeStudio(r)?.state);
  const selected = s?.tracks.find((t) => t.id === s.selection.track);
  const armed = s?.tracks.filter((t) => t.armed) ?? [];
  return (
    <div className="remote-play">
      <div className="remote-hint">
        Playing into{' '}
        <b>{armed.length ? armed.map((t) => t.name).join(', ') : (selected?.name ?? 'the selected track')}</b>
        {armed.length ? ' (armed)' : ''} on {activeStudio()?.name ?? 'the studio'}
      </div>
      <PlayPad onMidi={sendMidi} color={(armed[0] ?? selected)?.color} middleC={s?.middleC} />
    </div>
  );
}

function MarkersTab() {
  const s = useRemote((r) => activeStudio(r)?.state);
  const [bar, setBar] = useState('');
  if (!s) return null;
  const meter = s.meter?.length ? s.meter : DEFAULT_METER;
  const go = () => {
    const n = Number(bar);
    if (n >= 1) command('locate', { tick: barToTick(meter, Math.floor(n)) });
  };
  return (
    <div className="remote-markers">
      <div className="remote-row">
        <input
          className="input mono"
          inputMode="numeric"
          placeholder="Bar"
          aria-label="Bar to go to"
          value={bar}
          onChange={(e) => setBar(e.target.value.replace(/[^\d]/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />
        <button type="button" className="btn" onClick={go}>
          Go to bar
        </button>
        <span className="grow" />
        <button type="button" className="btn primary" onClick={() => command('marker')}>
          <Flag size={14} /> Marker here
        </button>
      </div>
      <div className="remote-row">
        <span className="label">Count-in</span>
        <div className="seg">
          {[0, 1, 2].map((n) => (
            <button
              key={n}
              type="button"
              className={`btn${s.countIn === n ? ' on' : ''}`}
              onClick={() => {
                optimistic((x) => ({ ...x, countIn: n }));
                command('countIn', { bars: n });
              }}
            >
              {n === 0 ? 'Off' : `${n} bar${n > 1 ? 's' : ''}`}
            </button>
          ))}
        </div>
        <span className="grow" />
        <span className="muted mono">
          {s.cycle.on
            ? `Cycle ${formatBarBeat(meter, s.cycle.start)} – ${formatBarBeat(meter, s.cycle.end)}`
            : 'Cycle off'}
        </span>
      </div>
      {s.markers.length ? (
        <ul className="remote-marker-list">
          {s.markers.map((m, i) => {
            const next = s.markers[i + 1]?.tick ?? m.tick + barToTick(meter, 5) - barToTick(meter, 1);
            return (
              <li key={`${m.tick}-${m.name}`}>
                <button type="button" className="go" onClick={() => command('locate', { tick: m.tick })}>
                  <span className="mono at">{m.at}</span>
                  <span className="name">{m.name}</span>
                </button>
                <button
                  type="button"
                  className="btn"
                  title="Cycle this section"
                  onClick={() => command('cycleRange', { start: m.tick, end: next })}
                >
                  <Repeat size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="remote-empty">No markers yet. “Marker here” adds one where the playhead is.</div>
      )}
    </div>
  );
}

function Notice() {
  const notice = useRemote((s) => s.notice);
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    setShown(notice.text);
    const t = setTimeout(() => setShown(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);
  return shown ? <div className="remote-notice">{shown}</div> : null;
}
