import type { Emu } from './emu';

export const GAME_KEYS: Record<string, [number, number]> = {
  ArrowUp: [2, 0],    // Q climb
  ArrowDown: [1, 0],  // A dive
  ArrowLeft: [5, 1],  // O slower
  ArrowRight: [5, 0], // P faster
  Space: [7, 0],      // fire/bomb
  Enter: [6, 0], Digit1: [3, 0], Digit2: [3, 1], Digit3: [3, 2],
  Digit4: [3, 3], Digit0: [4, 0],
  KeyQ: [2, 0], KeyA: [1, 0], KeyO: [5, 1], KeyP: [5, 0], KeyI: [5, 2],
  KeyM: [7, 2], KeyN: [7, 3], KeyB: [7, 4], KeyZ: [0, 1], KeyX: [0, 2],
};

export function attachKeyboard(emu: Emu): void {
  const h = (down: boolean) => (ev: KeyboardEvent) => {
    const m = GAME_KEYS[ev.code];
    if (!m) return;
    ev.preventDefault();
    emu.key(m[0], m[1], down);
  };
  addEventListener('keydown', h(true));
  addEventListener('keyup', h(false));
}
