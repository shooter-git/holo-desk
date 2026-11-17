/** Pop-up menus: opened from code at a point (a button, a right-click, a long press). */
import { Check } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';

export type MenuEntry =
  | {
      label: string;
      onSelect: () => void;
      hint?: string;
      icon?: ReactNode;
      /** A color before the label (a track's), beside the check rather than in its place. */
      color?: string;
      checked?: boolean;
      disabled?: boolean;
      /** The keyboard starts here, scrolled into view, not on the first item (a long menu's middle). */
      focus?: boolean;
    }
  | { heading: string }
  | 'sep';

interface Open {
  x: number;
  y: number;
  items: MenuEntry[];
}

let open: Open | null = null;
/** What had the keyboard when the menu opened: it gets it back when the menu closes. */
let opener: Element | null = null;
/** The button the menu opened under: pressed again, it closes the menu (and doesn't open it again). */
let anchor: Element | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function openMenu(x: number, y: number, items: MenuEntry[]): void {
  if (!open) opener = document.activeElement;
  open = { x, y, items };
  anchor = null;
  emit();
}

/** Open a menu under an element (a button that was clicked). */
export function openMenuAt(el: Element, items: MenuEntry[]): void {
  const r = el.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, items);
  anchor = el;
}

/**
 * The click that ends a press is let go by: the press closed the menu from its own button. A
 * finger's tap clicks whatever is under it once the menu has gone, which is that button, and its
 * click would open the menu again. (A mouse's press doesn't click there, so the next press, or a
 * moment, ends the wait.)
 */
function swallowClick(): void {
  const stop = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    done();
  };
  const done = () => {
    window.clearTimeout(timer);
    window.removeEventListener('click', stop, true);
    window.removeEventListener('pointerdown', done, true);
  };
  const timer = window.setTimeout(done, 800);
  window.addEventListener('click', stop, true);
  // (added after this press's own listeners have run: it's the next press that ends the wait)
  window.setTimeout(() => window.addEventListener('pointerdown', done, true));
}

export function closeMenu(): void {
  if (!open) return;
  open = null;
  anchor = null;
  emit();
  const back = opener;
  opener = null;
  if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
}

const ITEMS = '.item:not(:disabled)';
const START = '.item[data-focus]:not(:disabled)';

export function MenuHost() {
  const state = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => open,
  );
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !state) return;
    // keep it on screen
    const r = el.getBoundingClientRect();
    const x = Math.max(6, Math.min(state.x, window.innerWidth - r.width - 6));
    const y = state.y + r.height > window.innerHeight - 6 ? Math.max(6, window.innerHeight - r.height - 6) : state.y;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    const start = el.querySelector<HTMLElement>(START) ?? el.querySelector<HTMLElement>(ITEMS);
    start?.focus({ preventScroll: true });
    // (the menu is its items' offset parent: it scrolls, the page doesn't)
    if (start && start.offsetTop + start.offsetHeight > el.clientHeight)
      el.scrollTop = start.offsetTop - (el.clientHeight - start.offsetHeight) / 2;
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const down = (e: PointerEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      // a press outside closes the menu and goes no further: the control under it isn't pressed as well
      e.preventDefault();
      e.stopPropagation();
      // (and on the menu's own button it's a toggle's second press: it closes the menu, and that's all)
      const r = anchor?.getBoundingClientRect();
      if (r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)
        swallowClick();
      closeMenu();
    };
    const key = (e: KeyboardEvent) => {
      const items = [...(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
      const i = items.indexOf(document.activeElement as HTMLElement);
      let to: HTMLElement | undefined;
      if (e.key === 'Escape' || e.key === 'Tab') {
        closeMenu();
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowDown') to = items[(i + 1) % items.length];
      else if (e.key === 'ArrowUp') to = items[(i - 1 + items.length) % items.length];
      else if (e.key === 'Home') to = items[0];
      else if (e.key === 'End') to = items[items.length - 1];
      else return;
      to?.focus();
      e.preventDefault();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [state]);

  if (!state) return null;
  return (
    <>
      {/* catches the press that closes the menu, so nothing under it is hit */}
      <div className="menu-backdrop" onPointerDown={closeMenu} />
      <div
        className="menu"
        ref={ref}
        role="menu"
        style={{ left: state.x, top: state.y }}
        onKeyDown={(e) => {
          // Enter and Space press the focused item; the studio's shortcuts (Return, Space) must not see them
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
        }}
      >
        {state.items.map((item, i) => {
          if (item === 'sep') return <hr key={`s${i}`} className="sep" />;
          if ('heading' in item) {
            return (
              <div key={`h${i}`} className="heading" role="presentation">
                {item.heading}
              </div>
            );
          }
          const radio = item.checked !== undefined;
          return (
            // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-checked goes with menuitemradio, the role set when checked is given
            <button
              key={`${item.label}${i}`}
              type="button"
              className="item"
              role={radio ? 'menuitemradio' : 'menuitem'}
              aria-checked={radio ? item.checked : undefined}
              disabled={item.disabled}
              data-focus={item.focus || undefined}
              onClick={() => {
                closeMenu();
                item.onSelect();
              }}
            >
              <span className="mark">{item.checked ? <Check size={13} aria-hidden="true" /> : item.icon}</span>
              {item.color && <span className="swatch" style={{ background: item.color }} />}
              <span>{item.label}</span>
              {item.hint && <span className="hint">{item.hint}</span>}
            </button>
          );
        })}
      </div>
    </>
  );
}
