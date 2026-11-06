/**
 * Play with your fingers: a keyboard (slide for glissandi, touch higher on a key to play harder)
 * and General MIDI drum pads. They send MIDI like any device, so they play, record and reach the AI
 * the same way.
 */
import { type Instrument, type MiddleC, noteName } from '@holo/session';
import { useEffect, useRef, useState } from 'react';
import { ensureAudio } from '../app/actions.ts';
import { sendMidi } from '../app/live.ts';
import { toast, useApp } from '../app/store.ts';
import { midi } from '../audio/midi.ts';
import { type InstrumentMap, instrumentManifest } from '../audio/pack-files.ts';
import { useMedia, useSize } from './frame.ts';
import { padManifestKey, padsFor, padTrack } from './pads.ts';

const PORT = 'On-screen';
/** The pads' channel (General MIDI's drums). */
const PAD_CHANNEL = 10;
/** A short landscape screen: the pads in rows of eight, so each keeps a finger's height. */
const WIDE_PADS = '(orientation: landscape) and (max-height: 540px)';
/** The highest octave the chromatic pads start on (their sixteen notes stay within MIDI). */
const PAD_TOP_OCTAVE = 8;
const BLACK = [1, 3, 6, 8, 10];
/** Semitones from C of the white keys in an octave. */
const WHITES = [0, 2, 4, 5, 7, 9, 11];

/** The highest octave whose keyboard of `whiteCount` keys stays within MIDI (G9 is note 127). */
function topOctave(whiteCount: number): number {
  const last = whiteCount - 1;
  const span = 12 * Math.floor(last / 7) + (WHITES[last % 7] ?? 0);
  return Math.min(7, Math.floor((127 - span) / 12) - 1);
}

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
  const others = useApp((s) => Math.max(0, s.peers.filter((p) => p.role === 'editor').length - 1));
  const [octave, setOctave] = useState(4);
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
  const [lit, setLit] = useState<Set<number>>(new Set());
  const touches = useRef(new Map<number, number>());

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
  const whites: number[] = [];
  for (let n = (shownOctave + 1) * 12; whites.length < whiteCount; n++) if (!BLACK.includes(n % 12)) whites.push(n);
  const keyW = size.w / whiteCount;

  const noteAt = (x: number, y: number): number | null => {
    const h = size.h;
    const wi = Math.floor(x / keyW);
    const white = whites[wi];
    if (white === undefined) return null;
    if (y < h * 0.6) {
      // a black key's zone takes the edges between white keys
      const local = x - wi * keyW;
      const left = white - 1;
      const right = white + 1;
      if (local < keyW * 0.3 && BLACK.includes(((left % 12) + 12) % 12)) return left;
      if (local > keyW * 0.7 && BLACK.includes(right % 12)) return right;
    }
    return white;
  };

  const velocityFor = (y: number) => Math.round(40 + 87 * Math.min(1, Math.max(0, 1 - y / size.h)) ** 0.8);

  const update = () => setLit(new Set(touches.current.values()));

  return (
    <div className="playpad">
      <div className="pane-bar">
        <div className="seg">
          {/* short names: on a phone the bar holds these, where the notes go, and the octave */}
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
        <span className="grow" />
        {(mode === 'keys' || grid.chromatic) && (
          <>
            <button
              type="button"
              className="btn"
              aria-label="An octave down"
              onClick={() => setOctave(Math.max(0, shownOctave - 1))}
            >
              −
            </button>
            <span className="mono">{noteName((shownOctave + 1) * 12, middleC)}</span>
            <button
              type="button"
              className="btn"
              aria-label="An octave up"
              onClick={() => setOctave(Math.min(top, shownOctave + 1))}
            >
              +
            </button>
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
              aria-pressed={lit.has(n)}
              className={`pad${lit.has(n) ? ' hit' : ''}`}
              style={{ ['--pad-color' as string]: color }}
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
        <div
          ref={box}
          className="keyboard"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            wake();
            const r = e.currentTarget.getBoundingClientRect();
            const hit = noteAt(e.clientX - r.left, e.clientY - r.top);
            if (hit === null) return;
            touches.current.set(e.pointerId, hit);
            update();
            play(0x90, hit, velocityFor(e.clientY - r.top));
          }}
          onPointerMove={(e) => {
            const held = touches.current.get(e.pointerId);
            if (held === undefined) return;
            const r = e.currentTarget.getBoundingClientRect();
            const hit = noteAt(e.clientX - r.left, e.clientY - r.top);
            if (hit === null || hit === held) return;
            play(0x80, held, 0);
            touches.current.set(e.pointerId, hit);
            update();
            play(0x90, hit, velocityFor(e.clientY - r.top));
          }}
          onPointerUp={(e) => {
            const held = touches.current.get(e.pointerId);
            touches.current.delete(e.pointerId);
            update();
            if (held !== undefined) play(0x80, held, 0);
          }}
          onPointerCancel={(e) => {
            const held = touches.current.get(e.pointerId);
            touches.current.delete(e.pointerId);
            update();
            if (held !== undefined) play(0x80, held, 0);
          }}
        >
          {/* the keys are drawn, and named for a screen reader; the surface above takes the touches */}
          {whites.map((n, i) => (
            <button
              key={n}
              type="button"
              tabIndex={-1}
              aria-label={noteName(n, middleC)}
              style={{
                all: 'unset',
                position: 'absolute',
                left: i * keyW,
                top: 0,
                width: keyW - 2,
                bottom: 0,
                borderRadius: '0 0 8px 8px',
                background: lit.has(n)
                  ? `linear-gradient(180deg, #fff, ${color})`
                  : 'linear-gradient(180deg, #e6e9ee, #fbfcfd 85%, #d6dae0)',
                boxShadow: 'inset 0 -4px 0 rgba(0,0,0,0.12), 0 2px 3px rgba(0,0,0,0.5)',
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'center',
                paddingBottom: 8,
                color: '#5b636f',
                fontSize: 11,
                fontWeight: 600,
                pointerEvents: 'none',
              }}
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
                style={{
                  all: 'unset',
                  position: 'absolute',
                  left: (i + 1) * keyW - keyW * 0.3,
                  top: 0,
                  width: keyW * 0.6,
                  height: '60%',
                  borderRadius: '0 0 6px 6px',
                  background: lit.has(n + 1) ? color : 'linear-gradient(180deg, #1a1d22, #33383f 90%, #1a1d22)',
                  boxShadow: '0 3px 6px rgba(0,0,0,0.6), inset 0 -3px 0 rgba(255,255,255,0.06)',
                  pointerEvents: 'none',
                }}
              />
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
