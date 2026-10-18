/** The songs, grouped: your own, then each experience's, with the engine each experience builds with. */
import { FileMusic, FolderOpen, History, Plus, Trash2 } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { openPiece, openProject } from '../app/actions.ts';
import { api, type Creation, type ProjectRow } from '../app/api.ts';
import { engineBadge, groupSongs } from '../app/songs.ts';
import { toast } from '../app/store.ts';

/** Enter or Space on a row that isn't a button (it holds one of its own) acts as a click. */
function pressable(open: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    open();
  };
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
  // the creation a new song is being named for, and the name so far
  const [naming, setNaming] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  // the song whose bin button was pressed once: the second press moves it
  const [binning, setBinning] = useState<string | null>(null);
  if (rows === null) return <div className="list-item muted">Loading…</div>;
  const groups = groupSongs(rows, creations);
  const newSong = async (c: Creation) => {
    const name = title.trim();
    if (!name) return;
    setNaming(null);
    setTitle('');
    try {
      const r = await api.newSongFor(c.name, name);
      toast(`"${r.project.title}" is ${c.title}'s now (${r.path})`);
      await openProject(r.project.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error', 8000);
    }
  };
  return (
    <>
      {groups.map((g) => {
        const badge = engineBadge(g.title, g.creation?.engine ?? null);
        const empty = g.songs.length === 0 && g.pieces.length === 0;
        return (
          <section key={g.key || '-own'} className="song-group" aria-label={g.title}>
            <div className="song-group-head">
              <span className={g.key ? 'song-group-title' : 'label'}>{g.title}</span>
              {g.key && <span className="muted">{g.key}</span>}
              {badge && (
                <span className="engine-badge" title={badge.detail}>
                  <History size={12} /> {badge.text}
                </span>
              )}
              <span className="grow" />
              {g.creation?.engine && naming !== g.creation.name && (
                <button
                  type="button"
                  className="btn ghost"
                  title={`A new song for ${g.title}, written into its songs folder`}
                  onClick={() => {
                    setNaming(g.creation?.name ?? null);
                    setTitle('');
                  }}
                >
                  <Plus size={14} /> New song
                </button>
              )}
            </div>
            {g.creation && naming === g.creation.name && (
              <div className="hstack new-song">
                <input
                  className="input"
                  // biome-ignore lint/a11y/noAutofocus: the field appears because New song was pressed
                  autoFocus
                  placeholder={`A new song for ${g.creation.title}`}
                  aria-label={`The new song's name for ${g.creation.title}`}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void newSong(g.creation as Creation);
                    else if (e.key === 'Escape') {
                      e.stopPropagation();
                      setNaming(null);
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn primary"
                  disabled={!title.trim()}
                  onClick={() => void newSong(g.creation as Creation)}
                >
                  Create
                </button>
                <button type="button" className="btn ghost" onClick={() => setNaming(null)}>
                  Cancel
                </button>
              </div>
            )}
            {g.key && !g.creation && (
              <div className="muted song-group-note">Not in the studio's creations folder (HOLO_CREATIONS_DIR).</div>
            )}
            <div className="list boxed">
              {empty && (
                <div className="list-item muted still">
                  {g.key ? (g.creation?.exportHelp ?? 'No songs yet.') : 'No songs yet.'}
                </div>
              )}
              {g.songs.map((r) => (
                // biome-ignore lint/a11y/useSemanticElements: a row with a button of its own (the bin) can't be a button itself
                <div
                  key={r.id}
                  className={`list-item${current === r.id ? ' active' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-current={current === r.id ? 'true' : undefined}
                  onClick={() => void openProject(r.id)}
                  onKeyDown={pressable(() => void openProject(r.id))}
                >
                  <FileMusic size={16} className="muted" />
                  <span className="strong">{r.title}</span>
                  {r.piece && <span className="muted">{r.piece}</span>}
                  <span className="meta">{when(r.modified)}</span>
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
                  )}
                </div>
              ))}
              {g.pieces.map((p) => (
                <button
                  key={p.piece}
                  type="button"
                  className="list-item"
                  onClick={() => void openPiece(g.key, p.piece)}
                >
                  <FolderOpen size={16} className="muted" />
                  <span className="strong">{p.title}</span>
                  <span className="muted">{p.piece}</span>
                  {p.edited > 0 && <span className="chip still">{p.edited} edited</span>}
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
