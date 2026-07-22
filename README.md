# zx-penetrator

**[Play it in your browser →](https://aastroem.github.io/zx-penetrator/)**

A pixel-perfect port of *Penetrator* (ZX Spectrum 48K, Beam Software, 1982,
design by Philip Mitchell) running entirely client-side. The original game
binary is not reimplemented — it's emulated: a purpose-built Spectrum 48K
core, written in C and compiled to WebAssembly, executes the real Z80
machine code, and a WebGL2 shader decodes the Spectrum's display file
(bitmap + attributes, including FLASH) straight out of emulated memory. A
sample-accurate AudioWorklet reconstructs the beeper audio from the
emulated speaker port.

Nothing about the game's look, timing, or behavior has been reverse
engineered into a rewrite — the machine just runs the original 1982 code.

## Controls

| Action        | Keyboard         | Touch / Gamepad         |
|---------------|------------------|--------------------------|
| Climb         | `Q` / `↑`        | left cluster, up         |
| Dive          | `A` / `↓`        | left cluster, down       |
| Slower        | `O` / `←`        | left cluster, left       |
| Faster        | `P` / `→`        | left cluster, right      |
| Fire + bomb   | `Space` / `M`    | tap the fire button      |
| Menu          | `1` / `2`        | —                        |
| Quick save    | `F5` (slot 1)    | —                        |
| Quick load    | `F8` (slot 1)    | —                        |

A touch control overlay appears automatically on coarse-pointer (mobile/
tablet) devices, and any connected gamepad (d-pad or left stick, plus two
buttons) works out of the box via the Gamepad API.

## The pixel-perfect story

"Pixel perfect" isn't a marketing claim here, it's a test result. The C
core builds two ways from the same source: once to WebAssembly for the
browser, and once as a native binary for a test harness. The harness
drives the emulator through a scripted input timeline — boot, menu,
into the game, several minutes of scripted play — and after *every
single frame* emits an FNV-1a hash of the display file and CPU registers.
An independent Python Spectrum emulator (a sibling project, in a
companion research repo) is driven through the identical input timeline
and produces its own per-frame hash stream. The two streams are diffed
frame-by-frame over 6000 frames; the first divergence, if any, is
reported with a frame number and register dump.

The resulting golden hash file is checked into this repo and re-verified
on every CI run — a real regression in the Z80 core or machine model
fails the build before it ever reaches Pages.

## Landscape editor persistence

Penetrator's landscape editor originally saved custom terrain to
cassette tape. In this port, the two ROM routines the game uses for
tape save/load are trapped inside the emulator core; instead of hitting
real tape I/O, they hand the terrain data to the JavaScript shell, which
stores it in `localStorage`. The editor works end-to-end in the browser,
save slots and all, with no tape deck in sight.

## Building it yourself

Requires [Emscripten](https://emscripten.org/) (`emcc` on your `PATH`)
and Node.js 22.

```bash
npm ci
npm test        # native cross-validation against the golden hash file
npm run build   # emcc core build + vite bundle -> dist/
```

`npm run dev` runs a Vite dev server against a prebuilt wasm for
day-to-day front-end work.

## Provenance

The Spectrum machine model and Z80 core were reverse engineered from the
original Penetrator cassette image, cross-checked against an independent
Python reference emulator built in a companion research repo
([c64-research](https://github.com/aastroem/c64-research), a broader
8-bit reverse-engineering project). *Penetrator* is © 1982 Beam Software.
The original game binary is included in this repository as an
abandonware-era title; if you are the rights holder and want it removed,
please open an issue and it will be taken down promptly.

## License

The code in this repository (Z80/Spectrum emulator core, build tooling,
web front end) is MIT licensed — see [LICENSE](LICENSE). This license
covers the code **only**; it does not extend to the Penetrator game data
shipped alongside it (see Provenance above).

---

Reverse-engineering, emulator, and port built with Claude (Anthropic).
