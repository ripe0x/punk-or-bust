#!/usr/bin/env python3
"""Vendor or verify the verified FWA V2 sources under refs/.

  python3 script/fwa_refs.py                 verify every refs/*/provenance.json hash
  python3 script/fwa_refs.py vendor <dir> <sourcify.json> [source ...]
                                             write sources (as .sol.txt), a forge artifact and
                                             provenance from a Sourcify `?fields=all` response

Sources are kept with a .txt suffix so their 0.8.26 pragmas stay out of this repo's build.
"""
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1] / "refs"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def vendor(target, response, only):
    d = json.loads(pathlib.Path(response).read_text())
    if d.get("creationMatch") != "match" or d.get("runtimeMatch") != "match":
        sys.exit("refusing a partial Sourcify match")
    out = ROOT / target
    out.mkdir(parents=True, exist_ok=True)
    names = only or list(d["sources"])
    for name in names:
        p = out / (name + ".txt")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(d["sources"][name]["content"])
    settings = d["stdJsonInput"]["settings"]
    settings.pop("outputSelection", None)
    (out / "compiler-settings.json").write_text(json.dumps(settings, indent=2, sort_keys=True) + "\n")
    artifact = {
        "abi": d["abi"],
        "bytecode": {"object": d["creationBytecode"]["recompiledBytecode"]},
        "deployedBytecode": {"object": d["runtimeBytecode"]["recompiledBytecode"]},
    }
    contract = d["compilation"]["fullyQualifiedName"].split(":")[1]
    (out / f"{contract}.json").write_text(json.dumps(artifact) + "\n")
    files = sorted(p for p in out.rglob("*") if p.is_file() and p.name not in ("provenance.json", "README.md"))
    provenance = {
        "chainId": d["chainId"],
        "address": d["address"],
        "contract": d["compilation"]["fullyQualifiedName"],
        "compiler": d["compilation"]["compilerVersion"],
        "sourceURL": f"https://sourcify.dev/server/v2/contract/{d['chainId']}/{d['address']}?fields=all",
        "matchId": d["matchId"],
        "creationMatch": d["creationMatch"],
        "runtimeMatch": d["runtimeMatch"],
        "verifiedAt": d["verifiedAt"],
        "vendoredSources": "all" if not only else "subset",
        "sha256": {str(p.relative_to(out)): sha(p) for p in files},
    }
    (out / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
    print(f"vendored {len(files)} files into refs/{target}")


def verify():
    dirs = sorted(p.parent for p in ROOT.glob("*/provenance.json"))
    if not dirs:
        sys.exit("no vendored refs found")
    for out in dirs:
        expected = json.loads((out / "provenance.json").read_text())["sha256"]
        actual = {str(p.relative_to(out)) for p in out.rglob("*") if p.is_file() and p.name not in ("provenance.json", "README.md")}
        if actual != set(expected):
            sys.exit(f"refs/{out.name}: untracked or missing files {sorted(actual ^ set(expected))}")
        for rel, digest in expected.items():
            if sha(out / rel) != digest:
                sys.exit(f"refs/{out.name}: {rel} changed")
        print(f"refs/{out.name}: {len(expected)} files match provenance")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "vendor":
        vendor(sys.argv[2], sys.argv[3], sys.argv[4:])
    else:
        verify()
