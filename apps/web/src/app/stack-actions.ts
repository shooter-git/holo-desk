/**
 * What the studio does with track stacks: make one, put tracks in and take them out, give one a bus
 * or take it away, mute, solo and switch its tracks together, take it apart. Each is one undo step.
 *
 * A stack never changes what's heard by being one (packages/session/src/stacks.ts). Where a step here
 * changes where a track plays (into a stack's bus, back to Stereo Out), it does so in so many words,
 * in that same step, and a toast says it.
 */
import { newBus, newId, type Op, type Project, type Stack, type Track, type TrackPatch } from '@holo/session';
import { apply, foldStack } from './actions.ts';
import { store, toast } from './store.ts';

const song = (): Project | null => store.get().project;
const stackOf = (p: Project, id: string): Stack | undefined => p.stacks?.find((s) => s.id === id);
const members = (p: Project, id: string): Track[] => p.tracks.filter((t) => t.stack === id);
const list = (names: string[]): string =>
  names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');

/** A name no stack of the song has yet: "Stack", "Stack 2"… */
function freeName(p: Project, base = 'Stack'): string {
  const taken = new Set((p.stacks ?? []).map((s) => s.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/** A new stack (a folder) of these tracks, gathered at the first one's place. Returns its id. */
export function makeStack(tracks: string[], name?: string): string | null {
  const p = song();
  const ids = tracks.filter((id) => p?.tracks.some((t) => t.id === id));
  if (!p || !ids.length) return null;
  const stack: Stack = { id: newId('stk'), name: name?.trim() || freeName(p) };
  return apply([{ op: 'addStack', stack, tracks: ids }], 'Stack') ? stack.id : null;
}

/** The selected track in a new stack of its own: more are dragged in, or added from their menus. */
export function stackSelected(): void {
  const s = store.get();
  const track = s.project?.tracks.find((t) => t.id === s.selectedTrack);
  if (!track) return;
  if (track.stack) {
    toast(`${track.name} is in a stack already: drag it out, or take it out from its menu`);
    return;
  }
  makeStack([track.id]);
}

/** A track into a stack, at its end; through its bus, where the stack has one. */
export function addToStack(track: string, stack: string): void {
  const p = song();
  const t = p?.tracks.find((x) => x.id === track);
  const s = p && stackOf(p, stack);
  if (!p || !t || !s || t.stack === stack) return;
  const ops: Op[] = [{ op: 'moveTrack', track, index: p.tracks.length, stack }];
  const routed = !!s.bus && t.channel.output !== s.bus;
  if (routed) ops.push({ op: 'updateChannel', target: track, patch: { output: s.bus as string } });
  if (apply(ops, `Into the stack “${s.name}”`) && routed)
    toast(`${t.name} now plays through ${p.buses.find((b) => b.id === s.bus)?.name ?? 'the stack’s bus'}`);
  foldStack(stack, false);
}

/** A track out of its stack, to just after it; back to Stereo Out, where it played through the stack's bus. */
export function takeOutOfStack(track: string): void {
  const p = song();
  const t = p?.tracks.find((x) => x.id === track);
  const s = p && t?.stack ? stackOf(p, t.stack) : undefined;
  if (!p || !t || !s) return;
  const last = p.tracks.findLastIndex((x) => x.stack === s.id);
  const ops: Op[] = [{ op: 'moveTrack', track, index: last, stack: null }];
  const routed = !!s.bus && t.channel.output === s.bus;
  if (routed) ops.push({ op: 'updateChannel', target: track, patch: { output: 'master' } });
  if (apply(ops, `Out of the stack “${s.name}”`) && routed) toast(`${t.name} now plays to Stereo Out`);
}

export function renameStack(stack: string, name: string): void {
  const p = song();
  const s = p && stackOf(p, stack);
  const next = name.trim();
  if (!s || !next || next === s.name) return;
  apply([{ op: 'updateStack', stack, patch: { name: next } }], 'Rename Stack');
}

/** Take a stack apart: its tracks stay where they are, playing as they did (its bus, if it had one, is still in the Mixer). */
export function unstack(stack: string): void {
  const p = song();
  const s = p && stackOf(p, stack);
  if (!p || !s) return;
  const through = s.bus ? members(p, stack).filter((t) => t.channel.output === s.bus) : [];
  if (apply([{ op: 'removeStack', stack }], 'Unstack') && through.length)
    toast(
      `${list(through.map((t) => t.name))} still ${through.length > 1 ? 'play' : 'plays'} through the bus “${p.buses.find((b) => b.id === s.bus)?.name ?? ''}”`,
    );
}

/**
 * Mix a stack through a bus of its own (a summing stack): a new bus named after it, which its header
 * then controls, and every one of its tracks routed there. Or stop: its tracks that play through the
 * bus go back to Stereo Out, and the stack is a folder again (the bus stays in the Mixer, with whatever
 * was put on it).
 */
export function mixStackThroughBus(stack: string, on: boolean): void {
  const p = song();
  const s = p && stackOf(p, stack);
  if (!p || !s || !!s.bus === on) return;
  const tracks = members(p, stack);
  if (on) {
    const bus = newBus(s.name, s.color ?? tracks[0]?.color);
    const ops: Op[] = [
      { op: 'addBus', bus },
      { op: 'updateStack', stack, patch: { bus: bus.id } },
      ...tracks
        .filter((t) => t.channel.output !== bus.id)
        .map((t): Op => ({ op: 'updateChannel', target: t.id, patch: { output: bus.id } })),
    ];
    if (apply(ops, 'Mix Stack Through a Bus'))
      toast(
        `${list(tracks.map((t) => t.name))} now ${tracks.length > 1 ? 'play' : 'plays'} through the new bus “${bus.name}”`,
      );
    return;
  }
  const through = tracks.filter((t) => t.channel.output === s.bus);
  const ops: Op[] = [
    { op: 'updateStack', stack, patch: { bus: null } },
    ...through.map((t): Op => ({ op: 'updateChannel', target: t.id, patch: { output: 'master' } })),
  ];
  const name = p.buses.find((b) => b.id === s.bus)?.name ?? '';
  if (apply(ops, 'Stop Mixing Stack Through Its Bus'))
    toast(`${s.name}’s tracks play to Stereo Out again. The bus “${name}” is still in the Mixer`);
}

/**
 * Mute a stack: its bus, when it has one (what the tracks are heard through); else its tracks, all
 * of them muted unless they all are already (then none).
 */
export function muteStack(stack: string): void {
  const p = song();
  const s = p && stackOf(p, stack);
  if (!p || !s) return;
  const bus = s.bus ? p.buses.find((b) => b.id === s.bus) : undefined;
  if (bus) {
    apply([{ op: 'updateChannel', target: bus.id, patch: { mute: !bus.channel.mute } }], 'Mute');
    return;
  }
  const tracks = members(p, stack);
  const mute = !tracks.every((t) => t.channel.mute);
  apply(
    tracks
      .filter((t) => t.channel.mute !== mute)
      .map((t): Op => ({ op: 'updateChannel', target: t.id, patch: { mute } })),
    'Mute',
  );
}

/** Solo a stack's tracks, all of them unless they all are already (the engine solos tracks, not buses). */
export function soloStack(stack: string): void {
  const p = song();
  if (!p || !stackOf(p, stack)) return;
  const tracks = members(p, stack).filter((t) => !t.inactive);
  const solo = !tracks.every((t) => t.channel.solo);
  apply(
    tracks
      .filter((t) => t.channel.solo !== solo)
      .map((t): Op => ({ op: 'updateChannel', target: t.id, patch: { solo } })),
    'Solo',
  );
}

/** Switch a whole stack off (its tracks made inactive: nothing of them plays or is loaded), or on again. */
export function setStackActive(stack: string, active: boolean): void {
  const p = song();
  if (!p || !stackOf(p, stack)) return;
  const ops = members(p, stack)
    .filter((t) => !!t.inactive === active)
    .map((t): Op => {
      const patch: TrackPatch = active ? { inactive: false } : { inactive: true, armed: false };
      if (!active && t.audioInput?.monitor) patch.audioInput = { ...t.audioInput, monitor: false };
      return { op: 'updateTrack', track: t.id, patch };
    });
  if (ops.length) apply(ops, active ? 'Make Stack Active' : 'Make Stack Inactive');
}

/** What a stack's header shows of its tracks: muted, soloed and off when they all are (muted too when its bus is). */
export function stackState(
  p: Project,
  stack: Stack,
): { mute: boolean; solo: boolean; inactive: boolean; count: number } {
  const tracks = members(p, stack.id);
  const bus = stack.bus ? p.buses.find((b) => b.id === stack.bus) : undefined;
  const on = tracks.filter((t) => !t.inactive);
  return {
    mute: bus ? bus.channel.mute : tracks.length > 0 && tracks.every((t) => t.channel.mute),
    solo: on.length > 0 && on.every((t) => t.channel.solo),
    inactive: tracks.length > 0 && tracks.every((t) => t.inactive),
    count: tracks.length,
  };
}
