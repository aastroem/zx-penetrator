#!/usr/bin/env bash
set -euo pipefail
mkdir -p core/build
cc -O2 -Wall -Wextra -o core/build/test_z80 test/test_z80.c core/z80.c
core/build/test_z80
