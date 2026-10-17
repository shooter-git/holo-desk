/** Pop-up menus: opened from code at a point (a button, a right-click, a long press). */
import { type ReactNode, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';

export type MenuEntry =
  | { label: string; onSelect: () => void; hint?: string; icon?: ReactNode; checked?: boolean; disabled?: boolean }
  | { heading: string }
  | 'sep';

interface Open {
  x: number;
  y: number;
  items: MenuEntry[];
}

let open: Open | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function openMenu(x: number, y: number, items: MenuEntry[]): void {
  open = { x, y, items };
  emit();
}

/** Open a menu under an element (a button that was clicked). */
export function openMenuAt(el: Element, items: MenuEntry[]): void {
  const r = el.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, items);
}

export function closeMenu(): void {
  open = null;
  emit();
}

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
    (el.querySelector('.item') as HTMLElement | null)?.focus({ preventScroll: true });
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeMenu();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('.item') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
        e.preventDefault();
      }
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
    <div className="menu" ref={ref} role="menu" style={{ left: state.x, top: state.y }}>
      {state.items.map((item, i) => {
        if (item === 'sep') return <div key={`s${i}`} className="sep" />;
        if ('heading' in item) {
          return (
            <div key={`h${i}`} className="heading">
              {item.heading}
            </div>
          );
        }
        return (
          <button
            key={`${item.label}${i}`}
            type="button"
            className="item"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              closeMenu();
              item.onSelect();
            }}
          >
            <span style={{ width: 14, display: 'inline-flex' }}>{item.checked ? '✓' : item.icon}</span>
            <span>{item.label}</span>
            {item.hint && <span className="hint">{item.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
