#!/usr/bin/env python3
import json, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from gen_golden import Spectrum, boot, state_hash
from spectrum import KEYROWS

tl = json.load(open(os.path.join(os.path.dirname(__file__), "..", "timeline.json")))
ev = sorted(tl["events"], key=lambda e: e["frame"])
s = Spectrum(); boot(s)
i = 0
for f in range(tl["frames"]):
    while i < len(ev) and ev[i]["frame"] == f:
        name = KEYROWS[ev[i]["row"]][ev[i]["bit"]]
        (s.press if ev[i]["down"] else s.release)(name)
        i += 1
    s.frame()
    print("%08x" % state_hash(s))
