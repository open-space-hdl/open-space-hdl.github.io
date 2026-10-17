#!/usr/bin/env python3
"""Build and check the block catalog of the Open Space Composer.

The catalog source is the YAML in _composer/catalog/: interface types, the pinned source repositories and the
semantic description of every block (interfaces, clocks, resets, tie-offs, presets, rules). The ports and generics
themselves are read from the VHDL entity at the pinned commit or tag, so the published catalog cannot drift from the
RTL.

  python tools/composer_catalog.py build              write assets/composer/catalog.json
  python tools/composer_catalog.py check              verify YAML against VHDL, catalog.json current, examples valid
  python tools/composer_catalog.py clone              clone the missing source repositories (continuous integration)
  python tools/composer_catalog.py dump <src> <path> <entity>
                                                      print the parsed entity (authoring aid)

The repositories are expected as sibling clones of this repository (override with --repos or COMPOSER_REPOS).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
CATALOG_DIR = ROOT / "_composer" / "catalog"
OUT_FILE = ROOT / "assets" / "composer" / "catalog.json"
SCHEMA_FILES = {1: ROOT / "composer" / "schema" / "system-1.json", 2: ROOT / "composer" / "schema" / "system-2.json"}
EXAMPLES_DIR = ROOT / "assets" / "composer" / "examples"
SUBSYSTEM_FIXTURES_DIR = ROOT / "tests" / "fixtures" / "subsystems"

CATALOG_FORMAT = "open-space-composer-catalog"
CATALOG_VERSION = 1

TYPE_KINDS = {"stream", "bus", "pins", "event"}
ROLES = {"source", "sink", "master", "slave", "pins", "event_out", "event_in"}
FLIPPED_ROLES = {"sink", "slave", "event_in"}
ROLE_KINDS = {
    "source": {"stream"},
    "sink": {"stream"},
    "master": {"bus"},
    "slave": {"bus"},
    "pins": {"pins"},
    "event_out": {"event"},
    "event_in": {"event"},
}
GENERIC_KINDS = {"boolean", "integer", "real", "std_logic", "std_logic_vector", "string", "integer_vector", "opaque"}
# design rules implemented by the Composer (assets/composer/js/model/rules.js) with their required keys
RULE_KINDS = {
    "clock_freq_multiple": ("clock", "multipleHz", "tolerance"),
    "clock_relation": ("faster", "slower"),
    "generic_any_true": ("generics",),
    "generic_multiple": ("generic", "of"),
    "generic_range": ("generic",),
    "generic_requires": ("generic", "value", "requires"),
    "vector_within": ("generic", "mask"),
    "mutual_initiator": ("generic",),
    "same_domain": ("interfaces",),
    "partner_requires": ("interface", "types", "generic", "value", "message"),
    "flag_dropped": ("interface", "signal", "bit", "message"),
    "run_rate": ("clock", "divider", "sampling", "message"),
    "with_block": ("block", "message"),
    "known_defect": ("message",),
}
# the optional keys of every rule kind, beside kind, message, severity and when (a key outside them is a mistake, for
# example a flow mapping of YAML split at the comma of an unquoted expression)
RULE_OPTIONAL = {
    "clock_relation": ("integer",),
    "generic_multiple": ("pow2Ratio",),
    "generic_range": ("min", "max", "unlessZero", "elements"),
    "flag_dropped": ("unlessGeneric", "unlessInterface"),
    "known_defect": ("generic", "below"),
}
# keys of a field of a side band or of a user signal
FIELD_KEYS = {"name", "label", "lsb", "bits", "kind", "default", "enabledBy", "below", "description"}
# conditions of a software initialisation step (names of boolean generics)
INIT_CONDITIONS = ("when", "unless", "unlessAll")
GENERIC_CHECKS = {"pow2", "multiple8", "multiple16"}
# constraints of the blocks (translated to the top level by the resolver) with their required keys
# Throughput data of a block (rates): keys and the names an expression may use besides the generics
RATE_INTERFACE_KEYS = {"bytesPerBeat", "beatsPerCycle", "extraBeats", "overheadCycles", "cycles", "maxBytes", "reference"}
# named models of the Composer for numbers no expression can give (assets/composer/js/model/throughput.js), with the
# variables they set; the variable an assumption of the user sets (rates.assumed) beside them
RATE_MODELS = {"ocp": {"ocp_cycles_per_image", "ocp_header_bytes", "ocp_image_bytes"}}
RATE_ASSUMED_KEYS = {"name", "label", "description"}
RATE_ROUTE_KEYS = {"from", "to", "addBytes", "chunk", "gather", "paced"}
RATE_LINK_KEYS = {"interface", "from", "to", "capacity", "capacityBoth", "efficiency", "note"}
RATE_CHAIN_KEYS = {"from", "to", "cycles", "evidence"}
EXPR_WORDS = {"mod", "rem", "abs"}


def check_rates(ctx: "Context", where: str, rates: object, gen_names: set, itf_names: set, clock_ports: set) -> None:
    """The throughput data of a block: known keys, interfaces of the block, and expressions that name only generics,
    the variables of vars, n (bytes of the packet), eff (efficiency of a link) and Freq_<clock port>."""
    if not isinstance(rates, dict):
        ctx.err(where, "rates must be a mapping")
        return
    unknown = set(rates) - {"evidence", "packet", "vars", "interfaces", "routes", "links", "chains", "model", "assumed"}
    if unknown:
        ctx.err(where, f"rates: unknown keys {', '.join(sorted(unknown))}")
    if not isinstance(rates.get("evidence"), str) or not rates["evidence"].strip():
        ctx.err(where, "rates needs evidence (the test case or measurement behind the numbers)")
    names = {g.lower() for g in gen_names} | {"n"} | {f"freq_{c}".lower() for c in clock_ports}
    names |= {k.lower() for k in (rates.get("vars") or {})}
    model = rates.get("model")
    if model is not None and model not in RATE_MODELS:
        ctx.err(where, f"rates: unknown model {model} (known: {', '.join(sorted(RATE_MODELS))})")
    names |= RATE_MODELS.get(model, set())
    assumed = rates.get("assumed")
    if assumed is not None:
        # the instance states the value (traffic.<name> of the file); only the ratio of a compressor so far
        if not isinstance(assumed, dict) or set(assumed) != RATE_ASSUMED_KEYS or assumed.get("name") != "ratio" or model is None:
            ctx.err(where, "rates: assumed needs name (ratio), label and description, and a model that uses it")
    funcs = {f.lower() for f in FUNCTIONS} | EXPR_WORDS

    def expr(what: str, value: object, extra: set = frozenset()) -> None:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return
        if not isinstance(value, str):
            ctx.err(where, f"rates: {what} must be a number or an expression")
            return
        for name in re.findall(r"[A-Za-z]\w*", re.sub(r"\d+#[0-9a-fA-F_]+#|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?", " ", value)):
            if name.lower() not in names | funcs | extra:
                ctx.err(where, f"rates: {what} names {name}, which is no generic, variable, n or clock frequency")

    for k, v in (rates.get("vars") or {}).items():
        expr(f"vars.{k}", v)
    itfs = rates.get("interfaces") or {}
    for iname, entry in itfs.items():
        if iname not in itf_names:
            ctx.err(where, f"rates: unknown interface {iname}")
        if not isinstance(entry, dict):
            ctx.err(where, f"rates: interface {iname} must be a mapping")
            continue
        if set(entry) - RATE_INTERFACE_KEYS:
            ctx.err(where, f"rates: interface {iname}: unknown keys {', '.join(sorted(set(entry) - RATE_INTERFACE_KEYS))}")
        if "cycles" not in entry and "bytesPerBeat" not in entry:
            ctx.err(where, f"rates: interface {iname} needs cycles or bytesPerBeat")
        for key in RATE_INTERFACE_KEYS:
            if key in entry and not (key == "bytesPerBeat" and entry[key] == "carried"):
                expr(f"{iname}.{key}", entry[key])
    for r in rates.get("routes") or []:
        if set(r) - RATE_ROUTE_KEYS or "from" not in r or "to" not in r:
            ctx.err(where, "rates: a route needs from and to and knows addBytes, chunk, gather and paced")
            continue
        if "chunk" in r and "gather" in r:
            ctx.err(where, f"rates: route {r['from']} to {r['to']}: chunk and gather exclude each other")
        for end in ("from", "to"):
            if r[end] not in itfs and not (end == "to" and r.get("paced") and r[end] in itf_names):
                ctx.err(where, f"rates: route {r['from']} to {r['to']}: {r[end]} has no rate entry")
        for key in ("addBytes", "chunk", "gather"):
            if key in r:
                expr(f"route {r['from']} to {r['to']}: {key}", r[key])
    for lk in rates.get("links") or []:
        if set(lk) - RATE_LINK_KEYS or "interface" not in lk or "capacity" not in lk:
            ctx.err(where, "rates: a link needs interface and capacity")
            continue
        if lk["interface"] not in itf_names:
            ctx.err(where, f"rates: link: unknown interface {lk['interface']}")
        for end in ("from", "to"):
            if end in lk and lk[end] not in itfs:
                ctx.err(where, f"rates: link {lk['interface']}: {lk[end]} has no rate entry")
        eff = lk.get("efficiency")
        if eff is not None and (not isinstance(eff, dict) or eff.get("by") not in gen_names
                                or not isinstance(eff.get("oneDirection"), dict) or not isinstance(eff.get("bothDirections"), dict)):
            ctx.err(where, f"rates: link {lk['interface']}: efficiency needs by (a generic), oneDirection and bothDirections")
        for key in ("capacity", "capacityBoth"):
            if key in lk:
                expr(f"link {lk['interface']}: {key}", lk[key], {"eff"} if eff else set())
    for ch in rates.get("chains") or []:
        if set(ch) - RATE_CHAIN_KEYS or not isinstance(ch.get("to"), dict) or "cycles" not in ch or "from" not in ch:
            ctx.err(where, "rates: a chain needs from, to (block, in, out, when) and cycles")
            continue
        if ch["from"] not in itfs:
            ctx.err(where, f"rates: chain from {ch['from']} has no rate entry")
        if set(ch["to"]) - {"block", "in", "out", "when"} or not all(k in ch["to"] for k in ("block", "in", "out")):
            ctx.err(where, "rates: chain to needs block, in and out (when optional)")
        expr(f"chain from {ch['from']}: cycles", ch["cycles"])


REGISTER_KEYS = {"map", "header", "doc", "prefix"}
WINDOW_KEYS = {"array", "registers", "count", "reset", "states"}
IRQ_REGISTER_KEYS = {"events", "enable", "status"}
ECC_REGISTER_KEYS = {"status", "select", "count", "inject"}


# the kinds of a change of a block in the chain of pin steps (changes.yml), with the keys each needs
CHANGE_KINDS = {
    "generic_renamed": ("from", "to"),
    "generic_removed": ("generic",),
    "generic_default": ("generic", "old"),
    "generic_added": ("generic",),
    "generic_range": ("generic",),
    "interface_renamed": ("from", "to"),
    "interface_removed": ("interface",),
    "interface_added": ("interface",),
    "registers": (),
    "behaviour": (),
}


def check_changes(ctx: "Context", changes: object, sources: dict, blocks: list) -> None:
    """The chain of pin steps of every source (changes.yml): each step moves from the pin before (previous, an ancestor)
    to its pin, the steps follow each other and end at the current pin, and every change names a block of the source and
    generics and interfaces as the current catalog has them (new names present, removed names gone). The steps are
    attached to the source (sources[].changes)."""
    if changes is None:
        return
    if not isinstance(changes, dict):
        ctx.err("changes.yml", "must map source ids to their steps")
        return
    by_id = {b["id"]: b for b in blocks}
    for sid, steps in changes.items():
        where = f"changes.yml: {sid}"
        src = sources.get(sid)
        if src is None:
            ctx.err(where, "unknown source")
            continue
        if not isinstance(steps, list) or not steps:
            ctx.err(where, "needs a list of steps")
            continue
        repo = ctx.repos / src["repo"]
        for k, step in enumerate(steps):
            swhere = f"{where}: step {k + 1}"
            if not isinstance(step, dict) or set(step) != {"previous", "pin", "evidence", "changes"} or not isinstance(step.get("evidence"), str):
                ctx.err(swhere, "needs previous, pin, evidence and changes")
                continue
            for key in ("previous", "pin"):
                if not git_ok(repo, "cat-file", "-e", f"{step[key]}^{{commit}}"):
                    ctx.err(swhere, f"{key} {step[key]} is no commit of {src['repo']}")
            if not git_ok(repo, "merge-base", "--is-ancestor", str(step["previous"]), str(step["pin"])):
                ctx.err(swhere, f"previous {step['previous']} is not an ancestor of pin {step['pin']}")
            if k > 0 and isinstance(steps[k - 1], dict) and steps[k - 1].get("pin") != step["previous"]:
                ctx.err(swhere, "previous is not the pin of the step before")
            for ch in step["changes"] if isinstance(step["changes"], list) else []:
                kind = ch.get("kind") if isinstance(ch, dict) else None
                if kind not in CHANGE_KINDS or not isinstance(ch.get("text"), str) or not isinstance(ch.get("block"), str):
                    ctx.err(swhere, f"a change needs block, a kind of {', '.join(CHANGE_KINDS)} and text")
                    continue
                need = CHANGE_KINDS[kind]
                extra = set(ch) - {"block", "kind", "text", *need} - ({"adopt"} if kind == "generic_default" else set())
                if any(key not in ch for key in need) or extra:
                    ctx.err(swhere, f"{kind} needs {', '.join(need) or 'no further key'}")
                    continue
                b = by_id.get(ch["block"])
                if b is None or b["source"] != sid:
                    ctx.err(swhere, f"{ch['block']} is no block of {sid}")
                    continue
                gens = {g["name"] for g in b["generics"]}
                itfs = {i["name"] for i in b["interfaces"]}
                present = {
                    "generic_renamed": [(ch.get("to"), gens, True), (ch.get("from"), gens, False)],
                    "generic_removed": [(ch.get("generic"), gens, False)],
                    "generic_default": [(ch.get("generic"), gens, True)],
                    "generic_added": [(ch.get("generic"), gens, True)],
                    "generic_range": [(ch.get("generic"), gens, True)],
                    "interface_renamed": [(ch.get("to"), itfs, True), (ch.get("from"), itfs, False)],
                    "interface_removed": [(ch.get("interface"), itfs, False)],
                    "interface_added": [(ch.get("interface"), itfs, True)],
                }.get(kind, [])
                for name, names, must in present:
                    if (name in names) != must:
                        ctx.err(swhere, f"{kind}: {ch['block']} {'has no' if must else 'still has'} {name}")
        last = steps[-1]
        if isinstance(last, dict) and last.get("pin") != src["sha"]:
            ctx.err(where, f"the last step ends at {last.get('pin')}, not at the pin {src['sha']}")
        src["changes"] = steps


def field_width(bits: str) -> int:
    """Width of a field of a register map ("17:0", "5")."""
    hi, _, lo = str(bits).partition(":")
    return int(hi) - int(lo or hi) + 1


def register_extent(regmap: dict, maxima: dict[str, int]) -> int:
    """Bytes a register map occupies: up to the end of its highest register (32-bit registers). An array whose count is
    a generic counts with the largest value of the generic."""
    ends = [int(r["offset"]) + 4 for r in regmap.get("registers") or []]
    for a in regmap.get("arrays") or []:
        count = a["count"] if isinstance(a["count"], int) else maxima.get(str(a["count"]), 1)
        last = int(a["base"]) + int(a["stride"]) * (int(count) - 1)
        ends += [last + int(r["offset"]) + 4 for r in a.get("registers") or []]
    return max(ends, default=0)


def check_registers(ctx: "Context", where: str, b: dict, src: dict, interfaces: list, generics: list,
                    block: dict) -> dict | None:
    """The register map of a block in its repository at the pin (the YAML source of the core, its C header and its
    Markdown): it exists, its ID is the ID register of the catalog, it fits the address width of the AXI4-Lite slave,
    and the header defines <prefix>_REGMAP_ID. An address space that a master of the block starts names the windows of
    the block (an array of the map), which get their base and stride from it."""
    regs = b["registers"]
    gen_names = {g["name"] for g in generics}
    maxima = {g["name"]: g["max"] for g in generics if isinstance(g.get("max"), int)}
    if not isinstance(regs, dict) or set(regs) != REGISTER_KEYS:
        ctx.err(where, "registers needs map, header, doc and prefix")
        return None
    repo = ctx.repos / src["repo"]
    for key in ("map", "header", "doc"):
        if not git_ok(repo, "cat-file", "-e", f"{src['sha']}:{regs[key]}"):
            ctx.err(where, f"registers: {key} {regs[key]} does not exist at the pin")
            return None
    regmap = yaml.safe_load(git(repo, "show", f"{src['sha']}:{regs['map']}"))
    ident = (b.get("idRegister") or {}).get("value")
    if ident is None or int(str(ident), 0) != int(regmap.get("id", -1)):
        ctx.err(where, f"registers: the ID {regmap.get('id')} of {regs['map']} is not the ID register {ident}")
    if f"#define {regs['prefix']}_REGMAP_ID " not in git(repo, "show", f"{src['sha']}:{regs['header']}"):
        ctx.err(where, f"registers: {regs['header']} does not define {regs['prefix']}_REGMAP_ID")
    slave = next((i for i in interfaces if i["role"] == "slave" and i["type"] in ("axi4lite", "axi4")), None)
    width = ((slave or {}).get("params") or {}).get("addrWidth")
    if not isinstance(width, int):
        ctx.err(where, "registers: the block needs an AXI4-Lite slave with a numeric addrWidth")
    else:
        if "addr_bits" in regmap and regmap["addr_bits"] != width:
            ctx.err(where, f"registers: {regs['map']} has addr_bits {regmap['addr_bits']}, the slave {width}")
        extent = register_extent(regmap, maxima)
        if extent > 2 ** width:
            ctx.err(where, f"registers: {regs['map']} reaches byte {extent - 1}, beyond the {width} address bits of the slave")
    for itf in interfaces:
        space = itf.get("addressSpace")
        if space is None:
            continue
        iwhere = f"{where}: interface {itf['name']}: addressSpace"
        win = space.get("windows") if isinstance(space, dict) else None
        if itf["role"] != "master" or set(space) - {"what", "windows"} or not isinstance(space.get("what"), str):
            ctx.err(iwhere, "needs what (and windows), on a master")
            continue
        if win is None:
            continue
        if set(win) != WINDOW_KEYS:
            ctx.err(iwhere, f"windows needs {', '.join(sorted(WINDOW_KEYS))}")
            continue
        arr = next((a for a in regmap.get("arrays") or [] if a.get("name") == win["array"]), None)
        if arr is None:
            ctx.err(iwhere, f"{regs['map']} has no array {win['array']}")
            continue
        names = {r["name"] for r in arr.get("registers") or []}
        for name in win["registers"]:
            if name not in names:
                ctx.err(iwhere, f"the array {win['array']} has no register {name}")
        for key in ("count", "reset"):
            if win[key] not in gen_names:
                ctx.err(iwhere, f"windows: {key} names {win[key]}, which is no generic")
        itf["addressSpace"] = {**space, "windows": {**win, "base": int(arr["base"]), "stride": int(arr["stride"])}}
    by_name = {r["name"]: r for r in regmap.get("registers") or []}

    def register(name: object, iwhere: str) -> dict | None:
        r = by_name.get(str(name))
        if r is None:
            ctx.err(iwhere, f"{regs['map']} has no register {name}")
            return None
        return {"name": r["name"], "offset": int(r["offset"])}

    # the registers of an interrupt: its events (cleared by writing ones), the enables and the status
    for itf in interfaces:
        irq = itf.get("irqRegisters")
        if irq is None:
            continue
        iwhere = f"{where}: interface {itf['name']}: irqRegisters"
        if itf["type"] != "irq" or not isinstance(irq, dict) or set(irq) - IRQ_REGISTER_KEYS or not isinstance(irq.get("enable"), list):
            ctx.err(iwhere, "on an irq interface, needs enable (a list) and optionally events and status")
            continue
        out = {"enable": [x for x in (register(n, iwhere) for n in irq["enable"]) if x]}
        for key in ("events", "status"):
            if key in irq:
                found = register(irq[key], iwhere)
                if found:
                    out[key] = found
        itf["irqRegisters"] = out
    # the ECC of the memories inside the block: the double-error flags of the status register give the channels, and
    # the select register must address every channel
    prot = b.get("protection")
    if prot is not None:
        pwhere = f"{where}: protection"
        ecc = prot.get("ecc") if isinstance(prot, dict) else None
        if not isinstance(prot, dict) or set(prot) - {"evidence", "ecc"} or not isinstance(prot.get("evidence"), str):
            ctx.err(pwhere, "needs evidence (the protection scope of the user guide) and optionally ecc")
        elif ecc is not None:
            if not isinstance(ecc, dict) or set(ecc) != ECC_REGISTER_KEYS:
                ctx.err(pwhere, f"ecc needs {', '.join(sorted(ECC_REGISTER_KEYS))}")
            else:
                found = {key: register(ecc[key], pwhere) for key in sorted(ECC_REGISTER_KEYS)}
                status = by_name.get(str(ecc["status"])) or {}
                ded = next((f for f in status.get("fields") or [] if f.get("name") == "DED"), None)
                select = by_name.get(str(ecc["select"])) or {}
                channel = next((f for f in select.get("fields") or [] if f.get("name") == "CHANNEL"), None)
                if ded is None:
                    ctx.err(pwhere, f"{ecc['status']} has no field DED (one double-error flag per channel)")
                elif channel is None:
                    ctx.err(pwhere, f"{ecc['select']} has no field CHANNEL")
                else:
                    channels = field_width(ded["bits"])
                    if 2 ** field_width(channel["bits"]) < channels:
                        ctx.err(pwhere, f"{ecc['select']}.CHANNEL ({channel['bits']}) cannot address the {channels} channels of {ecc['status']}.DED")
                    elif all(found.values()):
                        block["protection"] = {"evidence": prot["evidence"], "ecc": {**found, "channels": channels}}
        if ecc is None and isinstance(prot, dict) and isinstance(prot.get("evidence"), str):
            block["protection"] = {"evidence": prot["evidence"]}
    return dict(regs)


def check_sizes(ctx: "Context", where: str, sizes: object, gen_names: set, itf_names: set) -> None:
    """The size data of a block: known keys, interfaces of the block, and expressions that name only generics and n
    (bytes of the packet), m and d (beats of a message and of a buffer, in fullRate)."""
    if not isinstance(sizes, dict):
        ctx.err(where, "sizes must be a mapping")
        return
    unknown = set(sizes) - {"evidence", "interfaces", "buffers", "sends", "chains"}
    if unknown:
        ctx.err(where, f"sizes: unknown keys {', '.join(sorted(unknown))}")
    if not isinstance(sizes.get("evidence"), str) or not sizes["evidence"].strip():
        ctx.err(where, "sizes needs evidence (the user guide or test case behind the limits)")
    names = {g.lower() for g in gen_names} | {"n"}
    funcs = {f.lower() for f in FUNCTIONS} | EXPR_WORDS

    def expr(what: str, value: object, extra: frozenset = frozenset()) -> None:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return
        if not isinstance(value, str):
            ctx.err(where, f"sizes: {what} must be a number or an expression")
            return
        for name in re.findall(r"[A-Za-z]\w*", re.sub(r"\d+#[0-9a-fA-F_]+#|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?", " ", value)):
            if name.lower() not in names | funcs | extra:
                ctx.err(where, f"sizes: {what} names {name}, which is no generic or n")

    for iname, entry in (sizes.get("interfaces") or {}).items():
        if iname not in itf_names:
            ctx.err(where, f"sizes: unknown interface {iname}")
        if not isinstance(entry, dict) or ("limits" in entry) == bool(entry.get("noLimit")):
            ctx.err(where, f"sizes: interface {iname} needs limits or noLimit: true")
            continue
        if set(entry) - {"limits", "noLimit", "tested"}:
            ctx.err(where, f"sizes: interface {iname}: unknown keys {', '.join(sorted(set(entry) - {'limits', 'noLimit', 'tested'}))}")
        for lim in entry.get("limits") or []:
            if set(lim) - {"maxBytes", "over", "why", "soft", "set"} or not all(k in lim for k in ("maxBytes", "over", "why")):
                ctx.err(where, f"sizes: a limit of {iname} needs maxBytes, over and why (soft and set optional)")
                continue
            if "set" in lim and lim["set"] not in gen_names:
                ctx.err(where, f"sizes: limit of {iname}: set names {lim['set']}, which is no generic")
            expr(f"{iname}.maxBytes", lim["maxBytes"])
            soft = lim.get("soft")
            if soft is not None:
                if not isinstance(soft, dict) or soft.get("generic") not in gen_names or "register" not in soft or "hard" not in soft:
                    ctx.err(where, f"sizes: soft limit of {iname} needs generic, register and hard")
                else:
                    expr(f"{iname}.soft.hard", soft["hard"])
    for buf in sizes.get("buffers") or []:
        need = ("interface", "holds", "beat", "sections", "over")
        if not all(k in buf for k in need) or set(buf) - {*need, "enabledBy", "spareBeats", "fullRate"}:
            ctx.err(where, "sizes: a buffer needs interface, holds, beat, sections and over (enabledBy, spareBeats, fullRate optional)")
            continue
        if buf["interface"] not in itf_names:
            ctx.err(where, f"sizes: buffer: unknown interface {buf['interface']}")
        if buf.get("enabledBy") and buf["enabledBy"] not in gen_names:
            ctx.err(where, f"sizes: buffer: unknown generic {buf['enabledBy']}")
        for key in ("holds", "beat"):
            expr(f"buffer {key}", buf[key])
        for s in buf["sections"]:
            expr("buffer section", s)
        fr = buf.get("fullRate")
        if fr is not None:
            if set(fr) != {"messages", "cycles", "normal"}:
                ctx.err(where, "sizes: fullRate needs messages, cycles and normal")
            else:
                for key in ("cycles", "normal"):
                    expr(f"fullRate {key}", fr[key], frozenset({"m", "d"}))
    for s in sizes.get("sends") or []:
        if set(s) != {"interface", "what", "bytes", "farEnd"}:
            ctx.err(where, "sizes: sends needs interface, what, bytes and farEnd")
            continue
        if s["interface"] not in itf_names:
            ctx.err(where, f"sizes: sends: unknown interface {s['interface']}")
        expr("sends bytes", s["bytes"])
    for ch in sizes.get("chains") or []:
        if set(ch) != {"from", "to", "sections"} or not isinstance(ch.get("to"), dict) or set(ch["to"]) != {"block", "in", "out"}:
            ctx.err(where, "sizes: a chain needs from, to (block, in, out) and sections")
            continue
        if ch["from"] not in itf_names:
            ctx.err(where, f"sizes: chain from unknown interface {ch['from']}")
        for s in ch["sections"]:
            expr("chain section", s)


CONSTRAINT_KINDS = {
    "false_path": ("fromPorts",),
    "max_delay_pairs": ("clocks",),
    "io_register": ("ports",),
    "vendor_scoped": ("file",),
}
FOLLOW_MEASURES = {"data", "user", "packed", "generic"}
CDC_MODES = {"level", "pulse", "valid", "none"}
INT_MAX = 2**31 - 1


class CatalogError(Exception):
    """A problem in the catalog source or in its relation to the VHDL."""


# ---------------------------------------------------------------------------------------------------------------------
# Git access
# ---------------------------------------------------------------------------------------------------------------------
def git(repo: Path, *args: str) -> str:
    res = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, encoding="utf-8")
    if res.returncode != 0:
        raise CatalogError(f"git {' '.join(args)} in {repo} failed: {res.stderr.strip()}")
    return res.stdout


def git_ok_output(repo: Path, *args: str) -> str:
    """Output of a git command that may find nothing (git grep exits with 1 then)."""
    r = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, encoding="utf-8")
    return r.stdout if r.returncode in (0, 1) else ""


def git_ok(repo: Path, *args: str) -> bool:
    res = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    return res.returncode == 0


# ---------------------------------------------------------------------------------------------------------------------
# Expressions (VHDL subset used in widths and defaults)
# ---------------------------------------------------------------------------------------------------------------------
TOKEN_RE = re.compile(
    r"\s*(?:(?P<based>\d+#[0-9a-fA-F_]+#)|(?P<num>\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)"
    r"|(?P<attr>'\w+)|(?P<id>[A-Za-z]\w*)|(?P<op>\*\*|[-+*/(),]))"
)


@dataclass
class Num:
    value: float | int
    real: bool


def eccparitybits(width: int) -> int:
    bits = 1
    while 2**bits < width + bits + 1:
        bits += 1
    return bits


def log2ceil(n: int) -> int:
    n = int(n)
    if n <= 1:
        return 0
    return (n - 1).bit_length()


FUNCTIONS = {
    "log2ceil": lambda a: log2ceil(a),
    "log2": lambda a: int(a).bit_length() - 1 if int(a) > 0 else 0,
    "max": lambda *a: max(a),
    "min": lambda *a: min(a),
    "maximum": lambda *a: max(a),
    "minimum": lambda *a: min(a),
    "ecccodewordwidth": lambda a: int(a) + eccparitybits(int(a)) + 1,
    "eccparitybits": lambda a: eccparitybits(int(a)),
    "slotbits": lambda a: max(1, log2ceil(a)),
    "ceil": lambda a: math.ceil(a),
    "floor": lambda a: math.floor(a),
    "cdiv": lambda a, b: math.ceil(a / b),
}


class Expr:
    """Recursive-descent evaluator for the integer and real expressions of VHDL declarations."""

    def __init__(self, text: str, env: dict[str, Num]):
        self.text = text
        self.tokens = self._tokenize(text)
        self.pos = 0
        self.env = {k.lower(): v for k, v in env.items()}

    @staticmethod
    def _tokenize(text: str) -> list[tuple[str, str]]:
        out = []
        pos = 0
        text = text.strip()
        while pos < len(text):
            m = TOKEN_RE.match(text, pos)
            if not m or m.end() == pos:
                raise CatalogError(f"cannot parse expression '{text}' at '{text[pos:]}'")
            for kind in ("based", "num", "attr", "id", "op"):
                if m.group(kind) is not None:
                    out.append((kind, m.group(kind)))
                    break
            pos = m.end()
            while pos < len(text) and text[pos].isspace():
                pos += 1
        return out

    def peek(self) -> tuple[str, str] | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def take(self) -> tuple[str, str]:
        tok = self.peek()
        if tok is None:
            raise CatalogError(f"unexpected end of expression '{self.text}'")
        self.pos += 1
        return tok

    def evaluate(self) -> Num:
        val = self.expr()
        if self.peek() is not None:
            raise CatalogError(f"unexpected '{self.peek()[1]}' in expression '{self.text}'")
        return val

    def expr(self) -> Num:
        val = self.term()
        while self.peek() and self.peek()[1] in ("+", "-"):
            op = self.take()[1]
            rhs = self.term()
            val = Num(val.value + rhs.value if op == "+" else val.value - rhs.value, val.real or rhs.real)
        return val

    def term(self) -> Num:
        val = self.factor()
        while self.peek() and (self.peek()[1] in ("*", "/") or self.peek()[1].lower() in ("mod", "rem")):
            op = self.take()[1].lower()
            rhs = self.factor()
            real = val.real or rhs.real
            if op == "*":
                val = Num(val.value * rhs.value, real)
            elif op == "/":
                if rhs.value == 0:
                    raise CatalogError(f"division by zero in '{self.text}'")
                if real:
                    val = Num(val.value / rhs.value, True)
                else:
                    q = abs(int(val.value)) // abs(int(rhs.value))
                    val = Num(q if (val.value >= 0) == (rhs.value >= 0) else -q, False)
            else:
                if rhs.value == 0:
                    raise CatalogError(f"division by zero in '{self.text}'")
                val = Num(int(val.value) % int(rhs.value), False)
        return val

    def factor(self) -> Num:
        base = self.unary()
        if self.peek() and self.peek()[1] == "**":
            self.take()
            exp = self.factor()
            return Num(base.value ** exp.value, base.real or exp.real)
        return base

    def unary(self) -> Num:
        tok = self.peek()
        if tok and tok[1] in ("-", "+"):
            self.take()
            val = self.unary()
            return Num(-val.value if tok[1] == "-" else val.value, val.real)
        if tok and tok[0] == "id" and tok[1].lower() == "abs":
            self.take()
            val = self.unary()
            return Num(abs(val.value), val.real)
        return self.primary()

    def primary(self) -> Num:
        kind, text = self.take()
        if kind == "num":
            clean = text.replace("_", "")
            if "." in clean or "e" in clean.lower():
                return Num(float(clean), True)
            return Num(int(clean), False)
        if kind == "based":
            base, digits, _ = text.split("#")
            return Num(int(digits.replace("_", ""), int(base)), False)
        if kind == "op" and text == "(":
            val = self.expr()
            if self.take()[1] != ")":
                raise CatalogError(f"missing ')' in '{self.text}'")
            return val
        if kind == "id":
            name = text.lower()
            if self.peek() and self.peek()[1] == "(":
                self.take()
                args = [self.expr()]
                while self.peek() and self.peek()[1] == ",":
                    self.take()
                    args.append(self.expr())
                if self.take()[1] != ")":
                    raise CatalogError(f"missing ')' in '{self.text}'")
                if name not in FUNCTIONS:
                    raise CatalogError(f"unknown function '{text}' in '{self.text}'")
                res = FUNCTIONS[name](*[a.value for a in args])
                return Num(res, isinstance(res, float))
            if self.peek() and self.peek()[0] == "attr":
                attr = self.take()[1].lower()
                if name in ("positive", "natural", "integer") and attr == "'high":
                    return Num(INT_MAX, False)
                raise CatalogError(f"unsupported attribute '{text}{attr}' in '{self.text}'")
            if name in self.env:
                return self.env[name]
            raise CatalogError(f"unknown name '{text}' in '{self.text}'")
        raise CatalogError(f"unexpected '{text}' in '{self.text}'")


def evaluate(text: str, env: dict[str, Num]) -> Num:
    return Expr(text, env).evaluate()


def try_evaluate(text: str, env: dict[str, Num]) -> Num | None:
    try:
        return evaluate(text, env)
    except CatalogError:
        return None


# ---------------------------------------------------------------------------------------------------------------------
# VHDL entity parser
# ---------------------------------------------------------------------------------------------------------------------
@dataclass
class VhdlGeneric:
    name: str
    vtype: str
    default: str | None


@dataclass
class VhdlPort:
    name: str
    mode: str
    vtype: str
    default: str | None


@dataclass
class VhdlEntity:
    name: str
    generics: list[VhdlGeneric] = field(default_factory=list)
    ports: list[VhdlPort] = field(default_factory=list)


def strip_comments(text: str) -> str:
    out = []
    for line in text.splitlines():
        cut = None
        in_str = False
        i = 0
        while i < len(line):
            ch = line[i]
            if ch == '"':
                in_str = not in_str
            elif not in_str and line.startswith("--", i):
                cut = i
                break
            i += 1
        out.append(line if cut is None else line[:cut])
    return "\n".join(out)


def matching_paren(text: str, open_pos: int) -> int:
    depth = 0
    for i in range(open_pos, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return i
    raise CatalogError("unbalanced parentheses in entity declaration")


def split_top(text: str, sep: str) -> list[str]:
    parts, depth, cur = [], 0, []
    in_str = False
    for ch in text:
        if ch == '"':
            in_str = not in_str
        if not in_str:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
        if ch == sep and depth == 0 and not in_str:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    parts.append("".join(cur))
    return [p.strip() for p in parts if p.strip()]


def split_default(text: str) -> tuple[str, str | None]:
    depth = 0
    for i in range(len(text) - 1):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
        elif depth == 0 and text[i : i + 2] == ":=":
            return text[:i].strip(), text[i + 2 :].strip()
    return text.strip(), None


def parse_section(body: str, keyword: str) -> str | None:
    m = re.search(rf"\b{keyword}\s*\(", body, re.IGNORECASE)
    if not m:
        return None
    start = m.end() - 1
    end = matching_paren(body, start)
    return body[start + 1 : end]


def parse_entity(text: str, name: str) -> VhdlEntity:
    clean = strip_comments(text)
    m = re.search(rf"\bentity\s+{re.escape(name)}\s+is\b", clean, re.IGNORECASE)
    if not m:
        raise CatalogError(f"entity {name} not found")
    end = re.search(r"\bend\s+(entity\b|" + re.escape(name) + r"\b)", clean[m.end() :], re.IGNORECASE)
    if not end:
        raise CatalogError(f"end of entity {name} not found")
    body = clean[m.end() : m.end() + end.start()]
    ent = VhdlEntity(name)
    port_m = re.search(r"\bport\s*\(", body, re.IGNORECASE)
    gen_body = body[: port_m.start()] if port_m else body
    gens = parse_section(gen_body, "generic")
    if gens:
        for decl in split_top(gens, ";"):
            names, rest = decl.split(":", 1)
            vtype, default = split_default(rest)
            for n in names.split(","):
                ent.generics.append(VhdlGeneric(n.strip(), " ".join(vtype.split()), default and " ".join(default.split())))
    ports = parse_section(body[port_m.start() :], "port") if port_m else None
    if ports:
        for decl in split_top(ports, ";"):
            names, rest = decl.split(":", 1)
            rest = rest.strip()
            mm = re.match(r"(in|out|inout|buffer)\b\s*(.*)$", rest, re.IGNORECASE | re.DOTALL)
            if not mm:
                raise CatalogError(f"port declaration without mode: '{decl}'")
            vtype, default = split_default(mm.group(2))
            for n in names.split(","):
                ent.ports.append(
                    VhdlPort(n.strip(), mm.group(1).lower(), " ".join(vtype.split()), default and " ".join(default.split()))
                )
    return ent


def parse_constants(text: str) -> dict[str, str]:
    clean = strip_comments(text)
    out = {}
    for m in re.finditer(r"\bconstant\s+(\w+)\s*:\s*([^;]*?):=\s*([^;]+);", clean, re.IGNORECASE):
        out[m.group(1)] = " ".join(m.group(3).split())
    return out


# ---------------------------------------------------------------------------------------------------------------------
# Types and widths
# ---------------------------------------------------------------------------------------------------------------------
VECTOR_RE = re.compile(r"^(std_logic_vector|std_ulogic_vector|unsigned|signed)\s*\((.*)\)$", re.IGNORECASE | re.DOTALL)


def width_expr(vtype: str) -> str | None:
    """Width of a port type as an expression text, or None for types without a bit width."""
    t = vtype.strip()
    if t.lower() in ("std_logic", "std_ulogic"):
        return "1"
    m = VECTOR_RE.match(t)
    if not m:
        return None
    rng = m.group(2)
    mm = re.match(r"(.*)\s+(downto|to)\s+(.*)$", rng, re.IGNORECASE | re.DOTALL)
    if not mm:
        return None
    hi, direction, lo = mm.group(1).strip(), mm.group(2).lower(), mm.group(3).strip()
    if direction == "to":
        hi, lo = lo, hi
    if lo == "0":
        m2 = re.match(r"^(.*?)\s*-\s*1$", hi)
        if m2 and depth_ok(m2.group(1)):
            return simplify_parens(m2.group(1))
        if re.fullmatch(r"\d+", hi):
            return str(int(hi) + 1)
        return f"({hi}) + 1"
    return f"({hi}) - ({lo}) + 1"


def depth_ok(text: str) -> bool:
    depth = 0
    for ch in text:
        depth += ch == "("
        depth -= ch == ")"
        if depth < 0:
            return False
    return depth == 0


def simplify_parens(text: str) -> str:
    t = text.strip()
    while t.startswith("(") and t.endswith(")") and depth_ok(t[1:-1]) and matching_paren(t, 0) == len(t) - 1:
        t = t[1:-1].strip()
    return t


def generic_kind(vtype: str, env: dict[str, Num]) -> tuple[str, int | float | None, int | float | None]:
    """Composer kind of a VHDL generic type, with its range."""
    t = " ".join(vtype.lower().split())
    m = re.match(r"^(positive|natural|integer)(?:\s+range\s+(.+?)\s+to\s+(.+))?$", t)
    if m:
        lo = {"positive": 1, "natural": 0, "integer": -INT_MAX - 1}[m.group(1)]
        hi = INT_MAX
        if m.group(2):
            lo = evaluate(m.group(2), env).value
            hi = evaluate(m.group(3), env).value
        return "integer", int(lo), int(hi)
    if t == "real":
        return "real", None, None
    if t == "boolean":
        return "boolean", None, None
    if t in ("std_logic", "std_ulogic"):
        return "std_logic", None, None
    if t.startswith("std_logic_vector"):
        return "std_logic_vector", None, None
    if t == "string":
        return "string", None, None
    if t == "integer_vector":
        return "integer_vector", None, None
    return "opaque", None, None


def slv_value(text: str) -> tuple[str, int, int | None] | None:
    """Normalize a std_logic_vector literal: ('bits', value, length) or ('others', bit, None). A sized literal
    (VHDL-2008, 22x"3FC000") has its size as length; the bits it drops on the left must be zero."""
    t = text.strip()
    m = re.fullmatch(r'(\d*)[xX]"([0-9a-fA-F_]*)"', t)
    if m:
        digits = m.group(2).replace("_", "")
        value, length = int(digits or "0", 16), 4 * len(digits)
    else:
        m = re.fullmatch(r'(?:(\d*)[bB]|())"([01_]*)"', t)
        if m:
            digits = m.group(3).replace("_", "")
            value, length = int(digits or "0", 2), len(digits)
    if m:
        if m.group(1):
            length = int(m.group(1))
            if value >= 2 ** length:
                return None
        return ("bits", value, length)
    m = re.fullmatch(r"\(\s*others\s*=>\s*'([01])'\s*\)", t, re.IGNORECASE)
    if m:
        return ("others", int(m.group(1)), None)
    return None


def default_to_json(kind: str, text: str | None, env: dict[str, Num]) -> tuple[Any, bool]:
    """JSON value of a VHDL generic default and whether it is representable (editable)."""
    if text is None:
        return None, True
    t = text.strip()
    if kind == "boolean":
        if t.lower() in ("true", "false"):
            return t.lower() == "true", True
        return None, False
    if kind == "integer":
        val = try_evaluate(t, env)
        return (int(val.value), True) if val is not None and not val.real else (None, False)
    if kind == "real":
        val = try_evaluate(t, env)
        return (float(val.value), True) if val is not None else (None, False)
    if kind == "std_logic":
        m = re.fullmatch(r"'([01])'", t)
        return (m.group(1), True) if m else (None, False)
    if kind == "std_logic_vector":
        return (t, True) if slv_value(t) is not None else (None, False)
    if kind == "string":
        m = re.fullmatch(r'"(.*)"', t)
        return (m.group(1), True) if m else (None, False)
    if kind == "integer_vector":
        return (t, True)
    return None, False


def json_to_vhdl(kind: str, value: Any) -> str:
    if kind == "boolean":
        return "true" if value else "false"
    if kind == "integer":
        return str(int(value))
    if kind == "real":
        return repr(float(value))
    if kind == "std_logic":
        return f"'{value}'"
    if kind == "string":
        return f'"{value}"'
    return str(value)


def same_default(kind: str, catalog_value: Any, vhdl_text: str | None, env: dict[str, Num]) -> bool:
    if vhdl_text is None:
        return catalog_value is None
    if catalog_value is None:
        return False
    if kind == "std_logic_vector":
        return slv_value(str(catalog_value)) == slv_value(vhdl_text)
    if kind in ("integer", "real"):
        a = try_evaluate(json_to_vhdl(kind, catalog_value), env)
        b = try_evaluate(vhdl_text, env)
        return a is not None and b is not None and math.isclose(float(a.value), float(b.value), rel_tol=1e-12)
    if kind == "integer_vector":
        return "".join(str(catalog_value).split()) == "".join(vhdl_text.split())
    return json_to_vhdl(kind, catalog_value).lower() == vhdl_text.strip().lower()


# ---------------------------------------------------------------------------------------------------------------------
# Catalog source
# ---------------------------------------------------------------------------------------------------------------------
def load_yaml(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f)


@dataclass
class Context:
    repos: Path
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    # rules that refer to other blocks, checked when all blocks are built
    size_chains: list[tuple[str, dict]] = field(default_factory=list)
    type_ids: set[str] = field(default_factory=set)

    def err(self, where: str, msg: str) -> None:
        self.errors.append(f"{where}: {msg}")

    def warn(self, where: str, msg: str) -> None:
        self.warnings.append(f"{where}: {msg}")


def require(obj: dict, key: str, where: str) -> Any:
    if not isinstance(obj, dict) or key not in obj:
        raise CatalogError(f"{where}: missing '{key}'")
    return obj[key]


def load_sources(ctx: Context, resolve: bool = True) -> dict[str, dict]:
    data = load_yaml(CATALOG_DIR / "sources.yml")
    sources = {}
    for src in require(data, "sources", "sources.yml"):
        sid = require(src, "id", "sources.yml")
        for key in ("name", "repo", "url", "library", "file_list"):
            require(src, key, f"sources.yml {sid}")
        if ("commit" in src) == ("tag" in src):
            raise CatalogError(f"sources.yml {sid}: give exactly one of 'commit' or 'tag'")
        if not resolve:
            sources[sid] = dict(src)
            continue
        repo = ctx.repos / src["repo"]
        if not repo.is_dir():
            raise CatalogError(f"sources.yml {sid}: local clone {repo} not found (set --repos)")
        rev = src.get("commit") or src["tag"]
        sha = git(repo, "rev-parse", f"{rev}^{{commit}}").strip()
        if "commit" in src and sha != src["commit"]:
            raise CatalogError(f"sources.yml {sid}: commit must be the full 40-digit hash, got {src['commit']}")
        src = dict(src)
        src["sha"] = sha
        sources[sid] = src
    return sources


def check_source_published(ctx: Context, src: dict) -> None:
    repo = ctx.repos / src["repo"]
    where = f"sources.yml {src['id']}"
    if "tag" in src:
        remote = git(repo, "ls-remote", "--tags", "origin", f"refs/tags/{src['tag']}").strip()
        if not remote:
            ctx.err(where, f"tag {src['tag']} is not on origin")
        return
    branch = src.get("branch", "main")
    if not git_ok(repo, "merge-base", "--is-ancestor", src["sha"], f"origin/{branch}"):
        ctx.err(where, f"commit {src['sha'][:10]} is not on origin/{branch} (not pushed)")
        return
    head = git(repo, "rev-parse", f"origin/{branch}").strip()
    if head != src["sha"]:
        ctx.warn(where, f"origin/{branch} has moved on to {head[:10]}; update the pin and rerun the check")


def package_env(ctx: Context, src: dict, packages: list[str]) -> dict[str, Num]:
    env: dict[str, Num] = {}
    raw: dict[str, str] = {}
    repo = ctx.repos / src["repo"]
    for path in packages:
        raw.update(parse_constants(git(repo, "show", f"{src['sha']}:{path}")))
    for _ in range(4):
        for name, text in raw.items():
            if name.lower() in env:
                continue
            val = try_evaluate(text, env)
            if val is not None:
                env[name.lower()] = val
    return env


# words of a VHDL expression that are no identifiers to resolve
VHDL_WORDS = {"others", "and", "or", "not", "xor", "nand", "nor", "xnor", "downto", "to", "true", "false", "mod", "rem",
              "abs", "sll", "srl", "sla", "sra", "rol", "ror", "null", "open"}
_PACKAGE_INDEX: dict[str, dict[str, str]] = {}
_PACKAGE_NAMES: dict[tuple[str, str], set[str]] = {}


def package_index(ctx: Context, src: dict) -> dict[str, str]:
    """Package name (lower case) -> file of the repository at the pinned commit that declares it."""
    if src["id"] not in _PACKAGE_INDEX:
        out = git_ok_output(ctx.repos / src["repo"], "grep", "-i", "-E", r"^\s*package\s+[a-z0-9_]+\s+is\b", src["sha"], "--", "*.vhd")
        index: dict[str, str] = {}
        for line in out.splitlines():
            # <sha>:<path>:<text>
            _, path, text = line.split(":", 2)
            m = re.match(r"\s*package\s+(\w+)\s+is\b", text, re.I)
            if m and m.group(1).lower() != "body":
                index.setdefault(m.group(1).lower(), path)
        _PACKAGE_INDEX[src["id"]] = index
    return _PACKAGE_INDEX[src["id"]]


def package_names(ctx: Context, src: dict, path: str) -> set[str]:
    """Names (lower case) that the declaration of a package makes visible: constants, functions, types, subtypes."""
    key = (src["id"], path)
    if key not in _PACKAGE_NAMES:
        text = strip_comments(git(ctx.repos / src["repo"], "show", f"{src['sha']}:{path}"))
        body = re.search(r"\bpackage\s+body\b", text, re.I)
        decl = text[: body.start()] if body else text
        names: set[str] = set()
        for m in re.finditer(r"\bconstant\s+([\w\s,]+?)\s*:", decl, re.I):
            names.update(n.strip().lower() for n in m.group(1).split(","))
        for kw in ("function", "type", "subtype"):
            names.update(m.group(1).lower() for m in re.finditer(rf"\b{kw}\s+(\w+)", decl, re.I))
        _PACKAGE_NAMES[key] = names
    return _PACKAGE_NAMES[key]


def qualify_expression(ctx: Context, b: dict, src: dict, sources: dict, entity_text: str, expr: str,
                       generic_names: set[str]) -> tuple[str, list[str]]:
    """The expression with every package identifier written as <library>.<package>.<name>, found through the use
    clauses of the entity file at the pinned commit; and the identifiers that cannot be resolved."""
    head = re.split(rf"\bentity\s+{re.escape(b['entity'])}\s+is\b", strip_comments(entity_text), maxsplit=1, flags=re.I)[0]
    uses = re.findall(r"^\s*use\s+(\w+)\s*\.\s*(\w+)\s*\.\s*all\s*;", head, re.M | re.I)
    by_library = {s["library"].lower(): s for s in sources.values()}
    out = []
    unresolved = []
    i = 0
    while i < len(expr):
        ch = expr[i]
        if ch == '"':
            j = expr.index('"', i + 1) + 1
            out.append(expr[i:j])
            i = j
            continue
        if ch == "'" and i + 2 < len(expr) and expr[i + 2] == "'":
            out.append(expr[i:i + 3])
            i += 3
            continue
        m = re.match(r"[A-Za-z]\w*", expr[i:])
        if not m or (i > 0 and (expr[i - 1].isalnum() or expr[i - 1] in "_.'")):
            out.append(ch)
            i += 1
            continue
        word = m.group(0)
        j = i + len(word)
        # base specifier of a bit-string literal (x"FE"), or a selected name that is already qualified
        if (j < len(expr) and expr[j] in '".') or word.lower() in VHDL_WORDS:
            out.append(word)
            i = j
            continue
        found = None
        for lib, pkg in uses:
            owner = src if lib.lower() == "work" else by_library.get(lib.lower())
            if owner is None:
                continue
            path = package_index(ctx, owner).get(pkg.lower())
            if path and word.lower() in package_names(ctx, owner, path):
                found = f"{owner['library'] if lib.lower() == 'work' else lib}.{pkg}.{word}"
                break
        if found is None:
            unresolved.append(word + (" (a generic of the entity)" if word in generic_names else ""))
        out.append(found or word)
        i = j
    return "".join(out), unresolved


def flip(direction: str) -> str:
    return {"in": "out", "out": "in"}.get(direction, direction)


def load_types() -> dict[str, dict]:
    data = load_yaml(CATALOG_DIR / "types.yml")
    types = {}
    for t in require(data, "types", "types.yml"):
        tid = require(t, "id", "types.yml")
        where = f"types.yml {tid}"
        if tid in types:
            raise CatalogError(f"{where}: duplicate type")
        kind = require(t, "kind", where)
        if kind not in TYPE_KINDS:
            raise CatalogError(f"{where}: unknown kind '{kind}'")
        for key in ("name", "color", "description"):
            require(t, key, where)
        if not re.fullmatch(r"#[0-9A-F]{6}", t["color"]):
            raise CatalogError(f"{where}: color must be #RRGGBB in upper case")
        sigs = t.get("signals") or {}
        for sname, sdef in sigs.items():
            if sdef.get("dir") not in ("in", "out"):
                raise CatalogError(f"{where}: signal {sname} needs dir in/out")
            if "absent" in sdef and sdef["absent"] not in ("0", "1"):
                raise CatalogError(f"{where}: signal {sname}: absent must be '0' or '1'")
            # pins are external only: no connection between two blocks can lack them
            if sdef.get("optional") and kind != "pins" and "absent" not in sdef:
                raise CatalogError(f"{where}: optional signal {sname} needs an absent value")
        if t.get("needsLast") and (sigs.get("last") is None or sigs["last"].get("optional")):
            raise CatalogError(f"{where}: needsLast needs a last signal that is not optional")
        if t.get("fields") not in (None, "in", "out", "mixed"):
            raise CatalogError(f"{where}: fields must be in, out or mixed")
        if "cdc" in t and t["cdc"] not in CDC_MODES:
            raise CatalogError(f"{where}: cdc must be one of {', '.join(sorted(CDC_MODES))}")
        if kind in ("event", "bus") and "cdc" not in t and not t.get("generic"):
            raise CatalogError(f"{where}: event and bus types need a cdc mode")
        types[tid] = t
    for t in types.values():
        for acc in t.get("accepts") or []:
            if acc.get("type") not in types:
                raise CatalogError(f"types.yml {t['id']}: accepts unknown type {acc.get('type')}")
            if acc.get("condition") not in (None, "liteWhen"):
                raise CatalogError(f"types.yml {t['id']}: unknown accept condition {acc.get('condition')}")
            if acc.get("sideband") not in (None, "required"):
                raise CatalogError(f"types.yml {t['id']}: sideband must be 'required'")
            # a signal that one of the two types lacks needs the value it takes in such a connection
            src = types[acc["type"]]
            mine = t.get("signals") or {}
            theirs = src.get("signals") or {}
            for sname, sdef in theirs.items():
                if sdef["dir"] == "in" and sname not in mine and "absent" not in sdef:
                    raise CatalogError(f"types.yml {src['id']}: signal {sname} needs an absent value ({t['id']} accepts {src['id']} without it)")
            for sname, sdef in mine.items():
                replaced = acc.get("sideband") == "required" and sname == "user"
                if sdef["dir"] == "out" and sname not in theirs and not replaced and "absent" not in sdef:
                    raise CatalogError(f"types.yml {t['id']}: signal {sname} needs an absent value ({acc['type']} lacks it)")
        for br in t.get("bridges") or []:
            if br.get("type") not in types:
                raise CatalogError(f"types.yml {t['id']}: bridge to unknown type {br.get('type')}")
    return types


def build_block(ctx: Context, b: dict, sources: dict, types: dict, groups: dict) -> dict | None:
    bid = require(b, "id", "block")
    where = f"block {bid}"
    for key in ("kind", "name", "source", "entity", "path", "summary", "group"):
        require(b, key, where)
    if b["kind"] not in ("core", "module", "olo"):
        raise CatalogError(f"{where}: kind must be core, module or olo")
    if b["group"] not in groups:
        raise CatalogError(f"{where}: unknown palette group '{b['group']}'")
    src = sources.get(b["source"])
    if src is None:
        raise CatalogError(f"{where}: unknown source '{b['source']}'")
    repo = ctx.repos / src["repo"]
    text = git(repo, "show", f"{src['sha']}:{b['path']}")
    ent = parse_entity(text, b["entity"])
    env = package_env(ctx, src, b.get("packages") or [])

    # Generics: VHDL is authoritative for name, type and default; the YAML adds presentation and rules
    meta = {g["name"]: g for g in (b.get("generics") or [])}
    for name in meta:
        if name not in {g.name for g in ent.generics}:
            ctx.err(where, f"generic {name} is not a generic of {ent.name}")
    generics = []
    defaults_env = dict(env)
    for g in ent.generics:
        kind, lo, hi = generic_kind(g.vtype, env)
        default, representable = default_to_json(kind, g.default, defaults_env)
        m = meta.get(g.name, {})
        gen = {"name": g.name, "vhdlType": g.vtype, "kind": kind if representable else "opaque"}
        if kind == "integer":
            gen["min"], gen["max"] = lo, hi
        if g.default is None:
            gen["required"] = True
        else:
            gen["defaultText"] = g.default
            if representable:
                gen["default"] = default
            else:
                # the generic map of a top level names package constants fully qualified (no use clauses there)
                qualified, unresolved = qualify_expression(ctx, b, src, sources, text, g.default,
                                                           {x.name for x in ent.generics})
                for word in unresolved:
                    ctx.err(where, f"generic {g.name}: default {g.default} names {word}, which no package of the use clauses declares")
                if qualified != g.default:
                    gen["defaultVhdl"] = qualified
        for key in ("label", "description", "choices", "check", "advanced", "fromClock", "unit", "min", "max", "follow",
                    "enabledBy"):
            if key in m:
                gen[key] = m[key]
        if "follow" in m:
            fol = m["follow"]
            if kind != "integer" or not isinstance(fol, dict) or fol.get("measure") not in FOLLOW_MEASURES \
                    or not isinstance(fol.get("interfaces"), list) or not fol["interfaces"]:
                ctx.err(where, f"generic {g.name}: follow needs an integer generic, interfaces and measure data, user, packed or generic")
            elif fol.get("measure") == "generic" and not isinstance(fol.get("generic"), str):
                ctx.err(where, f"generic {g.name}: follow with measure generic names the generic of the partner")
            elif not isinstance(fol.get("rank", 0), int) or isinstance(fol.get("rank", 0), bool):
                ctx.err(where, f"generic {g.name}: follow rank must be an integer")
        if "min" in m and kind == "integer" and m["min"] < lo:
            ctx.err(where, f"generic {g.name}: min {m['min']} below the VHDL range {lo}")
        if "max" in m and kind == "integer" and m["max"] > hi:
            ctx.err(where, f"generic {g.name}: max {m['max']} above the VHDL range {hi}")
        if "check" in m and m["check"] not in GENERIC_CHECKS:
            ctx.err(where, f"generic {g.name}: unknown check {m['check']}")
        if "choices" in m:
            if kind not in ("string", "integer"):
                ctx.err(where, f"generic {g.name}: choices only for string and integer generics")
            elif representable and default is not None and default not in m["choices"]:
                ctx.err(where, f"generic {g.name}: default '{default}' not in choices")
        if g.default is None and "example" in m:
            gen["example"] = m["example"]
        if g.default is None and "example" not in m:
            ctx.err(where, f"generic {g.name} has no VHDL default: give an 'example' value")
        generics.append(gen)
        if representable and default is not None and kind in ("integer", "real"):
            defaults_env[g.name.lower()] = Num(default, kind == "real")
        elif "example" in m and kind in ("integer", "real"):
            defaults_env[g.name.lower()] = Num(m["example"], kind == "real")
    gen_names = {g["name"] for g in generics}
    for g in generics:
        dep = g.get("enabledBy")
        if dep is not None:
            target = next((x for x in generics if x["name"] == dep), None)
            if target is None or target["kind"] != "boolean" or dep == g["name"]:
                ctx.err(where, f"generic {g['name']}: enabledBy must name another boolean generic")

    # Ports
    ports = []
    port_by_name = {}
    for p in ent.ports:
        wtxt = width_expr(p.vtype)
        width = None
        if wtxt is not None:
            # substitute package constants so that the catalog only refers to generics
            width = substitute_constants(wtxt, env)
        port = {"name": p.name, "dir": p.mode, "vhdlType": p.vtype, "width": width}
        if p.default is not None:
            port["default"] = p.default
        ports.append(port)
        port_by_name[p.name] = port

    used: dict[str, str] = {}

    def use(port_name: str, owner: str) -> dict | None:
        if port_name not in port_by_name:
            ctx.err(where, f"{owner}: {port_name} is not a port of {ent.name}")
            return None
        if port_name in used:
            ctx.err(where, f"{owner}: port {port_name} already used by {used[port_name]}")
        used[port_name] = owner
        return port_by_name[port_name]

    # Clocks and resets
    clocks = []
    for c in b.get("clocks") or []:
        unknown = set(c) - {"port", "primary", "output", "frequency", "label", "description", "freqGeneric"}
        if unknown:
            ctx.err(where, f"clock {c.get('port')}: unknown keys {', '.join(sorted(map(str, unknown)))}")
        p = use(require(c, "port", where), "clocks")
        expected_dir = "out" if c.get("output") else "in"
        if p and (p["dir"] != expected_dir or p["width"] != "1"):
            ctx.err(where, f"clock {c['port']} must be a std_logic {'output' if c.get('output') else 'input'}")
        if c.get("output") and ("frequency" not in c or c.get("primary")):
            ctx.err(where, f"clock output {c['port']} needs a frequency and cannot be primary")
        if "freqGeneric" in c and c["freqGeneric"] not in gen_names:
            ctx.err(where, f"clock {c['port']}: unknown frequency generic {c['freqGeneric']}")
        clocks.append({k: v for k, v in c.items()})
    clock_ports = {c["port"] for c in clocks}
    if clocks and sum(1 for c in clocks if c.get("primary")) != 1:
        ctx.err(where, "exactly one clock must be primary")
    for c in clocks:
        if c.get("output") and try_evaluate(str(c["frequency"]), defaults_env) is None:
            ctx.err(where, f"clock output {c['port']}: frequency '{c['frequency']}' cannot be evaluated")
    resets = []
    for r in b.get("resets") or []:
        unknown = set(r) - {"port", "dir", "active", "sync", "clock", "description"}
        if unknown:
            ctx.err(where, f"reset {r.get('port')}: unknown keys {', '.join(sorted(map(str, unknown)))}")
        p = use(require(r, "port", where), "resets")
        if p and p["width"] != "1":
            ctx.err(where, f"reset {r['port']} must be a std_logic")
        if r.get("dir", "in") != (p["dir"] if p else "in"):
            ctx.err(where, f"reset {r['port']}: direction differs from the VHDL")
        if r.get("clock") and r["clock"] not in clock_ports:
            ctx.err(where, f"reset {r['port']}: unknown clock {r['clock']}")
        # a reset input that gets the unsynchronised system reset (asynchronous, or without a clock): the system has no
        # timing exception on Rst, so the block must release it through olo_base_reset_gen, whose scoped constraints
        # cut the paths into its synchronisers
        if r.get("dir", "in") == "in" and (r.get("sync") == "async" or not r.get("clock")) and b["entity"] != "olo_base_reset_gen":
            for line, how in raw_reset_uses(text, r["port"]):
                ctx.err(where, f"reset {r['port']} gets the unsynchronised system reset, but {b['path']} line {line} uses it {how}; "
                               "it may only feed RstIn of olo_base_reset_gen (or declare the reset synchronous to a clock)")
        resets.append(dict(r))

    # Interfaces
    interfaces = []
    names = set()
    for itf in b.get("interfaces") or []:
        iname = require(itf, "name", where)
        iwhere = f"{where} interface {iname}"
        if iname in names:
            ctx.err(iwhere, "duplicate interface name")
        names.add(iname)
        tid = require(itf, "type", iwhere)
        role = require(itf, "role", iwhere)
        ttype = types.get(tid)
        if ttype is None:
            ctx.err(iwhere, f"unknown type {tid}")
            continue
        if role not in ROLES or ttype["kind"] not in ROLE_KINDS[role]:
            ctx.err(iwhere, f"role {role} does not fit a {ttype['kind']} type")
            continue
        clock = itf.get("clock")
        if clock is not None and clock not in clock_ports:
            ctx.err(iwhere, f"unknown clock {clock}")
        if clock is None and ttype["kind"] != "pins" and clocks:
            ctx.err(iwhere, "needs a clock")
        sigmap = dict(itf.get("signals") or {})
        prefix = itf.get("prefix")
        tsigs = ttype.get("signals") or {}
        if prefix:
            for sname in tsigs:
                if sname not in sigmap and (prefix + sname) in port_by_name:
                    sigmap[sname] = prefix + sname
        count = itf.get("vector")
        count_val = 1
        if count is not None:
            cv = try_evaluate(str(count), defaults_env)
            if cv is None:
                ctx.err(iwhere, f"vector count '{count}' cannot be evaluated")
            else:
                count_val = int(cv.value)
        signals = {}
        for sname, pname in sigmap.items():
            sdef = tsigs.get(sname)
            if sdef is None:
                if ttype.get("fields") is None:
                    ctx.err(iwhere, f"type {tid} has no signal '{sname}'")
                    continue
                if ttype["fields"] == "mixed":
                    if not isinstance(pname, dict) or pname.get("dir") not in ("in", "out") or "port" not in pname:
                        ctx.err(iwhere, f"field '{sname}' of a mixed type needs {{port, dir}}")
                        continue
                    base_dir = pname["dir"]
                    pname = pname["port"]
                else:
                    base_dir = ttype["fields"]
            else:
                base_dir = sdef["dir"]
            if not isinstance(pname, str):
                ctx.err(iwhere, f"signal '{sname}' must map to a port name")
                continue
            expected = flip(base_dir) if role in FLIPPED_ROLES else base_dir
            p = use(pname, f"interface {iname}")
            if p is None:
                continue
            if p["dir"] != expected:
                ctx.err(iwhere, f"{pname} is '{p['dir']}' but signal '{sname}' of a {role} must be '{expected}'")
            signals[sname] = pname
        for sname, sdef in tsigs.items():
            if not sdef.get("optional") and sname not in signals:
                ctx.err(iwhere, f"required signal '{sname}' of type {tid} not mapped")
        out = {"name": iname, "type": tid, "role": role}
        for key in ("clock", "label", "description", "mustServe", "externalOnly", "enabledBy", "sideband",
                    "params", "vector", "tieOff", "carry", "userFields", "needsLast", "clockSignals", "asyncSignals",
                    "addressSpace", "irqRegisters", "memory"):
            if key in itf:
                out[key] = itf[key]
        mem = itf.get("memory")
        if mem is not None and (tid != "ecc.event" or not (isinstance(mem, str) or (isinstance(mem, list) and all(isinstance(x, str) for x in mem)))):
            ctx.err(iwhere, "memory names the memory whose errors an ecc.event interface reports (a text, or one per element)")
        for cs in itf.get("clockSignals") or []:
            if cs not in signals or role != "pins":
                ctx.err(iwhere, f"clockSignals: {cs} is not a signal of these pins")
        for an in itf.get("asyncSignals") or []:
            if an not in signals:
                ctx.err(iwhere, f"asyncSignals: {an} is not a signal of the interface")
        if itf.get("needsLast") and (role != "sink" or "last" not in signals):
            ctx.err(iwhere, "needsLast is for a sink with a last signal")
        # needsLast: always (true), or while the boolean generic it names is true
        needs_last = itf.get("needsLast")
        if needs_last is not None and needs_last is not True and \
                next((g["kind"] for g in generics if g["name"] == needs_last), None) != "boolean":
            ctx.err(iwhere, "needsLast is true or names a boolean generic of the block")
        for uf in itf.get("userFields") or []:
            if "user" not in signals:
                ctx.err(iwhere, "userFields need a user signal")
            for key in ("name", "label", "lsb", "bits"):
                if key not in uf:
                    ctx.err(iwhere, f"user field needs '{key}'")
            if set(uf) - FIELD_KEYS:
                ctx.err(iwhere, f"user field {uf.get('name')}: unknown keys {', '.join(sorted(map(str, set(uf) - FIELD_KEYS)))}")
        if "carry" in itf and (itf["carry"] not in ("native", "packed") or not ttype.get("generic")):
            ctx.err(iwhere, "carry (native or packed) is only for untyped interfaces")
        out["signals"] = signals
        # element widths of data/keep/user (vector interfaces divide by the count)
        widths = {}
        for sname in ("data", "keep", "user"):
            if sname in signals:
                w = port_by_name[signals[sname]]["width"]
                if w is not None and count is not None:
                    m = re.fullmatch(rf"\(?\s*{re.escape(str(count))}\s*\*\s*(.+?)\s*\)?", w)
                    widths[sname] = m.group(1) if m and depth_ok(m.group(1)) else f"({w}) / ({count})"
                elif w is not None:
                    widths[sname] = w
        if widths:
            out["widths"] = widths
        if count is not None:
            for sname, pname in signals.items():
                w = port_by_name[pname]["width"]
                wv = try_evaluate(w, defaults_env) if w else None
                if wv is not None and int(wv.value) % count_val != 0:
                    ctx.err(iwhere, f"width of {pname} is not a multiple of the vector count {count}")
        if "enabledBy" in itf and itf["enabledBy"] not in gen_names:
            ctx.err(iwhere, f"enabledBy refers to unknown generic {itf['enabledBy']}")
        tie = itf.get("tieOff")
        if tie is not None:
            inputs = [pn for pn in signals.values() if port_by_name[pn]["dir"] == "in"]
            if tie == "default":
                missing = [pn for pn in inputs if port_by_name[pn].get("default") is None]
                if missing:
                    ctx.err(iwhere, f"tieOff default, but {', '.join(missing)} has no VHDL default")
            elif tie == "open":
                if inputs:
                    ctx.err(iwhere, f"tieOff open, but the interface has inputs ({', '.join(inputs)})")
            elif tie == "constant":
                if "sideband" not in itf or inputs != list(signals.values()):
                    ctx.err(iwhere, "tieOff constant needs inputs only and a sideband with the fields of the constant")
            elif tie != "zero":
                ctx.err(iwhere, f"tieOff must be default, open, zero or constant, not {tie}")
        for key, val in (itf.get("params") or {}).items():
            if key == "liteWhen":
                for cond in val:
                    if cond.get("generic") not in gen_names:
                        ctx.err(iwhere, f"liteWhen refers to unknown generic {cond.get('generic')}")
            elif isinstance(val, str) and try_evaluate(val, defaults_env) is None:
                ctx.err(iwhere, f"parameter {key} = '{val}' cannot be evaluated")
        if "sideband" in itf:
            sb = itf["sideband"]
            if sb.get("signal") not in signals:
                ctx.err(iwhere, f"sideband signal {sb.get('signal')} not mapped")
            fields = sb.get("fields") or []
            for f in fields:
                for key in ("name", "label", "lsb", "bits"):
                    if key not in f:
                        ctx.err(iwhere, f"sideband field needs '{key}'")
                if set(f) - FIELD_KEYS:
                    ctx.err(iwhere, f"sideband field {f.get('name')}: unknown keys {', '.join(sorted(map(str, set(f) - FIELD_KEYS)))}")
                below = f.get("below")
                if below is not None and (f.get("kind") == "boolean"
                                          or next((g["kind"] for g in generics if g["name"] == below), None) != "integer"):
                    ctx.err(iwhere, f"sideband field {f.get('name')}: below must name an integer generic of the block")
                dep = f.get("enabledBy")
                if dep is not None:
                    target = next((x for x in fields if x.get("name") == dep), None)
                    if target is None or target.get("kind") != "boolean" or dep == f.get("name"):
                        ctx.err(iwhere, f"sideband field {f.get('name')}: enabledBy must name another boolean field")
        interfaces.append(out)

    # Tie-offs: ports deliberately not part of an interface
    tie_offs = []
    for t in b.get("tieOffs") or []:
        pname = require(t, "port", where)
        p = use(pname, "tieOffs")
        if p is None:
            continue
        value = require(t, "value", f"{where} tie-off {pname}")
        if p["dir"] == "out" and value != "open":
            ctx.err(where, f"tie-off {pname}: an output can only be 'open'")
        if p["dir"] == "in" and value == "open":
            ctx.err(where, f"tie-off {pname}: an input needs a value or 'default'")
        if p["dir"] == "in" and value == "default" and p.get("default") is None:
            ctx.err(where, f"tie-off {pname}: the port has no VHDL default")
        tie_offs.append(dict(t))

    for p in ports:
        if p["name"] not in used:
            ctx.err(where, f"port {p['name']} is not assigned to an interface, clock, reset or tie-off")

    # References of the generic follow rules and of the design rules
    itf_names = {i["name"] for i in interfaces}
    for g in generics:
        for iname in (g.get("follow") or {}).get("interfaces", []):
            if iname not in itf_names:
                ctx.err(where, f"generic {g['name']} follows unknown interface {iname}")
    for r in b.get("rules") or []:
        kind = r.get("kind")
        if kind not in RULE_KINDS:
            ctx.err(where, f"unknown rule kind {kind}")
            continue
        for key in RULE_KINDS[kind]:
            if key not in r:
                ctx.err(where, f"rule {kind} needs '{key}'")
        extra = set(r) - {"kind", "message", "severity", "when"} - set(RULE_KINDS[kind]) - set(RULE_OPTIONAL.get(kind, ()))
        if extra:
            ctx.err(where, f"rule {kind}: unknown keys {', '.join(sorted(map(str, extra)))}")
        refs = [r.get(k) for k in ("clock", "faster", "slower") if r.get(k)]
        for c in refs:
            if c not in clock_ports:
                ctx.err(where, f"rule {kind}: unknown clock {c}")
        # when: a boolean generic, or {generic, is | not: value}, or a list of them that must all hold
        conditions = r.get("when")
        if isinstance(conditions, list) and not conditions:
            ctx.err(where, f"rule {kind}: when is an empty list")
        for when in conditions if isinstance(conditions, list) else [conditions]:
            if isinstance(when, str) and next((g["kind"] for g in generics if g["name"] == when), None) != "boolean":
                ctx.err(where, f"rule {kind}: when names {when}, not a boolean generic")
            elif isinstance(when, dict) and (when.get("generic") not in {g["name"] for g in generics} or len({"is", "not"} & set(when)) != 1):
                ctx.err(where, f"rule {kind}: when needs a generic of the block and one of is or not")
            elif when is not None and not isinstance(when, (str, dict)):
                ctx.err(where, f"rule {kind}: when must be a boolean generic, {{generic, is | not}} or a list of them")
        if kind == "generic_range" and "min" not in r and "max" not in r:
            ctx.err(where, "rule generic_range needs min or max")
        # elements: the elements of an integer_vector generic that the range applies to
        if kind == "generic_range" and ("elements" in r) != (next((g["kind"] for g in generics if g["name"] == r.get("generic")), None) == "integer_vector"):
            ctx.err(where, "rule generic_range: elements goes with an integer_vector generic, and such a generic needs it")
        if kind == "known_defect" and ("generic" in r) != isinstance(r.get("below"), (int, float, str)):
            ctx.err(where, "rule known_defect: generic and below (a number or an expression) go together")
        for gname in [r.get("generic")] + list(r.get("generics") or []):
            if gname and gname not in gen_names:
                ctx.err(where, f"rule {kind}: unknown generic {gname}")
        for iname in list(r.get("interfaces") or []) + ([r["interface"]] if r.get("interface") else []):
            if iname not in itf_names:
                ctx.err(where, f"rule {kind}: unknown interface {iname}")
        if r.get("severity", "error") not in ("error", "warning"):
            ctx.err(where, f"rule {kind}: severity must be error or warning")
        if kind == "flag_dropped":
            if r.get("unlessGeneric") and r["unlessGeneric"] not in gen_names:
                ctx.err(where, f"rule {kind}: unknown generic {r['unlessGeneric']}")
            if r.get("unlessInterface") and r["unlessInterface"] not in itf_names:
                ctx.err(where, f"rule {kind}: unknown interface {r['unlessInterface']}")
            flagged = next((i for i in interfaces if i["name"] == r.get("interface")), None)
            if flagged is not None and r.get("signal") not in flagged["signals"]:
                ctx.err(where, f"rule {kind}: {r.get('signal')} is not a signal of {r.get('interface')}")
        if kind == "vector_within":
            for key in ("generic", "mask"):
                kind_of = next((g["kind"] for g in generics if g["name"] == r.get(key)), None)
                if r.get(key) in gen_names and kind_of != "std_logic_vector":
                    ctx.err(where, f"rule {kind}: {r.get(key)} is not a std_logic_vector generic")
            if r.get("mask") not in gen_names:
                ctx.err(where, f"rule {kind}: unknown generic {r.get('mask')}")
        if kind == "run_rate" and r.get("divider") not in gen_names:
            ctx.err(where, f"rule {kind}: unknown generic {r.get('divider')}")
        if kind == "partner_requires":
            for tid in r.get("types") or []:
                if tid not in ctx.type_ids:
                    ctx.err(where, f"rule {kind}: unknown type {tid}")

    # Constraints
    port_names = {p["name"] for p in ports}
    for k in b.get("constraints") or []:
        kind = k.get("kind")
        if kind not in CONSTRAINT_KINDS:
            ctx.err(where, f"unknown constraint kind {kind}")
            continue
        for key in CONSTRAINT_KINDS[kind]:
            if key not in k:
                ctx.err(where, f"constraint {kind} needs '{key}'")
        for c in k.get("clocks") or []:
            if c not in clock_ports:
                ctx.err(where, f"constraint {kind}: unknown clock {c}")
        for pn in list(k.get("fromPorts") or []) + list(k.get("ports") or []):
            if pn not in port_names:
                ctx.err(where, f"constraint {kind}: unknown port {pn}")

    if "rates" in b:
        check_rates(ctx, where, b["rates"], gen_names, itf_names, clock_ports)
    if "sizes" in b:
        check_sizes(ctx, where, b["sizes"], gen_names, itf_names)
        for ch in (b["sizes"] or {}).get("chains") or [] if isinstance(b["sizes"], dict) else []:
            ctx.size_chains.append((where, ch))

    # Presets
    presets = []
    for pr in b.get("presets") or []:
        for key in ("id", "name", "summary"):
            require(pr, key, f"{where} preset")
        kinds = {g["name"]: g["kind"] for g in generics}
        for gname, val in (pr.get("generics") or {}).items():
            if gname not in gen_names:
                ctx.err(where, f"preset {pr['id']}: unknown generic {gname}")
            elif isinstance(val, dict):
                # {sameAs, why}: the generic follows another generic of the same kind until the user sets it
                target = val.get("sameAs")
                if set(val) - {"sameAs", "why"} or not isinstance(target, str):
                    ctx.err(where, f"preset {pr['id']}: {gname} is a literal or {{sameAs, why}}")
                elif target == gname or kinds.get(target) != kinds[gname]:
                    ctx.err(where, f"preset {pr['id']}: {gname} can follow only another generic of its kind, not {target}")
                elif isinstance((pr.get("generics") or {}).get(target), dict):
                    ctx.err(where, f"preset {pr['id']}: {gname} follows {target}, which follows another generic itself")
        presets.append(dict(pr))

    block = {
        "id": bid,
        "kind": b["kind"],
        "name": b["name"],
        "group": b["group"],
        "source": b["source"],
        "library": src["library"],
        "entity": ent.name,
        "path": b["path"],
        "summary": b["summary"],
        "idPrefix": b.get("idPrefix") or re.sub(r"^(olo_(base|ft|axi)_)", "", ent.name).split("_")[0],
    }
    for key in ("doc", "project", "vendor", "notes", "rules", "constraints", "idRegister", "init", "endToEnd", "rates", "sizes"):
        if key in b:
            block[key] = b[key]
    # software initialisation: steps with optional conditions on boolean generics
    reg = b.get("idRegister")
    if reg is not None and (not isinstance(reg, dict) or set(reg) != {"address", "value"}):
        ctx.err(where, "idRegister needs address and value")
    for step in b.get("init") or []:
        if not isinstance(step, dict) or not isinstance(step.get("text"), str):
            ctx.err(where, "every init step needs a text")
            continue
        for cond in INIT_CONDITIONS:
            for gname in step.get(cond) or []:
                if next((g["kind"] for g in generics if g["name"] == gname), None) != "boolean":
                    ctx.err(where, f"init step: {cond} names {gname}, not a boolean generic")
        if set(step) - {"text", *INIT_CONDITIONS}:
            ctx.err(where, f"init step: unknown keys {', '.join(sorted(set(step) - {'text', *INIT_CONDITIONS}))}")
    # packages of the block (use clauses of the top level when a generic value names one of their constants)
    if b.get("packages"):
        names = []
        for path in b["packages"]:
            m = re.search(r"^\s*package\s+(\w+)\s+is", git(ctx.repos / src["repo"], "show", f"{src['sha']}:{path}"), re.M | re.I)
            if m:
                names.append(m.group(1))
            else:
                ctx.err(where, f"no package in {path}")
        block["packages"] = names
    # the register map of the block at the pin (address map of a system); an address space needs it for its windows
    if "registers" in b:
        checked = check_registers(ctx, where, b, src, interfaces, generics, block)
        if checked:
            block["registers"] = checked
    elif any("addressSpace" in i or "irqRegisters" in i for i in interfaces):
        ctx.err(where, "an addressSpace or irqRegisters needs the registers of the block")
    elif "protection" in b:
        # a block without a register map of its own (Open Logic): the evidence only
        prot = b["protection"]
        if not isinstance(prot, dict) or set(prot) != {"evidence"} or not isinstance(prot["evidence"], str):
            ctx.err(where, "protection of a block without registers needs evidence only")
        else:
            block["protection"] = {"evidence": prot["evidence"]}
    block["generics"] = generics
    block["clocks"] = clocks
    block["resets"] = resets
    block["interfaces"] = interfaces
    block["ports"] = ports
    if tie_offs:
        block["tieOffs"] = tie_offs
    if presets:
        block["presets"] = presets
    return block


def source_files(ctx: Context, s: dict) -> None:
    """The synthesis sources of a repository in compile order, read from its file list at the pinned commit (format
    files: one path per line, relative to the repository root), as s["files"] for the VHDL export. A file inside a
    submodule marks the source with s["submodules"]: it is cloned recursively."""
    if s.get("file_list_format") != "files":
        return
    where = f"sources.yml {s['id']}"
    repo = ctx.repos / s["repo"]
    text = git(repo, "show", f"{s['sha']}:{s['file_list']}")
    files = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    tree = git(repo, "ls-tree", "-r", s["sha"])
    blobs = set()
    modules = []
    for line in tree.splitlines():
        meta, path = line.split("\t", 1)
        mode, kind = meta.split()[:2]
        if kind == "commit":
            modules.append(path + "/")
        elif kind == "blob":
            blobs.add(path)
    in_module = [f for f in files if any(f.startswith(m) for m in modules)]
    for f in files:
        if f not in blobs and f not in in_module:
            ctx.err(where, f"{s['file_list']} names {f}, which is not in the repository at {s['sha'][:10]}")
    if len(set(files)) != len(files):
        ctx.err(where, f"{s['file_list']} names a file twice")
    s["files"] = files
    if in_module:
        s["submodules"] = True


def raw_reset_uses(text: str, port: str) -> list[tuple[int, str]]:
    """The uses of a reset input in the architecture of a block other than as RstIn of olo_base_reset_gen: (line, how).
    Allowed are the port declaration, the port as the formal of an instance (Rst => LinkRst) and RstIn => <port> in an
    instance of olo_base_reset_gen."""
    lines = [re.sub(r"--.*", "", ln) for ln in text.splitlines()]
    found = []
    entity = None
    for k, ln in enumerate(lines, 1):
        m = re.search(r"\bentity\s+(\w+)\.(\w+)", ln, re.I)
        if m:
            entity = m.group(2).lower()
        for occ in re.finditer(rf"(?<![\w.]){re.escape(port)}(?!\w)", ln, re.I):
            before, after = ln[:occ.start()], ln[occ.end():]
            if re.match(r"\s*:\s*(in|out|inout)\b", after, re.I):
                continue  # the port declaration
            if re.match(r"\s*=>", after):
                continue  # the formal of an instance
            if re.search(r"\bRstIn\s*=>\s*$", before, re.I):
                if entity == "olo_base_reset_gen":
                    continue
                found.append((k, f"as RstIn of {entity or 'an instance'}"))
                continue
            found.append((k, f"in '{ln.strip()}'"))
    return found


def substitute_constants(text: str, env: dict[str, Num]) -> str:
    """Replace package constants by their values; generic names stay symbolic."""

    def repl(m: re.Match) -> str:
        name = m.group(0)
        val = env.get(name.lower())
        if val is None or name.lower() in FUNCTIONS:
            return name
        return repr(val.value) if val.real else str(int(val.value))

    return re.sub(r"[A-Za-z]\w*", repl, text)


def build_catalog(ctx: Context) -> dict:
    types = load_types()
    sources = load_sources(ctx)
    pal = load_yaml(CATALOG_DIR / "palette.yml")
    groups = {}
    for cat in require(pal, "categories", "palette.yml"):
        for g in require(cat, "groups", "palette.yml"):
            groups[g["id"]] = {"id": g["id"], "name": g["name"], "category": cat["id"]}
    blocks = []
    ctx.type_ids = set(types)
    files = sorted(p for p in CATALOG_DIR.glob("blocks-*.yml"))
    seen = set()
    for f in files:
        data = load_yaml(f) or {}
        for b in data.get("blocks") or []:
            try:
                blk = build_block(ctx, b, sources, types, groups)
            except CatalogError as e:
                ctx.err(f.name, str(e))
                continue
            if blk is None:
                continue
            if blk["id"] in seen:
                ctx.err(f.name, f"duplicate block id {blk['id']}")
            seen.add(blk["id"])
            blocks.append(blk)
    by_id = {blk["id"]: blk for blk in blocks}
    for blk in blocks:
        for r in blk.get("rules") or []:
            if r.get("kind") == "with_block" and r.get("block") not in by_id:
                ctx.err(blk["id"], f"rule with_block: unknown block {r.get('block')}")
    # a measured message layout of a pair of blocks names the block behind and its interfaces
    for where, ch in ctx.size_chains:
        ref = ch.get("to") or {}
        other = by_id.get(ref.get("block"))
        if other is None:
            ctx.err(where, f"sizes: chain to an unknown block {ref.get('block')}")
            continue
        names = {i["name"] for i in other["interfaces"]}
        for k in ("in", "out"):
            if ref.get(k) not in names:
                ctx.err(where, f"sizes: chain: {other['id']} has no interface {ref.get(k)}")
    for t in types.values():
        t.pop("_", None)
    for s in sources.values():
        source_files(ctx, s)
    # the technology readiness level of every source, from the projects of the website (the only place it is decided)
    projects = {pr.get("repo"): pr for pr in load_yaml(ROOT / "_data" / "projects.yml") or []}
    for s in sources.values():
        pr = projects.get(s["repo"])
        if pr is None or not isinstance(pr.get("trl"), int) or not isinstance(pr.get("trl_status"), str):
            ctx.err(f"source {s['id']}", f"_data/projects.yml has no trl and trl_status for the repository {s['repo']}")
            continue
        s["trl"] = pr["trl"]
        s["trl_status"] = pr["trl_status"]
    # the changes of the blocks per source, as a chain of pin steps (the migration of files of older pins)
    check_changes(ctx, load_yaml(CATALOG_DIR / "changes.yml"), sources, blocks)
    catalog = {
        "format": CATALOG_FORMAT,
        "formatVersion": CATALOG_VERSION,
        "sources": [
            {camel(k): v for k, v in s.items() if k not in ("sha",)} | {"commit": s["sha"]} for s in sources.values()
        ],
        "categories": pal["categories"],
        "types": list(types.values()),
        "blocks": blocks,
    }
    # Content identifier: lets a saved system tell which catalog it was resolved with
    digest = hashlib.sha256(json.dumps(catalog, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
    return {"format": catalog.pop("format"), "formatVersion": catalog.pop("formatVersion"), "id": digest[:12]} | catalog


def camel(key: str) -> str:
    head, *rest = key.split("_")
    return head + "".join(p.capitalize() for p in rest)


def render(catalog: dict) -> str:
    return json.dumps(catalog, indent=1, ensure_ascii=False) + "\n"


# ---------------------------------------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------------------------------------
def cmd_build(ctx: Context) -> int:
    catalog = build_catalog(ctx)
    report(ctx)
    if ctx.errors:
        return 1
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(render(catalog), encoding="utf-8", newline="\n")
    print(f"wrote {OUT_FILE.relative_to(ROOT)}: {len(catalog['types'])} types, {len(catalog['blocks'])} blocks")
    return 0


def cmd_check(ctx: Context, fetch: bool) -> int:
    sources = load_sources(ctx)
    for src in sources.values():
        if fetch:
            git(ctx.repos / src["repo"], "fetch", "--quiet", "--tags", "origin")
        check_source_published(ctx, src)
    catalog = build_catalog(ctx)
    if not ctx.errors:
        current = OUT_FILE.read_text(encoding="utf-8") if OUT_FILE.exists() else ""
        if current != render(catalog):
            ctx.err(str(OUT_FILE.relative_to(ROOT)), "not current: run 'python tools/composer_catalog.py build'")
    check_examples(ctx, catalog)
    report(ctx)
    if not ctx.errors:
        print(f"catalog check passed: {len(catalog['types'])} types, {len(catalog['blocks'])} blocks")
    return 1 if ctx.errors else 0


def cmd_clone(ctx: Context) -> int:
    """Clones every source repository that is missing next to this one (full history and tags for the check)."""
    for src in load_sources(ctx, resolve=False).values():
        target = ctx.repos / src["repo"]
        if target.exists():
            print(f"{src['repo']}: present")
            continue
        subprocess.run(["git", "clone", "--quiet", src["url"], str(target)], check=True)
        print(f"{src['repo']}: cloned from {src['url']}")
    return 0


def definition_hash(definition: dict) -> str:
    """SHA-256 of the canonical JSON of a subsystem definition without its hash (format reference, section Subsystems):
    keys sorted, no white space, UTF-8. The Composer computes it with its own implementation; this is the cross-check."""
    rest = {k: v for k, v in definition.items() if k != "hash"}
    text = json.dumps(rest, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def check_examples(ctx: Context, catalog: dict) -> None:
    """The examples (version 1) and the fixtures of subsystems (version 2) against the schema of their version, their
    blocks against the catalog and the hashes of their definitions against hashlib."""
    missing = [f for f in SCHEMA_FILES.values() if not f.exists()]
    for f in missing:
        ctx.err("schema", f"{f.relative_to(ROOT)} missing")
    if missing:
        return
    try:
        import jsonschema
    except ImportError:
        ctx.warn("schema", "jsonschema not installed: examples not validated")
        return
    validators = {}
    for version, f in SCHEMA_FILES.items():
        schema = json.loads(f.read_text(encoding="utf-8"))
        jsonschema.Draft202012Validator.check_schema(schema)
        validators[version] = jsonschema.Draft202012Validator(schema)
    block_ids = {b["id"] for b in catalog["blocks"]}
    files = sorted(EXAMPLES_DIR.glob("*.composer.json")) + sorted(SUBSYSTEM_FIXTURES_DIR.glob("*.composer.json"))
    for f in files:
        doc = json.loads(f.read_text(encoding="utf-8"))
        validator = validators.get(doc.get("formatVersion"))
        if validator is None:
            ctx.err(f.name, f"unknown formatVersion {doc.get('formatVersion')}")
            continue
        for e in validator.iter_errors(doc):
            ctx.err(f.name, f"{'/'.join(str(p) for p in e.absolute_path)}: {e.message}")
        definitions = doc.get("subsystems", [])
        names = [s.get("name") for s in definitions]
        for k, s in enumerate(definitions):
            if s.get("hash") != definition_hash(s):
                ctx.err(f.name, f"subsystems[{k}] ({s.get('name')}): hash differs from the SHA-256 of its canonical JSON")
            # leaves first: a definition uses only those before it
            for inst in s.get("instances", []):
                if "subsystem" in inst and inst["subsystem"] not in names[:k]:
                    ctx.err(f.name, f"subsystems[{k}] ({s.get('name')}): {inst['subsystem']} is not defined before it")
        for where, inst in [("", i) for i in doc.get("instances", [])] + [
            (f"{s.get('name')}/", i) for s in definitions for i in s.get("instances", [])
        ]:
            if "subsystem" in inst:
                if inst["subsystem"] not in names:
                    ctx.err(f.name, f"instance {where}{inst.get('id')}: unknown subsystem {inst['subsystem']}")
            elif inst.get("block") not in block_ids:
                ctx.err(f.name, f"instance {where}{inst.get('id')}: unknown block {inst.get('block')}")


def report(ctx: Context) -> None:
    for w in ctx.warnings:
        print(f"warning: {w}")
    for e in ctx.errors:
        print(f"error: {e}")


def cmd_dump(ctx: Context, source: str, path: str, entity: str) -> int:
    sources = load_sources(ctx)
    src = sources[source]
    ent = parse_entity(git(ctx.repos / src["repo"], "show", f"{src['sha']}:{path}"), entity)
    for g in ent.generics:
        print(f"generic {g.name:24} {g.vtype:40} := {g.default}")
    for p in ent.ports:
        print(f"port    {p.name:24} {p.mode:4} {width_expr(p.vtype)!s:40} := {p.default}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repos", default=os.environ.get("COMPOSER_REPOS", str(ROOT.parent)),
                    help="directory with the clones of the source repositories")
    ap.add_argument("--check", action="store_true", help="same as the command 'check'")
    ap.add_argument("--fetch", action="store_true", help="fetch origin of every source before the check")
    sub = ap.add_subparsers(dest="cmd")
    sub.add_parser("build")
    sub.add_parser("check")
    sub.add_parser("clone")
    dmp = sub.add_parser("dump")
    dmp.add_argument("source")
    dmp.add_argument("path")
    dmp.add_argument("entity")
    args = ap.parse_args()
    if args.check:
        args.cmd = "check"
    if args.cmd is None:
        ap.error("give a command (build, check, dump) or --check")
    ctx = Context(Path(args.repos))
    try:
        if args.cmd == "build":
            return cmd_build(ctx)
        if args.cmd == "check":
            return cmd_check(ctx, args.fetch)
        if args.cmd == "clone":
            return cmd_clone(ctx)
        return cmd_dump(ctx, args.source, args.path, args.entity)
    except CatalogError as e:
        print(f"error: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
