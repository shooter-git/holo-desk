import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const { app } = await buildApp(config);

await app.listen({ port: config.port, host: config.host });
console.log(`HO[LO] Desk on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
