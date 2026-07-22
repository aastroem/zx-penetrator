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
