/**
 * A song's stems from the terminal: `holo stems` asks the host for the ZIP (as the studio's Export
 * stems does), and `holo render-audio --stems` renders them here, headless. Both read the stems
 * from the same place the studio does (`@holo/agent/edits`).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Stem, type StemsBy, stemSongs, stemWarnings } from '@holo/agent/edits';
import { type Project, projectEnd } from '@holo/session';

type Call = <T>(path: string, init?: RequestInit) => Promise<T>;

interface Job {
  state: 'waiting' | 'running' | 'done' | 'failed';
  line: string;
  error: string | null;
  file: string | null;
  url: string | null;
  path: string | null;
}

/** The stems a song has, or why it has none, and what to know about them, said before any is made. */
export function announce(project: Project, log: (text: string) => void, by: StemsBy = 'tracks'): Stem[] {
  const stems = stemSongs(project, by);
  if (!stems.length) throw new Error('Nothing in the song would be heard: no track has anything to play');
  log(
    `${stems.length === 1 ? '1 stem' : `${stems.length} stems`} of "${project.title}": ${stems.map((s) => s.file).join(', ')}`,
  );
  for (const w of stemWarnings(project, by)) log(`Note: ${w}`);
  return stems;
}

export interface HostStems {
  base: string;
  call: Call;
  project: Project;
  /** The whole song, even while its cycle is on. */
  whole: boolean;
  /** A file for each stack (its tracks together) and each track in none, instead of one a track. */
  by?: StemsBy;
  /** Where to save the ZIP here as well (it's kept on the host either way). */
  out?: string;
  log: (text: string) => void;
  progress: (text: string) => void;
  /** How long to wait between askings, ms (a test doesn't wait). */
  every?: number;
}

/** `holo stems`: the host makes the ZIP and keeps it with the song's bounces. */
export async function hostStems(o: HostStems): Promise<{ path: string; url: string }> {
  const p = o.project;
  announce(p, o.log, o.by);
  const cycle = !o.whole && p.cycle.on && p.cycle.end > p.cycle.start;
  const started = await o.call<{ id: string }>(`/api/projects/${p.id}/bounces/host`, {
    method: 'POST',
    body: JSON.stringify({
      doc: p,
      from: cycle ? p.cycle.start : 0,
      to: cycle ? p.cycle.end : projectEnd(p),
      tail: 3,
      stems: o.by === 'stacks' ? 'stacks' : true,
      name: `${p.title}${cycle ? ' (cycle)' : ''} (stems)`,
    }),
  });
  let last = '';
  for (;;) {
    const job = await o.call<Job>(`/api/bounce-jobs/${started.id}`);
    if (job.state === 'failed') throw new Error(`The stems failed on the host: ${job.error ?? 'it didn’t say why'}`);
    if (job.state === 'done' && job.url && job.path) {
      o.progress('');
      o.log(`Exported the stems to ${job.path} on the host (${o.base}${job.url})`);
      if (o.out !== undefined) {
        const file = resolve(o.out || (job.file ?? 'stems.zip'));
        const res = await fetch(`${o.base}${job.url}`);
        if (!res.ok) throw new Error(`The ZIP couldn't be fetched (${res.status})`);
        writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
        o.log(`Saved ${file}`);
      }
      return { path: job.path, url: job.url };
    }
    const line = job.state === 'waiting' ? 'Waiting for the host…' : job.line;
    if (line && line !== last) o.progress(line);
    last = line;
    await new Promise((ok) => setTimeout(ok, o.every ?? 1000));
  }
}

export interface RenderedStems {
  project: Project;
  /** A folder (made if it isn't there) or a file ending .zip. */
  out: string;
  by?: StemsBy;
  /** The stretch to render, in ticks, where it was said (else the whole song). */
  from?: number;
  to?: number;
  /** One stem's audio over that stretch, as the file's bytes. */
  render: (song: Project, name: string, stretch: { from: number; to: number }) => Promise<Uint8Array>;
  log: (text: string) => void;
}

/** `holo render-audio --stems`: each stem rendered here, into a folder or a ZIP. */
export async function renderStems(o: RenderedStems): Promise<string[]> {
  const stems = announce(o.project, o.log, o.by);
  // every stem covers the same stretch, the whole song's unless told: left to itself a render ends
  // with what it plays, and a part that stops early would be a shorter file than the others
  const stretch = { from: o.from ?? 0, to: o.to ?? projectEnd(o.project) };
  const out = resolve(o.out);
  const zipped = /\.zip$/i.test(out);
  const { ZipWriter } = await import('@holo/music');
  const zip = zipped ? new ZipWriter(out) : null;
  if (!zip) mkdirSync(out, { recursive: true });
  const made: string[] = [];
  try {
    for (const stem of stems) {
      const wav = await o.render(stem.song, stem.name, stretch);
      if (zip) zip.add(stem.file, wav);
      else writeFileSync(join(out, stem.file), wav);
      made.push(stem.file);
    }
  } finally {
    zip?.close();
  }
  o.log(`Rendered ${made.length === 1 ? '1 stem' : `${made.length} stems`} ${zipped ? 'into' : 'in'} ${out}`);
  return made;
}
