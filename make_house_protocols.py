"""The house protocols, written from one definition — as the sessions actually ran them.

Read off the runner's own trial logs (stimlog.csv) of the recorded sessions: no black blocks anywhere;
  * 8-ori 4 s:  grey 4 s, then 0→315 each 4 s with 4 s grey after it, the last grey 8 s;
  * 8-s runs:   a custom 2 s grey first, then each 8 s grating with 4 s grey after it
                (1 rep, 5 reps, or all 8 directions).
House grating: 1 Hz, 100 % contrast, 0.02 cycles/px, the runner's default (binary) waveform.

Also: the shuffled 8-ori runs (3 experiments × 4 runs; across the 4 runs of an experiment every
direction falls in the first half of the sweep exactly twice and never twice at one position) and the
2-hour single-grating exposures. The photodiode marker says only "grating", never which one — for a
shuffled run the runner's log is the only record of the order.

Retired protocols go to protocols/_archive/ (the runner lists only protocols/*.json).

    python3 make_house_protocols.py
"""
import copy
import json
import random
from pathlib import Path

OUT = Path(__file__).resolve().parent / "protocols"
DIRS = [0, 45, 90, 135, 180, 225, 270, 315]


def grey(s):
    return {"type": "grey", "orientation": None, "duration": float(s)}


def grating(d, s):
    return {"type": "moving", "orientation": float(d), "sf": 0.02, "tf": 1.0, "contrast": 1.0,
            "duration": float(s), "moving": True}


def sweep_4s(order):
    blocks = [grey(4)]
    for i, d in enumerate(order):
        blocks += [grating(d, 4), grey(8 if i == len(order) - 1 else 4)]
    return blocks


def eight_s(order):
    blocks = [grey(2)]
    for d in order:
        blocks += [grating(d, 8), grey(4)]
    return blocks


def balanced_orders(n_runs, rng, tries=200000):
    for _ in range(tries):
        orders = [rng.sample(DIRS, len(DIRS)) for _ in range(n_runs)]
        if any(len({o[p] for o in orders}) < n_runs for p in range(len(DIRS))):
            continue
        if any(sum(d in o[:4] for o in orders) != n_runs // 2 for d in DIRS):
            continue
        return orders
    raise RuntimeError("no balanced set")


def write(name, blocks, description=""):
    out = {"name": name, "blocks": blocks}
    if description:
        out["description"] = description
    (OUT / f"{name}.json").write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    return name


def main():
    made = [write("01 8ori 4s", sweep_4s(DIRS), "house sweep: grey 4 s, 0→315 × 4 s, grey 4 s between, last grey 8 s")]
    for e in (1, 2, 3):
        for r, order in enumerate(balanced_orders(4, random.Random(e)), 1):
            made.append(write(f"02 8ori 4s random E{e} r{r}", sweep_4s(order),
                              f"experiment {e}, run {r} of 4, seed {e}: {' '.join(map(str, order))} — labels from the runner log only"))
    made.append(write("03 8ori 8s", eight_s(DIRS), "grey 2 s, 0→315 × 8 s, grey 4 s after each"))
    for d in DIRS:
        made.append(write(f"10 8s 1rep {d}deg", eight_s([d]), "grey 2 s, one 8 s grating, grey 4 s"))
    for d in DIRS:
        made.append(write(f"11 8s 5rep {d}deg", eight_s([d] * 5), "grey 2 s, five 8 s gratings, grey 4 s after each"))
    for d in DIRS:
        made.append(write(f"20 2h single {d}deg", [grating(d, 7200)], "adaptation exposure: one grating, 2 h, no imaging"))
    print(f"{len(made)} protocols written")


if __name__ == "__main__":
    main()
