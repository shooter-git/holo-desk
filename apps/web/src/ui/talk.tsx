/**
 * The agent's side of a conversation, shared by the bar (a desktop's) and the page (a phone's or a
 * tablet's): an exchange (the request, the work going on or the reply, what the reply shows under it,
 * at most the button it needs), a permission's one button (with a screenshot or a photo shown before
 * it leaves), and a brief for the user's own harness with the lines to read twice marked.
 */
import { useEffect, useRef, useState } from 'react';
import { bounceSong, exportStems, renderForAgent, sendToCreation } from '../app/actions.ts';
import {
  afterFailure,
  allowLabel,
  type BriefWarning,
  doneListening,
  type Exchange,
  elapsedClock,
  elapsedMs,
  type Permission,
  permit,
  resetOffer,
  serverNow,
  stopJob,
  tryAgain,
  upload,
  useAgent,
  waitForReset,
} from '../app/agent.ts';
import { canCaptureScreen, grabScreen, type Ready, record, redraw } from '../app/attach.ts';
import { useApp } from '../app/store.ts';
import { installs, useInstalls } from '../audio/installs.ts';
import { MoveButton } from './AgentChooser.tsx';
import { AgentView } from './AgentView.tsx';
import { atClock, startsAgain } from './harness-usage.ts';

/** "0:07": how long a recording has run. */
export const clock = (ms: number) =>
  `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/**
 * The one button a job's permission needs, beside the agent's reason for it (a pack's says what it
 * downloads): a click runs the studio's own code (the Library's install queue, sending the song to its
 * creation, a bounce, the creation's own render, capturing the screen, a photo, the microphone), then
 * the host hears what happened and the agent carries on. A screenshot or a photo is shown first, small,
 * with Send and Cancel: nothing leaves the device until Send.
 */
export function PermissionButton({
  job,
  permission,
  project,
}: {
  job: string;
  permission: Permission;
  project: string;
}) {
  const [busy, setBusy] = useState('');
  const [failed, setFailed] = useState('');
  const [preview, setPreview] = useState<{ file: Ready; url: string; result: string } | null>(null);
  const [recording, setRecording] = useState<{ stop: () => void; since: number } | null>(null);
  const [now, setNow] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  const install = useInstalls();
  // a phone can't capture its screen: a photo of it stands in
  const kind = permission.kind === 'screen' && !canCaptureScreen() ? 'photo' : permission.kind;
  // a pack's size, from the catalog the Library reads
  const packId = permission.kind === 'install-pack' ? (permission.pack ?? null) : null;
  useEffect(() => {
    if (packId && !installs.state.packs) void installs.load();
  }, [packId]);
  const pack = packId ? install.packs?.find((p) => p.id === packId) : undefined;
  // the creation that renders the song ("Hear it as my-game")
  const creation = useApp((s) => s.project?.origin?.creation);

  useEffect(() => {
    if (!recording) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [recording]);
  useEffect(() => () => (preview ? URL.revokeObjectURL(preview.url) : undefined), [preview]);

  const attempt = async (what: string, work: () => Promise<void>) => {
    setBusy(what);
    setFailed('');
    try {
      await work();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };
  // what was captured goes up as an attachment of the song's, and the answer carries it
  const send = (file: Ready, result: string) =>
    attempt('Sending…', async () => {
      const id = await upload(file, project);
      await permit(job, true, result, [id]);
      setPreview(null);
    });
  const shown = (file: Ready, result: string) => setPreview({ file, url: URL.createObjectURL(file.blob), result });

  const run = () => {
    if (kind === 'install-pack' && permission.pack) {
      const pack = permission.pack;
      return attempt('Installing…', async () => {
        if (!install.packs) await installs.load();
        const name = installs.pack(pack)?.name ?? pack;
        // (named, so the Library shows it in its queue, and no toast says it's in: the reply will)
        const ok = await installs.install([pack], name);
        await permit(job, true, ok ? `Installed ${name}` : `${name} couldn’t be installed`);
      });
    }
    if (kind === 'send-creation')
      return attempt('Sending…', async () => {
        const sent = await sendToCreation(true);
        await permit(
          job,
          true,
          sent ? sent.text : 'This song didn’t come from a creation, so there’s none to send it to',
        );
      });
    if (kind === 'bounce')
      return attempt('Bouncing…', async () => {
        // the song (or the cycle, when it's on), kept with it on the host, where the agent measures it
        const r = await bounceSong(false);
        if (!r) throw new Error('The bounce didn’t finish: try again');
        await permit(job, true, `Bounced ${clock(r.seconds * 1000)} of the song, kept with it as ${r.path}`);
      });
    if (kind === 'stems' || kind === 'stems-stacks')
      return attempt('Exporting the stems…', async () => {
        // a WAV for each track (or each stack), in a ZIP the host makes and keeps with the song's bounces
        const stacks = kind === 'stems-stacks';
        const r = await exportStems(undefined, false, stacks ? 'stacks' : 'tracks');
        if (!r) throw new Error('The stems weren’t made: try again');
        await permit(
          job,
          true,
          `Exported the song’s stems (a 24-bit WAV for each ${stacks ? 'stack, and each track in none' : 'track'}), kept with it as ${r.path}`,
        );
      });
    if (kind === 'render')
      return attempt('Rendering…', async () => {
        await permit(job, true, await renderForAgent());
      });
    if (kind === 'screen')
      return attempt('Choose what to share…', async () => shown(await grabScreen(), 'Shared a screenshot'));
    if (kind === 'photo') {
      picker.current?.click();
      return;
    }
    if (kind === 'microphone')
      return attempt('Asking for the microphone…', async () => {
        const r = await record((made) => {
          setRecording(null);
          void attempt('Measuring…', async () => {
            const file = await made;
            const seconds = Math.round(Number(file.meta?.seconds ?? 0));
            await send(file, `Recorded ${seconds} s from the microphone`);
          });
        });
        setNow(Date.now());
        setRecording({ ...r, since: Date.now() });
      });
  };

  return (
    <>
      {preview && (
        <div className="shot">
          <img src={preview.url} alt="What will be sent" />
        </div>
      )}
      {busy && kind === 'install-pack' && install.job?.line ? (
        <span className="muted grow bar-line">{install.job.line}</span>
      ) : busy ? (
        <span className="muted grow bar-line">{busy}</span>
      ) : null}
      {recording && <span className="muted grow bar-line">Recording {clock(now - recording.since)}</span>}
      {failed && <span className="agent-error grow bar-line">{failed}</span>}
      {!busy && !recording && !failed && !preview && permission.detail && (
        <span className="muted grow bar-line" title={permission.detail}>
          {permission.detail}
        </span>
      )}
      {kind === 'photo' && (
        <input
          ref={picker}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f)
              void attempt('Reading the photo…', async () =>
                shown(await redraw(f, 'photo.jpg', 'image/jpeg'), 'Took a photo'),
              );
          }}
        />
      )}
      {preview ? (
        <>
          <button type="button" className="btn ghost" disabled={!!busy} onClick={() => setPreview(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!!busy}
            onClick={() => void send(preview.file, preview.result)}
          >
            Send
          </button>
        </>
      ) : recording ? (
        <button type="button" className="btn primary" onClick={() => recording.stop()}>
          Done
        </button>
      ) : (
        <button type="button" className="btn" disabled={!!busy} onClick={() => void run()}>
          {permission.kind === 'screen' && kind === 'photo'
            ? 'Take a photo instead'
            : allowLabel(permission, pack, creation)}
        </button>
      )}
    </>
  );
}

/** Why a flagged line of a brief is to be read twice. */
export const WHY: Record<BriefWarning, string> = {
  command: 'runs a command',
  url: 'a link: check where it goes',
  secret: 'asks for something secret: don’t pass it on',
};

/**
 * A brief for the user's own harness, in full: the lines that run something, link somewhere or ask for
 * something secret are marked.
 */
export function Brief({ text, flagged }: { text: string; flagged: Exchange['flagged'] }) {
  return (
    <div className="brief" role="document" aria-label="Brief">
      {text.split('\n').map((line, i) => {
        const flag = flagged.get(i);
        return (
          <div key={i} className={flag ? 'flag' : undefined}>
            {line || '\u00a0'}
            {flag && <span className="why">{WHY[flag] ?? WHY.command}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function CopyBrief({ text }: { text: string }) {
  const [said, setSaid] = useState('');
  return (
    <button
      type="button"
      className="btn"
      onClick={() =>
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setSaid('Copied'))
          // (a page served over plain http on the network may not write to the clipboard)
          .catch(() => setSaid('Select it above to copy'))
      }
    >
      {said || 'Copy brief'}
    </button>
  );
}

/**
 * An exchange: the request, then the work going on or the reply, what the reply shows under it, then
 * its buttons (one that failed: Try again where that may help, Carry on at the time its harness's
 * limit starts again, and Continue with… where another harness is ready). `elapsed` (the page's) shows how long it has been working, beside its line.
 */
export function TalkBody({
  ex,
  project,
  busy,
  elapsed = false,
  last = false,
  choosing = false,
}: {
  ex: Exchange;
  project: string;
  busy: boolean;
  elapsed?: boolean;
  /** The conversation's last exchange: one that failed can be tried again from here, or carried on with another harness. */
  last?: boolean;
  /** The page's chooser is open under it: it has the buttons a failure would. */
  choosing?: boolean;
}) {
  const job = ex.job;
  // (what a failure that won't pass by itself needs, and Try again when it might)
  const now = serverNow();
  const after = last && ex.mine ? afterFailure(ex, (resets) => startsAgain(resets, { now }), now) : null;
  // out of usage till a time its harness said: it can be carried on by itself then, and that called off
  const reset = last ? resetOffer(ex, now) : null;
  const waits = reset && 'waiting' in reset ? reset.waiting : null;
  const buttons = [
    ex.permission && job && ex.mine && (
      <PermissionButton key="allow" job={job} permission={ex.permission} project={project} />
    ),
    after?.again && job && !choosing && (
      <button key="again" type="button" className="btn" onClick={() => void tryAgain(ex, project)}>
        Try again
      </button>
    ),
    reset && 'at' in reset && job && ex.mine && !choosing && (
      <button
        key="wait"
        type="button"
        className="btn"
        onClick={() => void waitForReset(job, true, project).catch(() => undefined)}
      >
        Carry on {atClock(reset.at, { now })}
      </button>
    ),
    waits && job && ex.mine && !choosing && (
      <button
        key="no-wait"
        type="button"
        className="btn ghost"
        onClick={() => void waitForReset(job, false, project).catch(() => undefined)}
      >
        Don’t carry on
      </button>
    ),
    // (it shows only where another harness, or another model, could take the request)
    after && job && !choosing && <MoveButton key="move" ex={ex} project={project} />,
    ex.brief && <CopyBrief key="brief" text={ex.brief} />,
  ].filter(Boolean);
  return (
    <>
      <div className="you">{ex.request}</div>
      {ex.working ? (
        <div className="status">
          <span className="ring" aria-hidden="true" />
          <span className="grow bar-line">
            {ex.listening ? 'Listening: play it, then press Done' : (ex.line ?? 'Working on it')}
          </span>
          {elapsed && <Elapsed started={ex.started} />}
          {ex.listening && job && ex.mine && (
            <button type="button" className="btn primary small" onClick={() => void doneListening(job)}>
              Done
            </button>
          )}
          {job && (
            <button type="button" className="btn ghost small" onClick={() => void stopJob(job).catch(() => undefined)}>
              Stop
            </button>
          )}
        </div>
      ) : (
        ex.reply && <div className="reply">{ex.reply}</div>
      )}
      {!ex.working && after?.say && <div className="reply-after">{after.say}</div>}
      {/* (the time its limit starts again, as the button said it: it's carried on a moment after) */}
      {!ex.working && waits && (
        <div className="reply-after">It carries on by itself {atClock(ex.stop?.resets ?? waits, { now })}.</div>
      )}
      {!ex.working && ex.view && ex.job && <AgentView view={ex.view} job={ex.job} busy={busy} />}
      {ex.brief && <Brief text={ex.brief} flagged={ex.flagged} />}
      {buttons.length > 0 && <div className="btns">{buttons}</div>}
    </>
  );
}

/**
 * How long a request has been working ("1:05"), counted on the host's clock: it moves once a second,
 * only while it's shown (the page open, the request working).
 */
function Elapsed({ started }: { started: number }) {
  const skew = useAgent((a) => a.skew);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const ms = elapsedMs(started, now, skew);
  return (
    <span className="talk-time" title="How long it has been working">
      {elapsedClock(ms)}
    </span>
  );
}

/**
 * The song's last exchange under the bar's field: the request, then the work going on or the reply,
 * what the reply shows under it, then its button.
 */
export function Talk({ ex, project, busy }: { ex: Exchange; project: string; busy: boolean }) {
  return (
    <div className="talk" aria-live="polite">
      <TalkBody ex={ex} project={project} busy={busy} last />
    </div>
  );
}
