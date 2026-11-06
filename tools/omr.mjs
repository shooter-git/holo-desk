// The sheet-music recognition engines, a second reader of scans: `pnpm omr on | off | status`.
//
// A container (deploy/omr, compose profile "omr") runs Audiveris and homr, which read a scanned page
// into MusicXML; HO[LO] compares their reading with the bars written into the song and flags where
// they differ. It's big (Java, Python and the engines' models: a few gigabytes) and is built here the
// first time it's turned on. It has no way out to the internet; only HO[LO] on this machine reaches it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const envFile = join(repo, '.env');
const [command = 'status'] = process.argv.slice(2);
const URL = 'http://omr:8070';
const compose = (...args) =>
  execFileSync(
    'docker',
    [
      'compose',
      '--project-directory',
      repo,
      '-f',
      join(repo, 'deploy/compose.yml'),
      '--env-file',
      envFile,
      '--profile',
      'omr',
      ...args,
    ],
    { stdio: 'inherit' },
  );

function setEnv(key, value) {
  let text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  const line = `${key}=${value}`;
  text = new RegExp(`^${key}=.*$`, 'm').test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line)
    : `${text.replace(/\n?$/, '\n')}${line}\n`;
  writeFileSync(envFile, text);
}

if (command === 'on') {
  console.log('Building and starting the recognition engines (the first build takes a while: a few GB)…');
  compose('up', '-d', '--build', 'omr');
  setEnv('HOLO_OMR_URL', URL);
  process.env.HOLO_OMR_URL = URL;
  // HO[LO] picks the engines' address up when it starts again
  compose('up', '-d', 'holo');
  console.log('The engines are on: in a scan’s review, Compare with the engines reads each page with them.');
} else if (command === 'off') {
  setEnv('HOLO_OMR_URL', '');
  compose('rm', '-sf', 'omr');
  compose('up', '-d', 'holo');
  console.log('The engines are off (their image stays: pnpm omr on starts them again quickly).');
} else if (command === 'status') {
  const on = existsSync(envFile) && /^HOLO_OMR_URL=\S+/m.test(readFileSync(envFile, 'utf8'));
  console.log(on ? 'The recognition engines are on.' : 'The recognition engines are off: pnpm omr on');
  if (on) compose('ps', 'omr');
} else {
  console.log('pnpm omr on | off | status');
  process.exitCode = 1;
}
