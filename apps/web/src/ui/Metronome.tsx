/**
 * The metronome button, and what it sounds like: a click toggles it; a right-click (or a finger held
 * on it) opens its sound, volume and count-in. Settings has the same controls.
 */
import type { ClickSound } from '@holo/engine';
import { Metronome } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { setMetronomeLevel, setMetronomeSound, syncMetronome, toggleMetronome } from '../app/actions.ts';
import { isPhone, useLayout } from '../app/layout.ts';
import { store, useApp } from '../app/store.ts';
import { LONG_PRESS_MS } from './gesture.ts';

const SOUNDS: [ClickSound, string][] = [
  ['beep', 'Beep'],
  ['wood', 'Woodblock'],
  ['stick', 'Sticks'],
  ['soft', 'Soft'],
];

const COUNT_IN: [number, string][] = [
  [0, 'Off'],
  [1, '1 bar'],
  [2, '2 bars'],
];

/** The metronome's sound, volume and count-in (each choice heard as it's made). */
export function MetronomeSettings() {
  const on = useApp((s) => s.metronome);
  const sound = useApp((s) => s.metronomeSound);
  const level = useApp((s) => s.metronomeLevel);
  const countIn = useApp((s) => s.countIn);
  const volume = Math.round(level * 100);
  const slider = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // React's onChange is every step of a drag; the element's own change is the slider let go (or a key's
    // step): then a click plays at the new level
    const el = slider.current;
    const hear = () => syncMetronome(true);
    el?.addEventListener('change', hear);
    return () => el?.removeEventListener('change', hear);
  }, []);
  return (
    <div className="vstack metro-settings">
      <label className="hstack">
        <input type="checkbox" checked={on} onChange={toggleMetronome} />
        Click while playing
        <kbd>K</kbd>
      </label>
      <div className="vstack">
        <span className="muted">Sound</span>
        <div className="seg" role="radiogroup" aria-label="Metronome sound">
          {SOUNDS.map(([s, name]) => (
            // biome-ignore lint/a11y/useSemanticElements: the studio's segmented buttons, as a radio group
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={sound === s}
              className={`btn${sound === s ? ' on' : ''}`}
              onClick={() => setMetronomeSound(s)}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
      <label className="vstack">
        <span className="hstack">
          <span className="muted grow">Volume</span>
          <span className="mono">{volume}%</span>
        </span>
        <input
          ref={slider}
          type="range"
          min={0}
          max={100}
          value={volume}
          aria-label="Metronome volume"
          style={{ accentColor: '#5cb8ff' }}
          onChange={(e) => setMetronomeLevel(Number(e.currentTarget.value) / 100)}
        />
      </label>
      <div className="vstack">
        <span className="muted">Count-in when recording</span>
        <div className="seg" role="radiogroup" aria-label="Count-in when recording">
          {COUNT_IN.map(([bars, name]) => (
            // biome-ignore lint/a11y/useSemanticElements: the studio's segmented buttons, as a radio group
            <button
              key={bars}
              type="button"
              role="radio"
              aria-checked={countIn === bars}
              className={`btn${countIn === bars ? ' on' : ''}`}
              onClick={() => store.set({ countIn: bars })}
            >
              {name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The metronome button in the control bar: a click toggles it, a right-click or long press opens its settings. */
export function MetronomeButton({ className, title }: { className: string; title: string }) {
  const on = useApp((s) => s.metronome);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const held = useRef<{ timer: number; fired: boolean } | null>(null);
  const labelId = useId();
  const sheet = isPhone(useLayout());

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus({ preventScroll: true });
    };
    // placed under the button as it opens: a resize (or a turn of the phone) moves the button
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const letGo = () => {
    if (held.current) clearTimeout(held.current.timer);
  };
  const rect = button.current?.getBoundingClientRect();
  const place = (r: DOMRect) => {
    const width = Math.min(320, window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8));
    return { top: r.bottom + 6, left };
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`${className}${on ? ' on' : ''}`}
        title={`${title}. Right-click for its sound, volume and count-in`}
        aria-label={title}
        aria-pressed={on}
        aria-haspopup="true"
        aria-expanded={open}
        id={labelId}
        onClick={() => {
          // a finger held on it opened the settings: lifting it isn't a click as well
          if (held.current?.fired) {
            held.current = null;
            return;
          }
          toggleMetronome();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          letGo();
          held.current = null;
          setOpen(true);
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== 'touch') return;
          letGo();
          const press = {
            fired: false,
            timer: window.setTimeout(() => {
              press.fired = true;
              setOpen(true);
            }, LONG_PRESS_MS),
          };
          held.current = press;
        }}
        onPointerUp={letGo}
        onPointerCancel={letGo}
        onPointerLeave={letGo}
      >
        <Metronome />
      </button>
      {open && rect && (
        // biome-ignore lint/a11y/useSemanticElements: a fieldset brings its own box and sizing; this is a styled popover
        <div
          ref={panel}
          className={`metro-menu${sheet ? ' sheet' : ''}`}
          role="group"
          aria-labelledby={labelId}
          style={sheet ? undefined : place(rect)}
        >
          <div className="label">Metronome</div>
          <MetronomeSettings />
        </div>
      )}
    </>
  );
}
