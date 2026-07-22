#!/usr/bin/env bash
set -euo pipefail
bash scripts/embed-assets.sh
mkdir -p web/public
emcc -O2 --no-entry -sSTANDALONE_WASM=1 -sALLOW_MEMORY_GROWTH=0 \
  -sINITIAL_MEMORY=4194304 -sTOTAL_STACK=131072 \
  -sEXPORTED_FUNCTIONS=_pen_boot,_pen_run,_pen_run_frames,_pen_key,_pen_screen,_pen_border,_pen_audio,_pen_trap,_pen_peek,_pen_poke,_pen_frame,_pen_hash,_pen_state_size,_pen_state_save,_pen_state_load,_malloc \
  -o web/public/pen.wasm core/z80.c core/spectrum.c core/penetrator.c
ls -l web/public/pen.wasm
