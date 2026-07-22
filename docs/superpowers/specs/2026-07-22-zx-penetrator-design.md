# zx-penetrator — pixel-perfect Penetrator in the browser

**Date:** 2026-07-22
**Status:** approved

## Goal

Run the original Penetrator (ZX Spectrum 48K, Beam Software 1982) in the
browser, pixel- and behavior-perfect, by emulating the actual game binary.
Deployed as a static site at `https://aastroem.github.io/zx-penetrator`.

"Pixel perfect" means: the emulated machine produces byte-identical
display-file contents to the reference implementation (the Python emulator
in `c64-research`), verified by automated cross-validation — not by eye.

## Non-goals

- Not a general-purpose Spectrum emulator: no tape deck, no BASIC, no
  contended-memory timing, no other games. Only what Penetrator needs
  (proven sufficient by the working Python emulator: IM 1 + EI/HALT,
  direct keyboard polling, stubbed ROM at $0038/$0556/$04C2).
- No reimplementation of game logic; the original blob is the game.
- No enhanced-graphics mode (the CRT shader styles the authentic pixels;
  it never redraws content).

## Architecture

```
core/            C, compiled two ways
  z80.c/h        full documented Z80, exact T-states per instruction
  spectrum.c/h   48K machine: 64KB RAM, port $FE in/out, IM1 frame IRQ,
                 speaker-edge ring buffer, border log, state save/load
  penetrator.c   embeds game blobs, boot(), public WASM API
web/             TypeScript + Vite
  emu.ts         WASM loader, audio-clock-driven scheduler
  gl.ts          WebGL2 renderer (shader decodes display file + attrs)
  audio.ts       AudioWorklet + speaker ring-buffer consumer
  input.ts       keyboard/touch/gamepad -> matrix (row,bit)
  state.ts       save-state slots + landscape persistence (localStorage)
  ui.ts          shell chrome: CRT toggle, save slots, touch overlay
test/
  native harness + cross-validation vs the Python reference emulator
assets/          06-p.cod (32KB game), 04-s.cod (title SCREEN$)
.github/workflows/deploy.yml   emsdk + vite build -> GitHub Pages
```

### Core WASM API (exports)

- `pen_boot()` — reset machine, load SCREEN$ at $4000 + game at $8000,
  PC=$8000.
- `pen_run(tstates) -> tstates_run` — execute at least the given
  T-states, stopping on frame boundaries to fire the IM1 interrupt
  (69888 T-states per frame, 50Hz).
- `pen_key(row, bit, down)` — set/clear a key in the 8×5 matrix.
- `pen_screen() -> ptr` — 6912-byte display file ($4000 region).
- `pen_border() -> int` — current border color 0-7.
- `pen_audio(ptr_out) -> n` — drain speaker-edge events
  (tstate_delta, level) accumulated since last call.
- `pen_state_size() / pen_state_save(ptr) / pen_state_load(ptr)` —
  opaque state blob (regs + RAM + machine state).
- `pen_peek(addr) / pen_poke(addr, v)` — for landscape import/export
  and debugging.

The same C sources build natively (plain `cc`) for the test harness.

## Timing & audio (the clock is the audio clock)

Main thread, rAF loop: `owed = (audioCtx.currentTime - t0) * 3_500_000 -
tstates_done`; run `pen_run(owed)` (capped at 4 frames to survive tab
throttling, dropping owed time beyond that). After each run, drain
speaker edges, convert to 44.1kHz square-wave samples (8-sample linear
ramp on edges to soften clicks), push Float32 chunks to the AudioWorklet
via port.postMessage. Worklet keeps a ~90ms jitter buffer; on underrun it
holds the last level (silence-safe). No SharedArrayBuffer, so no
COOP/COEP headers — required for GitHub Pages.

Audio starts suspended until first user gesture (browser autoplay rules);
the "press any key" title screen doubles as the gesture.

## Rendering (WebGL2)

Two integer textures uploaded per frame: `R8UI 32×192` (bitmap bytes,
linearized from the Spectrum's y-interleave at upload time in TS — one
192-entry row-permutation table) and `R8UI 32×24` (attributes). Fragment
shader decodes ink/paper/bright per pixel and applies FLASH from a
frame-counter uniform (swap every 16 frames). Border drawn as clear
color at authentic proportions (48px top/bottom, 48px sides in native
pixel units).

Presentation: canvas sized to the largest integer multiple that fits,
nearest-neighbor. CRT toggle switches to a second fragment-shader path:
scanlines, mild phosphor glow, slight barrel distortion. Default off.
Preference persisted in localStorage.

## Input

- Keyboard: physical keys map to the Spectrum matrix (full 40-key map),
  plus a friendly layer: arrows/Space/Enter mapped to Penetrator's
  in-game controls. The exact in-game keys are pinned down during
  implementation by reading the $8139 key-scan code (and verified
  empirically in the emulator); the friendly mapping is defined then.
- Touch (shown on coarse-pointer devices): left cluster up/down/
  slower/faster, right cluster fire + bomb; buttons inject matrix keys.
- Gamepad API polled each rAF: d-pad/left stick + two buttons.

## Save states & landscape editor persistence

- Save states: `pen_state_save` blob → base64 → localStorage, 3 slots +
  auto-slot on unload. UI in shell chrome.
- Landscape editor: the original saves terrain to tape via ROM $0556 and
  loads via $04C2. The core traps both addresses (they are already RET
  stubs) and raises a JS callback with HL/DE/IX params; the shell
  exports/imports $D000..$ECCF (the $1CD0-byte landscape) to
  localStorage under a named slot. The editor thus works end-to-end in
  the browser.

## Error handling

- WASM load failure → static error card with link to GitHub issue page.
- Audio underruns → hold last speaker level; never crash the frame loop.
- JAM/unknown opcode in core → trap, surface `pen_error()` string to
  shell, freeze with overlay (should never happen — cross-validation).
- localStorage full/unavailable (private mode) → features degrade to
  in-memory with a toast, game still runs.

## Testing (pixel-perfect proof)

1. **Z80 unit tests (native):** targeted flag/edge cases (DAA table,
   ADC/SBC 16-bit, CB/DDCB, block ops, R register) asserted against
   known-good vectors.
2. **Cross-validation (the real gate):** native harness runs the game
   N frames with a scripted input timeline (boot → menu → start game →
   fixed key script, ≥3 minutes of play incl. attract mode); after every
   frame it emits FNV-1a hashes of (display file, registers). A Python
   script drives the reference emulator in `c64-research` through the
   identical timeline and diffs the hash streams. First divergence
   reported with frame number + register dump. CI runs this on every
   push.
3. **Shell smoke test:** Playwright loads the page, asserts canvas
   renders non-black and audio context starts after a key event.

## Build & deploy

- npm scripts: `dev` (vite + prebuilt wasm), `build:core` (emcc -O2,
  single .wasm + tiny JS glue, no Emscripten runtime bloat:
  `-sEXPORTED_FUNCTIONS=... -sMINIMAL_RUNTIME`), `build` (core + vite),
  `test` (native harness + cross-validation).
- GitHub Actions: setup-emsdk → npm ci → build → test → deploy to Pages
  (`actions/deploy-pages`, base path `/zx-penetrator/`).
- README credits Claude (per Kenneth's convention: credit in README,
  no commit trailers). Game data ships in the repo (abandonware-era
  title, Kenneth's call).

## Milestones

1. Core boots to title in native harness (screen hash matches Python).
2. Cross-validation green over scripted gameplay.
3. WebGL shell: video + input playable, no sound.
4. Audio pipeline.
5. Save states + landscape persistence.
6. Touch/gamepad + CRT shader + chrome.
7. CI + Pages deploy live.
