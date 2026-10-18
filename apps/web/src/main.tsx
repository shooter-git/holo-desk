import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/app.css';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { findCompanion, startup } from './app/actions.ts';
import { installKeys } from './app/keys.ts';
import { connectLive, device } from './app/live.ts';
import { connectRemote } from './app/remote.ts';

// the studio and the remote are files of their own, so a phone loads only the remote's
const App = lazy(() => import('./ui/App.tsx').then((m) => ({ default: m.App })));
const Remote = lazy(() => import('./ui/Remote.tsx').then((m) => ({ default: m.Remote })));

// /remote is HO[LO] Remote (a phone driving the studio on another device); anything else, the studio
const isRemote = /^\/remote\/?$/.test(location.pathname);

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
  // the live channel and HO[LO] Engine need no song: they're looked for while it loads
  connectLive();
  findCompanion();
  void startup();
}

// the installed app works offline; a development server never registers it
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
