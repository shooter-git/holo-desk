/**
 * A song's stems: the mix, split into a file for each track. A stem is an ordinary render of the
 * song with every other track switched off (inactive, so its instruments aren't even loaded) and
 * without the song's finish, so each stem carries its own share of the buses it's sent to (its
 * reverb comes with it), and the stems, added together, are the mix before the finish.
 *
 * That sum is exact unless something reacts to how loud the mix is as a whole: `stemWarnings` says
 * what in a song does. The studio's dialog, the host's job and `holo render-audio --stems` all read
 * the stems here.
 */
import { type Channel, type Plugin, type Project, pluginDef, type Track } from '@holo/session';

export interface Stem {
  /** What it's a stem of: the track's name. */
  name: string;
  /** Its file in the archive: numbered in the song's order, so they sort as the tracks do. */
  file: string;
  /** The ids of the tracks heard in it. */
  tracks: string[];
  /** The song as this stem renders it. */
  song: Project;
}

/** MIDI effects that play without a note being written (a part can be all theirs). */
const PLAYS_ALONE = new Set(['drummer']);

/** Whether a track has anything to be heard: a region that isn't muted, or an effect that plays by itself. */
function sounds(t: Track): boolean {
  return (
    t.regions.some((r) => !r.muted && (r.audio !== undefined || r.notes.length > 0)) ||
    t.midiFx.some((p) => !p.bypass && PLAYS_ALONE.has(p.type))
  );
}

/** The tracks the mix is made of: on, not muted (the soloed ones alone while any is soloed), with something to play. */
export function stemTracks(project: Project): Track[] {
  const on = project.tracks.filter((t) => !t.inactive);
  const solo = on.some((t) => t.channel.solo);
  return on.filter((t) => (solo ? t.channel.solo : !t.channel.mute) && sounds(t));
}

/** A name as a file's: what a file system and a ZIP both take, never empty. */
const fileName = (name: string): string =>
  name
    .replace(/[^\w .()'-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'Track';

/** The song's stems, one for each track the mix is made of, in the song's order. */
export function stemSongs(project: Project): Stem[] {
  const heard = stemTracks(project);
  const width = Math.max(2, String(heard.length).length);
  const taken = new Set<string>();
  return heard.map((track, i) => {
    let file = `${String(i + 1).padStart(width, '0')} ${fileName(track.name)}.wav`;
    // (two tracks of one name: the number tells them apart already, but never two files of one name)
    for (let n = 2; taken.has(file.toLowerCase()); n++)
      file = `${String(i + 1).padStart(width, '0')} ${fileName(track.name)} ${n}.wav`;
    taken.add(file.toLowerCase());
    const { finish: _finish, ...rest } = project;
    const song: Project = {
      ...rest,
      // every other track is switched off: not played, and nothing of it loaded
      tracks: project.tracks.map((t) =>
        t.id === track.id
          ? { ...t, channel: { ...t.channel, mute: false, solo: false } }
          : { ...t, inactive: true, channel: { ...t.channel, solo: false } },
      ),
    };
    return { name: track.name, file, tracks: [track.id], song };
  });
}

/** The buses a track's sound gets to: where it goes and what it's sent to, and on from each of those. */
function reached(project: Project, track: Track): Set<string> {
  const seen = new Set<string>();
  const from = (c: Channel) => {
    for (const id of [c.output, ...c.sends.map((s) => s.bus)]) {
      if (id === 'master' || seen.has(id)) continue;
      seen.add(id);
      const bus = project.buses.find((b) => b.id === id);
      if (bus) from(bus.channel);
    }
  };
  from(track.channel);
  return seen;
}

/** A plugin that turns the level up or down by how loud what reaches it is. */
const reacts = (p: Plugin): boolean => !p.bypass && pluginDef(p.type)?.category === 'Dynamics';

/**
 * Why a song's stems won't add up to its bounce exactly, in words for whoever exports them: its
 * finish, and anything on the master, or on a bus more than one stem reaches, that reacts to level.
 * Empty when they add up to the mix.
 */
export function stemWarnings(project: Project): string[] {
  const out: string[] = [];
  const heard = stemTracks(project);
  if (project.finish)
    out.push(
      'The song’s finish (its mastering) isn’t on the stems: they’re the mix before it, so together they’re quieter than the bounce.',
    );
  const plural = (names: string[]) =>
    names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  const master = project.master.inserts.filter(reacts).map((p) => pluginDef(p.type)?.name ?? p.type);
  if (master.length)
    out.push(
      `${plural(master)} on Stereo Out ${master.length > 1 ? 'work' : 'works'} on the whole mix (a new song has a Limiter there). Each stem goes through ${master.length > 1 ? 'them' : 'it'} alone: wherever ${master.length > 1 ? 'they turn' : 'it turns'} the mix down, the stems won’t add up to it exactly.`,
    );
  for (const bus of project.buses) {
    const fx = bus.channel.inserts.filter(reacts).map((p) => pluginDef(p.type)?.name ?? p.type);
    if (!fx.length) continue;
    const reaching = heard.filter((t) => reached(project, t).has(bus.id));
    if (reaching.length < 2) continue;
    out.push(
      `${plural(fx)} on ${bus.name} ${fx.length > 1 ? 'react' : 'reacts'} to ${plural(reaching.map((t) => t.name))} together. In the stems each goes through alone, so they won’t add up to the mix exactly.`,
    );
  }
  return out;
}
