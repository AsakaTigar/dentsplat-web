#!/usr/bin/env python3
"""poseidon_probe.py -- print the shape of a Poseidon3D label pickle without guessing.

    python3 tools/poseidon_probe.py MAPPING.pkl REGIONS.pkl [TRANSLATED.pkl ...]

Pickles are loaded (the dataset ships them; pickletools confirmed they hold plain ints/lists before
this script was allowed near them) and summarised: length, value domain, most common labels.
"""
import collections
import pickle
import sys


def load(path: str):
    with open(path, "rb") as f:
        return pickle.load(f)


def main() -> None:
    for path in sys.argv[1:]:
        v = load(path)
        name = path.rsplit("/", 1)[-1]
        if isinstance(v, (list, tuple)):
            n = len(v)
            if n and isinstance(v[0], (int,)):
                c = collections.Counter(int(x) for x in v)
                print(f"{name}: tuple/list n={n} min={min(v)} max={max(v)} "
                      f"unique={len(c)} top={c.most_common(10)}")
            else:
                print(f"{name}: tuple/list n={n} head={v[:20]}")
        elif isinstance(v, dict):
            print(f"{name}: dict n={len(v)} head={dict(list(v.items())[:10])}")
        else:
            print(f"{name}: {type(v)} {v!r}"[:400])


if __name__ == "__main__":
    main()
