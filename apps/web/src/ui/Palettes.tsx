/**
 * The Library's palettes: packs of ready-made sounds, each an instrument with its effects, room and
 * level. A click installs the packs a sound plays (one at a time, showing how far it has got) and
 * adds it as a new track. A sound that needs a synth, an effect or a pack this HO[LO] doesn't have yet
 * shows as coming.
 */
import { checkSound, type PackSound, SOUND_FAMILIES, soundPacks, soundSampler } from '@holo/session';
import {
  AudioWaveform,
  Bell,
  Download,
  Drum,
  Guitar,
  Mic,
  Music,
  Palette,
  Piano,
  Sparkles,
  Waves,
  Wind,
} from 'lucide-react';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { addSound } from '../app/actions.ts';
import { store } from '../app/store.ts';
import { type AvailablePack, installs, useInstalls } from '../audio/installs.ts';
import { library, type PackSummary } from '../audio/samples.ts';
import { type Field, rank, WEIGHT, words } from './search.ts';

const FAMILY_ICON: Record<string, typeof Piano> = {
  Keys: Piano,
  Organs: Piano,
  Strings: Music,
  Brass: Music,
  Woodwinds: Wind,
  Voices: Mic,
  Plucked: Guitar,
  'Mallets and bells': Bell,
  'Drums and percussion': Drum,
  Bass: Waves,
  Synths: AudioWaveform,
  Pads: Waves,
  Textures: Sparkles,
};

/** A palette as the Library shows it: from the pinned maps, or (offline) as it was installed. */
interface PaletteView {
  id: string;
  name: string;
  description?: string;
  sounds: PackSound[];
  requires: string[];
}

export type SoundState =
  | { kind: 'ready' }
  /** Its packs aren't installed yet: what a click installs, and the room they take. */
  | { kind: 'install'; ids: string[]; bytes: number }
  /** It needs something this HO[LO] doesn't have yet. */
  | { kind: 'coming'; why: string };

/** Whether a sound can play here: everything it needs is installed, can be, or isn't in this HO[LO] yet. */
export function soundState(
  sound: PackSound,
  installed: Map<string, PackSummary>,
  available: Map<string, AvailablePack>,
): SoundState {
  const { missing, problems } = checkSound(sound);
  if (missing.length) return { kind: 'coming', why: `Needs ${missing.join(' and ')}, coming to HO[LO]` };
  if (problems.length) return { kind: 'coming', why: problems.join('; ') };
  const sampler = soundSampler(sound);
  const ids: string[] = [];
  let bytes = 0;
  for (const id of soundPacks(sound)) {
    const have = installed.get(id);
    const pinned = available.get(id);
    if (!have && !pinned) return { kind: 'coming', why: `Plays the "${id}" pack, coming to HO[LO]` };
    if (sampler?.pack === id) {
      const names = (have ?? pinned)?.instruments.map((i) => i.name) ?? [];
      if (!names.includes(sampler.name))
        return { kind: 'coming', why: `Plays ${sampler.name}, which ${(have ?? pinned)?.name} doesn't have yet` };
    }
    if (!have) {
      ids.push(id);
      bytes += pinned?.bytes ?? 0;
    }
  }
  return ids.length ? { kind: 'install', ids, bytes } : { kind: 'ready' };
}

function diskSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function useInstalledPacks() {
  return useSyncExternalStore(
    (fn) => library.subscribe(fn),
    () => library.packs,
  );
}

/** Add a sound: its packs installed first when they aren't. */
async function pickSound(palette: PaletteView, sound: PackSound, state: SoundState, overlay: boolean) {
  if (state.kind === 'coming') return;
  if (state.kind === 'install') {
    const ok = await installs.install(state.ids, `${palette.id}/${sound.name}`);
    if (!ok) return;
  }
  addSound(sound);
  // on a tablet the Library slides over the tracks: the choice made, it slides away
  if (overlay) store.set({ library: false });
}

export function Palettes({ query, overlay }: { query: string; overlay: boolean }) {
  const { packs, job, queue } = useInstalls();
  const installedPacks = useInstalledPacks();
  // the pinned maps (More packs asks for them too; whichever comes first fills both)
  useEffect(() => {
    if (!installs.state.packs) void installs.load();
  }, []);

  const installed = useMemo(() => new Map(installedPacks.map((p) => [p.id, p])), [installedPacks]);
  const available = useMemo(() => new Map((packs ?? []).map((p) => [p.id, p])), [packs]);
  const palettes = useMemo(() => {
    const out = new Map<string, PaletteView>();
    // as installed (what plays offline), then as pinned now
    for (const p of [...installedPacks, ...(packs ?? [])]) {
      const sounds = (p as { sounds?: PackSound[] }).sounds;
      if (!sounds?.length) continue;
      const description = (p as { description?: string }).description;
      out.set(p.id, {
        id: p.id,
        name: p.name,
        ...(description ? { description } : {}),
        sounds,
        requires: (p as { requires?: string[] }).requires ?? [],
      });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [installedPacks, packs]);

  const q = words(query);
  const shown = palettes.map((p) => ({ palette: p, sounds: q.length ? [] : p.sounds })).filter((x) => x.sounds.length);
  // while searching, every palette's sounds are one list, best match first
  const found = useMemo(
    () =>
      rank(
        words(query),
        palettes.flatMap((palette) => palette.sounds.map((sound) => ({ palette, sound }))),
        ({ palette, sound }): Field[] => [
          { text: sound.name, weight: WEIGHT.title },
          { text: sound.family, weight: WEIGHT.category },
          { text: palette.name, weight: WEIGHT.source },
          { text: sound.note ?? '', weight: WEIGHT.note },
        ],
      ).map((r) => r.item),
    [palettes, query],
  );
  if (!shown.length && !found.length) return null;
  const busy = !!queue || job?.state === 'running';
  const row = (palette: PaletteView, s: PackSound, where?: string) => {
    const st = soundState(s, installed, available);
    const waiting = queue?.label === `${palette.id}/${s.name}`;
    return (
      <SoundRow
        key={`${palette.id}/${s.name}`}
        palette={palette}
        sound={s}
        state={st}
        waiting={waiting}
        progress={waiting ? Math.round(((job?.done ?? 0) / Math.max(1, job?.total ?? 1)) * 100) : 0}
        busy={busy}
        available={available}
        where={where}
        overlay={overlay}
      />
    );
  };

  return (
    <details className="disclosure palettes" open>
      <summary>
        Palettes{' '}
        <span className="meta muted pack-license">
          {q.length ? `${found.length} found` : `${palettes.length} sets of sounds`}
        </span>
      </summary>
      <div className="muted palettes-hint">
        Ready-made sounds: a click adds a new track with the sound’s effects and room, installing what it plays first.
      </div>
      {q.length > 0 && (
        <div className="list">
          {found.map(({ palette, sound }) => row(palette, sound, `${palette.name} · ${sound.family}`))}
        </div>
      )}
      {shown.map(({ palette, sounds }) => {
        const mine = queue?.label.startsWith(`${palette.id}/`) ? queue : null;
        const ready = sounds.filter((s) => soundState(s, installed, available).kind !== 'coming').length;
        const families = [
          ...SOUND_FAMILIES.filter((f) => sounds.some((s) => s.family === f)),
          ...new Set(sounds.map((s) => s.family).filter((f) => !(SOUND_FAMILIES as readonly string[]).includes(f))),
        ];
        return (
          <details key={palette.id} className="palette">
            <summary>
              <Palette size={14} className="muted" />
              <span>{palette.name}</span>
              <span className="meta muted">
                {ready === sounds.length ? '' : `${ready} of `}
                {sounds.length} sound{sounds.length === 1 ? '' : 's'}
              </span>
            </summary>
            {palette.description && <div className="muted palette-about">{palette.description}</div>}
            {mine && (
              <div className="palette-progress" role="status">
                <div className="muted">
                  {mine.label.slice(palette.id.length + 1)}: installing{' '}
                  {installs.pack(mine.ids[mine.at] ?? '')?.name ?? mine.ids[mine.at]}
                  {mine.ids.length > 1 ? ` (${mine.at + 1} of ${mine.ids.length})` : ''}
                </div>
                <progress
                  max={Math.max(1, job?.total ?? 1)}
                  value={job?.state === 'running' ? job.done : 0}
                  aria-label={`Installing for ${mine.label.slice(palette.id.length + 1)}`}
                />
                {job?.state === 'running' && <span className="muted">{job.line}</span>}
              </div>
            )}
            {families.map((family) => (
              <div key={family}>
                <div className="label category">{family}</div>
                <div className="list">{sounds.filter((s) => s.family === family).map((s) => row(palette, s))}</div>
              </div>
            ))}
          </details>
        );
      })}
    </details>
  );
}

/** A palette's sound: a click adds it (installing what it plays first), or why it can't be yet. */
function SoundRow({
  palette,
  sound: s,
  state: st,
  waiting,
  progress,
  busy,
  available,
  where,
  overlay,
}: {
  palette: PaletteView;
  sound: PackSound;
  state: SoundState;
  /** its packs are installing now, `progress` percent of the way */
  waiting: boolean;
  progress: number;
  busy: boolean;
  available: Map<string, AvailablePack>;
  /** where it comes from (a search's results are one list): its palette and family */
  where?: string | undefined;
  overlay: boolean;
}) {
  const Icon = FAMILY_ICON[s.family] ?? Music;
  const meta =
    st.kind === 'coming' ? 'coming' : waiting ? `${progress}%` : st.kind === 'install' ? diskSize(st.bytes) : '';
  const title =
    st.kind === 'coming'
      ? st.why
      : st.kind === 'install'
        ? `${s.note ? `${s.note} ` : ''}A click installs ${st.ids
            .map((id) => available.get(id)?.name ?? id)
            .join(' and ')} (${diskSize(st.bytes)}) first.`
        : s.note;
  return (
    <button
      type="button"
      className={`list-item sound${st.kind === 'coming' ? ' coming' : ''}`}
      disabled={st.kind === 'coming' || (busy && st.kind === 'install')}
      title={title}
      onClick={() => void pickSound(palette, s, st, overlay)}
    >
      <Icon size={14} className="muted" />
      <span className="sound-text">
        <span>{s.name}</span>
        {where && <span className="muted item-where">{where}</span>}
        {s.note && <span className="muted sound-note">{s.note}</span>}
      </span>
      {meta && (
        <span className="meta">
          {st.kind === 'install' && !waiting && <Download size={11} />} {meta}
        </span>
      )}
    </button>
  );
}
