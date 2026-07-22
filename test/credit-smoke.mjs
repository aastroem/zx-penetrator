// Pure-logic test for web/credit.ts's screen-memory addressing: verifies
// pokeCredit() writes the right bitmap bytes at the right addresses (using
// interleave.ts's ROW_ADDR, the same table the renderer decodes with) and
// the right attribute bytes/values, centered in a 32-column row — all
// without needing a real browser font renderer. A fake `document` stands in
// for the canvas 2D text rendering: its getImageData() returns a
// deterministic checkerboard instead of real glyph pixels, so the test can
// independently recompute the exact bytes pokeCredit() should produce and
// catch any off-by-one in the byte-packing or address math. Same
// transpile-with-tsc-then-dynamic-import approach as test/state-smoke.mjs /
// test/shell-smoke.mjs (credit.ts's `Emu` import is type-only and erased).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'zx-credit-'));

let ok = true;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    ok = false;
  }
}

// Same rowAddr formula as interleave.ts, kept independent so a bug shared
// between the two modules can't hide from this test.
function rowAddr(y) {
  return ((y & 0xc0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2);
}

// Fake canvas 2D context: fillText etc. are no-ops (recorded, not
// rendered); getImageData returns a deterministic checkerboard regardless
// of what was "drawn", so the test can recompute the exact expected bytes.
function checkerboardValue(x, y) {
  return (x + y) % 2 === 0 ? 255 : 0;
}
class FakeCtx {
  fillRect() {}
  fillText() {}
  set fillStyle(_v) {}
  set font(_v) {}
  set textBaseline(_v) {}
  set textAlign(_v) {}
  getImageData(sx, sy, w, h) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = checkerboardValue(x, y);
        const i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    return { data };
  }
}
class FakeCanvas {
  width = 0;
  height = 0;
  getContext(kind) {
    return kind === '2d' ? new FakeCtx() : null;
  }
}
globalThis.document = {
  createElement: (tag) => (tag === 'canvas' ? new FakeCanvas() : null),
};

try {
  execFileSync(
    path.join(repoRoot, 'node_modules', '.bin', 'tsc'),
    [
      path.join(repoRoot, 'web', 'credit.ts'),
      path.join(repoRoot, 'web', 'interleave.ts'),
      '--outDir', outDir,
      '--target', 'es2022',
      '--module', 'esnext',
      '--moduleResolution', 'bundler',
      '--strict',
      '--types', 'vite/client',
      '--ignoreConfig',
    ],
    { stdio: 'inherit' },
  );

  const { pokeCredit, CREDIT_START_FRAME, CREDIT_END_FRAME } =
    await import(pathToFileURL(path.join(outDir, 'credit.js')).href);

  // --- Reveal window: pinned to the empirically-verified values (logo ends
  // ~1400 frames after "leave title"; game starts touching these rows again
  // at ~2300+) so a drift here is caught rather than silently reintroducing
  // a HUD collision or an always-late/never-shown credit. -------------------
  assert(CREDIT_START_FRAME === 1400, `CREDIT_START_FRAME should be 1400, got ${CREDIT_START_FRAME}`);
  assert(CREDIT_END_FRAME === 2280, `CREDIT_END_FRAME should be 2280, got ${CREDIT_END_FRAME}`);
  assert(CREDIT_END_FRAME > CREDIT_START_FRAME, 'reveal window must be non-empty');

  // --- pokeCredit(): capture every emu.poke(addr, value) call -------------
  const pokes = new Map(); // addr -> last value written
  const fakeEmu = { poke: (a, v) => pokes.set(a, v) };
  pokeCredit(fakeEmu);

  assert(pokes.size > 0, 'pokeCredit wrote at least one byte');

  // Recompute the expected bitmap bytes for a line the same way credit.ts's
  // renderLineCells does (checkerboard in, byte-packed out), independently
  // of credit.ts's own implementation.
  function expectedCellByte(pr, col) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit++) {
      const x = col * 8 + bit;
      if (checkerboardValue(x, pr) > 128) byte |= 1 << (7 - bit);
    }
    return byte;
  }

  function checkLine(charRow, text) {
    const cols = text.length;
    const startCol = Math.floor((32 - cols) / 2);
    for (let pr = 0; pr < 8; pr++) {
      const addr = 0x4000 + rowAddr(charRow * 8 + pr);
      for (let col = 0; col < cols; col++) {
        const got = pokes.get(addr + startCol + col);
        const want = expectedCellByte(pr, col);
        assert(
          got === want,
          `row ${charRow} pr ${pr} col ${col}: addr 0x${(addr + startCol + col).toString(16)} ` +
            `expected byte ${want}, got ${got}`,
        );
      }
    }
    const attrAddr = 0x5800 + charRow * 32 + startCol;
    for (let col = 0; col < cols; col++) {
      const got = pokes.get(attrAddr + col);
      assert(got === 0b01000111, `row ${charRow} attr col ${col}: expected bright-white-on-black (0x47), got ${got}`);
    }
    // Every address touched must fall inside real screen memory ($4000-$5AFF).
    for (const addr of pokes.keys()) {
      assert(addr >= 0x4000 && addr < 0x5b00, `poke address 0x${addr.toString(16)} inside screen memory`);
    }
  }

  // Rows 17/19: chosen because they're the ones verified (by a live scan
  // against the real game's own screen writes, see credit.ts's doc comment)
  // to stay untouched by the game from logo-end through well past the
  // reveal window's end — never rows 22/23, which the score-panel HUD
  // claims once the attract demo starts.
  checkLine(17, 'A KIM & KENNY SHOW');
  checkLine(19, 'PRODUCTION - 2026');

  // Both lines fit within the 32-column screen width.
  assert('A KIM & KENNY SHOW'.length <= 32, 'line 1 fits in 32 columns');
  assert('PRODUCTION - 2026'.length <= 32, 'line 2 fits in 32 columns');

  if (ok) console.log('credit-smoke: in-screen credit bitmap/attr addressing + reveal window MATCH');
} finally {
  rmSync(outDir, { recursive: true, force: true });
  delete globalThis.document;
}

if (!ok) process.exit(1);
