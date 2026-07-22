// Shell chrome: top bar (CRT toggle, save/load slots, resume-autosave, keys
// help), a touch overlay for coarse-pointer devices, and per-tick gamepad
// polling. Pure DOM wiring over pieces that already work on their own —
// Screen.setCrt (gl.ts), Slots (state.ts), GAME_KEYS/emu.key (input.ts/
// emu.ts) and gamepad-logic.ts's edge-detected pad-state mapping. No game
// logic lives here.

import type { Emu } from './emu';
import type { Screen } from './gl';
import type { Slots } from './state';
import { GAME_KEYS } from './input';
import { mapGamepadState } from './gamepad-logic';

const CRT_KEY = 'zxpen.crt';

// localStorage access with the same try/catch-and-degrade shape as
// state.ts's Slots (private there, and CRT is a one-key, non-critical
// preference, so a tiny local copy beats exporting Slots' internals).
function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // CRT preference just won't persist this session — not worth surfacing.
  }
}

export interface UiDeps {
  emu: Emu;
  scr: Screen;
  slots: Slots;
}

/** Builds and inserts all shell chrome into the current document. Call once
 * at startup after emu/scr/slots exist. */
export function initUi(deps: UiDeps): void {
  buildTopBar(deps);
  buildTouchOverlay(deps.emu);
}

function buildTopBar({ emu, scr, slots }: UiDeps): void {
  const bar = document.createElement('div');
  bar.id = 'zxpen-topbar';

  // --- CRT toggle, persisted at 'zxpen.crt' -------------------------------
  const crtLabel = document.createElement('label');
  const crtCheckbox = document.createElement('input');
  crtCheckbox.type = 'checkbox';
  const crtOn = storageGet(CRT_KEY) === '1';
  crtCheckbox.checked = crtOn;
  scr.setCrt(crtOn);
  crtCheckbox.addEventListener('change', () => {
    scr.setCrt(crtCheckbox.checked);
    storageSet(CRT_KEY, crtCheckbox.checked ? '1' : '0');
  });
  crtLabel.append(crtCheckbox, document.createTextNode(' CRT'));
  bar.append(crtLabel);

  // --- Save/load slots (0-2, shown as 1-3) ---------------------------------
  // One compact pill per slot (number + a save-icon button + a load-icon
  // button) instead of six flat text buttons loose in the bar — same
  // save(slot)/load(slot) calls, just grouped so three slots reads as one
  // widget rather than a wall of buttons.
  const slotGroup = document.createElement('div');
  slotGroup.id = 'zxpen-slots';
  slotGroup.title = 'Save / load game state';
  for (const slot of [0, 1, 2] as const) {
    const cell = document.createElement('div');
    cell.className = 'zxpen-slot';

    const num = document.createElement('span');
    num.className = 'zxpen-slot-num';
    num.textContent = String(slot + 1);
    num.setAttribute('aria-hidden', 'true');
    cell.append(num);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = '💾';
    saveBtn.title = `Save to slot ${slot + 1}`;
    saveBtn.setAttribute('aria-label', `Save to slot ${slot + 1}`);
    saveBtn.addEventListener('click', () => slots.save(slot));

    const loadBtn = document.createElement('button');
    loadBtn.type = 'button';
    loadBtn.textContent = '📂';
    loadBtn.title = `Load slot ${slot + 1}`;
    loadBtn.setAttribute('aria-label', `Load slot ${slot + 1}`);
    loadBtn.addEventListener('click', () => slots.load(slot));

    cell.append(saveBtn, loadBtn);
    slotGroup.append(cell);
  }
  bar.append(slotGroup);

  // --- Resume last session, only offered if a pagehide autosave exists ----
  if (slots.hasAutoSave()) {
    const resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.id = 'zxpen-resume';
    resumeBtn.textContent = '⟲ Resume';
    resumeBtn.title = 'Resume last session (auto-saved on close)';
    resumeBtn.addEventListener('click', () => {
      slots.loadAuto();
    });
    bar.append(resumeBtn);
  }

  // --- Collapsible keys help ----------------------------------------------
  const details = document.createElement('details');
  details.id = 'zxpen-keyshelp';
  const summary = document.createElement('summary');
  summary.textContent = 'Keys';
  details.append(summary);

  const body = document.createElement('div');
  body.innerHTML =
    '<p><b>Menu:</b> 1/2 number of players, T training center, E landscape ' +
    'editor, L load landscape, S toggle sirens.</p>' +
    '<p><b>Flight:</b> Q/↑ climb, A/↓ dive, O/← slower, P/→ faster, ' +
    'SPACE/M fire+bomb.</p>' +
    '<p><b>Quick save/load:</b> F5 saves slot 1, F8 loads slot 1.</p>' +
    '<p>Any key during the demo returns to the menu.</p>';
  details.append(body);
  bar.append(details);

  // Prepended (not appended) so it lands before #zxpen-screen-wrap in DOM
  // order — body is a column flex layout now (see index.html), and flex
  // items stack in DOM order by default.
  document.body.prepend(bar);
}

// --- Touch overlay: only on coarse (touch) pointers -----------------------

// Menu-strip buttons: label -> matrix target, derived from GAME_KEYS (not
// hand-written) so this can never drift from input.ts's ROWS table. Digit1/
// Digit2 = number-of-players, the rest are the menu-mode letter commands.
const MENU_STRIP_KEYS: readonly [string, [number, number]][] = [
  ['1', GAME_KEYS.Digit1],
  ['2', GAME_KEYS.Digit2],
  ['T', GAME_KEYS.KeyT],
  ['E', GAME_KEYS.KeyE],
  ['L', GAME_KEYS.KeyL],
  ['S', GAME_KEYS.KeyS],
];

function buildTouchOverlay(emu: Emu): void {
  if (!matchMedia('(pointer: coarse)').matches) return;

  const overlay = document.createElement('div');
  overlay.id = 'zxpen-touch';

  const dpad = document.createElement('div');
  dpad.id = 'zxpen-dpad';
  const up = makeTouchButton('▲', GAME_KEYS.ArrowUp, emu);
  const down = makeTouchButton('▼', GAME_KEYS.ArrowDown, emu);
  const left = makeTouchButton('◀', GAME_KEYS.ArrowLeft, emu);
  const right = makeTouchButton('▶', GAME_KEYS.ArrowRight, emu);
  up.style.gridArea = 'up';
  down.style.gridArea = 'down';
  left.style.gridArea = 'left';
  right.style.gridArea = 'right';
  dpad.append(up, down, left, right);

  const fire = makeTouchButton('FIRE', GAME_KEYS.Space, emu);
  fire.id = 'zxpen-fire';

  overlay.append(dpad, fire);
  document.body.append(overlay);

  buildMenuStrip(emu);
}

// A separate fixed-position strip (not part of #zxpen-touch, which is
// bottom-anchored) so it can be pinned to the top of the fixed overlay
// layer without colliding with the in-flow #zxpen-topbar above it. The
// topbar's height varies (its keys-help <details> can expand), so the strip
// tracks the topbar's actual bottom edge via ResizeObserver + resize rather
// than a hardcoded offset.
function buildMenuStrip(emu: Emu): void {
  const strip = document.createElement('div');
  strip.id = 'zxpen-menustrip';
  for (const [label, target] of MENU_STRIP_KEYS) {
    const btn = makeTouchButton(label, target, emu);
    btn.classList.add('zxpen-menu-btn');
    strip.append(btn);
  }
  document.body.append(strip);

  const bar = document.getElementById('zxpen-topbar');
  const reposition = () => {
    strip.style.top = `${bar ? bar.getBoundingClientRect().bottom : 0}px`;
  };
  reposition();
  addEventListener('resize', reposition);
  if (bar && typeof ResizeObserver === 'function') {
    new ResizeObserver(reposition).observe(bar);
  }
}

function makeTouchButton(
  label: string,
  [row, bit]: [number, number],
  emu: Emu,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'zxpen-touch-btn';
  btn.textContent = label;
  const setDown = (down: boolean) => (ev: PointerEvent) => {
    ev.preventDefault();
    emu.key(row, bit, down);
  };
  btn.addEventListener('pointerdown', setDown(true));
  btn.addEventListener('pointerup', setDown(false));
  btn.addEventListener('pointercancel', setDown(false));
  btn.addEventListener('pointerleave', setDown(false));
  return btn;
}

// --- Gamepad polling --------------------------------------------------------

// Tracks whether the previous poll saw a pad, purely to skip redundant work
// once a disconnect has already been fed through as a neutral poll (see
// below) — mapGamepadState's own edge-detection already makes a second
// neutral poll a no-op, this just avoids reallocating the neutral arrays and
// calling into it at all.
let padWasPresent = false;

/** Call once per tick from main.ts's rAF loop. Reads pad 0 (if any) and
 * feeds its axes/buttons through gamepad-logic.ts's edge-detected mapper,
 * applying only the resulting state-change events to emu.key — a held
 * direction/button is not resent every tick.
 *
 * When no pad is present (never connected, or disconnected mid-hold), this
 * feeds mapGamepadState neutral axes/all-false buttons instead of early-
 * returning: a direction/button held at disconnect time then sees its
 * down-state flip to false exactly once via the normal edge-detected diff,
 * so it can't get stuck latched in the key matrix forever. Once a neutral
 * poll has been fed through, further polls with still no pad are skipped
 * (prevState is already neutral, so they'd produce zero events anyway). */
export function pollGamepad(emu: Emu): void {
  const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  const pad = pads[0];
  if (!pad && !padWasPresent) return;
  padWasPresent = !!pad;
  const axes = pad ? Array.from(pad.axes) : [0, 0];
  const buttons = pad ? Array.from(pad.buttons, (b) => b.pressed) : [];
  for (const { row, bit, down } of mapGamepadState(axes, buttons)) {
    emu.key(row, bit, down);
  }
}
