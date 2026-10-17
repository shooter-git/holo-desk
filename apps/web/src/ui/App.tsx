/** The studio's frame: the desktop layout, the tablet's, and the phone's (portrait and landscape). */
import { Library as LibraryIcon, Music2, Piano, Rows3, SlidersVertical } from 'lucide-react';
import { useEffect } from 'react';
import { ensureAudio, resolveConflict } from '../app/actions.ts';
import { isPhone, type Layout, useLayout } from '../app/layout.ts';
import { type MobileTab, store, useApp } from '../app/store.ts';
import { AudioEditor, AudioEditorBar } from './AudioEditor.tsx';
import { ControlBar, Lcd, TransportButtons } from './ControlBar.tsx';
import { Wordmark } from './controls.tsx';
import { Dialogs } from './Dialogs.tsx';
import { Mixer, PluginWindow, StageWindow } from './Mixer.tsx';
import { MenuHost } from './menu.tsx';
import { Inspector, LibraryPanel } from './Panels.tsx';
import { PianoRoll, PianoRollBar } from './PianoRoll.tsx';
import { PlayPad } from './PlayPad.tsx';
import { TracksArea } from './Tracks.tsx';

/** The selected track's editor: the Piano Roll, or the Audio Editor for an audio track. */
function useAudioSelected(): boolean {
  return useApp((s) => s.project?.tracks.find((t) => t.id === s.selectedTrack)?.kind === 'audio');
}

function EditorPane() {
  const editor = useApp((s) => s.editor);
  const height = useApp((s) => s.editorHeight);
  const audio = useAudioSelected();
  if (!editor) return null;
  const editorName = audio ? 'Audio Editor' : 'Piano Roll';
  return (
    <section className="editor-pane" style={{ height }} aria-label={editor === 'piano' ? editorName : 'Mixer'}>
      <div
        className="splitter"
        title="Drag to resize"
        onPointerDown={(e) => {
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          let h = height;
          let y = e.clientY;
          const move = (ev: PointerEvent) => {
            h = Math.max(140, Math.min(window.innerHeight - 180, h - (ev.clientY - y)));
            y = ev.clientY;
            store.set({ editorHeight: Math.round(h) });
          };
          const up = () => {
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
          };
          el.addEventListener('pointermove', move);
          el.addEventListener('pointerup', up);
        }}
      />
      <div className="pane-bar">
        {editor === 'piano' ? (
          audio ? (
            <AudioEditorBar />
          ) : (
            <PianoRollBar />
          )
        ) : (
          <>
            <span className="title">Mixer</span>
            <span className="grow" />
          </>
        )}
        <div className="seg">
          <button
            type="button"
            className={`btn${editor === 'piano' ? ' on' : ''}`}
            onClick={() => store.set({ editor: 'piano' })}
          >
            {editorName}
          </button>
          <button
            type="button"
            className={`btn${editor === 'mixer' ? ' on' : ''}`}
            onClick={() => store.set({ editor: 'mixer' })}
          >
            Mixer
          </button>
        </div>
      </div>
      {editor === 'piano' ? audio ? <AudioEditor /> : <PianoRoll /> : <Mixer />}
    </section>
  );
}

function Banners() {
  const save = useApp((s) => s.saveState);
  const connection = useApp((s) => s.connection);
  if (connection === 'offline') {
    return (
      <div
        className="banner"
        role="status"
        style={{ background: 'linear-gradient(90deg, #3a1d22, #2a1619)', color: '#ffd6da' }}
      >
        <span className="status-dot bad" />
        <span className="grow">
          Can’t reach HO[LO] on {location.hostname}. Keep working: your changes are kept here and saved when it’s back.
        </span>
      </div>
    );
  }
  // always an element, so the layout's rows stay where they are
  if (save !== 'conflict') return <div />;
  return (
    <div className="banner" role="alert">
      <span className="grow">This song was changed somewhere else while you were editing it.</span>
      <button type="button" className="btn" onClick={() => void resolveConflict('theirs')}>
        Load the other version
      </button>
      <button type="button" className="btn primary" onClick={() => void resolveConflict('mine')}>
        Keep mine
      </button>
    </div>
  );
}

function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

function BounceStatus() {
  const text = useApp((s) => s.bouncing);
  if (!text) return null;
  return (
    <div className="toasts" style={{ bottom: 'calc(64px + var(--safe-bottom))' }} aria-live="polite">
      <div className="toast" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="status-dot busy" />
        {text}
      </div>
    </div>
  );
}

function StartAudio() {
  const ready = useApp((s) => s.audioReady);
  if (ready) return null;
  return (
    <div className="start-audio">
      <div className="card">
        <img className="start-icon" src="/icons/icon-192.png" alt="" />
        <h1>
          <Wordmark desk />
        </h1>
        <p className="start-what">A studio for writing, recording and mixing music</p>
        <p className="start-tag">Headphones On [Lights Out]</p>
        <button
          type="button"
          className="btn primary"
          style={{ height: 40, padding: '0 22px', fontSize: 14 }}
          onClick={() => void ensureAudio()}
        >
          Start the studio
        </button>
        <p style={{ fontSize: 11 }}>Starts the audio and asks to use your MIDI devices.</p>
      </div>
    </div>
  );
}

const TABS: [MobileTab, string, typeof Rows3][] = [
  ['tracks', 'Tracks', Rows3],
  ['editor', 'Piano Roll', Piano],
  ['mixer', 'Mixer', SlidersVertical],
  ['play', 'Play', Music2],
  ['library', 'Library', LibraryIcon],
];

function TabBar() {
  const tab = useApp((s) => s.mobileTab);
  const audio = useAudioSelected();
  return (
    <nav className="tabbar" aria-label="Views">
      {TABS.map(([id, label, Icon]) => (
        <button
          key={id}
          type="button"
          className={tab === id ? 'active' : ''}
          onClick={() => store.set({ mobileTab: id })}
          aria-current={tab === id}
        >
          <Icon />
          {id === 'editor' && audio ? 'Editor' : label}
        </button>
      ))}
    </nav>
  );
}

function PhoneView() {
  const tab = useApp((s) => s.mobileTab);
  const audio = useAudioSelected();
  if (tab === 'editor') {
    return (
      <div className="phone-view" style={{ gridTemplateRows: 'auto minmax(0,1fr)' }}>
        <div className="pane-bar" style={{ height: 44 }}>
          {audio ? <AudioEditorBar /> : <PianoRollBar />}
        </div>
        {audio ? <AudioEditor /> : <PianoRoll />}
      </div>
    );
  }
  if (tab === 'mixer') {
    return (
      <div className="phone-view">
        <Mixer />
      </div>
    );
  }
  if (tab === 'play') {
    return (
      <div className="phone-view">
        <PlayPad />
      </div>
    );
  }
  if (tab === 'library') {
    return (
      <div className="phone-view" style={{ overflowY: 'auto' }}>
        <LibraryPanel full />
      </div>
    );
  }
  return (
    <div className="phone-view">
      <TracksArea />
    </div>
  );
}

function PhoneLayout({ layout }: { layout: Layout }) {
  if (layout === 'phone-landscape') {
    return (
      <div className="app phone phone-landscape">
        <aside className="side-rail">
          <TabBar />
        </aside>
        <div
          style={{
            display: 'grid',
            gridTemplateRows: 'auto auto minmax(0,1fr)',
            minHeight: 0,
            paddingTop: 'var(--safe-top)',
            paddingRight: 'var(--safe-right)',
          }}
        >
          <div className="phone-transport" style={{ borderBottom: '1px solid var(--line)', background: 'var(--bg-3)' }}>
            <TransportButtons minimal />
            <Lcd compact />
          </div>
          <Banners />
          <PhoneView />
        </div>
      </div>
    );
  }
  return (
    <div className="app phone" style={{ gridTemplateRows: 'auto auto minmax(0,1fr) auto' }}>
      <ControlBar />
      <Banners />
      <PhoneView />
      <div className="phone-dock">
        <div className="phone-transport">
          <TransportButtons minimal />
          <Lcd compact />
        </div>
        <TabBar />
      </div>
    </div>
  );
}

export function App() {
  const layout = useLayout();
  const inspector = useApp((s) => s.inspector);
  const library = useApp((s) => s.library);
  const typing = useApp((s) => s.typing);

  useEffect(() => {
    document.documentElement.dataset.layout = layout;
  }, [layout]);

  const overlays = layout === 'tablet';
  return (
    <>
      {isPhone(layout) ? (
        <PhoneLayout layout={layout} />
      ) : (
        <div className="app">
          <ControlBar />
          <div style={{ display: 'grid', gridTemplateRows: 'auto minmax(0,1fr)', minHeight: 0 }}>
            <Banners />
            <div className="workspace" style={{ position: 'relative' }}>
              {inspector && !overlays ? <Inspector /> : <div />}
              <div className="center">
                <TracksArea />
                <EditorPane />
              </div>
              {library && !overlays ? <LibraryPanel /> : <div />}
              {overlays && inspector && <Inspector overlay />}
              {overlays && library && <LibraryPanel overlay />}
            </div>
          </div>
          {typing && (
            <div
              className="banner"
              style={{
                position: 'fixed',
                left: '50%',
                bottom: 16,
                transform: 'translateX(-50%)',
                borderRadius: 999,
                border: '1px solid #4a3a18',
                zIndex: 80,
              }}
            >
              Musical Typing is on: A S D F G H J K play the white keys, W E T Y U the black ones, Z / X change octave.{' '}
              <kbd>Ctrl K</kbd> turns it off.
            </div>
          )}
        </div>
      )}
      <PluginWindow />
      <StageWindow />
      <Dialogs />
      <MenuHost />
      <Toasts />
      <BounceStatus />
      <StartAudio />
    </>
  );
}
