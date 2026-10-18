import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants as zlib } from 'node:zlib';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const server = `http://127.0.0.1:${process.env.HOLO_PORT ?? 47800}`;

/**
 * Cross-origin isolation: without it the browser won't share memory between the page and the
 * audio thread, and live MIDI would have to queue behind everything else on the page.
 */
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** Writes sw.js with this build's files, so the installed app opens offline. */
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'holo-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    writeBundle(_options, bundle) {
      const shell = [
        './',
        'manifest.webmanifest',
        'remote.webmanifest',
        'icons/icon-192.png',
        'icons/icon-512.png',
        ...Object.keys(bundle),
      ]
        // the fonts aren't in the shell: the page loads the two it uses, and the browser keeps them
        // for a year by their hashed names, so a fresh version needn't fetch the other eleven
        .filter((f) => !f.endsWith('.map') && !f.endsWith('.woff2') && f !== 'sw.js')
        .sort();
      const version = createHash('sha256').update(shell.join('\n')).digest('hex').slice(0, 12);
      const template = readFileSync(resolve(here, 'src/sw-template.js'), 'utf8');
      writeFileSync(resolve(outDir, 'sw.js'), template.replace('/* BUILD */ null', JSON.stringify({ version, shell })));
    },
  };
}

/**
 * Writes a .br and a .gz beside every text file of the build (scripts, styles, the page, the
 * manifests), compressed as well as they can be, for the server to send as they are: nothing
 * between it and another device compresses, and a fresh gzip on every request would be worse.
 */
function precompress(): Plugin {
  let outDir = 'dist';
  return {
    name: 'holo-precompress',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    // after every plugin has written (the service worker among them)
    closeBundle() {
      for (const file of readdirSync(outDir, { recursive: true, encoding: 'utf8' })) {
        if (!/\.(js|css|svg|json|webmanifest|html)$/.test(file)) continue;
        const path = resolve(outDir, file);
        const data = readFileSync(path);
        // under a kilobyte, the headers outweigh the saving
        if (data.length < 1024) continue;
        const params = { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: data.length };
        writeFileSync(`${path}.br`, brotliCompressSync(data, { params }));
        writeFileSync(`${path}.gz`, gzipSync(data, { level: 9 }));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker(), precompress()],
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 900 },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.HOLO_WEB_PORT ?? 47810),
    strictPort: true,
    allowedHosts: ['.ts.net', 'localhost'],
    headers: isolation,
    proxy: {
      '/api': { target: server, ws: true },
      '/packs': server,
    },
  },
  preview: { headers: isolation },
});
