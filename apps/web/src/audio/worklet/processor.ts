/**
 * The studio's audio thread: HO[LO]'s engine (@holo/engine, the same code that bounces and renders
 * headless) in an AudioWorkletProcessor. Live MIDI reaches it through shared memory within a block.
 */
import { AheadLink, AheadPlayer, EngineCore, type ToWorklet } from '@holo/engine';

declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class EngineProcessor extends AudioWorkletProcessor {
  private readonly core: EngineCore;
  /** Rendering ahead: the song comes from the workers, block by block, and this plays the master and what's live. */
  private player: AheadPlayer | null = null;
  constructor() {
    super();
    this.core = new EngineCore(sampleRate, (msg, transfer) => this.port.postMessage(msg, transfer ?? []));
    this.port.onmessage = (e: MessageEvent<ToWorklet>) => {
      const msg = e.data;
      if (msg.type === 'init') {
        this.core.receive(msg);
        const a = msg.ahead;
        this.player = a ? new AheadPlayer(this.core, new AheadLink(a.control, a.data, a.edges), a.workers) : null;
      } else if (this.player) this.player.receive(msg);
      else this.core.receive(msg);
    };
    // the DSP meter's clock: a fine one where the audio thread has it, else the millisecond clock (averages only)
    const perf = (globalThis as { performance?: { now(): number } }).performance;
    if (perf?.now) {
      this.core.clock = () => perf.now();
      this.core.fineClock = true;
    } else this.core.clock = () => Date.now();
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const out0 = out?.[0];
    const out1 = out?.[1] ?? out0;
    if (out0 && out1) {
      if (this.player) this.player.process(out0, out1, inputs[0], currentFrame);
      else this.core.process(out0, out1, inputs[0], currentFrame);
    }
    return true;
  }
}

registerProcessor('holo-engine', EngineProcessor);

/**
 * Measuring the round trip: a click every half second out of the speakers, found again in the
 * microphone's input. The frames between the two are the output and input latency together.
 */
class Loopback extends AudioWorkletProcessor {
  private frame = 0;
  private readonly period = Math.round(sampleRate * 0.5);
  private clickAt = -1_000_000;
  private armed = false;
  private noise = 0;

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const out0 = outputs[0]?.[0];
    const out1 = outputs[0]?.[1];
    if (!out0) return true;
    const n = out0.length;
    for (let i = 0; i < n; i++) {
      const f = this.frame + i;
      if (f % this.period === 0 && f > sampleRate * 0.4) {
        this.clickAt = f;
        this.armed = true;
      }
      const k = f - this.clickAt;
      const s = k >= 0 && k < 64 ? Math.sin((2 * Math.PI * 2500 * k) / sampleRate) * (1 - k / 64) * 0.9 : 0;
      out0[i] = s;
      if (out1) out1[i] = s;
      if (!input) continue;
      const x = Math.abs(input[i] as number);
      if (k > sampleRate * 0.25) {
        // between clicks: how loud the room is
        this.noise = Math.max(x, this.noise * 0.9995);
      } else if (this.armed && k > sampleRate * 0.002 && x > Math.max(0.03, this.noise * 5)) {
        this.armed = false;
        this.port.postMessage({ type: 'echo', frames: k });
      }
    }
    this.frame += n;
    return true;
  }
}

registerProcessor('holo-loopback', Loopback);
