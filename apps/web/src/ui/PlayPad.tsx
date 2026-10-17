/**
 * Play with your fingers: a keyboard (slide for glissandi, touch higher on a key to play harder)
 * and General MIDI drum pads. They send MIDI like any device, so they play, record and reach the AI
 * the same way.
 */
import { GM_DRUMS, type MiddleC, noteName } from '@holo/session';
import { useRef, useState } from 'react';
import { ensureAudio } from '../app/actions.ts';
import { sendMidi } from '../app/live.ts';
import { toast, useApp } from '../app/store.ts';
import { midi } from '../audio/midi.ts';
import { useSize } from './frame.ts';

const PORT = 'On-screen';
const PADS = [49, 51, 46, 42, 50, 47, 45, 43, 39, 37, 38, 36, 56, 54, 70, 75];
const BLACK = [1, 3, 6, 8, 10];

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
}

export function PlayPad({ onMidi, color: colorProp, middleC: middleCProp }: PlayPadProps = {}) {
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

  const whiteCount = size.w > 900 ? 21 : size.w > 560 ? 14 : 10;
  const whites: number[] = [];
  for (let n = (octave + 1) * 12; whites.length < whiteCount; n++) if (!BLACK.includes(n % 12)) whites.push(n);
  const keyW = size.w / whiteCount;

  const noteAt = (x: number, y: number): { note: number; vel: number } | null => {
    const h = size.h;
    const wi = Math.floor(x / keyW);
    const white = whites[wi];
    if (white === undefined) return null;
    if (y < h * 0.6) {
      // a black key's zone takes the edges between white keys
      const local = x - wi * keyW;
      const left = white - 1;
      const right = white + 1;
      if (local < keyW * 0.3 && BLACK.includes(((left % 12) + 12) % 12)) return { note: left, vel: 0 };
      if (local > keyW * 0.7 && BLACK.includes(right % 12)) return { note: right, vel: 0 };
    }
    return { note: white, vel: 0 };
  };

  const velocityFor = (y: number) => Math.round(40 + 87 * Math.min(1, Math.max(0, 1 - y / size.h)) ** 0.8);

  const update = () => setLit(new Set(touches.current.values()));

  return (
    <div className="playpad">
      <div className="pane-bar">
        <div className="seg">
          <button type="button" className={`btn${mode === 'keys' ? ' on' : ''}`} onClick={() => setMode('keys')}>
            Keyboard
          </button>
          <button type="button" className={`btn${mode === 'pads' ? ' on' : ''}`} onClick={() => setMode('pads')}>
            Drum pads
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
        {mode === 'keys' && (
          <>
            <button type="button" className="btn" onClick={() => setOctave((o) => Math.max(0, o - 1))}>
              −
            </button>
            <span className="mono">{noteName((octave + 1) * 12, middleC)}</span>
            <button type="button" className="btn" onClick={() => setOctave((o) => Math.min(7, o + 1))}>
              +
            </button>
          </>
        )}
      </div>
      {mode === 'pads' ? (
        <div className="pads" style={{ alignContent: 'center' }}>
          {PADS.map((n) => (
            <div
              key={n}
              className={`pad${lit.has(n) ? ' hit' : ''}`}
              style={{ ['--pad-color' as string]: color, ['--pad-glow' as string]: `${color}88` }}
              onPointerDown={(e) => {
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
              {GM_DRUMS[n] ?? n}
            </div>
          ))}
        </div>
      ) : (
        <div
          ref={box}
          className="keyboard"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            wake();
            const r = e.currentTarget.getBoundingClientRect();
            const hit = noteAt(e.clientX - r.left, e.clientY - r.top);
            if (!hit) return;
            touches.current.set(e.pointerId, hit.note);
            update();
            play(0x90, hit.note, velocityFor(e.clientY - r.top));
          }}
          onPointerMove={(e) => {
            const held = touches.current.get(e.pointerId);
            if (held === undefined) return;
            const r = e.currentTarget.getBoundingClientRect();
            const hit = noteAt(e.clientX - r.left, e.clientY - r.top);
            if (!hit || hit.note === held) return;
            play(0x80, held, 0);
            touches.current.set(e.pointerId, hit.note);
            update();
            play(0x90, hit.note, velocityFor(e.clientY - r.top));
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
          {whites.map((n, i) => (
            <div
              key={n}
              style={{
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
            </div>
          ))}
          {whites.map((n, i) =>
            BLACK.includes((n + 1) % 12) && i < whites.length - 1 ? (
              <div
                key={`b${n}`}
                style={{
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
