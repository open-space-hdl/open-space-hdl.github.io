#!/usr/bin/env python3
"""Build and check the block catalog of the Open Space Composer.

The catalog source is the YAML in _composer/catalog/: interface types, the pinned source repositories and the
semantic description of every block (interfaces, clocks, resets, tie-offs, presets, rules). The ports and generics
themselves are read from the VHDL entity at the pinned commit or tag, so the published catalog cannot drift from the
RTL.

  python tools/composer_catalog.py build              write assets/composer/catalog.json
  python tools/composer_catalog.py check              verify YAML against VHDL, catalog.json current, examples valid
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
SCHEMA_FILE = ROOT / "composer" / "schema" / "system-1.json"
EXAMPLES_DIR = ROOT / "assets" / "composer" / "examples"

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
    "generic_requires": ("generic", "value", "requires"),
    "mutual_initiator": ("generic",),
    "same_domain": ("interfaces",),
}
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
    """Normalize a std_logic_vector literal: ('bits', value, length) or ('others', bit, None)."""
    t = text.strip()
    m = re.fullmatch(r'[xX]"([0-9a-fA-F_]*)"', t)
    if m:
        digits = m.group(1).replace("_", "")
        return ("bits", int(digits or "0", 16), 4 * len(digits))
    m = re.fullmatch(r'[bB]?"([01_]*)"', t)
    if m:
        digits = m.group(1).replace("_", "")
        return ("bits", int(digits or "0", 2), len(digits))
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

    def err(self, where: str, msg: str) -> None:
        self.errors.append(f"{where}: {msg}")

    def warn(self, where: str, msg: str) -> None:
        self.warnings.append(f"{where}: {msg}")


def require(obj: dict, key: str, where: str) -> Any:
    if not isinstance(obj, dict) or key not in obj:
        raise CatalogError(f"{where}: missing '{key}'")
    return obj[key]


def load_sources(ctx: Context) -> dict[str, dict]:
    data = load_yaml(CATALOG_DIR / "sources.yml")
    sources = {}
    for src in require(data, "sources", "sources.yml"):
        sid = require(src, "id", "sources.yml")
        for key in ("name", "repo", "url", "library", "file_list"):
            require(src, key, f"sources.yml {sid}")
        if ("commit" in src) == ("tag" in src):
            raise CatalogError(f"sources.yml {sid}: give exactly one of 'commit' or 'tag'")
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
        for key in ("label", "description", "choices", "check", "advanced", "fromClock", "unit", "min", "max", "follow"):
            if key in m:
                gen[key] = m[key]
        if "follow" in m:
            fol = m["follow"]
            if kind != "integer" or not isinstance(fol, dict) or fol.get("measure") not in ("data", "packed") \
                    or not isinstance(fol.get("interfaces"), list) or not fol["interfaces"]:
                ctx.err(where, f"generic {g.name}: follow needs an integer generic, interfaces and measure data or packed")
        if "min" in m and kind == "integer" and m["min"] < lo:
            ctx.err(where, f"generic {g.name}: min {m['min']} below the VHDL range {lo}")
        if "max" in m and kind == "integer" and m["max"] > hi:
            ctx.err(where, f"generic {g.name}: max {m['max']} above the VHDL range {hi}")
        if "choices" in m:
            if kind != "string":
                ctx.err(where, f"generic {g.name}: choices only for string generics")
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
        p = use(require(r, "port", where), "resets")
        if p and p["width"] != "1":
            ctx.err(where, f"reset {r['port']} must be a std_logic")
        if r.get("dir", "in") != (p["dir"] if p else "in"):
            ctx.err(where, f"reset {r['port']}: direction differs from the VHDL")
        if r.get("clock") and r["clock"] not in clock_ports:
            ctx.err(where, f"reset {r['port']}: unknown clock {r['clock']}")
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
                    "params", "vector", "tieOff", "carry"):
            if key in itf:
                out[key] = itf[key]
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
            elif tie != "zero":
                ctx.err(iwhere, f"tieOff must be default, open or zero, not {tie}")
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
            for f in sb.get("fields") or []:
                for key in ("name", "label", "lsb", "bits"):
                    if key not in f:
                        ctx.err(iwhere, f"sideband field needs '{key}'")
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
        refs = [r.get(k) for k in ("clock", "faster", "slower") if r.get(k)]
        for c in refs:
            if c not in clock_ports:
                ctx.err(where, f"rule {kind}: unknown clock {c}")
        for gname in [r.get("generic")] + list(r.get("generics") or []):
            if gname and gname not in gen_names:
                ctx.err(where, f"rule {kind}: unknown generic {gname}")
        for iname in r.get("interfaces") or []:
            if iname not in itf_names:
                ctx.err(where, f"rule {kind}: unknown interface {iname}")

    # Presets
    presets = []
    for pr in b.get("presets") or []:
        for key in ("id", "name", "summary"):
            require(pr, key, f"{where} preset")
        for gname in (pr.get("generics") or {}):
            if gname not in gen_names:
                ctx.err(where, f"preset {pr['id']}: unknown generic {gname}")
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
    for key in ("doc", "project", "notes", "rules", "constraints"):
        if key in b:
            block[key] = b[key]
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
    for t in types.values():
        t.pop("_", None)
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


def check_examples(ctx: Context, catalog: dict) -> None:
    if not SCHEMA_FILE.exists():
        ctx.err("schema", f"{SCHEMA_FILE.relative_to(ROOT)} missing")
        return
    try:
        import jsonschema
    except ImportError:
        ctx.warn("schema", "jsonschema not installed: examples not validated")
        return
    schema = json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator.check_schema(schema)
    validator = jsonschema.Draft202012Validator(schema)
    block_ids = {b["id"] for b in catalog["blocks"]}
    for f in sorted(EXAMPLES_DIR.glob("*.composer.json")):
        doc = json.loads(f.read_text(encoding="utf-8"))
        for e in validator.iter_errors(doc):
            ctx.err(f.name, f"{'/'.join(str(p) for p in e.absolute_path)}: {e.message}")
        for inst in doc.get("instances", []):
            if inst.get("block") not in block_ids:
                ctx.err(f.name, f"instance {inst.get('id')}: unknown block {inst.get('block')}")


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
        return cmd_dump(ctx, args.source, args.path, args.entity)
    except CatalogError as e:
        print(f"error: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
