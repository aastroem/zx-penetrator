// Pure-logic test for web/input.ts's GAME_KEYS matrix. No DOM/vite
// dependency at the type level (attachKeyboard's `Emu` import is type-only
// and erased by tsc), so — same approach as test/shell-smoke.mjs and
// test/ui-smoke.mjs — transpile with the TypeScript compiler CLI into a
// scratch dir and dynamic-import the plain-JS output.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'zx-input-'));

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
      path.join(repoRoot, 'web', 'input.ts'),
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

  const { GAME_KEYS } = await import(pathToFileURL(path.join(outDir, 'input.js')).href);

  // Hand-derived independently from the row spec (row0 $FE Shift,Z,X,C,V ...
  // row7 $7F Space,Sym,M,N,B) rather than copied from input.ts's own ROWS
  // table, so a transcription error in that table gets caught here.
  const expected = {
    KeyT: [2, 4],   // row2 Q,W,E,R,T
    KeyE: [2, 2],
    KeyL: [6, 1],   // row6 Enter,L,K,J,H
    KeyS: [1, 1],   // row1 A,S,D,F,G
    Digit0: [4, 0], // row4 0,9,8,7,6
    KeyY: [5, 4],   // row5 P,O,I,U,Y
    KeyH: [6, 4],
    KeyB: [7, 4],   // row7 Space,Sym,M,N,B
  };

  for (const [code, [row, bit]] of Object.entries(expected)) {
    const got = GAME_KEYS[code];
    assert(
      Array.isArray(got) && got[0] === row && got[1] === bit,
      `${code} -> expected [${row},${bit}], got ${JSON.stringify(got)}`,
    );
  }

  // Sanity: friendly arrow aliases still present and match Q/A/O/P.
  assert(JSON.stringify(GAME_KEYS.ArrowUp) === JSON.stringify(GAME_KEYS.KeyQ), 'ArrowUp mirrors KeyQ');
  assert(JSON.stringify(GAME_KEYS.ArrowDown) === JSON.stringify(GAME_KEYS.KeyA), 'ArrowDown mirrors KeyA');
  assert(JSON.stringify(GAME_KEYS.ArrowLeft) === JSON.stringify(GAME_KEYS.KeyO), 'ArrowLeft mirrors KeyO');
  assert(JSON.stringify(GAME_KEYS.ArrowRight) === JSON.stringify(GAME_KEYS.KeyP), 'ArrowRight mirrors KeyP');

  if (ok) console.log('input-smoke: full 40-key GAME_KEYS matrix MATCH');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (!ok) process.exit(1);
