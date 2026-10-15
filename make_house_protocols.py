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


def grating(d, s, tf=1.0):
    return {"type": "moving", "orientation": float(d), "sf": 0.02, "tf": float(tf), "contrast": 1.0,
            "duration": float(s), "moving": True}


def sweep_4s(order, tf=1.0):
    """``order``: directions (all at ``tf``), or (direction, tf) pairs for a mixed run."""
    blocks = [grey(4)]
    for i, d in enumerate(order):
        dd, t = d if isinstance(d, tuple) else (d, tf)
        blocks += [grating(dd, 4, t), grey(8 if i == len(order) - 1 else 4)]
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


def balanced_mixed(rng, tfs=(1.0, 3.0)):
    """Four runs of every direction at both TFs, shuffled and balanced by construction: for runs 1-2
    the directions are split at random into halves A and B, run 1 opens with A at the first TF and B
    at the second and run 2 the other way round; runs 3-4 do the same with a fresh split. So within a
    run each TF has four gratings in the first half of the sweep, and across the four runs every
    (direction, TF) is in the first half exactly twice: position in the sweep (adaptation, bleaching,
    state) weighs on both TFs alike."""
    t1, t2 = tfs
    runs = []
    for _ in range(2):
        a = rng.sample(DIRS, len(DIRS))
        A, B = a[:4], a[4:]
        for first, second in ((A, B), (B, A)):
            head = [(d, t1) for d in first] + [(d, t2) for d in second]
            tail = [(d, t2) for d in first] + [(d, t1) for d in second]
            runs.append(rng.sample(head, len(head)) + rng.sample(tail, len(tail)))
    pairs = [(d, t) for t in tfs for d in DIRS]
    assert all(sorted(r) == sorted(pairs) for r in runs)
    assert all(sum(pr in r[:8] for r in runs) == 2 for pr in pairs)
    assert all(sum(p[1] == t for p in r[:8]) == 4 for r in runs for t in tfs)
    return runs


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
    # 3 Hz: RL (where most of our boutons come from) prefers higher temporal frequencies than V1.
    made.append(write("05 8ori 4s 3Hz", sweep_4s(DIRS, tf=3.0), "the house sweep at 3 Hz instead of 1 Hz"))
    for e in (1, 2, 3):
        for r, order in enumerate(balanced_orders(4, random.Random(e)), 1):
            made.append(write(f"06 8ori 4s 3Hz random E{e} r{r}", sweep_4s(order, tf=3.0),
                              f"as 02 E{e} r{r} (same order) at 3 Hz: {' '.join(map(str, order))} — labels from the runner log only"))
    for r, order in enumerate(balanced_mixed(random.Random(13)), 1):
        made.append(write(f"07 1v3Hz mixed r{r}", sweep_4s(order),
                          f"run {r} of 4, seed 13: all 8 directions at 1 Hz and at 3 Hz, shuffled and balanced — "
                          + " ".join(f"{d}@{t:g}" for d, t in order)))
    for d in DIRS:
        made.append(write(f"10 8s 1rep {d}deg", eight_s([d]), "grey 2 s, one 8 s grating, grey 4 s"))
    for d in DIRS:
        made.append(write(f"11 8s 5rep {d}deg", eight_s([d] * 5), "grey 2 s, five 8 s gratings, grey 4 s after each"))
    for d in DIRS:
        made.append(write(f"20 2h single {d}deg", [grating(d, 7200)], "adaptation exposure: one grating, 2 h, no imaging"))
    print(f"{len(made)} protocols written")


if __name__ == "__main__":
    main()
