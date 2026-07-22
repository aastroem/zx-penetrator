// Thin TypeScript wrapper over the standalone pen.wasm module (core/spectrum.h
// exports). Instantiation follows the same pattern as test/wasm-smoke.mjs.

interface PenExports {
  memory: WebAssembly.Memory;
  pen_boot(): void;
  pen_run_frames(n: number): void;
  pen_run(tstates: number): number;
  pen_key(row: number, bit: number, down: number): void;
  pen_screen(): number;
  pen_border(): number;
  pen_audio(tsOut: number, lvOut: number): number;
  pen_trap(): number;
  pen_peek(a: number): number;
  pen_poke(a: number, v: number): void;
  pen_frame(): number;
  pen_hash(): number;
  pen_state_size(): number;
  pen_state_save(out: number): void;
  pen_state_load(inp: number): number;
  malloc(n: number): number;
}

const SCREEN_BYTES = 6912;

export class Emu {
  private readonly e: PenExports;
  private readonly screenView: Uint8Array;
  // Scratch cells for pen_audio's out-params: it writes a pointer value
  // (4 bytes, little-endian) into each of these addresses.
  private readonly audioTsSlot: number;
  private readonly audioLvSlot: number;
  // Save-state scratch buffer, malloc'd lazily on first use and reused
  // forever after (see stateBuf() below) — there is no wasm `free` export,
  // so a fresh malloc per stateSave()/stateLoad() call would leak the wasm
  // heap unboundedly once the UI starts calling these repeatedly (every F5,
  // every autosave). pen_state_size() is a compile-time constant, so one
  // buffer of that size safely serves both directions: save and load are
  // never concurrent (this is a single-threaded, single-instance wrapper).
  private stateBufPtr: number | null = null;

  private constructor(e: PenExports) {
    this.e = e;
    this.screenView = new Uint8Array(e.memory.buffer, e.pen_screen(), SCREEN_BYTES);
    this.audioTsSlot = e.malloc(4);
    this.audioLvSlot = e.malloc(4);
  }

  private stateBuf(): number {
    if (this.stateBufPtr === null) {
      this.stateBufPtr = this.e.malloc(this.e.pen_state_size());
    }
    return this.stateBufPtr;
  }

  static async create(): Promise<Emu> {
    const url = import.meta.env.BASE_URL + 'pen.wasm';
    const res = await fetch(url);
    const bytes = await res.arrayBuffer();
    const stubs = new Proxy({}, { get: () => () => 0 });
    const { instance } = await WebAssembly.instantiate(bytes, {
      wasi_snapshot_preview1: stubs,
    });
    return new Emu(instance.exports as unknown as PenExports);
  }

  boot(): void {
    this.e.pen_boot();
  }

  runFrames(n: number): void {
    this.e.pen_run_frames(n);
  }

  run(tstates: number): number {
    return this.e.pen_run(tstates) >>> 0;
  }

  key(row: number, bit: number, down: boolean): void {
    this.e.pen_key(row, bit, down ? 1 : 0);
  }

  screen(): Uint8Array {
    return this.screenView;
  }

  border(): number {
    return this.e.pen_border();
  }

  frame(): number {
    return this.e.pen_frame() >>> 0;
  }

  drainAudio(): { ts: Uint32Array; lv: Uint8Array } {
    const n = this.e.pen_audio(this.audioTsSlot, this.audioLvSlot) >>> 0;
    if (n === 0) {
      return { ts: new Uint32Array(0), lv: new Uint8Array(0) };
    }
    const buf = this.e.memory.buffer;
    const view = new DataView(buf);
    const tsPtr = view.getUint32(this.audioTsSlot, true);
    const lvPtr = view.getUint32(this.audioLvSlot, true);
    // Copy out: the underlying arrays are static storage inside the wasm
    // module and get overwritten by the next drain.
    const ts = new Uint32Array(buf, tsPtr, n).slice();
    const lv = new Uint8Array(buf, lvPtr, n).slice();
    return { ts, lv };
  }

  peek(a: number): number {
    return this.e.pen_peek(a);
  }

  poke(a: number, v: number): void {
    this.e.pen_poke(a, v);
  }

  trap(): number {
    return this.e.pen_trap();
  }

  stateSave(): Uint8Array {
    const size = this.e.pen_state_size();
    const ptr = this.stateBuf();
    this.e.pen_state_save(ptr);
    // .slice() copies out of wasm memory: the shared buffer is about to be
    // reused by the next stateSave()/stateLoad() call.
    return new Uint8Array(this.e.memory.buffer, ptr, size).slice();
  }

  stateLoad(b: Uint8Array): boolean {
    const ptr = this.stateBuf();
    new Uint8Array(this.e.memory.buffer, ptr, b.length).set(b);
    return this.e.pen_state_load(ptr) !== 0;
  }
}
