/**
 * What goes with a request: a picture (a screenshot, a photo of a page), a recording, a MIDI file, a
 * MusicXML score (plain or .mxl) or a text. Each is made ready on this device before it leaves:
 *  - a picture is drawn again through a canvas, no bigger than it needs to be, so what the camera wrote
 *    into it (where it was taken, on what) stays here;
 *  - a recording is measured (its length, loudness, a tempo, and the notes when it's one line), when
 *    this browser can decode it and it isn't long;
 *  - a MIDI file is read into notes.
 * What HO[LO] takes, and how big, is the host's rule (agent/attachments.ts); a file it wouldn't take is
 * turned away here, with a line in the bar.
 */
import { type MidiFile, PPQ, readMidi } from '@holo/session';

export const ATTACHMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/aiff',
  'audio/mpeg',
  'audio/ogg',
  'audio/mp4',
  'audio/midi',
  'application/vnd.recordare.musicxml+xml',
  'application/vnd.recordare.musicxml',
  'text/plain',
] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];
export type AttachmentKind = 'image' | 'audio' | 'midi' | 'score' | 'text';

/** The host's limits: a file, a recording, a text, and what's measured of one. */
export const MAX_ATTACHMENT = 25 * 1024 * 1024;
export const MAX_AUDIO = 200 * 1024 * 1024;
export const MAX_TEXT = 100 * 1024;
/** A recording is measured here up to this size (a longer one goes as it is). */
export const MAX_MEASURED = 25 * 1024 * 1024;
export const MAX_META = 64 * 1024;
/** A picture is drawn no bigger than this on its long side: enough to read a page of music. */
export const MAX_IMAGE_SIDE = 2048;
/** A picture picked can be big (it's made smaller here); past this it isn't worth reading in. */
const MAX_IMAGE_IN = 60 * 1024 * 1024;
/** At most this many go with one request (the host's limit). */
export const MAX_FILES = 10;

/** By the file's ending, which is surer than the type a system gives it: what it goes up as, and what kind it is. */
const BY_ENDING: Record<string, [AttachmentType | null, AttachmentKind]> = {
  png: [null, 'image'],
  jpg: [null, 'image'],
  jpeg: [null, 'image'],
  webp: [null, 'image'],
  gif: [null, 'image'],
  wav: ['audio/wav', 'audio'],
  flac: ['audio/flac', 'audio'],
  aif: ['audio/aiff', 'audio'],
  aiff: ['audio/aiff', 'audio'],
  aifc: ['audio/aiff', 'audio'],
  mp3: ['audio/mpeg', 'audio'],
  ogg: ['audio/ogg', 'audio'],
  oga: ['audio/ogg', 'audio'],
  opus: ['audio/ogg', 'audio'],
  m4a: ['audio/mp4', 'audio'],
  mid: ['audio/midi', 'midi'],
  midi: ['audio/midi', 'midi'],
  musicxml: ['application/vnd.recordare.musicxml+xml', 'score'],
  xml: ['application/vnd.recordare.musicxml+xml', 'score'],
  mxl: ['application/vnd.recordare.musicxml', 'score'],
  txt: ['text/plain', 'text'],
};

/** By the type alone, for what has no ending (a picture pasted from the clipboard). */
const BY_TYPE: Record<string, [AttachmentType | null, AttachmentKind]> = {
  'image/png': [null, 'image'],
  'image/jpeg': [null, 'image'],
  'image/webp': [null, 'image'],
  'image/gif': [null, 'image'],
  'audio/wav': ['audio/wav', 'audio'],
  'audio/x-wav': ['audio/wav', 'audio'],
  'audio/wave': ['audio/wav', 'audio'],
  'audio/flac': ['audio/flac', 'audio'],
  'audio/x-flac': ['audio/flac', 'audio'],
  'audio/aiff': ['audio/aiff', 'audio'],
  'audio/x-aiff': ['audio/aiff', 'audio'],
  'audio/mpeg': ['audio/mpeg', 'audio'],
  'audio/mp3': ['audio/mpeg', 'audio'],
  'audio/ogg': ['audio/ogg', 'audio'],
  'audio/mp4': ['audio/mp4', 'audio'],
  'audio/x-m4a': ['audio/mp4', 'audio'],
  'audio/midi': ['audio/midi', 'midi'],
  'audio/mid': ['audio/midi', 'midi'],
  'audio/x-midi': ['audio/midi', 'midi'],
  'application/vnd.recordare.musicxml+xml': ['application/vnd.recordare.musicxml+xml', 'score'],
  'application/vnd.recordare.musicxml': ['application/vnd.recordare.musicxml', 'score'],
  'text/plain': ['text/plain', 'text'],
};

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * Whether HO[LO] takes a file, and as what: its kind, and the type it goes up as (a picture's is
 * settled when it's drawn again: PNG or JPEG). Otherwise why not, in a few words.
 */
export function classify(file: {
  name: string;
  type: string;
  size: number;
}): { kind: AttachmentKind; type: AttachmentType | null } | { error: string } {
  const ending = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
  const found = BY_ENDING[ending] ?? BY_TYPE[file.type.toLowerCase()];
  if (!found)
    return {
      error: `${file.name || 'That'} can’t go with a request: pictures, recordings, MIDI, MusicXML and text can`,
    };
  const [type, kind] = found;
  if (!file.size) return { error: `${file.name} is empty` };
  const max = kind === 'audio' ? MAX_AUDIO : MAX_ATTACHMENT;
  if (kind === 'image' ? file.size > MAX_IMAGE_IN : file.size > max)
    return { error: `${file.name} is ${mb(file.size)}: ${mb(max)} at most` };
  if (kind === 'text' && file.size > MAX_TEXT) return { error: `${file.name} is too long: a text is 100 KB at most` };
  return { kind, type };
}

/** A picture's size once drawn again: its long side at most `max`, its shape kept; never made bigger. */
export function fitImage(w: number, h: number, max = MAX_IMAGE_SIDE): { w: number; h: number } {
  const long = Math.max(w, h);
  if (long <= max) return { w, h };
  const scale = max / long;
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** What a picture is drawn again as: a screenshot stays sharp as PNG; a photo is a JPEG; a file keeps PNG's sharpness when it had it. */
export function imageType(source: 'screenshot' | 'photo' | 'file', inType: string): 'image/png' | 'image/jpeg' {
  if (source === 'screenshot') return 'image/png';
  if (source === 'photo') return 'image/jpeg';
  return inType === 'image/png' || inType === 'image/gif' ? 'image/png' : 'image/jpeg';
}

/** What's measured, made to fit the host's limit: its list of notes shortened until it does. */
export function fitMeta(meta: Record<string, unknown>, max = MAX_META): Record<string, unknown> {
  let m = meta;
  while (JSON.stringify(m).length > max) {
    const notes = m.notes;
    if (!Array.isArray(notes) || notes.length === 0)
      return Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'notes'));
    m = { ...m, notes: notes.slice(0, Math.floor(notes.length / 2)), notesCut: true };
  }
  return m;
}

/** A MIDI file's notes, as the agent reads them: [start tick, length, pitch, velocity, track] each (at HO[LO]'s PPQ). */
export function midiMeta(file: MidiFile): Record<string, unknown> {
  const notes = file.tracks.flatMap((t, i) => t.notes.map((n) => [n.t, n.d, n.p, n.v, i]));
  notes.sort((a, b) => (a[0] as number) - (b[0] as number));
  const meter = file.meter[0];
  return {
    ppq: PPQ,
    bpm: file.tempo[0]?.bpm ?? 120,
    meter: meter ? `${meter.num}/${meter.den}` : '4/4',
    tracks: file.tracks.map((t) => t.name || `Channel ${t.channel + 1}`),
    notes,
  };
}

/** Mono samples as a 16-bit WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] as number));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return bytes;
}

// ---- in the browser ----

/** A file made ready to go: what's sent, under what name and type, and what was measured of it. */
export interface Ready {
  blob: Blob;
  name: string;
  type: AttachmentType;
  kind: AttachmentKind;
  meta: Record<string, unknown> | null;
}

/** A picture drawn again: no bigger than it needs to be, and nothing but its pixels in it. */
export async function redraw(source: ImageBitmapSource, name: string, as: 'image/png' | 'image/jpeg'): Promise<Ready> {
  const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' }).catch(() => null);
  if (!bitmap) throw new Error(`This browser can’t read the picture ${name}`);
  const { w, h } = fitImage(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser can’t draw pictures');
  // a JPEG has no transparency: what was clear is white, as on a page
  if (as === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob: Blob = await new Promise((ok, fail) =>
    canvas.toBlob((b) => (b ? ok(b) : fail(new Error('The picture couldn’t be drawn'))), as, 0.9),
  );
  const base = name.replace(/\.[a-z0-9]+$/i, '') || 'picture';
  return {
    blob,
    name: `${base}.${as === 'image/png' ? 'png' : 'jpg'}`,
    type: as,
    kind: 'image',
    meta: { width: w, height: h },
  };
}

let worker: Worker | null = null;
let asked = 0;
const answers = new Map<number, (m: Record<string, unknown>) => void>();

/** A recording measured in a worker (its length, peak, tempo, and notes when it's one line). */
async function measureAudio(samples: Float32Array, sampleRate: number): Promise<Record<string, unknown>> {
  if (!worker) {
    worker = new Worker(new URL('../audio/pitch.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; measure: Record<string, unknown> }>) => {
      answers.get(e.data.id)?.(e.data.measure);
      answers.delete(e.data.id);
    };
  }
  const id = ++asked;
  return new Promise((ok) => {
    answers.set(id, ok);
    worker?.postMessage({ id, samples, sampleRate }, [samples.buffer]);
  });
}

/** A recording's samples, mixed to one channel. */
export async function decode(data: ArrayBuffer): Promise<{ samples: Float32Array; sampleRate: number }> {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const audio = await ctx.decodeAudioData(data).catch(() => null);
  if (!audio) throw new Error('This browser can’t read that recording');
  const samples = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < ch.length; i++)
      samples[i] = (samples[i] as number) + (ch[i] as number) / audio.numberOfChannels;
  }
  return { samples, sampleRate: audio.sampleRate };
}

/** A file made ready to go with a request. */
export async function ready(file: File): Promise<Ready> {
  const c = classify(file);
  if ('error' in c) throw new Error(c.error);
  if (c.kind === 'image') return redraw(file, file.name, imageType('file', file.type));
  const type = c.type as AttachmentType;
  if (c.kind === 'audio') {
    // measured when this browser decodes it (most don't decode AIFF) and it isn't long; else it goes as it is
    const decoded = file.size <= MAX_MEASURED ? await decode(await file.arrayBuffer()).catch(() => null) : null;
    const meta = decoded ? fitMeta(await measureAudio(decoded.samples, decoded.sampleRate)) : null;
    return { blob: file, name: file.name, type, kind: c.kind, meta };
  }
  if (c.kind === 'midi') {
    let midi: MidiFile;
    try {
      midi = readMidi(new Uint8Array(await file.arrayBuffer()));
    } catch {
      throw new Error(`${file.name} isn’t a MIDI file HO[LO] can read`);
    }
    return { blob: file, name: file.name, type, kind: c.kind, meta: fitMeta(midiMeta(midi)) };
  }
  return { blob: file, name: file.name, type, kind: c.kind, meta: null };
}

/** A recording from the microphone, as a WAV file with what was measured of it. */
export async function recordingReady(samples: Float32Array, sampleRate: number, name: string): Promise<Ready> {
  const wav = encodeWav(samples, sampleRate);
  const meta = fitMeta(await measureAudio(samples.slice(), sampleRate));
  return { blob: new Blob([wav], { type: 'audio/wav' }), name, type: 'audio/wav', kind: 'audio', meta };
}

/** Whether this browser can capture the screen (a phone's can't: it takes a photo instead). */
export function canCaptureScreen(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

/** One frame of what the user chooses to share (a screen, a window, a tab), as a PNG; the sharing stops at once. */
export async function grabScreen(): Promise<Ready> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    // a frame drawn, not the black one before it
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
    return await redraw(video, 'screenshot.png', 'image/png');
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}

/** How long a recording for the agent may run. */
export const MAX_RECORDING_MS = 120_000;

/**
 * Record from the microphone until stopped (or two minutes): the recording comes to `done` as a WAV
 * with what was measured of it. The microphone is let go as soon as it stops.
 */
export async function record(done: (r: Promise<Ready>) => void): Promise<{ stop: () => void }> {
  // the sound as it is: what the agent measures is the playing, not a call's clean-up
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  recorder.onstop = () => {
    for (const t of stream.getTracks()) t.stop();
    done(
      (async () => {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        const { samples, sampleRate } = await decode(await blob.arrayBuffer());
        return recordingReady(samples, sampleRate, 'recording.wav');
      })(),
    );
  };
  recorder.start(1000);
  const timer = window.setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), MAX_RECORDING_MS);
  return {
    stop: () => {
      window.clearTimeout(timer);
      if (recorder.state !== 'inactive') recorder.stop();
    },
  };
}
