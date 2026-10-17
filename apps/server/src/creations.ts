/**
 * Creations: projects of yours (a game, an app) whose music HO[LO] edits. A creation opts in with a
 * holo.creation.json at its root naming the folder where its sessions live. A piece's session is
 * one file, <piece>.holo.json, that both sides read and write:
 *
 *   - the creation writes it from its own score (its adapter does), and HO[LO] opens it;
 *   - HO[LO] writes it back when you send, and the creation's renderer plays the edited tracks.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { audioFolder, type PinnedEngine, slug } from '@holo/music';
import { formatJson, type Project, parseProject } from '@holo/session';

export interface CreationManifest {
  format: 'holo-creation';
  version: 1;
  name: string;
  title: string;
  /** Folder of the creation's sessions, relative to its root. */
  sessions: string;
  /** How to bring a piece in from the creation's code, shown to people and read by the AI. */
  exportHelp?: string;
  /** How to hear the creation's own render of a piece, likewise. */
  renderHelp?: string;
  /**
   * How the creation renders a piece for HO[LO] to play (run on the host by `pnpm runner`, never by
   * the server): a command and environment, with {piece}, {out} and {sessions} filled in, and where
   * the WAV it writes lands. The renderer must read the session from {sessions} and write only into
   * {out}.
   */
  render?: { command: string[]; env?: Record<string, string>; output: string };
  /** An experience's pinned engine (`holo init`): what its songs are built with. */
  engine?: PinnedEngine;
}

export interface Piece {
  piece: string;
  title: string;
  modified: string;
  tracks: number;
  edited: number;
}

interface Found {
  manifest: CreationManifest;
  root: string;
  sessions: string;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class Creations {
  private readonly dir: string | null;
  constructor(dir: string | null) {
    this.dir = dir;
  }

  private all(): Found[] {
    if (!this.dir || !existsSync(this.dir)) return [];
    const out: Found[] = [];
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const root = join(this.dir, entry.name);
      const file = join(root, 'holo.creation.json');
      if (!existsSync(file)) continue;
      try {
        const manifest = JSON.parse(readFileSync(file, 'utf8')) as CreationManifest;
        if (manifest.format !== 'holo-creation' || !NAME.test(manifest.name)) continue;
        const sessions = normalize(join(root, manifest.sessions));
        if (!sessions.startsWith(root + sep)) continue;
        out.push({ manifest, root, sessions });
      } catch {
        // not readable: not listed
      }
    }
    return out;
  }

  private find(name: string): Found | null {
    return this.all().find((c) => c.manifest.name === name) ?? null;
  }

  list() {
    return this.all().map(({ manifest, sessions }) => ({
      name: manifest.name,
      title: manifest.title,
      exportHelp: manifest.exportHelp ?? null,
      renderHelp: manifest.renderHelp ?? null,
      canRender: Array.isArray(manifest.render?.command) && typeof manifest.render?.output === 'string',
      engine: manifest.engine ?? null,
      pieces: this.pieces(sessions),
    }));
  }

  private pieces(dir: string): Piece[] {
    if (!existsSync(dir)) return [];
    const out: Piece[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.holo.json')) continue;
      try {
        const project = parseProject(JSON.parse(readFileSync(join(dir, f), 'utf8')));
        out.push({
          piece: f.slice(0, -'.holo.json'.length),
          title: project.title,
          modified: statSync(join(dir, f)).mtime.toISOString(),
          tracks: project.tracks.length,
          edited: project.tracks.filter((t) => t.origin?.edited).length,
        });
      } catch {
        // a broken file isn't offered
      }
    }
    return out.sort((a, b) => a.piece.localeCompare(b.piece));
  }

  read(name: string, piece: string): Project {
    const c = this.find(name);
    if (!c || !NAME.test(piece)) throw new Error(`No creation "${name}" or piece "${piece}"`);
    const file = join(c.sessions, `${piece}.holo.json`);
    if (!existsSync(file))
      throw new Error(`${name} has no session for "${piece}" yet: export it from the creation first`);
    return parseProject(JSON.parse(readFileSync(file, 'utf8')));
  }

  /** Whether a creation exists here and declares a render. */
  renderable(name: string): { title: string } | null {
    const c = this.find(name);
    return c?.manifest.render ? { title: c.manifest.title } : null;
  }

  /** A name for a new piece in a creation: the one asked for, or one from the title not yet taken. */
  freePiece(name: string, title: string, asked?: string): string {
    const fail = (status: number, message: string) => Object.assign(new Error(message), { statusCode: status });
    const c = this.find(name);
    if (!c) throw fail(404, `No creation "${name}" in the creations folder`);
    const taken = (p: string) => existsSync(join(c.sessions, `${p}.holo.json`));
    if (asked) {
      if (!NAME.test(asked)) throw fail(400, `"${asked}" can't be a piece's name: lower case letters, digits, - and _`);
      if (taken(asked)) throw fail(409, `${c.manifest.title} has a song "${asked}" already`);
      return asked;
    }
    const base = slug(title);
    let piece = base;
    for (let n = 2; taken(piece); n++) piece = `${base.slice(0, 60)}-${n}`;
    return piece;
  }

  /**
   * Write a session back into its creation (atomically: a renderer never reads half a file), and the
   * song's own audio files beside it (<piece>.audio/), so they travel with the creation.
   */
  write(project: Project, audioDir?: string): string {
    const origin = project.origin;
    if (!origin) throw new Error('This song did not come from a creation');
    const c = this.find(origin.creation);
    if (!c || !NAME.test(origin.piece)) throw new Error(`No creation "${origin.creation}" here`);
    mkdirSync(c.sessions, { recursive: true });
    const file = join(c.sessions, `${origin.piece}.holo.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, sessionText(project));
    renameSync(tmp, file);
    if (audioDir) this.writeAudio(c.sessions, origin.piece, project, audioDir);
    return `${c.manifest.sessions}/${origin.piece}.holo.json`;
  }

  /** The song's audio files into <piece>.audio/: those it plays, and no others. */
  private writeAudio(sessions: string, piece: string, project: Project, audioDir: string): void {
    const ids = new Set((project.files ?? []).map((f) => f.id));
    const dest = audioFolder(sessions, piece);
    const have = existsSync(audioDir) ? readdirSync(audioDir).filter((f) => ids.has(f.replace(/\..*$/, ''))) : [];
    if (!have.length && !existsSync(dest)) return;
    mkdirSync(dest, { recursive: true });
    for (const f of have) {
      const to = join(dest, f);
      if (!existsSync(to) || statSync(to).size !== statSync(join(audioDir, f)).size)
        copyFileSync(join(audioDir, f), to);
    }
    for (const f of readdirSync(dest)) if (/^aud_[a-z0-9]+\./.test(f) && !have.includes(f)) rmSync(join(dest, f));
  }

  /** A piece's audio files in its creation (to bring in with it). */
  audioFiles(name: string, piece: string): string[] {
    const c = this.find(name);
    if (!c || !NAME.test(piece)) return [];
    const dir = audioFolder(c.sessions, piece);
    return existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => /^aud_[a-z0-9]+\.[a-z0-9]{2,5}$/.test(f))
          .map((f) => join(dir, f))
      : [];
  }
}

/** A song as its creation's session file (what Send writes, and what a render reads). */
export function sessionText(project: Project): string {
  const origin = project.origin;
  return formatJson(origin ? { ...project, origin: { ...origin, sentAt: new Date().toISOString() } } : project);
}
