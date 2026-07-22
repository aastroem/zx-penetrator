// "A Kim & Kenny Show production" credit — baked directly into the emulated
// Spectrum's own screen memory (bitmap + attribute bytes at $4000/$5800),
// not a rendering-layer overlay: to the WebGL shader and the CRT effect this
// is indistinguishable from text the game itself drew.
//
// Timing: revealed once per boot, starting right after the title's animated
// "handwritten logo" (spark-trail) sequence finishes, and stopped before the
// attract-mode demo's score-panel HUD starts drawing over the same rows.
// Both frame counts are empirically verified against the real 1982 code
// (not guessed): booting to the title, injecting the "leave title" keypress,
// then scanning every screen row for first-touched-by-the-game frame shows
// character rows 15-21 completely untouched by the game from frame ~1400
// (logo finished) through at least frame ~2280 (the earliest HUD row, 21,
// isn't touched again until frame 2300). Rows 17/19 (used below) go
// untouched even longer, to ~2355+ (test/credit-smoke.mjs pins the window
// values; a separate real-wasm integration run confirmed the poke survives
// untouched for the whole window and the game resumes normally afterward).
import type { Emu } from './emu';
import { ROW_ADDR } from './interleave.js';

export const CREDIT_START_FRAME = 1400;
export const CREDIT_END_FRAME = 2280;

const LINE1 = 'A KIM & KENNY SHOW';
const LINE2 = 'PRODUCTION - 2026';
const LINE1_ROW = 17;
const LINE2_ROW = 19;

// attr byte: bit7 flash=0, bit6 bright=1, bits5-3 paper=0 (black), bits2-0
// ink=7 (white) -> bright white on black, readable against any game content
// that happens to be near (there is none, per the scan above).
const ATTR_BRIGHT_WHITE_ON_BLACK = 0b01000111;

const SCREEN_BASE = 0x4000;
const ATTR_BASE = 0x5800;

/** Renders `text` at 1:1 Spectrum scale (one 8px-tall character row) via an
 * offscreen canvas — far simpler and more legible than hand-encoding a pixel
 * font — then packs it into the Spectrum's own byte-per-8-pixels bitmap
 * format: returns 8 (pixel rows) x `cols` (byte per character column),
 * row-major (`cells[pixelRow * cols + col]`). */
function renderLineCells(text: string, cols: number): Uint8Array {
  const w = cols * 8;
  const h = 8;
  const out = new Uint8Array(cols * 8);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return out; // never expected; leaves this line blank (harmless)
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.font = '7px ui-monospace, monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(text, 0, 0);
  const img = ctx.getImageData(0, 0, w, h).data;
  for (let pr = 0; pr < 8; pr++) {
    for (let col = 0; col < cols; col++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        if (img[(pr * w + col * 8 + bit) * 4] > 128) byte |= 1 << (7 - bit);
      }
      out[pr * cols + col] = byte;
    }
  }
  return out;
}

// Built lazily (needs a live DOM/canvas) and cached forever — the credit
// text never changes at runtime, so there's no reason to re-render it.
let cells1: Uint8Array | null = null;
let cells2: Uint8Array | null = null;

function build(): void {
  if (cells1 && cells2) return;
  cells1 = renderLineCells(LINE1, LINE1.length);
  cells2 = renderLineCells(LINE2, LINE2.length);
}

function pokeLine(emu: Emu, charRow: number, cells: Uint8Array, cols: number): void {
  const startCol = Math.floor((32 - cols) / 2);
  for (let pr = 0; pr < 8; pr++) {
    const addr = SCREEN_BASE + ROW_ADDR[charRow * 8 + pr];
    for (let col = 0; col < cols; col++) {
      emu.poke(addr + startCol + col, cells[pr * cols + col]);
    }
  }
  const attrAddr = ATTR_BASE + charRow * 32 + startCol;
  for (let col = 0; col < cols; col++) {
    emu.poke(attrAddr + col, ATTR_BRIGHT_WHITE_ON_BLACK);
  }
}

/** Pokes the credit directly into the emulated screen's bitmap + attribute
 * bytes. Idempotent (safe to call every frame within the reveal window) —
 * main.ts calls it once on entering the window and leaves it there for the
 * rest of the window's duration since the game itself never touches these
 * rows during that stretch (see the module doc comment). */
export function pokeCredit(emu: Emu): void {
  build();
  pokeLine(emu, LINE1_ROW, cells1!, LINE1.length);
  pokeLine(emu, LINE2_ROW, cells2!, LINE2.length);
}
