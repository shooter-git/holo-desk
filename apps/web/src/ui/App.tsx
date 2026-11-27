/** The studio's frame: the desktop layout, the tablet's, and the phone's (portrait and landscape). */
import { Library as LibraryIcon, Music2, Piano, Rows3, Settings, SlidersVertical, X } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import { bounceClock, ensureAudio, putBounceAway, resolveConflict, saveBounce } from '../app/actions.ts';
import { clampEditorHeight, fitEditorHeight, isPhone, type Layout, layoutNow, useLayout } from '../app/layout.ts';
import { otherStudioToDrive } from '../app/live.ts';
import { pageCovers, paneCovered } from '../app/page-layout.ts';
import { closeBar, type MobileTab, openSettings, store, useApp, useShow } from '../app/store.ts';
import { useVersion } from '../app/version.ts';
import { AudioEditor, AudioEditorBar } from './AudioEditor.tsx';
import { Bar } from './Bar.tsx';
import { BarButton, ControlBar, Lcd, SaveDot, TransportButtons } from './ControlBar.tsx';
import { Wordmark } from './controls.tsx';
import { Dialogs } from './Dialogs.tsx';
import { FramePause, keepAwake, wake } from './frame.ts';
import { Mixer, PluginWindow, StageWindow, SynthWindow } from './Mixer.tsx';
import { MenuHost } from './menu.tsx';
import { Inspector, LibraryPanel, MasterRail, useMasterRail } from './Panels.tsx';
import { PianoRoll, PianoRollBar } from './PianoRoll.tsx';
import { PlayPad } from './PlayPad.tsx';
import { useScrollCue } from './scroll-cue.ts';
import { spareTrackRoom, TracksArea } from './Tracks.tsx';
import { Tray } from './Tray.tsx';
import { UndoRedo } from './UndoRedo.tsx';
import { DOUBLE_TAP_MS } from './view.ts';

/** The selected track's editor: the Piano Roll, or the Audio Editor for an audio track. */
function useAudioSelected(): boolean {
  return useApp((s) => s.project?.tracks.find((t) => t.id === s.selectedTrack)?.kind === 'audio');
}

// the Score (and its engraver) loads the first time it's shown
const Score = lazy(() => import('../score/Score.tsx').then((m) => ({ default: m.Score })));
const ScoreBar = lazy(() => import('../score/Score.tsx').then((m) => ({ default: m.ScoreBar })));
const ScanWindow = lazy(() => import('../score/scan/ScanWindow.tsx'));
const PrintWindow = lazy(() => import('../score/Print.tsx'));

/** Printing the score: its pages, over the studio, while it's open. */
function Printing() {
  const open = useApp((s) => s.printView !== null);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <PrintWindow />
    </Suspense>
  );
}

/** Scanning sheet music: a window over the studio while it's open. */
function Scanning() {
  const open = useApp((s) => s.scanView !== null);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <ScanWindow />
    </Suspense>
  );
}

// the Audio Editor's Notes view (and its note-finding) loads the first time it's shown
const AudioNotes = lazy(() => import('./AudioNotes.tsx').then((m) => ({ default: m.AudioNotes })));
const AudioNotesBar = lazy(() => import('./AudioNotes.tsx').then((m) => ({ default: m.AudioNotesBar })));

/** The Audio Editor: the recording's waveform, or its notes. */
function AudioView() {
  const notes = useApp((s) => s.audioMode === 'notes');
  if (!notes) return <AudioEditor />;
  return (
    <Suspense fallback={<div className="audio-ed" />}>
      <AudioNotes />
    </Suspense>
  );
}

/** The Audio Editor's bar, for the view it shows. */
function AudioBar() {
  const notes = useApp((s) => s.audioMode === 'notes');
  if (!notes) return <AudioEditorBar />;
  return (
    <Suspense fallback={null}>
      <AudioNotesBar />
    </Suspense>
  );
}

/** Wave or Notes, for an audio track's recording. */
function AudioModeSwitch() {
  const mode = useApp((s) => s.audioMode);
  return (
    <div className="seg">
      <button
        type="button"
        className={`btn${mode === 'wave' ? ' on' : ''}`}
        title="The recording's waveform: trim, stretch, fades and gain"
        onClick={() => store.set({ audioMode: 'wave' })}
      >
        Wave
      </button>
      <button
        type="button"
        className={`btn${mode === 'notes' ? ' on' : ''}`}
        title="The recording's notes: each one's pitch and length"
        onClick={() => store.set({ audioMode: 'notes' })}
      >
        Notes
      </button>
    </div>
  );
}

/** Whether the notes editor shows the Score (an audio track always has its Audio Editor). */
function useScoreShown(): boolean {
  const audio = useAudioSelected();
  return useApp((s) => s.noteView === 'score') && !audio;
}

/** Piano Roll or Score, for an instrument track's notes. */
function NoteViewSwitch() {
  const view = useApp((s) => s.noteView);
  return (
    <div className="seg">
      <button
        type="button"
        className={`btn${view === 'roll' ? ' on' : ''}`}
        onClick={() => store.set({ noteView: 'roll' })}
      >
        Piano Roll
      </button>
      <button
        type="button"
        className={`btn${view === 'score' ? ' on' : ''}`}
        onClick={() => store.set({ noteView: 'score' })}
      >
        Score
      </button>
    </div>
  );
}

/**
 * An editor's bar. Where it's wider than its pane it scrolls sideways, and the edge that has more
 * fades: the bar has no scrollbar to say so. (A phone held upright has bars made to fit it, with ⋯
 * for the rest: UprightBar.)
 */
function PaneBar({ children }: { children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  useScrollCue(bar, 'x');
  return (
    <div className="pane-bar" ref={bar}>
      {children}
    </div>
  );
}

function EditorPane() {
  const editor = useApp((s) => s.editor);
  const height = clampEditorHeight(useApp((s) => s.editorHeight));
  const audio = useAudioSelected();
  const score = useScoreShown();
  const lastPress = useRef(0);
  if (!editor) return null;
  const editorName = audio ? 'Audio Editor' : score ? 'Score' : 'Piano Roll';
  return (
    <section className="editor-pane" style={{ height }} aria-label={editor === 'piano' ? editorName : 'Mixer'}>
      <div
        className="splitter"
        title="Drag to resize, double-click to fit the tracks"
        onPointerDown={(e) => {
          // a double-click (a finger's double tap too) fits the tracks: the room under the last one goes to the editor
          const now = performance.now();
          if (now - lastPress.current < DOUBLE_TAP_MS) {
            lastPress.current = 0;
            const fitted = fitEditorHeight(height, spareTrackRoom());
            if (fitted !== null) store.set({ editorHeight: fitted });
            return;
          }
          lastPress.current = now;
          const el = e.currentTarget;
          const id = e.pointerId;
          el.setPointerCapture(id);
          const y0 = e.clientY;
          let h = height;
          let y = e.clientY;
          const move = (ev: PointerEvent) => {
            if (ev.pointerId !== id) return;
            // a drag isn't the first click of a double-click
            if (Math.abs(ev.clientY - y0) > 3) lastPress.current = 0;
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
      <PaneBar>
        {editor === 'piano' ? (
          audio ? (
            <AudioBar />
          ) : score ? (
            <Suspense fallback={<span className="title">Score</span>}>
              <ScoreBar />
            </Suspense>
          ) : (
            <PianoRollBar />
          )
        ) : (
          <>
            <span className="title">Mixer</span>
            <span className="grow" />
            {/* as the editors have them: where the control bar has none (too narrow for its own, or View hides them), these are the only ones */}
            <UndoRedo group="seg pane-undo" />
          </>
        )}
        {/* how the notes (or the recording) are shown; the Piano Roll and the Mixer themselves are opened at the top right */}
        {editor === 'piano' && (audio ? <AudioModeSwitch /> : <NoteViewSwitch />)}
      </PaneBar>
      {editor === 'piano' ? (
        audio ? (
          <AudioView />
        ) : score ? (
          <Suspense fallback={<div className="score" />}>
            <Score />
          </Suspense>
        ) : (
          <PianoRoll />
        )
      ) : (
        <Mixer />
      )}
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
        <div
          key={t.id}
          className={`toast ${t.kind}${t.action ? ' with-action' : ''}`}
          role={t.kind === 'error' ? 'alert' : undefined}
        >
          {t.text}
          {t.action && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                t.action?.run();
                store.set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }));
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A bounce: how far it has got while it's made, and, on a phone or a tablet, that it's done, with
 * Save (it stays until it's saved or put away: nothing downloads by itself there).
 */
function BounceStatus() {
  const text = useApp((s) => s.bouncing);
  const done = useApp((s) => s.bounced);
  if (!text && !done) return null;
  return (
    <div className="toasts bounce" aria-live="polite">
      {text ? (
        <div className="toast">
          <span className="status-dot busy" />
          {text}
        </div>
      ) : (
        done && (
          <div className="toast with-action bounced">
            <span className="status-dot ok" />
            <span className="bounced-text">
              Bounced {done.seconds === null ? '' : `${bounceClock(done.seconds)} of `}“{done.name}”
            </span>
            <button
              type="button"
              className="btn"
              disabled={!done.ready}
              aria-label={`Save the bounce of ${done.name}`}
              onClick={() => void saveBounce()}
            >
              {done.ready ? 'Save' : 'Getting the file…'}
            </button>
            <button
              type="button"
              className="btn ghost icon"
              title="Put away"
              aria-label="Put the bounce away: it stays with the song"
              onClick={putBounceAway}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        )
      )}
    </div>
  );
}

/** How long the audio may take to start before the start screen says it's still waiting. */
const START_SLOW_MS = 4000;

function StartAudio() {
  const ready = useApp((s) => s.audioReady);
  const other = useApp((s) => otherStudioToDrive(s.peers));
  const version = useVersion();
  // A browser with no sound output to use may never answer (it neither starts the audio nor
  // refuses): the screen says so instead of sitting there as if the button hadn't been pressed.
  const [waiting, setWaiting] = useState(false);
  const slow = useRef(0);
  useEffect(() => () => window.clearTimeout(slow.current), []);
  const start = () => {
    window.clearTimeout(slow.current);
    setWaiting(false);
    slow.current = window.setTimeout(() => setWaiting(true), START_SLOW_MS);
    void ensureAudio().finally(() => {
      window.clearTimeout(slow.current);
      setWaiting(false);
    });
  };
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
        <button type="button" className="btn primary large" onClick={start}>
          Start the studio
        </button>
        {waiting ? (
          <p className="start-note waiting" role="status">
            The audio hasn’t started yet. Check that this device has a sound output the browser can use.
          </p>
        ) : (
          <p className="start-note">Starts the audio and asks to use your MIDI devices.</p>
        )}
        {other && (
          <div className="start-remote">
            <p>
              HO[LO] is also open on <b>{other}</b>. A studio here plays on its own; to control that one from here, use
              HO[LO] Remote.
            </p>
            <a className="btn" href="/remote">
              Open Remote
            </a>
          </div>
        )}
        <p className="start-version">{version ? `Version ${version}` : ''}</p>
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
  const score = useScoreShown();
  return (
    <nav className="tabbar" aria-label="Views">
      {TABS.map(([id, label, Icon]) => (
        <button
          key={id}
          type="button"
          className={tab === id ? 'active' : ''}
          onClick={() => {
            store.set({ mobileTab: id });
            // (the page over the views, on a phone held upright, gives way to the one chosen)
            if (pageCovers(layoutNow())) closeBar();
          }}
          aria-current={tab === id}
        >
          <Icon />
          {id === 'editor' && audio ? 'Editor' : id === 'editor' && score ? 'Score' : label}
        </button>
      ))}
    </nav>
  );
}

function PhoneView() {
  const tab = useApp((s) => s.mobileTab);
  const audio = useAudioSelected();
  const score = useScoreShown();
  const upright = useLayout() === 'phone-portrait';
  if (tab === 'editor') {
    return (
      <div className="phone-view editor">
        <PaneBar>
          {audio ? (
            <AudioBar />
          ) : score ? (
            <Suspense fallback={null}>
              <ScoreBar />
            </Suspense>
          ) : (
            <PianoRollBar />
          )}
          {/* (held upright, the bar's ⋯ has the other view: see UprightBar) */}
          {!upright && (audio ? <AudioModeSwitch /> : <NoteViewSwitch />)}
        </PaneBar>
        {audio ? (
          <AudioView />
        ) : score ? (
          <Suspense fallback={<div className="score" />}>
            <Score />
          </Suspense>
        ) : (
          <PianoRoll />
        )}
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
  return (
    <div className="rail-tools">
      <UndoRedo button="btn ghost icon" />
      <button
        type="button"
        className="btn ghost icon wide"
        title="Settings"
        aria-label="Settings"
        onClick={() => openSettings()}
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
  const nav = useShow('barNav');
  // the agent's page over the views (a phone held upright): they're out of sight, so they're neither
  // drawn nor shown until it closes, or is held to see through it (the transport's display, outside
  // them, keeps going)
  const covered = useApp((s) => paneCovered(layout, s.bar, s.barPeek));
  if (layout === 'phone-landscape') {
    return (
      <div className="app phone phone-landscape" inert={inert}>
        <aside className="side-rail">
          <TabBar />
          <RailTools />
        </aside>
        <div className="phone-main">
          {/* on its side, the phone has the room for the back and forward buttons and the key (held
              upright it hasn't: the position display's drag moves a bar at a time there) */}
          <div className="phone-transport top">
            <TransportButtons minimal={!nav} capture />
            <Lcd compact keyCell />
            <SongTitle />
            {/* the bar; View is in Settings, as on a phone held upright */}
            <BarButton />
          </div>
          <Banners />
          <PhoneView />
          {/* a read reply's controls, at the foot of the column (a row of its own: it covers nothing) */}
          <Tray layout={layout} />
        </div>
      </div>
    );
  }
  return (
    <div className="app phone phone-portrait" inert={inert} data-covered={covered ? '' : undefined}>
      <ControlBar />
      <Banners />
      <FramePause paused={covered}>
        <PhoneView />
      </FramePause>
      <div className="phone-dock">
        {/* a read reply's controls, above the transport (a row of its own: it covers nothing) */}
        <Tray layout={layout} />
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
  // a dialog up, or a window over the whole studio (Print, Scan): the studio behind it is inert (no
  // focus, no clicks, nothing for a screen reader)
  const inert = useApp((s) => s.dialog !== null || s.printView !== null || s.scanView !== null);
  const workspace = useRef<HTMLDivElement>(null);
  const overlays = layout === 'tablet';
  const masterRail = useMasterRail();

  useEffect(() => {
    document.documentElement.dataset.layout = layout;
  }, [layout]);

  // The screen is drawn at its own pace while a song plays or records, and for a moment after
  // anything changes in the studio (an edit from here, from the agent or from a remote); left
  // alone and stopped, the frame loop rests (frame.ts).
  useEffect(() => {
    const playing = keepAwake(() => store.get().playing || store.get().recording);
    const changed = store.subscribe(wake);
    return () => {
      playing();
      changed();
    };
  }, []);

  // on a tablet the Inspector is an overlay: it doesn't start open over the tracks, however it was left
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, at launch
  useEffect(() => {
    if (overlays && store.get().inspector) store.set({ inspector: false });
  }, []);

  // on a tablet the agent's page is a sheet down the right edge, where the Library slides in: one goes
  // as the other comes (the Inspector too, so the studio between them keeps its room)
  useEffect(() => {
    if (!overlays) return;
    let was = store.get();
    return store.subscribe(() => {
      const s = store.get();
      const before = was;
      was = s;
      if (s.bar && !before.bar && (s.inspector || s.library)) store.set({ inspector: false, library: false });
      else if (s.bar && ((s.inspector && !before.inspector) || (s.library && !before.library))) closeBar();
    });
  }, [overlays]);

  // a tap outside an overlay closes it (the tap still lands: selecting a track closes the Library over it)
  useEffect(() => {
    const el = workspace.current;
    if (!overlays || !el) return;
    const down = (e: PointerEvent) => {
      const s = store.get();
      if (!s.inspector && !s.library) return;
      // (Stereo Out pinned beside them is there to be used whatever is open: a press on it closes nothing)
      if ((e.target as Element | null)?.closest?.('.overlay-panel, .master-rail')) return;
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
            <div className={`workspace${masterRail ? ' with-rail' : ''}`} ref={workspace}>
              {masterRail ? <MasterRail /> : <div />}
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
      <SynthWindow />
      <StageWindow />
      <Dialogs />
      <Scanning />
      <Printing />
      {/* outside the studio's frame, so a dialog making the studio inert leaves the bar working over it */}
      <Bar />
      <MenuHost />
      <Toasts />
      <BounceStatus />
      <StartAudio />
    </>
  );
}
