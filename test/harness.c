#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../core/spectrum.h"
/* modes: boot300 | frames N | timeline file.json (Task 4) */
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
    fprintf(stderr, "usage: harness boot300\n");
    return 2;
}
