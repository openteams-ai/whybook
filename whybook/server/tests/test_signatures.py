"""The signatures of the functions that a cell calls, which the kernel's analysis reads for "Find more defaults with AI".

Design iteration 1.53: with ``signatures`` in its arguments, the analysis of a
cell lists, for each call of a library function, every parameter that the
call leaves at its default, with the default's value, the function's module
and the library's version (kernel_code/analyze_cells.py).
"""

import json
import sys
import types

import pandas as pd
import pytest

pytestmark = pytest.mark.demo


def analyse(demo, source, **args):
    return demo.kernel("analyze_cells", {"cells": [{"id": "x", "source": source}], **args})["cells"]["x"]


def listed(analysis):
    return {signature["name"]: signature for signature in analysis["signatures"]}


def test_the_analysis_reads_no_signature_unless_the_view_asks(demo):
    source = '_g = weekly.groupby(["patient_id"], as_index=False)["pain_score"].mean()'
    assert "signatures" not in analyse(demo, source)
    assert "signatures" not in analyse(demo, source, signatures=False)


def test_a_call_lists_each_parameter_that_it_leaves_at_its_default(demo):
    source = '_g = weekly.groupby(["patient_id"], as_index=False)["pain_score"].mean()'
    (groupby,) = analyse(demo, source, signatures=True)["signatures"]
    assert {key: groupby[key] for key in ("function", "name", "module", "library", "version")} == {
        "function": "pandas.core.frame.DataFrame.groupby",
        "name": "DataFrame.groupby",
        "module": "pandas.core.frame",
        "library": "pandas",
        "version": pd.__version__,
    }
    # Every parameter of the signature that has a default, with the default as code.
    assert groupby["params"] == [
        {"name": "by", "default": "None"},
        {"name": "level", "default": "None"},
        {"name": "as_index", "default": "True"},
        {"name": "sort", "default": "True"},
        {"name": "group_keys", "default": "True"},
        {"name": "observed", "default": "True"},
        {"name": "dropna", "default": "True"},
    ]
    # The call passes by and as_index: the others it leaves at their defaults.
    assert groupby["calls"] == [
        {"line": 1, "col": 12, "target": "weekly", "defaulted": ["level", "sort", "group_keys", "observed", "dropna"]}
    ]


def test_calls_of_one_function_are_listed_under_it_each_with_what_it_leaves(demo):
    source = 'both = weekly.merge(patients, on="patient_id").merge(olink, on="patient_id", how="left", validate="1:1")'
    (merge,) = analyse(demo, source, signatures=True)["signatures"]
    assert merge["name"] == "DataFrame.merge"
    first, second = merge["calls"]
    assert (first["target"], second["target"]) == ("patients", "olink")
    assert "how" in first["defaulted"] and "validate" in first["defaulted"]
    assert "how" not in second["defaulted"] and "validate" not in second["defaulted"]
    assert "on" not in first["defaulted"] + second["defaulted"]


def test_the_demo_cells_list_the_functions_of_libraries_and_not_those_of_the_analyst(demo):
    cells = [{"id": cell.id, "source": cell.source} for cell in demo.cells if cell.id in ("weekly", "lmm")]
    analysis = demo.kernel("analyze_cells", {"cells": cells, "signatures": True})["cells"]
    weekly = listed(analysis["weekly"])
    # drop_sparse is the analyst's own, in prep.py: its default is a chip already, MIN_DAYS.
    assert set(weekly) == {"DataFrame.merge", "DataFrame.groupby", "ribbon"}
    ribbon = weekly["ribbon"]
    assert (ribbon["module"], ribbon["library"]) == ("whybook.plots", "whybook")
    # units and max_units draw a line per unit (design iteration 1.75); the demo's ribbon by arm leaves them.
    assert ribbon["calls"][0]["defaulted"] == ["units", "max_units", "seed", "title"]
    lmm = listed(analysis["lmm"])
    assert {"DataFrame.merge", "MixedLM.from_formula", "MixedLM.fit"} <= set(lmm)
    fit = lmm["MixedLM.fit"]
    assert fit["library"] == "statsmodels" and "reml" in fit["calls"][0]["defaulted"]
    # The analysis of the cell does not change: the same decisions as without signatures.
    plain = demo.kernel("analyze_cells", {"cells": cells})["cells"]
    assert {cell: {k: v for k, v in result.items() if k != "signatures"} for cell, result in analysis.items()} == plain


def test_builtins_the_notebooks_own_functions_and_the_analysts_modules_are_left_out(demo):
    demo.run("def _mine(x, k=3):\n    return x")
    try:
        source = "_a = _mine(1)\n_b = sorted([3, 1])\n_c = round(2.5)\n_d = drop_sparse(diary)\n_e = 'a,b'.split(',')"
        assert analyse(demo, source, signatures=True)["signatures"] == []
    finally:
        demo.run("del _mine")


def test_a_call_with_unpacked_arguments_is_left_out(demo):
    source = '_opts = {"sort": False}\n_g = weekly.groupby("patient_id", **_opts)\n_h = weekly.groupby(*["patient_id"])'
    assert analyse(demo, source, signatures=True)["signatures"] == []


def test_a_cell_lists_at_most_the_functions_asked_for(demo):
    source = '_a = weekly.head()\n_b = weekly.groupby("week")\n_c = weekly.merge(patients, on="patient_id")\n_d = pd.to_datetime(["2025-01-02"])'
    assert [s["name"] for s in analyse(demo, source, signatures=True)["signatures"]] == [
        "NDFrame.head",
        "DataFrame.groupby",
        "DataFrame.merge",
        "to_datetime",
    ]
    assert len(analyse(demo, source, signatures=True, max_signatures=2)["signatures"]) == 2


def test_what_was_read_of_a_function_stays_in_the_kernels_session(demo):
    source = '_g = weekly.groupby("week")'
    analyse(demo, source, signatures=True)
    kept = demo.shell._whybook_signatures["functions"]["pandas.core.frame.DataFrame.groupby"]
    assert kept["params"][-1] == {"name": "dropna", "default": "True"}
    # The next analysis reads the kept entry, not the signature again.
    saved = kept["params"]
    kept["params"] = [{"name": "dropna", "default": "'kept'"}]
    try:
        (groupby,) = analyse(demo, source, signatures=True)["signatures"]
        assert groupby["params"] == [{"name": "dropna", "default": "'kept'"}]
    finally:
        kept["params"] = saved
    # It stays on the shell, not among the notebook's names.
    assert not [name for name in demo.shell.user_ns if name.startswith("_whybook_")]


@pytest.fixture
def library():
    """A library of one function whose defaults hold a frame, a long list, a key and a function."""
    module = types.ModuleType("fakestats")
    module.__version__ = "2.1.0"
    source = (
        "import pandas as pd\n"
        "WEIGHTS = pd.DataFrame({'w': [1.0, 2.0, 3.0], 'v': [4, 5, 6]})\n"
        "def fit(data, weights=WEIGHTS, bins=list(range(20)), token='hf_" + "Q" * 34 + "', link=sum, alpha=0.05, method='exact', labels=('low', 'high')):\n"
        "    return data\n"
    )
    exec(compile(source, "fakestats.py", "exec"), module.__dict__)
    sys.modules["fakestats"] = module
    yield module
    sys.modules.pop("fakestats", None)


def test_a_default_that_holds_data_says_what_it_is_and_a_key_is_left_out(demo, library):
    demo.shell.user_ns["fakestats"] = library
    try:
        analysis = analyse(demo, "_f = fakestats.fit(weekly)", signatures=True)
    finally:
        demo.shell.user_ns.pop("fakestats", None)
    (fit,) = analysis["signatures"]
    assert (fit["function"], fit["library"], fit["version"]) == ("fakestats.fit", "fakestats", "2.1.0")
    assert fit["params"] == [
        {"name": "weights", "default": "<DataFrame 3 × 2>", "data": True},
        {"name": "bins", "default": "<list of 20 items>", "data": True},
        {"name": "link", "default": "sum"},
        {"name": "alpha", "default": "0.05"},
        {"name": "method", "default": "'exact'"},
        {"name": "labels", "default": "('low', 'high')"},
    ]
    assert "hf_" not in json.dumps(analysis)
