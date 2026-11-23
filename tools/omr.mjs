// The sheet-music recognition engines, which read scans into songs: `pnpm omr status | off | on | build`.
//
// They're on by default. In Docker they're a container beside the studio's (deploy/compose.yml: the image
// CI publishes from deploy/omr, kept up to date with the studio's), on a network with no way out to the
// internet. Run without Docker (pnpm start, pnpm dev), the server runs them itself the first time a scan
// wants them, in a container with no network at all, when the computer has Docker. Inside are Audiveris
// and homr (AGPL-3.0), unmodified: a few GB, so the first time takes a while.
//
//   status   on or off, and their container
//   off      turned off: the studio doesn't use them, and their container goes (its image stays until
//            `docker image rm`)
//   on       back on, from the image CI publishes
//   build    their image built from this checkout's deploy/omr instead (holo-omr:local), and used
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { compose, omrImage, omrOn, readEnv, setEnv, startEngines, unsetEnv } from './update.mjs';

const [command = 'status'] = process.argv.slice(2);
const LOCAL = 'holo-omr:local';

/** Whether the studio runs in Docker here (pnpm run update or pnpm run up wrote its image). */
const inDocker = () => !!readEnv().values.HOLO_IMAGE;

/** docker, its output shown; false when it failed. */
function docker(...args) {
  try {
    execFileSync('docker', args, { stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The container a server run without Docker starts for itself from this checkout: named for its data
 * folder, as apps/server/src/omr-docker.ts names it (another studio's on this computer is left alone).
 */
function ownContainers() {
  const data = resolve(import.meta.dirname, '..', readEnv().values.HOLO_DATA_DIR ?? './data');
  const name = `holo-omr-${createHash('sha256').update(data).digest('hex').slice(0, 10)}`;
  try {
    return execFileSync('docker', ['ps', '-aq', '--filter', `name=^${name}$`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

if (command === 'off') {
  setEnv('HOLO_OMR_URL', '');
  if (inDocker()) {
    setEnv('HOLO_OMR_REPLICAS', '0');
    compose('rm', '-sf', 'omr');
    // the studio stops looking for them when it starts again
    compose('up', '-d', '--no-build', 'holo');
  } else {
    const own = ownContainers();
    if (own.length) docker('rm', '-f', ...own);
    console.log('Start HO[LO] again (pnpm start) for it to take effect.');
  }
  console.log('The recognition engines are off (`pnpm omr on` turns them back on).');
} else if (command === 'on') {
  unsetEnv('HOLO_OMR_URL');
  unsetEnv('HOLO_OMR_REPLICAS');
  if (readEnv().values.HOLO_OMR_IMAGE === LOCAL) unsetEnv('HOLO_OMR_IMAGE');
  if (inDocker()) {
    const channel = readEnv().values.HOLO_CHANNEL;
    if (channel === 'main' || channel === 'stable') setEnv('HOLO_OMR_IMAGE', omrImage(channel));
    compose('up', '-d', '--no-build', 'holo');
    startEngines();
    console.log('The recognition engines are on: a scan’s review reads it in with them.');
  } else {
    console.log(
      'The recognition engines are on: the server starts them (with Docker) the first time a scan wants them.' +
        '\nStart HO[LO] again (pnpm start) for it to take effect.',
    );
  }
} else if (command === 'build') {
  if (!docker('build', '-t', LOCAL, 'deploy/omr')) process.exit(1);
  setEnv('HOLO_OMR_IMAGE', LOCAL);
  unsetEnv('HOLO_OMR_URL');
  unsetEnv('HOLO_OMR_REPLICAS');
  if (inDocker()) {
    compose('up', '-d', '--no-build', 'omr');
    compose('up', '-d', '--no-build', 'holo');
    console.log(`The recognition engines run from ${LOCAL} (\`pnpm omr on\` goes back to the published image).`);
  } else {
    const own = ownContainers();
    if (own.length) docker('rm', '-f', ...own);
    console.log(`The recognition engines run from ${LOCAL} once HO[LO] starts again (pnpm start).`);
  }
} else if (command === 'status') {
  const { values } = readEnv();
  const on = omrOn(values);
  console.log(
    on
      ? `The recognition engines are on${values.HOLO_OMR_IMAGE ? ` (${values.HOLO_OMR_IMAGE})` : ''}.`
      : 'The recognition engines are off: pnpm omr on',
  );
  if (on && inDocker()) compose('ps', 'omr');
  else if (on) {
    const own = ownContainers();
    console.log(own.length ? 'Their container is running.' : 'They start the first time a scan wants them.');
  }
} else {
  console.log('pnpm omr status | off | on | build');
  process.exitCode = 1;
}
