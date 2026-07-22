#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../core/spectrum.h"
/* modes: boot300 | frames N | runts N | statechk | timeline file.json (Task 4) */
int main(int argc, char **argv) {
    pen_boot();
    if (argc >= 2 && !strcmp(argv[1], "boot300")) {
        pen_run_frames(300);
        printf("%08x\n", pen_hash());
        return 0;
    }
    if (argc >= 3 && !strcmp(argv[1], "frames")) {
        pen_run_frames(atoi(argv[2]));
        printf("%08x\n", pen_hash());
        return 0;
    }
    if (argc >= 3 && !strcmp(argv[1], "runts")) {
        long n = atol(argv[2]);
        pen_run((uint32_t)(n * 69888));
        printf("%08x\n", pen_hash());
        return 0;
    }
    if (argc >= 2 && !strcmp(argv[1], "statechk")) {
        pen_run_frames(100);
        uint32_t h1 = pen_hash();
        int sz = pen_state_size();
        uint8_t *buf = malloc((size_t)sz);
        if (!buf) { fprintf(stderr, "statechk: alloc failed\n"); return 2; }
        pen_state_save(buf);
        pen_run_frames(50);
        int ok = pen_state_load(buf);
        uint32_t h2 = pen_hash();
        free(buf);
        if (!ok) { printf("statechk: MISMATCH (load returned 0)\n"); return 0; }
        printf("statechk: %s\n", h1 == h2 ? "MATCH" : "MISMATCH");
        return 0;
    }
    fprintf(stderr, "usage: harness boot300|frames N|runts N|statechk\n");
    return 2;
}
