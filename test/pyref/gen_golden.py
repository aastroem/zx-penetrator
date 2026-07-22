#!/usr/bin/env python3
"""Golden hashes from the Python reference emulator."""
import os, sys
C64R = os.environ.get("C64R", os.path.expanduser("~/git/c64-research"))
sys.path.insert(0, os.path.join(C64R, "tools"))
from spectrum import Spectrum

FNV = 2166136261
def fnv(h, data):
    for b in data:
        h = ((h ^ b) * 16777619) & 0xFFFFFFFF
    return h

def state_hash(s):
    h = fnv(FNV, bytes(s.mem[0x4000:0x5B00]))
    regs = bytes([s.a, s.f, s.b, s.c, s.d, s.e, s.h, s.l,
                  s.ix >> 8, s.ix & 255, s.iy >> 8, s.iy & 255,
                  s.sp >> 8, s.sp & 255, s.pc >> 8, s.pc & 255])
    return fnv(h, regs)

def boot(spec):
    g = os.path.join(C64R, "games/penetrator/extracted")
    spec.load_blob(os.path.join(g, "04-s.cod"), 0x4000)
    spec.load_blob(os.path.join(g, "06-p.cod"), 0x8000)
    spec.pc = 0x8000

if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    s = Spectrum()
    boot(s)
    s.run_frames(n)
    print("%08x" % state_hash(s))
