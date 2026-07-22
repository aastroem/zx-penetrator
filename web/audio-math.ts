// Pure square-wave synthesis for the ZX Spectrum beeper. Kept dependency-free
// (no DOM, no AudioContext, no vite) so it can be exercised directly from a
// plain Node test (see test/audio-smoke.mjs) the same way web/interleave.ts
// is exercised from test/shell-smoke.mjs.

/** Samples per edge transition spent linearly ramping (avoids a hard step
 * in the DAC output, which would otherwise click). */
const RAMP_SAMPLES = 8;

/** Peak amplitude of the synthesized square wave (±AMPLITUDE around 0). */
const AMPLITUDE = 0.25;

/**
 * Synthesizes one tick's worth of beeper audio from the speaker edges the
 * emulator core recorded during the run.
 *
 * `edges`/`levels` are parallel arrays straight off `Emu.drainAudio()`:
 * `edges[i]` is the T-state offset (0..tstatesRun), *relative to the start
 * of this run*, at which the speaker bit changed to `levels[i]` (0 or 1).
 * They only contain entries for actual transitions — a silent run (speaker
 * untouched) drains as two empty arrays.
 *
 * Output is `round(tstatesRun * sampleRateRatio)` samples of a square wave
 * at ±0.25 amplitude, with an `RAMP_SAMPLES`-sample linear ramp at each
 * transition. `sampleRateRatio` is samples-per-T-state (44100/3500000 in
 * the real shell); it's a parameter rather than a constant so tests can
 * pick convenient numbers.
 *
 * Design note (stateless by construction): the level *before* the first
 * edge in the run is derived as the complement of that edge's target
 * (an edge is, by definition, a transition away from the prior level) —
 * so no state needs to carry across calls to know what to render up to
 * the first transition. When a run has *no* edges at all (speaker held
 * steady the whole tick) there is nothing to derive that from, so it
 * resets to a fixed convention: level 0 (-AMPLITUDE). This is a
 * deliberate simplification: a truly edge-free tick renders as flat
 * silence either way, and the only cost is a possible single-sample-step
 * discontinuity (no ramp) at the boundary going into/out of such a tick,
 * which is inaudible relative to an 8-sample ramp elsewhere.
 */
export function edgesToSamples(
  edges: ArrayLike<number>,
  levels: ArrayLike<number>,
  tstatesRun: number,
  sampleRateRatio: number,
): Float32Array {
  const n = Math.max(0, Math.round(tstatesRun * sampleRateRatio));
  const out = new Float32Array(n);
  if (n === 0) return out;

  const toVolt = (level: number): number => (level ? AMPLITUDE : -AMPLITUDE);

  // Map each edge's T-state offset to an output sample index, clamped into
  // range. Edges are assumed sorted ascending (as drainAudio() produces).
  const edgeCount = edges.length;
  const idx = new Array<number>(edgeCount);
  for (let i = 0; i < edgeCount; i++) {
    idx[i] = Math.min(n, Math.max(0, Math.round(edges[i] * sampleRateRatio)));
  }

  let level = edgeCount > 0 ? 1 - levels[0] : 0; // level in effect before this run
  let prevSample = toVolt(level);

  let rampFrom = prevSample;
  let rampTo = prevSample;
  let rampLeft = 0;
  let edgeI = 0;

  for (let i = 0; i < n; i++) {
    // Any edges landing exactly on this sample index start (or restart) a
    // fresh ramp from wherever the waveform currently is.
    while (edgeI < edgeCount && idx[edgeI] === i) {
      level = levels[edgeI];
      rampFrom = prevSample;
      rampTo = toVolt(level);
      rampLeft = RAMP_SAMPLES;
      edgeI++;
    }

    let v: number;
    if (rampLeft > 0) {
      const step = RAMP_SAMPLES - rampLeft + 1; // 1..RAMP_SAMPLES
      v = rampFrom + (rampTo - rampFrom) * (step / RAMP_SAMPLES);
      rampLeft--;
    } else {
      v = toVolt(level);
    }
    out[i] = v;
    prevSample = v;
  }

  return out;
}
