#!/usr/bin/env bash
set -euo pipefail
C64R="${C64R:-$HOME/git/c64-research}"
SRC="$C64R/games/penetrator/extracted"
mkdir -p assets
cp "$SRC/06-p.cod" assets/game.bin
cp "$SRC/04-s.cod" assets/title.scr
ls -l assets
