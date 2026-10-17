import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { findCompanion, startup } from './app/actions.ts';
import { installKeys } from './app/keys.ts';
import { connectLive, device } from './app/live.ts';
import { connectRemote } from './app/remote.ts';
import { App } from './ui/App.tsx';
import { Remote } from './ui/Remote.tsx';

// /remote is HO[LO] Remote (a phone driving the studio on another device); anything else, the studio
const isRemote = /^\/remote\/?$/.test(location.pathname);

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<StrictMode>{isRemote ? <Remote /> : <App />}</StrictMode>);
}

if (isRemote) {
  connectRemote(`Remote (${device().replace(/ on an? /, ', ')})`);
} else {
  installKeys();
  void startup().then(() => {
    connectLive();
    findCompanion();
  });
}

// the installed app works offline; a development server never registers it
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
