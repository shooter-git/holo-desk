/**
 * The View menu: show or hide the parts of the studio (panes, what the tracks and regions show, the
 * mixer strips' sections, the control bar's items), as Logic's View menu and its Customize Control
 * Bar do. Each device remembers its own choice.
 */
import { Eye } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const rect = button.current?.getBoundingClientRect();
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
        onClick={() => setOpen(!open)}
      >
        <Eye />
        {hidden > 0 && <span className="view-badge">{hidden}</span>}
      </button>
      {open && rect && (
        <div
          ref={panel}
          className="view-menu"
          role="dialog"
          aria-label="View"
          style={{ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right - 4) }}
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
