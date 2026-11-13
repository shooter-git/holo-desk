/**
 * A recorded take's way to the song: kept on this device first, then sent, then placed where it was
 * played. When the server doesn't answer it's tried a few times, then left kept and sent again later
 * (while the song stays open, and the next time it's opened); a take the server refuses stays kept
 * too, and either way there's a copy to save by hand. Nothing recorded is dropped because an upload
 * failed.
 */
import type { AudioFile } from '@holo/session';
import { type KeptTake, type TakePlan, type Takes, UploadError } from '../audio/takes.ts';

export interface TakeDeps {
  takes: Takes;
  upload: (take: TakePlan, wav: Blob) => Promise<AudioFile>;
  /** Put the take's regions in the open song: false when its song isn't the one open. */
  place: (take: TakePlan, file: AudioFile) => boolean;
  say: (text: string, kind: 'info' | 'error', ms?: number, action?: { label: string; run: () => void }) => void;
  /** Hand the take's WAV to the person, as a download. */
  save: (name: string, wav: Blob) => void;
  wait: (ms: number) => Promise<void>;
}

/** The waits before a take just recorded is tried again, while the server gives no answer. */
const TRIES = [0, 700, 2500];

export class TakeSender {
  private readonly deps: TakeDeps;
  /** Takes on their way now (not sent twice by two callers). */
  private readonly going = new Set<string>();
  constructor(deps: TakeDeps) {
    this.deps = deps;
  }

  /** A take just recorded. True when it's with the song; false when it waits, kept, to be sent again. */
  async record(plan: TakePlan, wav: Blob): Promise<boolean> {
    const { takes, say, save } = this.deps;
    const kept = await takes.keep(plan, wav);
    const copy = { label: 'Save a copy', run: () => save(`${plan.name}.wav`, wav) };
    try {
      const file = await this.send(plan, wav, TRIES);
      await this.land(kept, plan, file);
      return true;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const refused = err instanceof UploadError && !err.passing;
      if (!kept)
        say(`${plan.name} couldn’t be sent (${why}), and this device has nowhere to keep it.`, 'error', 20_000, copy);
      else if (refused)
        say(`The server wouldn’t take ${plan.name} (${why}). It’s kept on this device.`, 'error', 20_000, copy);
      else
        say(
          `${plan.name} couldn’t be sent (${why}). It’s kept on this device and will be sent when the server answers.`,
          'error',
          12_000,
          copy,
        );
      return false;
    }
  }

  /**
   * The takes kept here for a song, sent again (once each) and placed. The number still waiting.
   * Quiet when the server still doesn't answer.
   */
  async resume(project: string): Promise<number> {
    const { takes, say } = this.deps;
    let left = 0;
    for (const take of await takes.list(project)) {
      if (this.going.has(take.id)) {
        left++;
        continue;
      }
      this.going.add(take.id);
      try {
        let file = take.file;
        if (!file) {
          const wav = await takes.wav(take.id);
          if (!wav) {
            await takes.forget(take.id);
            continue;
          }
          file = await this.send(take, wav, [0]);
        }
        if (await this.land(take, take, file))
          say(`${take.name}, recorded earlier, is with the song now.`, 'info', 6000);
        else left++;
      } catch {
        left++;
      } finally {
        this.going.delete(take.id);
      }
    }
    return left;
  }

  private async send(plan: TakePlan, wav: Blob, tries: number[]): Promise<AudioFile> {
    let last: unknown;
    for (const delay of tries) {
      if (delay) await this.deps.wait(delay);
      try {
        return await this.deps.upload(plan, wav);
      } catch (err) {
        last = err;
        if (err instanceof UploadError && !err.passing) break;
      }
    }
    throw last;
  }

  /** The server has the file: into the song, and forgotten here; kept with its file when its song isn't open. */
  private async land(kept: KeptTake | null, plan: TakePlan, file: AudioFile): Promise<boolean> {
    const { takes, place } = this.deps;
    if (place(plan, file)) {
      if (kept) await takes.forget(kept.id);
      return true;
    }
    if (kept && !kept.file) await takes.sent(kept, file);
    return false;
  }
}
