// "A Kim & Kenny Show production" credit — baked directly into the emulated
// Spectrum's own screen memory (bitmap + attribute bytes at $4000/$5800),
// not a rendering-layer overlay: to the WebGL shader and the CRT effect this
// is indistinguishable from text the game itself drew.
//
// Big text via the classic ZX double-size trick: render each line small
// and crisp, then nearest-neighbor-scale every source pixel to a 2x2 block
// (SCALE below) — the same blocky, no-antialiasing "big letters" look 8-bit
// games and demos use for logos/titles, rather than a bigger antialiased
// font (which would produce grey edges that don't threshold cleanly to the
// Spectrum's 1-bit-per-pixel bitmap).
//
// Timing: revealed once per boot, appearing *alongside* the tail of the
// title's animated "handwritten logo" (spark-trail) sequence — not after it
// — and stopped before the attract-mode demo's score-panel HUD starts
// drawing over the same rows. All three frame counts are empirically
// verified against the real 1982 code (not guessed): booting to the title,
// injecting the "leave title" keypress, then scanning every screen row
// frame-by-frame for when the game itself first/last touches it shows:
// character rows 15-21 hold leftover static-title-picture content through
// frame ~1300, then go completely untouched by the game from frame 1300
// through at least frame ~2280 (the earliest HUD row, 21, isn't touched
// again until frame 2300) — while the logo/instructions text in rows 8-14
// is still on screen at least through frame ~1742, so starting at 1300
// puts the credit up while that's still visible, not after it's gone. See
// test/credit-smoke.mjs (pins the window + a real-wasm integration check
// confirming no collision for the whole window and normal resumption after).
import type { Emu } from './emu';
import { ROW_ADDR } from './interleave.js';

export const CREDIT_START_FRAME = 1300;
export const CREDIT_END_FRAME = 2280;

const SCALE = 2; // 2x2 nearest-neighbor blow-up: 16px-tall, bold, unmissable

const LINE1 = 'KIM & KENNY SHOW'; // 16 chars * (8*SCALE)px = exactly 256px wide
const LINE2 = 'PRODUCTION 2026';  // 15 chars, centered with a 1-col margin
const LINE1_ROW = 16; // spans char rows 16-17 (2 rows tall at SCALE=2)
const LINE2_ROW = 19; // spans char rows 19-20; row 15/18/21 left as gaps

// attr byte: bit7 flash=0, bit6 bright=1, bits5-3 paper=0 (black), bits2-0
// ink=7 (white) -> bright white on black, readable against any game content
// that happens to be near (there is none, per the scan above).
const ATTR_BRIGHT_WHITE_ON_BLACK = 0b01000111;

const SCREEN_BASE = 0x4000;
const ATTR_BASE = 0x5800;

/** Renders `text` at 1:1 Spectrum scale (8px tall) via an offscreen canvas
 * — far simpler and more legible than hand-encoding a pixel font — then
 * nearest-neighbor-upscales it by SCALE and packs the result into the
 * Spectrum's byte-per-8-pixels bitmap format. Returns `8*SCALE` pixel rows
 * x `cols*SCALE` byte-columns, row-major (`cells[pixelRow*outCols+col]`). */
function renderLineCells(text: string, cols: number): Uint8Array {
  const baseW = cols * 8;
  const baseH = 8;
  const outCols = cols * SCALE;
  const outRows = 8 * SCALE;
  const out = new Uint8Array(outRows * outCols);

  const canvas = document.createElement('canvas');
  canvas.width = baseW;
  canvas.height = baseH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return out; // never expected; leaves this line blank (harmless)
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, baseW, baseH);
  ctx.fillStyle = '#fff';
  ctx.font = '7px ui-monospace, monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(text, 0, 0);
  const img = ctx.getImageData(0, 0, baseW, baseH).data;
  const baseSet = (x: number, y: number) => x < baseW && img[(y * baseW + x) * 4] > 128;

  for (let oy = 0; oy < outRows; oy++) {
    const sy = Math.floor(oy / SCALE);
    for (let ocol = 0; ocol < outCols; ocol++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const ox = ocol * 8 + bit;
        const sx = Math.floor(ox / SCALE);
        if (baseSet(sx, sy)) byte |= 1 << (7 - bit);
      }
      out[oy * outCols + ocol] = byte;
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

function pokeLine(emu: Emu, charRow: number, cells: Uint8Array, textCols: number): void {
  const outCols = textCols * SCALE;
  const outRows = 8 * SCALE;
  const startCol = Math.floor((32 - outCols) / 2);
  for (let pr = 0; pr < outRows; pr++) {
    const addr = SCREEN_BASE + ROW_ADDR[charRow * 8 + pr];
    for (let col = 0; col < outCols; col++) {
      emu.poke(addr + startCol + col, cells[pr * outCols + col]);
    }
  }
  // Attribute granularity is one byte per 8x8 cell, so a SCALE-tall line
  // needs SCALE consecutive character-rows of attribute bytes, not just one.
  for (let r = 0; r < SCALE; r++) {
    const attrAddr = ATTR_BASE + (charRow + r) * 32 + startCol;
    for (let col = 0; col < outCols; col++) {
      emu.poke(attrAddr + col, ATTR_BRIGHT_WHITE_ON_BLACK);
    }
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
