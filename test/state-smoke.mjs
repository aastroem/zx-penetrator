// Pure-logic test for web/b64.ts and web/state.ts. Neither module touches
// DOM/vite/wasm at the type level in a way tsc can't resolve standalone
// (state.ts's Emu/Storage dependencies are structural interfaces, not
// imports of the concrete classes), so we transpile both with the
// TypeScript compiler's CLI (already a devDependency) into a scratch dir
// and dynamic-import the plain-JS output — same approach as
// test/shell-smoke.mjs / test/audio-smoke.mjs.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const outDir = mkdtempSync(path.join(tmpdir(), 'zx-state-'));

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
      path.join(repoRoot, 'web', 'b64.ts'),
      path.join(repoRoot, 'web', 'state.ts'),
      '--outDir', outDir,
      '--target', 'es2022',
      '--module', 'esnext',
      '--moduleResolution', 'bundler',
      '--strict',
      '--ignoreConfig',
    ],
    { stdio: 'inherit' },
  );

  const { b64EncodeChunked, b64Decode } = await import(
    pathToFileURL(path.join(outDir, 'b64.js')).href
  );
  const { Slots } = await import(
    pathToFileURL(path.join(outDir, 'state.js')).href
  );

  // --- (a) b64 roundtrip of an 86128-byte random buffer, byte-exact -------
  {
    const n = 86128;
    const bytes = new Uint8Array(n);
    // Deterministic PRNG (mulberry32) so failures are reproducible.
    let seed = 0xc0ffee;
    function rnd() {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    for (let i = 0; i < n; i++) bytes[i] = Math.floor(rnd() * 256);

    const encoded = b64EncodeChunked(bytes);
    const decoded = b64Decode(encoded);
    assert(decoded.length === n, `b64 roundtrip: length ${decoded.length} === ${n}`);
    let exact = true;
    for (let i = 0; i < n; i++) {
      if (decoded[i] !== bytes[i]) {
        exact = false;
        break;
      }
    }
    assert(exact, 'b64 roundtrip: byte-exact for 86128-byte random buffer');
  }

  // --- (a1) b64 roundtrip for boundary buffer sizes -------------------------
  {
    const CHUNK_BYTES = 8193;
    const sizesToTest = [0, CHUNK_BYTES, 2 * CHUNK_BYTES, CHUNK_BYTES - 1];
    for (const size of sizesToTest) {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 17 + 7) & 0xff;
      const encoded = b64EncodeChunked(bytes);
      const decoded = b64Decode(encoded);
      assert(decoded.length === size, `b64 boundary: length ${size}`);
      let exact = true;
      for (let i = 0; i < size; i++) {
        if (decoded[i] !== bytes[i]) {
          exact = false;
          break;
        }
      }
      assert(exact, `b64 boundary: byte-exact for ${size}-byte buffer`);
    }
  }

  // --- Fake storage + stub emu shared by (b) and (c)/(d) ------------------
  function makeFakeStorage() {
    const m = new Map();
    return {
      map: m,
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => {
        m.set(k, v);
      },
      removeItem: (k) => {
        m.delete(k);
      },
    };
  }

  function makeStubEmu(memSize, expectedStateSize = null) {
    const mem = new Uint8Array(memSize);
    return {
      mem,
      savedBytes: null, // known bytes returned by stateSave()
      lastLoadedBytes: null, // records what stateLoad() was called with
      trapValue: 0,
      expectedStateSize, // if set, stateLoad rejects wrong-size blobs
      stateSave() {
        return this.savedBytes;
      },
      stateLoad(bytes) {
        this.lastLoadedBytes = bytes;
        // Reject wrong-size blobs like the real emu.ts does
        if (this.expectedStateSize !== null && bytes.length !== this.expectedStateSize) {
          return false;
        }
        return true;
      },
      trap() {
        const t = this.trapValue;
        this.trapValue = 0; // real pen_trap() reads-and-clears
        return t;
      },
      peek(a) {
        return this.mem[a];
      },
      poke(a, v) {
        this.mem[a] = v;
      },
    };
  }

  // --- (b) Slots.save/load roundtrip via fake storage, byte-exact ---------
  {
    const storage = makeFakeStorage();
    const emu = makeStubEmu(0x10000);
    const known = new Uint8Array(1234);
    for (let i = 0; i < known.length; i++) known[i] = (i * 7 + 3) & 0xff;
    emu.savedBytes = known;

    const slots = new Slots(emu, storage);
    slots.save(0);
    assert(storage.map.has('zxpen.state.0'), 'save: writes zxpen.state.0 key');

    const result = slots.load(0);
    assert(result === true, 'load: returns emu.stateLoad()\'s result (true)');
    assert(
      emu.lastLoadedBytes.length === known.length,
      `load: byte length ${emu.lastLoadedBytes?.length} === ${known.length}`,
    );
    let exact = true;
    for (let i = 0; i < known.length; i++) {
      if (emu.lastLoadedBytes[i] !== known[i]) exact = false;
    }
    assert(exact, 'Slots save/load: byte-exact roundtrip through fake storage');

    // Empty slot -> load() returns false without touching the emu.
    const emptySlots = new Slots(emu, makeFakeStorage());
    assert(emptySlots.load(1) === false, 'load: empty slot returns false');

    // Wrong-size blob -> Slots.load() returns false when emu.stateLoad() rejects it
    const storage2 = makeFakeStorage();
    const goodState = new Uint8Array(1234);
    for (let i = 0; i < goodState.length; i++) goodState[i] = (i * 11 + 2) & 0xff;
    const emuWithSizeCheck = makeStubEmu(0x10000, 1234); // expects 1234-byte state
    emuWithSizeCheck.savedBytes = goodState;
    const slots2 = new Slots(emuWithSizeCheck, storage2);
    slots2.save(0);

    // Store a wrong-size blob directly in storage
    const wrongSizeState = new Uint8Array(999);
    storage2.setItem('zxpen.state.0', b64EncodeChunked(wrongSizeState));
    const resultWrongSize = slots2.load(0);
    assert(resultWrongSize === false, 'load: wrong-size blob returns false from emu.stateLoad()');
  }

  // --- (c) trap 1 (tape save) copies 7376 bytes $D000..$ECCF into storage -
  {
    const LANDSCAPE_ADDR = 0xd000;
    const LANDSCAPE_SIZE = 0x1cd0; // 7376
    const storage = makeFakeStorage();
    const emu = makeStubEmu(0x10000);
    for (let i = 0; i < LANDSCAPE_SIZE; i++) {
      emu.mem[LANDSCAPE_ADDR + i] = (i * 13 + 5) & 0xff;
    }
    const slots = new Slots(emu, storage);
    emu.trapValue = 1;
    slots.pollTraps();

    assert(storage.map.has('zxpen.land.current'), 'trap 1: writes zxpen.land.current key');
    const stored = b64Decode(storage.map.get('zxpen.land.current'));
    assert(
      stored.length === LANDSCAPE_SIZE,
      `trap 1: stored length ${stored.length} === ${LANDSCAPE_SIZE}`,
    );
    let exact = true;
    for (let i = 0; i < LANDSCAPE_SIZE; i++) {
      if (stored[i] !== emu.mem[LANDSCAPE_ADDR + i]) exact = false;
    }
    assert(exact, 'trap 1: stored bytes match $D000..$ECCF exactly');
    assert(emu.trap() === 0, 'trap 1: pollTraps() consumed (read-and-cleared) the trap flag');
  }

  // --- (d) trap 2 (tape load) pokes the stored landscape back -------------
  {
    const LANDSCAPE_ADDR = 0xd000;
    const LANDSCAPE_SIZE = 0x1cd0;
    const storage = makeFakeStorage();
    const known = new Uint8Array(LANDSCAPE_SIZE);
    for (let i = 0; i < LANDSCAPE_SIZE; i++) known[i] = (i * 29 + 11) & 0xff;
    storage.map.set('zxpen.land.current', b64EncodeChunked(known));

    const emu = makeStubEmu(0x10000);
    const slots = new Slots(emu, storage);
    emu.trapValue = 2;
    slots.pollTraps();

    let exact = true;
    for (let i = 0; i < LANDSCAPE_SIZE; i++) {
      if (emu.mem[LANDSCAPE_ADDR + i] !== known[i]) exact = false;
    }
    assert(exact, 'trap 2: pokes stored landscape back into $D000..$ECCF exactly');
  }

  if (ok) console.log('state-smoke: b64 roundtrip + Slots save/load + trap 1/2 MATCH');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (!ok) process.exit(1);
