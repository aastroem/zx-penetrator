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
        // Continuous reference: 150 frames, no save/load
        pen_run_frames(150);
        uint32_t ref_screen = pen_hash();
        // Full-memory hash to catch state divergence
        uint32_t ref_mem = 2166136261u;
        for (int i = 0x5B00; i < 0x10000; i++)
            ref_mem = (ref_mem ^ pen_peek((uint16_t)i)) * 16777619u;

        // Reset and create diverging path
        pen_boot();
        pen_run_frames(100);

        // Save state before divergence
        int sz = pen_state_size();
        uint8_t *buf = malloc((size_t)sz);
        if (!buf) { fprintf(stderr, "statechk: alloc failed\n"); return 2; }
        pen_state_save(buf);

        // Diverge past the save point
        pen_run_frames(30);

        // Load state and exercise restored inp/outp hooks
        if (!pen_state_load(buf)) {
            printf("statechk: LOAD FAIL\n");
            free(buf);
            return 1;
        }

        // Run 50 more frames (exercises restored inp/outp hooks; game polls IN $FE constantly)
        pen_run_frames(50);
        uint32_t final_screen = pen_hash();
        // Full-memory hash to catch state divergence
        uint32_t final_mem = 2166136261u;
        for (int i = 0x5B00; i < 0x10000; i++)
            final_mem = (final_mem ^ pen_peek((uint16_t)i)) * 16777619u;

        free(buf);
        int match = (final_screen == ref_screen) && (final_mem == ref_mem);
        printf("statechk: %s\n", match ? "MATCH" : "MISMATCH");
        return match ? 0 : 1;
    }
    fprintf(stderr, "usage: harness boot300|frames N|runts N|statechk\n");
    return 2;
}
