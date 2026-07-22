#!/usr/bin/env bash
set -euo pipefail
mkdir -p core/build
cc -O2 -Wall -Wextra -o core/build/test_z80 test/test_z80.c core/z80.c
core/build/test_z80

cc -O2 -Wall -Wextra -o core/build/harness \
   test/harness.c core/spectrum.c core/penetrator.c core/z80.c
if [ "$(core/build/harness boot300)" = "$(cat test/golden/boot300.hash)" ];
then echo "boot300 hash: MATCH"; else echo "boot300 hash: MISMATCH"; exit 1; fi
