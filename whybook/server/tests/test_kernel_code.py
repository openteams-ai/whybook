"""The kernel code, run in an in-process IPython shell on the demo notebook's state."""

import json

import pytest

pytestmark = pytest.mark.demo


def test_constant_knows_where_it_is_defined(demo):
    assert demo.variable("MIN_DAYS")["defined_in"] == {"file": "prep.py", "line": 31, "module": "prep"}


def test_frame_columns_have_tags_and_ranges(demo):
    patients = {c["label"]: c for c in demo.variable("patients")["columns"]}
    assert patients["patient_id"]["tag"] == "id"
    assert (patients["treatment_arm"]["kind"], patients["treatment_arm"]["levels"]) == ("binary", ["A", "B"])
    assert patients["stage"]["tag"] == "ord"
    assert (patients["age"]["tag"], patients["age"]["min"], patients["age"]["max"]) == ("int", 18, 55)
    assert patients["bmi"]["missing"] == 16


def test_wide_frame_keeps_its_column_groups(demo):
    olink = demo.variable("olink")
    assert olink["n_columns"] == 4813
    assert [(g["label"], len(g["columns"])) for g in olink["groups"]] == [
        ("Inflammation", 1104),
        ("Cardiometabolic", 1472),
        ("Neurology", 1180),
        ("Oncology", 1056),
    ]
    il6 = next(c for c in olink["columns"] if c["label"] == "IL6")
    frame = demo.shell.user_ns["olink"]
    assert (il6["unique"], il6["missing"]) == (frame["IL6"].nunique(), int(frame["IL6"].isna().sum()))


def test_fitted_model_lists_its_terms(demo):
    model = demo.variable("lmm_fit")
    assert model["kind"] == "model"
    assert model["formula"] == "pain_score ~ treatment_arm * month + age"
    assert "treatment_arm[T.B]:month" in [term["term"] for term in model["terms"]]


def test_unchanged_frames_are_sent_as_stubs(demo):
    known = {v["name"]: v["fingerprint"] for v in demo.snapshot["variables"] if v.get("fingerprint")}
    second = demo.kernel("inspect_variables", {"known": known})
    stubs = {v["name"] for v in second["variables"] if v.get("unchanged")}
    assert {"olink", "diary", "patients"} <= stubs


def test_silent_default_from_the_users_module(demo):
    weekly = demo.analysis["weekly"]
    decision = weekly["decisions"][0]
    assert (decision["name"], decision["value"], decision["provenance"]) == ("MIN_DAYS", "14", "defaulted")
    assert decision["source"] == {"file": "prep.py", "line": 31}
    (attachment,) = weekly["attachments"]
    assert (attachment["file"], attachment["symbol"], attachment["highlight"]) == ("prep.py", "drop_sparse", [31])
    assert attachment["lines"][0] == [31, "MIN_DAYS = 14"]


def test_library_default_and_literal_choices(demo):
    decisions = {d["name"]: d for d in demo.analysis["lmm"]["decisions"]}
    assert decisions["reml"]["provenance"] == "library_default"
    assert decisions["re_formula"]["provenance"] == "literal"
    assert "formula" not in decisions
    assert demo.analysis["lmm"]["formulas"][0] == "pain_score ~ treatment_arm * month + age"


def test_merge_default_as_a_function_and_as_a_method(demo):
    cells = [
        {"id": "function", "source": "_merged = pd.merge(diary, patients, on='patient_id')"},
        {"id": "method", "source": "_merged = diary.merge(patients, on='patient_id')"},
    ]
    analysis = demo.kernel("analyze_cells", {"cells": cells})["cells"]
    for cell in ("function", "method"):
        how = next(d for d in analysis[cell]["decisions"] if d["name"] == "how")
        assert (how["value"], how["provenance"]) == ("'inner'", "library_default")


def test_a_default_of_a_class_is_named_by_the_class(demo):
    # The finance video's dry run showed two chips of one default, "C 1.0 · __init__" from
    # this list and "C 1.0 · LogisticRegression" from a model's pick of the signature, which
    # names the class as the cell calls it.
    demo.run("from sklearn.linear_model import LogisticRegression")
    try:
        cells = [{"id": "fit", "source": "_clf = LogisticRegression()"}]
        analysis = demo.kernel("analyze_cells", {"cells": cells})["cells"]
        c = next(d for d in analysis["fit"]["decisions"] if d["name"] == "C")
        assert (c["function"], c["value"], c["provenance"]) == ("LogisticRegression", "1.0", "library_default")
    finally:
        demo.run("del LogisticRegression")


def test_the_iteration_limit_of_a_fit_is_listed_for_a_fit_that_does_not_converge(demo):
    # The finance video's scorecard stopped at max_iter=100 of LogisticRegression() with a
    # ConvergenceWarning, and no chip named the limit (design iteration 1.116). The kernel lists
    # the limit with "when", and the view shows it only when the cell's fit did not converge.
    demo.run("from sklearn.linear_model import LogisticRegression")
    try:
        cells = [{"id": "fit", "source": "_clf = LogisticRegression()"}, {"id": "set", "source": "_clf = LogisticRegression(max_iter=500)"}]
        analysis = demo.kernel("analyze_cells", {"cells": cells})["cells"]
        limit = next(d for d in analysis["fit"]["decisions"] if d["name"] == "max_iter")
        assert (limit["value"], limit["provenance"], limit["function"], limit["when"]) == ("100", "library_default", "LogisticRegression", "not_converged")
        assert limit["note"] == "the fit stops after this many iterations, whether it has converged or not"
        # A limit that the cell writes is the analyst's value, which shows whatever the fit did.
        (written,) = [d for d in analysis["set"]["decisions"] if d["name"] == "max_iter"]
        assert (written["value"], written["provenance"], written.get("when")) == ("500", "literal", None)
        assert all("when" not in d for d in analysis["fit"]["decisions"] if d["name"] != "max_iter")
    finally:
        demo.run("del LogisticRegression")


def test_a_call_of_the_warnings_module_makes_no_decision(demo):
    # The agent of the finance video's dry run refitted a model inside
    # warnings.catch_warnings(record=True) with warnings.simplefilter("always", ...), and its
    # card showed the chips "record True" and "action always", which change no result.
    demo.run("import warnings as _warnings")
    try:
        cells = [{"id": "w", "source": 'with _warnings.catch_warnings(record=True) as _caught:\n    _warnings.simplefilter("always")'}]
        analysis = demo.kernel("analyze_cells", {"cells": cells})["cells"]
        assert analysis["w"]["decisions"] == []
    finally:
        demo.run("del _warnings")


def test_each_call_leaves_its_own_decision_and_calls_that_agree_share_one(demo):
    """Home energy [4] merges twice and showed one chip, since the analysis
    kept the first decision of each name. Each decision is now keyed by its
    call: two merges that leave how='inner' share one decision with both calls,
    and a merge that passes how="left" has one of its own. Each call names the
    frame it joins, and the server finds it by the same place."""
    import ast

    from whybook.server import codegen

    agree = 'both = weekly.merge(patients[["patient_id", "age"]], on="patient_id").merge(olink, on="patient_id")'
    differ = 'both = weekly.merge(patients, on="patient_id").merge(olink, on="patient_id", how="left")'
    cells = [{"id": "agree", "source": agree}, {"id": "differ", "source": differ}]
    analysis = demo.kernel("analyze_cells", {"cells": cells})["cells"]
    (how,) = [d for d in analysis["agree"]["decisions"] if d["name"] == "how"]
    assert (how["value"], how["provenance"]) == ("'inner'", "library_default")
    assert how["calls"] == [{"line": 1, "col": 14, "target": "patients"}, {"line": 1, "col": 70, "target": "olink"}]
    tree = ast.parse(agree)
    assert sorted(codegen.call_site(call) for call in codegen.calls_to(tree, "merge")) == [(1, 14), (1, 70)]
    hows = {d["provenance"]: d for d in analysis["differ"]["decisions"] if d["name"] == "how"}
    assert hows["library_default"]["calls"] == [{"line": 1, "col": 14, "target": "patients"}]
    assert (hows["literal"]["value"], hows["literal"]["calls"]) == ("'left'", [{"line": 1, "col": 47, "target": "olink"}])


def test_each_file_a_cell_reads_is_a_decision_named_by_the_file(demo):
    """Home energy [2] reads four files and showed one chip, filepath_or_buffer =
    'homes.csv'; read_parquet's file, a parameter named path, showed none."""
    source = '_a = pd.read_csv("homes.csv")\n_b = pd.read_csv("data/weather.csv")\n_c = pd.read_parquet("readings.parquet")'
    decisions = demo.kernel("analyze_cells", {"cells": [{"id": "load", "source": source}]})["cells"]["load"]["decisions"]
    assert [(d["param"], d["value"], d["calls"][0]["target"]) for d in decisions] == [
        # A library default of both read_csv calls, from the list (design iteration 1.86).
        ("header", "'infer'", "homes"),
        ("filepath_or_buffer", "'homes.csv'", "homes"),
        ("filepath_or_buffer", "'data/weather.csv'", "weather"),
        ("path", "'readings.parquet'", "readings"),
    ]


def test_the_lines_of_a_call_are_those_of_the_cell_as_written(demo):
    # IPython's transform drops leading blank lines, which moved each call up.
    source = "\n\n_merged = weekly.merge(patients, on='patient_id')"
    decisions = demo.kernel("analyze_cells", {"cells": [{"id": "blank", "source": source}]})["cells"]["blank"]["decisions"]
    how = next(d for d in decisions if d["name"] == "how")
    assert how["calls"] == [{"line": 3, "col": 17, "target": "patients"}]
    assert codegen_site(source, "merge") == [(3, 17)]


def codegen_site(source, function):
    import ast

    from whybook.server import codegen

    return [codegen.call_site(call) for call in codegen.calls_to(ast.parse(source), function)]


def test_definitions_uses_and_columns(demo):
    weekly = demo.analysis["weekly"]
    assert weekly["defs"] == ["weekly"]
    assert {"diary", "patients", "drop_sparse"} <= set(weekly["uses"])
    assert weekly["columns"]["diary"] == ["pain_score", "patient_id", "week"]


def test_a_frame_built_from_its_columns_and_shown_names_no_column(demo):
    # The keys that build a frame, and head(), which shows all of it, analyse
    # nothing: the Exploration panel counts a column once a cell uses it.
    demo.run("scores = pd.DataFrame({'group': ['a', 'b'], 'score': [3.1, 4.2], 'hours': [2, 5]})")
    try:
        cells = [
            {"id": "make", "source": "scores = pd.DataFrame({'group': ['a', 'b'], 'score': [3.1, 4.2], 'hours': [2, 5]})\nscores.head()"},
            {"id": "use", "source": "scores[['score', 'hours']].corr()"},
            {"id": "subset", "source": "pairs = scores[['score', 'hours']]"},
        ]
        analysis = demo.kernel("analyze_cells", {"cells": cells})["cells"]
        assert analysis["make"]["columns"] == {}
        assert analysis["use"]["columns"] == {"scores": ["hours", "score"]}
        # A frame made from another one names the columns it reads.
        assert analysis["subset"]["columns"] == {"scores": ["hours", "score"]}
    finally:
        demo.run("del scores")


def test_region_summary(demo):
    result = demo.kernel(
        "region_summary",
        {"frame": "weekly", "x": "week", "x0": 6, "x1": 9, "y": "pain_score", "by": "treatment_arm", "unit": "patient_id"},
    )
    frame = demo.shell.user_ns["weekly"]
    assert result["rows"] == int(frame["week"].between(6, 9).sum())
    assert [group["name"] for group in result["groups"]] == ["A", "B"]
    assert result["seen"]


def test_region_summary_of_a_box(demo):
    # A box on a Plotly chart bounds y too.
    box = demo.kernel("region_summary", {"frame": "weekly", "x": "week", "x0": 6, "x1": 9, "y": "pain_score", "y0": 2, "y1": 5})
    frame = demo.shell.user_ns["weekly"]
    assert box["rows"] == int((frame["week"].between(6, 9) & frame["pain_score"].between(2, 5)).sum())
    assert box["where"] == "6 <= week <= 9 and 2 <= pain_score <= 5"


def test_region_summary_of_picked_bars(demo):
    frame = demo.shell.user_ns["weekly"]
    arm = demo.kernel("region_summary", {"frame": "weekly", "x": "treatment_arm", "values": ["A"], "y": "pain_score", "unit": "patient_id"})
    assert arm["rows"] == int((frame["treatment_arm"] == "A").sum())
    assert arm["where"] == "treatment_arm = A"
    assert arm["seen"].startswith("Mean pain_score is ") and arm["seen"].endswith(" in treatment_arm B.")
    # A bar's label is its level as text: week 3 is "3".
    weeks = demo.kernel("region_summary", {"frame": "weekly", "x": "week", "values": ["3", "4"]})
    assert weeks["rows"] == int(frame["week"].isin([3, 4]).sum())
    assert weeks["seen"] == f"{weeks['rows']} of {len(frame)} rows have week in 3 and 4."


def test_kernel_code_leaves_no_names_behind(demo):
    assert not [name for name in demo.shell.user_ns if name.startswith("_whybook_")]


def test_odd_values_do_not_break_the_listing(demo):
    # A long text without a long run of letters and digits, which would make it a secret.
    demo.run("_odd = __import__('pandas').DataFrame({'lists': [[1], [2]]})\nodd_frame = _odd\nlong_text = 'pain score ' * 10")
    try:
        listing = demo.kernel("inspect_variables", {})
        odd = next(v for v in listing["variables"] if v["name"] == "odd_frame")
        assert "unique" not in odd["columns"][0]
        assert next(v for v in listing["variables"] if v["name"] == "long_text")["kind"] == "other"
    finally:
        demo.run("del _odd, odd_frame, long_text")


def test_polars_frame_is_listed_with_an_ordered_enum(demo):
    pl = pytest.importorskip("polars")
    ns = demo.shell.user_ns
    ns["stages_pl"] = pl.DataFrame({"stage": ["I", "II", "I"], "arm": ["A", "B", "A"], "x": [1.0, None, 2.0]}).with_columns(
        pl.col("stage").cast(pl.Enum(["I", "II"])), pl.col("arm").cast(pl.Categorical)
    )
    try:
        listed = next(v for v in demo.kernel("inspect_variables", {})["variables"] if v["name"] == "stages_pl")
        assert (listed["kind"], listed["type"], listed["rows"]) == ("dataframe", "polars.dataframe.frame.DataFrame", 3)
        tags = {c["label"]: (c["tag"], c.get("missing")) for c in listed["columns"]}
        # An Enum keeps its order, as an ordered pandas categorical does.
        assert tags == {"stage": ("ord", 0), "arm": ("cat", 0), "x": ("num", 1)}
    finally:
        ns.pop("stages_pl", None)


# The cases of the rule that hides a secret are in data/secret_names.json (test_secret_names.py).
TOKEN = "hf_" + "Q" * 34


def test_a_token_read_from_the_environment_is_listed_with_its_length_only(demo, monkeypatch):
    monkeypatch.setenv("HF_TOKEN", TOKEN)
    demo.run('HF_TOKEN = __import__("os").environ["HF_TOKEN"]')
    try:
        listing = demo.kernel("inspect_variables", {})
    finally:
        demo.run("del HF_TOKEN")
    token = next(v for v in listing["variables"] if v["name"] == "HF_TOKEN")
    assert token == {"name": "HF_TOKEN", "label": "HF_TOKEN", "kind": "constant", "type": "builtins.str", "secret": True, "length": 37}
    assert TOKEN not in json.dumps(listing)
    # The demo's own constants keep their values.
    assert next(v for v in listing["variables"] if v["name"] == "MIN_DAYS")["value"] == "14"


def test_a_token_in_a_call_is_no_decision(demo):
    demo.run("def login(token=None, retries=3, max_tokens=256):\n    return token")
    try:
        source = f"login(token={TOKEN!r}, retries=5, max_tokens=512)"
        analysis = demo.kernel("analyze_cells", {"cells": [{"id": "x", "source": source}]})["cells"]["x"]
    finally:
        demo.run("del login")
    # A number is no secret, whatever its name: max_tokens keeps its chip.
    assert [(d["name"], d["value"]) for d in analysis["decisions"]] == [("retries", "5"), ("max_tokens", "512")]
    assert TOKEN not in json.dumps(analysis)


def test_a_frame_changed_in_place_is_listed_again(demo):
    import numpy as np
    import pandas as pd

    def listed(known):
        return next(v for v in demo.kernel("inspect_variables", {"known": known})["variables"] if v["name"] == "visits_kept")

    demo.shell.user_ns["visits_kept"] = pd.DataFrame({"pain": [1.0, np.nan, 3.0, np.nan], "arm": ["A", "B", "A", "B"]})
    try:
        first = listed({})
        assert {c["label"]: c["missing"] for c in first["columns"]} == {"pain": 2, "arm": 0}
        assert listed({"visits_kept": first["fingerprint"]}) == {"name": "visits_kept", "unchanged": True, "fingerprint": first["fingerprint"]}
        # The same frame, shape and column names: its missing counts tell the change.
        demo.run('visits_kept["pain"] = visits_kept["pain"].fillna(0)')
        filled = listed({"visits_kept": first["fingerprint"]})
        assert {c["label"]: c["missing"] for c in filled["columns"]} == {"pain": 0, "arm": 0}
        # And a column's type, where no count changes.
        demo.run('visits_kept["arm"] = visits_kept["arm"].map({"A": 0, "B": 1})')
        mapped = listed({"visits_kept": filled["fingerprint"]})
        assert {c["label"]: c["tag"] for c in mapped["columns"]} == {"pain": "num", "arm": "int"}
    finally:
        demo.shell.user_ns.pop("visits_kept", None)


def test_small_numbers_keep_six_significant_figures(demo):
    import pandas as pd
    import statsmodels.formula.api as smf

    ns = demo.shell.user_ns
    ns["tiny_values"] = pd.DataFrame({"p": [1e-7, 4.2e-5, 0.00123456789], "big": [1234567.891, 2.0, 3.0]})
    ns["tiny_fit"] = smf.ols("y ~ x", data=pd.DataFrame({"x": [0.0, 1.0, 2.0, 3.0], "y": [1.0, 1.00004, 1.00008, 1.000121]})).fit()
    try:
        listing = {v["name"]: v for v in demo.kernel("inspect_variables", {})["variables"]}
    finally:
        ns.pop("tiny_values", None)
        ns.pop("tiny_fit", None)
    # Rounded to four decimals, 1e-7 read 0 and a slope of 4e-5 read 0: the view formats a number for display itself.
    columns = {c["label"]: c for c in listing["tiny_values"]["columns"]}
    assert (columns["p"]["min"], columns["p"]["max"], columns["big"]["max"]) == (1e-07, 0.00123457, 1234570)
    slope = next(term for term in listing["tiny_fit"]["terms"] if term["term"] == "x")
    assert slope["coef"] == pytest.approx(4.03e-05, rel=1e-3) and slope["coef"] == float(f"{slope['coef']:.6g}")


def test_the_interval_of_a_ribbon_is_named_for_what_the_helper_computes(demo):
    source = 'whybook.ribbon(weekly, "week", "pain_score", by="treatment_arm")'
    analysis = demo.kernel("analyze_cells", {"cells": [{"id": "r", "source": source}]})["cells"]["r"]
    [ci] = [decision for decision in analysis["decisions"] if decision["name"] == "ci"]
    assert (ci["value"], ci["note"]) == ("'normal'", "t interval of the mean, with n - 1 degrees of freedom: assumes normal values at each x")
