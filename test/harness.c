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
    if (argc >= 3 && !strcmp(argv[1], "timeline")) {
        FILE *fp = fopen(argv[2], "rb");
        if (!fp) { fprintf(stderr, "timeline: cannot open %s\n", argv[2]); return 2; }
        fseek(fp, 0, SEEK_END);
        long len = ftell(fp);
        fseek(fp, 0, SEEK_SET);
        char *buf = malloc((size_t)len + 1);
        if (!buf) { fprintf(stderr, "timeline: alloc failed\n"); fclose(fp); return 2; }
        size_t rd = fread(buf, 1, (size_t)len, fp);
        buf[rd] = '\0';
        fclose(fp);

        long total_frames = 0;
        char *p = strstr(buf, "\"frames\":");
        if (p) total_frames = strtol(p + strlen("\"frames\":"), NULL, 10);

        /* Parse events in file order: each has frame/row/bit/down keys. */
        #define MAX_EV 4096
        static long ev_frame[MAX_EV];
        static int ev_row[MAX_EV], ev_bit[MAX_EV], ev_down[MAX_EV];
        int nev = 0;
        p = strstr(buf, "\"events\":");
        if (p) {
            char *cur = p;
            for (;;) {
                char *f = strstr(cur, "\"frame\":");
                if (!f) break;
                long frame = strtol(f + strlen("\"frame\":"), NULL, 10);
                char *r = strstr(f, "\"row\":");
                if (!r) break;
                int row = (int)strtol(r + strlen("\"row\":"), NULL, 10);
                char *b = strstr(r, "\"bit\":");
                if (!b) break;
                int bit = (int)strtol(b + strlen("\"bit\":"), NULL, 10);
                char *d = strstr(b, "\"down\":");
                if (!d) break;
                char *dv = d + strlen("\"down\":");
                while (*dv == ' ') dv++;
                int down = strncmp(dv, "true", 4) == 0;
                if (nev >= MAX_EV) { fprintf(stderr, "timeline: too many events\n"); return 2; }
                ev_frame[nev] = frame; ev_row[nev] = row; ev_bit[nev] = bit; ev_down[nev] = down;
                nev++;
                cur = d + strlen("\"down\":");
            }
        }
        free(buf);

        int ei = 0;
        for (long f = 0; f < total_frames; f++) {
            while (ei < nev && ev_frame[ei] == f) {
                pen_key(ev_row[ei], ev_bit[ei], ev_down[ei]);
                ei++;
            }
            pen_run_frames(1);
            printf("%08x\n", pen_hash());
        }
        return 0;
    }
    if (argc >= 2 && !strcmp(argv[1], "statechk")) {
        // Reference: 100 frames, then hold Space and run 50 more frames
        pen_run_frames(100);
        pen_key(7, 0, 1);  // Press Space (row 7, bit 0)
        pen_run_frames(50);
        uint32_t ref_screen = pen_hash();
        // Full-memory hash to catch state divergence
        uint32_t ref_mem = 2166136261u;
        for (int i = 0x5B00; i < 0x10000; i++)
            ref_mem = (ref_mem ^ pen_peek((uint16_t)i)) * 16777619u;

        // Round-trip test: 100 frames, save, diverge 30, load, hold Space, run 50
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

        // Hold Space post-load (pen_key writes into S.keys which is part of saved state)
        pen_key(7, 0, 1);
        // Run 50 more frames (exercises restored inp/outp hooks; game polls all rows at boot)
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
