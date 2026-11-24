import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/app.css';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { findCompanion, openTurn, startup } from './app/actions.ts';
import { installEdgeGuard } from './app/edge-swipe.ts';
import { installKeys } from './app/keys.ts';
import { connectLive, device } from './app/live.ts';
import { installNotices } from './app/notify.ts';
import { readPairLink } from './app/pair-link.ts';
import { connectRemote } from './app/remote.ts';
import { installRightClick } from './app/right-click.ts';
import { openSettings } from './app/store.ts';

// the studio and the remote are files of their own, so a phone loads only the remote's
const App = lazy(() => import('./ui/App.tsx').then((m) => ({ default: m.App })));
const Remote = lazy(() => import('./ui/Remote.tsx').then((m) => ({ default: m.Remote })));

// /remote is HO[LO] Remote (a phone driving the studio on another device); anything else, the studio
const isRemote = /^\/remote\/?$/.test(location.pathname);

installRightClick();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Suspense fallback={null}>{isRemote ? <Remote /> : <App />}</Suspense>
    </StrictMode>,
  );
}

if (isRemote) {
  connectRemote(`Remote (${device().replace(/ on an? /, ', ')})`);
} else {
  installKeys();
  // an iPhone's swipe from the side of the screen doesn't take the studio away
  installEdgeGuard();
  // a pairing link from `holo pair`: Settings › Agent, with its code filled in
  const paired = () => {
    if (readPairLink()) openSettings('agent');
  };
  paired();
  window.addEventListener('hashchange', paired);
  // the live channel and HO[LO] Engine need no song: they're looked for while it loads
  connectLive();
  findCompanion();
  void startup();
  // the agent's notices outside HO[LO] (app/notify.ts): a tap on one while the studio is open comes
  // from the service worker, for the page to open at that reply
  installNotices();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
      const m = e.data as { type?: unknown; project?: unknown; job?: unknown } | null;
      if (m?.type === 'open-turn' && typeof m.project === 'string')
        openTurn(m.project, typeof m.job === 'string' ? m.job : null);
    });
    navigator.serviceWorker.startMessages();
  }
}

// the installed app works offline; a development server never registers it
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
