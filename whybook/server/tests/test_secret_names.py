"""One set of cases for the rule that hides a secret, in the places that apply it.

data/secret_names.json holds names, values and verdicts. Here they go
through the server (privacy.looks_secret), the kernel's listing
(kernel_code/inspect_variables.py) and the kernel's analysis of cells
(kernel_code/analyze_cells.py). src/__tests__/secrets.spec.ts reads the same
file for the view (looksSecret in src/model/restore.ts).
"""

import json
import types
from pathlib import Path

import IPython
import IPython.display
import pytest

from whybook.server import privacy

HERE = Path(__file__).parent
CASES = json.loads((HERE / "data" / "secret_names.json").read_text())["cases"]
KERNEL_CODE = HERE.parent / "kernel_code"
MIME = "application/vnd.whybook.result+json"


def case_id(case):
    return f"{case['name']}={case['value']!r}"


def kernel(name, namespace, args, monkeypatch):
    """Run one file of kernel code in a bare shell whose namespace is ``namespace``, as the view runs it in the kernel."""
    code = {}
    exec((KERNEL_CODE / f"{name}.py").read_text(), code)  # noqa: S102
    shown = []
    shell = types.SimpleNamespace(user_ns=namespace, user_ns_hidden={}, transform_cell=lambda source: source)
    monkeypatch.setattr(IPython, "get_ipython", lambda: shell)
    monkeypatch.setattr(IPython.display, "display", lambda data, raw=False, **kw: shown.append(data))
    code[f"_whybook_{name}"](args)
    return shown[-1][MIME]


@pytest.mark.parametrize("case", CASES, ids=case_id)
def test_the_server_reads_a_secret_by_the_shared_rule(case):
    # The value as the kernel lists it, and as a notebook kept it before 29 September 2026.
    assert privacy.looks_secret(case["name"], repr(case["value"])) is case["secret"]


@pytest.mark.parametrize("case", CASES, ids=case_id)
def test_the_kernel_lists_a_secret_by_its_length_only(case, monkeypatch):
    [listed] = kernel("inspect_variables", {case["name"]: case["value"]}, {}, monkeypatch)["variables"]
    if case["secret"]:
        assert listed == {"name": case["name"], "label": case["name"], "kind": "constant", "type": "builtins.str", "secret": True, "length": len(case["value"])}
    else:
        assert (listed["kind"], listed["value"], "secret" in listed) == ("constant", repr(case["value"]), False)


@pytest.mark.parametrize("case", CASES, ids=case_id)
def test_the_kernel_keeps_a_chip_unless_it_holds_a_secret(case, monkeypatch):
    source = f"{case['name']} = {case['value']!r}"
    analysis = kernel("analyze_cells", {}, {"cells": [{"id": "c", "source": source}]}, monkeypatch)["cells"]["c"]
    decisions = [(decision["name"], decision["value"]) for decision in analysis["decisions"]]
    assert decisions == ([] if case["secret"] else [(case["name"], repr(case["value"]))])
