/**
 * Play with your fingers: a keyboard (slide for glissandi, touch higher on a key to play harder; on
 * a phone held upright, two rows of keys if you like) and General MIDI drum pads. They send MIDI
 * like any device, so they play, record and reach the AI the same way.
 */
import { type Instrument, type MiddleC, noteName } from '@holo/session';
import { CircleDashed } from 'lucide-react';
import { Fragment, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { captureRecent, ensureAudio } from '../app/actions.ts';
import { useLayout } from '../app/layout.ts';
import { sendMidi } from '../app/live.ts';
import { toast, useApp } from '../app/store.ts';
import { midi } from '../audio/midi.ts';
import { type InstrumentMap, instrumentManifest } from '../audio/pack-files.ts';
import { useMedia, useSize } from './frame.ts';
import { padManifestKey, padsFor, padTrack } from './pads.ts';
import { BLACK, noteAt, topOctave, upperOctave, velocityAt, whiteKeys } from './play-keys.ts';

const PORT = 'On-screen';
/** The pads' channel (General MIDI's drums). */
const PAD_CHANNEL = 10;
/** A short landscape screen: the pads in rows of eight, so each keeps a finger's height. */
const WIDE_PADS = '(orientation: landscape) and (max-height: 540px)';
/** The highest octave the chromatic pads start on (their sixteen notes stay within MIDI). */
const PAD_TOP_OCTAVE = 8;
/**
 * The height two rows of keys need: each its octave (about 40 px) over 120 px of keys, the least a
 * keyboard has (app.css).
 */
const TWO_ROWS_HEIGHT = 2 * (40 + 120);

/** Where the pads and keys play: this device's own studio, or the studio open on another device. */
let remote = (() => {
  try {
    return localStorage.getItem('holo:play-remote') === '1';
  } catch {
    return false;
  }
})();

function send(status: number, d1: number, d2: number): void {
  if (remote && sendMidi([status, d1, d2])) return;
  midi.addVirtualPort(PORT, 'typing');
  midi.receive(PORT, [status, d1, d2], performance.now());
}

interface PlayPadProps {
  /** HO[LO] Remote: the notes go here (to the studio it drives), never to this device. */
  onMidi?: (data: number[]) => void;
  color?: string;
  middleC?: MiddleC;
  /** HO[LO] Remote: the instrument its notes reach in the studio (the pads follow it). */
  instrument?: Instrument | null;
}

export function PlayPad({
  onMidi,
  color: colorProp,
  middleC: middleCProp,
  instrument: instrumentProp,
}: PlayPadProps = {}) {
  const [mode, setMode] = useState<'keys' | 'pads'>('keys');
  const [toStudio, setToStudio] = useState(remote);
  const kept = useApp((s) => s.captureReady);
  const others = useApp((s) => Math.max(0, s.peers.filter((p) => p.role === 'editor').length - 1));
  const [octave, setOctave] = useState(4);
  /** The upper row's octave, once it's given one (until then, an octave above the lower row). */
  const [upper, setUpper] = useState<number | null>(null);
  const [twoRows, setTwoRows] = useState(() => {
    try {
      return localStorage.getItem('holo:play-rows') === '2';
    } catch {
      return false;
    }
  });
  const ownMiddleC = useApp((s) => s.middleC);
  const ownColor = useApp((s) => s.project?.tracks.find((t) => t.id === s.selectedTrack)?.color ?? '#5cb8ff');
  const middleC = middleCProp ?? ownMiddleC;
  const color = colorProp ?? ownColor;
  const play = (status: number, d1: number, d2: number) => (onMidi ? onMidi([status, d1, d2]) : send(status, d1, d2));
  const wake = () => {
    if (!onMidi) void ensureAudio();
  };
  const box = useRef<HTMLDivElement>(null);
  const size = useSize(box);
  const touches = useRef(new Map<number, number>());
  // The keys and pads held down light up by a class put on them here, not by drawing the pad again:
  // a note played is a touch, and every touch used to render the whole keyboard while it was played.
  const pad = useRef<HTMLDivElement>(null);
  const lit = useRef(new Set<number>());

  // the pads follow the instrument their notes reach (its map says what each key plays)
  const ownInstrument = useApp((s) => padTrack(s.project, s.selectedTrack, PORT, PAD_CHANNEL)?.instrument ?? null);
  const instrument = onMidi ? (instrumentProp ?? null) : ownInstrument;
  const mapKey = padManifestKey(instrument);
  const [map, setMap] = useState<{ key: string; manifest: InstrumentMap } | null>(null);
  useEffect(() => {
    if (!mapKey || (instrument?.type !== 'sampler' && instrument?.type !== 'performance')) return;
    let live = true;
    instrumentManifest(instrument.pack, instrument.name).then(
      (manifest) => {
        if (live) setMap({ key: mapKey, manifest });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [mapKey, instrument]);
  const wide = useMedia(WIDE_PADS);
  // Held upright, a phone's keys are far taller than a finger needs: they can stack in two rows, the
  // upper an octave above the lower until it's given an octave of its own. Each row has its octave
  // over it there, as the bar has room for the rows switch but not for an octave beside it. (Where
  // the keys have no height to spare, HO[LO] Remote's on a small phone, they stay as they were.)
  const stacking = useLayout() === 'phone-portrait' && size.h >= TWO_ROWS_HEIGHT;
  const two = stacking && twoRows;

  const whiteCount = size.w > 900 ? 21 : size.w > 560 ? 14 : 10;
  // a wide keyboard reaches further, so the top octave moves down with the width: a key past 127
  // would play as a note seven octaves below (the engine keeps the low seven bits)
  const top = mode === 'pads' ? PAD_TOP_OCTAVE : topOctave(whiteCount);
  const shownOctave = Math.min(octave, top);
  const grid = padsFor(instrument, map && map.key === mapKey ? map.manifest : null, {
    wide,
    octave: shownOctave,
    middleC,
  });
  const shownUpper = upperOctave(upper, shownOctave, top);
  const lower: KeyRow = {
    id: 'lower',
    octave: shownOctave,
    setOctave: (o) => {
      // (an upper row still following this one stays where it is)
      if (two && upper === null) setUpper(shownUpper);
      setOctave(o);
    },
  };
  const rows: KeyRow[] = two ? [{ id: 'upper', octave: shownUpper, setOctave: setUpper }, lower] : [lower];
  const pickRows = (on: boolean) => {
    setTwoRows(on);
    try {
      localStorage.setItem('holo:play-rows', on ? '2' : '1');
    } catch {
      // remembered for this visit only
    }
  };

  const light = (n: number, on: boolean) => {
    for (const el of pad.current?.querySelectorAll(`[data-note="${n}"]`) ?? []) {
      if (el.classList.contains('pad')) {
        el.classList.toggle('hit', on);
        el.setAttribute('aria-pressed', String(on));
      } else el.classList.toggle('lit', on);
    }
  };
  const update = () => {
    const held = new Set(touches.current.values());
    for (const n of lit.current) if (!held.has(n)) light(n, false);
    for (const n of held) if (!lit.current.has(n)) light(n, true);
    lit.current = held;
  };
  // (a render may have made the keys anew, another octave or the pads: what's held is lit on them)
  useLayoutEffect(() => {
    for (const n of lit.current) light(n, true);
  });

  // a finger on the keys, of either row: the rows share what's held, so it's lit and let go alike
  const fingers: Fingers = {
    down(id, n, velocity) {
      wake();
      if (n === null) return;
      touches.current.set(id, n);
      update();
      play(0x90, n, velocity);
    },
    move(id, n, velocity) {
      const held = touches.current.get(id);
      if (held === undefined || n === null || n === held) return;
      play(0x80, held, 0);
      touches.current.set(id, n);
      update();
      play(0x90, n, velocity);
    },
    up(id) {
      const held = touches.current.get(id);
      touches.current.delete(id);
      update();
      if (held !== undefined) play(0x80, held, 0);
    },
  };

  // What was just played here can be kept (Capture): said where it was played, in the room there is
  // (the bar, or beside the octave where the keyboard's rows fill the bar).
  const keepChip = kept && !toStudio && (
    <button
      type="button"
      className="btn capture-chip"
      title="Keep what you just played as a region (Capture)"
      aria-label="Keep what I played"
      onClick={captureRecent}
    >
      <CircleDashed />
      <span className="words">Keep</span>
    </button>
  );

  return (
    <div className="playpad" ref={pad} style={{ ['--pad-color' as string]: color }}>
      <div className="pane-bar">
        <div className="seg">
          {/* short names: on a phone the bar holds these, where the notes go, and the octave (or held
              upright, how many rows of keys) */}
          <button
            type="button"
            className={`btn${mode === 'keys' ? ' on' : ''}`}
            title="Keyboard"
            onClick={() => setMode('keys')}
          >
            Keys
          </button>
          <button
            type="button"
            className={`btn${mode === 'pads' ? ' on' : ''}`}
            title="Pads: a kit's pieces, or notes for an instrument played by pitch"
            onClick={() => setMode('pads')}
          >
            Pads
          </button>
        </div>
        {!onMidi && (
          <button
            type="button"
            className={`btn${toStudio ? ' on' : ''}`}
            title="Play into the studio open on another device (your laptop, say) instead of this one"
            onClick={() => {
              remote = !toStudio;
              setToStudio(remote);
              try {
                localStorage.setItem('holo:play-remote', remote ? '1' : '0');
              } catch {
                // remembered for this visit only
              }
              if (remote && others === 0)
                toast('No studio is open on another device yet: open HO[LO] there too', 'info', 5000);
            }}
          >
            {toStudio ? `To the studio${others ? ` (${others})` : ''}` : 'On this device'}
          </button>
        )}
        {!(mode === 'keys' && stacking) && keepChip}
        {mode === 'keys' && stacking ? (
          <div className="seg rows" role="radiogroup" aria-label="Rows of keys">
            {/* biome-ignore lint/a11y/useSemanticElements: the studio's segmented buttons, as a radio group */}
            <button
              type="button"
              role="radio"
              aria-checked={!twoRows}
              className={`btn tight${twoRows ? '' : ' on'}`}
              title="One row of keys, as tall as the screen"
              onClick={() => pickRows(false)}
            >
              1 row
            </button>
            {/* biome-ignore lint/a11y/useSemanticElements: the studio's segmented buttons, as a radio group */}
            <button
              type="button"
              role="radio"
              aria-checked={twoRows}
              className={`btn tight${twoRows ? ' on' : ''}`}
              title="Two rows of keys, one over the other, each with its own octave"
              onClick={() => pickRows(true)}
            >
              2 rows
            </button>
          </div>
        ) : (
          <>
            <span className="grow" />
            {(mode === 'keys' || grid.chromatic) && (
              <Octave octave={shownOctave} top={top} middleC={middleC} onChange={setOctave} />
            )}
          </>
        )}
      </div>
      {mode === 'pads' ? (
        <div
          className="pads"
          style={{
            gridTemplateColumns: `repeat(${grid.cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${Math.ceil(grid.pads.length / grid.cols)}, minmax(0, 1fr))`,
          }}
        >
          {grid.pads.map(({ note: n, name }) => (
            <button
              key={n}
              type="button"
              aria-label={name}
              aria-pressed={false}
              className="pad"
              data-note={n}
              onKeyDown={(e) => {
                // a pad from a keyboard: held down for as long as the key is
                if ((e.key !== ' ' && e.key !== 'Enter') || e.repeat) return;
                e.preventDefault();
                wake();
                touches.current.set(-1 - n, n);
                update();
                play(0x99, n, 100);
              }}
              onKeyUp={(e) => {
                if (e.key !== ' ' && e.key !== 'Enter') return;
                touches.current.delete(-1 - n);
                update();
                play(0x89, n, 0);
              }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                wake();
                const r = e.currentTarget.getBoundingClientRect();
                const vel = Math.round(50 + 77 * Math.min(1, 1 - (e.clientY - r.top) / r.height + 0.3));
                touches.current.set(e.pointerId, n);
                update();
                play(0x99, n, Math.min(127, vel));
              }}
              onPointerUp={(e) => {
                touches.current.delete(e.pointerId);
                update();
                play(0x89, n, 0);
              }}
              onPointerCancel={(e) => {
                touches.current.delete(e.pointerId);
                update();
              }}
            >
              {name}
            </button>
          ))}
        </div>
      ) : (
        <div ref={box} className="keyboards">
          {rows.map((row, i) => (
            <Fragment key={row.id}>
              {stacking && (
                <div className="key-strip">
                  {i === 0 && keepChip}
                  {two && <span className="label">{row.id === 'upper' ? 'Upper row' : 'Lower row'}</span>}
                  <span className="grow" />
                  <Octave
                    octave={row.octave}
                    top={top}
                    middleC={middleC}
                    row={two ? row.id : undefined}
                    onChange={row.setOctave}
                  />
                </div>
              )}
              <Keyboard octave={row.octave} count={whiteCount} width={size.w} middleC={middleC} fingers={fingers} />
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

/** A row of keys: which octave it starts on, and how it's changed. */
interface KeyRow {
  id: 'upper' | 'lower';
  octave: number;
  setOctave: (octave: number) => void;
}

/** An octave down and up, with the C it starts on between them: the bar's, or a row's own. */
function Octave({
  octave,
  top,
  middleC,
  row,
  onChange,
}: {
  octave: number;
  /** The highest it goes. */
  top: number;
  middleC: MiddleC;
  /** The row it's for, where there are two. */
  row?: KeyRow['id'];
  onChange: (octave: number) => void;
}) {
  return (
    <>
      <button
        type="button"
        className="btn"
        aria-label={row ? `The ${row} row an octave down` : 'An octave down'}
        onClick={() => onChange(Math.max(0, octave - 1))}
      >
        −
      </button>
      <span className="mono">{noteName((octave + 1) * 12, middleC)}</span>
      <button
        type="button"
        className="btn"
        aria-label={row ? `The ${row} row an octave up` : 'An octave up'}
        onClick={() => onChange(Math.min(top, octave + 1))}
      >
        +
      </button>
    </>
  );
}

/** What a finger does on the keys: comes down on a note (null: off the keys), slides to another, lifts. */
interface Fingers {
  down(id: number, note: number | null, velocity: number): void;
  move(id: number, note: number | null, velocity: number): void;
  up(id: number): void;
}

/**
 * One keyboard: `count` white keys from the C of `octave`, across `width` px. It plays what a finger
 * does on it, as hard as the finger is high on its own keys, so each of two rows plays as one.
 */
function Keyboard({
  octave,
  count,
  width,
  middleC,
  fingers,
}: {
  octave: number;
  count: number;
  width: number;
  middleC: MiddleC;
  fingers: Fingers;
}) {
  const whites = whiteKeys(octave, count);
  const keyW = width / count;
  const at = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return [noteAt(whites, x, y, r.width, r.height), velocityAt(y, r.height)] as const;
  };
  return (
    <div
      className="keyboard"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // (a finger keeps to the row it came down on: a glissando doesn't slide into the other)
        e.currentTarget.setPointerCapture(e.pointerId);
        fingers.down(e.pointerId, ...at(e));
      }}
      onPointerMove={(e) => {
        // (a mouse passing over the keys plays nothing: only a pointer that came down on them)
        if (e.currentTarget.hasPointerCapture(e.pointerId)) fingers.move(e.pointerId, ...at(e));
      }}
      onPointerUp={(e) => fingers.up(e.pointerId)}
      onPointerCancel={(e) => fingers.up(e.pointerId)}
    >
      {/* the keys are drawn, and named for a screen reader; the surface above takes the touches */}
      {whites.map((n, i) => (
        <button
          key={n}
          type="button"
          tabIndex={-1}
          aria-label={noteName(n, middleC)}
          className="key white"
          data-note={n}
          style={{ left: i * keyW, width: keyW - 2 }}
        >
          {n % 12 === 0 ? noteName(n, middleC) : ''}
        </button>
      ))}
      {whites.map((n, i) =>
        BLACK.includes((n + 1) % 12) && i < whites.length - 1 ? (
          <button
            key={`b${n}`}
            type="button"
            tabIndex={-1}
            aria-label={noteName(n + 1, middleC)}
            className="key black"
            data-note={n + 1}
            style={{ left: (i + 1) * keyW - keyW * 0.3, width: keyW * 0.6 }}
          />
        ) : null,
      )}
    </div>
  );
}
