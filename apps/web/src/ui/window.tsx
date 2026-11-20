/**
 * What the instrument and plugin windows are made of: the floating window itself (a sheet on a
 * phone) and a setting in it, a knob or a button of names.
 */
import type { ParamDef } from '@holo/session';
import { ChevronDown } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Knob, startDrag } from './controls.tsx';
import { openMenuAt } from './menu.tsx';

/** The window's size, so a floating window stays on screen when it changes (a window resized, a phone turned). */
export function useViewport(): { w: number; h: number } {
  const [v, setV] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () =>
      setV((s) =>
        s.w === window.innerWidth && s.h === window.innerHeight ? s : { w: window.innerWidth, h: window.innerHeight },
      );
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('orientationchange', on);
    };
  }, []);
  return v;
}

/**
 * A plugin's or a stage's window: it floats where it was put (its header drags it), and on a
 * phone it is a sheet up from the bottom, with a scrim behind it that closes it. Keyed by what
 * it shows, so a new one opens centered and takes the keyboard; closing gives the keyboard back.
 */
export function Floating({
  width,
  phone,
  className,
  label,
  header,
  onClose,
  children,
}: {
  width: number;
  phone: boolean;
  className?: string;
  label: string;
  header: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const vp = useViewport();
  const win = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => ({
    x: Math.max(8, window.innerWidth / 2 - width / 2),
    y: Math.max(60, window.innerHeight / 2 - 220),
  }));
  // it opens whole, and stays so as it grows (a kit's pads page opened, its deeper settings shown): a
  // window taller than the room under it moves up to fit
  useLayoutEffect(() => {
    const el = win.current;
    if (!el) return;
    const fit = () => {
      const h = el.offsetHeight;
      setPos((p) => {
        const y = Math.max(8, Math.min(p.y, window.innerHeight - h - 8));
        return y === p.y ? p : { ...p, y };
      });
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  useEffect(() => {
    const before = document.activeElement;
    win.current?.focus({ preventScroll: true });
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  // kept on screen however the window was left (a smaller window, a phone turned)
  const left = Math.max(0, Math.min(vp.w - 120, pos.x));
  const top = Math.max(0, Math.min(vp.h - 40, pos.y));
  return (
    <>
      {phone && <button type="button" className="sheet-scrim" aria-label="Close" tabIndex={-1} onClick={onClose} />}
      <div
        ref={win}
        className={`plugin-window${phone ? ' sheet' : ''}${className ? ` ${className}` : ''}`}
        style={phone ? undefined : { left, top, width }}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          onClose();
        }}
      >
        <header
          onPointerDown={(e) => {
            if (phone || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
            const el = win.current;
            if (!el) return;
            // the window follows the pointer as a transform, and its place is kept once it's let go
            let tx = 0;
            let ty = 0;
            startDrag(e, {
              onMove: (dx, dy) => {
                tx += dx;
                ty += dy;
                el.style.transform = `translate(${tx}px, ${ty}px)`;
              },
              onEnd: () => {
                el.style.transform = '';
                setPos({ x: left + tx, y: top + ty });
              },
            });
          }}
        >
          {header}
        </header>
        <div className="plugin-body">{children}</div>
      </div>
    </>
  );
}

export interface SettingProps {
  def: ParamDef;
  value: number;
  onBegin: () => void;
  onEnd: () => void;
  onChange: (v: number) => void;
  color?: string;
  size?: number;
  label?: string;
}

/**
 * One of a window's settings. A number is a knob. A setting that is one of a few names is a button:
 * with two or three it goes round them, with more it opens a menu of them, since a knob swept
 * through names shows one at a time and none of the others.
 */
export function Setting({ def, value, onBegin, onEnd, onChange, color, size, label }: SettingProps) {
  const options = def.options;
  if (!options)
    return (
      <Knob
        def={def}
        value={value}
        onBegin={onBegin}
        onEnd={onEnd}
        onChange={onChange}
        color={color}
        size={size}
        label={label}
      />
    );
  const at = Math.round(value);
  const set = (v: number) => {
    if (v === at) return;
    onBegin();
    onChange(v);
    onEnd();
  };
  const few = options.length <= 3;
  // (names too long for a knob's width, an organ's drawbars, have two)
  const wide = !few && options.some((o) => o.length > 8);
  return (
    <div className={`knob choice${wide ? ' wide' : ''}`}>
      <button
        type="button"
        className={`btn${few ? (value >= 0.5 ? ' on' : '') : ' choice-menu'}`}
        aria-haspopup={few ? undefined : 'menu'}
        aria-label={`${def.name}: ${options[at] ?? at}`}
        onClick={(e) =>
          few
            ? set((at + 1) % options.length)
            : openMenuAt(
                e.currentTarget,
                options.map((name, i) => ({ label: name, checked: i === at, focus: i === at, onSelect: () => set(i) })),
              )
        }
      >
        <span className="grow">{options[at] ?? at}</span>
        {!few && <ChevronDown size={12} aria-hidden="true" />}
      </button>
      <span className="knob-label">{label ?? def.name}</span>
    </div>
  );
}
