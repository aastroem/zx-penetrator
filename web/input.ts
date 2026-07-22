import type { Emu } from './emu';

// Full 40-key Spectrum matrix, row 0 = $FE ... row 7 = $7F, bit 0 first
// within each row (matches emu.key(row, bit, down)'s addressing). Keep this
// table as the single source of truth for the letter/digit mapping below —
// hand-writing 36 KeyX/DigitX entries is exactly how row transcription bugs
// happen.
const ROWS: readonly (readonly string[])[] = [
  ['Shift', 'Z', 'X', 'C', 'V'],    // row0 $FE
  ['A', 'S', 'D', 'F', 'G'],        // row1 $FD
  ['Q', 'W', 'E', 'R', 'T'],        // row2 $FB
  ['1', '2', '3', '4', '5'],        // row3 $F7
  ['0', '9', '8', '7', '6'],        // row4 $EF
  ['P', 'O', 'I', 'U', 'Y'],        // row5 $DF
  ['Enter', 'L', 'K', 'J', 'H'],    // row6 $BF
  ['Space', 'Sym', 'M', 'N', 'B'],  // row7 $7F
];

// KeyboardEvent.code(s) a matrix label corresponds to. Shift/Sym each have
// two physical keys mapping onto the one matrix bit (Spectrum has no right
// Shift key of its own — Sym Shift doubles up on the PC's right Shift too).
function codesFor(label: string): string[] {
  switch (label) {
    case 'Enter': return ['Enter'];
    case 'Space': return ['Space'];
    case 'Shift': return ['ShiftLeft'];
    case 'Sym': return ['AltLeft', 'ShiftRight'];
    default:
      return [/^[0-9]$/.test(label) ? `Digit${label}` : `Key${label}`];
  }
}

function buildGameKeys(): Record<string, [number, number]> {
  const keys: Record<string, [number, number]> = {};
  ROWS.forEach((row, r) => {
    row.forEach((label, b) => {
      for (const code of codesFor(label)) keys[code] = [r, b];
    });
  });
  // Friendly aliases: arrow keys mirror the original Spectrum climb/dive/
  // slower/faster keys (not physical matrix positions of their own).
  keys.ArrowUp = [2, 0];    // Q climb
  keys.ArrowDown = [1, 0];  // A dive
  keys.ArrowLeft = [5, 1];  // O slower
  keys.ArrowRight = [5, 0]; // P faster
  return keys;
}

export const GAME_KEYS: Record<string, [number, number]> = buildGameKeys();

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
