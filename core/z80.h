#ifndef Z80_H
#define Z80_H

#include <stdint.h>

#define FC  0x01
#define FN  0x02
#define FPV 0x04
#define F3  0x08
#define FH  0x10
#define F5  0x20
#define FZ  0x40
#define FS  0x80

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

#endif /* Z80_H */
