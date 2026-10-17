/** Dialogs: songs (open, new, import, from a creation), Audio & MIDI settings, key commands. */
import { AudioLines, Download, Plus, Send, Upload, X } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  bounceSong,
  createProject,
  enableMidi,
  ensureAudio,
  exportMidi,
  importMidiFile,
  renderInCreation,
  sendToCreation,
  setLatencyMode,
  setShareDevice,
} from '../app/actions.ts';
import { api, type Creation, type ProjectRow } from '../app/api.ts';
import { KEY_COMMANDS } from '../app/keys.ts';
import { device, renameDevice } from '../app/live.ts';
import { store, toast, useApp } from '../app/store.ts';
import { companion } from '../audio/companion.ts';
import { engine } from '../audio/engine.ts';
import { midi } from '../audio/midi.ts';
import { Wordmark } from './controls.tsx';
import { useFrame } from './frame.ts';
import { SongGroups } from './Songs.tsx';

function Dialog({
  title,
  children,
  footer,
  wide,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && store.set({ dialog: null })}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={wide ? { width: 'min(860px, 100%)' } : undefined}
      >
        <header>
          <h2>{title}</h2>
          <span className="grow" />
          <button
            type="button"
            className="btn ghost icon"
            aria-label="Close"
            onClick={() => store.set({ dialog: null })}
          >
            <X />
          </button>
        </header>
        <div className="content">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

const when = (iso: string) => {
  const d = new Date(iso);
  const days = (Date.now() - d.getTime()) / 86400000;
  if (days < 1) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString();
};

function ProjectsDialog() {
  const current = useApp((s) => s.project);
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [creations, setCreations] = useState<Creation[]>([]);
  const [title, setTitle] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const load = () => {
    void api
      .projects()
      .then(setRows)
      .catch(() => setRows([]));
    void api
      .creations()
      .then(setCreations)
      .catch(() => setCreations([]));
  };
  useEffect(load, []);
  return (
    <Dialog
      title="Songs"
      wide
      footer={
        <>
          <input
            ref={file}
            type="file"
            accept=".mid,.midi,audio/midi"
            hidden
            onChange={(e) => e.target.files?.[0] && void importMidiFile(e.target.files[0])}
          />
          <button type="button" className="btn" onClick={() => file.current?.click()}>
            <Upload /> Import MIDI file
          </button>
          {current && (
            <button type="button" className="btn" onClick={exportMidi}>
              <Download /> Export MIDI
            </button>
          )}
          {current && (
            <button
              type="button"
              className="btn"
              title="Render the song (or the cycle) to a 24-bit WAV (Ctrl B)"
              onClick={() => {
                store.set({ dialog: null });
                void bounceSong(true);
              }}
            >
              <AudioLines /> Bounce to WAV
            </button>
          )}
          <span className="grow" />
          <input
            className="input"
            placeholder="New song's name"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="New song name"
            style={{ width: 200 }}
          />
          <button type="button" className="btn primary" onClick={() => void createProject(title.trim() || 'Untitled')}>
            <Plus /> New song
          </button>
        </>
      }
    >
      {current?.origin && (
        <div
          className="banner song-origin"
          style={{
            borderRadius: 8,
            marginBottom: 12,
            background: 'linear-gradient(90deg, #22314a, #1b2433)',
            color: '#d6e9ff',
          }}
        >
          <Send size={16} />
          {creations.find((c) => c.name === current.origin?.creation)?.engine ? (
            <span className="grow">
              This song is <b>{creations.find((c) => c.name === current.origin?.creation)?.title}</b>’s (
              {current.origin.piece}). Send writes it into the project, whose own build makes it (npm run music).
            </span>
          ) : (
            <span className="grow">
              This song came from <b>{current.origin.creation}</b> ({current.origin.piece}). Send it back when you’re
              happy with it: the creation plays the tracks you edited.
            </span>
          )}
          {creations?.find((c) => c.name === current.origin?.creation)?.canRender && (
            <button
              type="button"
              className="btn"
              title="The creation renders this song itself, with your edits, on the host; its own sound comes back as an audio track to compare"
              onClick={() => void renderInCreation()}
            >
              <AudioLines size={14} /> Hear it as {creations.find((c) => c.name === current.origin?.creation)?.title}
            </button>
          )}
          <button type="button" className="btn primary" onClick={() => void sendToCreation()}>
            Send to {creations.find((c) => c.name === current.origin?.creation)?.title ?? current.origin.creation}
          </button>
        </div>
      )}
      <SongGroups rows={rows} creations={creations} current={current?.id ?? null} when={when} reload={load} />
    </Dialog>
  );
}

/** Where this device's time from key to ear goes, live. */
/** The audio thread's load in full: average, peak, overloads, and what to do about it. */
function DspReadout() {
  const line = useRef<HTMLSpanElement>(null);
  const ahead = useRef<HTMLSpanElement>(null);
  useFrame(() => {
    const d = engine.dsp();
    const block = (128 / engine.sampleRate) * 1000;
    if (line.current)
      line.current.textContent = d.fine
        ? `${Math.round(d.load * 100)}% average, ${Math.round(d.peak * 100)}% peak, ${d.overloads} overload${d.overloads === 1 ? '' : 's'} (blocks of ${block.toFixed(1)} ms)`
        : `${Math.round(d.load * 100)}% average (this browser's audio thread can't time a single block, so no peak)`;
    if (ahead.current)
      ahead.current.textContent = d.ahead
        ? `${d.ahead.loads.map((x) => `${Math.round(x * 100)}%`).join(', ')}; ${engine.remote ? 'HO[LO] Engine’s render thread' : 'the audio thread'} waited for them ${d.ahead.stalls} time${d.ahead.stalls === 1 ? '' : 's'} while playing`
        : engine.remote
          ? 'off (HO[LO] Engine was started with --threads 0, or its computer has too few cores)'
          : 'off (this page has no shared memory, or this device too few cores)';
  });
  return (
    <div className="vstack" style={{ gap: 4 }}>
      <div className="hstack">
        <span className="label">DSP load</span>
        <span ref={line} className="mono" />
        <button type="button" className="btn ghost" onClick={() => engine.resetLoad()}>
          Reset
        </button>
      </div>
      <div className="hstack">
        <span className="label">Ahead</span>
        <span ref={ahead} className="mono" />
      </div>
      <span className="muted">
        How much of each block's time the engine takes on this device's audio thread. The song itself plays a little
        ahead of the playhead on the other cores (Ahead: each thread's share), so only the master and what you play live
        are left to the audio thread. Above about 80% on either the sound can crackle: mute or remove heavy tracks, or
        choose Balanced or Safe. Bounces aren't affected.
      </span>
    </div>
  );
}

/** Where to get HO[LO] Engine: one file for each computer, nothing to install. */
const ENGINE_DOWNLOADS = 'https://github.com/shooter-git/holo-desk/releases/latest';

/** HO[LO] Engine on this device: what it plays through, and whether it has the device to itself. */
function EngineLink() {
  const c = useSyncExternalStore(companion.subscribe, companion.snapshot);
  const share = useApp((s) => s.shareDevice);
  const d = c.device;
  if (!d) {
    return (
      <div className="vstack" style={{ gap: 4 }}>
        <div className="hstack" style={{ flexWrap: 'wrap' }}>
          <span className="status-dot" />
          <span style={{ fontWeight: 600 }}>HO[LO] Engine</span>
          <span className="muted">isn’t running on this device</span>
          {!c.looking && (
            <button type="button" className="btn ghost" onClick={() => void companion.find(!share, true)}>
              Look for it
            </button>
          )}
        </div>
        <span className="muted" style={{ fontSize: 11 }}>
          {c.note ??
            'A small app for the computer you play on: it plays the studio with native audio and reads every USB MIDI instrument itself, a few milliseconds from key to ear. Start it and the studio uses it; quit it and the browser plays again.'}{' '}
          <a href={ENGINE_DOWNLOADS} target="_blank" rel="noreferrer">
            Get HO[LO] Engine
          </a>
        </span>
      </div>
    );
  }
  const ms = (frames: number) => ((frames / d.rate) * 1000).toFixed(1);
  return (
    <div className="vstack" style={{ gap: 4 }}>
      <div className="hstack" style={{ flexWrap: 'wrap' }}>
        <span className="status-dot ok" />
        <span style={{ fontWeight: 600 }}>HO[LO] Engine</span>
        <span className="muted">
          plays this studio through {d.name}: {d.backend} {d.mode === 'exclusive' ? 'exclusive mode' : 'shared'},{' '}
          {d.rate} Hz, {ms(d.period)} ms period
        </span>
      </div>
      {d.backend === 'WASAPI' && (
        <label
          className="hstack"
          title="Exclusive mode is the lowest latency, but while HO[LO] Engine plays no other app can make a sound. Shared, they can (a few milliseconds more)."
        >
          <input type="checkbox" checked={share} onChange={(e) => setShareDevice(e.target.checked)} />
          Share the sound device with other apps
        </label>
      )}
      {c.note && (
        <span className="muted" style={{ fontSize: 11 }}>
          {c.note}
        </span>
      )}
    </div>
  );
}

function LatencyReadout() {
  const ref = useRef<HTMLDivElement>(null);
  const lowLatency = useApp((s) => s.lowLatency);
  const project = useApp((s) => s.project);
  // plugins on the master that hold the sound back (the limiter's look-ahead), when not bypassed
  const pluginMs = lowLatency
    ? 0
    : (project?.master.inserts
        .filter((p) => p.type === 'limiter' && !p.bypass)
        .reduce((a, p) => a + (p.params.lookahead ?? 3), 0) ?? 0);
  useFrame(() => {
    const el = ref.current;
    if (!el) return;
    const l = engine.latency();
    if (!engine.ctx) {
      if (el.textContent !== 'Start the studio to see the numbers.')
        el.textContent = 'Start the studio to see the numbers.';
      return;
    }
    const native = l.companion;
    if (native) {
      const stats = companion.snapshot().stats;
      const block = (128 / native.rate) * 1000;
      const ahead = ((stats?.cushion ?? 0) / native.rate) * 1000;
      const notes = stats?.notes;
      const total = notes ? notes.median + pluginMs : block / 2 + ahead + l.output + pluginMs;
      const rows = [
        `Key to ear ≈ ${total.toFixed(1)} ms${notes ? ' (measured, + about 1 ms of USB and the sound chip)' : ''}`,
        `  device ${l.output.toFixed(1)} ms buffer (${native.backend} ${native.mode}) at ${native.rate} Hz`,
        `  engine: rendered ${ahead.toFixed(1)} ms ahead of the device${stats?.underruns ? `, which ran short ${stats.underruns} time${stats.underruns === 1 ? '' : 's'}` : ''}${pluginMs ? ` + plugins ${pluginMs.toFixed(1)} ms` : ''}`,
        notes
          ? `  USB MIDI to the speakers ${notes.median.toFixed(1)} ms (worst ${notes.worst.toFixed(1)} ms, last ${notes.count} notes)`
          : '  USB MIDI to the speakers: play a few notes to measure it',
        '  live MIDI read natively by HO[LO] Engine',
      ].join('\n');
      if (el.textContent !== rows) el.textContent = rows;
      return;
    }
    const out = l.base + l.output;
    const block = (128 / l.sampleRate) * 1000;
    const m = midi.handling();
    const handling = m?.median ?? 0;
    const total = handling + block / 2 + out + pluginMs;
    const rows = [
      `Key to ear ≈ ${total.toFixed(1)} ms`,
      `  output ${out.toFixed(1)} ms (browser ${l.base.toFixed(1)} + device ${l.output.toFixed(1)}) at ${l.sampleRate} Hz`,
      `  engine ${(block / 2).toFixed(1)} ms on average (one ${block.toFixed(1)} ms block at most)${pluginMs ? ` + plugins ${pluginMs.toFixed(1)} ms` : ''}`,
      m
        ? `  USB MIDI to the engine ${m.median.toFixed(1)} ms (worst ${m.worst.toFixed(1)} ms, last ${m.count} notes)`
        : '  USB MIDI to the engine: play a few notes to measure it',
      `  live MIDI ${l.sharedMemory ? 'through shared memory' : 'through messages: open HO[LO] over HTTPS for shared memory'}`,
    ].join('\n');
    if (el.textContent !== rows) el.textContent = rows;
  });
  return (
    <div
      ref={ref}
      className="mono"
      style={{ whiteSpace: 'pre', fontSize: 11, lineHeight: 1.6, color: 'var(--text-2)' }}
    />
  );
}

function platformTip(): string {
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) {
    return 'On Windows the sound device adds most of the delay. Wired headphones or a USB audio interface cut it (Bluetooth adds 100–250 ms). Firefox’s audio path on Windows is often shorter than Chrome’s: open HO[LO] in both and compare these numbers. In Windows sound settings, turn off audio enhancements and set the device to 48 kHz.';
  }
  if (/Mac OS X/.test(ua))
    return 'macOS has a short audio path. Wired headphones or an audio interface keep it that way; Bluetooth adds 100–250 ms.';
  if (/Android/.test(ua))
    return 'Phones have the longest audio paths: use this one to play into the studio on a computer (Play → To the studio).';
  if (/Linux/.test(ua))
    return 'On Linux, PipeWire with a small quantum (128 frames) is far quicker than PulseAudio; see docs/latency-and-devices.md.';
  return 'Wired headphones or an audio interface give the shortest path; Bluetooth adds 100–250 ms.';
}

/** The sound device this studio plays through. */
function OutputPicker() {
  const native = useSyncExternalStore(companion.subscribe, companion.snapshot).device;
  const chosen = useApp((s) => s.outputDevice);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () =>
      void navigator.mediaDevices
        ?.enumerateDevices()
        .then((all) => setDevices(all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default')))
        .catch(() => setDevices([]));
    load();
    navigator.mediaDevices?.addEventListener('devicechange', load);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', load);
  }, []);
  if (native)
    return (
      <span className="muted" style={{ fontSize: 11 }}>
        HO[LO] Engine plays through the system’s default output: choose it in the system’s sound settings.
      </span>
    );
  if (!engine.canChooseOutput) return null;
  return (
    <label className="hstack" style={{ flexWrap: 'wrap' }}>
      <span className="muted">Output</span>
      <select
        className="select"
        value={chosen}
        aria-label="Sound output"
        style={{ minWidth: 220 }}
        onChange={(e) => {
          const id = e.target.value;
          // a new device has its own delay: measure the round trip again
          store.set({ outputDevice: id, roundTrip: null });
          void engine
            .setOutput(id)
            .catch((err: unknown) =>
              toast(`Couldn’t use that output: ${err instanceof Error ? err.message : String(err)}`, 'error'),
            );
        }}
      >
        <option value="">The system’s default</option>
        {devices.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `Output ${i + 1}`}
          </option>
        ))}
      </select>
      {devices.some((d) => !d.label) && (
        <span className="muted" style={{ fontSize: 11 }}>
          The browser shows the devices’ names once the microphone has been allowed (Measure, below).
        </span>
      )}
    </label>
  );
}

/** The input audio tracks record from, on this device. */
function InputPicker() {
  const native = useSyncExternalStore(companion.subscribe, companion.snapshot).device;
  const chosen = useApp((s) => s.inputDevice);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () =>
      void navigator.mediaDevices
        ?.enumerateDevices()
        .then((all) => setDevices(all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default')))
        .catch(() => setDevices([]));
    load();
    navigator.mediaDevices?.addEventListener('devicechange', load);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', load);
  }, []);
  if (native)
    return (
      <span className="muted" style={{ fontSize: 11 }}>
        HO[LO] Engine records audio tracks from the system’s default input.
      </span>
    );
  if (!navigator.mediaDevices) return null;
  return (
    <label className="hstack" style={{ flexWrap: 'wrap' }}>
      <span className="muted">Input</span>
      <select
        className="select"
        value={chosen}
        aria-label="Audio input"
        style={{ minWidth: 220 }}
        onChange={(e) => {
          const id = e.target.value;
          store.set({ inputDevice: id, roundTrip: null });
          void engine.setInput(id);
        }}
      >
        <option value="">The system’s default</option>
        {devices.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `Input ${i + 1}`}
          </option>
        ))}
      </select>
      <span className="muted" style={{ fontSize: 11 }}>
        For audio tracks. Plug the microphone or instrument into this device (an audio interface is best).
      </span>
    </label>
  );
}

function RoundTrip() {
  const saved = useApp((s) => s.roundTrip);
  const [state, setState] = useState<string | null>(null);
  return (
    <div className="vstack" style={{ gap: 4 }}>
      <button
        type="button"
        className="btn"
        style={{ alignSelf: 'flex-start' }}
        disabled={state === 'Listening…'}
        onClick={async () => {
          setState('Listening…');
          try {
            await ensureAudio();
            const r = await engine.measureRoundTrip(5);
            if (r.roundTrip === null) {
              setState(
                'The microphone didn’t hear the clicks. Use the speakers (or hold the headphones to the microphone) and try again.',
              );
              return;
            }
            const input = r.input;
            // recordings on audio tracks are moved back by this, so they land where they were played
            store.set({ roundTrip: r.roundTrip });
            setState(
              `Round trip ${r.roundTrip.toFixed(1)} ms (${r.heard} clicks)` +
                (input !== null
                  ? `: output ≈ ${(r.roundTrip - input).toFixed(1)} ms, microphone ≈ ${input.toFixed(1)} ms`
                  : ''),
            );
          } catch (err) {
            setState(`Couldn’t measure: ${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      >
        Measure with the microphone
      </button>
      <span className="muted" style={{ fontSize: 11 }}>
        {state ??
          (saved
            ? `Measured here: ${saved.toFixed(1)} ms round trip. Audio recordings are moved back by it.`
            : 'Plays a few clicks and listens for them: the real time from the engine to the air and back, on this device. Audio recordings are moved back by it, so they land where you played them.')}
      </span>
    </div>
  );
}

function SettingsDialog() {
  const mode = useApp((s) => s.latencyMode);
  const lowLatency = useApp((s) => s.lowLatency);
  const status = useApp((s) => s.midiStatus);
  const ports = useApp((s) => s.midiPorts);
  const middleC = useApp((s) => s.middleC);
  const connection = useApp((s) => s.connection);
  const peers = useApp((s) => s.peers);
  const deviceName = useApp((s) => s.deviceName);
  const lights = useRef(new Map<string, HTMLSpanElement>());
  useFrame((now) => {
    for (const [name, el] of lights.current) {
      const t = midi.lastActivity.get(name) ?? 0;
      el.className = `status-dot ${now - t < 90 ? 'flash' : 'ok'}`;
    }
  });
  useEffect(() => midi.onPorts(() => store.set({ midiPorts: midi.ports })), []);
  return (
    <Dialog title="Audio & MIDI">
      <div className="vstack" style={{ gap: 14 }}>
        <section className="vstack">
          <div className="label">This device</div>
          <div className="hstack">
            <input
              className="input"
              style={{ flex: 1, maxWidth: 260 }}
              placeholder={device()}
              defaultValue={deviceName}
              aria-label="This device's name"
              onBlur={(e) => renameDevice(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                e.stopPropagation();
              }}
            />
            <span
              className={`status-dot ${connection === 'online' ? 'ok' : connection === 'offline' ? 'bad' : 'busy'}`}
            />
            <span className="muted">
              {connection === 'online' ? 'Connected to' : connection === 'offline' ? 'Can’t reach' : 'Connecting to'}{' '}
              HO[LO] on {location.host}
            </span>
          </div>
          {peers.filter((p) => p.name !== device()).length > 0 && (
            <span className="muted">
              Also here:{' '}
              {peers
                .filter((p) => p.name !== device())
                .map((p) => `${p.name} (${p.role === 'editor' ? 'studio' : p.role === 'agent' ? 'AI' : 'device'})`)
                .join(', ')}
            </span>
          )}
          <span className="muted">
            The name other devices and the AI see for this one, and what its notes are called when it plays into another
            studio.
          </span>
        </section>
        <section className="vstack">
          <div className="label">Latency</div>
          <div className="hstack" style={{ flexWrap: 'wrap' }}>
            <div className="seg">
              {(
                [
                  ['lowest', 'Lowest'],
                  ['balanced', 'Balanced'],
                  ['safe', 'Safe'],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  className={`btn${mode === m ? ' on' : ''}`}
                  onClick={() => void setLatencyMode(m)}
                >
                  {label}
                </button>
              ))}
            </div>
            <label
              className="hstack"
              title="Plugins that hold the sound back (the master limiter's look-ahead) don't while this is on. Bounces always use them in full."
            >
              <input
                type="checkbox"
                checked={lowLatency}
                onChange={(e) => {
                  store.set({ lowLatency: e.target.checked });
                  engine.setLowLatency(e.target.checked);
                }}
              />
              Low Latency Mode
            </label>
          </div>
          <EngineLink />
          <OutputPicker />
          <InputPicker />
          <LatencyReadout />
          <DspReadout />
          <RoundTrip />
          <span className="muted">
            Lowest is best for playing live; if you hear crackles, try Balanced. {platformTip()}
          </span>
        </section>
        <section className="vstack">
          <div className="label">MIDI devices</div>
          {status === 'unsupported' && (
            <div className="muted">
              This browser has no MIDI (Safari, and every browser on an iPhone or iPad). Use Chrome, Edge or Firefox on
              a computer or an Android phone. A keyboard on an iPhone or iPad reaches the studio over network MIDI
              (below, in the studio’s settings on a computer).
            </div>
          )}
          {status === 'denied' && (
            <div className="muted">
              MIDI access was refused. Allow it in the browser’s site settings, then try again.
            </div>
          )}
          {status === 'off' && (
            <button
              type="button"
              className="btn primary"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => void ensureAudio().then(enableMidi)}
            >
              Turn on MIDI
            </button>
          )}
          {status === 'on' && (
            <div className="list" style={{ border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
              {ports.length === 0 && (
                <div className="list-item muted">No MIDI devices yet. Plug one in: it appears here straight away.</div>
              )}
              {ports.map((p) => (
                <div key={p.id} className="list-item" style={{ cursor: 'default' }}>
                  <span
                    className="status-dot ok"
                    ref={(el) => {
                      if (el) lights.current.set(p.name, el);
                      else lights.current.delete(p.name);
                    }}
                  />
                  <span style={{ fontWeight: 600 }}>{p.name}</span>
                  <span className="meta">
                    {p.source === 'device'
                      ? p.manufacturer || 'USB'
                      : p.source === 'typing'
                        ? 'computer keyboard'
                        : p.source === 'ai'
                          ? 'the AI'
                          : 'network'}
                  </span>
                </div>
              ))}
            </div>
          )}
          <span className="muted">
            Live MIDI plays the armed tracks whose input matches; with none armed, the selected track. Set a track’s
            input and channel in the Inspector.
          </span>
        </section>
        <NetworkMidiPanel />
        <section className="vstack">
          <div className="label">Note names</div>
          <div className="seg" style={{ alignSelf: 'flex-start' }}>
            {(['C3', 'C4'] as const).map((c) => (
              <button
                key={c}
                type="button"
                className={`btn${middleC === c ? ' on' : ''}`}
                onClick={() => {
                  store.set({ middleC: c });
                  void api.saveSettings({ middleC: c }).catch(() => toast('Couldn’t save the setting', 'error'));
                }}
              >
                Middle C is {c} {c === 'C3' ? '(Logic)' : '(scientific)'}
              </button>
            ))}
          </div>
        </section>
      </div>
    </Dialog>
  );
}

function ShortcutsDialog() {
  const groups = [...new Set(KEY_COMMANDS.map((k) => k.group))];
  return (
    <Dialog title="Key commands">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
        {groups.map((g) => (
          <div key={g}>
            <div className="label" style={{ marginBottom: 6 }}>
              {g}
            </div>
            {KEY_COMMANDS.filter((k) => k.group === g).map((k) => (
              <div
                key={k.keys}
                className="hstack"
                style={{ justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--line)' }}
              >
                <span>{k.what}</span>
                <kbd>{k.keys}</kbd>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  );
}

interface NetworkMidiStatus {
  on: boolean;
  port: number;
  reach: string | null;
  error: string | null;
  sessions: { name: string; since: number; seen: number; messages: number }[];
}

/** HO[LO] as a network MIDI session: how an iPhone's USB keyboard (or a Mac) plays into the studio. */
function NetworkMidiPanel() {
  const [status, setStatus] = useState<NetworkMidiStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/network-midi')
        .then((r) => r.json() as Promise<NetworkMidiStatus>)
        .then((s) => alive && setStatus(s))
        .catch(() => undefined);
    load();
    const t = window.setInterval(load, 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  if (!status) return null;
  const local = status.reach === '127.0.0.1';
  return (
    <section className="vstack">
      <div className="label">Network MIDI (iPhone, iPad, Mac)</div>
      {!status.on ? (
        <span className="muted">
          {status.error
            ? `It couldn’t start on the host: ${status.error}`
            : 'Off. An iPhone or iPad can’t give a browser its USB MIDI, but it can send it over the network: set HOLO_NETWORK_MIDI=on on the host (Docker has it on).'}
        </span>
      ) : (
        <>
          <span className="muted">
            HO[LO] is a network MIDI session on port {status.port}.{' '}
            {local
              ? 'Only the host can reach it now: run pnpm netmidi on (your tailnet) or pnpm netmidi lan there.'
              : `Reachable at ${!status.reach || status.reach === '0.0.0.0' ? 'this machine’s network addresses' : status.reach}, port ${status.port}.`}{' '}
            On the iPhone, plug the keyboard in and connect a network session to that address in a MIDI app (midimittr,
            for one); on a Mac, Audio MIDI Setup → Network.
          </span>
          <div className="list" style={{ border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
            {status.sessions.length === 0 && <div className="list-item muted">No device connected.</div>}
            {status.sessions.map((s) => (
              <div key={`${s.name}-${s.since}`} className="list-item" style={{ cursor: 'default' }}>
                <span className="status-dot ok" />
                <span className="grow">{s.name}</span>
                <span className="muted">{s.messages} messages</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** A QR code as SVG (dark modules on white, with the quiet zone scanners need). */
function QrCode({ text, size = 196 }: { text: string; size?: number }) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${n + 8} ${n + 8}`}
      role="img"
      aria-label={`QR code for ${text}`}
      style={{ borderRadius: 10, background: '#fff', flex: 'none' }}
      shapeRendering="crispEdges"
    >
      <path d={d} fill="#0b0d10" />
    </svg>
  );
}

/** Pairing a phone: HO[LO] Remote at this studio's own address. */
function RemoteDialog() {
  const peers = useApp((s) => s.peers);
  const remotes = peers.filter((p) => p.role === 'remote').map((p) => p.name);
  const url = `${location.origin}/remote`;
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  return (
    <Dialog title="Control from your phone">
      <div className="hstack" style={{ alignItems: 'flex-start', gap: 18, flexWrap: 'wrap' }}>
        <QrCode text={url} />
        <div className="vstack" style={{ gap: 10, flex: '1 1 240px', minWidth: 0 }}>
          <p style={{ margin: 0 }}>
            Scan this with the phone by your instruments, or open <b className="mono">{url}</b> on it. It drives this
            studio: play, stop, record, cycle, the tracks and their faders, markers, and a keyboard and pads that play
            into the selected track.
          </p>
          {local && (
            <p className="muted" style={{ margin: 0, color: 'var(--cycle)' }}>
              This studio is open as {location.hostname}, which a phone can’t reach. Open HO[LO] at its tailnet address
              (<kbd>pnpm tailnet</kbd> prints it) or its network address (<kbd>pnpm lan on</kbd>), then scan from there.
            </p>
          )}
          <p className="muted" style={{ margin: 0 }}>
            Add it to the Home Screen: it opens like an app, as HO[LO] Remote, and keeps the screen awake while it’s in
            front. Press Start the studio here once; after that the remote can play, record and stop.
          </p>
          <div className="hstack" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(url)
                  .then(() => toast('Copied'))
                  .catch(() => undefined)
              }
            >
              Copy the address
            </button>
            <span className="muted">
              {remotes.length ? `Connected now: ${remotes.join(', ')}` : 'No remote connected yet'}
            </span>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** About HO[LO] Desk: what it is, its version and licence, and where it lives. */
function AboutDialog() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void fetch('/api/health')
      .then((r) => r.json() as Promise<{ version?: string }>)
      .then((h) => setVersion(h.version ?? null))
      .catch(() => undefined);
  }, []);
  return (
    <Dialog title="About">
      <div className="about">
        <img className="about-icon" src="/icons/icon-192.png" alt="" />
        <div className="about-name">
          <Wordmark desk />
        </div>
        <p className="about-what">A studio for writing, recording and mixing music, in the browser.</p>
        <p className="about-tag">Headphones On [Lights Out]</p>
        <p className="muted">{version ? `Version ${version}` : ''}</p>
        <p className="muted about-small">
          Free software under the MIT licence. Sample libraries are their authors’ work, credited in CREDITS.md. Not
          affiliated with Apple or Avid.
        </p>
        <div className="hstack" style={{ gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <a className="btn" href="https://github.com/shooter-git/holo-desk" target="_blank" rel="noreferrer">
            Source and documentation
          </a>
          <button type="button" className="btn" onClick={() => store.set({ dialog: 'shortcuts' })}>
            Key commands
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function Dialogs() {
  const dialog = useApp((s) => s.dialog);
  if (dialog === 'about') return <AboutDialog />;
  if (dialog === 'remote') return <RemoteDialog />;
  if (dialog === 'projects') return <ProjectsDialog />;
  if (dialog === 'settings') return <SettingsDialog />;
  if (dialog === 'shortcuts') return <ShortcutsDialog />;
  return null;
}
