// Pure-logic gamepad -> GAME_KEYS-matrix mapping. Kept dependency-free (no
// DOM, no Gamepad API types touched beyond plain number[]/boolean[] arrays)
// so it's directly testable from plain Node — see test/ui-smoke.mjs. ui.ts's
// pollGamepad() is the only caller; it hands this module the raw
// pad.axes/pad.buttons[].pressed arrays every tick.
//
// The GAME_KEYS matrix is level-based (emu.key(row, bit, down) just sets/
// clears one matrix bit), so calling it every tick with the same value is
// harmless but wasteful — hundreds of redundant sets/frame for a held
// direction. This module edge-detects instead: it remembers the previous
// digital state and only emits a KeyEvent when a direction/button's
// down-state actually flips this poll.

export interface KeyEvent {
  row: number;
  bit: number;
  down: boolean;
}

// Matrix coordinates, mirroring web/input.ts's GAME_KEYS for the physical
// keys the game maps to a pad: Q climb, A dive, O slower, P faster, Space
// fire/bomb.
export const PAD_UP: [number, number] = [2, 0];
export const PAD_DOWN: [number, number] = [1, 0];
export const PAD_LEFT: [number, number] = [5, 1];
export const PAD_RIGHT: [number, number] = [5, 0];
export const PAD_FIRE: [number, number] = [7, 0];

// Standard-mapping dpad button indices (Gamepad API "standard" layout).
const BTN_DPAD_UP = 12;
const BTN_DPAD_DOWN = 13;
const BTN_DPAD_LEFT = 14;
const BTN_DPAD_RIGHT = 15;
const BTN_FIRE_A = 0;
const BTN_FIRE_B = 1;

// Stick deflection past which an axis counts as "held" in that direction.
// Exported so tests can probe the exact boundary rather than hardcoding it
// twice.
export const AXIS_THRESHOLD = 0.5;

export interface PadState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  fire: boolean;
}

const NEUTRAL: PadState = { up: false, down: false, left: false, right: false, fire: false };

/** Reduces a Gamepad's raw axes[]/buttons[] (already unwrapped to plain
 * booleans, i.e. `buttons.map(b => b.pressed)`) into the five logical
 * digital directions/fire this game cares about. axes[0]/[1] are the left
 * stick's x/y (-1..1, y negative = up); missing entries default to
 * neutral/unpressed so a pad that reports fewer axes/buttons than expected
 * never throws. */
export function reduceGamepad(axes: number[], buttons: boolean[]): PadState {
  const ax = axes[0] ?? 0;
  const ay = axes[1] ?? 0;
  return {
    up: ay < -AXIS_THRESHOLD || (buttons[BTN_DPAD_UP] ?? false),
    down: ay > AXIS_THRESHOLD || (buttons[BTN_DPAD_DOWN] ?? false),
    left: ax < -AXIS_THRESHOLD || (buttons[BTN_DPAD_LEFT] ?? false),
    right: ax > AXIS_THRESHOLD || (buttons[BTN_DPAD_RIGHT] ?? false),
    fire: (buttons[BTN_FIRE_A] ?? false) || (buttons[BTN_FIRE_B] ?? false),
  };
}

/** Diffs `next` against `prev` (treated as all-neutral when null, e.g. the
 * very first poll), producing exactly one KeyEvent per digital direction/
 * button whose down-state actually changed — nothing at all when the two
 * states are identical. */
export function diffPadState(prev: PadState | null, next: PadState): KeyEvent[] {
  const p = prev ?? NEUTRAL;
  const events: KeyEvent[] = [];
  if (next.up !== p.up) events.push({ row: PAD_UP[0], bit: PAD_UP[1], down: next.up });
  if (next.down !== p.down) events.push({ row: PAD_DOWN[0], bit: PAD_DOWN[1], down: next.down });
  if (next.left !== p.left) events.push({ row: PAD_LEFT[0], bit: PAD_LEFT[1], down: next.left });
  if (next.right !== p.right) {
    events.push({ row: PAD_RIGHT[0], bit: PAD_RIGHT[1], down: next.right });
  }
  if (next.fire !== p.fire) events.push({ row: PAD_FIRE[0], bit: PAD_FIRE[1], down: next.fire });
  return events;
}

// Module-level "previous poll" state, so pollGamepad() (and tests) can call
// mapGamepadState(axes, buttons) directly each tick without threading a
// state value through main.ts's loop themselves.
let prevState: PadState | null = null;

/** One-shot per-tick entry point: reduces this poll's raw pad arrays and
 * diffs them against the previous poll's, returning only the edges. */
export function mapGamepadState(axes: number[], buttons: boolean[]): KeyEvent[] {
  const next = reduceGamepad(axes, buttons);
  const events = diffPadState(prevState, next);
  prevState = next;
  return events;
}

/** Resets the remembered previous state (e.g. when a pad disconnects, or
 * between independent test cases). */
export function resetGamepadState(): void {
  prevState = null;
}
