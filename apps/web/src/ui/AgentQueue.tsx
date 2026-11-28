/**
 * On the agent's page, under the song's conversation: the requests that wait on the song behind the one
 * that works, in the order they'll start. Each starts by itself when the one before it is done. After
 * one that failed or was stopped they wait for Send, on the first; behind a reply that asks for the
 * user's OK they wait for the answer, or for Send, which passes the question over. The device that sent one may reword
 * it; any allowed device may take one out.
 */
import { Pencil, X } from 'lucide-react';
import { useState } from 'react';
import { type Queued, queued, useAgent } from '../app/agent.ts';

function Row({ q, project, mine, send }: { q: Queued; project: string; mine: boolean; send: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState('');
  const [busy, setBusy] = useState(false);
  const act = (what: Parameters<typeof queued>[2]) => {
    // (one press at a time: a second Send would find it gone)
    if (busy) return Promise.resolve();
    setBusy(true);
    return queued(project, q.id, what)
      .then(
        () => {
          setText(null);
          setFailed('');
        },
        (err: unknown) => setFailed((err as Error).message),
      )
      .finally(() => setBusy(false));
  };
  if (text !== null)
    return (
      <div className="talk-queued editing">
        <textarea
          className="input"
          aria-label="The request"
          value={text}
          rows={2}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="btns">
          <button type="button" className="btn ghost" onClick={() => setText(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || !text.trim()}
            onClick={() => void act({ text: text.trim() })}
          >
            Save
          </button>
        </div>
        {failed && (
          <div className="talk-queue-note" role="alert">
            {failed}
          </div>
        )}
      </div>
    );
  return (
    <div className="talk-queued">
      <span className="grow you">{q.text}</span>
      {send && (
        <button type="button" className="btn small primary" disabled={busy} onClick={() => void act({ send: true })}>
          Send
        </button>
      )}
      {mine && (
        <button
          type="button"
          className="btn icon ghost"
          title="Reword it"
          aria-label="Reword it"
          onClick={() => setText(q.text)}
        >
          <Pencil />
        </button>
      )}
      <button
        type="button"
        className="btn icon ghost"
        title="Take it out"
        aria-label="Take it out"
        disabled={busy}
        onClick={() => void act({ remove: true })}
      >
        <X />
      </button>
      {failed && (
        <div className="talk-queue-note" role="alert">
          {failed}
        </div>
      )}
    </div>
  );
}

/** How the page says what waits, over its rows: going on by itself, held, or behind a reply's question. */
export function queueTitle(t: { held: boolean; asks: boolean }): string {
  if (t.asks) return 'Waiting for your answer above: or Send, to go on without it';
  return t.held ? 'Waiting: Send lets them go on' : 'Then';
}

/** `folded`: only how many wait, in a line (a phone on its side, typing: there's no room for the rows). */
export function Queue({ project, folded = false }: { project: string; folded?: boolean }) {
  const thread = useAgent((a) => (a.thread?.project === project ? a.thread : null));
  const me = useAgent((a) => a.me);
  if (!thread?.queue.length) return null;
  if (folded)
    return (
      <div className="talk-queue folded">
        <div className="talk-queue-title">
          {thread.queue.length === 1 ? '1 request waits its turn' : `${thread.queue.length} requests wait their turn`}
        </div>
      </div>
    );
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of the page's own rows, not a form's fieldset
    <div className="talk-queue" role="group" aria-label="Requests waiting">
      <div className="talk-queue-title">{queueTitle(thread)}</div>
      {thread.queue.map((q, i) => (
        <Row key={q.id} q={q} project={project} mine={q.device === me} send={thread.held && i === 0} />
      ))}
    </div>
  );
}
