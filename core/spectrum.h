#ifndef SPECTRUM_H
#define SPECTRUM_H

#include <stdint.h>
#include "z80.h"

typedef struct {
    Z80 cpu;
    uint8_t keys[8];        /* per-row bitmask, 1 = pressed (bits 0-4) */
    uint8_t border;
    uint32_t frame;         /* frame counter */
    /* speaker edge log, drained by pen_audio */
    uint32_t au_ts[4096]; uint8_t au_lv[4096]; int au_n;
    uint64_t frame_start_ts;
    uint64_t frame_start_ts_base; /* audio timestamps relative to last drain */
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

#endif /* SPECTRUM_H */
