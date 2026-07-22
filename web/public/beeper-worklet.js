// AudioWorklet processor for the ZX Spectrum beeper. Plain JS (not bundled
// by vite) — loaded via `audioCtx.audioWorklet.addModule(...)` from
// web/audio.ts. Runs on the audio rendering thread, separate from the main
// thread that drives the emulator.
//
// Protocol: the main thread posts Float32Array sample chunks via
// `node.port.postMessage(chunk)`. Chunks are copied into a 16384-sample ring
// buffer (~370ms of audio at 44100Hz — comfortably larger than the ~90ms
// jitter buffer the shell targets, so a burst of a few chunks in a row can't
// overrun it). `process()` drains the ring one sample at a time into the
// output; on underrun (ring caught up to the write pointer — the shell fell
// behind) it repeats the last sample rather than dropping to silence, which
// reads as a brief hold instead of a click.
class Beeper extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(16384);
    this.r = 0;
    this.w = 0;
    this.last = 0;
    this.port.onmessage = (e) => {
      const c = e.data;
      for (let i = 0; i < c.length; i++) this.buf[this.w++ & 16383] = c[i];
    };
  }

  process(_in, out) {
    const o = out[0][0];
    for (let i = 0; i < o.length; i++)
      o[i] = this.r < this.w ? (this.last = this.buf[this.r++ & 16383]) : this.last;
    return true;
  }
}

registerProcessor('beeper', Beeper);
