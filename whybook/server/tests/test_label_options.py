"""A label option makes no decision: a title, and the label of a line or of an axis (design iteration 1.141).

ThinkStats2's chapter 3 showed chips such as xlabel 'Class size' and ylabel
'PMF' on eight cards, from thinkplot.Config, a function of a file in the
notebook's folder whose name the drawing functions do not match, and a
default of the analyst's own function, label=None, made a chip and could make
the question "Does label = None change the result?". A label names what a
reader sees and changes no result, so it makes no decision in any function,
whether the call writes it or leaves it at a default, and a model that reads
the signatures of library functions is not shown it. The other values of the
same calls keep their decisions.
"""

import sys

import pytest

from .kernel_call import run

LABELS = {"label", "xlabel", "ylabel", "zlabel", "title", "suptitle"}

# A module of the notebook's folder, as thinkplot.py and thinkstats2.py are.
PLOTS = '''\
def config(xlabel=None, ylabel=None, title=None, legend=True, **options):
    return options


def pre_plot(num=None, rows=None, cols=None, label=None, suptitle=None):
    return num


class Pmf:
    def __init__(self, obj=None, label=None, zlabel="z"):
        self.obj = obj
        self.label = label
'''

ABSENT = object()


@pytest.fixture
def shell(tmp_path, monkeypatch):
    """An IPython shell whose folder holds plots.py, imported, with pandas."""
    from IPython.core.interactiveshell import InteractiveShell
    from traitlets.config import Config

    (tmp_path / "plots.py").write_text(PLOTS)
    monkeypatch.chdir(tmp_path)
    monkeypatch.syspath_prepend(str(tmp_path))
    config = Config()
    config.HistoryManager.hist_file = ":memory:"
    shell = InteractiveShell.instance(config=config)
    # IPython's one instance, which the demo's state of conftest.py runs in too.
    before = dict(shell.user_ns)
    signatures = vars(shell).pop("_whybook_signatures", ABSENT)
    result = shell.run_cell('import pandas as pd\nimport plots\ndf = pd.DataFrame({"a": [1.5, 2.5]})', silent=True)
    assert result.success, result.error_in_exec
    yield shell
    shell.user_ns.clear()
    shell.user_ns.update(before)
    vars(shell).pop("_whybook_signatures", None)
    if signatures is not ABSENT:
        shell._whybook_signatures = signatures
    sys.modules.pop("plots", None)


def analysis(shell, source, signatures=False):
    return run(shell, "analyze_cells", {"cells": [{"id": "c", "source": source}], "signatures": signatures})["cells"]["c"]


def test_a_label_option_makes_no_decision_in_any_function(shell):
    source = "\n".join(
        [
            'plots.config(xlabel="Class size", ylabel="PMF", title="Class sizes", legend=False)',
            'plots.pre_plot(2, label="observed")',
            'pmf = plots.Pmf([7, 12, 17], "actual")',
        ]
    )
    found = analysis(shell, source)["decisions"]
    params = {(decision["param"], decision["provenance"]) for decision in found}
    assert not {param for param, _ in params} & LABELS, params
    # The other values of the same calls keep theirs: written, or left at a default of plots.py.
    assert {("legend", "literal"), ("num", "literal"), ("rows", "defaulted"), ("cols", "defaulted"), ("obj", "literal")} <= params


def test_a_label_left_at_a_default_of_the_analysts_function_makes_no_decision(shell):
    found = analysis(shell, "biased = plots.Pmf([7, 12, 17])\nplots.pre_plot()")["decisions"]
    assert not {decision["param"] for decision in found} & LABELS, found
    assert {"num", "rows", "cols"} <= {decision["param"] for decision in found}


def test_a_model_that_reads_the_signatures_is_not_shown_a_label(shell):
    found = analysis(shell, "text = df.to_latex(index=False)", signatures=True)
    [latex] = [signature for signature in found["signatures"] if signature["name"].endswith("to_latex")]
    params = {param["name"] for param in latex["params"]}
    assert "caption" in params and "label" not in params
    assert latex["calls"] and all("label" not in call["defaulted"] for call in latex["calls"])
