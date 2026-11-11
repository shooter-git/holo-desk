import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const { app } = await buildApp(config);

await app.listen({ port: config.port, host: config.host });
console.log(`HO[LO] Desk on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);

// Stopping closes the live channel's connections and drops what's left after a second (app.ts); if
// anything still holds the server up, it exits anyway a few seconds on. A second signal: at once.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    setTimeout(() => process.exit(0), 3000).unref();
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
