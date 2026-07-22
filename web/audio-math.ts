// Pure square-wave synthesis for the ZX Spectrum beeper. Kept dependency-free
// (no DOM, no AudioContext, no vite) so it can be exercised directly from a
// plain Node test (see test/audio-smoke.mjs) the same way web/interleave.ts
// is exercised from test/shell-smoke.mjs.

/** Samples per level change spent linearly ramping (avoids a hard step
 * in the DAC output, which would otherwise click). */
const RAMP_SAMPLES = 8;

/** Peak amplitude of the synthesized square wave (±AMPLITUDE around 0). */
const AMPLITUDE = 0.25;

/**
 * Synthesizes one tick's worth of beeper audio from the speaker-level log
 * the emulator core recorded during the run.
 *
 * `ts`/`lv` are parallel arrays straight off `Emu.drainAudio()`: `ts[i]` is
 * the T-state offset (0..tstatesRun), *relative to the start of this run*,
 * at which the core logged the speaker port ($FE bit 4) reading `lv[i]`
 * (0 or 1).
 *
 * These are level *snapshots*, not guaranteed transitions: the core logs
 * every OUT to port $FE — including writes that only touch the border-color
 * bits and leave the speaker bit unchanged, with no transition filtering
 * (see `spec_outp` in core/spectrum.c). So consecutive entries (or a run's
 * first entry vs. whatever the speaker was already doing) can legitimately
 * carry the *same* level. Synthesis therefore treats each entry as "the
 * level is (still) `lv[i]` as of T-state `ts[i]`": it only starts an
 * `RAMP_SAMPLES`-sample ramp when an entry's value actually differs from
 * the level currently in effect. A same-value entry is a no-op — no ramp,
 * no artifact — which matters because a border-only write landing inside
 * an otherwise-silent drain window must not invent a spurious full-swing
 * transition.
 *
 * Because entries are absolute levels rather than transitions, there is no
 * way to derive what the speaker was doing *before* the run started from
 * the run's own data alone (a zero-entry tick, or a tick whose entries all
 * repeat the same level, gives nothing to "complement" against). Synthesis
 * is therefore stateful across calls: the caller passes `startLevel` (the
 * level in effect at the end of the previous call — or an initial
 * convention on the very first call) and gets back `endLevel` (the level
 * in effect after this call's last entry, or unchanged from `startLevel`
 * if there were none), threading it into the next call. A zero-entry tick
 * (no $FE writes logged this run) renders as a flat line at `startLevel`,
 * matching what the speaker was actually doing instead of snapping to a
 * fixed baseline (which would otherwise click every time the speaker rests
 * high between sounds).
 *
 * Output is `round(tstatesRun * sampleRateRatio)` samples of a square wave
 * at ±0.25 amplitude, with an `RAMP_SAMPLES`-sample linear ramp on each
 * actual level change. `sampleRateRatio` is samples-per-T-state
 * (44100/3500000 in the real shell); it's a parameter rather than a
 * constant so tests can pick convenient numbers.
 */
export function edgesToSamples(
  ts: ArrayLike<number>,
  lv: ArrayLike<number>,
  tstatesRun: number,
  sampleRateRatio: number,
  startLevel: 0 | 1,
): { samples: Float32Array; endLevel: 0 | 1 } {
  const n = Math.max(0, Math.round(tstatesRun * sampleRateRatio));
  const out = new Float32Array(n);
  const entryCount = ts.length;

  const asLevel = (v: number): 0 | 1 => (v ? 1 : 0);

  if (n === 0) {
    // Nothing to render this call, but still fold any logged entries into
    // endLevel so a run that rounds down to zero samples doesn't lose
    // track of what the speaker last did.
    const endLevel = entryCount > 0 ? asLevel(lv[entryCount - 1]) : startLevel;
    return { samples: out, endLevel };
  }

  const toVolt = (level: 0 | 1): number => (level ? AMPLITUDE : -AMPLITUDE);

  // Map each entry's T-state offset to an output sample index, clamped into
  // range. Entries are assumed sorted ascending (as drainAudio() produces).
  const idx = new Array<number>(entryCount);
  for (let i = 0; i < entryCount; i++) {
    idx[i] = Math.min(n, Math.max(0, Math.round(ts[i] * sampleRateRatio)));
  }

  let level: 0 | 1 = startLevel;
  let prevSample = toVolt(level);

  let rampFrom = prevSample;
  let rampTo = prevSample;
  let rampLeft = 0;
  let entryI = 0;

  for (let i = 0; i < n; i++) {
    // Apply every entry landing exactly on this sample index, in order.
    // Only an actual level change starts (or restarts) a ramp from
    // wherever the waveform currently is; a same-value entry (border-only
    // write) is a no-op.
    while (entryI < entryCount && idx[entryI] === i) {
      const newLevel = asLevel(lv[entryI]);
      if (newLevel !== level) {
        level = newLevel;
        rampFrom = prevSample;
        rampTo = toVolt(level);
        rampLeft = RAMP_SAMPLES;
      }
      entryI++;
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

  // Entries whose T-state offset rounded to exactly `n` (the sample just
  // past the end of this buffer) get clamped into idx[] but never visited
  // by the render loop above (which only runs i in [0, n)) — still fold
  // them into the final level so endLevel reflects the true last logged
  // value.
  while (entryI < entryCount) {
    level = asLevel(lv[entryI]);
    entryI++;
  }

  return { samples: out, endLevel: level };
}
