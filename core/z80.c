/* Z80 core -- 1:1 port of the proven Python reference at
 * ~/git/c64-research/tools/z80.py (Penetrator boots and plays correctly
 * against it). Full documented instruction set incl. CB/ED/DD/FD prefixes
 * (+DDCB/FDCB), same T-state increments as the Python. Flat 64KB memory,
 * no banking; io through the inp/outp hooks installed by the machine layer.
 */
#include "z80.h"

enum { IDX_NONE = 0, IDX_IX = 1, IDX_IY = 2 };

/* ---- register-pair accessors ------------------------------------------ */
static uint16_t bc(Z80 *cpu) { return (uint16_t)((cpu->b << 8) | cpu->c); }
static uint16_t de(Z80 *cpu) { return (uint16_t)((cpu->d << 8) | cpu->e); }
static uint16_t hl(Z80 *cpu) { return (uint16_t)((cpu->h << 8) | cpu->l); }
static uint16_t af(Z80 *cpu) { return (uint16_t)((cpu->a << 8) | cpu->f); }

static void set_bc(Z80 *cpu, uint16_t v) { cpu->b = (uint8_t)(v >> 8); cpu->c = (uint8_t)v; }
static void set_de(Z80 *cpu, uint16_t v) { cpu->d = (uint8_t)(v >> 8); cpu->e = (uint8_t)v; }
static void set_hl(Z80 *cpu, uint16_t v) { cpu->h = (uint8_t)(v >> 8); cpu->l = (uint8_t)v; }
static void set_af(Z80 *cpu, uint16_t v) { cpu->a = (uint8_t)(v >> 8); cpu->f = (uint8_t)v; }

/* rp with idx mode (0=none,1=IX,2=IY): p==2 slot substitutes IX/IY */
static uint16_t get_rp(Z80 *cpu, int p, int idx) {
    if (p == 0) return bc(cpu);
    if (p == 1) return de(cpu);
    if (p == 2) {
        if (idx == IDX_IX) return cpu->ix;
        if (idx == IDX_IY) return cpu->iy;
        return hl(cpu);
    }
    return cpu->sp;
}

static void set_rp(Z80 *cpu, int p, uint16_t v, int idx) {
    if (p == 0) { set_bc(cpu, v); return; }
    if (p == 1) { set_de(cpu, v); return; }
    if (p == 2) {
        if (idx == IDX_IX) cpu->ix = v;
        else if (idx == IDX_IY) cpu->iy = v;
        else set_hl(cpu, v);
        return;
    }
    cpu->sp = v;
}

/* ---- memory / io -------------------------------------------------------- */
static uint8_t rd(Z80 *cpu, uint16_t a) { return cpu->mem[a]; }
static void wr(Z80 *cpu, uint16_t a, uint8_t v) { cpu->mem[a] = v; }

static uint8_t do_inp(Z80 *cpu, uint16_t port) {
    return cpu->inp ? cpu->inp(cpu, port) : 0xFF;
}
static void do_outp(Z80 *cpu, uint16_t port, uint8_t v) {
    if (cpu->outp) cpu->outp(cpu, port, v);
}

static uint8_t fetch(Z80 *cpu) {
    uint8_t v = rd(cpu, cpu->pc);
    cpu->pc = (uint16_t)(cpu->pc + 1);
    return v;
}
static uint16_t fetch16(Z80 *cpu) {
    uint16_t lo = fetch(cpu);
    uint16_t hi = fetch(cpu);
    return (uint16_t)(lo | (hi << 8));
}
static uint16_t rd16(Z80 *cpu, uint16_t a) {
    return (uint16_t)(rd(cpu, a) | (rd(cpu, (uint16_t)(a + 1)) << 8));
}
static void wr16(Z80 *cpu, uint16_t a, uint16_t v) {
    wr(cpu, a, (uint8_t)v);
    wr(cpu, (uint16_t)(a + 1), (uint8_t)(v >> 8));
}
static void push(Z80 *cpu, uint16_t v) {
    cpu->sp = (uint16_t)(cpu->sp - 2);
    wr16(cpu, cpu->sp, v);
}
static uint16_t pop(Z80 *cpu) {
    uint16_t v = rd16(cpu, cpu->sp);
    cpu->sp = (uint16_t)(cpu->sp + 2);
    return v;
}

/* ---- 8-bit register access with index handling ------------------------- */
static uint8_t get_r(Z80 *cpu, int i, int idx, int dsp) {
    if (i == 6) {
        if (idx == IDX_IX) return rd(cpu, (uint16_t)(cpu->ix + dsp));
        if (idx == IDX_IY) return rd(cpu, (uint16_t)(cpu->iy + dsp));
        return rd(cpu, hl(cpu));
    }
    if (idx == IDX_IX && i == 4) return (uint8_t)(cpu->ix >> 8);
    if (idx == IDX_IX && i == 5) return (uint8_t)(cpu->ix & 0xFF);
    if (idx == IDX_IY && i == 4) return (uint8_t)(cpu->iy >> 8);
    if (idx == IDX_IY && i == 5) return (uint8_t)(cpu->iy & 0xFF);
    switch (i) {
        case 0: return cpu->b;
        case 1: return cpu->c;
        case 2: return cpu->d;
        case 3: return cpu->e;
        case 4: return cpu->h;
        case 5: return cpu->l;
        default: return cpu->a; /* i == 7 */
    }
}

static void set_r(Z80 *cpu, int i, uint8_t v, int idx, int dsp) {
    if (i == 6) {
        if (idx == IDX_IX) wr(cpu, (uint16_t)(cpu->ix + dsp), v);
        else if (idx == IDX_IY) wr(cpu, (uint16_t)(cpu->iy + dsp), v);
        else wr(cpu, hl(cpu), v);
        return;
    }
    if (idx == IDX_IX && i == 4) { cpu->ix = (uint16_t)((cpu->ix & 0xFF) | (v << 8)); return; }
    if (idx == IDX_IX && i == 5) { cpu->ix = (uint16_t)((cpu->ix & 0xFF00) | v); return; }
    if (idx == IDX_IY && i == 4) { cpu->iy = (uint16_t)((cpu->iy & 0xFF) | (v << 8)); return; }
    if (idx == IDX_IY && i == 5) { cpu->iy = (uint16_t)((cpu->iy & 0xFF00) | v); return; }
    switch (i) {
        case 0: cpu->b = v; break;
        case 1: cpu->c = v; break;
        case 2: cpu->d = v; break;
        case 3: cpu->e = v; break;
        case 4: cpu->h = v; break;
        case 5: cpu->l = v; break;
        default: cpu->a = v; break; /* i == 7 */
    }
}

/* ---- flag helpers -------------------------------------------------------- */
static uint8_t parity_flag(uint8_t v) {
    v ^= (uint8_t)(v >> 4);
    v ^= (uint8_t)(v >> 2);
    v ^= (uint8_t)(v >> 1);
    return (v & 1) ? 0 : FPV;
}

static uint8_t szp(Z80 *cpu, uint8_t v) {
    (void)cpu;
    return (uint8_t)((v & FS) | (v == 0 ? FZ : 0) | parity_flag(v) | (v & (F3 | F5)));
}

static uint8_t add8(Z80 *z, uint8_t x, uint8_t y, int cin) {
    int r = x + y + cin; uint8_t res = (uint8_t)r;
    z->f = (uint8_t)((res & (FS|F3|F5)) | (res == 0 ? FZ : 0)
         | (((x ^ y ^ r) & 0x10) ? FH : 0)
         | ((((~(x ^ y)) & (x ^ r)) & 0x80) ? FPV : 0)
         | (r > 0xFF ? FC : 0));
    return res;
}

static uint8_t sub8(Z80 *z, uint8_t x, uint8_t y, int cin) {
    int r = x - y - cin; uint8_t res = (uint8_t)r;
    z->f = (uint8_t)((res & (FS|F3|F5)) | (res == 0 ? FZ : 0)
         | (((x ^ y ^ r) & 0x10) ? FH : 0)
         | ((((x ^ y) & (x ^ r)) & 0x80) ? FPV : 0)
         | FN | (r < 0 ? FC : 0));
    return res;
}

static uint8_t inc8(Z80 *cpu, uint8_t x) {
    uint8_t res = (uint8_t)(x + 1);
    cpu->f = (uint8_t)((cpu->f & FC) | (res & FS) | (res == 0 ? FZ : 0)
         | (res & (F3|F5))
         | ((x & 0x0F) == 0x0F ? FH : 0)
         | (x == 0x7F ? FPV : 0));
    return res;
}

static uint8_t dec8(Z80 *cpu, uint8_t x) {
    uint8_t res = (uint8_t)(x - 1);
    cpu->f = (uint8_t)((cpu->f & FC) | (res & FS) | (res == 0 ? FZ : 0)
         | (res & (F3|F5)) | FN
         | ((x & 0x0F) == 0 ? FH : 0)
         | (x == 0x80 ? FPV : 0));
    return res;
}

static uint16_t add16(Z80 *cpu, uint16_t x, uint16_t y) {
    int r = x + y;
    cpu->f = (uint8_t)((cpu->f & (FS|FZ|FPV))
         | (((x ^ y ^ r) >> 8) & FH)
         | (r > 0xFFFF ? FC : 0)
         | ((r >> 8) & (F3|F5)));
    return (uint16_t)r;
}

static uint16_t adc16(Z80 *cpu, uint16_t x, uint16_t y) {
    int c = cpu->f & FC;
    int r = x + y + c;
    uint16_t res = (uint16_t)r;
    cpu->f = (uint8_t)(((res >> 8) & FS) | (res == 0 ? FZ : 0)
         | ((res >> 8) & (F3|F5))
         | (((x ^ y ^ r) >> 8) & FH)
         | ((((~(x ^ y)) & (x ^ r)) & 0x8000) ? FPV : 0)
         | (r > 0xFFFF ? FC : 0));
    return res;
}

static uint16_t sbc16(Z80 *cpu, uint16_t x, uint16_t y) {
    int c = cpu->f & FC;
    int r = x - y - c;
    uint16_t res = (uint16_t)r;
    cpu->f = (uint8_t)(((res >> 8) & FS) | (res == 0 ? FZ : 0)
         | ((res >> 8) & (F3|F5))
         | (((x ^ y ^ r) >> 8) & FH)
         | (((x ^ y) & (x ^ r)) & 0x8000 ? FPV : 0)
         | FN | (r < 0 ? FC : 0));
    return res;
}

static void alu(Z80 *cpu, int op, uint8_t v) {
    switch (op) {
        case 0: cpu->a = add8(cpu, cpu->a, v, 0); break;
        case 1: cpu->a = add8(cpu, cpu->a, v, cpu->f & FC); break;
        case 2: cpu->a = sub8(cpu, cpu->a, v, 0); break;
        case 3: cpu->a = sub8(cpu, cpu->a, v, cpu->f & FC); break;
        case 4: cpu->a &= v; cpu->f = (uint8_t)(szp(cpu, cpu->a) | FH); break;
        case 5: cpu->a ^= v; cpu->f = szp(cpu, cpu->a); break;
        case 6: cpu->a |= v; cpu->f = szp(cpu, cpu->a); break;
        default: sub8(cpu, cpu->a, v, 0); break; /* CP: flags only */
    }
}

static int cc(Z80 *cpu, int y) {
    uint8_t f = cpu->f;
    switch (y) {
        case 0: return !(f & FZ);
        case 1: return (f & FZ) != 0;
        case 2: return !(f & FC);
        case 3: return (f & FC) != 0;
        case 4: return !(f & FPV);
        case 5: return (f & FPV) != 0;
        case 6: return !(f & FS);
        default: return (f & FS) != 0; /* y == 7 */
    }
}

static uint8_t rot(Z80 *cpu, int op, uint8_t v) {
    int c = cpu->f & FC;
    uint8_t res; int nc;
    switch (op) {
        case 0: res = (uint8_t)((v << 1) | (v >> 7)); nc = v >> 7; break;          /* RLC */
        case 1: res = (uint8_t)((v >> 1) | (v << 7)); nc = v & 1; break;           /* RRC */
        case 2: res = (uint8_t)((v << 1) | c); nc = v >> 7; break;                 /* RL */
        case 3: res = (uint8_t)((v >> 1) | (c << 7)); nc = v & 1; break;           /* RR */
        case 4: res = (uint8_t)(v << 1); nc = v >> 7; break;                      /* SLA */
        case 5: res = (uint8_t)((v >> 1) | (v & 0x80)); nc = v & 1; break;        /* SRA */
        case 6: res = (uint8_t)((v << 1) | 1); nc = v >> 7; break;                /* SLL */
        default: res = (uint8_t)(v >> 1); nc = v & 1; break;                      /* SRL */
    }
    cpu->f = (uint8_t)(szp(cpu, res) | (nc ? FC : 0));
    return res;
}

/* ---- base (unprefixed / DD / FD) opcode table --------------------------- */
static void base_op(Z80 *cpu, uint8_t op, int idx) {
    int x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    int p = y >> 1, q = y & 1;
    int idxreg_present = (idx != IDX_NONE);
    uint16_t idxreg = (idx == IDX_IX) ? cpu->ix : (idx == IDX_IY ? cpu->iy : 0);
    int dsp = 0;
    int uses_hl6 = ((x == 0 && (z == 4 || z == 5 || z == 6) && y == 6) ||
                    (x == 1 && (y == 6 || z == 6) && !(y == 6 && z == 6)) ||
                    (x == 2 && z == 6));
    if (idx && uses_hl6) {
        int d = fetch(cpu);
        dsp = d >= 128 ? d - 256 : d;
        cpu->ts += 8;
    }

    if (x == 0) {
        if (z == 0) {
            if (y == 0) { cpu->ts += 4; }                                     /* NOP */
            else if (y == 1) {                                               /* EX AF,AF' */
                uint8_t t;
                t = cpu->a; cpu->a = cpu->a2; cpu->a2 = t;
                t = cpu->f; cpu->f = cpu->f2; cpu->f2 = t;
                cpu->ts += 4;
            } else if (y == 2) {                                             /* DJNZ */
                int d = fetch(cpu);
                cpu->b = (uint8_t)(cpu->b - 1);
                if (cpu->b) {
                    cpu->pc = (uint16_t)(cpu->pc + (d >= 128 ? d - 256 : d));
                    cpu->ts += 13;
                } else {
                    cpu->ts += 8;
                }
            } else if (y == 3) {                                             /* JR */
                int d = fetch(cpu);
                cpu->pc = (uint16_t)(cpu->pc + (d >= 128 ? d - 256 : d));
                cpu->ts += 12;
            } else {                                                          /* JR cc */
                int d = fetch(cpu);
                if (cc(cpu, y - 4)) {
                    cpu->pc = (uint16_t)(cpu->pc + (d >= 128 ? d - 256 : d));
                    cpu->ts += 12;
                } else {
                    cpu->ts += 7;
                }
            }
        } else if (z == 1) {
            if (q == 0) {                                                     /* LD rp,nn */
                set_rp(cpu, p, fetch16(cpu), idx);
                cpu->ts += 10;
            } else {                                                          /* ADD HL,rp */
                uint16_t v = add16(cpu, idxreg_present ? idxreg : hl(cpu), get_rp(cpu, p, idx));
                if (idx == IDX_IX) cpu->ix = v;
                else if (idx == IDX_IY) cpu->iy = v;
                else set_hl(cpu, v);
                cpu->ts += 11;
            }
        } else if (z == 2) {
            uint16_t hlv = idxreg_present ? idxreg : hl(cpu);
            if (q == 0) {
                if (p == 0) { wr(cpu, bc(cpu), cpu->a); cpu->ts += 7; }
                else if (p == 1) { wr(cpu, de(cpu), cpu->a); cpu->ts += 7; }
                else if (p == 2) { wr16(cpu, fetch16(cpu), hlv); cpu->ts += 16; }
                else { wr(cpu, fetch16(cpu), cpu->a); cpu->ts += 13; }
            } else {
                if (p == 0) { cpu->a = rd(cpu, bc(cpu)); cpu->ts += 7; }
                else if (p == 1) { cpu->a = rd(cpu, de(cpu)); cpu->ts += 7; }
                else if (p == 2) {
                    uint16_t v = rd16(cpu, fetch16(cpu));
                    set_rp(cpu, 2, v, idx);
                    cpu->ts += 16;
                } else { cpu->a = rd(cpu, fetch16(cpu)); cpu->ts += 13; }
            }
        } else if (z == 3) {                                                  /* INC/DEC rp */
            uint16_t v = get_rp(cpu, p, idx);
            v = (uint16_t)(q == 0 ? v + 1 : v - 1);
            set_rp(cpu, p, v, idx);
            cpu->ts += 6;
        } else if (z == 4) {                                                  /* INC r */
            set_r(cpu, y, inc8(cpu, get_r(cpu, y, idx, dsp)), idx, dsp);
            cpu->ts += (idx && y == 6) ? 11 : 4;
        } else if (z == 5) {                                                  /* DEC r */
            set_r(cpu, y, dec8(cpu, get_r(cpu, y, idx, dsp)), idx, dsp);
            cpu->ts += (idx && y == 6) ? 11 : 4;
        } else if (z == 6) {                                                  /* LD r,n */
            set_r(cpu, y, fetch(cpu), idx, dsp);
            cpu->ts += (y == 6) ? 10 : 7;
        } else {
            uint8_t a = cpu->a, f = cpu->f;
            switch (y) {
                case 0:                                                       /* RLCA */
                    cpu->a = (uint8_t)((a << 1) | (a >> 7));
                    cpu->f = (uint8_t)((f & (FS|FZ|FPV)) | (a >> 7) | (cpu->a & (F3|F5)));
                    break;
                case 1:                                                       /* RRCA */
                    cpu->a = (uint8_t)((a >> 1) | (a << 7));
                    cpu->f = (uint8_t)((f & (FS|FZ|FPV)) | (a & 1) | (cpu->a & (F3|F5)));
                    break;
                case 2:                                                       /* RLA */
                    cpu->a = (uint8_t)((a << 1) | (f & FC));
                    cpu->f = (uint8_t)((f & (FS|FZ|FPV)) | (a >> 7) | (cpu->a & (F3|F5)));
                    break;
                case 3:                                                       /* RRA */
                    cpu->a = (uint8_t)((a >> 1) | ((f & FC) << 7));
                    cpu->f = (uint8_t)((f & (FS|FZ|FPV)) | (a & 1) | (cpu->a & (F3|F5)));
                    break;
                case 4: {                                                     /* DAA */
                    uint8_t a0 = cpu->a, t = 0, c = cpu->f & FC;
                    if ((cpu->f & FH) || (a0 & 0x0F) > 9) t |= 0x06;
                    if (c || a0 > 0x99) { t |= 0x60; c = FC; }
                    cpu->a = (cpu->f & FN) ? (uint8_t)(a0 - t) : (uint8_t)(a0 + t);
                    cpu->f = (uint8_t)(szp(cpu, cpu->a) | c | (cpu->f & FN) | (((a0 ^ cpu->a) & 0x10) ? FH : 0));
                    break;
                }
                case 5:                                                       /* CPL */
                    cpu->a = (uint8_t)(a ^ 0xFF);
                    cpu->f = (uint8_t)(f | FH | FN);
                    break;
                case 6:                                                       /* SCF */
                    cpu->f = (uint8_t)((f & (FS|FZ|FPV)) | FC);
                    break;
                default:                                                      /* CCF */
                    cpu->f = (uint8_t)((f & (FS|FZ|FPV)) | ((f & FC) ? FH : 0) | ((f & FC) ^ FC));
                    break;
            }
            cpu->ts += 4;
        }
    } else if (x == 1) {
        if (y == 6 && z == 6) {                                               /* HALT */
            cpu->halted = 1;
            cpu->ts += 4;
            return;
        }
        if (idx && (y == 6 || z == 6)) {
            if (y == 6) {
                uint8_t v = get_r(cpu, z, IDX_NONE, 0);
                set_r(cpu, 6, v, idx, dsp);
            } else {
                set_r(cpu, y, get_r(cpu, 6, idx, dsp), IDX_NONE, 0);
            }
            cpu->ts += 11;
        } else {
            set_r(cpu, y, get_r(cpu, z, idx, dsp), idx, dsp);
            cpu->ts += (y == 6 || z == 6) ? 7 : 4;
        }
    } else if (x == 2) {                                                      /* ALU r */
        alu(cpu, y, get_r(cpu, z, idx, dsp));
        cpu->ts += (z == 6) ? 7 : 4;
    } else {
        if (z == 0) {                                                         /* RET cc */
            if (cc(cpu, y)) { cpu->pc = pop(cpu); cpu->ts += 11; }
            else { cpu->ts += 5; }
        } else if (z == 1) {
            if (q == 0) {                                                     /* POP */
                uint16_t v = pop(cpu);
                if (p == 3) set_af(cpu, v);
                else set_rp(cpu, p, v, idx);
                cpu->ts += 10;
            } else {
                if (p == 0) { cpu->pc = pop(cpu); cpu->ts += 10; }             /* RET */
                else if (p == 1) {                                            /* EXX */
                    uint8_t t;
                    t = cpu->b; cpu->b = cpu->b2; cpu->b2 = t;
                    t = cpu->c; cpu->c = cpu->c2; cpu->c2 = t;
                    t = cpu->d; cpu->d = cpu->d2; cpu->d2 = t;
                    t = cpu->e; cpu->e = cpu->e2; cpu->e2 = t;
                    t = cpu->h; cpu->h = cpu->h2; cpu->h2 = t;
                    t = cpu->l; cpu->l = cpu->l2; cpu->l2 = t;
                    cpu->ts += 4;
                } else if (p == 2) {                                          /* JP (HL) */
                    cpu->pc = idxreg_present ? idxreg : hl(cpu);
                    cpu->ts += 4;
                } else {                                                       /* LD SP,HL */
                    cpu->sp = idxreg_present ? idxreg : hl(cpu);
                    cpu->ts += 6;
                }
            }
        } else if (z == 2) {                                                  /* JP cc,nn */
            uint16_t nn = fetch16(cpu);
            if (cc(cpu, y)) cpu->pc = nn;
            cpu->ts += 10;
        } else if (z == 3) {
            if (y == 0) { cpu->pc = fetch16(cpu); cpu->ts += 10; }             /* JP nn */
            else if (y == 2) {                                                /* OUT (n),A */
                uint8_t n = fetch(cpu);
                do_outp(cpu, (uint16_t)((cpu->a << 8) | n), cpu->a);
                cpu->ts += 11;
            } else if (y == 3) {                                              /* IN A,(n) */
                uint8_t n = fetch(cpu);
                cpu->a = do_inp(cpu, (uint16_t)((cpu->a << 8) | n));
                cpu->ts += 11;
            } else if (y == 4) {                                              /* EX (SP),HL */
                uint16_t v = rd16(cpu, cpu->sp);
                if (idx == IDX_IX) { wr16(cpu, cpu->sp, cpu->ix); cpu->ix = v; }
                else if (idx == IDX_IY) { wr16(cpu, cpu->sp, cpu->iy); cpu->iy = v; }
                else { wr16(cpu, cpu->sp, hl(cpu)); set_hl(cpu, v); }
                cpu->ts += 19;
            } else if (y == 5) {                                              /* EX DE,HL */
                uint8_t d = cpu->d, e = cpu->e;
                cpu->d = cpu->h; cpu->e = cpu->l;
                cpu->h = d; cpu->l = e;
                cpu->ts += 4;
            } else if (y == 6) {                                              /* DI */
                cpu->iff1 = cpu->iff2 = 0;
                cpu->ts += 4;
            } else {                                                          /* EI */
                cpu->iff1 = cpu->iff2 = 1;
                cpu->ts += 4;
            }
        } else if (z == 4) {                                                  /* CALL cc,nn */
            uint16_t nn = fetch16(cpu);
            if (cc(cpu, y)) { push(cpu, cpu->pc); cpu->pc = nn; cpu->ts += 17; }
            else { cpu->ts += 10; }
        } else if (z == 5) {
            if (q == 0) {                                                     /* PUSH */
                if (p == 3) push(cpu, af(cpu));
                else push(cpu, get_rp(cpu, p, idx));
                cpu->ts += 11;
            } else {                                                          /* CALL nn */
                uint16_t nn = fetch16(cpu);
                push(cpu, cpu->pc);
                cpu->pc = nn;
                cpu->ts += 17;
            }
        } else if (z == 6) {                                                  /* ALU n */
            alu(cpu, y, fetch(cpu));
            cpu->ts += 7;
        } else {                                                              /* RST */
            push(cpu, cpu->pc);
            cpu->pc = (uint16_t)(y * 8);
            cpu->ts += 11;
        }
    }
}

/* ---- CB / DDCB / FDCB ---------------------------------------------------- */
static void cb_op(Z80 *cpu, int idx) {
    int dsp = 0;
    if (idx) {
        int d = fetch(cpu);
        dsp = d >= 128 ? d - 256 : d;
    }
    uint8_t op = fetch(cpu);
    int x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    int src = idx ? 6 : z;                 /* DDCB/FDCB always operate on (IX/IY+d) */
    uint8_t v = get_r(cpu, src, idx, dsp);
    uint8_t res;
    if (x == 0) {
        res = rot(cpu, y, v);
    } else if (x == 1) {                                                     /* BIT */
        uint8_t bit = (uint8_t)(v & (1 << y));
        cpu->f = (uint8_t)((cpu->f & FC) | FH | (!bit ? FZ : 0)
             | (!bit ? FPV : 0)
             | ((y == 7 && bit) ? FS : 0));
        cpu->ts += (src == 6) ? 12 : 8;
        return;
    } else if (x == 2) {
        res = (uint8_t)(v & ~(1 << y));
    } else {
        res = (uint8_t)(v | (1 << y));
    }
    set_r(cpu, src, res, idx, dsp);
    if (idx && z != 6) {                                                     /* undocumented copy */
        set_r(cpu, z, res, IDX_NONE, 0);
    }
    cpu->ts += (src == 6) ? 15 : 8;
}

/* ---- ED prefix ------------------------------------------------------------ */
static void ed_op(Z80 *cpu) {
    uint8_t op = fetch(cpu);
    int x = op >> 6, y = (op >> 3) & 7, z = op & 7;
    int p = y >> 1, q = y & 1;
    if (x == 1) {
        if (z == 0) {                                                        /* IN r,(C) */
            uint8_t v = do_inp(cpu, bc(cpu));
            if (y != 6) set_r(cpu, y, v, IDX_NONE, 0);
            cpu->f = (uint8_t)((cpu->f & FC) | szp(cpu, v));
            cpu->ts += 12;
        } else if (z == 1) {                                                 /* OUT (C),r */
            do_outp(cpu, bc(cpu), y == 6 ? 0 : get_r(cpu, y, IDX_NONE, 0));
            cpu->ts += 12;
        } else if (z == 2) {
            if (q == 0) set_hl(cpu, sbc16(cpu, hl(cpu), get_rp(cpu, p, IDX_NONE)));
            else set_hl(cpu, adc16(cpu, hl(cpu), get_rp(cpu, p, IDX_NONE)));
            cpu->ts += 15;
        } else if (z == 3) {
            uint16_t nn = fetch16(cpu);
            if (q == 0) wr16(cpu, nn, get_rp(cpu, p, IDX_NONE));
            else set_rp(cpu, p, rd16(cpu, nn), IDX_NONE);
            cpu->ts += 20;
        } else if (z == 4) {                                                 /* NEG */
            cpu->a = sub8(cpu, 0, cpu->a, 0);
            cpu->ts += 8;
        } else if (z == 5) {                                                 /* RETN/RETI */
            cpu->iff1 = cpu->iff2;
            cpu->pc = pop(cpu);
            cpu->ts += 14;
        } else if (z == 6) {                                                 /* IM */
            static const uint8_t imtab[4] = {0, 0, 1, 2};
            cpu->im = imtab[y & 3];
            cpu->ts += 8;
        } else {
            if (y == 0) cpu->i = cpu->a;
            else if (y == 1) cpu->r = cpu->a;
            else if (y == 2) {                                               /* LD A,I */
                cpu->a = cpu->i;
                cpu->f = (uint8_t)((cpu->f & FC) | (szp(cpu, cpu->a) & ~FPV) | (cpu->iff2 ? FPV : 0));
            } else if (y == 3) {                                             /* LD A,R */
                cpu->a = cpu->r;
                cpu->f = (uint8_t)((cpu->f & FC) | (szp(cpu, cpu->a) & ~FPV) | (cpu->iff2 ? FPV : 0));
            } else if (y == 4) {                                             /* RRD */
                uint8_t m = rd(cpu, hl(cpu));
                wr(cpu, hl(cpu), (uint8_t)((cpu->a << 4) | (m >> 4)));
                cpu->a = (uint8_t)((cpu->a & 0xF0) | (m & 0x0F));
                cpu->f = (uint8_t)((cpu->f & FC) | szp(cpu, cpu->a));
            } else if (y == 5) {                                             /* RLD */
                uint8_t m = rd(cpu, hl(cpu));
                wr(cpu, hl(cpu), (uint8_t)((m << 4) | (cpu->a & 0x0F)));
                cpu->a = (uint8_t)((cpu->a & 0xF0) | (m >> 4));
                cpu->f = (uint8_t)((cpu->f & FC) | szp(cpu, cpu->a));
            }
            cpu->ts += 9;
        }
    } else if (x == 2 && z <= 3 && y >= 4) {
        int rep = y >= 6;
        int delta = (y == 4 || y == 6) ? 1 : -1;
        if (z == 0) {                                                        /* LDI/LDD(R) */
            uint8_t v = rd(cpu, hl(cpu));
            wr(cpu, de(cpu), v);
            set_hl(cpu, (uint16_t)(hl(cpu) + delta));
            set_de(cpu, (uint16_t)(de(cpu) + delta));
            uint16_t bcv = (uint16_t)(bc(cpu) - 1);
            set_bc(cpu, bcv);
            cpu->f = (uint8_t)((cpu->f & (FC|FZ|FS)) | (bcv ? FPV : 0));
            if (rep && bcv) { cpu->pc = (uint16_t)(cpu->pc - 2); cpu->ts += 21; }
            else cpu->ts += 16;
        } else if (z == 1) {                                                 /* CPI/CPD(R) */
            uint8_t v = rd(cpu, hl(cpu));
            uint8_t c = cpu->f & FC;
            sub8(cpu, cpu->a, v, 0);
            cpu->f = (uint8_t)((cpu->f & ~(FC|FPV)) | c);
            set_hl(cpu, (uint16_t)(hl(cpu) + delta));
            uint16_t bcv = (uint16_t)(bc(cpu) - 1);
            set_bc(cpu, bcv);
            cpu->f = (uint8_t)(cpu->f | (bcv ? FPV : 0));
            if (rep && bcv && !(cpu->f & FZ)) { cpu->pc = (uint16_t)(cpu->pc - 2); cpu->ts += 21; }
            else cpu->ts += 16;
        } else if (z == 2) {                                                 /* INI/IND(R) */
            wr(cpu, hl(cpu), do_inp(cpu, bc(cpu)));
            set_hl(cpu, (uint16_t)(hl(cpu) + delta));
            cpu->b = (uint8_t)(cpu->b - 1);
            cpu->f = (uint8_t)((cpu->b == 0 ? FZ : 0) | FN);
            if (rep && cpu->b) { cpu->pc = (uint16_t)(cpu->pc - 2); cpu->ts += 21; }
            else cpu->ts += 16;
        } else {                                                             /* OUTI/OTD(R) */
            uint8_t v = rd(cpu, hl(cpu));
            cpu->b = (uint8_t)(cpu->b - 1);
            do_outp(cpu, bc(cpu), v);
            set_hl(cpu, (uint16_t)(hl(cpu) + delta));
            cpu->f = (uint8_t)((cpu->b == 0 ? FZ : 0) | FN);
            if (rep && cpu->b) { cpu->pc = (uint16_t)(cpu->pc - 2); cpu->ts += 21; }
            else cpu->ts += 16;
        }
    } else {
        cpu->ts += 8;                                                        /* ED NOP* */
    }
}

/* ---- public API ----------------------------------------------------------- */
void z80_reset(Z80 *cpu) {
    cpu->a = cpu->f = 0;
    cpu->b = cpu->c = cpu->d = cpu->e = cpu->h = cpu->l = 0;
    cpu->a2 = cpu->f2 = cpu->b2 = cpu->c2 = cpu->d2 = cpu->e2 = cpu->h2 = cpu->l2 = 0;
    cpu->ix = cpu->iy = 0;
    cpu->sp = 0xFFFF;
    cpu->pc = 0;
    cpu->i = cpu->r = 0;
    cpu->iff1 = cpu->iff2 = 0;
    cpu->im = 0;
    cpu->halted = 0;
    cpu->ts = 0;
}

int z80_step(Z80 *cpu) {
    uint64_t t0 = cpu->ts;
    cpu->r = (uint8_t)((cpu->r + 1) & 0x7F);
    if (cpu->halted) {
        cpu->ts += 4;
        return 4;
    }
    int idx = IDX_NONE;
    uint8_t op = fetch(cpu);
    while (op == 0xDD || op == 0xFD) {
        idx = (op == 0xDD) ? IDX_IX : IDX_IY;
        op = fetch(cpu);
        cpu->ts += 4;
    }
    if (op == 0xCB) {
        cb_op(cpu, idx);
    } else if (op == 0xED) {
        ed_op(cpu);
    } else {
        base_op(cpu, op, idx);
    }
    return (int)(cpu->ts - t0);
}

int z80_interrupt(Z80 *cpu) {
    if (!cpu->iff1) return 0;
    cpu->iff1 = cpu->iff2 = 0;
    if (cpu->halted) cpu->halted = 0;
    push(cpu, cpu->pc);
    if (cpu->im == 2) {
        uint16_t vec = (uint16_t)((cpu->i << 8) | 0xFF);
        cpu->pc = rd16(cpu, vec);
        cpu->ts += 19;
    } else {
        cpu->pc = 0x0038;
        cpu->ts += 13;
    }
    return 1;
}
