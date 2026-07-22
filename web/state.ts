// Save-state slots + landscape-editor persistence, layered on emu.ts's
// stateSave/stateLoad/trap/peek/poke and the browser's localStorage. Kept
// dependency-light (only structural interfaces, no import of emu.ts's
// concrete `Emu` class or the DOM's concrete `Storage` type) so it's
// testable from plain Node with fakes — see test/state-smoke.mjs.

/** The subset of Emu's surface Slots needs. `Emu` satisfies this
 * structurally, so no import (and no wasm dependency) is required here. */
export interface EmuLike {
  stateSave(): Uint8Array;
  stateLoad(bytes: Uint8Array): boolean;
  trap(): number;
  peek(a: number): number;
  poke(a: number, v: number): void;
}

/** The subset of the Web Storage API (localStorage/sessionStorage) Slots
 * needs. Lets tests inject a plain object instead of a real Storage. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// Note the explicit '.js' extension: TS (moduleResolution "bundler") maps
// this back to b64.ts at typecheck time, but leaves the specifier as-is in
// emitted output — required for the compiled JS to run directly under
// Node's ESM loader (see test/state-smoke.mjs), and harmless for Vite too.
import { b64EncodeChunked, b64Decode } from './b64.js';

// ROM tape-trap PCs (see core/spectrum.c's spec_run_frame): the synthetic
// ROM stubs at $0556/$04C2 are single RET instructions, so by the time
// trap() reports a hit the "tape" operation has already (instantly)
// returned to the caller from the Z80's point of view — we just need to
// shuttle the bytes it would have written/read.
const TRAP_TAPE_SAVE = 1;
const TRAP_TAPE_LOAD = 2;

// The landscape editor's tape-save/load range: $D000-$ECCF inclusive.
const LANDSCAPE_ADDR = 0xd000;
const LANDSCAPE_SIZE = 0x1cd0; // 7376 bytes

const LANDSCAPE_KEY = 'zxpen.land.current';
const AUTO_KEY = 'zxpen.state.auto';
const SLOT_KEYS: Record<0 | 1 | 2, string> = {
  0: 'zxpen.state.0',
  1: 'zxpen.state.1',
  2: 'zxpen.state.2',
};

/** localStorage as seen from module scope, resolved lazily (not at import
 * time) so this module never touches the global at all unless a caller
 * actually asks for the default storage — keeping it importable from Node. */
function defaultStorage(): StorageLike {
  if (typeof localStorage !== 'undefined') return localStorage;
  const err = 'localStorage is not defined in this environment';
  return {
    getItem(): string | null {
      throw new Error(err);
    },
    setItem(): void {
      throw new Error(err);
    },
    removeItem(): void {
      throw new Error(err);
    },
  };
}

export class Slots {
  private readonly emu: EmuLike;
  private readonly storage: StorageLike;
  // In-memory fallback used once `storage` proves to throw (private
  // browsing quota, disabled storage, etc). Once engaged we stay on it for
  // the rest of the session so reads and writes don't get split across two
  // stores; the switch is logged once via console.warn, and (browser-only)
  // stamped onto <body> as a data attribute so a future UI (Task 9) can
  // surface it as a toast.
  private memoryFallback: Map<string, string> | null = null;
  private warned = false;

  constructor(emu: EmuLike, storage: StorageLike = defaultStorage()) {
    this.emu = emu;
    this.storage = storage;
  }

  private fallback(err: unknown): Map<string, string> {
    if (!this.memoryFallback) this.memoryFallback = new Map();
    if (!this.warned) {
      this.warned = true;
      console.warn(
        'zxpen: localStorage unavailable, falling back to in-memory storage ' +
          '(save states will not persist across reloads)',
        err,
      );
      if (typeof document !== 'undefined' && document.body) {
        document.body.setAttribute('data-zxpen-storage-fallback', '1');
      }
    }
    return this.memoryFallback;
  }

  private setItem(key: string, value: string): void {
    if (this.memoryFallback) {
      this.memoryFallback.set(key, value);
      return;
    }
    try {
      this.storage.setItem(key, value);
    } catch (err) {
      this.fallback(err).set(key, value);
    }
  }

  private getItem(key: string): string | null {
    if (this.memoryFallback) return this.memoryFallback.get(key) ?? null;
    try {
      return this.storage.getItem(key);
    } catch (err) {
      return this.fallback(err).get(key) ?? null;
    }
  }

  /** Saves a full emulator snapshot to slot 0/1/2. */
  save(slot: 0 | 1 | 2): void {
    const bytes = this.emu.stateSave();
    this.setItem(SLOT_KEYS[slot], b64EncodeChunked(bytes));
  }

  /** Loads slot 0/1/2 back into the emulator. Returns false if the slot is
   * empty or the emulator rejected the snapshot (e.g. size mismatch). */
  load(slot: 0 | 1 | 2): boolean {
    const encoded = this.getItem(SLOT_KEYS[slot]);
    if (encoded === null) return false;
    return this.emu.stateLoad(b64Decode(encoded));
  }

  /** Registers a 'pagehide' listener that snapshots the emulator to
   * 'zxpen.state.auto'. 'pagehide' is used rather than 'beforeunload'
   * because it fires reliably on mobile Safari/Chrome (bfcache eviction,
   * tab switch, app backgrounding), where 'beforeunload' often doesn't.
   *
   * Deliberately does NOT auto-restore this slot on boot: silently
   * resuming a stale run without the player asking for it would be
   * surprising. Task 9's UI is expected to detect 'zxpen.state.auto' and
   * offer it as an explicit "resume?" choice instead. */
  autoSaveOnUnload(): void {
    addEventListener('pagehide', () => {
      const bytes = this.emu.stateSave();
      this.setItem(AUTO_KEY, b64EncodeChunked(bytes));
    });
  }

  /** Call once per tick (any scheduling path) so a tape-save/load hit is
   * never missed regardless of which loop is currently driving the
   * emulator. Handles trap 1 (tape save of the landscape editor's buffer,
   * $D000-$ECCF) by stashing it under 'zxpen.land.current', and trap 2
   * (tape load) by restoring it if present. trap() itself reads-and-clears
   * the flag, so this is safe to call unconditionally every tick. */
  pollTraps(): void {
    const t = this.emu.trap();
    if (t === TRAP_TAPE_SAVE) {
      const buf = new Uint8Array(LANDSCAPE_SIZE);
      for (let i = 0; i < LANDSCAPE_SIZE; i++) {
        buf[i] = this.emu.peek(LANDSCAPE_ADDR + i);
      }
      this.setItem(LANDSCAPE_KEY, b64EncodeChunked(buf));
    } else if (t === TRAP_TAPE_LOAD) {
      const encoded = this.getItem(LANDSCAPE_KEY);
      if (encoded !== null) {
        const buf = b64Decode(encoded);
        const n = Math.min(LANDSCAPE_SIZE, buf.length);
        for (let i = 0; i < n; i++) {
          this.emu.poke(LANDSCAPE_ADDR + i, buf[i]);
        }
      }
    }
  }
}

/** Standalone F5 (save slot 0) / F8 (load slot 0) hotkeys. Kept out of
 * input.ts's GAME_KEYS (which drives in-game controls) as its own listener,
 * since these are shell-level actions, not gameplay keys. preventDefault is
 * required for F5 — browsers otherwise treat it as a page reload. */
export function attachHotkeys(slots: Slots): void {
  addEventListener('keydown', (ev) => {
    if (ev.code === 'F5') {
      ev.preventDefault();
      slots.save(0);
    } else if (ev.code === 'F8') {
      ev.preventDefault();
      slots.load(0);
    }
  });
}
