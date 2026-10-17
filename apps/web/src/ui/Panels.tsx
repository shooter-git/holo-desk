/** The Inspector (the selected region and track, and its channel strip) and the Library (instruments). */
import { type Instrument, SYNTH_PRESETS, tickToBarBeat } from '@holo/session';
import { Check, Drum, Music, Piano, Search, Upload, Waves } from 'lucide-react';
import { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  addTrack,
  apply,
  findRegion,
  normalizeRegion,
  quantizeSelection,
  secondsBetween,
  setInstrument,
  updateTrack,
} from '../app/actions.ts';
import { store, toast, useApp } from '../app/store.ts';
import { library } from '../audio/samples.ts';
import { NumberBox } from './AudioEditor.tsx';
import { Strip } from './Mixer.tsx';
import { instrumentLabel } from './Tracks.tsx';
import { setStretch } from './wave.ts';

/** An audio region's settings: its recording, gain, fades and stretch. */
function AudioRegionRows({ trackId }: { trackId: string }) {
  const project = useApp((s) => s.project);
  const regionId = useApp((s) => s.selectedRegions[0]);
  const region = project?.tracks.find((t) => t.id === trackId)?.regions.find((r) => r.id === regionId);
  const clip = region?.audio;
  if (!project || !region || !clip) return null;
  const file = project.files?.find((f) => f.id === clip.file);
  const set = (patch: Partial<typeof clip>, label: string, extra: { length?: number } = {}) =>
    apply(
      [{ op: 'updateRegion', track: trackId, region: region.id, patch: { ...extra, audio: { ...clip, ...patch } } }],
      label,
    );
  return (
    <>
      <div className="row">
        <span>Recording</span>
        <span
          className="muted"
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={file?.name}
        >
          {file?.name ?? clip.file}
        </span>
      </div>
      <div className="row">
        <span>Length</span>
        <span className="mono">{secondsBetween(project, region.start, region.start + region.length).toFixed(2)} s</span>
      </div>
      <div className="row">
        <span>Gain</span>
        <NumberBox
          label=""
          unit="dB"
          value={clip.gain}
          min={-60}
          max={24}
          onCommit={(gain) => set({ gain }, 'Region Gain')}
        />
      </div>
      <div className="row">
        <span>Fade in</span>
        <NumberBox
          label=""
          unit="ms"
          value={Math.round(clip.fadeIn * 1000)}
          min={0}
          max={60000}
          onCommit={(v) => set({ fadeIn: v / 1000 }, 'Fade')}
        />
      </div>
      <div className="row">
        <span>Fade out</span>
        <NumberBox
          label=""
          unit="ms"
          value={Math.round(clip.fadeOut * 1000)}
          min={0}
          max={60000}
          onCommit={(v) => set({ fadeOut: v / 1000 }, 'Fade')}
        />
      </div>
      <div className="row">
        <span>Stretch</span>
        <NumberBox
          label=""
          unit="%"
          value={Math.round(clip.stretch * 1000) / 10}
          min={25}
          max={400}
          onCommit={(v) => {
            const next = setStretch(project, region, clip, v / 100);
            if (next.audio) set({ stretch: next.audio.stretch }, 'Time Stretch', { length: next.length });
          }}
        />
      </div>
      <div className="row">
        <span>Level</span>
        <button type="button" className="btn" onClick={() => normalizeRegion(trackId, region.id)}>
          Normalize
        </button>
      </div>
    </>
  );
}

/** An audio track's input: which channels it records, and whether you hear them through it. */
function AudioTrackRows({ trackId }: { trackId: string }) {
  const track = useApp((s) => s.project?.tracks.find((t) => t.id === trackId));
  if (!track) return null;
  const input = track.audioInput ?? { input: 0, channels: 1 as const, monitor: false };
  const value = `${input.channels}:${input.input}`;
  return (
    <>
      <div className="row">
        <span>Input</span>
        <select
          className="select"
          value={value}
          aria-label="Audio input"
          onChange={(e) => {
            const [ch, i] = e.target.value.split(':').map(Number);
            updateTrack(track.id, { audioInput: { ...input, channels: ch === 2 ? 2 : 1, input: i ?? 0 } }, 'Input');
          }}
        >
          {Array.from({ length: 8 }, (_, i) => (
            <option key={`m${i}`} value={`1:${i}`}>
              Input {i + 1}
            </option>
          ))}
          {Array.from({ length: 4 }, (_, i) => (
            <option key={`s${i}`} value={`2:${i * 2}`}>
              Input {i * 2 + 1}-{i * 2 + 2} (stereo)
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <span>Monitor</span>
        <label className="hstack" title="Hear the input through the track and its plugins (wear headphones)">
          <input
            type="checkbox"
            checked={input.monitor}
            onChange={(e) =>
              updateTrack(track.id, { audioInput: { ...input, monitor: e.target.checked } }, 'Input Monitoring')
            }
          />{' '}
          input monitoring
        </label>
      </div>
    </>
  );
}

function useLibrary() {
  return useSyncExternalStore(
    (fn) => library.subscribe(fn),
    () => library.packs,
  );
}

function useLoadStates() {
  useSyncExternalStore(
    (fn) => library.subscribe(fn),
    () => library.version,
  );
  return library.states;
}

export function Inspector({ overlay = false }: { overlay?: boolean }) {
  const project = useApp((s) => s.project);
  const trackId = useApp((s) => s.selectedTrack);
  const regionIds = useApp((s) => s.selectedRegions);
  const ports = useApp((s) => s.midiPorts);
  const track = project?.tracks.find((t) => t.id === trackId);
  const region = project && regionIds.length === 1 ? findRegion(project, regionIds[0] as string) : null;
  return (
    <aside
      className={`inspector${overlay ? ' overlay-panel' : ''}`}
      style={overlay ? { left: 0 } : undefined}
      aria-label="Inspector"
    >
      {region && project && (
        <details className="disclosure" open>
          <summary>Region: {region.region.name || (region.region.audio ? 'Audio' : 'MIDI')}</summary>
          <div className="body">
            <div className="row">
              <span>Position</span>
              <span className="mono">
                {(() => {
                  const b = tickToBarBeat(project.meter, region.region.start);
                  return `${b.bar} ${b.beat} ${b.div} ${b.tick}`;
                })()}
              </span>
            </div>
            {region.region.audio ? (
              <AudioRegionRows trackId={region.track.id} />
            ) : (
              <div className="row">
                <span>Notes</span>
                <span className="mono">{region.region.notes.length}</span>
              </div>
            )}
            <div className="row">
              <span>Mute</span>
              <input
                type="checkbox"
                checked={region.region.muted}
                onChange={(e) =>
                  apply(
                    [
                      {
                        op: 'updateRegion',
                        track: region.track.id,
                        region: region.region.id,
                        patch: { muted: e.target.checked },
                      },
                    ],
                    'Mute Region',
                  )
                }
              />
            </div>
            {!region.region.audio && (
              <>
                <div className="row">
                  <span>Transpose</span>
                  <div className="hstack">
                    {[-12, -1, 1, 12].map((st) => (
                      <button
                        key={st}
                        type="button"
                        className="btn"
                        style={{ padding: '0 6px' }}
                        onClick={() =>
                          apply(
                            [
                              {
                                op: 'setNotes',
                                track: region.track.id,
                                region: region.region.id,
                                notes: region.region.notes.map((n) => ({
                                  ...n,
                                  p: Math.max(0, Math.min(127, n.p + st)),
                                })),
                              },
                            ],
                            'Transpose',
                          )
                        }
                      >
                        {st > 0 ? `+${st}` : st}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="row">
                  <span>Quantize</span>
                  <button type="button" className="btn" onClick={quantizeSelection}>
                    Quantize to grid
                  </button>
                </div>
              </>
            )}
          </div>
        </details>
      )}
      {track && (
        <details className="disclosure" open>
          <summary>Track: {track.name}</summary>
          <div className="body">
            {track.kind === 'audio' ? (
              <AudioTrackRows trackId={track.id} />
            ) : (
              <>
                <div className="row">
                  <span>Instrument</span>
                  <button
                    type="button"
                    className="btn"
                    style={{ justifyContent: 'flex-start', overflow: 'hidden' }}
                    onClick={() => store.set({ library: true, mobileTab: 'library' })}
                  >
                    {instrumentLabel(track.instrument)}
                  </button>
                </div>
                <div className="row">
                  <span>MIDI in</span>
                  <select
                    className="select"
                    value={track.input.port}
                    onChange={(e) =>
                      updateTrack(track.id, { input: { ...track.input, port: e.target.value } }, 'Input')
                    }
                  >
                    <option value="*">All inputs</option>
                    {ports.map((p) => (
                      <option key={p.id} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                    {track.input.port !== '*' && !ports.some((p) => p.name === track.input.port) && (
                      <option value={track.input.port}>{track.input.port} (not connected)</option>
                    )}
                  </select>
                </div>
                <div className="row">
                  <span>Channel</span>
                  <select
                    className="select"
                    value={track.input.channel}
                    onChange={(e) =>
                      updateTrack(
                        track.id,
                        { input: { ...track.input, channel: Number(e.target.value) } },
                        'Input Channel',
                      )
                    }
                  >
                    <option value={0}>All channels</option>
                    {Array.from({ length: 16 }, (_, i) => (
                      <option key={i + 1} value={i + 1}>
                        Channel {i + 1}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
            <div className="row">
              <span>Record</span>
              <label className="hstack">
                <input
                  type="checkbox"
                  checked={track.armed}
                  onChange={(e) => updateTrack(track.id, { armed: e.target.checked }, 'Arm')}
                />{' '}
                armed
              </label>
            </div>
            <div className="row">
              <span>Colour</span>
              <input
                type="color"
                value={track.color}
                onChange={(e) => updateTrack(track.id, { color: e.target.value }, 'Colour')}
                style={{ width: 40, height: 24, border: 0, background: 'none' }}
              />
            </div>
            {track.origin && (
              <div className="row">
                <span>From</span>
                <span className="muted">
                  {project?.origin?.piece}: {track.origin.voice}
                  {track.origin.edited ? ' (edited here)' : ''}
                  {track.origin.locked ? ' (locked)' : ''}
                </span>
              </div>
            )}
          </div>
        </details>
      )}
      {track && (
        // the track's strip and the one it plays into, side by side (as Logic's inspector shows them)
        <div style={{ display: 'flex', justifyContent: 'center', gap: 2, padding: 8, height: 580, flex: 'none' }}>
          <Strip
            id={track.id}
            kind="track"
            name={track.name}
            color={track.color}
            channel={track.channel}
            track={track}
          />
          {(() => {
            const bus = project?.buses.find((b) => b.id === track.channel.output);
            if (bus) return <Strip id={bus.id} kind="bus" name={bus.name} color={bus.color} channel={bus.channel} />;
            return project ? (
              <Strip id="master" kind="master" name="Stereo Out" color="#e9d8b4" channel={project.master} />
            ) : null;
          })()}
        </div>
      )}
    </aside>
  );
}

const PRESET_ICON: Record<string, typeof Piano> = {
  'Drum Synth': Drum,
  'Analog Bass': Waves,
  'Sub Bass': Waves,
  'Warm Pad': Waves,
  'Bright Lead': Waves,
  Pluck: Waves,
};

export function LibraryPanel({ overlay = false, full = false }: { overlay?: boolean; full?: boolean }) {
  const packs = useLibrary();
  const states = useLoadStates();
  const project = useApp((s) => s.project);
  const trackId = useApp((s) => s.selectedTrack);
  const track = project?.tracks.find((t) => t.id === trackId);
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();

  const importPack = async (f: File) => {
    setImporting(true);
    try {
      const res = await fetch(`/api/packs/import?name=${encodeURIComponent(f.name.replace(/\.zip$/i, ''))}`, {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: f,
      });
      const body = (await res.json()) as { error?: string; name?: string; instruments?: string[] };
      if (!res.ok) throw new Error(body.error ?? 'The pack could not be imported');
      toast(`Imported ${body.name}: ${body.instruments?.length ?? 0} instrument(s)`);
      await library.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error', 8000);
    } finally {
      setImporting(false);
    }
  };

  const pick = (i: Instrument) => {
    if (track)
      setInstrument(track.id, i, track.regions.length === 0 && track.name === instrumentLabel(track.instrument));
    else addTrack(i);
  };
  const isCurrent = (i: Instrument) => JSON.stringify(track?.instrument) === JSON.stringify(i);

  const groups = useMemo(
    () =>
      packs.map((p) => ({
        pack: p,
        categories: [...new Set(p.instruments.map((i) => i.category))].map((c) => ({
          name: c,
          items: p.instruments.filter(
            (i) => i.category === c && (!q || `${i.title} ${i.category} ${p.name}`.toLowerCase().includes(q)),
          ),
        })),
      })),
    [packs, q],
  );

  return (
    <aside
      className={`library${overlay ? ' overlay-panel' : ''}`}
      style={{ ...(overlay ? { right: 0 } : {}), ...(full ? { width: '100%', borderLeft: 0 } : {}) }}
      aria-label="Library"
    >
      <div className="hstack search">
        <Search size={15} className="muted" />
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder="Search instruments"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search instruments"
        />
      </div>
      <div className="muted" style={{ padding: '0 10px 8px' }}>
        {track ? (
          <>
            For <b style={{ color: 'var(--text)' }}>{track.name}</b>: click to load.
          </>
        ) : (
          'Click an instrument to make a new track with it.'
        )}
      </div>
      <details className="disclosure" open>
        <summary>Built-in</summary>
        <div className="list">
          {SYNTH_PRESETS.filter((pr) => !q || pr.toLowerCase().includes(q)).map((preset) => {
            const inst: Instrument = { type: 'synth', preset };
            const Icon = PRESET_ICON[preset] ?? Piano;
            return (
              <div key={preset} className={`list-item${isCurrent(inst) ? ' active' : ''}`} onClick={() => pick(inst)}>
                <Icon size={15} className="muted" />
                <span>{preset}</span>
                {isCurrent(inst) && <Check size={14} className="meta" />}
              </div>
            );
          })}
        </div>
      </details>
      {groups.map(({ pack, categories }) => (
        <details key={pack.id} className="disclosure" open={!!q}>
          <summary>
            {pack.name}{' '}
            <span className="meta muted" style={{ marginLeft: 'auto', fontWeight: 500 }}>
              {pack.license.length > 14 ? 'Free use' : pack.license}
            </span>
          </summary>
          {categories
            .filter((c) => c.items.length)
            .map((c) => (
              <div key={c.name}>
                <div className="label" style={{ padding: '8px 10px 4px' }}>
                  {c.name}
                </div>
                <div className="list">
                  {c.items.map((i) => {
                    const inst: Instrument = { type: 'sampler', pack: pack.id, name: i.name };
                    const st = states.get(`${pack.id}/${i.name}`);
                    return (
                      <div
                        key={i.name}
                        className={`list-item${isCurrent(inst) ? ' active' : ''}`}
                        onClick={() => pick(inst)}
                      >
                        <Music size={14} className="muted" />
                        <span>{i.title}</span>
                        <span className="meta">
                          {st?.state === 'loading'
                            ? `${Math.round((st.done / Math.max(1, st.total)) * 100)}%`
                            : st?.state === 'error'
                              ? 'error'
                              : `${i.size} MB`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          <div className="muted" style={{ padding: '8px 10px 12px', fontSize: 11 }}>
            {pack.credit}
          </div>
        </details>
      ))}
      <div style={{ padding: 10 }}>
        <input
          ref={file}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => e.target.files?.[0] && void importPack(e.target.files[0])}
        />
        <button
          type="button"
          className="btn"
          style={{ width: '100%' }}
          disabled={importing}
          onClick={() => file.current?.click()}
        >
          <Upload /> {importing ? 'Importing…' : 'Import a sample pack (.zip)'}
        </button>
        <div className="muted" style={{ marginTop: 6, fontSize: 11, lineHeight: 1.5 }}>
          SFZ instruments, or folders of WAV/FLAC files named by note (C4, F#3…); a folder of unnamed hits becomes a
          drum kit.
        </div>
      </div>
      {packs.length === 0 && (
        <div className="muted" style={{ padding: 12, lineHeight: 1.6 }}>
          No sample packs installed yet. The built-in instruments above always work. To install the orchestral packs,
          run <kbd>pnpm packs install</kbd> on the machine that runs HO[LO].
        </div>
      )}
    </aside>
  );
}
