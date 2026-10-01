"""Names from the data in the code of the templates: columns, keys, groups, files.

A name goes into code as a Python string, and into a formula as a
``Q("...")`` term inside a string, so a column named "sleep hours" or
'sleep "hours"' gives code that parses and runs, and a name made to close
the quote stays a string. A name in a comment stays on the comment's line.
Until 29 September 2026 the templates wrote a name between double quotes as
it was: ``smf.ols("pain ~ Q("sleep hours")", ...)`` did not parse.
"""

import ast

import numpy as np
import pandas as pd
import pytest

from whybook.server.questions.cells import CellInfo, next_steps, random_slope_code
from whybook.server.questions.drops import DropRequest, drop_options
from whybook.server.questions.files import FileDrop, file_options
from whybook.server.questions.models import Context

# Each name holds MARK: the name is safe when MARK shows in no name, attribute or call of the code.
MARK = "PWNED"
NAMES = [
    "sleep hours",
    'sleep "hours"',
    "sleep's hours",
    "sleep\\hours",
    'sleep", "pain"]].corr(); PWNED(); visits[["pain',
    "sleep {PWNED()} hours",
    "sleep\nPWNED()",
]


def context(name, frames=None):
    columns = {"patient_id": "id", "week": "num", "pain": "num", name: "num", "arm": "cat", "site": "cat"}
    return {"frames": frames or {"visits": {"rows": 60, "columns": columns}}, "outcome": "pain", "unit": "patient_id", "used": [], "asked": []}


def column(label, kind="numeric", frame="visits"):
    return {"name": f"{frame}[{label!r}]", "label": label, "kind": kind, "parent": frame, "rows": 60}


def visits(name="sleep hours"):
    rng = np.random.default_rng(3)
    return pd.DataFrame(
        {
            "patient_id": np.repeat(np.arange(10), 6),
            "week": np.tile(np.arange(6), 10),
            "pain": rng.normal(5, 1, 60),
            name: rng.normal(7, 1, 60),
            "arm": pd.Categorical(np.repeat(["A", "B"], 30)),
            "site": pd.Categorical(np.tile(["north", "south", "east"], 20)),
        }
    )


def safe(code):
    """Parse the code, and check that the name is a string in it: MARK names nothing and calls nothing."""
    tree = ast.parse(code)
    for node in ast.walk(tree):
        text = getattr(node, "id", None) or getattr(node, "attr", None) or getattr(node, "arg", None)
        assert MARK not in str(text or ""), f"the name runs as code:\n{code}"
    return tree


def drops(name):
    """The options of every drop that writes the name into code."""
    load = {"id": "c2", "label": "[2]", "source": "visits = load()", "defs": ["visits"], "uses": ["load"]}
    fit = {"id": "c5", "label": "[5]", "source": 'fit = smf.ols("pain ~ week", data=visits).fit()', "defs": ["fit"], "uses": ["smf", "visits"], "formulas": ["pain ~ week"]}
    requests = [
        {"source": column(name), "target": {"cell": load}, "cells": [load]},
        {"source": column(name), "target": {"cell": fit}, "cells": [load, fit]},
        {"source": column(name), "target": {"item": column("pain")}, "cells": []},
        {"source": column(name, "categorical"), "target": {"item": column("pain")}, "cells": []},
        {"source": column(name), "target": {"item": column(name)}, "cells": []},
        {"source": {"name": "visits", "label": "visits", "kind": "dataframe", "rows": 60, "n_columns": 6}, "target": {"item": column(name)}, "cells": []},
    ]
    found = []
    for request in requests:
        found += drop_options(DropRequest.from_json({**request, "context": context(name)}))["options"]
    return [option for option in found if option["code"]]


@pytest.mark.parametrize("name", NAMES)
def test_every_drop_keeps_the_name_a_string(name):
    codes = [option["code"] for option in drops(name)]
    assert len(codes) >= 6
    for code in codes:
        safe(code)


@pytest.mark.parametrize("name", NAMES)
def test_worth_asking_next_keeps_the_name_a_string(name):
    cells = [CellInfo("c2", "[2]", "visits = load()", defs=("visits",))]
    steps = next_steps(cells, Context.from_json(context(name)), {"visits": [{"label": f"{name} panel", "used": 0, "total": 9}]}, set())
    codes = [step.code for step in steps if step.code]
    # One association for each column, and the screen of the panel.
    assert len(codes) == 5
    for code in codes:
        safe(code)


@pytest.mark.parametrize("name", ["sleep hours", 'sleep "hours"', "sleep's hours"])
def test_a_column_that_is_not_a_python_name_gives_code_that_runs(name):
    load = {"id": "c2", "label": "[2]", "source": "visits = load()", "defs": ["visits"], "uses": ["load"]}
    request = DropRequest.from_json({"source": column(name), "target": {"cell": load}, "cells": [load], "context": context(name)})
    [association] = [o for o in drop_options(request)["options"] if o["text"].startswith(f"Is {name} associated")]
    namespace = {"visits": visits(name)}
    exec(association["code"], namespace)  # noqa: S102  the view runs the same code in the kernel
    fit = next(value for key, value in namespace.items() if key.endswith("_vs_pain"))
    assert len(fit.params) == 4
    cells = [CellInfo("c2", "[2]", "visits = load()", defs=("visits",))]
    [step] = [s for s in next_steps(cells, Context.from_json(context(name)), {}, set()) if s.text == f"How does {name} relate to pain?"]
    exec(step.code, {"visits": visits(name)})  # noqa: S102


def test_a_covariate_with_a_quote_goes_into_a_formula_in_double_quotes():
    name = 'sleep "hours"'
    fit = {"id": "c5", "label": "[5]", "source": 'fit = smf.ols("pain ~ week", data=visits).fit()', "defs": ["fit"], "uses": ["smf", "visits"], "formulas": ["pain ~ week"]}
    request = DropRequest.from_json({"source": column(name), "target": {"cell": fit}, "cells": [fit], "context": context(name)})
    [covariate] = [o for o in drop_options(request)["options"] if o["text"] == f"Add {name} as a covariate"]
    import statsmodels.formula.api as smf

    namespace = {"smf": smf, "visits": visits(name)}
    exec(covariate["code"], namespace)  # noqa: S102
    assert len(namespace["fit"].params) == 3


def test_a_random_slope_test_of_a_formula_with_a_quoted_term_parses():
    source = "fit = smf.mixedlm('pain ~ Q(\"sleep hours\")', data=visits, groups=visits['patient_id'], re_formula='~week').fit()"
    cell = CellInfo("c3", "[3]", source, formulas=('pain ~ Q("sleep hours")',))
    tree = ast.parse(random_slope_code(cell))
    formulas = {node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and "~" in str(node.value)}
    assert formulas == {'pain ~ Q("sleep hours")', "~week"}


@pytest.mark.parametrize("name", ["visits{__import__('os').getpid()}.csv", 'visits".csv', "visits\nPWNED().csv"])
def test_a_file_name_is_a_string_in_the_code_of_a_dropped_file(tmp_path, monkeypatch, name):
    (tmp_path / name).write_text("patient_id,pain_extra\n1,2\n")
    cell = {"id": "c2", "label": "[2]", "source": "x = visits", "defs": ["x"], "uses": ["visits"]}
    frames = {"visits": {"patient_id": "id", "pain": "num"}}
    drop = FileDrop.from_json({"source": {"path": name, "kernel_path": name, "label": name}, "target": {"cell": cell}, "cells": [cell], "context": {"frames": frames, "unit": "patient_id"}})
    codes = [option["code"] for option in file_options(drop, str(tmp_path))["options"] if option["code"]]
    # Load, profile and join, and the questions to start with of a notebook with one cell (design iteration 1.87).
    assert len(codes) > 3
    for code in codes:
        tree = safe(code)
        assert "getpid" not in {getattr(node, "attr", None) for node in ast.walk(tree)}
    [join] = [code for code in codes if ".merge(" in code]
    monkeypatch.chdir(tmp_path)
    namespace = {"visits": pd.DataFrame({"patient_id": [1, 2], "pain": [3.0, 4.0]})}
    exec(join, namespace)  # noqa: S102
    joined = next(value for key, value in namespace.items() if key.startswith("visits_visits"))
    assert list(joined["pain_extra"].fillna(0)) == [2, 0]
