/**
 * View: show or hide the parts of the studio (panes, what the tracks and regions show, the mixer
 * strips' sections, the control bar's items), as Logic's View menu and its Customize Control Bar do.
 * The eye's menu in the control bar and Settings › View show the same options; each device remembers
 * its own choice.
 */
import { Eye } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { isPhone, useLayout } from '../app/layout.ts';
import { SHOW_DEFAULTS, type ShowKey, store, useApp } from '../app/store.ts';
import { PANES, paneOn, togglePane, viewGroups } from './view-options.ts';

/** The options themselves: the panes, then each group's parts, then a way back to everything. */
export function ViewOptions() {
  const show = useApp((s) => s.show);
  const panes = useApp((s) => PANES.map(([p]) => paneOn(s, p)).join(','));
  const phone = isPhone(useLayout());
  const hidden = Object.values(show).filter((v) => !v).length;
  const set = (key: ShowKey, on: boolean) => store.set({ show: { ...store.get().show, [key]: on } });
  const paneStates = panes.split(',');
  return (
    <div className="view-options">
      <div className="view-group">
        <div className="label">Panes</div>
        {PANES.map(([pane, name, key], i) => (
          <label key={pane} className="view-item">
            <input type="checkbox" checked={paneStates[i] === 'true'} onChange={() => togglePane(pane)} />
            <span className="grow">{name}</span>
            <kbd>{key}</kbd>
          </label>
        ))}
      </div>
      {viewGroups(phone).map(([group, items]) => (
        <div key={group} className="view-group">
          <div className="label">{group}</div>
          {items.map(([key, name]) => (
            <label key={key} className="view-item">
              <input type="checkbox" checked={show[key]} onChange={(e) => set(key, e.target.checked)} />
              <span className="grow">{name}</span>
            </label>
          ))}
        </div>
      ))}
      <div className="view-foot">
        <button
          type="button"
          className="btn"
          disabled={hidden === 0}
          onClick={() => store.set({ show: { ...SHOW_DEFAULTS } })}
        >
          Show everything
        </button>
      </div>
    </div>
  );
}

/** The eye in the control bar (a phone has its options in Settings › View): a click opens them under it. */
export function ViewMenu() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const hidden = useApp((s) => Object.values(s.show).filter((v) => !v).length);
  const labelId = useId();

  useEffect(() => {
    if (!open) return;
    // the keyboard goes to the first checkbox, and comes back to the button when the menu closes
    panel.current?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true });
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus({ preventScroll: true });
    };
    // the panel is placed under the button at open time: a resize moves the button
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

  const rect = button.current?.getBoundingClientRect();
  // it hangs under the button, kept on screen
  const place = (r: DOMRect) => {
    const width = Math.min(620, window.innerWidth - 16);
    const right = Math.max(8, Math.min(window.innerWidth - r.right - 4, window.innerWidth - 8 - width));
    return { top: r.bottom + 6, right };
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`btn icon ghost${open ? ' on' : ''}`}
        title={
          hidden ? `View: ${hidden} part${hidden === 1 ? '' : 's'} hidden` : 'View: show or hide parts of the studio'
        }
        aria-expanded={open}
        aria-haspopup="true"
        id={labelId}
        onClick={() => setOpen(!open)}
      >
        <Eye />
        {hidden > 0 && <span className="view-badge">{hidden}</span>}
      </button>
      {open && rect && (
        // biome-ignore lint/a11y/useSemanticElements: a fieldset brings its own box and sizing; this is a styled popover
        <div ref={panel} className="view-menu" role="group" aria-labelledby={labelId} style={place(rect)}>
          <ViewOptions />
        </div>
      )}
    </>
  );
}
