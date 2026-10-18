#!/usr/bin/env python3
"""Analyse and elaborate the VHDL export of a system with GHDL, file by file in the order of its compile order file.

  python tools/composer_hdl_check.py <export dir> --sources <root> [--workdir <dir>] [--catalog <catalog.json>]
                                     [--relaxed <library> ...] [--checkout-from <clones>]

<export dir> holds the files of tools/composer_hdl.mjs (or of the button Export HDL); <root> holds one checkout per
repository named in the "source" lines of the compile order, at the commit given there. Every file is analysed into
its library in the listed order, so a wrong order or a missing file fails here.

  - Open Logic (library olo) is analysed with -frelaxed: olo_base_ram_sdp and olo_base_ram_tdp use a shared variable
    without a protected type, the RAM inference pattern of Open Logic, which GHDL accepts only relaxed. This is
    upstream code, it is not changed.
  - The cores and the generated top level are analysed strictly (--std=08 without -frelaxed).
  - A vendor-specific block (vendor in the catalog, for example ofb_pa_gty) needs the simulation libraries of its
    vendor; it is replaced by a stub: its own context clause and entity declaration, without the vendor libraries, and
    an architecture that drives every output with zeros. The top level is checked against the real entity that way.
    The further files of the block (files in the catalog, for example its architecture) are not analysed. Before
    that, the check asserts that the compile order lists them right after the file of the block, in the order of the
    catalog and in its library, and that each exists in the sources: the stub would hide a missing architecture.

--checkout-from creates the missing checkouts of the sources root as worktrees of the clones in <clones> (the clones of
tools/composer_catalog.py clone), at the commits of the compile order.

--relaxed analyses further libraries with -frelaxed, for a local check of the top level while a core still needs it;
the continuous integration does not use it.

The top level is elaborated at the end and run to 0 ns, so that the assertions of the cores on their generics fire
(ghdl --elab-run with --stop-time=0ns --assert-level=error). Exit status 0 when every step passes.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FORMAT_LINE = "format composer-compile-order 1"
RELAXED_LIBRARIES = {"olo"}
VENDOR_LIBRARIES = re.compile(r"^\s*(library\s+(unisim|unimacro|xpm)\s*;|use\s+(unisim|unimacro|xpm)\.\S+\s*;)\s*$", re.I)


def read_order(export: Path) -> tuple[str, list[tuple[str, str]], Path]:
    """Entity name, (library, path) of every file line and the compile order file."""
    found = sorted(export.glob("*_compile_order.txt"))
    if len(found) != 1:
        sys.exit(f"{export}: expected exactly one *_compile_order.txt, found {len(found)}")
    path = found[0]
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != FORMAT_LINE:
        sys.exit(f"{path}: the first line must be '{FORMAT_LINE}'")
    files = []
    for ln in lines[1:]:
        parts = ln.split()
        if parts and parts[0] == "file":
            if len(parts) != 3:
                sys.exit(f"{path}: malformed line '{ln}'")
            files.append((parts[1], parts[2]))
    if not files:
        sys.exit(f"{path}: no files")
    entity = path.name[: -len("_compile_order.txt")]
    if files[-1] != (entity, f"{entity}.vhd"):
        sys.exit(f"{path}: the last file must be the top level '{entity} {entity}.vhd'")
    return entity, files, path


def checkout_sources(order: Path, sources: Path, clones: Path) -> None:
    """A checkout at the given commit for every "source" line that the sources root lacks, as a worktree of the clone
    of that repository in <clones> (with its submodules where the line says "recursive")."""
    for ln in order.read_text(encoding="utf-8").splitlines():
        parts = ln.split()
        if not parts or parts[0] != "source":
            continue
        name, commit = parts[1], parts[3]
        target = sources / name
        if target.exists():
            continue
        clone = clones / name
        if not clone.is_dir():
            sys.exit(f"{order.name}: no clone of {name} in {clones}")
        subprocess.run(["git", "-C", str(clone), "worktree", "add", "--quiet", "--detach", str(target.resolve()), commit],
                       check=True)
        if "recursive" in parts[4:]:
            subprocess.run(["git", "-C", str(target), "submodule", "update", "--quiet", "--init", "--recursive"], check=True)
        print(f"{name}: checked out at {commit[:10]}")


def vendor_blocks(catalog: dict) -> dict[str, dict]:
    """<repository>/<path> of every vendor-specific block -> the block."""
    repo = {s["id"]: s["repo"] for s in catalog["sources"]}
    return {f"{repo[b['source']]}/{b['path']}": b for b in catalog["blocks"] if b.get("vendor")}


def vendor_files(order: str, files: list[tuple[str, str]], vendors: dict[str, dict], catalog: dict,
                 sources: Path) -> set[str]:
    """The further files of every vendor-specific block in the compile order, as <repository>/<file>. Each must follow
    the file of its block in the order of the catalog and in its library, and exist in the sources; otherwise the check
    stops, since the stub of the block would hide a missing file. These files are not analysed."""
    repo = {s["id"]: s["repo"] for s in catalog["sources"]}
    rels = [rel for _, rel in files]
    skip = set()
    errors = []
    for path, b in vendors.items():
        if path not in rels:
            continue
        at = rels.index(path)
        lib = files[at][0]
        for k, f in enumerate(b.get("files") or [], 1):
            rel = f"{repo[b['source']]}/{f}"
            skip.add(rel)
            if rel not in rels:
                errors.append(f"{order}: {rel}, a file of the vendor-specific block {b['entity']}, is not listed; "
                              "the stub of the block would hide its absence")
                continue
            if rels.index(rel) != at + k or files[at + k][0] != lib:
                errors.append(f"{order}: {rel} must follow {path} as file {k} of {b['entity']} in the library {lib}")
            if not (sources / rel).is_file():
                errors.append(f"{order}: {rel}, a file of the vendor-specific block {b['entity']}, is not in {sources}")
    if errors:
        sys.exit("\n".join(errors))
    return skip


def stub(block: dict, source: Path, out: Path) -> Path:
    """The real context clause and entity declaration of a vendor-specific block with an architecture that drives its
    outputs with zeros."""
    text = source.read_text(encoding="utf-8")
    m = re.search(rf"^\s*entity\s+{re.escape(block['entity'])}\s+is\b.*?^\s*end\s+(entity\b|{re.escape(block['entity'])}\b)[^;]*;",
                  text, re.I | re.M | re.S)
    if not m:
        sys.exit(f"{source}: no entity declaration of {block['entity']}")
    context = [ln for ln in text[: m.start()].splitlines() if not VENDOR_LIBRARIES.match(ln)]
    drives = []
    for p in block["ports"]:
        if p["dir"] != "out":
            continue
        vector = not re.fullmatch(r"\s*std_u?logic\s*", p["vhdlType"], re.I)
        drives.append(f"    {p['name']} <= {'(others => ' + chr(39) + '0' + chr(39) + ')' if vector else chr(39) + '0' + chr(39)};")
    body = "\n".join(drives)
    path = out / f"{block['entity']}_stub.vhd"
    path.write_text(
        "\n".join(context)
        + f"\n-- Stub for the GHDL check of the Composer export: the vendor libraries are not available.\n{m.group(0)}\n\n"
        + f"architecture stub of {block['entity']} is\nbegin\n{body}\nend architecture;\n",
        encoding="utf-8",
    )
    return path


def ghdl(args: list[str], what: str) -> None:
    r = subprocess.run(["ghdl", *args], capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout + r.stderr)
        sys.exit(f"GHDL failed: {what}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("export", type=Path)
    ap.add_argument("--sources", type=Path, required=True)
    ap.add_argument("--workdir", type=Path)
    ap.add_argument("--catalog", type=Path, default=ROOT / "assets" / "composer" / "catalog.json")
    ap.add_argument("--relaxed", action="append", default=[], metavar="LIBRARY")
    ap.add_argument("--checkout-from", type=Path, metavar="CLONES")
    a = ap.parse_args()
    entity, files, order = read_order(a.export)
    if a.checkout_from:
        a.sources.mkdir(parents=True, exist_ok=True)
        checkout_sources(order, a.sources, a.checkout_from)
    catalog = json.loads(a.catalog.read_text(encoding="utf-8"))
    vendors = vendor_blocks(catalog)
    skip = vendor_files(order.name, files, vendors, catalog, a.sources)
    work = a.workdir or (a.export / "ghdl")
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    libraries = []
    for lib, _ in files:
        if lib not in libraries:
            libraries.append(lib)
    for lib in libraries:
        (work / lib).mkdir()
    paths = [f"-P{work / lib}" for lib in libraries]
    stubs = 0
    for lib, rel in files:
        if rel in skip:
            continue
        src = a.export / rel if lib == entity else a.sources / rel
        if not src.is_file():
            sys.exit(f"{order.name}: {rel} not found in {a.export if lib == entity else a.sources}")
        if rel in vendors:
            src = stub(vendors[rel], src, work)
            stubs += 1
        flags = ["--std=08"] + (["-frelaxed"] if lib in RELAXED_LIBRARIES or lib in a.relaxed else [])
        ghdl(["-a", *flags, f"--work={lib}", f"--workdir={work / lib}", *paths, str(src)], f"{lib} {rel}")
    # the mcode backend analyses every unit again in memory when it elaborates, Open Logic included: -frelaxed here,
    # the strict analysis of the cores and the top level is the step above
    # run to 0 ns: the assertions of the cores on their generics fire at the start of the simulation, not at the
    # elaboration; an assertion of severity error or failure stops it
    ghdl(["--elab-run", "--std=08", "-frelaxed", f"--work={entity}", f"--workdir={work / entity}", *paths, entity,
          "--stop-time=0ns", "--assert-level=error", "--ieee-asserts=disable"], f"elaboration and simulation to 0 ns of {entity}")
    skipped = f", {len(skip)} vendor file{'s' if len(skip) != 1 else ''} not analysed" if skip else ""
    print(f"{entity}: {len(files) - len(skip)} files analysed ({stubs} vendor stub{'s' if stubs != 1 else ''}{skipped}), "
          "top level elaborated and run to 0 ns")
    return 0


if __name__ == "__main__":
    sys.exit(main())
