/**
 * The studio's part in the agent's `import` of a recording only a browser decodes (MP3, Ogg, M4A, a
 * WAV the host's reader doesn't take): the host asks (`agent-import-audio {project, attachment,
 * name}`), and the studio fetches the attachment's bytes (`GET /api/agent/attachments/:id/data`, with
 * this device's token), decodes them, and uploads them as one of the song's files, a 32-bit float WAV
 * (so every renderer reads it). The answer is that file, as the song lists it (an AudioFile); the
 * agent's own changes then put it on a track.
 */
import { engine } from '../audio/engine.ts';
import { audioFiles } from '../audio/files.ts';
import { attachmentData } from './agent.ts';
import { type AgentRequestHandler, registerAgentRequest } from './agent-studio.ts';
import { store } from './store.ts';

/** Answers `agent-import-audio`: the file, uploaded; or why not (another song open, a recording this browser can't read). */
export const importAudio: AgentRequestHandler = async (msg, ack) => {
  const project = typeof msg.project === 'string' ? msg.project : '';
  const attachment = typeof msg.attachment === 'string' ? msg.attachment : '';
  const name = (typeof msg.name === 'string' && msg.name.trim().slice(0, 120)) || 'Recording';
  if (!project || store.get().project?.id !== project) {
    ack(false, { error: 'That song isn’t open in the studio' });
    return;
  }
  if (!/^att_[0-9a-f]{12}$/.test(attachment)) {
    ack(false, { error: 'No such attachment' });
    return;
  }
  const data = await (await attachmentData(attachment)).arrayBuffer();
  const ctx = engine.ctx ?? new OfflineAudioContext(1, 1, 48000);
  const decoded = await ctx.decodeAudioData(data).catch(() => null);
  if (!decoded?.length) {
    ack(false, { error: `This browser can’t read ${name}` });
    return;
  }
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
  const file = await audioFiles.uploadRecording(
    project,
    channels,
    decoded.sampleRate,
    `${name.replace(/\.[^.]+$/, '') || 'Recording'}.wav`,
  );
  // (named as it came: "take 3.mp3")
  ack(true, { file: { ...file, name } });
};

registerAgentRequest('agent-import-audio', importAudio);
