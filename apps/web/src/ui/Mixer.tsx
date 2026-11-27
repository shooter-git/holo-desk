/** The mixer: a channel strip per track, then the buses and the master; and the plugin windows. */
import { bandsResponse, kitSource, peqBands } from '@holo/engine';
import {
  type Bus,
  type Channel,
  DRUM_PIECES,
  DRUM_PRESETS,
  FM6_SOUNDS,
  type Instrument,
  macroValue,
  type Op,
  type ParamDef,
  PEQ_BANDS,
  PEQ_TYPES,
  PLUGINS,
  type Plugin,
  type PluginDef,
  PRISM_SOUNDS,
  paramValue,
  pluginDef,
  type Seat,
  SPACE_FILE,
  SPACE_NAMES,
  type Stack,
  type Stage,
  SYNTH_MACROS,
  SYNTH_NOTES,
  samplerKnobValue,
  type Track,
} from '@holo/session';
import { ChevronDown, ChevronRight, Headphones, Power, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import {
  type CSSProperties,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  addBusWithSend,
  addPlugin,
  apply,
  beginGesture,
  endGesture,
  foldStack,
  gestureChange,
  hitsToMidi,
  moveShownTrack,
  selectTrack,
  setInstrument,
  updateChannel,
  updateTrack,
} from '../app/actions.ts';
import { isPhone, useLayout } from '../app/layout.ts';
import { muteStack, soloStack, stackState } from '../app/stack-actions.ts';
import { store, useApp } from '../app/store.ts';
import { trackRows } from '../app/track-rows.ts';
import { engine } from '../audio/engine.ts';
import { library, type PackSummary, samplerKnobDefs } from '../audio/samples.ts';
import { Fader, formatDb, Knob, Meter, PanKnob, startDrag, TAP } from './controls.tsx';
import { Fm6Window } from './Fm6Window.tsx';
import { DelayView, DynamicsView, PresetButton, ReverbView, STUDIO_BANDS, StudioEqView } from './FxViews.tsx';
import { prepare, useFrame, useSize } from './frame.ts';
import { isMenuPress } from './gesture.ts';
import { KitPads, kitPadGrid, useInstrumentMap } from './KitPads.tsx';
import { openMenu, openMenuAt } from './menu.tsx';
import { PrismPackWindow, PrismWindow } from './PrismWindow.tsx';
import { pressToReorder, useNoScrollWhileDragging } from './reorder.ts';
import { useScrollCue } from './scroll-cue.ts';
import { pastSlop, upDownOnly } from './slop.ts';
import { slotName, stripRows } from './strips.ts';
import { inputLabel, instrumentLabel, instrumentMenu, PowerChip } from './Tracks.tsx';
import { Floating, Setting, useViewport } from './window.tsx';

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
      <span className="grow">{slotName(plugin.type, def?.name ?? plugin.type)}</span>
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
  /** In the mixer, a track's strip can be dragged by its name to move the track. */
  movable?: boolean;
  /** A track's place in the song, shown before its name where View › Track numbers is on. */
  number?: number;
  /** A phone's Stereo Out, kept at the mixer's left edge while the other strips scroll by. */
  pinned?: boolean;
  /** The colour of the stack a track is in: its strip is marked with it, after the stack's tab. */
  stackColor?: string;
}

const NO_BUSES: Bus[] = [];

/**
 * One channel strip. Memoized: a song's edits leave the other strips' channel and track
 * objects as they were, so only the strip that changed is drawn again.
 */
export const Strip = memo(function Strip({
  id,
  kind,
  name,
  color,
  channel,
  track,
  selected,
  movable,
  number,
  pinned,
  stackColor,
}: StripProps) {
  const buses = useApp((s) => s.project?.buses ?? NO_BUSES);
  const show = useApp((s) => s.show);
  // (a kit's knobs show once the library knows it)
  const packs = useSyncExternalStore(
    (fn) => library.subscribe(fn),
    () => library.packs,
  );
  const set = (patch: Partial<Channel>) => gestureChange([{ op: 'updateChannel', target: id, patch }]);
  // the fader has the height its row gives it (the same on every strip: see strips.ts); the slots
  // above scroll where there are more than fit, and fade at the edge that has more
  const faderBox = useRef<HTMLDivElement>(null);
  const faderHeight = Math.max(56, useSize(faderBox).h - 2);
  const slots = useRef<HTMLDivElement>(null);
  useScrollCue(slots);
  // a tap on the strip selects its track; a scroll, a fader drag or a right-click doesn't
  const press = useRef<{ x: number; y: number } | null>(null);
  // in the mixer, a track strip's name is its handle: drag it (a finger holds it first) to move the track
  const nameBar = useRef<HTMLDivElement>(null);
  useNoScrollWhileDragging(nameBar);
  // a track's or a bus's name, double-clicked, is typed over where it stands (Stereo Out keeps its own)
  const [renaming, setRenaming] = useState(false);
  const canceled = useRef(false);
  const rename = (typed: string) => {
    setRenaming(false);
    const to = canceled.current ? '' : typed.trim();
    canceled.current = false;
    if (!to || to === name) return;
    if (kind === 'track') updateTrack(id, { name: to }, 'Rename');
    else if (kind === 'bus') apply([{ op: 'updateBus', bus: id, patch: { name: to } }], 'Rename Bus');
  };
  return (
    <section
      className={`strip ${kind}${selected ? ' selected' : ''}${track?.inactive ? ' inactive' : ''}${pinned ? ' pinned' : ''}${stackColor ? ' in-stack' : ''}`}
      style={stackColor ? ({ '--stack': stackColor } as CSSProperties) : undefined}
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
      <div className="strip-top" ref={slots}>
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
              {hasKnobs(track.instrument, packs) && (
                <button
                  type="button"
                  className="slot-edit"
                  title="Its knobs"
                  aria-label={`${instrumentLabel(track.instrument)}: its knobs`}
                  onClick={(e) => {
                    e.stopPropagation();
                    store.set({ synth: id });
                  }}
                >
                  <SlidersHorizontal size={12} />
                </button>
              )}
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
                    // (a finger's sideways swipe scrolls the strips: the level follows it up and down, slop.ts)
                    const upDown = upDownOnly(e);
                    const rise = pastSlop();
                    beginGesture('Send Level');
                    startDrag(e, {
                      onMove: (dx, dy) => {
                        const by = upDown ? -rise(dy) : dx - dy;
                        if (by === 0) return;
                        level = Math.max(-60, Math.min(6, level + by * 0.25));
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
        {/* (the stage is a slot like the others: it scrolls with them where the strip is short) */}
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
                  // (a finger's sideways swipe scrolls the strips: the distance follows it up and down, slop.ts)
                  const upDown = upDownOnly(e);
                  const rise = pastSlop();
                  beginGesture('Distance');
                  startDrag(e, {
                    onMove: (dx, dy) => {
                      tx += dx;
                      ty += dy;
                      const by = upDown ? -rise(dy) : dx - dy;
                      if (upDown ? by === 0 : !moved && Math.hypot(tx, ty) < TAP) return;
                      moved = true;
                      d = Math.max(0, Math.min(1, d + by * 0.004));
                      gestureChange([
                        {
                          op: 'updateChannel',
                          target: id,
                          patch: { stage: { ...stage, distance: Math.round(d * 1000) / 1000 } },
                        },
                      ]);
                    },
                    onEnd: (canceled) => {
                      endGesture();
                      // a scroll that began on the slot is canceled by the browser: not a tap
                      if (!moved && !canceled) store.set({ stage: id });
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
      </div>
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
          length={faderHeight}
          label={`${name} volume`}
          onBegin={() => beginGesture('Volume')}
          onEnd={endGesture}
          onChange={(v) => set({ volume: v })}
        />
        <Meter id={id} height={Math.max(40, faderHeight - 8)} width={12} />
      </div>
      <div className={`strip-chips${show.stripButtons ? '' : ' off'}`}>
        {track && <PowerChip id={id} name={name} inactive={!!track.inactive} />}
        {kind !== 'master' && (
          <>
            <button
              type="button"
              className={`chip mute${channel.mute ? ' on' : ''}`}
              title="Mute"
              aria-label={`Mute ${name}`}
              aria-pressed={channel.mute}
              disabled={!!track?.inactive}
              onClick={() => updateChannel(id, { mute: !channel.mute }, 'Mute')}
            >
              M
            </button>
            {kind === 'track' && (
              <button
                type="button"
                className={`chip solo${channel.solo ? ' on' : ''}`}
                title="Solo"
                aria-label={`Solo ${name}`}
                aria-pressed={channel.solo}
                disabled={!!track?.inactive}
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
            title="Record-arm"
            aria-label={`Record-arm ${name}`}
            aria-pressed={track.armed}
            disabled={!!track.inactive}
            onClick={() => updateTrack(id, { armed: !track.armed }, 'Arm')}
          >
            R
          </button>
        )}
      </div>
      <div
        ref={nameBar}
        className={`strip-name${movable ? ' movable' : ''}`}
        style={{ background: color }}
        title={
          movable
            ? `${name}: drag to move the track, double-click to rename`
            : kind === 'master'
              ? name
              : `${name}: double-click to rename`
        }
        onDoubleClick={() => {
          if (kind !== 'master') setRenaming(true);
        }}
        onPointerDown={(e) => {
          // (the name being typed keeps its presses: they place the caret, and move nothing)
          if (renaming) return;
          if (!movable || (e.pointerType !== 'touch' && (e.button !== 0 || isMenuPress(e)))) return;
          const strip = e.currentTarget.closest<HTMLElement>('.strip');
          const mixer = strip?.parentElement;
          if (!strip || !mixer) return;
          pressToReorder(e, {
            item: strip,
            items: () => [...mixer.querySelectorAll<HTMLElement>(':scope > .strip.track')],
            axis: 'x',
            box: mixer,
            scroll: {
              get: () => mixer.scrollLeft,
              by: (d) => {
                mixer.scrollLeft += d;
              },
            },
            onLift: () => selectTrack(id),
            onDrop: (index) => moveShownTrack(id, index),
          });
        }}
        // a finger's long press is the drag here, not the browser's menu
        onContextMenu={(e) => {
          if (movable) e.preventDefault();
        }}
      >
        {renaming ? (
          <input
            className="input strip-rename"
            // biome-ignore lint/a11y/noAutofocus: shown because the name was double-clicked
            autoFocus
            defaultValue={name}
            aria-label={`Rename ${name}`}
            onFocus={(e) => e.currentTarget.select()}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              // (Escape leaves the name as it was: leaving the field is what sets it)
              if (e.key === 'Escape') canceled.current = true;
              if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
            }}
            onBlur={(e) => rename(e.currentTarget.value)}
          />
        ) : (
          <>
            {number !== undefined && <span className="num">{number}</span>}
            {name}
          </>
        )}
      </div>
    </section>
  );
});

/** The editor pane's height the mixer wants at least: a few of its slots, a fader with room to travel, and the name, all in view. */
const MIXER_PANE = 480;

/**
 * A stack's tab, before its tracks' strips: its arrow folds them away (on this device, as in the
 * tracks pane), its name runs up it, and M and S act on its tracks together (M on its bus, when it
 * has one: that bus's strip is among the buses, with its fader).
 */
function StackTab({ stack, open, color }: { stack: Stack; open: boolean; color: string }) {
  const state = useApp((s) => {
    if (!s.project) return '';
    const st = stackState(s.project, stack);
    return `${st.count}|${st.mute ? 1 : 0}|${st.solo ? 1 : 0}|${st.inactive ? 1 : 0}`;
  });
  const [count, mute, solo, inactive] = state.split('|').map(Number) as [number, number, number, number];
  const bus = useApp((s) => (stack.bus ? (s.project?.buses.find((b) => b.id === stack.bus)?.name ?? null) : null));
  const what = `${count === 1 ? '1 track' : `${count} tracks`}${bus ? `, mixed through ${bus}` : ''}`;
  return (
    <section
      className={`stack-tab${open ? ' open' : ''}${inactive ? ' inactive' : ''}`}
      style={{ '--stack': color } as CSSProperties}
      aria-label={`The stack ${stack.name}: ${what}`}
    >
      <button
        type="button"
        className="btn ghost icon stack-fold"
        title={open ? `Close ${stack.name}: fold its strips away` : `Open ${stack.name}`}
        aria-label={open ? `Close the stack ${stack.name}` : `Open the stack ${stack.name}`}
        aria-expanded={open}
        onClick={() => foldStack(stack.id, open)}
      >
        {open ? <ChevronDown /> : <ChevronRight />}
      </button>
      <div className="stack-tab-name" title={`${stack.name}: ${what}`}>
        <span>{stack.name}</span>
        <span className="stack-tab-count">{count}</span>
      </div>
      <div className="stack-tab-chips">
        <button
          type="button"
          className={`chip mute${mute ? ' on' : ''}`}
          title={bus ? `Mute ${stack.name}: its bus, ${bus}` : `Mute ${stack.name}: its tracks`}
          aria-label={`Mute ${stack.name}`}
          aria-pressed={!!mute}
          disabled={!!inactive}
          onClick={() => muteStack(stack.id)}
        >
          M
        </button>
        <button
          type="button"
          className={`chip solo${solo ? ' on' : ''}`}
          title={`Solo ${stack.name}: its tracks`}
          aria-label={`Solo ${stack.name}`}
          aria-pressed={!!solo}
          disabled={!!inactive}
          onClick={() => soloStack(stack.id)}
        >
          S
        </button>
      </div>
    </section>
  );
}

export function Mixer() {
  // the slices are stable while something else changes, so an edit redraws one strip, not the row
  const tracks = useApp((s) => s.project?.tracks);
  const stacks = useApp((s) => s.project?.stacks);
  const folded = useApp((s) => s.foldedStacks);
  const buses = useApp((s) => s.project?.buses);
  const master = useApp((s) => s.project?.master);
  const selected = useApp((s) => s.selectedTrack);
  const show = useApp((s) => s.show);
  const layout = useLayout();
  const phone = isPhone(layout);
  // Stereo Out pinned (View): beside the studio it stands on its own, so it isn't here as well; a
  // phone has no room for that, and keeps it here, at the left edge, while the other strips scroll by
  const pinned = show.masterRail && !phone;
  const pinnedHere = show.masterRail && phone;
  // in the editor pane (not a phone's own tab) the mixer opens tall enough to use
  useEffect(() => {
    if (phone) return;
    store.set((s) => ({ editorHeight: Math.max(s.editorHeight, Math.min(MIXER_PANE, window.innerHeight - 180)) }));
  }, [phone]);
  if (!tracks || !buses || !master) return null;
  // View leaves strips out: the inactive tracks' (with the tracks pane), the buses' and the master's;
  // a stack has a tab before its strips, and a closed one's strips are folded away under it
  const rows = trackRows({ tracks, ...(stacks ? { stacks } : {}) }, { inactiveTracks: show.inactiveTracks, folded });
  // (with every strip the song has left out, the mixer says so, and brings them back)
  if (!rows.length && !(show.mixerBuses && buses.length) && !(show.mixerMaster && !pinned) && !pinnedHere)
    return (
      <div className="mixer-empty">
        <p>The strips this song has are hidden in View.</p>
        <button type="button" className="btn" onClick={showStrips}>
          Show them
        </button>
      </div>
    );
  return (
    <div className="mixer" ref={stripRows}>
      {pinnedHere && <Strip id="master" kind="master" name="Stereo Out" color="#e9d8b4" channel={master} pinned />}
      {rows.map((row) => {
        if (row.kind === 'stack') {
          const color = row.stack.color ?? row.tracks[0]?.color ?? '#7c8a99';
          return <StackTab key={`stack:${row.stack.id}`} stack={row.stack} open={row.open} color={color} />;
        }
        const t = row.track;
        const inStack = row.stack
          ? (row.stack.color ?? tracks.find((x) => x.stack === row.stack?.id)?.color)
          : undefined;
        return (
          <Strip
            key={t.id}
            id={t.id}
            kind="track"
            name={t.name}
            color={t.color}
            channel={t.channel}
            track={t}
            selected={t.id === selected}
            movable
            // (its place in the song, whatever View leaves out of the mixer)
            number={show.trackNumbers ? tracks.indexOf(t) + 1 : undefined}
            {...(inStack ? { stackColor: inStack } : {})}
          />
        );
      })}
      {show.mixerBuses &&
        buses.map((b) => <Strip key={b.id} id={b.id} kind="bus" name={b.name} color={b.color} channel={b.channel} />)}
      {show.mixerMaster && !pinned && !pinnedHere && (
        <Strip id="master" kind="master" name="Stereo Out" color="#e9d8b4" channel={master} />
      )}
    </div>
  );
}

/** Every strip View can leave out of the mixer, shown again. */
function showStrips(): void {
  store.set((s) => ({ show: { ...s.show, inactiveTracks: true, mixerBuses: true, mixerMaster: true } }));
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

/** Parametric EQ's bands, each in its own color (the curve's handles and the strip below it). */
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

/** The frequencies an EQ's curve is drawn through, 20 Hz to 20 kHz, even in octaves. */
const EQ_FREQS = new Float64Array(220).map((_, i) => 20 * 1000 ** (i / 219));

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
    const ctx = prepare(ref.current, width, h, true);
    if (!ctx) return;
    const n = EQ_FREQS.length;
    const resp = curveOf(type, params, EQ_FREQS, engine.sampleRate);
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
    // a wider, fainter stroke under the curve is its glow: a blur would be worked out again for
    // every move of a knob or a band
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(166,236,255,0.16)';
    ctx.lineWidth = 9;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(166,236,255,0.22)';
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = '#a6ecff';
    ctx.lineWidth = 2;
    ctx.stroke();
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

interface PluginSettingProps {
  /** The channel the plugin is on, the plugin, and its name (for the undo step's). */
  target: string;
  plugin: string;
  of: string;
  def: ParamDef;
  value: number;
  color?: string;
  size?: number;
  label?: string;
}

/**
 * One of a plugin's settings, told what it is and not handed functions made for it: so it is drawn
 * again only when its own value changes. A knob dragged in a window of twenty-four (the Parametric
 * EQ's) used to draw all twenty-four on every move of the pointer.
 */
const PluginSetting = memo(function PluginSetting({
  target,
  plugin,
  of,
  def,
  value,
  color,
  size,
  label,
}: PluginSettingProps) {
  const begin = useCallback(() => beginGesture(`${of}: ${def.name}`), [of, def.name]);
  const change = useCallback(
    (v: number) =>
      gestureChange([{ op: 'updatePlugin', target, plugin, patch: { params: { [def.id]: v } } } satisfies Op]),
    [target, plugin, def.id],
  );
  return (
    <Setting
      def={def}
      value={value}
      onBegin={begin}
      onEnd={endGesture}
      onChange={change}
      color={color}
      size={size}
      label={label}
    />
  );
});

/** Channel EQ's bands, low to high: each one's switch, frequency, gain and Q, as it has them. */
const EQ_BANDS: { name: string; on?: string; f: string; g?: string; q?: string }[] = [
  { name: 'Low Cut', on: 'hpOn', f: 'hpFreq' },
  { name: 'Low Shelf', f: 'lsFreq', g: 'lsGain' },
  { name: 'Low Mid', f: 'b1Freq', g: 'b1Gain', q: 'b1Q' },
  { name: 'Mid', f: 'b2Freq', g: 'b2Gain', q: 'b2Q' },
  { name: 'High Mid', f: 'b3Freq', g: 'b3Gain', q: 'b3Q' },
  { name: 'High Shelf', f: 'hsFreq', g: 'hsGain' },
  { name: 'High Cut', on: 'lpOn', f: 'lpFreq' },
];
/** The settings the bands show (the rest of Channel EQ's, its output, is a knob under them). */
const EQ_BANDED = new Set(EQ_BANDS.flatMap((b) => [b.on, b.f, b.g, b.q]).filter((x): x is string => !!x));

/**
 * Channel EQ, a band to a column as its curve reads, low to high: frequency, then gain, then Q on
 * the same lines across the bands, and a cut's switch where the others have their gain.
 */
function EqBands({
  def,
  params,
  target,
  plugin,
}: {
  def: PluginDef;
  params: Record<string, number>;
  target: string;
  plugin: string;
}) {
  const param = (id?: string) => (id ? def.params.find((p) => p.id === id) : undefined);
  const setting = (p: ParamDef, label: string, dim = false) => (
    <div key={p.id} className={`peq-knob${dim ? ' dim' : ''}`}>
      <PluginSetting
        target={target}
        plugin={plugin}
        of={def.name}
        def={p}
        value={paramValue(def.type, params, p.id)}
        size={30}
        label={label}
      />
    </div>
  );
  return (
    <div className="eq-bands">
      {EQ_BANDS.map((b) => {
        const on = param(b.on);
        const off = !!on && paramValue('eq', params, on.id) < 0.5;
        const f = param(b.f);
        const g = param(b.g);
        const q = param(b.q);
        return (
          <div key={b.name} className="eq-band">
            <span className="label">{b.name}</span>
            {f && setting(f, 'Freq', off)}
            {/* (its button says On or Off: it needs no name under it) */}
            {on && setting(on, '')}
            {g && setting(g, 'Gain')}
            {q && setting(q, 'Q')}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Studio EQ's bands, a column each as its curve reads, low to high: the band's switch, then its
 * frequency, its gain (a cut's slope), and its Q, on the same lines across the bands.
 */
function StudioEqBands({
  def,
  params,
  target,
  plugin,
}: {
  def: PluginDef;
  params: Record<string, number>;
  target: string;
  plugin: string;
}) {
  const param = (id: string) => def.params.find((p) => p.id === id);
  const setting = (id: string, label: string, color: string, dim: boolean) => {
    const p = param(id);
    if (!p) return null;
    return (
      <div key={id} className={`peq-knob${dim ? ' dim' : ''}`}>
        <PluginSetting
          target={target}
          plugin={plugin}
          of={def.name}
          def={p}
          value={paramValue('studioeq', params, id)}
          size={30}
          label={label}
          color={color}
        />
      </div>
    );
  };
  return (
    <div className="studio-bands">
      {STUDIO_BANDS.map((b) => {
        const off = paramValue('studioeq', params, `${b.key}On`) < 0.5;
        return (
          <div key={b.key} className={`eq-band studio-band${off ? ' off' : ''}`}>
            <span className="label studio-band-name">
              <span className="studio-dot" style={{ background: b.color }} />
              {b.name}
            </span>
            {setting(`${b.key}On`, '', b.color, false)}
            {setting(`${b.key}Freq`, 'Freq', b.color, off)}
            {b.cut ? setting(`${b.key}Slope`, 'Slope', b.color, off) : setting(`${b.key}Gain`, 'Gain', b.color, off)}
            {setting(`${b.key}Q`, 'Q', b.color, off)}
          </div>
        );
      })}
    </div>
  );
}

/** The settings Studio EQ's bands show (the rest, its output and Proportional Q, are knobs under them). */
const STUDIO_BANDED = new Set(
  STUDIO_BANDS.flatMap((b) => ['On', 'Freq', 'Gain', 'Slope', 'Q'].map((k) => `${b.key}${k}`)),
);

/**
 * The plugins whose settings come in groups, each under its name (half: two side by side, where
 * there's room): what shapes the sound first, then what follows it.
 */
const FACE_GROUPS: Record<string, { title: string; ids: string[]; half?: boolean }[]> = {
  charcomp: [
    { title: 'Circuit', ids: ['circuit', 'threshold', 'ratio', 'attack', 'release', 'knee', 'detector'] },
    { title: 'Output', ids: ['makeup', 'autoGain', 'saturation', 'limiter', 'limit', 'mix'] },
  ],
  dualdelay: [
    { title: 'Left', ids: ['noteL', 'grooveL', 'timeL', 'fbL', 'crossLR', 'invL'], half: true },
    { title: 'Right', ids: ['noteR', 'grooveR', 'timeR', 'fbR', 'crossRL', 'invR'], half: true },
    { title: 'Both', ids: ['sync', 'lowcut', 'highcut', 'invX', 'mix'] },
  ],
  roomreverb: [
    { title: 'Room', ids: ['predelay', 'size', 'walls', 'density', 'diffusion', 'spread'] },
    { title: 'Tail', ids: ['decay', 'lowDecay', 'crossover', 'highDecay', 'highcut', 'lowLevel'] },
    { title: 'Mix', ids: ['balance', 'dry', 'wet'] },
  ],
  smoothhall: [
    { title: 'Space', ids: ['predelay', 'size', 'decay', 'density'] },
    { title: 'Tone', ids: ['highcut', 'lowcut', 'modRate', 'modDepth', 'spread'] },
    { title: 'Mix', ids: ['dry', 'wet'] },
  ],
};

/** Shorter names under a group's knobs, where the group's own name says the rest (Dual Delay's sides). */
const FACE_LABELS: Record<string, Record<string, string>> = {
  dualdelay: {
    noteL: 'Note',
    grooveL: 'Groove',
    timeL: 'Time',
    fbL: 'Feedback',
    crossLR: 'To Right',
    invL: 'Invert',
    noteR: 'Note',
    grooveR: 'Groove',
    timeR: 'Time',
    fbR: 'Feedback',
    crossRL: 'To Left',
    invR: 'Invert',
  },
};

/** A setting that does nothing as the others stand (a free delay's note, a synced one's time; the limit with the limiter off), drawn faint. */
function dimmed(type: string, id: string, params: Record<string, number>): boolean {
  const v = (x: string) => paramValue(type, params, x);
  if (type === 'dualdelay') {
    const sync = v('sync') >= 0.5;
    if (id.startsWith('time')) return sync;
    if (id.startsWith('note') || id.startsWith('groove')) return !sync;
  }
  if (type === 'charcomp') {
    if (id === 'limit') return v('limiter') < 0.5;
    // (an FET hears its own peaks, an opto cell its power: neither has a choice of detector)
    if (id === 'detector') return [1, 3].includes(Math.round(v('circuit')));
  }
  return false;
}

/** Window widths by plugin (the ones with a wide display or many bands want more room than a row of knobs). */
const WINDOW_WIDTHS: Record<string, number> = {
  peq: 600,
  eq: 540,
  studioeq: 660,
  charcomp: 640,
  limiter: 520,
  compressor: 460,
  dualdelay: 640,
  roomreverb: 600,
  smoothhall: 500,
};

/** Parametric EQ's eight bands, side by side: each one's type, and its frequency, gain and Q. */
function PeqBands({
  def,
  params,
  target,
  plugin,
  set,
}: {
  def: PluginDef;
  params: Record<string, number>;
  target: string;
  plugin: string;
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
                  <PluginSetting
                    target={target}
                    plugin={plugin}
                    of={def.name}
                    def={p}
                    value={paramValue('peq', params, p.id)}
                    size={30}
                    label={k === 'f' ? 'Freq' : k === 'g' ? 'Gain' : 'Q'}
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
    // (as wide as its track and scaled to the reduction: nothing is laid out for a new reading)
    if (bar.current) bar.current.style.transform = `scaleX(${Math.min(1, -gr / 30)})`;
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
  const width = phone ? vp.w : (WINDOW_WIDTHS[plugin.type] ?? 460);
  const bpm = project.tempo[0]?.bpm ?? 120;
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
          <PresetButton target={target} plugin={plugin} />
          <span className="muted owner-name">{owner.name}</span>
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
      {plugin.type === 'eq' && <EqBands def={def} params={plugin.params} target={target} plugin={id} />}
      {plugin.type === 'peq' && (
        <PeqBands
          def={def}
          params={plugin.params}
          target={target}
          plugin={id}
          set={(param, value, label) =>
            apply([{ op: 'updatePlugin', target, plugin: id, patch: { params: { [param]: value } } }], label)
          }
        />
      )}
      {plugin.type === 'studioeq' && (
        <>
          <div className="display">
            <StudioEqView target={target} plugin={plugin} width={width - 30} sr={engine.sampleRate} />
          </div>
          <StudioEqBands def={def} params={plugin.params} target={target} plugin={id} />
        </>
      )}
      {(plugin.type === 'charcomp' || plugin.type === 'compressor' || plugin.type === 'limiter') && (
        <div className="display">
          <DynamicsView target={target} plugin={plugin} width={width - 30} />
        </div>
      )}
      {plugin.type === 'gate' && (
        <div className="display">
          <GainReduction target={target} plugin={plugin.id} />
        </div>
      )}
      {plugin.type === 'dualdelay' && (
        <div className="display">
          <DelayView params={plugin.params} width={width - 30} bpm={bpm} />
        </div>
      )}
      {(plugin.type === 'roomreverb' || plugin.type === 'smoothhall') && (
        <div className="display">
          <ReverbView type={plugin.type} params={plugin.params} width={width - 30} />
        </div>
      )}
      {(plugin.type === 'space' || plugin.type === 'shimmer') && <SpacePicker target={target} plugin={plugin} />}
      {plugin.type === 'replacer' && <KitPicker target={target} plugin={plugin} />}
      {plugin.type === 'wow' && plugin.settings?.curve && <WowDrift target={target} plugin={plugin} />}
      {FACE_GROUPS[plugin.type] ? (
        <div className="face-groups">
          {FACE_GROUPS[plugin.type]?.map((g) => (
            <section key={g.title} className={`face-group${g.half ? ' half' : ''}`}>
              <span className="label face-title">{g.title}</span>
              <div className="face">
                {g.ids.map((pid) => {
                  const p = def.params.find((x) => x.id === pid);
                  if (!p) return null;
                  return (
                    <div key={pid} className={`face-cell${dimmed(plugin.type, pid, plugin.params) ? ' dim' : ''}`}>
                      <PluginSetting
                        target={target}
                        plugin={id}
                        of={def.name}
                        def={p}
                        value={paramValue(def.type, plugin.params, pid)}
                        color="var(--accent)"
                        label={FACE_LABELS[plugin.type]?.[pid]}
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="face">
          {def.params
            .filter((p) => plugin.type !== 'peq' || p.id === 'output')
            // (Channel EQ's and Studio EQ's bands have their settings, above)
            .filter((p) => plugin.type !== 'eq' || !EQ_BANDED.has(p.id))
            .filter((p) => plugin.type !== 'studioeq' || !STUDIO_BANDED.has(p.id))
            .filter(
              (p) =>
                (plugin.type !== 'space' && plugin.type !== 'shimmer') || spaceKnob(plugin.type, p.id, plugin.params),
            )
            // a drift curve stands in for every generated setting
            .filter(() => plugin.type !== 'wow' || !plugin.settings?.curve)
            // (a Drum Replacer's piece has its own menu, by its kit)
            .filter((p) => plugin.type !== 'replacer' || p.id !== 'piece')
            .map((p) => (
              <PluginSetting
                key={p.id}
                target={target}
                plugin={id}
                of={def.name}
                def={p}
                value={paramValue(def.type, plugin.params, p.id)}
                color={def.kind === 'midi' ? 'var(--midi)' : 'var(--accent)'}
              />
            ))}
        </div>
      )}
      <div className="muted plugin-note">{def.description}</div>
    </Floating>
  );
}

/** Whether an instrument has knobs of its own: a synth with them, or a kit (its microphones, tune and decay). */
function hasKnobs(i: Instrument, packs: PackSummary[]): boolean {
  if (i.type === 'synth') return Boolean(SYNTH_MACROS[i.preset]);
  return samplerKnobDefs(i, packs) !== null || playsThroughSynth(i, packs);
}

/** A pack instrument that plays through a built-in synth (Prism): that synth's window. */
function playsThroughSynth(i: Instrument, packs: PackSummary[]): boolean {
  if (i.type !== 'sampler') return false;
  return Boolean(packs.find((p) => p.id === i.pack)?.instruments.find((x) => x.name === i.name)?.synth);
}

/** What a kit's knobs do, for its window. */
const KIT_NOTE =
  "Tune moves the hits that come after it, up or down; Decay keeps that much of each hit's ring, shortening what rings now too.";
const MICS_NOTE =
  'Each microphone the kit was recorded with, at its own level, mixed as it plays: all the way down, a microphone is off. ';

/** A synth's own knobs (Fat, Ethereal…), or a kit's (its microphones, tune, decay): turned, they change what's sounding. */
export function SynthWindow() {
  const id = useApp((s) => s.synth);
  const project = useApp((s) => s.project);
  const layout = useLayout();
  const phone = isPhone(layout);
  const vp = useViewport();
  const packs = useSyncExternalStore(
    (fn) => library.subscribe(fn),
    () => library.packs,
  );
  if (!id || !project) return null;
  const track = project.tracks.find((t) => t.id === id);
  const inst = track?.instrument;
  if (track && inst?.type === 'sampler')
    return playsThroughSynth(inst, packs) ? (
      <PrismPackWindow track={track} inst={inst} />
    ) : (
      <KitWindow track={track} inst={inst} packs={packs} />
    );
  if (!track || inst?.type !== 'synth') return null;
  if (FM6_SOUNDS.includes(inst.preset)) return <Fm6Window track={track} inst={inst} />;
  if (PRISM_SOUNDS.includes(inst.preset)) return <PrismWindow track={track} inst={inst} />;
  const defs = SYNTH_MACROS[inst.preset];
  if (!defs) return null;
  const close = () => store.set({ synth: null });
  const change = (param: string, value: number) =>
    gestureChange([
      {
        op: 'updateTrack',
        track: track.id,
        patch: { instrument: { ...inst, params: { ...inst.params, [param]: value } } },
      } satisfies Op,
    ]);
  return (
    <Floating
      key={id}
      width={phone ? vp.w : 460}
      phone={phone}
      label={inst.preset}
      onClose={close}
      header={
        <>
          <span className="name">{inst.preset}</span>
          <span className="muted">{track.name}</span>
          <button
            type="button"
            className="btn ghost icon"
            title="Back to the preset's settings"
            aria-label="Back to the preset's settings"
            disabled={!inst.params}
            onClick={() => updateTrack(track.id, { instrument: { type: 'synth', preset: inst.preset } }, 'Reset')}
          >
            <RotateCcw />
          </button>
          <button type="button" className="btn ghost icon" title="Close" aria-label="Close" onClick={close}>
            <X />
          </button>
        </>
      }
    >
      <div className="face">
        {defs.map((p) => (
          <Setting
            key={p.id}
            def={p}
            value={macroValue(inst.preset, inst.params, p.id)}
            onBegin={() => beginGesture(`${inst.preset}: ${p.name}`)}
            onEnd={endGesture}
            onChange={(v) => change(p.id, v)}
          />
        ))}
      </div>
      <div className="muted plugin-note">{SYNTH_NOTES[inst.preset]}</div>
    </Floating>
  );
}

/** Which page a kit's window opened on last: its own knobs, or its pads. */
let kitView: 'kit' | 'pads' = 'kit';

/** A sampler kit's knobs (each microphone's level, then tune and decay), and on a page of their own its pads'. */
function KitWindow({
  track,
  inst,
  packs,
}: {
  track: Track;
  inst: Extract<Instrument, { type: 'sampler' }>;
  packs: PackSummary[];
}) {
  const layout = useLayout();
  const phone = isPhone(layout);
  const vp = useViewport();
  const map = useInstrumentMap(inst);
  const [view, setView] = useState(kitView);
  const defs = samplerKnobDefs(inst, packs);
  if (!defs) return null;
  const title = instrumentLabel(inst);
  const mics = defs.length > 2;
  const grid = kitPadGrid(inst, map);
  const pads = view === 'pads' && map !== null && grid !== null;
  const show = (v: 'kit' | 'pads') => {
    kitView = v;
    setView(v);
  };
  const width = phone ? vp.w : pads ? 700 : mics ? 560 : 300;
  const close = () => store.set({ synth: null });
  const change = (param: string, value: number) =>
    gestureChange([
      {
        op: 'updateTrack',
        track: track.id,
        patch: { instrument: { ...inst, params: { ...inst.params, [param]: value } } },
      } satisfies Op,
    ]);
  return (
    <Floating
      key={track.id}
      width={width}
      phone={phone}
      label={title}
      onClose={close}
      header={
        <>
          <span className="name">{title}</span>
          {!phone && <span className="muted">{track.name}</span>}
          {grid && (
            <div className="seg" role="radiogroup" aria-label="Page">
              {/* biome-ignore lint/a11y/useSemanticElements: the studio's segmented buttons, as a radio group */}
              <button
                type="button"
                role="radio"
                aria-checked={!pads}
                className={`btn tight${pads ? '' : ' on'}`}
                title="The kit's own knobs: tune, decay and its microphones"
                onClick={() => show('kit')}
              >
                Kit
              </button>
              {/* biome-ignore lint/a11y/useSemanticElements: the studio's segmented buttons, as a radio group */}
              <button
                type="button"
                role="radio"
                aria-checked={pads}
                className={`btn tight${pads ? ' on' : ''}`}
                title="Each pad's own level, tune, velocity curve and saturator"
                onClick={() => show('pads')}
              >
                Pads
              </button>
            </div>
          )}
          <button
            type="button"
            className="btn ghost icon"
            title={mics ? 'Back to the kit as it was mixed' : 'Back to the kit as it was recorded'}
            aria-label="Back to the kit's own settings"
            disabled={!inst.params}
            onClick={() =>
              updateTrack(track.id, { instrument: { type: 'sampler', pack: inst.pack, name: inst.name } }, 'Reset')
            }
          >
            <RotateCcw />
          </button>
          <button type="button" className="btn ghost icon" title="Close" aria-label="Close" onClick={close}>
            <X />
          </button>
        </>
      }
    >
      {pads ? (
        <KitPads track={track} inst={inst} map={map} grid={grid} width={width} phone={phone} />
      ) : (
        <>
          <div className="face">
            {defs.map((p) => (
              <Setting
                key={p.id}
                def={p}
                value={samplerKnobValue(defs, inst.params, p.id)}
                onBegin={() => beginGesture(`${title}: ${p.name}`)}
                onEnd={endGesture}
                onChange={(v) => change(p.id, v)}
              />
            ))}
          </div>
          <div className="muted plugin-note">{mics ? MICS_NOTE + KIT_NOTE : KIT_NOTE}</div>
        </>
      )}
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

/** The kits a Drum Replacer can play: the built-in ones, then every installed pack's drums and percussion. */
function useKits(): { key: string; title: string; pack: string }[] {
  const packs = useSyncExternalStore(
    (fn) => library.subscribe(fn),
    () => library.packs,
  );
  return packs.flatMap((p) =>
    p.instruments
      .filter((i) => /drum|kit|percussion/i.test(i.category))
      .map((i) => ({ key: `${p.id}/${i.name}`, title: i.title, pack: p.name })),
  );
}

/** A Drum Replacer's kit and the piece it plays, and its hits as notes of their own. */
function KitPicker({ target, plugin }: { target: string; plugin: Plugin }) {
  const kits = useKits();
  const track = useApp((s) => s.project?.tracks.find((t) => t.id === target));
  useSyncExternalStore(
    (fn) => library.subscribe(fn),
    () => library.version,
  );
  const kit = plugin.settings?.kit ?? '';
  const src = kitSource(kit);
  const piece = Math.round(paramValue('replacer', plugin.params, 'piece'));
  const [pack = '', ...rest] = src.kind === 'pack' ? src.key.split('/') : [];
  const load = src.kind === 'pack' ? library.state(pack, rest.join('/')) : undefined;
  const set = (patch: { params?: Record<string, number>; settings?: Record<string, string> }, label: string) =>
    apply([{ op: 'updatePlugin', target, plugin: plugin.id, patch }], label);
  const known = src.kind === 'synth' || kits.some((k) => k.key === kit);
  const [busy, setBusy] = useState(false);
  return (
    <div className="display space-picker">
      <label className="hstack">
        <span className="label">Kit</span>
        <select className="select" value={kit} onChange={(e) => set({ settings: { kit: e.target.value } }, 'Kit')}>
          <optgroup label="Built in">
            {DRUM_PRESETS.map((name) => (
              <option key={name} value={name === 'Drum Synth' ? '' : `synth:${name}`}>
                {name}
              </option>
            ))}
          </optgroup>
          {kits.length > 0 && (
            <optgroup label="Packs">
              {kits.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.pack.toLowerCase().includes(k.title.toLowerCase()) ? k.pack : `${k.title} (${k.pack})`}
                </option>
              ))}
            </optgroup>
          )}
          {!known && <option value={kit}>{rest.join('/') || kit} (not installed)</option>}
        </select>
      </label>
      <label className="hstack">
        <span className="label">Piece</span>
        <select
          className="select"
          value={piece}
          onChange={(e) => set({ params: { piece: Number(e.target.value) } }, 'Piece')}
        >
          {DRUM_PIECES.map((p, i) => (
            <option key={p.key} value={i}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {track?.kind === 'audio' && (
        <button
          type="button"
          className="btn"
          disabled={busy}
          title="The hits heard in this track’s recordings, as notes on a new track playing this kit"
          onClick={() => {
            setBusy(true);
            void hitsToMidi(target, plugin.id).finally(() => setBusy(false));
          }}
        >
          {busy ? 'Listening…' : 'Hits to MIDI'}
        </button>
      )}
      <span className="muted plugin-hint">
        {load?.state === 'loading'
          ? `Loading the kit (${load.done} of ${load.total})…`
          : load?.state === 'error'
            ? `The kit couldn’t load: ${load.message}`
            : 'Set the Threshold just under the softest hit, and Detect Low and High around the drum, so its neighbors’ spill isn’t heard as hits.'}
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
