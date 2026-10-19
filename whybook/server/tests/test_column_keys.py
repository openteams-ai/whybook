"""Columns whose key in their frame is not a string: the columns 0, 1 and 2 of pd.DataFrame(array).

The kernel's listing shows each label as text, "0", and gives the key as
JSON, ``"key": 0``. The view names the column by its key, ``X[0]``
(PYTHON.column in src/model/languages.ts), and sends the key with the column
and with the columns of each frame. The code of a question finds the column
by its key: ``whybook.summary(X, 0)``, where ``whybook.summary(X, "0")``
raised a KeyError.
"""

import numpy as np
import pandas as pd
import pytest

from whybook import explore
from whybook.server import codegen
from whybook.server.questions.drops import DropRequest, drop_options
from whybook.server.questions.models import Context, Variable

from .kernel_call import run

COLUMNS = {"0": "num", "1": "num", "2": "num", "3": "int", "4": "cat"}
CONTEXT = {"frames": {"X": {"rows": 60, "columns": COLUMNS, "keys": {"0": 0, "1": 1, "2": 2, "3": 3, "4": 4}}}, "used": [], "asked": []}


def data():
    rng = np.random.default_rng(0)
    X = pd.DataFrame(rng.normal(size=(60, 3)))
    X[3] = rng.integers(0, 3, 60)
    X[4] = np.repeat([f"u{i}" for i in range(15)], 4)
    return {"X": X}


def column(key, kind):
    """A column of X as the view sends it."""
    return {"name": f"X[{key}]", "label": str(key), "key": key, "kind": kind, "tag": COLUMNS[str(key)], "parent": "X", "rows": 60}


def options(source, target):
    return drop_options(DropRequest.from_json({"source": source, "target": {"item": target}, "cells": [], "context": CONTEXT}))["options"]


def run_code(code):
    namespace = data()
    exec(code, namespace)  # noqa: S102  the view runs the same code in the kernel
    return namespace


@pytest.fixture
def shell():
    from IPython.core.interactiveshell import InteractiveShell
    from traitlets.config import Config

    config = Config()
    config.HistoryManager.hist_file = ":memory:"
    shell = InteractiveShell.instance(config=config)
    # IPython's one instance, which the demo's state of conftest.py runs in too.
    before = dict(shell.user_ns)
    yield shell
    shell.user_ns.clear()
    shell.user_ns.update(before)


def test_the_listing_gives_the_key_of_a_column_whose_key_is_not_a_string(shell):
    frame = pd.DataFrame({"arm": ["A", "B"], "pain": [5.0, 3.0], "week": [1, 2]})
    shell.user_ns.update(
        {
            "X": pd.DataFrame(np.zeros((2, 3))),
            "wide": frame.groupby("arm").agg({"pain": ["mean", "std"]}),
            "halves": pd.DataFrame({0.5: [1, 2], 1.5: [3, 4]}),
            "days": pd.DataFrame({pd.Timestamp("2024-01-01"): [1, 2]}),
            "frame": frame,
        }
    )
    listed = {v["name"]: v for v in run(shell, "inspect_variables", {})["variables"]}

    def keys(name):
        return [(c["label"], c.get("key", "none")) for c in listed[name]["columns"]]

    assert keys("X") == [("0", 0), ("1", 1), ("2", 2)]
    assert keys("wide") == [("('pain', 'mean')", ["pain", "mean"]), ("('pain', 'std')", ["pain", "std"])]
    assert keys("halves") == [("0.5", 0.5), ("1.5", 1.5)]
    # A text is its own key, and a date has no literal.
    assert keys("frame") == [("arm", "none"), ("pain", "none"), ("week", "none")]
    assert keys("days") == [("2024-01-01 00:00:00", "none")]


def test_a_column_dropped_onto_itself_is_summarised_by_its_key():
    found = options(column(0, "numeric"), column(0, "numeric"))
    summary = next(option for option in found if option["text"].startswith("Summarise 0"))
    assert "whybook.summary(X, 0)" in summary["code"]
    run_code(summary["code"])


def test_two_columns_are_compared_by_their_keys(capsys):
    found = options(column(0, "numeric"), column(1, "numeric"))
    association = next(option for option in found if option["text"] == "Are 0 and 1 associated?")
    assert "X[[0, 1]].corr()" in association["code"]
    run_code(association["code"])
    both = next(option for option in found if option["text"].startswith("Summarise 0 and 1"))
    run_code(both["code"])
    levels = next(option for option in options(column(0, "numeric"), column(3, "categorical")) if option["text"].startswith("Does 0 differ"))
    assert "whybook.compare_levels(X, 0, 3)" in levels["code"]
    run_code(levels["code"])


def test_the_columns_of_a_frame_in_the_context_keep_their_keys():
    context = Context.from_json({**CONTEXT, "outcome": "0", "unit": "4"})
    assert [codegen.literal(label) for label in context.frames["X"]] == ["0", "1", "2", "3", "4"]
    assert (codegen.literal(context.outcome), codegen.literal(context.unit)) == ("0", "4")
    # A frame keeps the joins of a column that another frame has.
    plan = codegen.plan_data("X", ["1"], context.frames, None, target="_x_data")
    assert plan is not None and plan.lines == []
    assert codegen.formula(context.outcome, [label for label in context.frames["X"] if label != "0"][:2]) == '"Q(0) ~ Q(1) + Q(2)"'


def test_a_key_that_is_not_a_number_a_flag_or_a_list_of_them_stays_out_of_the_code():
    for key in ["__import__('os').system('id')", {"0": 1}, [1, [2]], [], None, float("nan"), float("inf")]:
        variable = Variable.from_json({"name": "X['0']", "label": "0", "kind": "numeric", "parent": "X", "key": key})
        assert codegen.literal(variable.label) == '"0"', key
    assert codegen.literal(Variable.from_json(column(0, "numeric")).label) == "0"
    assert codegen.literal(Variable.from_json({**column(0, "numeric"), "key": ["pain", 2, True]}).label) == '("pain", 2, True)'


def test_the_helpers_take_a_column_whose_key_is_a_number(capsys):
    X = data()["X"]
    explore.icc(X, 0, 4)
    explore.rows_per_unit(X, 4)
    explore.within_between(X, 0, 1, group=4)
    explore.screen(X, 0)
    explore.compare_levels(X, 0, 3, unit=4)
    assert "15 4s in 60 rows." in capsys.readouterr().out
