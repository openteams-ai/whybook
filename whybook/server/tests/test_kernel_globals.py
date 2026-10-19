"""The view runs each program of kernel_code/ in globals of its own (PYTHON.call in src/model/languages.ts).

A notebook binds names that are also builtins: ``type = "linear"``, or ``zip``
in ``with zipfile.ZipFile(path) as zip:``. These names do not reach the
programs, which read the notebook's names through ``get_ipython().user_ns``,
and nothing that a program defines stays in the notebook's namespace.
data/kernel_call.json holds what the view sends for one program, and jest
checks the view against it.
"""

import builtins
import json
from pathlib import Path

import pytest

from .kernel_call import call, execute, run

matplotlib = pytest.importorskip("matplotlib")

CASE = json.loads((Path(__file__).parent / "data" / "kernel_call.json").read_text())
AXES_MIME = "application/vnd.whybook.axes+json"
# Every builtin that a notebook can bind, but those with two underscores.
REBOUND = [name for name in dir(builtins) if not name.startswith("__")]
CELLS = [
    {"id": "load", "source": "visits = pd.DataFrame({'arm': ['A', 'B'] * 3, 'week': [1, 1, 2, 2, 3, 3], 'pain': [5.0, 4.0, 4.5, 3.5, 4.0, 3.0]})"},
    {"id": "means", "source": "means = visits.groupby('arm', sort=False)['pain'].mean().round(2)"},
    {"id": "merge", "source": "both = visits.merge(means.rename('mean_pain'), left_on='arm', right_index=True).head(4)"},
    {"id": "fit", "source": "fit = smf.ols('pain ~ week + arm', data=visits).fit()"},
    {"id": "plot", "source": "_figure, _axes = plt.subplots(figsize=(4, 3), dpi=72)\n_axes.scatter(visits['week'], visits['pain'])\n_axes.set_xlabel('week')\n_axes.set_ylabel('pain')"},
]
PROGRAMS = {
    "inspect_variables": {"known": {}},
    "analyze_cells": {"cells": CELLS, "signatures": True},
    "region_summary": {"frame": "visits", "x": "week", "x0": 1, "x1": 2, "y": "pain", "by": "arm"},
    "table_rows": {"frame": "visits", "keys": [], "labels": [["0"], ["1"]]},
    "kernel_facts": {},
    "write_frames": {"frames": ["visits"], "folder": "from_python", "format": "csv"},
}
ABSENT = object()


@pytest.fixture
def shell(tmp_path, monkeypatch):
    """An IPython shell whose folder is the notebook's, with PNG figures and the cells above run."""
    from IPython.core.interactiveshell import InteractiveShell
    from IPython.core.pylabtools import select_figure_formats
    from traitlets.config import Config

    matplotlib.use("agg")
    monkeypatch.chdir(tmp_path)
    config = Config()
    config.HistoryManager.hist_file = ":memory:"
    shell = InteractiveShell.instance(config=config)
    select_figure_formats(shell, {"png"}, bbox_inches="tight")
    # IPython's one instance, which the demo's state of conftest.py runs in too.
    before = dict(shell.user_ns)
    signatures = vars(shell).get("_whybook_signatures", ABSENT)
    imports = "import matplotlib.pyplot as plt\nimport pandas as pd\nimport statsmodels.formula.api as smf"
    result = shell.run_cell("\n".join([imports, *(cell["source"] for cell in CELLS)]), silent=True)
    assert result.success, result.error_in_exec
    yield shell
    shell.user_ns.clear()
    shell.user_ns.update(before)
    run(shell, "plot_hooks", {"uninstall": True})
    vars(shell).pop("_whybook_signatures", None)
    if signatures is not ABSENT:
        shell._whybook_signatures = signatures
    import matplotlib.pyplot as plt

    plt.close("all")


def changed(before, after):
    """The names whose value in ``after`` is not the same object as in ``before``."""
    return sorted(name for name in before.keys() | after.keys() if before.get(name, ABSENT) is not after.get(name, ABSENT))


def test_the_tests_send_what_the_view_sends():
    assert call(CASE["name"], CASE["args"], CASE["program"]) == CASE["code"]


def test_a_program_runs_in_globals_of_its_own(shell):
    shell.user_ns.update({"type": "linear", "len": 3, "zip": "a zip file"})
    names = dict(shell.user_ns)
    # The code of data/kernel_call.json, as the view sends it.
    found = execute(shell, CASE["code"], CASE["name"])
    assert found == {"args": CASE["args"], "in_notebook": False, "builtins": True, "names": ["_whybook_args", "_whybook_probe"]}
    assert changed(names, dict(shell.user_ns)) == []


def test_every_program_answers_as_before_after_the_notebook_binds_every_builtin(shell):
    before = {name: run(shell, name, args) for name, args in PROGRAMS.items()}
    assert run(shell, "plot_hooks", {})["hooks"]["matplotlib"]["state"] == "on"
    plotted, _ = shell.display_formatter.format(shell.user_ns["_figure"])
    run(shell, "plot_hooks", {"uninstall": True})
    # The analysis reads the signatures of the functions again, which it keeps on the shell.
    del shell._whybook_signatures

    shell.user_ns.update({name: "rebound" for name in REBOUND})
    names = dict(shell.user_ns)
    after = {name: run(shell, name, args) for name, args in PROGRAMS.items()}
    assert run(shell, "plot_hooks", {})["hooks"]["matplotlib"]["state"] == "on"
    replotted, _ = shell.display_formatter.format(shell.user_ns["_figure"])

    assert changed(names, dict(shell.user_ns)) == []
    # The listing also lists the rebound names, and the file of the frame was there for the second write.
    after["inspect_variables"]["variables"] = [v for v in after["inspect_variables"]["variables"] if v["name"] not in REBOUND]
    for result in (before, after):
        result["write_frames"]["files"][0].pop("existed")
    assert after == before
    assert before["analyze_cells"]["cells"]["merge"]["decisions"] and before["analyze_cells"]["cells"]["fit"]["formulas"]
    # The hooks find the frame of the plot among the notebook's names.
    assert replotted[AXES_MIME] == plotted[AXES_MIME] and plotted[AXES_MIME]["axes"][0]["frame"] == "visits"


def test_a_program_that_raises_leaves_the_notebook_as_it_was(shell):
    names = dict(shell.user_ns)
    result = shell.run_cell(call("region_summary", {"frame": "visits", "x": "no such column", "x0": 1, "x1": 2}), silent=True)
    assert isinstance(result.error_in_exec, KeyError)
    assert changed(names, dict(shell.user_ns)) == []
