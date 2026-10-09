"""What-if options for one decision of a cell: the popup of a decision chip."""

import types
from pathlib import Path

import nbformat
import pandas as pd
import pytest

from whybook.server import codegen
from whybook.server.questions.cells import CellInfo, Decision, DecisionCall, cell_questions, decision_options, next_steps, open_assumption, where_text
from whybook.server.questions.models import Context, InvalidRequest

WEEKLY = CellInfo("c2", "[2]", "weekly = weekly_means(diary)\nweekly.head()")
MIN_DAYS = Decision("MIN_DAYS", "14", "defaulted", param="min_days", function="weekly_means", source_file="prep.py", source_line=12)
# Home energy [4]: two merges that leave how='inner', one decision of two calls,
# each at the place where the cell names merge.
DAILY = CellInfo("c4", "[4]", 'daily = (\n    readings.merge(homes, on="home_id")\n    .merge(weather, on=["region", "date"])\n)\ndaily.head()')
HOMES, WEATHER = DecisionCall(2, 13, "homes"), DecisionCall(3, 5, "weather")
HOW = Decision("how", "'inner'", "library_default", param="how", function="DataFrame.merge", calls=(HOMES, WEATHER))


def texts(result):
    return [option["text"] for option in result["options"]]


def option(result, text):
    return next(o for o in result["options"] if o["text"] == text)


def test_a_constant_from_a_module_can_be_lower_higher_or_chosen_in_the_cell():
    result = decision_options(WEEKLY, MIN_DAYS, Context())
    assert texts(result)[:2] == ["What if MIN_DAYS were 7?", "What if MIN_DAYS were 21?"]
    lower = option(result, "What if MIN_DAYS were 7?")
    assert lower["placement"]["kind"] == "branch"
    # MIN_DAYS counts days: a week and three weeks, each with what it means.
    assert lower["effect"] == "7 instead of 14 (−7) · a week"
    # The branch keeps the original's variables: it names its own after the value.
    assert "weekly_if_7 = weekly_means(diary, min_days=7)" in lower["code"]
    assert "weekly_if_7.head()" in lower["code"]
    chosen = option(result, "Choose MIN_DAYS in [2]")
    assert chosen["placement"]["kind"] == "edit"
    assert chosen["code"].startswith("MIN_DAYS = 14  # chosen here; was the default in prep.py:12\n")
    assert "weekly_means(diary, min_days=MIN_DAYS)" in chosen["code"]


def test_a_library_default_offers_its_other_value():
    cell = CellInfo("c5", "[5]", 'fit = smf.mixedlm("pain ~ week", data=weekly, groups="patient_id").fit()')
    reml = Decision("reml", "True", "library_default", param="reml", function="MixedLM.fit")
    result = decision_options(cell, reml, Context())
    assert texts(result)[0] == "What if reml were False?"
    assert '.fit(reml=False)' in result["options"][0]["code"]
    assert "fit_if_false = smf.mixedlm" in result["options"][0]["code"]
    merge = Decision("how", "'inner'", "library_default", param="how", function="DataFrame.merge")
    both = CellInfo("c6", "[6]", "both = weekly.merge(patients, on='patient_id')")
    assert texts(decision_options(both, merge, Context()))[:2] == ['What if how were "left"?', 'What if how were "outer"?']
    # dropna's how takes other values than merge's.
    dropna = Decision("how", "'any'", "library_default", param="how", function="DataFrame.dropna")
    kept = CellInfo("c7", "[7]", "kept = weekly.dropna()")
    assert texts(decision_options(kept, dropna, Context()))[0] == 'What if how were "all"?'


def test_a_default_of_a_class_goes_into_the_call_of_the_class():
    # The kernel names the default of LogisticRegression() by the class's __init__. The finance
    # video's dry run clicked the chip "C 1.0", and its popover offered no what-if: the code
    # looked for a call of __init__ in the cell.
    cell = CellInfo("c4", "[4]", "scorecard = LogisticRegression().fit(X, y)\nscorecard.coef_")
    c = Decision.from_json(
        {"name": "C", "value": "1.0", "provenance": "library_default", "param": "C", "function": "LogisticRegression.__init__", "calls": [{"line": 1, "col": 12}]}
    )
    result = decision_options(cell, c, Context())
    assert texts(result) == ["What if C were 1e6?", "Choose C in [4]"]
    assert option(result, "What if C were 1e6?")["effect"].endswith("· almost no penalty on the coefficients")
    assert "scorecard_if_1e6 = LogisticRegression(C=1e6).fit(X, y)" in result["options"][0]["code"]
    chosen = option(result, "Choose C in [4]")["code"]
    assert chosen.startswith("C = 1.0  # chosen here; was the default of LogisticRegression\n")
    assert "scorecard = LogisticRegression(C=C).fit(X, y)" in chosen


# The scorecard of the finance video stopped at LogisticRegression's max_iter=100 before it
# converged; the view sends the limit only then (design iteration 1.116).
SCORECARD = CellInfo("c4", "[4]", "scorecard = LogisticRegression().fit(X, y)\nscorecard.coef_")
LIMIT = {"name": "max_iter", "value": "100", "provenance": "library_default", "param": "max_iter", "function": "LogisticRegression", "calls": [{"line": 1, "col": 12}]}


def test_an_iteration_limit_offers_more_iterations():
    result = decision_options(SCORECARD, Decision.from_json({**LIMIT, "when": "not_converged"}), Context())
    assert texts(result)[:2] == ["What if max_iter were 1000?", "What if max_iter were 10000?"]
    more = option(result, "What if max_iter were 1000?")
    assert more["effect"] == "1000 instead of 100 (+900) · ten times as many iterations"
    assert "scorecard_if_1000 = LogisticRegression(max_iter=1000).fit(X, y)" in more["code"]


def test_an_iteration_limit_at_which_the_fit_stopped_is_an_open_assumption():
    limit = Decision.from_json({**LIMIT, "when": "not_converged"})
    assert open_assumption(SCORECARD, limit, Context()) == (True, "the fit stopped at max_iter = 100, before it converged")
    # Without the condition, the limit is a library default like any other, with no sign.
    assert open_assumption(SCORECARD, Decision.from_json(LIMIT), Context()) == (False, None)
    assert Decision.from_json({**LIMIT, "when": "always"}).when is None
    # Worth asking next asks about it, with its sign, and the branch that answers it.
    steps = [step for step in next_steps([SCORECARD.__class__(**{**SCORECARD.__dict__, "decisions": (limit,)})], Context(), {}, set()) if "max_iter" in step.text]
    assert [step.text for step in steps] == ["Does max_iter = 100 change the result of [4]?"]
    assert steps[0].reasons[0] == "the fit stopped at max_iter = 100, before it converged"
    assert "LogisticRegression(max_iter=1000)" in steps[0].code


def test_a_constant_assigned_in_the_cell_changes_where_it_is_assigned():
    cell = CellInfo("c3", "[3]", "ALPHA = 0.05\nsignificant = results[results.p < ALPHA]")
    alpha = Decision("ALPHA", "0.05", "literal")
    result = decision_options(cell, alpha, Context())
    # A significance level takes the conventional levels next to it; the fallback rule would give half and double: 0.025 and 0.1.
    assert texts(result)[:2] == ["What if ALPHA were 0.01?", "What if ALPHA were 0.1?"]
    assert result["options"][1]["code"].splitlines()[1:] == ["ALPHA_if_0_1 = 0.1", "significant_if_0_1 = results[results.p < ALPHA_if_0_1]"]


def test_a_value_the_analyst_types_becomes_one_branch():
    result = decision_options(WEEKLY, MIN_DAYS, Context(), value="10")
    assert texts(result) == ["What if MIN_DAYS were 10?"]
    assert "weekly_means(diary, min_days=10)" in result["options"][0]["code"]
    with pytest.raises(InvalidRequest):
        decision_options(WEEKLY, MIN_DAYS, Context(), value="10 +")


def self_filtering():
    return {
        "weekly": pd.DataFrame({"patient_id": [1, 2, 3], "days": [10, 14, 20], "pain": [3.0, 4.0, 5.0]}),
        "patients": pd.DataFrame({"patient_id": [1, 2], "arm": ["A", "B"]}),
    }


def test_a_branch_of_a_cell_that_makes_its_frame_from_itself_reads_the_frame_before_the_cell():
    how = Decision("how", "'inner'", "library_default", param="how", function="DataFrame.merge")
    cell = CellInfo("c4", "[4]", 'weekly = weekly[weekly["days"] >= 14].merge(patients, on="patient_id")\nweekly.head()', decisions=(how,))
    left = option(decision_options(cell, how, Context()), 'What if how were "left"?')
    namespace = self_filtering()
    exec(left["code"], namespace)  # noqa: S102  the bug raised NameError: name 'weekly_if_left' is not defined
    assert (len(namespace["weekly_if_left"]), len(namespace["weekly"])) == (2, 3)
    # The branch of the default does the same.
    [branch] = [q for q in cell_questions([cell], Context()) if q.text.startswith("Is how=")]
    exec(branch.code, self_filtering())  # noqa: S102


def test_both_what_if_values_of_the_residual_plot_of_the_later_demo_run():
    """Cell [7] of examples/pain_diary/pain_diary_cohort_6h.ipynb, whose max_points chip offers 750 and 3000: half and twice as many points."""
    notebook = nbformat.read(Path(__file__).resolve().parents[3] / "examples" / "pain_diary" / "pain_diary_cohort_6h.ipynb", 4)
    source = next(c.source for c in notebook.cells if c.cell_type == "code" and c.id == "lmm_checks")
    assert source.startswith("model_data = model_data.assign(")
    cell = CellInfo("lmm_checks", "[7]", source)
    points = Decision("max_points", "1500", "literal", param="max_points", function="scatter")
    options = [o for o in decision_options(cell, points, Context())["options"] if o["text"].startswith("What if")]
    assert [o["text"] for o in options] == ["What if max_points were 750?", "What if max_points were 3000?"]
    for chosen in options:
        plotted = []
        model_data = pd.DataFrame({"treatment_arm": ["A", "B"] * 3, "pain": range(6)})
        fit = types.SimpleNamespace(fittedvalues=pd.Series([1.0] * 6), resid=pd.Series([0.5, -0.5] * 3))
        namespace = {"model_data": model_data, "lmm_fit": fit, "display": lambda value: None}
        namespace["whybook"] = types.SimpleNamespace(scatter=lambda data, **options: plotted.append((len(data.columns), options["max_points"])))
        exec(chosen["code"], namespace)  # noqa: S102
        assert plotted == [(4, int(chosen["text"].split()[-1].rstrip("?")))]
        assert list(namespace["model_data"].columns) == ["treatment_arm", "pain"]


def test_code_helpers_change_an_assignment_and_a_positional_argument():
    assert codegen.replace_assignment("A = 1\nb = A + 1", "A", "2") == "A = 2\nb = A + 1"
    assert codegen.replace_assignment("b = 1", "A", "2") is None
    assert codegen.replace_argument("split(X, y, 0.2)", "split", "0.2", "0.3") == "split(X, y, 0.3)"


def test_a_sweep_keeps_the_counts_of_its_table_whole():
    """The table of a sweep, one row per value tried: its counts are whole
    numbers. pandas turned the rows into columns with ``.T`` and made every
    count a float next to the mean, so the demo showed "5868.0 weekly rows"
    and "307.0 patient_ids"."""
    import pandas as pd

    from whybook.server.questions.cells import sweep_code

    context = Context.from_json(
        {
            "outcome": "pain",
            "unit": "patient_id",
            "frames": {"weekly": {"rows": 6, "columns": {"patient_id": "id", "week": "int", "pain": "num"}}},
        }
    )
    code = sweep_code(WEEKLY, MIN_DAYS, context)
    diary = pd.DataFrame({"patient_id": ["a", "a", "b", "c", "c", "c"], "week": [1, 2, 1, 1, 2, 3], "pain": [2.0, 3.0, 4.0, 1.0, 2.5, 3.5]})

    def weekly_means(frame, min_days=14):
        counts = frame.groupby("patient_id")["week"].transform("size")
        return frame[counts >= min_days // 7]

    namespace = {"diary": diary, "weekly_means": weekly_means}
    exec(compile(code, "<sweep>", "exec"), namespace)
    table = namespace["min_days_sweep"]
    assert list(table.columns) == ["weekly rows", "patient_ids", "mean pain"]
    assert table["weekly rows"].tolist() == [6, 5, 3]
    assert table["weekly rows"].dtype.kind == "i"
    assert table["patient_ids"].dtype.kind == "i"
    assert table["mean pain"].dtype.kind == "f"
    assert "5.0" not in table.to_string()


def test_a_choice_that_a_branch_asks_about_is_not_offered_again_after_the_cell_runs_again():
    """A cell's label is its execution count: [4] becomes [10] when the cell runs
    again. The branch that answered "Does MIN_DAYS = 14 change the result of [4]?"
    keeps that text, and Worth asking next offered the same question again as
    "... of [10]?"."""
    from whybook.server.questions.cells import next_steps

    weekly = CellInfo("c4", "[10]", WEEKLY.source, decisions=(MIN_DAYS,))
    branch = CellInfo("c4b", "[10b]", "min_days_sweep", title="Does MIN_DAYS = 14 change the result of [4]?", branch_of="c4")
    other = CellInfo("c5", "[11]", WEEKLY.source, decisions=(MIN_DAYS,))
    texts = [step.text for step in next_steps([weekly, branch, other], Context(), {}, set())]
    assert "Does MIN_DAYS = 14 change the result of [10]?" not in texts
    # The same choice in a cell that no branch asks about is still offered.
    assert "Does MIN_DAYS = 14 change the result of [11]?" in texts


def test_a_value_goes_into_the_one_merge_that_the_analyst_chose():
    """Home energy [4] merges with homes and then with weather, and both leave
    how='inner'. A value used to change every merge of the cell, so one merge
    could not be tried alone; it now goes into the call chosen in the menu."""
    weather = decision_options(DAILY, HOW, Context(), calls=(WEATHER,))
    assert texts(weather)[:2] == ['What if how were "left" in the merge with weather?', 'What if how were "outer" in the merge with weather?']
    code = option(weather, 'What if how were "left" in the merge with weather?')["code"]
    assert code.splitlines()[0] == "# What if how were \"left\" in the merge with weather? A branch of [4], where it is 'inner'."
    assert '    readings.merge(homes, on="home_id")\n    .merge(weather, on=["region", "date"], how="left")' in code
    assert "daily_if_left.head()" in code
    chosen = option(weather, "Choose how in [4], in the merge with weather")
    assert 'readings.merge(homes, on="home_id")\n    .merge(weather, on=["region", "date"], how=how)' in chosen["code"]
    # Both merges, as the chip's menu offers first.
    both = decision_options(DAILY, HOW, Context())
    assert texts(both)[0] == 'What if how were "left" in both merges?'
    assert 'readings.merge(homes, on="home_id", how="left")\n    .merge(weather, on=["region", "date"], how="left")' in both["options"][0]["code"]
    # A typed value goes into the chosen call too.
    typed = decision_options(DAILY, HOW, Context(), value='"right"', calls=(HOMES,))
    assert texts(typed) == ['What if how were "right" in the merge with homes?']
    assert 'readings.merge(homes, on="home_id", how="right")\n    .merge(weather, on=["region", "date"])' in typed["options"][0]["code"]


def test_a_decision_kept_before_calls_were_listed_changes_every_call():
    kept = Decision.from_json({"name": "how", "value": "'inner'", "provenance": "library_default", "param": "how", "function": "DataFrame.merge"})
    assert kept.calls == ()
    result = decision_options(DAILY, kept, Context())
    assert texts(result)[0] == 'What if how were "left"?'
    assert result["options"][0]["code"].count('how="left"') == 2


def test_the_calls_of_a_request_must_be_calls_of_the_decision():
    decision = Decision.from_json(
        {"name": "how", "value": "'inner'", "provenance": "library_default", "param": "how", "function": "DataFrame.merge", "calls": [{"line": 2, "col": 13, "target": "homes"}, {"line": 3, "col": 5, "target": "weather"}]}
    )
    assert decision.calls == (HOMES, WEATHER)
    assert decision.chosen_calls(None) is None
    assert decision.chosen_calls([{"line": 3, "col": 5}]) == (WEATHER,)
    with pytest.raises(InvalidRequest):
        decision.chosen_calls([{"line": 9, "col": 0}])
    with pytest.raises(InvalidRequest):
        decision.chosen_calls("all")
    # A place that no longer holds a call of the function, as after an edit, offers no value.
    moved = Decision("how", "'inner'", "library_default", param="how", function="DataFrame.merge", calls=(DecisionCall(1, 0, "homes"),))
    assert decision_options(DAILY, moved, Context())["options"] == []


def test_where_a_value_goes_names_the_frame_of_each_call_and_its_line_where_two_share_one():
    three = Decision("how", "'inner'", "library_default", param="how", function="DataFrame.merge", calls=(HOMES, WEATHER, DecisionCall(5, 4, "homes")))
    assert where_text(three, None) == "all 3 merges"
    assert where_text(three, (HOMES,)) == "the merge with homes on line 2"
    assert where_text(three, (WEATHER,)) == "the merge with weather"
    assert where_text(three, (HOMES, WEATHER)) == "2 of the 3 merges"
    ribbons = Decision("ci", "'normal'", "library_default", param="ci", function="plots.ribbon", calls=(DecisionCall(6, 8, "february"), DecisionCall(7, 8, None)))
    assert where_text(ribbons, None) == "both calls"
    assert where_text(ribbons, ribbons.calls[:1]) == "the ribbon of february"
    assert where_text(ribbons, ribbons.calls[1:]) == "the ribbon on line 7"
    # One call needs no place.
    assert where_text(Decision("reml", "True", "library_default", param="reml", function="MixedLM.fit", calls=(DecisionCall(4, 2),)), None) == ""


def test_a_sweep_of_a_constant_goes_into_the_chosen_call():
    cell = CellInfo("c3", "[3]", "kept = diary.pipe(drop_sparse)\nothers = visits.pipe(drop_sparse)")
    decision = Decision("MIN_DAYS", "14", "defaulted", param="min_days", function="drop_sparse", calls=(DecisionCall(1, 18, "diary"), DecisionCall(2, 21, "visits")))
    context = Context.from_json({"frames": {"kept": {"rows": 3, "columns": {"patient_id": "id"}}}})
    result = decision_options(cell, decision, context, calls=decision.calls[1:])
    sweep = option(result, "Compare MIN_DAYS = 7, 14, 21 in the drop_sparse of visits in one table")["code"]
    assert "visits.pipe(drop_sparse, min_days=_min_days_value)" in sweep
    assert "diary.pipe(drop_sparse)\n" in sweep


def test_a_call_kept_in_another_form_is_left_out():
    decision = Decision.from_json({"name": "how", "value": "'inner'", "provenance": "library_default", "calls": [{"line": 2, "col": 13}, {"line": "2"}, "x"]})
    assert decision.calls == (DecisionCall(2, 13),)
    assert Decision.from_json({"name": "how", "value": "'inner'", "calls": {"line": 2}}).calls == ()


def test_a_value_goes_into_each_call_of_a_decision_of_several_functions():
    """[20] of the NHEFS video: two means and a sum leave skipna=True. The
    view shows one chip of the three calls, each of which names its function,
    and a value goes into each call by its own function."""
    cell = CellInfo("c20", "[20]", "means = (x0.mean(), x1.mean())\ntotal = missing.sum()")
    skipna = Decision.from_json(
        {
            "name": "skipna",
            "value": "True",
            "provenance": "library_default",
            "param": "skipna",
            "function": "Series.mean",
            "found": {"by": None, "library": "pandas", "version": "3.0.6"},
            "calls": [
                {"line": 1, "col": 12, "target": None, "function": "Series.mean"},
                {"line": 1, "col": 23, "target": None, "function": "Series.mean"},
                {"line": 2, "col": 16, "target": None, "function": "Series.sum"},
            ],
        }
    )
    every = decision_options(cell, skipna, Context(), value="False")
    assert texts(every) == ["What if skipna were False in all 3 calls?"]
    assert "means_if_false = (x0.mean(skipna=False), x1.mean(skipna=False))\ntotal_if_false = missing.sum(skipna=False)" in every["options"][0]["code"]
    assert skipna.calls[2] == DecisionCall(2, 16, None, "Series.sum")
    assert skipna.functions() == ("mean", "sum")
    # The sum alone, as the chip's menu offers it.
    alone = decision_options(cell, skipna, Context(), value="False", calls=skipna.calls[2:])
    assert texts(alone) == ["What if skipna were False in the sum on line 2?"]
    assert "means_if_false = (x0.mean(), x1.mean())\ntotal_if_false = missing.sum(skipna=False)" in alone["options"][0]["code"]
    assert where_text(skipna, skipna.calls[:1]) == "the mean on line 1"
    # The choice written in the cell names both functions.
    chosen = option(decision_options(cell, skipna, Context()), "Choose skipna in [20], in all 3 calls")
    assert chosen["code"].startswith("skipna = True  # chosen here; was the default of Series.mean and Series.sum\n")
    assert "missing.sum(skipna=skipna)" in chosen["code"]
