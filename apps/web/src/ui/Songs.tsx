/** The songs, grouped: your own, then each experience's, with the engine each experience builds with. */
import { FileMusic, FolderOpen, History, Plus, Trash2 } from 'lucide-react';
import { openPiece, openProject } from '../app/actions.ts';
import { api, type Creation, type ProjectRow } from '../app/api.ts';
import { engineBadge, groupSongs } from '../app/songs.ts';
import { toast } from '../app/store.ts';

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
  if (rows === null) return <div className="list-item muted">Loading…</div>;
  const groups = groupSongs(rows, creations);
  const newSong = async (c: Creation) => {
    const title = window.prompt(`A new song for ${c.title}`, '')?.trim();
    if (!title) return;
    try {
      const r = await api.newSongFor(c.name, title);
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
              {g.creation?.engine && (
                <button
                  type="button"
                  className="btn ghost"
                  title={`A new song for ${g.title}, written into its songs folder`}
                  onClick={() => void newSong(g.creation as Creation)}
                >
                  <Plus size={14} /> New song
                </button>
              )}
            </div>
            {g.key && !g.creation && (
              <div className="muted song-group-note">Not in the studio's creations folder (HOLO_CREATIONS_DIR).</div>
            )}
            <div className="list" style={{ border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
              {empty && (
                <div className="list-item muted" style={{ cursor: 'default' }}>
                  {g.key ? (g.creation?.exportHelp ?? 'No songs yet.') : 'No songs yet.'}
                </div>
              )}
              {g.songs.map((r) => (
                <div
                  key={r.id}
                  className={`list-item${current === r.id ? ' active' : ''}`}
                  onClick={() => void openProject(r.id)}
                >
                  <FileMusic size={16} className="muted" />
                  <span style={{ fontWeight: 600 }}>{r.title}</span>
                  {r.piece && <span className="muted">{r.piece}</span>}
                  <span className="meta">{when(r.modified)}</span>
                  <button
                    type="button"
                    className="btn ghost icon"
                    title="Move to the bin"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!window.confirm(`Move “${r.title}” to the bin?`)) return;
                      void api.remove(r.id).then(reload);
                    }}
                  >
                    <Trash2 />
                  </button>
                </div>
              ))}
              {g.pieces.map((p) => (
                <div key={p.piece} className="list-item" onClick={() => void openPiece(g.key, p.piece)}>
                  <FolderOpen size={16} className="muted" />
                  <span style={{ fontWeight: 600 }}>{p.title}</span>
                  <span className="muted">{p.piece}</span>
                  {p.edited > 0 && (
                    <span className="chip" style={{ cursor: 'default' }}>
                      {p.edited} edited
                    </span>
                  )}
                  <span className="meta">in its folder · open · {when(p.modified)}</span>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
