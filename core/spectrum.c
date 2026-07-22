#include <string.h>
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
    s->frame_start_ts = s->cpu.ts;
    while (s->cpu.ts < end) {
        if (s->cpu.pc == 0x0556) s->trap = 1;
        if (s->cpu.pc == 0x04C2) s->trap = 2;
        z80_step(&s->cpu);
    }
    z80_interrupt(&s->cpu);
    s->frame++;
}
