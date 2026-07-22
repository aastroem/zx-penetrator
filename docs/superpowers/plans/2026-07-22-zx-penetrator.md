# zx-penetrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pixel-perfect Penetrator in the browser: a bespoke Spectrum-48K emulator in C→WASM running the original binary, WebGL2 display, AudioWorklet beeper, deployed to GitHub Pages.

**Architecture:** C core (`z80.c` + `spectrum.c` + `penetrator.c`) builds both natively (test harness, cross-validated against the Python reference emulator in `~/git/c64-research`) and to standalone WASM. TypeScript shell (Vite) drives the core off the audio clock, decodes the display file in a fragment shader, and adds save states, landscape-editor persistence, touch/gamepad, CRT toggle.

**Tech Stack:** C (clang native + Emscripten `-sSTANDALONE_WASM`), TypeScript, Vite, WebGL2, AudioWorklet, GitHub Actions → Pages.

## Global Constraints

- npm (never yarn/pnpm). Deploy target: GitHub Pages `aastroem.github.io/zx-penetrator`, base path `/zx-penetrator/`.
- No SharedArrayBuffer / COOP/COEP anywhere (GitHub Pages can't set headers).
- No git commit trailers; Claude is credited in README only.
- Reference emulator + game data source: `~/git/c64-research` (env `C64R`, default `$HOME/git/c64-research`). Python reference must never be needed in CI — CI compares against committed golden hash files.
- Machine truth (verified in the reference emulator): IM 1, ISR stub `EI/RET` at $0038, ROM elsewhere zero except RET at $0556/$04C2; game loads: SCREEN$ → $4000, 32KB blob → $8000, PC=$8000; frame = 69888 T-states @3.5MHz, IRQ at frame start; FLASH swaps every 16 frames.
- Key matrix rows (index = row): 0=$FE Shift,Z,X,C,V · 1=$FD A,S,D,F,G · 2=$FB Q,W,E,R,T · 3=$F7 1,2,3,4,5 · 4=$EF 0,9,8,7,6 · 5=$DF P,O,I,U,Y · 6=$BF Enter,L,K,J,H · 7=$7F Space,Sym,M,N,B. Bits active-low, bit0 = first key listed.
- In-game controls (decoded from $8BE5): Q climb, A dive, O/I/1 slower, P/2 faster, any of row 7 or row 0 = fire/bomb. Menu: 1 = start game. Title: any key.

---

### Task 1: Repo scaffold + game assets

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `.gitignore`, `web/index.html`, `web/main.ts`, `scripts/import-assets.sh`
- Create (generated): `assets/game.bin` (32768 B), `assets/title.scr` (6912 B)

**Interfaces:**
- Produces: `assets/game.bin`, `assets/title.scr` (exact names; Tasks 3+ embed them). `npm run dev` serves `web/`. Vite `base: '/zx-penetrator/'`.

- [ ] **Step 1: Scaffold npm + vite**

```bash
cd ~/git/zx-penetrator
npm init -y
npm install -D vite typescript
```

`package.json` scripts section (edit in place):

```json
{
  "scripts": {
    "dev": "vite web",
    "build": "npm run build:core && vite build web",
    "build:core": "bash scripts/build-core.sh",
    "test": "bash scripts/test.sh"
  }
}
```

`vite.config.ts`:

```ts
import { defineConfig } from 'vite';
export default defineConfig({
  base: '/zx-penetrator/',
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
});
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "types": ["vite/client"]
  },
  "include": ["web"]
}
```

`.gitignore`:

```
node_modules/
dist/
core/build/
web/public/pen.wasm
test/out/
```

`web/index.html`:

```html
<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Penetrator — ZX Spectrum</title>
<style>html,body{margin:0;background:#111;height:100%;display:grid;place-items:center}</style>
</head><body>
<canvas id="screen"></canvas>
<script type="module" src="/main.ts"></script>
</body></html>
```

`web/main.ts` (placeholder for now):

```ts
console.log('zx-penetrator shell placeholder');
```

- [ ] **Step 2: Import game assets from c64-research**

`scripts/import-assets.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
C64R="${C64R:-$HOME/git/c64-research}"
SRC="$C64R/games/penetrator/extracted"
mkdir -p assets
cp "$SRC/06-p.cod" assets/game.bin
cp "$SRC/04-s.cod" assets/title.scr
ls -l assets
```

Run: `bash scripts/import-assets.sh`
Expected: `game.bin` 32768 bytes, `title.scr` 6912 bytes.

- [ ] **Step 3: Verify dev server**

Run: `npm run dev -- --port 5199 &` then `curl -s localhost:5199/zx-penetrator/ | grep -q canvas && echo OK`; kill the server.
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "Scaffold vite shell and import game assets"
```

---

### Task 2: Z80 core in C with unit tests (native build)

**Files:**
- Create: `core/z80.h`, `core/z80.c`, `test/test_z80.c`, `scripts/build-native.sh`

**Interfaces:**
- Produces (consumed by spectrum.c and all later tasks):

```c
typedef struct Z80 Z80;
struct Z80 {
    uint8_t a, f, b, c, d, e, h, l;
    uint8_t a2, f2, b2, c2, d2, e2, h2, l2;
    uint16_t ix, iy, sp, pc;
    uint8_t i, r, im;
    uint8_t iff1, iff2, halted;
    uint64_t ts;                       /* T-state counter */
    uint8_t mem[65536];
    /* io hooks installed by the machine layer: */
    uint8_t (*inp)(Z80*, uint16_t port);
    void (*outp)(Z80*, uint16_t port, uint8_t v);
};
void z80_reset(Z80 *z);
int  z80_step(Z80 *z);                 /* exec 1 instr, returns T-states */
int  z80_interrupt(Z80 *z);            /* IM1/IM2 request; 1 if taken */
```

Flag bits: `FC=0x01 FN=0x02 FPV=0x04 F3=0x08 FH=0x10 F5=0x20 FZ=0x40 FS=0x80`.

- [ ] **Step 1: Write the failing unit tests**

`test/test_z80.c` — complete file:

```c
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "../core/z80.h"

static Z80 z;
static void rst(const char *code, int n) {
    memset(&z, 0, sizeof z); z80_reset(&z);
    memcpy(z.mem, code, n); z.pc = 0;
}
int main(void) {
    /* ADD A,n overflow+carry: 0x7F + 1 = 0x80, S set, PV set, C clear */
    rst("\xC6\x01", 2); z.a = 0x7F; z80_step(&z);
    assert(z.a == 0x80); assert(z.f & 0x80); assert(z.f & 0x04); assert(!(z.f & 0x01));
    /* SUB borrow: 0 - 1 = FF, C set, N set, S set */
    rst("\xD6\x01", 2); z.a = 0; z80_step(&z);
    assert(z.a == 0xFF); assert(z.f & 0x01); assert(z.f & 0x02);
    /* DAA after ADD 0x15+0x27 = 0x3C -> DAA -> 0x42 */
    rst("\xC6\x27\x27", 3); z.a = 0x15; z80_step(&z); z80_step(&z);
    assert(z.a == 0x42);
    /* ADC HL,BC with carry-in and overflow: 7FFF + 0000 + C = 8000, PV+S */
    rst("\xED\x4A", 2); z.h=0x7F; z.l=0xFF; z.b=0; z.c=0; z.f=0x01; z80_step(&z);
    assert(z.h == 0x80 && z.l == 0x00); assert(z.f & 0x04); assert(z.f & 0x80);
    /* SBC HL,DE: 0000 - 0001 = FFFF, C set */
    rst("\xED\x52", 2); z.h=z.l=0; z.d=0; z.e=1; z.f=0; z80_step(&z);
    assert(z.h == 0xFF && z.l == 0xFF); assert(z.f & 0x01);
    /* DJNZ taken: B=2, offset -2 loops once; total ts 13+8 */
    rst("\x10\xFE\x00", 3); z.b = 2; z80_step(&z);
    assert(z.pc == 0 && z.b == 1); assert(z.ts == 13);
    z80_step(&z); assert(z.pc == 2 && z.b == 0 && z.ts == 21);
    /* CB: BIT 7,(HL) sets Z when bit clear, H always */
    rst("\xCB\x7E", 2); z.h=0x40; z.l=0; z.mem[0x4000]=0x7F; z80_step(&z);
    assert(z.f & 0x40); assert(z.f & 0x10);
    /* DDCB: SET 0,(IX+1) writes memory and copies to B for z=0 */
    rst("\xDD\xCB\x01\xC0", 4); z.ix=0x5000; z.mem[0x5001]=0; z80_step(&z);
    assert(z.mem[0x5001] == 1); assert(z.b == 1);
    /* LDIR: copy 3 bytes, BC=0, PV clear at end, ts = 21+21+16 */
    rst("\xED\xB0", 2); z.h=0x40;z.l=0; z.d=0x50;z.e=0; z.b=0;z.c=3;
    memcpy(&z.mem[0x4000], "abc", 3);
    while (z.pc != 2) z80_step(&z);
    assert(!memcmp(&z.mem[0x5000], "abc", 3)); assert(!(z.f & 0x04));
    assert(z.ts == 58);
    /* EX AF,AF' + EXX round trip */
    rst("\x08\xD9", 2); z.a=1; z.f=2; z.b=3; z80_step(&z); z80_step(&z);
    assert(z.a2 == 1 && z.f2 == 2 && z.b2 == 3);
    /* IM1 interrupt: pushes PC, jumps 0x38, needs IFF1 */
    rst("\xFB\x00", 2); z80_step(&z); z80_step(&z);   /* EI; NOP */
    assert(z80_interrupt(&z) == 1);
    assert(z.pc == 0x38); assert(z.mem[z.sp] == 2);
    assert(z80_interrupt(&z) == 0);                    /* IFF1 now clear */
    /* HALT wakes on interrupt */
    rst("\xFB\x76", 2); z80_step(&z); z80_step(&z);
    assert(z.halted); z80_interrupt(&z); assert(!z.halted); assert(z.pc == 0x38);
    printf("test_z80: all passed\n");
    return 0;
}
```

`scripts/build-native.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
mkdir -p core/build
cc -O2 -Wall -Wextra -o core/build/test_z80 test/test_z80.c core/z80.c
core/build/test_z80
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash scripts/build-native.sh`
Expected: compile error (`z80.h` missing).

- [ ] **Step 3: Implement the core**

Write `core/z80.h` exactly as the Interfaces block above (plus include guard, `#include <stdint.h>`, and the flag `#define`s).

Write `core/z80.c` as a **1:1 port of the proven Python reference** `~/git/c64-research/tools/z80.py` (it already runs Penetrator correctly). Port rules:

- Same decode scheme: `x=op>>6, y=(op>>3)&7, z=op&7, p=y>>1, q=y&1`; prefix loop for DD/FD sets an `idx` mode (0=HL,1=IX,2=IY); CB and ED handled in their own functions, DDCB/FDCB fetch displacement *before* the sub-opcode.
- Port each method to a C function with identical semantics and the same T-state increments: `szp`, `add8`, `sub8`, `inc8`, `dec8`, `add16`, `adc16`, `sbc16`, `alu`, `cc`, `rot`, `_base`, `_cb`, `_ed`, `interrupt`, and the `(IX+d)` displacement handling (`uses_hl6` condition, +8 ts).
- Memory access: direct `z->mem[a]` for read/write (the 48K has no banking); IO through the `inp`/`outp` function pointers only.
- Tricky spots — implement exactly like these C fragments (they match the Python):

```c
static uint8_t add8(Z80 *z, uint8_t x, uint8_t y, int cin) {
    int r = x + y + cin; uint8_t res = r;
    z->f = (res & (FS|F3|F5)) | (res == 0 ? FZ : 0)
         | (((x ^ y ^ r) & 0x10) ? FH : 0)
         | ((((~(x ^ y)) & (x ^ r)) & 0x80) ? FPV : 0)
         | (r > 0xFF ? FC : 0);
    return res;
}
/* DAA */
case 4: { uint8_t a0 = z->a, t = 0, c = z->f & FC;
    if ((z->f & FH) || (a0 & 0x0F) > 9) t |= 0x06;
    if (c || a0 > 0x99) { t |= 0x60; c = FC; }
    z->a = (z->f & FN) ? a0 - t : a0 + t;
    z->f = szp(z, z->a) | c | (z->f & FN) | (((a0 ^ z->a) & 0x10) ? FH : 0);
} break;
/* CCF */
case 7: z->f = (z->f & (FS|FZ|FPV)) | ((z->f & FC) ? FH : 0) | ((z->f & FC) ^ FC); break;
```

- `z80_step` returns `(int)(z->ts - t0)`; bump `z->r = (z->r + 1) & 0x7F` per instruction; a halted CPU burns 4 ts per step.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bash scripts/build-native.sh`
Expected: `test_z80: all passed`

- [ ] **Step 5: Commit**

```bash
git add core test scripts && git commit -m "Z80 core in C with unit tests"
```

---

### Task 3: Spectrum machine + boot to title (golden hash vs Python)

**Files:**
- Create: `core/spectrum.h`, `core/spectrum.c`, `core/penetrator.c`, `scripts/embed-assets.sh`, `test/harness.c`, `test/pyref/gen_golden.py`
- Create (generated): `core/game_data.h`, `test/golden/boot300.hash`
- Modify: `scripts/build-native.sh`

**Interfaces:**
- Consumes: `Z80`, `z80_step`, `z80_interrupt` from Task 2.
- Produces (C API used by harness, WASM exports, and shell):

```c
/* spectrum.h */
typedef struct {
    Z80 cpu;
    uint8_t keys[8];        /* per-row bitmask, 1 = pressed (bits 0-4) */
    uint8_t border;
    uint32_t frame;         /* frame counter */
    /* speaker edge log, drained by pen_audio */
    uint32_t au_ts[4096]; uint8_t au_lv[4096]; int au_n;
    uint64_t frame_start_ts;
    uint8_t trap;           /* 1 = tape-save, 2 = tape-load, 0 = none */
} Spectrum;
void spec_init(Spectrum *s);
void spec_key(Spectrum *s, int row, int bit, int down);
void spec_run_frame(Spectrum *s);      /* 69888 ts then IRQ */

/* penetrator.c — also the WASM export surface */
void     pen_boot(void);
void     pen_run_frames(int n);
uint32_t pen_run(uint32_t tstates);    /* returns ts actually run */
void     pen_key(int row, int bit, int down);
uint8_t *pen_screen(void);             /* -> mem+0x4000 (6912 bytes) */
int      pen_border(void);
int      pen_audio(uint32_t **ts, uint8_t **lv); /* drain, ret count */
int      pen_trap(void);               /* read+clear trap flag */
uint8_t  pen_peek(uint16_t a); void pen_poke(uint16_t a, uint8_t v);
uint32_t pen_frame(void);
uint32_t pen_hash(void);               /* FNV-1a32 screen+regs (tests) */
int      pen_state_size(void);
void     pen_state_save(uint8_t *out); int pen_state_load(uint8_t *in);
```

- Hash definition (identical in C and Python): FNV-1a 32-bit, offset 2166136261, prime 16777619, over the 6912 display bytes then `a,f,b,c,d,e,h,l,ixh,ixl,iyh,iyl,sph,spl,pch,pcl` (16 bytes).

- [ ] **Step 1: Embed assets**

`scripts/embed-assets.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
{ echo "/* generated by embed-assets.sh */";
  xxd -i -n game_bin assets/game.bin;
  xxd -i -n title_scr assets/title.scr; } > core/game_data.h
```

Run it; expect `core/game_data.h` with `unsigned char game_bin[32768]`.

- [ ] **Step 2: Write failing golden test**

`test/pyref/gen_golden.py` — complete file:

```python
#!/usr/bin/env python3
"""Golden hashes from the Python reference emulator."""
import os, sys
C64R = os.environ.get("C64R", os.path.expanduser("~/git/c64-research"))
sys.path.insert(0, os.path.join(C64R, "tools"))
from spectrum import Spectrum

FNV = 2166136261
def fnv(h, data):
    for b in data:
        h = ((h ^ b) * 16777619) & 0xFFFFFFFF
    return h

def state_hash(s):
    h = fnv(FNV, bytes(s.mem[0x4000:0x5B00]))
    regs = bytes([s.a, s.f, s.b, s.c, s.d, s.e, s.h, s.l,
                  s.ix >> 8, s.ix & 255, s.iy >> 8, s.iy & 255,
                  s.sp >> 8, s.sp & 255, s.pc >> 8, s.pc & 255])
    return fnv(h, regs)

def boot(spec):
    g = os.path.join(C64R, "games/penetrator/extracted")
    spec.load_blob(os.path.join(g, "04-s.cod"), 0x4000)
    spec.load_blob(os.path.join(g, "06-p.cod"), 0x8000)
    spec.pc = 0x8000

if __name__ == "__main__":
    s = Spectrum()
    boot(s)
    s.run_frames(300)
    print("%08x" % state_hash(s))
```

Run: `python3 test/pyref/gen_golden.py > test/golden/boot300.hash && cat test/golden/boot300.hash`
Expected: 8-hex-digit hash (create `test/golden/` first).

`test/harness.c` — complete file:

```c
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../core/spectrum.h"
/* modes: boot300 | frames N | timeline file.json (Task 4) */
int main(int argc, char **argv) {
    pen_boot();
    if (argc >= 2 && !strcmp(argv[1], "boot300")) {
        pen_run_frames(300);
        printf("%08x\n", pen_hash());
        return 0;
    }
    fprintf(stderr, "usage: harness boot300\n");
    return 2;
}
```

Append to `scripts/build-native.sh`:

```bash
cc -O2 -Wall -Wextra -o core/build/harness \
   test/harness.c core/spectrum.c core/penetrator.c core/z80.c
if [ "$(core/build/harness boot300)" = "$(cat test/golden/boot300.hash)" ];
then echo "boot300 hash: MATCH"; else echo "boot300 hash: MISMATCH"; exit 1; fi
```

- [ ] **Step 3: Run to verify it fails** (spectrum.c missing) — `bash scripts/build-native.sh` → compile error.

- [ ] **Step 4: Implement spectrum.c + penetrator.c**

`core/spectrum.c` — complete behavior spec (port of `~/git/c64-research/tools/spectrum.py`):

```c
#include "spectrum.h"
#define TS_FRAME 69888
static uint8_t spec_inp(Z80 *z, uint16_t port) {
    Spectrum *s = (Spectrum *)z;           /* cpu is first member */
    if (port & 1) return 0xFF;
    uint8_t hi = port >> 8, v = 0x1F;
    for (int row = 0; row < 8; row++)
        if (!(hi & (1 << row))) v &= ~s->keys[row];
    return v | 0xE0;
}
static void spec_outp(Z80 *z, uint16_t port, uint8_t val) {
    Spectrum *s = (Spectrum *)z;
    if (port & 1) return;
    s->border = val & 7;
    if (s->au_n < 4096) {
        s->au_ts[s->au_n] = (uint32_t)(z->ts - s->frame_start_ts_base);
        s->au_lv[s->au_n] = (val >> 4) & 1;
        s->au_n++;
    }
}
void spec_init(Spectrum *s) {
    memset(s, 0, sizeof *s);
    z80_reset(&s->cpu);
    s->cpu.inp = spec_inp; s->cpu.outp = spec_outp;
    /* synthetic ROM */
    s->cpu.mem[0x0000] = 0xC3;                       /* JP $0000 trap */
    s->cpu.mem[0x0038] = 0xFB; s->cpu.mem[0x0039] = 0xC9;  /* EI/RET */
    s->cpu.mem[0x0556] = 0xC9; s->cpu.mem[0x04C2] = 0xC9;  /* tape stubs */
}
void spec_key(Spectrum *s, int row, int bit, int down) {
    if (down) s->keys[row] |= 1 << bit; else s->keys[row] &= ~(1 << bit);
}
void spec_run_frame(Spectrum *s) {
    uint64_t end = s->cpu.ts + TS_FRAME;
    while (s->cpu.ts < end) {
        if (s->cpu.pc == 0x0556) s->trap = 1;
        if (s->cpu.pc == 0x04C2) s->trap = 2;
        z80_step(&s->cpu);
    }
    z80_interrupt(&s->cpu);
    s->frame++;
}
```

(`frame_start_ts_base` = an extra `uint64_t` in the struct set by `pen_run`/`pen_audio` drain so audio timestamps are relative to the last drain; add it to the header.)

`core/penetrator.c`: singleton `static Spectrum S;`; `pen_boot` = `spec_init` + `memcpy(mem+0x4000, title_scr, 6912)` + `memcpy(mem+0x8000, game_bin, 32768)` + `S.cpu.pc = 0x8000`. `pen_run(ts)` loops `spec_run_frame`-style but against a T-state budget with the same per-instruction trap checks, firing the IRQ each time `ts` crosses a 69888 boundary (keep `uint64_t next_irq`). `pen_hash` implements the FNV spec above. `pen_state_save/load`: `memcpy` of a packed `struct { uint32_t version; Spectrum s; }` (version 1; `load` returns 0 on version mismatch). All exports carry `__attribute__((used))`.

- [ ] **Step 5: Run** `bash scripts/build-native.sh`
Expected: `test_z80: all passed` and `boot300 hash: MATCH`. Debug divergence by binary-searching the frame count (`gen_golden.py` and harness both take an optional frame arg — add `frames N` mode to both if needed).

- [ ] **Step 6: Commit** — `git add -A && git commit -m "Spectrum machine boots Penetrator; boot hash matches Python reference"`

---

### Task 4: Cross-validation over scripted gameplay

**Files:**
- Create: `test/timeline.json`, `test/pyref/run_timeline.py`, `scripts/test.sh`
- Modify: `test/harness.c`
- Create (generated): `test/golden/timeline.hashes`

**Interfaces:**
- Consumes: harness + gen_golden hash machinery from Task 3.
- Produces: `npm test` = green gate; `test/golden/timeline.hashes` committed (one 8-hex hash per frame, 6000 lines).

- [ ] **Step 1: Write the timeline**

`test/timeline.json` (row/bit per the Global Constraints matrix):

```json
{ "frames": 6000, "events": [
  {"frame": 150,  "row": 7, "bit": 0, "down": true},
  {"frame": 160,  "row": 7, "bit": 0, "down": false},
  {"frame": 2600, "row": 3, "bit": 0, "down": true},
  {"frame": 2610, "row": 3, "bit": 0, "down": false},
  {"frame": 2700, "row": 2, "bit": 0, "down": true},
  {"frame": 2760, "row": 2, "bit": 0, "down": false},
  {"frame": 2800, "row": 7, "bit": 2, "down": true},
  {"frame": 2810, "row": 7, "bit": 2, "down": false},
  {"frame": 2900, "row": 1, "bit": 0, "down": true},
  {"frame": 2960, "row": 1, "bit": 0, "down": false},
  {"frame": 3000, "row": 7, "bit": 0, "down": true},
  {"frame": 3010, "row": 7, "bit": 0, "down": false},
  {"frame": 3100, "row": 5, "bit": 0, "down": true},
  {"frame": 3160, "row": 5, "bit": 0, "down": false},
  {"frame": 3300, "row": 2, "bit": 0, "down": true},
  {"frame": 3340, "row": 2, "bit": 0, "down": false},
  {"frame": 4000, "row": 7, "bit": 2, "down": true},
  {"frame": 4010, "row": 7, "bit": 2, "down": false}
]}
```

(Any key at 150 leaves the title; 1 at 2600 starts the game after logo+tune; then climb/fire/dive/faster exercises sprites, terrain, collisions, sfx.)

- [ ] **Step 2: Python side**

`test/pyref/run_timeline.py` — complete file:

```python
#!/usr/bin/env python3
import json, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from gen_golden import Spectrum, boot, state_hash
from spectrum import KEYROWS

tl = json.load(open(os.path.join(os.path.dirname(__file__), "..", "timeline.json")))
ev = sorted(tl["events"], key=lambda e: e["frame"])
s = Spectrum(); boot(s)
i = 0
for f in range(tl["frames"]):
    while i < len(ev) and ev[i]["frame"] == f:
        name = KEYROWS[ev[i]["row"]][ev[i]["bit"]]
        (s.press if ev[i]["down"] else s.release)(name)
        i += 1
    s.frame()
    print("%08x" % state_hash(s))
```

Run: `python3 test/pyref/run_timeline.py > test/golden/timeline.hashes` (takes a few minutes). `wc -l` → 6000.

- [ ] **Step 3: C side + gate**

Add `timeline` mode to `test/harness.c` (tiny hand-rolled parser is fine — the JSON is flat; scan with `sscanf` per line or `strtol` over `"frame":` occurrences):

```c
/* harness timeline test/timeline.json:
   for each frame: apply due events via pen_key, pen_run_frames(1),
   printf("%08x\n", pen_hash()); */
```

`scripts/test.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
bash scripts/build-native.sh
core/build/harness timeline test/timeline.json > test/out/timeline.hashes
if diff -q test/out/timeline.hashes test/golden/timeline.hashes; then
  echo "cross-validation: 6000 frames MATCH"
else
  diff test/out/timeline.hashes test/golden/timeline.hashes | head -3
  echo "first divergent frame above"; exit 1
fi
```

(`mkdir -p test/out` inside the script.)

- [ ] **Step 4: Run** `npm test` → `cross-validation: 6000 frames MATCH`.
On mismatch: first divergent frame number = `diff` line number − 1; re-run Python with a register dump at that frame to isolate the opcode.

- [ ] **Step 5: Commit** (include the golden file) — `git add -A && git commit -m "Cross-validation: 6000-frame scripted gameplay matches Python reference"`

---

### Task 5: WASM build + node smoke test

**Files:**
- Create: `scripts/build-core.sh`, `test/wasm-smoke.mjs`

**Interfaces:**
- Consumes: `pen_*` exports from Task 3.
- Produces: `web/public/pen.wasm` — standalone WASM, no JS glue. Exports the full `pen_*` API plus `memory`. Shell loads it with `WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: stubs })`.

- [ ] **Step 1: Build script**

`scripts/build-core.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
bash scripts/embed-assets.sh
mkdir -p web/public
emcc -O2 --no-entry -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=0 \
  -sINITIAL_MEMORY=4194304 -sTOTAL_STACK=131072 \
  -sEXPORTED_FUNCTIONS=_pen_boot,_pen_run,_pen_run_frames,_pen_key,_pen_screen,_pen_border,_pen_audio,_pen_trap,_pen_peek,_pen_poke,_pen_frame,_pen_hash,_pen_state_size,_pen_state_save,_pen_state_load,_malloc \
  -o web/public/pen.wasm core/z80.c core/spectrum.c core/penetrator.c
ls -l web/public/pen.wasm
```

- [ ] **Step 2: Smoke test**

`test/wasm-smoke.mjs` — complete file:

```js
import { readFile } from 'node:fs/promises';
const bytes = await readFile('web/public/pen.wasm');
const stubs = new Proxy({}, { get: () => () => 0 });
const { instance } = await WebAssembly.instantiate(bytes,
  { wasi_snapshot_preview1: stubs });
const e = instance.exports;
e.pen_boot();
e.pen_run_frames(300);
const hash = (e.pen_hash() >>> 0).toString(16).padStart(8, '0');
const golden = (await readFile('test/golden/boot300.hash', 'utf8')).trim();
if (hash !== golden) { console.error(`WASM ${hash} != golden ${golden}`); process.exit(1); }
console.log('wasm-smoke: boot300 MATCH');
```

Append to `scripts/test.sh`: `node test/wasm-smoke.mjs` (guard with `command -v emcc` so native-only environments still pass the native gate; CI installs emsdk).

- [ ] **Step 3: Run** `npm run build:core && node test/wasm-smoke.mjs` → `wasm-smoke: boot300 MATCH`.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "Standalone WASM build with node smoke test"`

---

### Task 6: Web shell — WebGL2 video + keyboard (playable, silent)

**Files:**
- Create: `web/emu.ts`, `web/gl.ts`, `web/input.ts`
- Modify: `web/main.ts`, `web/index.html`

**Interfaces:**
- Consumes: `pen.wasm` exports (Task 5 shapes).
- Produces:

```ts
// emu.ts
export class Emu {
  static async create(): Promise<Emu>;      // fetch + instantiate wasm
  boot(): void;
  runFrames(n: number): void;
  run(tstates: number): number;
  key(row: number, bit: number, down: boolean): void;
  screen(): Uint8Array;                     // live view, 6912 bytes
  border(): number;
  frame(): number;
  drainAudio(): { ts: Uint32Array; lv: Uint8Array };   // Task 7
  peek(a: number): number; poke(a: number, v: number): void;
  trap(): number;
  stateSave(): Uint8Array; stateLoad(b: Uint8Array): boolean;
}
// gl.ts
export class Screen {
  constructor(canvas: HTMLCanvasElement);
  draw(display: Uint8Array, border: number, frame: number): void;
  setCrt(on: boolean): void;
  resize(): void;                           // integer-scale to window
}
// input.ts
export function attachKeyboard(emu: Emu): void;
export const GAME_KEYS: Record<string, [number, number]>;  // code -> row,bit
```

- [ ] **Step 1: emu.ts**

Complete implementation: fetch `pen.wasm` (`import.meta.env.BASE_URL + 'pen.wasm'`), instantiate with the same Proxy stub as the smoke test, wrap every export; `screen()` returns `new Uint8Array(memory.buffer, e.pen_screen(), 6912)` (re-created after any potential growth — memory growth is off, so cache it).

- [ ] **Step 2: gl.ts**

WebGL2. Vertex shader = fullscreen triangle. Fragment shader (complete, this is the heart):

```glsl
#version 300 es
precision highp float; precision highp usampler2D;
uniform usampler2D uBitmap;   // 32x192, R8UI, y already linearized
uniform usampler2D uAttrs;    // 32x24,  R8UI
uniform int uFrame; uniform int uCrt; uniform int uBorderColor;
in vec2 vUv; out vec4 fragColor;
const vec2 SCREEN = vec2(256.0, 192.0);
const vec2 BORDER = vec2(48.0, 48.0);
vec3 zxColor(uint c, uint bright) {
  float v = bright == 1u ? 1.0 : 0.843;
  return vec3(float((c >> 1u) & 1u), float((c >> 2u) & 1u), float(c & 1u)) * v;
}
void main() {
  vec2 total = SCREEN + BORDER * 2.0;
  vec2 p = vUv * total - BORDER;
  vec3 rgb;
  if (any(lessThan(p, vec2(0.0))) || any(greaterThanEqual(p, SCREEN))) {
    rgb = zxColor(uint(uBorderColor), 0u);
  } else {
    ivec2 ip = ivec2(p);
    uint byteVal = texelFetch(uBitmap, ivec2(ip.x >> 3, ip.y), 0).r;
    uint attr    = texelFetch(uAttrs,  ivec2(ip.x >> 3, ip.y >> 3), 0).r;
    uint bit = (byteVal >> uint(7 - (ip.x & 7))) & 1u;
    uint flash = (attr >> 7u) & 1u;
    if (flash == 1u && ((uFrame >> 4) & 1) == 1) bit ^= 1u;
    uint bright = (attr >> 6u) & 1u;
    rgb = bit == 1u ? zxColor(attr & 7u, bright)
                    : zxColor((attr >> 3u) & 7u, bright);
  }
  if (uCrt == 1) {
    float scan = 0.82 + 0.18 * sin(p.y * 6.28318);
    rgb *= scan;
    rgb += rgb * 0.15 * (1.0 - abs(vUv.y - 0.5) * 2.0);  // mild phosphor
  }
  fragColor = vec4(rgb, 1.0);
}
```

`draw()` linearizes the display file with a precomputed 192-entry table
(`addr = ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2)`) into a
reused `Uint8Array(32*192)`, uploads both textures with
`gl.texSubImage2D` (R8UI, `UNSIGNED_BYTE`, `gl.pixelStorei(gl.UNPACK_ALIGNMENT,1)`),
sets uniforms, draws 3 vertices. `resize()` picks the largest integer `k`
so `352k × 288k` fits the window ((256+96) × (192+96)), sets canvas size,
`gl.viewport`. CRT curvature intentionally omitted from v1 shader (scanline
+ glow only) — keep barrel distortion out unless it survives play-testing.

- [ ] **Step 3: input.ts**

```ts
export const GAME_KEYS: Record<string, [number, number]> = {
  ArrowUp: [2, 0],    // Q climb
  ArrowDown: [1, 0],  // A dive
  ArrowLeft: [5, 1],  // O slower
  ArrowRight: [5, 0], // P faster
  Space: [7, 0],      // fire/bomb
  Enter: [6, 0], Digit1: [3, 0], Digit2: [3, 1], Digit3: [3, 2],
  Digit4: [3, 3], Digit0: [4, 0],
  KeyQ: [2, 0], KeyA: [1, 0], KeyO: [5, 1], KeyP: [5, 0], KeyI: [5, 2],
  KeyM: [7, 2], KeyN: [7, 3], KeyB: [7, 4], KeyZ: [0, 1], KeyX: [0, 2],
};
export function attachKeyboard(emu: Emu) {
  const h = (down: boolean) => (ev: KeyboardEvent) => {
    const m = GAME_KEYS[ev.code];
    if (!m) return;
    ev.preventDefault();
    emu.key(m[0], m[1], down);
  };
  addEventListener('keydown', h(true));
  addEventListener('keyup', h(false));
}
```

- [ ] **Step 4: main.ts loop (no audio yet)**

```ts
import { Emu } from './emu'; import { Screen } from './gl';
import { attachKeyboard } from './input';
const emu = await Emu.create(); emu.boot();
const scr = new Screen(document.getElementById('screen') as HTMLCanvasElement);
attachKeyboard(emu);
addEventListener('resize', () => scr.resize()); scr.resize();
let last = performance.now();
function tick(now: number) {
  const owed = Math.min(4, Math.round((now - last) / 20));  // 50Hz frames
  if (owed > 0) { emu.runFrames(owed); last += owed * 20; }
  else if (now - last > 1000) last = now;                    // tab was parked
  scr.draw(emu.screen(), emu.border(), emu.frame());
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
```

- [ ] **Step 5: Manual test** — `npm run dev`, open the page: title screen pixels identical to `c64-research/games/penetrator/renders/title.png`, any key → logo animation → menu → `1` starts, arrows/space fly the ship. Console clean.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "WebGL2 shell: shader-decoded display, keyboard, playable silent"`

---

### Task 7: Beeper audio (AudioWorklet, audio-clock master)

**Files:**
- Create: `web/audio.ts`, `web/public/beeper-worklet.js`
- Modify: `web/main.ts`

**Interfaces:**
- Consumes: `emu.run(tstates)`, `emu.drainAudio()`.
- Produces: `class Beeper { static create(ctx: AudioContext): Promise<Beeper>; push(chunk: Float32Array): void; }` — worklet with ~90ms ring buffer, holds last level on underrun. `main.ts` switches to audio-clock scheduling.

- [ ] **Step 1: Worklet** — `web/public/beeper-worklet.js` (plain JS, loaded via `audioWorklet.addModule`):

```js
class Beeper extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(16384);
    this.r = 0; this.w = 0; this.last = 0;
    this.port.onmessage = (e) => { const c = e.data;
      for (let i = 0; i < c.length; i++) this.buf[this.w++ & 16383] = c[i]; };
  }
  process(_in, out) { const o = out[0][0];
    for (let i = 0; i < o.length; i++)
      o[i] = this.r < this.w ? (this.last = this.buf[this.r++ & 16383]) : this.last;
    return true;
  }
}
registerProcessor('beeper', Beeper);
```

- [ ] **Step 2: audio.ts** — creates `AudioContext({ sampleRate: 44100 })`, adds the module (`BASE_URL + 'beeper-worklet.js'`), connects node → destination, exposes `push`. Also export `edgesToSamples(edges, tstates, out)`: walk speaker edges (T-state offsets within the run), fill square wave at `44100/3500000` ratio, amplitude ±0.25, 8-sample linear ramp at each edge.

- [ ] **Step 3: main.ts audio-clock scheduling** — on first keydown/pointerdown: `ctx.resume()`, then replace the frame-counting loop:

```ts
let done = 0;                       // tstates executed since audio start
const T = 3500000;
function tick() {
  const owed = Math.min(4 * 69888, (ctx.currentTime - t0) * T - done);
  if (owed > 0) {
    const ran = emu.run(owed); done += ran;
    const { ts, lv } = emu.drainAudio();
    beeper.push(edgesToSamples(ts, lv, ran));
  }
  scr.draw(emu.screen(), emu.border(), emu.frame());
  requestAnimationFrame(tick);
}
```

- [ ] **Step 4: Manual test** — title tune plays cleanly (compare by ear with `c64-research/games/penetrator/extracted/intro-tune.wav`); in-game thrust/fire/explosion sfx present; no crackle after 5 minutes; muting tab and returning doesn't desync (game keeps running off audio clock).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "Sample-accurate beeper via AudioWorklet, audio-clock scheduling"`

---

### Task 8: Save states + landscape editor persistence

**Files:**
- Create: `web/state.ts`
- Modify: `web/main.ts`, `web/ui parts in index.html`

**Interfaces:**
- Consumes: `emu.stateSave/stateLoad`, `emu.trap()`, `emu.peek/poke`.
- Produces:

```ts
export class Slots {
  constructor(emu: Emu);
  save(slot: 0 | 1 | 2): void;      // localStorage 'zxpen.state.N' base64
  load(slot: 0 | 1 | 2): boolean;
  autoSaveOnUnload(): void;         // 'zxpen.state.auto'
  pollTraps(): void;                // call each tick; handles 0x0556/0x04C2
}
```

- [ ] **Step 1:** Implement `Slots`. Base64 via `btoa(String.fromCharCode(...chunk))` in 8KB chunks. Trap handling: trap 1 (save) → read `$D000..$ECCF` via `peek` into `zxpen.land.current`; trap 2 (load) → if saved landscape exists, `poke` it back. Wire `pollTraps()` into the rAF loop; keys F5/F8 = save/load slot 0 (guard `preventDefault`), plus UI buttons in Task 9.

- [ ] **Step 2: Manual test** — save mid-game (F5), die, load (F8) → exact resume. Landscape editor (`2` on menu): edit terrain, trigger its save option → reload page → editor load pulls the custom terrain back.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "Save states and landscape editor persistence via tape-trap hooks"`

---

### Task 9: Touch, gamepad, CRT toggle, chrome

**Files:**
- Create: `web/ui.ts`
- Modify: `web/index.html`, `web/main.ts`, `web/input.ts`, `web/gl.ts`

**Interfaces:**
- Consumes: `Screen.setCrt`, `Slots`, `GAME_KEYS`, `emu.key`.
- Produces: `initUi(deps): void` — top bar (CRT checkbox persisted at `zxpen.crt`, 3 save/load slot buttons, keys help details element crediting the original key map); touch overlay (media `(pointer: coarse)`): left column buttons ▲(Q) ▼(A) ◀(O) ▶(P), right FIRE(Space) — `pointerdown/up/cancel` → `emu.key`; `pollGamepad()` each tick: axes/dpad → Q/A/O/P, buttons 0/1 → fire.

- [ ] **Step 1:** Implement `ui.ts` + minimal CSS in `index.html` (buttons ≥64px, semi-transparent, `touch-action: none` on overlay).
- [ ] **Step 2: Manual test** — DevTools device mode: buttons fly the ship; CRT toggle visibly adds scanlines and survives reload; gamepad (if present) flies.
- [ ] **Step 3: Commit** — `git add -A && git commit -m "Touch overlay, gamepad, CRT toggle, shell chrome"`

---

### Task 10: CI + GitHub Pages deploy + README

**Files:**
- Create: `.github/workflows/deploy.yml`, `README.md`

**Interfaces:**
- Consumes: `npm test`, `npm run build`.
- Produces: live site at `https://aastroem.github.io/zx-penetrator/`.

- [ ] **Step 1: Workflow**

```yaml
name: build-test-deploy
on: { push: { branches: [main] } }
permissions: { contents: read, pages: write, id-token: write }
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: mymindstorm/setup-emsdk@v14
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm test          # native cross-validation + wasm smoke
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages }
    steps:
      - uses: actions/deploy-pages@v4
```

- [ ] **Step 2: README.md** — what it is, controls table, the pixel-perfect verification story (per-frame hash cross-validation), landscape-editor persistence, build instructions (`emcc` + npm), provenance (RE'd in c64-research, Beam Software 1982 credit, abandonware note), and: "Built with Claude (Anthropic), reverse-engineering and implementation." No license file for the game data; code under MIT.

- [ ] **Step 3: Create GitHub repo + push**

```bash
gh repo create aastroem/zx-penetrator --public --source . --push
gh api repos/aastroem/zx-penetrator/pages -X POST \
  -f build_type=workflow 2>/dev/null || true
```

Then verify: actions run green; `curl -s https://aastroem.github.io/zx-penetrator/ | grep -q canvas`.

- [ ] **Step 4: Commit any fixes** — `git add -A && git commit -m "CI: cross-validate, build, deploy to Pages"`

---

## Self-Review Notes

- Spec coverage: core API ✔ (T3), audio-clock scheduling ✔ (T7), shader decode + FLASH + border ✔ (T6), CRT ✔ (T6/T9), input incl. decoded game keys ✔ (T6), save states ✔ (T8), landscape traps ✔ (T8), cross-validation gate ✔ (T4, CI in T10), no-SAB constraint ✔ (T5 standalone wasm, T7 postMessage), Pages base path ✔ (T1/T10). Playwright smoke from spec deliberately reduced to manual test steps + curl check (YAGNI for v1; revisit if regressions bite).
- Type consistency: `pen_*` names identical across harness, smoke test, emcc exports, `Emu` wrapper. Hash spec identical in gen_golden.py / penetrator.c / wasm-smoke.
- Placeholders: none — the two "port from reference" tasks name the exact source file, the exact function list, and are gated by executable tests.
