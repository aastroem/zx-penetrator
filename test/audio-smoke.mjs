// Pure-logic test for web/audio-math.ts. Imports NOTHING from vite: the
// module under test has no DOM/AudioContext dependency, so we transpile it
// with the TypeScript compiler's CLI (already a devDependency) into a
// scratch dir and dynamic-import the plain-JS output — same approach as
// test/shell-smoke.mjs for web/interleave.ts.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'zx-audio-math-'));

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    ok = false;
  }
}

try {
  execFileSync(
    path.join(repoRoot, 'node_modules', '.bin', 'tsc'),
    [
      path.join(repoRoot, 'web', 'audio-math.ts'),
      '--outDir', outDir,
      '--target', 'es2022',
      '--module', 'esnext',
      '--moduleResolution', 'bundler',
      '--strict',
      '--ignoreConfig',
    ],
    { stdio: 'inherit' },
  );

  const { edgesToSamples } = await import(
    pathToFileURL(path.join(outDir, 'audio-math.js')).href
  );

  const RATIO = 44100 / 3500000; // real shell's samples-per-T-state

  // (a) No entries at all, startLevel 0 -> flat baseline at that level
  // (level 0 -> -0.25), endLevel unchanged from startLevel.
  {
    const tstates = 69888; // one frame's worth
    const { samples: out, endLevel } = edgesToSamples([], [], tstates, RATIO, 0);
    assert(out.length === Math.round(tstates * RATIO), 'no-entries: output length matches ratio');
    let allBaseline = true;
    for (let i = 0; i < out.length; i++) {
      if (Math.abs(out[i] - -0.25) > 1e-9) allBaseline = false;
    }
    assert(allBaseline, 'no-entries: all samples === -0.25');
    assert(endLevel === 0, 'no-entries: endLevel === startLevel (0)');
  }

  // (b) Single entry at ts=0 changing level 0 -> 1 (startLevel 0) -> ramps
  // from the prior level up to +0.25 within 8 samples, then holds; endLevel
  // reflects the new level.
  {
    const tstates = 5000;
    const { samples: out, endLevel } = edgesToSamples([0], [1], tstates, RATIO, 0);
    assert(out.length === Math.round(tstates * RATIO), 'single-entry: output length matches ratio');
    assert(out.length > 16, 'single-entry: buffer long enough to observe ramp + hold');
    // Strictly increasing (monotonic ramp) for the first 8 samples.
    let monotonic = true;
    for (let i = 1; i < 8; i++) if (out[i] <= out[i - 1]) monotonic = false;
    assert(monotonic, 'single-entry: first 8 samples ramp monotonically upward');
    assert(Math.abs(out[7] - 0.25) < 1e-9, 'single-entry: sample 7 reaches +0.25');
    // Holds at +0.25 for the remainder of the buffer.
    let holds = true;
    for (let i = 8; i < out.length; i++) if (Math.abs(out[i] - 0.25) > 1e-9) holds = false;
    assert(holds, 'single-entry: holds at +0.25 after the ramp');
    assert(endLevel === 1, 'single-entry: endLevel === 1');
  }

  // (c) Square wave at a known period -> zero-crossing count matches the
  // expected frequency within ±1. Build entries alternating level every
  // `halfPeriodTs` T-states across a run of `cycles` full periods, at a
  // ratio of 1 sample per T-state (keeps the math easy to reason about
  // independent of the real 44100/3500000 ratio, which is exercised above).
  {
    const halfPeriodTs = 100; // T-states per half-cycle
    const cycles = 20;
    const tstates = cycles * 2 * halfPeriodTs;
    const entries = [];
    const levels = [];
    for (let i = 0; i < cycles * 2; i++) {
      entries.push(i * halfPeriodTs);
      levels.push(i % 2 === 0 ? 1 : 0);
    }
    const ratio = 1; // 1 sample per T-state
    const { samples: out } = edgesToSamples(entries, levels, tstates, ratio, 0);
    let crossings = 0;
    for (let i = 1; i < out.length; i++) {
      if ((out[i - 1] < 0) !== (out[i] < 0)) crossings++;
    }
    // A square wave alternating every halfPeriodTs samples crosses zero
    // once per transition -> 2*cycles - 1 crossings across this buffer
    // (the very last transition's ramp may or may not complete a full
    // crossing before the buffer ends).
    const expected = cycles * 2 - 1;
    assert(
      Math.abs(crossings - expected) <= 1,
      `square-wave: zero crossings ${crossings} within ±1 of expected ${expected}`,
    );
  }

  // (d) Output length always = round(tstatesRun * sampleRateRatio), for an
  // arbitrary tstates count and the real shell ratio.
  {
    const tstates = 279552; // MAX_OWED_TSTATES from main.ts (4 frames)
    const { samples: out } = edgesToSamples([1000, 50000], [1, 0], tstates, RATIO, 0);
    assert(out.length === Math.round(tstates * RATIO), 'length: matches round(tstates*ratio) with entries present');
    const { samples: out2 } = edgesToSamples([], [], 12345, RATIO, 0);
    assert(out2.length === Math.round(12345 * RATIO), 'length: matches round(tstates*ratio) with no entries');
  }

  // (e) Zero-entry tick with startLevel=1 -> all samples ≈ +0.25 and
  // endLevel=1 (the click-fix regression test: resting high between sounds
  // must not snap to a fixed -0.25 baseline).
  {
    const tstates = 69888;
    const { samples: out, endLevel } = edgesToSamples([], [], tstates, RATIO, 1);
    let allHigh = true;
    for (let i = 0; i < out.length; i++) {
      if (Math.abs(out[i] - 0.25) > 1e-9) allHigh = false;
    }
    assert(allHigh, 'zero-entry/startLevel=1: all samples === +0.25 (no spurious click to baseline)');
    assert(endLevel === 1, 'zero-entry/startLevel=1: endLevel === 1');
  }

  // (f) Duplicate-level entries (both level 0, startLevel 0) -> flat -0.25
  // throughout, no excursion above -0.25+epsilon anywhere (the border-write
  // regression test: level snapshots that repeat the current level must
  // not invent a ramp/transition).
  {
    const tstates = 5000;
    const { samples: out, endLevel } = edgesToSamples([100, 200], [0, 0], tstates, RATIO, 0);
    let noExcursion = true;
    for (let i = 0; i < out.length; i++) {
      if (out[i] > -0.25 + 1e-9) noExcursion = false;
    }
    assert(noExcursion, 'duplicate-level entries: no excursion above -0.25 anywhere');
    assert(endLevel === 0, 'duplicate-level entries: endLevel === 0');
  }

  // (g) Two consecutive calls where call 2's startLevel = call 1's endLevel
  // produce a continuous boundary (last sample of call 1 ≈ first sample of
  // call 2 when no entry lands at the boundary).
  {
    const tstates1 = 3000;
    const { samples: out1, endLevel: end1 } = edgesToSamples([500], [1], tstates1, RATIO, 0);
    assert(end1 === 1, 'continuity: call 1 endLevel === 1');
    const tstates2 = 3000;
    const { samples: out2 } = edgesToSamples([], [], tstates2, RATIO, end1);
    assert(
      Math.abs(out1[out1.length - 1] - out2[0]) < 1e-9,
      'continuity: last sample of call 1 ≈ first sample of call 2 at the boundary',
    );
  }

  if (ok) console.log('audio-smoke: audio-math edgesToSamples MATCH');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (!ok) process.exit(1);
