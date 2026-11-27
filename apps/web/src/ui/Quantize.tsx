/**
 * Quantize, and how it quantizes: the Q button with, beside it, its strength (how far each note
 * goes toward the grid) and its swing (how late every other step falls). Both are this device's,
 * and every Quantize in the studio goes by them: the button, Q, the menus, the Inspector.
 */
import { MAX_SWING, swings } from '@holo/agent/edits';
import { DIVISIONS, PPQ } from '@holo/session';
import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { quantizeSelection } from '../app/actions.ts';
import { isPhone, useLayout } from '../app/layout.ts';
import { store, useApp } from '../app/store.ts';

const MOST_SWING = Math.round(MAX_SWING * 100);

/** "at 80%, swung 30%": how Quantize is set, when it isn't a plain one. */
export function quantizeHint(strength: number, swing: number, grid: string): string {
  const swung = swing > 0 && swings(DIVISIONS[grid] ?? PPQ / 4);
  return [strength < 100 ? `${strength}%` : '', swung ? `swing ${swing}%` : ''].filter(Boolean).join(', ');
}

/** Strength and swing, and Quantize itself. `onDone`: told once it has quantized (a sheet closes). */
export function QuantizeOptions({ onDone }: { onDone?: () => void }) {
  const grid = useApp((s) => s.grid);
  const strength = useApp((s) => s.quantStrength);
  const swing = useApp((s) => s.quantSwing);
  const canSwing = swings(DIVISIONS[grid] ?? PPQ / 4);
  const plain = strength === 100 && swing === 0;
  return (
    <div className="vstack quant-settings">
      <label className="vstack">
        <span className="hstack">
          <span className="muted grow">Strength</span>
          <span className="mono">{strength}%</span>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={strength}
          aria-label="Quantize strength"
          style={{ accentColor: '#5cb8ff' }}
          onChange={(e) => store.set({ quantStrength: Number(e.currentTarget.value) })}
        />
      </label>
      <label className="vstack">
        <span className="hstack">
          <span className="muted grow">Swing</span>
          <span className="mono">{canSwing ? `${swing}%` : 'none'}</span>
        </span>
        <input
          type="range"
          min={0}
          max={MOST_SWING}
          step={1}
          value={canSwing ? swing : 0}
          disabled={!canSwing}
          aria-label="Quantize swing"
          style={{ accentColor: '#5cb8ff' }}
          onChange={(e) => store.set({ quantSwing: Number(e.currentTarget.value) })}
        />
      </label>
      <span className="muted quant-note">
        {canSwing
          ? `Every other ${grid} note falls late. About 67% is a triplet feel.`
          : `A ${grid} grid doesn’t swing: 1/8 and 1/16 do.`}
      </span>
      <div className="hstack">
        <button
          type="button"
          className="btn"
          disabled={plain}
          onClick={() => store.set({ quantStrength: 100, quantSwing: 0 })}
        >
          Reset
        </button>
        <span className="grow" />
        <button
          type="button"
          className="btn primary"
          onClick={() => {
            quantizeSelection();
            onDone?.();
          }}
        >
          Quantize
        </button>
      </div>
    </div>
  );
}

/** The panel, under `anchor` or as a phone's sheet, closed by a press outside it or Escape. */
export function QuantizePanel({ anchor, onClose }: { anchor: HTMLElement | null; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const sheet = isPhone(useLayout());
  const labelId = useId();
  // (as it opens only: a slider moved draws it again, and the slider keeps the keyboard)
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !anchor?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onClose();
      anchor?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    // placed under its button as it opens: a resize (or a turn of the phone) moves the button
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);
  const r = anchor?.getBoundingClientRect();
  const width = Math.min(300, window.innerWidth - 16);
  const place =
    sheet || !r
      ? undefined
      : { top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), width };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings its own box and sizing; this is a styled popover
    <div
      ref={panel}
      className={`metro-menu quant-menu${sheet || !r ? ' sheet' : ''}`}
      role="group"
      aria-labelledby={labelId}
      style={place}
    >
      <div className="label" id={labelId}>
        Quantize
      </div>
      <QuantizeOptions onDone={sheet || !r ? onClose : undefined} />
    </div>
  );
}

/** Q, and beside it the arrow that opens its strength and swing. */
export function QuantizeButton() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const group = useRef<HTMLDivElement>(null);
  const grid = useApp((s) => s.grid);
  const hint = quantizeHint(
    useApp((s) => s.quantStrength),
    useApp((s) => s.quantSwing),
    grid,
  );
  return (
    <>
      <div className="seg quant-seg" ref={group}>
        <button
          type="button"
          className="btn"
          title={`Quantize the selection (Q)${hint ? `: ${hint}` : ''}`}
          aria-label="Quantize the selection"
          onClick={quantizeSelection}
        >
          Q{hint && <span className="quant-dot" aria-hidden="true" />}
        </button>
        <button
          type="button"
          className={`btn icon quant-more${open ? ' on' : ''}`}
          title="Quantize strength and swing"
          aria-label="Quantize strength and swing"
          aria-haspopup="true"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronDown />
        </button>
      </div>
      {open && <QuantizePanel anchor={group.current} onClose={close} />}
    </>
  );
}
