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

  // (a) No edges at all -> flat baseline at the chosen resting polarity
  // (level 0 -> -0.25), no edges to derive anything else from.
  {
    const tstates = 69888; // one frame's worth
    const out = edgesToSamples([], [], tstates, RATIO);
    assert(out.length === Math.round(tstates * RATIO), 'no-edges: output length matches ratio');
    let allBaseline = true;
    for (let i = 0; i < out.length; i++) {
      if (Math.abs(out[i] - -0.25) > 1e-9) allBaseline = false;
    }
    assert(allBaseline, 'no-edges: all samples === -0.25');
  }

  // (b) Single edge at ts=0 transitioning to level 1 -> ramps from the
  // implied prior level (0, the complement of the edge's target) up to
  // +0.25 within 8 samples, then holds.
  {
    const tstates = 5000;
    const out = edgesToSamples([0], [1], tstates, RATIO);
    assert(out.length === Math.round(tstates * RATIO), 'single-edge: output length matches ratio');
    assert(out.length > 16, 'single-edge: buffer long enough to observe ramp + hold');
    // Strictly increasing (monotonic ramp) for the first 8 samples.
    let monotonic = true;
    for (let i = 1; i < 8; i++) if (out[i] <= out[i - 1]) monotonic = false;
    assert(monotonic, 'single-edge: first 8 samples ramp monotonically upward');
    assert(Math.abs(out[7] - 0.25) < 1e-9, 'single-edge: sample 7 reaches +0.25');
    // Holds at +0.25 for the remainder of the buffer.
    let holds = true;
    for (let i = 8; i < out.length; i++) if (Math.abs(out[i] - 0.25) > 1e-9) holds = false;
    assert(holds, 'single-edge: holds at +0.25 after the ramp');
  }

  // (c) Square wave at a known period -> zero-crossing count matches the
  // expected frequency within ±1. Build edges alternating level every
  // `halfPeriodTs` T-states across a run of `cycles` full periods, at a
  // ratio of 1 sample per T-state (keeps the math easy to reason about
  // independent of the real 44100/3500000 ratio, which is exercised above).
  {
    const halfPeriodTs = 100; // T-states per half-cycle
    const cycles = 20;
    const tstates = cycles * 2 * halfPeriodTs;
    const edges = [];
    const levels = [];
    for (let i = 0; i < cycles * 2; i++) {
      edges.push(i * halfPeriodTs);
      levels.push(i % 2 === 0 ? 1 : 0);
    }
    const ratio = 1; // 1 sample per T-state
    const out = edgesToSamples(edges, levels, tstates, ratio);
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
    const out = edgesToSamples([1000, 50000], [1, 0], tstates, RATIO);
    assert(out.length === Math.round(tstates * RATIO), 'length: matches round(tstates*ratio) with edges present');
    const out2 = edgesToSamples([], [], 12345, RATIO);
    assert(out2.length === Math.round(12345 * RATIO), 'length: matches round(tstates*ratio) with no edges');
  }

  if (ok) console.log('audio-smoke: audio-math edgesToSamples MATCH');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (!ok) process.exit(1);
