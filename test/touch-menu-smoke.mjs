// Pure-logic test for web/ui.ts's touch menu-strip key derivation. No DOM/
// vite dependency at the type level, so — same approach as
// test/input-smoke.mjs and test/shell-smoke.mjs — transpile with the
// TypeScript compiler CLI into a scratch dir and dynamic-import the plain-JS
// output.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'zx-touch-menu-'));

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

  // Hand-written expectations, independent of ui.ts's MENU_STRIP_KEYS table
  // (which itself derives from GAME_KEYS) and independent of input.ts's own
  // ROWS table, per the touch menu strip's spec: 1->[3,0] 2->[3,1] T->[2,4]
  // E->[2,2] L->[6,1] S->[1,1].
  const expected = {
    Digit1: [3, 0],
    Digit2: [3, 1],
    KeyT: [2, 4],
    KeyE: [2, 2],
    KeyL: [6, 1],
    KeyS: [1, 1],
  };

  for (const [code, [row, bit]] of Object.entries(expected)) {
    const got = GAME_KEYS[code];
    assert(
      Array.isArray(got) && got[0] === row && got[1] === bit,
      `menu-strip ${code} -> expected [${row},${bit}], got ${JSON.stringify(got)}`,
    );
  }

  if (ok) console.log('touch-menu-smoke: menu-strip (row,bit) derivation MATCH');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (!ok) process.exit(1);
