// Pure logic for decoding the ZX Spectrum's y-interleaved display file.
// Kept dependency-free (no DOM, no vite) so it can be exercised directly
// from a plain Node test (see test/shell-smoke.mjs).

/**
 * Spectrum bitmap byte address for scanline `y` (0..191), relative to the
 * start of the display file:
 *   addr = ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2)
 * Row 0 -> 0, row 1 -> 256, row 8 -> 32, row 64 -> 2048, ...
 */
function rowAddr(y: number): number {
  return ((y & 0xc0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2);
}

/** Precomputed 192-entry table: ROW_ADDR[y] = rowAddr(y). */
export const ROW_ADDR: number[] = (() => {
  const t = new Array<number>(192);
  for (let y = 0; y < 192; y++) t[y] = rowAddr(y);
  return t;
})();

/**
 * Linearizes the 6144-byte bitmap portion of a Spectrum display file (the
 * first 6144 bytes of the 6912-byte display area at $4000) into row-major
 * order: out[y * 32 + x] = display[ROW_ADDR[y] + x].
 *
 * `out` must be at least 6144 bytes; it is both mutated and returned.
 */
export function linearize(display: Uint8Array, out: Uint8Array): Uint8Array {
  for (let y = 0; y < 192; y++) {
    const addr = ROW_ADDR[y];
    const base = y * 32;
    for (let x = 0; x < 32; x++) {
      out[base + x] = display[addr + x];
    }
  }
  return out;
}
