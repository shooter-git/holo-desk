/**
 * The View menu: show or hide the parts of the studio (panes, what the tracks and regions show, the
 * mixer strips' sections, the control bar's items), as Logic's View menu and its Customize Control
 * Bar do. Each device remembers its own choice.
 */
import { Eye } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { isPhone, useLayout } from '../app/layout.ts';
import { SHOW_DEFAULTS, type ShowKey, store, useApp } from '../app/store.ts';

type Pane = 'library' | 'inspector' | 'editor' | 'mixer' | 'automation';

const PANES: [Pane, string, string][] = [
  ['library', 'Library', 'Y'],
  ['inspector', 'Inspector', 'I'],
  ['editor', 'Piano Roll / Audio Editor', 'P'],
  ['mixer', 'Mixer', 'X'],
  ['automation', 'Automation lanes', 'A'],
];

const GROUPS: [string, [ShowKey, string][]][] = [
  [
    'Tracks',
    [
      ['trackIcons', 'Track icons'],
      ['trackSub', 'Instrument or input under the name'],
      ['trackButtons', 'Mute, solo and record buttons'],
      ['regionNames', 'Region names'],
      ['regionContents', 'Notes and waveforms in regions'],
      ['gridLines', 'Grid lines'],
      ['markers', 'Markers'],
    ],
  ],
  [
    'Mixer strips',
    [
      ['stripInstrument', 'Instrument or input'],
      ['stripMidiFx', 'MIDI effects'],
      ['stripAudioFx', 'Audio effects'],
      ['stripSends', 'Sends'],
      ['stripStage', 'Stage'],
      ['stripOutput', 'Output'],
      ['stripPan', 'Pan'],
    ],
  ],
  [
    'Control bar',
    [
      ['barNav', 'Back and forward buttons'],
      ['barTime', 'Time'],
      ['barSig', 'Time signature'],
      ['barKey', 'Key'],
      ['barMetronome', 'Metronome'],
      ['barTyping', 'Musical Typing'],
      ['barMidi', 'MIDI devices'],
      ['barDsp', 'DSP load'],
      ['barRemote', 'Remote'],
      ['barFullscreen', 'Full screen'],
    ],
  ],
];

function paneOn(s: ReturnType<typeof store.get>, pane: Pane): boolean {
  if (pane === 'library') return s.library;
  if (pane === 'inspector') return s.inspector;
  if (pane === 'editor') return s.editor === 'piano';
  if (pane === 'mixer') return s.editor === 'mixer';
  return s.automationView;
}

function togglePane(pane: Pane): void {
  const s = store.get();
  if (pane === 'library') store.set({ library: !s.library });
  else if (pane === 'inspector') store.set({ inspector: !s.inspector });
  else if (pane === 'editor') store.set({ editor: s.editor === 'piano' ? null : 'piano' });
  else if (pane === 'mixer') store.set({ editor: s.editor === 'mixer' ? null : 'mixer' });
  else store.set({ automationView: !s.automationView });
}

export function ViewMenu() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const show = useApp((s) => s.show);
  const panes = useApp((s) => PANES.map(([p]) => paneOn(s, p)).join(','));
  const hidden = Object.values(show).filter((v) => !v).length;
  const labelId = useId();
  // on a phone the panel is a sheet from the bottom; elsewhere it hangs under the button, kept on screen
  const sheet = isPhone(useLayout());

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
    // the panel is placed under the button at open time: a resize (or a turn of the phone) moves the button
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
  const place = (r: DOMRect) => {
    const width = Math.min(620, window.innerWidth - 16);
    const right = Math.max(8, Math.min(window.innerWidth - r.right - 4, window.innerWidth - 8 - width));
    return { top: r.bottom + 6, right };
  };
  const set = (key: ShowKey, on: boolean) => store.set({ show: { ...store.get().show, [key]: on } });
  const paneStates = panes.split(',');
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
        <div
          ref={panel}
          className={`view-menu${sheet ? ' sheet' : ''}`}
          role="group"
          aria-labelledby={labelId}
          style={sheet ? undefined : place(rect)}
        >
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
          {GROUPS.map(([group, items]) => (
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
      )}
    </>
  );
}
