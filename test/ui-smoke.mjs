// Pure-logic test for web/gamepad-logic.ts. No DOM/vite/wasm dependency at
// the type level, so — same approach as test/state-smoke.mjs and
// test/shell-smoke.mjs — transpile with the TypeScript compiler CLI into a
// scratch dir and dynamic-import the plain-JS output.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'zx-ui-'));

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
      path.join(repoRoot, 'web', 'gamepad-logic.ts'),
      '--outDir', outDir,
      '--target', 'es2022',
      '--module', 'esnext',
      '--moduleResolution', 'bundler',
      '--strict',
      '--ignoreConfig',
    ],
    { stdio: 'inherit' },
  );

  const {
    reduceGamepad,
    diffPadState,
    mapGamepadState,
    resetGamepadState,
    AXIS_THRESHOLD,
    PAD_UP,
    PAD_DOWN,
    PAD_LEFT,
    PAD_RIGHT,
    PAD_FIRE,
  } = await import(pathToFileURL(path.join(outDir, 'gamepad-logic.js')).href);

  const NEUTRAL_AXES = [0, 0];
  const NEUTRAL_BUTTONS = new Array(16).fill(false);

  // --- (a) axis thresholds: exactly at threshold does NOT count as held,
  // just past it does; dpad buttons work independently of the stick -------
  {
    const atThreshold = reduceGamepad([0, AXIS_THRESHOLD], NEUTRAL_BUTTONS);
    assert(atThreshold.down === false, 'axis: y === +threshold is not held (strict >)');

    const pastThreshold = reduceGamepad([0, AXIS_THRESHOLD + 0.01], NEUTRAL_BUTTONS);
    assert(pastThreshold.down === true, 'axis: y just past +threshold counts as held down');

    const negPast = reduceGamepad([0, -(AXIS_THRESHOLD + 0.01)], NEUTRAL_BUTTONS);
    assert(negPast.up === true, 'axis: y just past -threshold counts as held up');

    const xPastLeft = reduceGamepad([-(AXIS_THRESHOLD + 0.01), 0], NEUTRAL_BUTTONS);
    assert(xPastLeft.left === true, 'axis: x just past -threshold counts as held left');
    const xPastRight = reduceGamepad([AXIS_THRESHOLD + 0.01, 0], NEUTRAL_BUTTONS);
    assert(xPastRight.right === true, 'axis: x just past +threshold counts as held right');

    const dpadButtons = NEUTRAL_BUTTONS.slice();
    dpadButtons[12] = true; // dpad up
    const viaDpad = reduceGamepad(NEUTRAL_AXES, dpadButtons);
    assert(viaDpad.up === true, 'dpad: button 12 alone counts as held up, stick neutral');
    assert(viaDpad.down === false && viaDpad.left === false && viaDpad.right === false,
      'dpad: other directions stay unheld when only up is pressed');

    const fireButtons = NEUTRAL_BUTTONS.slice();
    fireButtons[0] = true;
    assert(reduceGamepad(NEUTRAL_AXES, fireButtons).fire === true, 'fire: button 0 triggers fire');
    const fireButtons2 = NEUTRAL_BUTTONS.slice();
    fireButtons2[1] = true;
    assert(reduceGamepad(NEUTRAL_AXES, fireButtons2).fire === true, 'fire: button 1 also triggers fire');
  }

  // --- (b) diffPadState: no events when steady (identical prev/next) -----
  {
    const s = reduceGamepad([0, AXIS_THRESHOLD + 0.2], NEUTRAL_BUTTONS); // down held
    const events = diffPadState(s, s);
    assert(events.length === 0, 'diff: identical prev/next state produces zero events');

    const neutral = reduceGamepad(NEUTRAL_AXES, NEUTRAL_BUTTONS);
    const eventsFromNull = diffPadState(null, neutral);
    assert(eventsFromNull.length === 0, 'diff: null prev vs all-neutral next produces zero events');
  }

  // --- (c) diffPadState: a single direction flipping produces exactly one
  // event, with the correct row/bit/down for that direction --------------
  {
    const neutral = reduceGamepad(NEUTRAL_AXES, NEUTRAL_BUTTONS);
    const nowUp = reduceGamepad([0, -(AXIS_THRESHOLD + 0.1)], NEUTRAL_BUTTONS);
    const events = diffPadState(neutral, nowUp);
    assert(events.length === 1, `diff: single direction change -> exactly one event (got ${events.length})`);
    assert(
      events[0].row === PAD_UP[0] && events[0].bit === PAD_UP[1] && events[0].down === true,
      'diff: up-transition event carries PAD_UP row/bit and down=true',
    );

    // Releasing it again -> exactly one event, down=false.
    const releaseEvents = diffPadState(nowUp, neutral);
    assert(releaseEvents.length === 1, 'diff: release transition -> exactly one event');
    assert(releaseEvents[0].down === false, 'diff: release event carries down=false');
  }

  // --- (d) diffPadState: two simultaneous direction changes -> exactly two
  // events, one per changed direction, unrelated directions produce none --
  {
    const neutral = reduceGamepad(NEUTRAL_AXES, NEUTRAL_BUTTONS);
    const upAndFire = reduceGamepad([0, -(AXIS_THRESHOLD + 0.1)], (() => {
      const b = NEUTRAL_BUTTONS.slice();
      b[0] = true;
      return b;
    })());
    const events = diffPadState(neutral, upAndFire);
    assert(events.length === 2, `diff: two simultaneous changes -> exactly two events (got ${events.length})`);
    const rows = events.map((e) => `${e.row},${e.bit}`).sort();
    const expected = [`${PAD_UP[0]},${PAD_UP[1]}`, `${PAD_FIRE[0]},${PAD_FIRE[1]}`].sort();
    assert(JSON.stringify(rows) === JSON.stringify(expected), 'diff: the two events are up + fire, nothing else');
  }

  // --- (e) mapGamepadState (stateful, per-tick entry point used by
  // ui.ts's pollGamepad): steady polls emit nothing; a held-then-released
  // direction emits exactly one event per edge, none while held ----------
  {
    resetGamepadState();

    // First poll ever: neutral -> neutral. Since the implicit "previous" is
    // all-neutral, a neutral first poll must emit nothing.
    let events = mapGamepadState(NEUTRAL_AXES, NEUTRAL_BUTTONS);
    assert(events.length === 0, 'mapGamepadState: first poll at neutral emits no events');

    // Push right past threshold: exactly one event (right, down=true).
    events = mapGamepadState([AXIS_THRESHOLD + 0.3, 0], NEUTRAL_BUTTONS);
    assert(events.length === 1 && events[0].down === true && events[0].row === PAD_RIGHT[0] && events[0].bit === PAD_RIGHT[1],
      'mapGamepadState: pushing right emits exactly one right-down event');

    // Hold steady for several polls: no further events (this is the crux of
    // "no events when steady" / avoiding wasteful repeat emu.key calls).
    for (let i = 0; i < 5; i++) {
      const steady = mapGamepadState([AXIS_THRESHOLD + 0.3, 0], NEUTRAL_BUTTONS);
      assert(steady.length === 0, `mapGamepadState: steady poll #${i} emits no events`);
    }

    // Release back to neutral: exactly one event (right, down=false).
    events = mapGamepadState(NEUTRAL_AXES, NEUTRAL_BUTTONS);
    assert(events.length === 1 && events[0].down === false && events[0].row === PAD_RIGHT[0] && events[0].bit === PAD_RIGHT[1],
      'mapGamepadState: releasing right emits exactly one right-up event');

    // Steady neutral again afterwards: no more events.
    events = mapGamepadState(NEUTRAL_AXES, NEUTRAL_BUTTONS);
    assert(events.length === 0, 'mapGamepadState: steady neutral after release emits no events');

    // Left/down/fire also round-trip cleanly through the stateful API.
    resetGamepadState();
    events = mapGamepadState([-(AXIS_THRESHOLD + 0.2), AXIS_THRESHOLD + 0.2], NEUTRAL_BUTTONS);
    assert(events.length === 2, 'mapGamepadState: simultaneous left+down press -> exactly two events');
    const got = events.map((e) => `${e.row},${e.bit},${e.down}`).sort();
    const want = [
      `${PAD_LEFT[0]},${PAD_LEFT[1]},true`,
      `${PAD_DOWN[0]},${PAD_DOWN[1]},true`,
    ].sort();
    assert(JSON.stringify(got) === JSON.stringify(want), 'mapGamepadState: left+down events carry correct row/bit/down');
  }

  // --- (f) Simulates ui.ts's pollGamepad on gamepad disconnect mid-hold: a
  // held direction/button followed by a neutral-input poll (mapGamepadState
  // fed neutral axes/all-false buttons, as pollGamepad now does instead of
  // early-returning when the pad vanishes) emits the release exactly once;
  // a further neutral poll (pad still gone) emits nothing more -------------
  {
    resetGamepadState();

    // Hold fire (a button, not an axis, to exercise a different edge than
    // the dpad-heavy case (e) above).
    const fireButtons = NEUTRAL_BUTTONS.slice();
    fireButtons[0] = true;
    let events = mapGamepadState(NEUTRAL_AXES, fireButtons);
    assert(
      events.length === 1 && events[0].down === true &&
        events[0].row === PAD_FIRE[0] && events[0].bit === PAD_FIRE[1],
      'disconnect-sim: holding fire emits exactly one fire-down event',
    );

    // Pad "disconnects" mid-hold: pollGamepad now feeds a neutral-input call
    // instead of returning early.
    events = mapGamepadState(NEUTRAL_AXES, NEUTRAL_BUTTONS);
    assert(
      events.length === 1 && events[0].down === false &&
        events[0].row === PAD_FIRE[0] && events[0].bit === PAD_FIRE[1],
      'disconnect-sim: neutral-input call after disconnect emits exactly the fire-release event',
    );

    // Second neutral call (pad still gone) -> zero events (prevState is
    // already neutral).
    events = mapGamepadState(NEUTRAL_AXES, NEUTRAL_BUTTONS);
    assert(events.length === 0, 'disconnect-sim: second neutral call after disconnect emits zero events');
  }

  if (ok) console.log('ui-smoke: gamepad-logic axis thresholds + edge-detection MATCH');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (!ok) process.exit(1);
