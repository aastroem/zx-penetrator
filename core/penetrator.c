#include <string.h>
#include "spectrum.h"
#include "game_data.h"

#define USED __attribute__((used))
#define TS_FRAME 69888

static Spectrum S;

USED void pen_boot(void) {
    spec_init(&S);
    memcpy(S.cpu.mem + 0x4000, title_scr, sizeof title_scr);
    memcpy(S.cpu.mem + 0x8000, game_bin, sizeof game_bin);
    S.cpu.pc = 0x8000;
}

USED void pen_run_frames(int n) {
    for (int i = 0; i < n; i++) {
        spec_run_frame(&S);
    }
}

/* Run whole frames until at least `tstates` T-states have been consumed.
 * Each frame is run by spec_run_frame itself (natural, possibly-overshooting
 * end computed from the current ts, same per-instruction trap checks, same
 * end-of-frame interrupt) — the caller's budget only decides whether
 * another frame gets started. This makes pen_run(n * 69888) and n calls
 * worth of pen_run_frames produce byte-identical execution traces. */
USED uint32_t pen_run(uint32_t tstates) {
    uint64_t start = S.cpu.ts;
    uint64_t budget_end = start + tstates;
    while (S.cpu.ts < budget_end) {
        spec_run_frame(&S);
    }
    return (uint32_t)(S.cpu.ts - start);
}

USED void pen_key(int row, int bit, int down) {
    spec_key(&S, row, bit, down);
}

USED uint8_t *pen_screen(void) {
    return S.cpu.mem + 0x4000;
}

USED int pen_border(void) {
    return S.border;
}

USED int pen_audio(uint32_t **ts, uint8_t **lv) {
    *ts = S.au_ts;
    *lv = S.au_lv;
    int n = S.au_n;
    S.au_n = 0;
    S.frame_start_ts_base = S.cpu.ts;
    return n;
}

USED int pen_trap(void) {
    int t = S.trap;
    S.trap = 0;
    return t;
}

USED uint8_t pen_peek(uint16_t a) {
    return S.cpu.mem[a];
}

USED void pen_poke(uint16_t a, uint8_t v) {
    S.cpu.mem[a] = v;
}

USED uint32_t pen_frame(void) {
    return S.frame;
}

USED uint32_t pen_hash(void) {
    uint32_t h = 2166136261u;
    for (int i = 0; i < 6912; i++)
        h = (h ^ S.cpu.mem[0x4000 + i]) * 16777619u;
    uint8_t regs[16] = {
        S.cpu.a, S.cpu.f, S.cpu.b, S.cpu.c, S.cpu.d, S.cpu.e, S.cpu.h, S.cpu.l,
        (uint8_t)(S.cpu.ix >> 8), (uint8_t)(S.cpu.ix & 0xFF),
        (uint8_t)(S.cpu.iy >> 8), (uint8_t)(S.cpu.iy & 0xFF),
        (uint8_t)(S.cpu.sp >> 8), (uint8_t)(S.cpu.sp & 0xFF),
        (uint8_t)(S.cpu.pc >> 8), (uint8_t)(S.cpu.pc & 0xFF),
    };
    for (int i = 0; i < 16; i++)
        h = (h ^ regs[i]) * 16777619u;
    return h;
}

typedef struct {
    uint32_t version;
    Spectrum s;
} PenState;

#define PEN_STATE_VERSION 1u

USED int pen_state_size(void) {
    return (int)sizeof(PenState);
}

USED void pen_state_save(uint8_t *out) {
    PenState ps;
    ps.version = PEN_STATE_VERSION;
    ps.s = S;
    memcpy(out, &ps, sizeof ps);
}

USED int pen_state_load(uint8_t *in) {
    PenState ps;
    memcpy(&ps, in, sizeof ps);
    if (ps.version != PEN_STATE_VERSION) return 0;
    S = ps.s;
    spec_repatch_io(&S);
    return 1;
}
