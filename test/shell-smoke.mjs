// Pure-logic test for web/interleave.ts. Imports NOTHING from vite: the
// module under test has no DOM/vite dependency, so we transpile it with the
// TypeScript compiler's CLI (already a devDependency) into a scratch dir and
// dynamic-import the plain-JS output.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'zx-interleave-'));

let ok = true;
try {
  execFileSync(
    path.join(repoRoot, 'node_modules', '.bin', 'tsc'),
    [
      path.join(repoRoot, 'web', 'interleave.ts'),
      '--outDir', outDir,
      '--target', 'es2022',
      '--module', 'esnext',
      '--moduleResolution', 'bundler',
      '--strict',
      '--ignoreConfig',
    ],
    { stdio: 'inherit' },
  );

  const { ROW_ADDR, linearize } = await import(
    pathToFileURL(path.join(outDir, 'interleave.js')).href
  );

  // --- ROW_ADDR: 192 entries, formula derived independently of interleave.ts ---
  function expectedRowAddr(y) {
    return ((y & 0xc0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2);
  }
  function assert(cond, msg) {
    if (!cond) {
      console.error(`FAIL: ${msg}`);
      ok = false;
    }
  }

  assert(ROW_ADDR.length === 192, `ROW_ADDR.length === 192 (got ${ROW_ADDR.length})`);
  assert(ROW_ADDR[0] === 0, `row 0 -> 0 (got ${ROW_ADDR[0]})`);
  assert(ROW_ADDR[1] === 256, `row 1 -> 256 (got ${ROW_ADDR[1]})`);
  assert(ROW_ADDR[8] === 32, `row 8 -> 32 (got ${ROW_ADDR[8]})`);
  assert(ROW_ADDR[64] === 2048, `row 64 -> 2048 (got ${ROW_ADDR[64]})`);
  for (let y = 0; y < 192; y++) {
    assert(
      ROW_ADDR[y] === expectedRowAddr(y),
      `row ${y} -> ${expectedRowAddr(y)} (got ${ROW_ADDR[y]})`,
    );
  }

  // --- linearize: synthetic display file ---
  const display = new Uint8Array(6912);
  const y = 100, xByte = 5;
  const addr = expectedRowAddr(y) + xByte; // 3205
  display[addr] = 0xaa;
  const linear = new Uint8Array(32 * 192);
  linearize(display, linear);
  assert(
    linear[y * 32 + xByte] === 0xaa,
    `linear[${y * 32 + xByte}] === 0xaa (got 0x${linear[y * 32 + xByte].toString(16)})`,
  );
  // Spot-check that nothing else in the row got clobbered.
  assert(linear[y * 32 + xByte - 1] === 0, 'neighbor byte left untouched');

  if (ok) console.log('shell-smoke: interleave ROW_ADDR + linearize MATCH');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (!ok) process.exit(1);
