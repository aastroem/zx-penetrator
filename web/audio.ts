// AudioWorklet wrapper for the ZX Spectrum beeper. Loads the plain-JS
// processor (web/public/beeper-worklet.js) and exposes a minimal push
// interface; the actual waveform synthesis lives in audio-math.ts (kept
// separate so it can be unit-tested without an AudioContext).

const SAMPLE_RATE = 44100;

// If the shell gets more than this many samples ahead of what the
// AudioContext has actually had time to play (e.g. after a scheduling
// hiccup pushes several chunks back-to-back), stop pushing until playback
// catches up rather than letting queued audio grow into extra latency. The
// worklet holds the last sample on underrun, so a dropped chunk reads as a
// brief hold, not a glitch. ~8000 samples ≈ 180ms — comfortably above the
// ~90ms jitter buffer this shell targets, so it only kicks in on real
// falling-behind, not normal scheduling jitter.
const MAX_AHEAD_SAMPLES = 8000;

export class Beeper {
  private pushedSamples = 0;
  private startTime: number | null = null;

  private constructor(
    private readonly ctx: AudioContext,
    private readonly node: AudioWorkletNode,
  ) {}

  static async create(ctx: AudioContext): Promise<Beeper> {
    await ctx.audioWorklet.addModule(import.meta.env.BASE_URL + 'beeper-worklet.js');
    const node = new AudioWorkletNode(ctx, 'beeper', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.connect(ctx.destination);
    return new Beeper(ctx, node);
  }

  /** Pushes one tick's worth of synthesized samples to the worklet's ring
   * buffer, unless the shell has gotten too far ahead of real-time playback
   * (see MAX_AHEAD_SAMPLES) — in that case the chunk is dropped. */
  push(chunk: Float32Array): void {
    if (chunk.length === 0) return;
    if (this.startTime === null) this.startTime = this.ctx.currentTime;

    const consumed = (this.ctx.currentTime - this.startTime) * SAMPLE_RATE;
    const ahead = this.pushedSamples - consumed;
    if (ahead > MAX_AHEAD_SAMPLES) return;

    this.pushedSamples += chunk.length;
    // Transfer the underlying buffer instead of structured-cloning it: the
    // Float32Array isn't reused after this push, so handing ownership to
    // the worklet thread avoids a copy on every chunk.
    this.node.port.postMessage(chunk, [chunk.buffer]);
  }
}
