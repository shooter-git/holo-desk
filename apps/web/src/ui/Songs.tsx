/**
 * The songs, grouped: your own, then each album (or artist) you gave some, then each experience's,
 * with the engine each experience builds with; and a search across them all.
 */
import {
  AudioLines,
  ChevronDown,
  ChevronRight,
  Disc3,
  Download,
  FileMusic,
  FolderOpen,
  History,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useState } from 'react';
import {
  bounceClock,
  deleteListedBounce,
  openPiece,
  openProject,
  renameSong,
  saveListedBounce,
} from '../app/actions.ts';
import { songSigns, useAgent } from '../app/agent.ts';
import { api, type Creation, type ProjectRow } from '../app/api.ts';
import { diskSize } from '../app/disk-size.ts';
import { type ListedBounce, songBounces } from '../app/host-bounce.ts';
import { engineBadge, groupSongs, type SongGroup, searchSongs, songDetailNames } from '../app/songs.ts';
import { toast, useApp } from '../app/store.ts';

/** Enter or Space on a row that isn't a button (it holds one of its own) acts as a click. */
function pressable(open: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    open();
  };
}

/**
 * A song's icon in the list. With the agent on: a ring in its place while a request of this device's
 * works on the song, and a dot on it while that request's reply hasn't been read.
 */
function SongIcon({ sign }: { sign: 'busy' | 'done' | undefined }) {
  if (!sign) return <FileMusic size={16} className="muted" />;
  const says = sign === 'busy' ? 'The agent is at work on this song' : 'A reply is waiting on this song';
  return (
    <span className="song-sign" role="img" aria-label={says} title={says}>
      {sign === 'busy' ? (
        <span className="ring" />
      ) : (
        <>
          <FileMusic size={16} className="muted" />
          <span className="song-dot" />
        </>
      )}
    </span>
  );
}

export function SongGroups({
  rows,
  creations,
  current,
  when,
  reload,
}: {
  rows: ProjectRow[] | null;
  creations: Creation[];
  current: string | null;
  when: (iso: string) => string;
  reload: () => void;
}) {
  // what the search has so far
  const [query, setQuery] = useState('');
  // the group (a creation or an album) a new song is being named for, and the name so far
  const [naming, setNaming] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  // the song whose bin button was pressed once: the second press moves it
  const [binning, setBinning] = useState<string | null>(null);
  // the song being renamed, and its name so far
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  // the song whose artist and album are being set, and them so far
  const [describing, setDescribing] = useState<string | null>(null);
  const [artist, setArtist] = useState('');
  const [album, setAlbum] = useState('');
  // this device's requests to the agent, by song: at work, or replied to and not read
  const signs = songSigns(useAgent((a) => a));
  if (rows === null) return <div className="list-item muted">Loading…</div>;
  const groups = searchSongs(groupSongs(rows, creations), query);
  const names = songDetailNames(rows);
  // a new song for a creation is written into its folder; one for an album is by its artist, on it
  const newSong = async (g: SongGroup) => {
    const name = title.trim();
    if (!name) return;
    setNaming(null);
    setTitle('');
    try {
      if (g.creation) {
        const r = await api.newSongFor(g.creation.name, name);
        toast(`"${r.project.title}" is ${g.creation.title}'s now (${r.path})`);
        await openProject(r.project.id);
      } else if (g.kind === 'album') {
        const p = await api.create(name);
        await api.setDetails(p.id, { artist: g.artist, album: g.album });
        await openProject(p.id);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error', 8000);
    }
  };
  const describe = async (r: ProjectRow) => {
    const tidy = (s: string) => s.trim().replace(/\s+/g, ' ') || null;
    const next = { artist: tidy(artist), album: tidy(album) };
    setDescribing(null);
    if (next.artist === r.artist && next.album === r.album) return;
    try {
      await api.setDetails(r.id, next);
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };
  const rename = async (r: ProjectRow) => {
    const name = newName.trim();
    setRenaming(null);
    if (!name || name === r.title) return;
    if (await renameSong(r.id, name)) reload();
  };
  return (
    <>
      <div className="song-search">
        <Search size={14} className="muted" />
        <input
          className="input"
          type="search"
          placeholder="Search songs, artists, albums"
          aria-label="Search songs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Escape clears the search first, and closes the dialog only when there's none
            if (e.key === 'Escape' && query) {
              e.stopPropagation();
              setQuery('');
            }
          }}
        />
      </div>
      {query.trim() && groups.length === 0 && (
        <div className="list-item muted still">No songs match "{query.trim()}".</div>
      )}
      <datalist id="song-artists">
        {names.artists.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <datalist id="song-albums">
        {names.albums.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {groups.map((g) => {
        const badge = engineBadge(g.title, g.creation?.engine ?? null);
        const empty = g.songs.length === 0 && g.pieces.length === 0;
        // a creation that builds its own music takes new songs into its folder; an album takes them too
        const takesNew = !!g.creation?.engine || g.kind === 'album';
        return (
          <section key={g.key || '-own'} className="song-group" aria-label={g.title}>
            <div className="song-group-head">
              <span className={g.kind === 'own' ? 'label' : 'song-group-title'}>{g.title}</span>
              {g.kind === 'creation' && <span className="muted">{g.key}</span>}
              {g.kind === 'album' && g.album && g.artist && <span className="muted">{g.artist}</span>}
              {g.kind === 'album' && !g.album && <span className="muted">no album</span>}
              {badge && (
                <span className="engine-badge" title={badge.detail}>
                  <History size={12} /> {badge.text}
                </span>
              )}
              <span className="grow" />
              {takesNew && naming !== g.key && (
                <button
                  type="button"
                  className="btn ghost"
                  title={
                    g.creation ? `A new song for ${g.title}, written into its songs folder` : `A new song in ${g.title}`
                  }
                  onClick={() => {
                    setNaming(g.key);
                    setTitle('');
                  }}
                >
                  <Plus size={14} /> New song
                </button>
              )}
            </div>
            {takesNew && naming === g.key && (
              <div className="hstack new-song">
                <input
                  className="input"
                  // biome-ignore lint/a11y/noAutofocus: the field appears because New song was pressed
                  autoFocus
                  placeholder={g.creation ? `A new song for ${g.title}` : `A new song in ${g.title}`}
                  aria-label={`The new song's name for ${g.title}`}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void newSong(g);
                    else if (e.key === 'Escape') {
                      e.stopPropagation();
                      setNaming(null);
                    }
                  }}
                />
                <button type="button" className="btn primary" disabled={!title.trim()} onClick={() => void newSong(g)}>
                  Create
                </button>
                <button type="button" className="btn ghost" onClick={() => setNaming(null)}>
                  Cancel
                </button>
              </div>
            )}
            {g.kind === 'creation' && !g.creation && (
              <div className="muted song-group-note">Not in the studio's creations folder (HOLO_CREATIONS_DIR).</div>
            )}
            <div className="list boxed">
              {empty && (
                <div className="list-item muted still">
                  {g.kind === 'creation' ? (g.creation?.exportHelp ?? 'No songs yet.') : 'No songs yet.'}
                </div>
              )}
              {g.songs.flatMap((r) => [
                describing === r.id ? (
                  <div key={r.id} className={`list-item renaming details${current === r.id ? ' active' : ''}`}>
                    <Disc3 size={16} className="muted" />
                    <input
                      className="input"
                      // biome-ignore lint/a11y/noAutofocus: the fields appear because Artist and album was pressed
                      autoFocus
                      list="song-artists"
                      placeholder="Artist"
                      aria-label={`Who ${r.title} is by`}
                      value={artist}
                      onChange={(e) => setArtist(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void describe(r);
                        else if (e.key === 'Escape') {
                          e.stopPropagation();
                          setDescribing(null);
                        }
                      }}
                    />
                    <input
                      className="input"
                      list="song-albums"
                      placeholder="Album"
                      aria-label={`The album ${r.title} is on`}
                      value={album}
                      onChange={(e) => setAlbum(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void describe(r);
                        else if (e.key === 'Escape') {
                          e.stopPropagation();
                          setDescribing(null);
                        }
                      }}
                    />
                    <button type="button" className="btn primary" onClick={() => void describe(r)}>
                      Save
                    </button>
                    <button type="button" className="btn ghost" onClick={() => setDescribing(null)}>
                      Cancel
                    </button>
                  </div>
                ) : renaming === r.id ? (
                  <div key={r.id} className={`list-item renaming${current === r.id ? ' active' : ''}`}>
                    <FileMusic size={16} className="muted" />
                    <input
                      className="input"
                      // biome-ignore lint/a11y/noAutofocus: the field appears because Rename was pressed
                      autoFocus
                      aria-label={`A new name for ${r.title}`}
                      value={newName}
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void rename(r);
                        else if (e.key === 'Escape') {
                          e.stopPropagation();
                          setRenaming(null);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn primary"
                      disabled={!newName.trim()}
                      onClick={() => void rename(r)}
                    >
                      Rename
                    </button>
                    <button type="button" className="btn ghost" onClick={() => setRenaming(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  // biome-ignore lint/a11y/useSemanticElements: a row with a button of its own (the bin) can't be a button itself
                  <div
                    key={r.id}
                    className={`list-item song-row${current === r.id ? ' active' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-current={current === r.id ? 'true' : undefined}
                    onClick={() => void openProject(r.id)}
                    onKeyDown={pressable(() => void openProject(r.id))}
                  >
                    <SongIcon sign={signs.get(r.id)} />
                    <span className="song-name">
                      <span className="strong">{r.title}</span>
                      {r.piece && <span className="muted">{r.piece}</span>}
                    </span>
                    <span className="meta" title={`Saved ${when(r.modified)} · created ${when(r.created)}`}>
                      {when(r.modified)}
                    </span>
                    {binning === r.id ? (
                      <span className="hstack" onClick={(e) => e.stopPropagation()}>
                        <span className="muted">Move to the bin?</span>
                        <button
                          type="button"
                          className="btn danger"
                          onClick={() => {
                            setBinning(null);
                            void api.remove(r.id).then(reload);
                          }}
                        >
                          Move
                        </button>
                        <button type="button" className="btn ghost" onClick={() => setBinning(null)}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn ghost icon"
                          title="Rename"
                          aria-label={`Rename ${r.title}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setBinning(null);
                            setDescribing(null);
                            setNewName(r.title);
                            setRenaming(r.id);
                          }}
                        >
                          <Pencil />
                        </button>
                        {!r.creation && (
                          <button
                            type="button"
                            className="btn ghost icon"
                            title="Artist and album"
                            aria-label={`${r.title}'s artist and album`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setBinning(null);
                              setRenaming(null);
                              setArtist(r.artist ?? '');
                              setAlbum(r.album ?? '');
                              setDescribing(r.id);
                            }}
                          >
                            <Disc3 />
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn ghost icon"
                          title="Move to the bin"
                          aria-label={`Move ${r.title} to the bin`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setBinning(r.id);
                          }}
                        >
                          <Trash2 />
                        </button>
                      </>
                    )}
                  </div>
                ),
                // the open song's bounces, under its row: one folded line until it's opened
                current === r.id && <SongBounces key={`${r.id}:bounces`} id={r.id} title={r.title} when={when} />,
              ])}
              {g.pieces.map((p) => (
                <button
                  key={p.piece}
                  type="button"
                  className="list-item song-row"
                  onClick={() => void openPiece(g.key, p.piece)}
                >
                  <FolderOpen size={16} className="muted" />
                  <span className="song-name">
                    <span className="strong">{p.title}</span>
                    <span className="muted">{p.piece}</span>
                    {p.edited > 0 && <span className="chip still">{p.edited} edited</span>}
                  </span>
                  <span className="meta">in its folder · open · {when(p.modified)}</span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

/** How many of a song's bounces show, once they're opened, before the rest are asked for. */
const BOUNCES_SHOWN = 3;

/**
 * The open song's bounces, kept with it on the host, nested under its row in Songs: one line saying
 * how many there are, folded until it's pressed; opened, each bounce to save on this device again
 * or to delete for good. Nothing is shown of a song with none.
 */
function SongBounces({ id, title, when }: { id: string; title: string; when: (iso: string) => string }) {
  const [rows, setRows] = useState<ListedBounce[]>([]);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  // the bounce whose delete is being asked about
  const [deleting, setDeleting] = useState<string | null>(null);
  // one being made, and the one whose line is showing (where saving goes through the share sheet, a row follows it)
  const making = useApp((s) => s.bouncing !== null);
  const shown = useApp((s) => s.bounced);
  // (asked again when a bounce has just been made)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `making` is why it's asked again
  useEffect(() => {
    let stale = false;
    void songBounces(id).then(
      (list) => {
        if (!stale) setRows(list);
      },
      () => {
        if (!stale) setRows([]);
      },
    );
    return () => {
      stale = true;
    };
  }, [id, making]);
  if (!rows.length) return null;
  const remove = async (b: ListedBounce) => {
    setDeleting(null);
    if (await deleteListedBounce(b)) setRows((list) => list.filter((r) => r.file !== b.file));
  };
  const visible = all ? rows : rows.slice(0, BOUNCES_SHOWN);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a part of the list of songs, not a form's set of fields
    <div className="song-bounces" role="group" aria-label={`Bounces of ${title}`}>
      <button
        type="button"
        className="list-item bounces-head"
        aria-expanded={open}
        title={open ? 'Fold this song’s bounces away' : 'This song’s bounces, to save again or delete'}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <span>{rows.length === 1 ? '1 bounce' : `${rows.length} bounces`}</span>
        <span className="meta">{diskSize(rows.reduce((sum, b) => sum + b.bytes, 0))} on the host</span>
      </button>
      {open &&
        visible.map((b) => {
          const made = b.made ? when(new Date(b.made).toISOString()) : '';
          // (its length and size stay together: on a narrow row they go under when it was made, whole)
          const size = [b.seconds === null ? '' : bounceClock(b.seconds), diskSize(b.bytes)]
            .filter(Boolean)
            .join(' · ')
            .replaceAll(' ', '\u00a0');
          const details = [made, size].filter(Boolean).join(' · ');
          const mine = shown?.url === b.url ? shown : null;
          return deleting === b.file ? (
            <div key={b.file} className="list-item still bounce-row asking">
              <span className="muted grow">
                Delete “{b.title}”{made ? ` of ${made}` : ''} for good?
              </span>
              <button type="button" className="btn danger" onClick={() => void remove(b)}>
                Delete
              </button>
              <button type="button" className="btn ghost" onClick={() => setDeleting(null)}>
                Keep
              </button>
            </div>
          ) : (
            <div key={b.file} className="list-item still song-row bounce-row">
              <AudioLines size={14} className="muted" />
              <span className="song-name">
                <span>{b.title}</span>
              </span>
              <span className="meta">{details}</span>
              <button
                type="button"
                className={`btn${mine?.ready ? ' primary' : ' ghost'}${mine && !mine.ready ? '' : ' icon'}`}
                disabled={mine !== null && !mine.ready}
                title={mine?.ready ? 'Save it now' : 'Save on this device'}
                aria-label={`Save the bounce “${b.title}”${made ? ` of ${made}` : ''} on this device`}
                onClick={() => void saveListedBounce(b)}
              >
                {mine && !mine.ready ? 'Getting…' : <Download />}
              </button>
              <button
                type="button"
                className="btn ghost icon"
                title="Delete this bounce"
                aria-label={`Delete the bounce “${b.title}”${made ? ` of ${made}` : ''}`}
                onClick={() => setDeleting(b.file)}
              >
                <Trash2 />
              </button>
            </div>
          );
        })}
      {open && !all && rows.length > BOUNCES_SHOWN && (
        <button type="button" className="list-item muted bounces-all" onClick={() => setAll(true)}>
          All {rows.length} bounces
        </button>
      )}
    </div>
  );
}
