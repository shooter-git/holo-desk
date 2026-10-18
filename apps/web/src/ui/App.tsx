/** The studio's frame: the desktop layout, the tablet's, and the phone's (portrait and landscape). */
import { Library as LibraryIcon, Music2, Piano, Redo2, Rows3, Settings, SlidersVertical, Undo2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { ensureAudio, redo, resolveConflict, undo } from '../app/actions.ts';
import { isPhone, type Layout, useLayout } from '../app/layout.ts';
import { type MobileTab, store, useApp } from '../app/store.ts';
import { AudioEditor, AudioEditorBar } from './AudioEditor.tsx';
import { ControlBar, Lcd, SaveDot, TransportButtons } from './ControlBar.tsx';
import { Wordmark } from './controls.tsx';
import { Dialogs } from './Dialogs.tsx';
import { Mixer, PluginWindow, StageWindow } from './Mixer.tsx';
import { MenuHost } from './menu.tsx';
import { Inspector, LibraryPanel } from './Panels.tsx';
import { PianoRoll, PianoRollBar } from './PianoRoll.tsx';
import { PlayPad } from './PlayPad.tsx';
import { TracksArea } from './Tracks.tsx';
import { ViewMenu } from './ViewMenu.tsx';

/** The selected track's editor: the Piano Roll, or the Audio Editor for an audio track. */
function useAudioSelected(): boolean {
  return useApp((s) => s.project?.tracks.find((t) => t.id === s.selectedTrack)?.kind === 'audio');
}

/** The editor never takes more than the window leaves for the tracks (a remembered height may be from a taller one). */
function clampEditorHeight(h: number): number {
  return Math.max(140, Math.min(window.innerHeight - 180, h));
}

function EditorPane() {
  const editor = useApp((s) => s.editor);
  const height = clampEditorHeight(useApp((s) => s.editorHeight));
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
          const id = e.pointerId;
          el.setPointerCapture(id);
          let h = height;
          let y = e.clientY;
          const move = (ev: PointerEvent) => {
            if (ev.pointerId !== id) return;
            h = clampEditorHeight(h - (ev.clientY - y));
            y = ev.clientY;
            store.set({ editorHeight: Math.round(h) });
          };
          // a touch the browser takes over (a scroll, a system gesture) ends the drag like a lifted finger
          const up = () => {
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
            el.removeEventListener('pointercancel', up);
            el.removeEventListener('lostpointercapture', up);
          };
          el.addEventListener('pointermove', move);
          el.addEventListener('pointerup', up);
          el.addEventListener('pointercancel', up);
          el.addEventListener('lostpointercapture', up);
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
      <div className="banner bad" role="status">
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
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : undefined}>
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
    <div className="toasts bounce" aria-live="polite">
      <div className="toast">
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
        <button type="button" className="btn primary large" onClick={() => void ensureAudio()}>
          Start the studio
        </button>
        <p className="start-note">Starts the audio and asks to use your MIDI devices.</p>
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
      <div className="phone-view editor">
        <div className="pane-bar">{audio ? <AudioEditorBar /> : <PianoRollBar />}</div>
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
      <div className="phone-view scroll">
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

/** The song's name, opening the Songs dialog, with the save dot beside it: the phone on its side has no control bar. */
function SongTitle() {
  const title = useApp((s) => s.project?.title ?? '');
  return (
    <>
      <button
        type="button"
        className="phone-title"
        title="Songs (open, new, import)"
        onClick={() => store.set({ dialog: 'projects' })}
      >
        {title}
      </button>
      <SaveDot />
    </>
  );
}

/** Undo, redo, settings and About, at the foot of the side rail: what the control bar holds elsewhere. */
function RailTools() {
  const canUndo = useApp((s) => s.undo.length > 0);
  const canRedo = useApp((s) => s.redo.length > 0);
  return (
    <div className="rail-tools">
      <button
        type="button"
        className="btn ghost icon"
        title="Undo"
        aria-label="Undo"
        disabled={!canUndo}
        onClick={undo}
      >
        <Undo2 />
      </button>
      <button
        type="button"
        className="btn ghost icon"
        title="Redo"
        aria-label="Redo"
        disabled={!canRedo}
        onClick={redo}
      >
        <Redo2 />
      </button>
      <button
        type="button"
        className="btn ghost icon"
        title="Audio & MIDI settings"
        aria-label="Audio & MIDI settings"
        onClick={() => store.set({ dialog: 'settings' })}
      >
        <Settings />
      </button>
      <button
        type="button"
        className="btn ghost icon mark"
        title="About HO[LO] Desk"
        onClick={() => store.set({ dialog: 'about' })}
      >
        <Wordmark />
      </button>
    </div>
  );
}

function PhoneLayout({ layout, inert }: { layout: Layout; inert: boolean }) {
  if (layout === 'phone-landscape') {
    return (
      <div className="app phone phone-landscape" inert={inert}>
        <aside className="side-rail">
          <TabBar />
          <RailTools />
        </aside>
        <div className="phone-main">
          <div className="phone-transport top">
            <TransportButtons minimal />
            <Lcd compact />
            <SongTitle />
            <ViewMenu />
          </div>
          <Banners />
          <PhoneView />
        </div>
      </div>
    );
  }
  return (
    <div className="app phone phone-portrait" inert={inert}>
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
  // a dialog up: the studio behind it is inert (no focus, no clicks, nothing for a screen reader)
  const inert = useApp((s) => s.dialog !== null);
  const workspace = useRef<HTMLDivElement>(null);
  const overlays = layout === 'tablet';

  useEffect(() => {
    document.documentElement.dataset.layout = layout;
  }, [layout]);

  // on a tablet the Inspector is an overlay: it doesn't start open over the tracks, however it was left
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, at launch
  useEffect(() => {
    if (overlays && store.get().inspector) store.set({ inspector: false });
  }, []);

  // a tap outside an overlay closes it (the tap still lands: selecting a track closes the Library over it)
  useEffect(() => {
    const el = workspace.current;
    if (!overlays || !el) return;
    const down = (e: PointerEvent) => {
      const s = store.get();
      if (!s.inspector && !s.library) return;
      if ((e.target as Element | null)?.closest?.('.overlay-panel')) return;
      store.set({ ...(s.inspector ? { inspector: false } : {}), ...(s.library ? { library: false } : {}) });
    };
    el.addEventListener('pointerdown', down, true);
    return () => el.removeEventListener('pointerdown', down, true);
  }, [overlays]);

  return (
    <>
      {isPhone(layout) ? (
        <PhoneLayout layout={layout} inert={inert} />
      ) : (
        <div className="app" inert={inert}>
          <ControlBar />
          <div className="app-body">
            <Banners />
            <div className="workspace" ref={workspace}>
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
            <div className="banner floating" role="status">
              <span>
                Musical Typing is on: A S D F G H J K play the white keys, W E T Y U the black ones, Z / X change
                octave. <kbd>Ctrl K</kbd> turns it off.
              </span>
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
