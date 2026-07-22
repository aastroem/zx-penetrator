#!/usr/bin/env bash
set -euo pipefail
bash scripts/build-native.sh
mkdir -p test/out
core/build/harness timeline test/timeline.json > test/out/timeline.hashes
if diff -q test/out/timeline.hashes test/golden/timeline.hashes; then
  echo "cross-validation: 6000 frames MATCH"
else
  diff test/out/timeline.hashes test/golden/timeline.hashes | head -3
  echo "first divergent frame above"; exit 1
fi

if command -v emcc >/dev/null 2>&1; then
  npm run build:core
  node test/wasm-smoke.mjs
else
  echo "emcc not found; skipping wasm smoke test"
fi

node test/shell-smoke.mjs
node test/audio-smoke.mjs
node test/state-smoke.mjs
