/** The Inspector (the selected region and track, and its channel strip) and the Library (instruments). */
import { type Instrument, SYNTH_FAMILIES, tickToBarBeat } from '@holo/session';
import {
  AudioWaveform,
  Check,
  Download,
  Drum,
  Globe,
  Mic,
  Music,
  Piano,
  Search,
  Sparkles,
  Trash2,
  Upload,
  Waves,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import { type AvailablePack, installs, useInstalls } from '../audio/installs.ts';
import { forgetPackFiles } from '../audio/pack-files.ts';
import { library, type PackSummary } from '../audio/samples.ts';
import { NumberBox } from './AudioEditor.tsx';
import { Strip } from './Mixer.tsx';
import { Palettes } from './Palettes.tsx';
import { type Field, rank, WEIGHT, words } from './search.ts';
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
        <span className="muted ellipsis" title={file?.name}>
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
    <aside className={`inspector${overlay ? ' overlay-panel' : ''}`} aria-label="Inspector">
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
                aria-label="Mute the region"
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
                        className="btn tight"
                        title={`Transpose ${st > 0 ? 'up' : 'down'} ${Math.abs(st) === 12 ? 'an octave' : 'a semitone'}`}
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
                    className="btn left"
                    title="Choose an instrument in the Library"
                    onClick={() => store.set({ library: true, mobileTab: 'library' })}
                  >
                    {instrumentLabel(track.instrument)}
                  </button>
                </div>
                <div className="row">
                  <span>MIDI in</span>
                  <select
                    className="select"
                    aria-label="MIDI input"
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
                    aria-label="MIDI channel"
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
              <span>Color</span>
              <input
                type="color"
                className="swatch-input"
                aria-label="Track color"
                value={track.color}
                onChange={(e) => updateTrack(track.id, { color: e.target.value }, 'Color')}
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
        <div className="inspector-strips">
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

/** Each family of built-in synths' icon (a preset of its own in PRESET_ICON comes first). */
const FAMILY_ICON: Record<string, typeof Piano> = {
  Keys: Piano,
  'Organs and reeds': Piano,
  Synths: AudioWaveform,
  'Bells and glass': Sparkles,
  Textures: Sparkles,
  Voices: Mic,
  World: Globe,
  'Drums and percussion': Drum,
};

const PRESET_ICON: Record<string, typeof Piano> = {
  'Drum Synth': Drum,
  'Analog Bass': Waves,
  'Sub Bass': Waves,
  'Warm Pad': Waves,
  'Bright Lead': Waves,
  Pluck: Waves,
  'Fat Mono': AudioWaveform,
  'Fat Poly': AudioWaveform,
  'Ethereal Pad': Sparkles,
  'Ethereal Keys': Sparkles,
};

/** What names an instrument: the same preset, or the same pack and name, is the same instrument. */
function instrumentKey(i: Instrument | undefined): string {
  if (!i) return '';
  if (i.type === 'synth') return `synth:${i.preset}`;
  if (i.type === 'sampler' || i.type === 'performance') return `${i.type}:${i.pack}/${i.name}`;
  return i.type;
}

const LibraryItem = memo(function LibraryItem({
  instrument,
  icon: Icon,
  title,
  where,
  meta,
  current,
  onPick,
}: {
  instrument: Instrument;
  icon: typeof Piano;
  title: string;
  /** where it comes from (a search's results are one list): its pack and category */
  where?: string;
  meta?: string;
  current: boolean;
  onPick: (i: Instrument) => void;
}) {
  return (
    <button
      type="button"
      className={`list-item${current ? ' active' : ''}`}
      aria-pressed={current}
      onClick={() => onPick(instrument)}
    >
      <Icon size={meta ? 14 : 15} className="muted" />
      {where ? (
        <span className="item-text">
          <span>{title}</span>
          <span className="muted item-where">{where}</span>
        </span>
      ) : (
        <span>{title}</span>
      )}
      {meta && <span className="meta">{meta}</span>}
      {current && !meta && <Check size={14} className="meta" />}
    </button>
  );
});

/**
 * A pack's license as the Library shows it: a pack you imported is under your own license (whatever
 * its text says), a pinned one under its own (a long one is a free-use statement).
 */
export function licenseLabel(pack: { license: string; source?: { kind: string } }): string {
  if (pack.source?.kind === 'imported' || pack.source?.kind === 'local') return 'Your own license';
  return pack.license.length > 14 ? 'Free use' : pack.license;
}

/** A size on disk, as people read one. */
function diskSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/**
 * An installed pack's size, and removing it to make room: asked first, naming what it frees and the
 * songs that play it (their tracks go quiet until it's back).
 */
function PackFoot({ pack }: { pack: PackSummary }) {
  const [asking, setAsking] = useState<{ songs: { id: string; title: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const own = pack.source?.kind === 'imported';
  const ask = async () => {
    try {
      const res = await fetch(`/api/packs/${encodeURIComponent(pack.id)}/songs`);
      setAsking(res.ok ? ((await res.json()) as { songs: { id: string; title: string }[] }) : { songs: [] });
    } catch {
      setAsking({ songs: [] });
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/packs/${encodeURIComponent(pack.id)}`, { method: 'DELETE' });
      const body = (await res.json()) as { freed?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? 'The pack could not be removed');
      await forgetPackFiles(pack.id);
      toast(`Removed ${pack.name}${body.freed ? `: ${diskSize(body.freed)} freed` : ''}`);
      await library.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error', 8000);
      setBusy(false);
      setAsking(null);
    }
  };
  const n = asking?.songs.length ?? 0;
  return (
    <div className="pack-foot">
      {!asking ? (
        <>
          <span className="muted">{pack.bytes ? `${diskSize(pack.bytes)} on disk` : ''}</span>
          <button type="button" className="btn ghost" onClick={() => void ask()} aria-label={`Remove ${pack.name}`}>
            <Trash2 /> Remove
          </button>
        </>
      ) : (
        <div className="pack-remove" role="alertdialog" aria-label={`Remove ${pack.name}?`}>
          <div>
            Remove <b>{pack.name}</b>
            {pack.bytes ? ` and free ${diskSize(pack.bytes)}` : ''}?{' '}
            {n
              ? `${n === 1 ? 'One song plays' : `${n} songs play`} it (${asking.songs
                  .slice(0, 3)
                  .map((x) => x.title)
                  .join(', ')}${n > 3 ? '…' : ''}): those tracks go quiet until it's back.`
              : 'No song plays it.'}{' '}
            {own ? 'It is a pack you imported: importing it again brings it back.' : 'More packs can install it again.'}
          </div>
          <div className="hstack">
            <button type="button" className="btn danger" disabled={busy} onClick={() => void remove()}>
              <Trash2 /> {busy ? 'Removing…' : 'Remove'}
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setAsking(null)}>
              Keep it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The sample libraries HO[LO] ships maps for that aren't installed yet: installed by the server
 * (from their pinned sources, every file checked), one at a time, while the Library shows how far
 * it has got.
 */
function MorePacks({ query, installed }: { query: string; installed: string }) {
  const { packs, job, queue } = useInstalls();
  // again when the installed packs change (one removed comes back here)
  useEffect(() => {
    void installed;
    void installs.load();
  }, [installed]);
  // one at a time: while one installs (here or for a palette's sound), the others wait
  const running = job?.state === 'running' || !!queue;
  const install = (p: AvailablePack) => void installs.install([p.id]);

  const missing = useMemo(
    () =>
      rank(
        words(query),
        // a palette has no samples to install: its sounds are under Palettes
        (packs ?? []).filter((p) => !p.installed && !(p.sounds?.length && !p.instruments.length)),
        // a pack matches as well as its best instrument does
        (p) =>
          p.instruments.length
            ? p.instruments.map((i): Field[] => [
                { text: i.title, weight: WEIGHT.title },
                { text: i.category, weight: WEIGHT.category },
                { text: p.name, weight: WEIGHT.source },
              ])
            : [{ text: p.name, weight: WEIGHT.title }],
      ).map((r) => r.item),
    [packs, query],
  );
  if (!missing.length) return null;
  return (
    <details className="disclosure" open>
      <summary>
        More packs <span className="meta muted pack-license">{missing.length} to install</span>
      </summary>
      <div className="more-packs">
        {missing.map((p) => {
          const mine = job?.id === p.id ? job : null;
          return (
            <div key={p.id} className="more-pack">
              <div className="more-pack-head">
                <b>{p.name}</b>
                <span className="meta muted">
                  {p.bytes ? `${diskSize(p.bytes)} · ` : ''}
                  {licenseLabel(p)}
                </span>
              </div>
              <div className="muted more-pack-list">{p.instruments.map((i) => i.title).join(' · ')}</div>
              {mine?.state === 'running' ? (
                <div className="more-pack-progress" role="status">
                  <progress max={Math.max(1, mine.total)} value={mine.done} aria-label={`Installing ${p.name}`} />
                  <span className="muted">{mine.line}</span>
                </div>
              ) : (
                <button type="button" className="btn" disabled={running} onClick={() => void install(p)}>
                  <Download /> Install
                </button>
              )}
              {mine?.state === 'error' && <div className="more-pack-error">{mine.error}</div>}
            </div>
          );
        })}
        <div className="muted note">Fetched by the computer that runs HO[LO], from each library's own source.</div>
      </div>
    </details>
  );
}

/** An instrument in a search's results: a built-in synth or a pack's (with its size). */
interface SearchHit {
  key: string;
  instrument: Instrument;
  icon: typeof Piano;
  title: string;
  category: string;
  source: string;
  size?: number;
}

/** The icon for a pack instrument's category. */
function categoryIcon(category: string): typeof Piano {
  if (/drum|kit|percussion/i.test(category)) return Drum;
  if (/piano|keys/i.test(category)) return Piano;
  return Music;
}

export function LibraryPanel({ overlay = false, full = false }: { overlay?: boolean; full?: boolean }) {
  const packs = useLibrary();
  const states = useLoadStates();
  // the selected track only: the whole song changing (a note played in) needn't redraw the list
  const track = useApp((s) => s.project?.tracks.find((t) => t.id === s.selectedTrack));
  const [query, setQuery] = useState('');
  const [importing, setImporting] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const searching = words(query).length > 0;
  // the bar asked for a sound by name ("Find “cello” in the Library"): it's searched for here
  const asked = useApp((s) => s.librarySearch);
  useEffect(() => {
    if (asked === null) return;
    setQuery(asked);
    store.set({ librarySearch: null });
  }, [asked]);

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

  const pick = useCallback(
    (i: Instrument) => {
      if (track)
        setInstrument(track.id, i, track.regions.length === 0 && track.name === instrumentLabel(track.instrument));
      else addTrack(i);
      // on a tablet the Library slides over the tracks: the choice made, it slides away
      if (overlay) store.set({ library: false });
    },
    [track, overlay],
  );
  const currentKey = instrumentKey(track?.instrument);
  // a stable object per instrument, so a memoized row sees the same props

  const groups = useMemo(
    () =>
      // a palette with no instruments of its own is under Palettes
      packs
        .filter((p) => p.instruments.length || !p.sounds?.length)
        .map((p) => ({
          pack: p,
          categories: [...new Set(p.instruments.map((i) => i.category))].map((c) => ({
            name: c,
            items: p.instruments
              .filter((i) => i.category === c)
              .map((i) => ({ ...i, instrument: { type: 'sampler', pack: p.id, name: i.name } as Instrument })),
          })),
        })),
    [packs],
  );

  // while searching, the built-in synths and the packs' instruments are one list, best match first
  const results = useMemo(() => {
    const q = words(query);
    if (!q.length) return [];
    const all: SearchHit[] = [
      ...SYNTH_FAMILIES.flatMap((family) =>
        family.presets.map((preset) => ({
          key: `synth:${preset}`,
          instrument: { type: 'synth', preset } as Instrument,
          icon: PRESET_ICON[preset] ?? FAMILY_ICON[family.name] ?? Piano,
          title: preset,
          category: family.name,
          source: 'Built-in',
        })),
      ),
      ...groups.flatMap(({ pack, categories }) =>
        categories.flatMap((c) =>
          c.items.map((i) => ({
            key: `${pack.id}/${i.name}`,
            instrument: i.instrument,
            icon: categoryIcon(c.name),
            title: i.title,
            category: c.name,
            source: pack.name,
            size: i.size,
          })),
        ),
      ),
    ];
    return rank(q, all, (h): Field[] => [
      { text: h.title, weight: WEIGHT.title },
      { text: h.category, weight: WEIGHT.category },
      { text: h.source, weight: WEIGHT.source },
    ]).map((r) => r.item);
  }, [groups, query]);

  return (
    <aside className={`library${overlay ? ' overlay-panel' : ''}${full ? ' full' : ''}`} aria-label="Library">
      <div className="hstack search">
        <Search size={15} className="muted" />
        <input
          className="input"
          placeholder="Search instruments"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search instruments"
        />
      </div>
      <div className="muted library-hint">
        {track ? (
          // what a click does: the selected track's instrument is replaced
          <>
            Click an instrument to put it on <b>{track.name}</b>
            {track.instrument.type === 'none' ? '.' : `, in place of ${instrumentLabel(track.instrument)}.`}
          </>
        ) : (
          'Click an instrument to make a new track with it.'
        )}
      </div>
      <Palettes query={query} overlay={overlay} />
      {searching ? (
        <details className="disclosure" open>
          <summary>
            Instruments{' '}
            <span className="meta muted pack-license">{results.length ? `${results.length} found` : ''}</span>
          </summary>
          {results.length ? (
            <div className="list">
              {results.map((h) => {
                const st = h.size === undefined ? undefined : states.get(h.key);
                return (
                  <LibraryItem
                    key={h.key}
                    instrument={h.instrument}
                    icon={h.icon}
                    title={h.title}
                    where={`${h.source} · ${h.category}`}
                    meta={
                      h.size === undefined
                        ? undefined
                        : st?.state === 'loading'
                          ? `${Math.round((st.done / Math.max(1, st.total)) * 100)}%`
                          : st?.state === 'error'
                            ? 'error'
                            : `${h.size} MB`
                    }
                    current={instrumentKey(h.instrument) === currentKey}
                    onPick={pick}
                  />
                );
              })}
            </div>
          ) : (
            <div className="muted library-none">No instrument matches “{query.trim()}”.</div>
          )}
        </details>
      ) : (
        <>
          <details className="disclosure" open>
            <summary>Built-in</summary>
            {SYNTH_FAMILIES.map((family) => {
              const presets = family.presets;
              return (
                <div key={family.name}>
                  <div className="label category">{family.name}</div>
                  <div className="list">
                    {presets.map((preset) => {
                      const inst: Instrument = { type: 'synth', preset };
                      return (
                        <LibraryItem
                          key={preset}
                          instrument={inst}
                          icon={PRESET_ICON[preset] ?? FAMILY_ICON[family.name] ?? Piano}
                          title={preset}
                          current={instrumentKey(inst) === currentKey}
                          onPick={pick}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </details>
          {groups.map(({ pack, categories }) => (
            <details key={pack.id} className="disclosure">
              <summary>
                {pack.name} <span className="meta muted pack-license">{licenseLabel(pack)}</span>
              </summary>
              {categories.map((c) => (
                <div key={c.name}>
                  <div className="label category">{c.name}</div>
                  <div className="list">
                    {c.items.map((i) => {
                      const st = states.get(`${pack.id}/${i.name}`);
                      return (
                        <LibraryItem
                          key={i.name}
                          instrument={i.instrument}
                          icon={categoryIcon(c.name)}
                          title={i.title}
                          meta={
                            st?.state === 'loading'
                              ? `${Math.round((st.done / Math.max(1, st.total)) * 100)}%`
                              : st?.state === 'error'
                                ? 'error'
                                : `${i.size} MB`
                          }
                          current={instrumentKey(i.instrument) === currentKey}
                          onPick={pick}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
              <div className="muted pack-credit">{pack.credit}</div>
              <PackFoot pack={pack} />
            </details>
          ))}
        </>
      )}
      {packs.length > 0 && (
        <div className="muted library-disk">
          Packs take {diskSize(packs.reduce((sum, p) => sum + (p.bytes ?? 0), 0))} on the computer that runs HO[LO].
        </div>
      )}
      <MorePacks query={query} installed={packs.map((p) => p.id).join(',')} />
      <div className="library-import">
        <input
          ref={file}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(e) => e.target.files?.[0] && void importPack(e.target.files[0])}
        />
        <button type="button" className="btn" disabled={importing} onClick={() => file.current?.click()}>
          <Upload /> {importing ? 'Importing…' : 'Import a sample pack (.zip)'}
        </button>
        <div className="muted note">
          SFZ instruments, or folders of WAV/FLAC files named by note (C4, F#3…); a folder of unnamed hits becomes a
          drum kit, and a kit with a folder for each piece keeps each microphone it was recorded with, mixed with its
          knobs.
        </div>
        <div className="muted note">
          A pack you import stays on this computer, under your own license. Bouncing or recording one of its instruments
          into a song's audio puts that audio in the song's experience repository when the song is sent.
        </div>
      </div>
      {packs.length === 0 && (
        <div className="muted library-empty">
          No sample packs installed yet. The built-in instruments above always work. Install packs from{' '}
          <b>More packs</b> above, or run <kbd>pnpm packs install</kbd> on the machine that runs HO[LO].
        </div>
      )}
    </aside>
  );
}
