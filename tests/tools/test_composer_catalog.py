"""Tests of tools/composer_catalog.py that need no clone of a core: the check of the pin steps of changes.yml, on a
small git repository that the test makes (an upstream project and a fork whose backlog is rebased onto a newer upstream
release).

    python -m unittest discover -s tests/tools
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
import composer_catalog as cc  # noqa: E402

GIT_ENV = {"GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.org",
           "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.org"}


class PinSteps(unittest.TestCase):
    """The repository fork/ of the test:

        u1 (tag 1.0) - u2 (tag 1.1)                     upstream, 1.1 adds src/u2.vhd
          \\           \\
           f1 - f2      f1r - f2r                       the fork on 1.0 (tags 1.0-ft.1, 1.0-ft.2) and its backlog
                                                        rebased onto 1.1 (tag 1.1-ft.1)
        u2 - d1                                         a fork tag on 1.1 that drops the fork's file (1.1-ft.drop)
        f1 + u2 -> m1                                   the fork's 1.0-ft.1 merged with 1.1, not rebased (1.1-ft.merge)
        u1 - x1                                         an upstream commit that 1.1-ft.1 does not contain
    """

    tmp: tempfile.TemporaryDirectory
    repo: Path
    c: dict[str, str]

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.repo = Path(cls.tmp.name) / "fork"
        cls.repo.mkdir()
        cls.c = {}
        cls.git("init", "-q", "-b", "main")
        cls.commit("u1", {"src/u1.vhd": "-- u1\n"}, ["src/u1.vhd"], tag="1.0")
        cls.commit("f1", {"src/ft.vhd": "-- ft 1\n"}, ["src/u1.vhd", "src/ft.vhd"], tag="1.0-ft.1")
        cls.commit("f2", {"src/ft.vhd": "-- ft 2\n"}, ["src/u1.vhd", "src/ft.vhd"], tag="1.0-ft.2")
        cls.git("checkout", "-q", "-b", "upstream", cls.c["u1"])
        cls.commit("u2", {"src/u2.vhd": "-- u2\n"}, ["src/u1.vhd", "src/u2.vhd"], tag="1.1")
        cls.git("checkout", "-q", "-b", "rebased")
        cls.commit("f1r", {"src/ft.vhd": "-- ft 1\n"}, ["src/u1.vhd", "src/u2.vhd", "src/ft.vhd"])
        cls.commit("f2r", {"src/ft.vhd": "-- ft 2\n"}, ["src/u1.vhd", "src/u2.vhd", "src/ft.vhd"], tag="1.1-ft.1")
        cls.git("checkout", "-q", "-b", "dropped", cls.c["u2"])
        cls.commit("d1", {"src/other.vhd": "-- other\n"}, ["src/u1.vhd", "src/u2.vhd", "src/other.vhd"], tag="1.1-ft.drop")
        cls.git("checkout", "-q", "-b", "merged", cls.c["f1"])
        cls.git("merge", "-q", "--no-edit", "-s", "ours", cls.c["u2"])
        cls.commit("m1", {"src/u2.vhd": "-- u2\n"}, ["src/u1.vhd", "src/u2.vhd", "src/ft.vhd"], tag="1.1-ft.merge")
        cls.git("checkout", "-q", "-b", "side", cls.c["u1"])
        cls.commit("x1", {"src/x.vhd": "-- x\n"}, ["src/u1.vhd", "src/x.vhd"])

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    @classmethod
    def git(cls, *args: str) -> str:
        r = subprocess.run(["git", "-C", str(cls.repo), "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false",
                            "-c", "tag.gpgsign=false", "-c", "core.hooksPath=.git/no-hooks", *args],
                           capture_output=True, text=True, env={**os.environ, **GIT_ENV})
        if r.returncode != 0:
            raise RuntimeError(f"git {' '.join(args)}: {r.stderr}")
        return r.stdout

    @classmethod
    def commit(cls, name: str, files: dict[str, str], file_list: list[str], tag: str | None = None) -> None:
        for path, text in {**files, "compile_order.txt": "".join(f"{f}\n" for f in file_list)}.items():
            p = cls.repo / path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8", newline="\n")
        cls.git("add", "-A")
        cls.git("commit", "-q", "--allow-empty", "-m", name)
        cls.c[name] = cls.git("rev-parse", "HEAD").strip()
        if tag:
            cls.git("tag", tag)

    def check(self, *steps: dict) -> list[str]:
        """The errors of check_changes for a chain of steps of a source pinned at the last pin."""
        ctx = cc.Context(Path(self.tmp.name))
        src = {"id": "olo", "repo": "fork", "file_list": "compile_order.txt", "sha": steps[-1]["pin"]}
        cc.check_changes(ctx, {"olo": [dict(s, evidence="test", changes=[]) for s in steps]}, {"olo": src}, [])
        return ctx.errors

    def rebase(self, **over: str) -> dict:
        """The step of the rebase from 1.0-ft.2 to 1.1-ft.1 with its rebase entry, optionally altered."""
        rb = {"from": "1.0-ft.2", "to": "1.1-ft.1", "base": self.c["u2"], "reason": "backlog rebased onto 1.1"}
        return {"previous": self.c["f2"], "pin": self.c["f2r"], "rebase": {**rb, **over}}

    def assert_error(self, errors: list[str], text: str) -> None:
        self.assertTrue(any(text in e for e in errors), f"no error with {text!r}: {errors}")

    def test_descendant_steps_pass(self) -> None:
        self.assertEqual(self.check({"previous": self.c["f1"], "pin": self.c["f2"]}), [])

    def test_unexplained_non_descendant_step_fails(self) -> None:
        errors = self.check({"previous": self.c["f2"], "pin": self.c["f2r"]})
        self.assert_error(errors, f"previous {self.c['f2']} is not an ancestor of pin {self.c['f2r']}")

    def test_documented_rebase_passes(self) -> None:
        self.assertEqual(self.check({"previous": self.c["f1"], "pin": self.c["f2"]}, self.rebase()), [])

    def test_rebase_on_a_descendant_step_fails(self) -> None:
        errors = self.check({"previous": self.c["f1"], "pin": self.c["f2"],
                             "rebase": {"from": "1.0-ft.1", "to": "1.0-ft.2", "base": self.c["u1"], "reason": "r"}})
        self.assert_error(errors, "previous is an ancestor of pin: the step is no rebase")

    def test_rebase_needs_every_key(self) -> None:
        step = self.rebase()
        del step["rebase"]["reason"]
        self.assert_error(self.check(step), "rebase needs from, to, base, reason")
        self.assert_error(self.check(self.rebase(reason=" ")), "rebase needs from, to, base, reason")

    def test_rebase_tags_name_the_pins(self) -> None:
        self.assert_error(self.check(self.rebase(**{"from": "1.0-ft.1"})), "from 1.0-ft.1 is no tag of fork at previous")
        self.assert_error(self.check(self.rebase(to="1.1-ft.9")), "to 1.1-ft.9 is no tag of fork at pin")

    def test_rebase_base_is_a_full_commit_in_pin(self) -> None:
        self.assert_error(self.check(self.rebase(base="1.1")), "base 1.1 is no full commit of fork")
        self.assert_error(self.check(self.rebase(base=self.c["x1"])), "is not an ancestor of pin")

    def test_rebase_base_is_newer_than_previous(self) -> None:
        self.assert_error(self.check(self.rebase(base=self.c["u1"])), "is an ancestor of previous")

    def test_rebase_drops_no_file(self) -> None:
        step = {"previous": self.c["f2"], "pin": self.c["d1"],
                "rebase": {"from": "1.0-ft.2", "to": "1.1-ft.drop", "base": self.c["u2"], "reason": "r"}}
        self.assert_error(self.check(step), "compile_order.txt at pin does not name src/ft.vhd")

    def test_rebase_is_no_merge_of_the_old_fork(self) -> None:
        step = {"previous": self.c["f2"], "pin": self.c["m1"],
                "rebase": {"from": "1.0-ft.2", "to": "1.1-ft.merge", "base": self.c["u2"], "reason": "r"}}
        self.assert_error(self.check(step), "share history after base")


if __name__ == "__main__":
    unittest.main()
