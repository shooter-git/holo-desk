// A drum kit pack from multi-microphone recordings (`rock-kit.mjs`, `prog-kit.mjs`, `jazz-kit.mjs`).
//
// Each hit was recorded on several microphones at once (a close one on the drum, the overheads, a
// room pair). A kit is mixed the way an engineer mixes a session: every microphone at its fader level
// and pan, the same for every hit, so the kit sounds as one instrument in one room. The mix of each hit
// is written as one stereo file, trimmed to just before its attack (a pad sounds the instant it's hit)
// and to where its tail falls away.
//
// Velocity: each piece's layers are measured (their loudness as BS.1770 weighs it) and set where the
// kit's one velocity curve meets them, so every drum gets louder smoothly as it's hit harder, changes
// its timbre at each layer, and answers velocity the same way as every other drum. Round robins take
// turns; the hi-hat chokes itself; a drum struck again past three times lets its oldest ring go.
import { join } from 'node:path';
import {
  arg,
  Downloads,
  envelope,
  loudness,
  makeFiles,
  memoryMb,
  mixSignal,
  onset,
  peakDb,
  pinDownloads,
  spreadLayers,
  writeManifest,
} from './lib.mjs';

/** A GitHub repository's files at a commit (cached beside the downloads). */
export async function githubTree(repo, commit, downloads) {
  const name = `tree-${repo.replace('/', '-')}-${commit}.json`;
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
  const file = join(downloads.dir, name);
  if (!existsSync(file)) {
    const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'holo-desk-packs' },
    });
    if (!res.ok) throw new Error(`${repo}@${commit}: ${res.status}`);
    mkdirSync(downloads.dir, { recursive: true });
    writeFileSync(file, await res.text());
  }
  const tree = JSON.parse(readFileSync(file, 'utf8'));
  if (tree.truncated) throw new Error(`${repo}: the tree is truncated`);
  return tree.tree.filter((t) => t.type === 'blob').map((t) => t.path);
}

export const raw = (repo, commit) => `https://raw.githubusercontent.com/${repo}/${commit}/`;

/** A mono microphone's gains into left and right at an SFZ pan (0 left, 63.5 centre, 127 right): constant power, unity in the centre. */
export function panGains(gain, pan = 63.5) {
  const p = Math.max(-1, Math.min(1, (pan - 63.5) / 63.5));
  const theta = ((p + 1) * Math.PI) / 4;
  return [gain * Math.cos(theta) * Math.SQRT2, gain * Math.sin(theta) * Math.SQRT2];
}

/**
 * The hits in a set of folders: `files` lists each microphone's file names by a pattern whose groups
 * are the layer and the round robin. Returns hits as { layer, rr, mics: { mic: download } }.
 */
export function hitsIn(paths, base, folder, mics, pattern) {
  const hits = new Map();
  for (const [mic, sub] of Object.entries(mics)) {
    const dir = `${folder}/${sub}/`;
    for (const p of paths) {
      if (!p.startsWith(dir) || p.slice(dir.length).includes('/')) continue;
      const m = pattern.exec(p.slice(dir.length));
      if (!m) continue;
      const layer = Number(m[1] ?? 1);
      const rr = Number(m[2] ?? 1);
      const key = `${layer}:${rr}`;
      if (!hits.has(key)) hits.set(key, { layer, rr, mics: {} });
      hits.get(key).mics[mic] = `${base}:${p}`;
    }
  }
  const out = [...hits.values()].filter((h) => Object.keys(mics).every((m) => h.mics[m]));
  if (!out.length) throw new Error(`No hits in ${folder} (${Object.values(mics).join(', ')})`);
  return out.sort((a, b) => a.layer - b.layer || a.rr - b.rr);
}

/** Keep `n` of a list, evenly spread (always the first and the last). */
function spreadPick(list, n) {
  if (!n || list.length <= n) return list;
  return Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))]);
}

/**
 * Build a kit pack. `spec.pieces`: each with a name, the keys it plays on, its hits (hitsIn), its
 * microphones' fader levels and pans ({ mic: [gain, pan] }, a stereo pair's pan left out), and how
 * long its tail may ring.
 */
export async function buildKit(spec) {
  const cache = arg('cache', join(process.env.HOME ?? '.', `.cache/holo-pack-sources/${spec.id}`));
  const out = arg('out', null);
  const downloads = spec.downloads;
  const pieces = spec.pieces;
  // fetch every microphone of every hit kept
  for (const piece of pieces) {
    piece.hits = spreadPick(
      [...new Set(piece.hits.map((h) => h.layer))].sort((a, b) => a - b),
      piece.maxLayers,
    ).flatMap((layer) => {
      const rrs = piece.hits.filter((h) => h.layer === layer);
      return spreadPick(rrs, piece.maxRR);
    });
  }
  const names = [...new Set(pieces.flatMap((p) => p.hits.flatMap((h) => Object.values(h.mics))))];
  console.log(`${spec.name}: ${names.length} downloads (cache ${cache})`);
  await downloads.all(names);

  const decodedCache = new Map();
  const decode = (n) => {
    if (!decodedCache.has(n)) decodedCache.set(n, downloads.decoded(n));
    return decodedCache.get(n);
  };
  const rateOf = (n) => decode(n).rate;

  // each piece's inputs: microphones at their gains and pans, summed as recorded (as the libraries'
  // own programs sum them: none turns a microphone over)
  for (const piece of pieces) {
    piece.inputsOf = (hit, scale = 1) =>
      Object.entries(piece.mics)
        .filter(([, [gain]]) => gain > 0)
        .map(([mic, [gain, pan]]) => {
          const name = hit.mics[mic];
          const g = decode(name).channels.length === 1 ? panGains(gain, pan) : [gain, gain];
          return [name, g[0] * scale, g[1] * scale];
        });
  }

  // the kit's loudest moment sets how loud the files are written (just under full scale)
  let loudestPeak = 0;
  for (const piece of pieces) {
    for (const hit of piece.hits.slice(-Math.min(4, piece.hits.length))) {
      const inputs = piece.inputsOf(hit);
      const m = new Map(inputs.map(([n]) => [n, decode(n)]));
      const [l, r] = mixSignal(inputs, m);
      for (let i = 0; i < l.length; i++) loudestPeak = Math.max(loudestPeak, Math.abs(l[i]), Math.abs(r[i]));
    }
  }
  const scale = 0.89 / loudestPeak;

  // measure every hit as it will be written
  const files = {};
  const zonesOf = new Map();
  for (const piece of pieces) {
    const measured = [];
    let topPeak = Number.NEGATIVE_INFINITY;
    for (const hit of piece.hits) {
      const inputs = piece.inputsOf(hit, scale);
      const m = new Map(inputs.map(([n]) => [n, decode(n)]));
      const rate = rateOf(inputs[0][0]);
      const [l, r] = mixSignal(inputs, m);
      const ch = [Float32Array.from(l), Float32Array.from(r)];
      const at = onset(ch, 40);
      const start = Math.max(0, at - Math.round(0.0015 * rate));
      const peak = peakDb(ch);
      topPeak = Math.max(topPeak, peak);
      measured.push({ hit, inputs, rate, ch, start, at, peak, level: loudness(ch, rate, at, 0.4) });
    }
    // tails: kept down to `floor` dB under the piece's loudest peak, and no longer than `ring` seconds
    for (const h of measured) {
      const env = envelope(h.ch, h.rate, 0.02);
      const floor = topPeak - (piece.floor ?? 62);
      let last = 0;
      for (let b = env.db.length - 1; b >= 0; b--)
        if (env.db[b] > floor) {
          last = (b + 1) * env.frames;
          break;
        }
      const end = Math.min(
        h.ch[0].length,
        last + Math.round(0.05 * h.rate),
        h.start + Math.round((piece.ring ?? 2) * h.rate),
      );
      h.frames = Math.max(Math.round(0.05 * h.rate), end - h.start);
      const fade = Math.min(Math.round((piece.fade ?? 0.2) * h.rate), Math.round(h.frames * 0.4));
      const path = `${spec.folder}/${piece.name}/${piece.name}_v${h.hit.layer}_rr${h.hit.rr}.wav`;
      h.path = path;
      files[path] = {
        in: h.inputs,
        start: h.start,
        frames: h.frames,
        fadeIn: Math.min(32, h.at - h.start),
        fadeOut: fade,
      };
    }
    zonesOf.set(piece, measured);
  }

  // velocity: one curve for the whole kit, as wide as its widest piece needs
  const levelsOf = (piece) => {
    const m = zonesOf.get(piece);
    const layers = [...new Set(m.map((h) => h.hit.layer))].sort((a, b) => a - b);
    return {
      layers,
      levels: layers.map((L) => {
        const of = m.filter((h) => h.hit.layer === L);
        return of.reduce((a, h) => a + h.level, 0) / of.length;
      }),
    };
  };
  const ranges = pieces.filter((p) => p.leadsRange).map((p) => spreadLayers(levelsOf(p).levels).need);
  const range = Math.round(Math.min(44, Math.max(28, ...ranges)) * 10) / 10;
  // every piece at its natural level in the mix, the kit as a whole brought to `spec.level`
  const natural = pieces.map((p) => spreadLayers(levelsOf(p).levels, { range }).ref);
  // pieces from another recording move by what brings one of them to one of this kit's
  // (`levelAs: [piece, like]`): a borrowed snare to the kick's level, and its rimshot with it
  const at = (name) => {
    const i = pieces.findIndex((q) => q.name === name);
    if (i < 0) throw new Error(`levelAs: no piece "${name}"`);
    return natural[i];
  };
  const refs = pieces.map((p, i) => natural[i] + (p.levelAs ? at(p.levelAs[1]) - at(p.levelAs[0]) : 0) + (p.trim ?? 0));
  // the kit's level is set by one piece (its snare, unless it says), the rest keep their balance to it
  const anchor = pieces.findIndex((p) => p.name === (spec.anchor ?? 'snare'));
  if (anchor < 0) throw new Error(`No piece "${spec.anchor ?? 'snare'}" to set the kit's level by`);
  const master = (spec.level ?? -19) - refs[anchor];
  // headroom: a track's fader starts at 0 dB, so the kit comes down until its snare peaks at -2 dB at
  // full velocity, and a piece that would still peak over full scale (a spiky rimshot) comes down alone
  const peakAtTop = (piece, target) => {
    const { layers, levels } = levelsOf(piece);
    const spread = spreadLayers(levels, { range, target });
    let peak = Number.NEGATIVE_INFINITY;
    for (const h of zonesOf.get(piece)) {
      const v = spread.layers[layers.indexOf(h.hit.layer)];
      if (v.hivel === 127 && !v.unreachable) peak = Math.max(peak, h.peak + v.gain);
    }
    return peak;
  };
  const shift = Math.min(0, -2 - peakAtTop(pieces[anchor], refs[anchor] + master));
  const targets = pieces.map((p, i) => {
    const t = refs[i] + master + shift;
    return t + Math.min(0, -peakAtTop(p, t));
  });
  const tuned = pieces.some((p) => p.tune);
  const zones = [];
  pieces.forEach((piece, i) => {
    const { layers, levels } = levelsOf(piece);
    const spread = spreadLayers(levels, { range, target: targets[i] });
    for (const h of zonesOf.get(piece)) {
      const v = spread.layers[layers.indexOf(h.hit.layer)];
      if (v.unreachable) continue;
      const base = {
        file: h.path,
        lovel: v.lovel,
        hivel: v.hivel,
        gain: Math.round(v.gain * 100) / 100,
        start: 0,
        end: h.frames,
        loopStart: 0,
        loopEnd: 0,
        rate: h.rate,
        rr: h.hit.rr,
        ...(piece.group ? { group: piece.group } : {}),
        ...(piece.offBy ? { offBy: piece.offBy } : {}),
      };
      // one zone a key (a tuned piece plays its recording a few semitones up)
      if (tuned) for (const key of piece.keys) zones.push({ ...base, root: key - (piece.tune ?? 0), lo: key, hi: key });
      else {
        const lo = Math.min(...piece.keys);
        const hi = Math.max(...piece.keys);
        if (hi - lo + 1 !== piece.keys.length)
          for (const key of piece.keys) zones.push({ ...base, root: key, lo: key, hi: key });
        else zones.push({ ...base, root: lo, lo, hi });
      }
    }
  });
  zones.sort((a, b) => a.lo - b.lo || a.lovel - b.lovel || a.rr - b.rr);
  const instrument = {
    name: spec.instrument.name,
    title: spec.instrument.title,
    category: 'Drums',
    pitched: tuned,
    release: 0.08,
    attack: 0,
    oneShot: true,
    velocityRange: range,
    polyphony: 96,
    notePolyphony: 3,
    offTime: 0.035,
    zones,
  };
  const source = { kind: 'mix', note: spec.note, bases: spec.bases, downloads: {}, bits: 24, files };
  source.downloads = pinDownloads(source, downloads);
  const pack = {
    format: 'holo-pack',
    version: 1,
    id: spec.id,
    name: spec.name,
    license: spec.license,
    credit: spec.credit,
    source,
    root: 'samples',
    instruments: [instrument],
  };
  console.log(
    `  velocity range ${range} dB; ${zones.length} zones from ${Object.keys(files).length} files; ` +
      `the kit ${shift.toFixed(1)} dB for headroom${
        targets.some((t, i) => t < refs[i] + master + shift - 0.05)
          ? `, ${pieces
              .filter((_p, i) => targets[i] < refs[i] + master + shift - 0.05)
              .map((p) => p.name)
              .join(', ')} more`
          : ''
      }`,
  );
  for (const piece of pieces) {
    const { levels } = levelsOf(piece);
    console.log(
      `  ${piece.name.padEnd(14)} keys ${piece.keys.join(',').padEnd(10)} ${String(zonesOf.get(piece).length).padStart(3)} hits, ` +
        `layers ${levels.length}, ${levels[0].toFixed(1)}..${levels[levels.length - 1].toFixed(1)} dB`,
    );
  }
  await makeFiles(pack, downloads, out);
  console.log(
    `${writeManifest(pack)}: ${memoryMb(zones.filter((z, i, a) => a.findIndex((x) => x.file === z.file) === i)).toFixed(0)} MB decoded at 48 kHz`,
  );
  return pack;
}

export { Downloads };
