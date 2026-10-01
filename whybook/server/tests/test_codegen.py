from whybook.server import codegen


def test_add_keyword_to_direct_call():
    assert codegen.add_keyword("x = f(a)", "f", "k", "1") == "x = f(a, k=1)"
    assert codegen.add_keyword("x = f()", "f", "k", "1") == "x = f(k=1)"


def test_add_keyword_through_pipe_keeps_the_rest_of_the_cell():
    source = "# keep this comment\nweekly = (\n    diary.pipe(drop_sparse)\n    .merge(p, on='id')\n)"
    edited = codegen.add_keyword(source, "drop_sparse", "min_days", "MIN_DAYS")
    assert edited == "# keep this comment\nweekly = (\n    diary.pipe(drop_sparse, min_days=MIN_DAYS)\n    .merge(p, on='id')\n)"


def test_add_keyword_replaces_a_value_already_passed():
    assert codegen.add_keyword("m.fit(reml=True)", "fit", "reml", "False") == "m.fit(reml=False)"


def test_add_keyword_after_trailing_comma():
    source = "f(\n    a,\n    b=2,\n)"
    assert codegen.add_keyword(source, "f", "c", "3") == "f(\n    a,\n    b=2,\nc=3)"


def test_add_keyword_without_matching_call():
    assert codegen.add_keyword("g(1)", "f", "k", "1") is None


def test_a_call_is_found_by_where_the_cell_names_its_function():
    """Every call of a chain starts where the chain starts, (1, 7) here, so
    each call is found by where its function's name is written: two merges
    of one chain are two places, and a piped function is where it is named."""
    source = "both = visits.merge(patients, on='id').merge(labs, on='id')\nkept = diary.pipe(drop_sparse)"
    import ast

    tree = ast.parse(source)
    assert sorted(codegen.call_site(call) for call in codegen.calls_to(tree, "merge")) == [(1, 14), (1, 39)]
    assert [codegen.call_site(call) for call in codegen.calls_to(tree, "drop_sparse")] == [(2, 18)]
    # A name after non-ASCII text: the column counts UTF-8 bytes, as ast does.
    assert [codegen.call_site(call) for call in codegen.calls_to(ast.parse("é = d.merge(x)"), "merge")] == [(1, 7)]


def test_add_keyword_to_one_call_of_several():
    source = "both = visits.merge(patients, on='id').merge(labs, on='id')"
    assert codegen.add_keyword(source, "merge", "how", '"left"', at=[(1, 39)]) == "both = visits.merge(patients, on='id').merge(labs, on='id', how=\"left\")"
    assert codegen.add_keyword(source, "merge", "how", '"left"', at=[(1, 14)]) == "both = visits.merge(patients, on='id', how=\"left\").merge(labs, on='id')"
    # A place that holds no call of the function changes nothing.
    assert codegen.add_keyword(source, "merge", "how", '"left"', at=[(1, 0)]) is None
    edited = "both = visits.merge(patients, on='id', how='left').merge(labs, on='id', how='left')"
    assert codegen.replace_keyword_value(edited, "merge", "how", '"outer"', at=[(1, 14)]) == "both = visits.merge(patients, on='id', how=\"outer\").merge(labs, on='id', how='left')"
    assert codegen.replace_argument("f(1).f(1)", "f", "1", "2", at=[(1, 5)]) == "f(1).f(2)"


def test_add_keyword_on_invalid_source():
    assert codegen.add_keyword("f(", "f", "k", "1") is None


def test_replace_string_keeps_quotes():
    assert codegen.replace_string("m('y ~ x')", "y ~ x", "y ~ x + z") == "m('y ~ x + z')"


def test_rename_leaves_attributes_and_keywords():
    source = "weekly = f(weekly, weekly=weekly.weekly)\nweekly.weekly = g(weekly=weekly)"
    assert codegen.rename(source, {"weekly": "_weekly"}) == "_weekly = f(weekly, weekly=weekly.weekly)\n_weekly.weekly = g(weekly=_weekly)"


def test_rename_starts_at_the_first_assignment():
    # The cell reads the frame it starts from, and assigns the branch's own.
    source = 'weekly = weekly[weekly["days"] >= 14]\nweekly.head()'
    assert codegen.rename(source, {"weekly": "weekly_if_7"}) == 'weekly_if_7 = weekly[weekly["days"] >= 14]\nweekly_if_7.head()'
    # x += 1 reads x first.
    assert codegen.rename("total += len(rows)\ntotal", {"total": "total_2"}) == "total_2 = total + (len(rows))\ntotal_2"
    # A read in a function body runs when the function is called, after the cell assigned the name.
    source = "def show():\n    return weekly.head()\nweekly = weekly.dropna()\nshow()"
    assert codegen.rename(source, {"weekly": "w2"}) == "def show():\n    return w2.head()\nw2 = weekly.dropna()\nshow()"
    # A read of what the cell starts from can go to another name: a frame dropped on the cell.
    assert codegen.rename("weekly = weekly.dropna()\nweekly", {"weekly": "w2"}, inputs={"weekly": "other"}) == "w2 = other.dropna()\nw2"


def test_a_loop_that_reads_what_it_assigns_starts_from_the_value_before_the_cell():
    source = "for week in weeks:\n    if week > 1:\n        total = total + week\nprint(total)"
    renamed = codegen.rename(source, {"total": "total_2"})
    assert renamed == "total_2 = total\nfor week in weeks:\n    if week > 1:\n        total_2 = total_2 + week\nprint(total_2)"
    namespace = {"weeks": [1, 2, 3], "total": 10}
    exec(renamed, namespace)  # noqa: S102
    assert (namespace["total_2"], namespace["total"]) == (15, 10)


def test_model_call():
    source = 'fit = smf.mixedlm(\n    "y ~ arm * month",\n    data=model_data,\n    groups="patient_id",\n    re_formula="~month",\n).fit()'
    call = codegen.model_call(source)
    assert call.function == "mixedlm"
    assert call.formula == "y ~ arm * month"
    assert call.data == "model_data"
    assert call.keywords == {"groups": '"patient_id"', "re_formula": '"~month"'}
    assert call.fit_target == "fit"


def test_defined_names_in_order():
    assert codegen.defined_names("a = 1\nb, c = 2, 3\na += 1") == ["a", "b", "c"]


FRAMES = {
    "weekly": {"patient_id": "id", "week": "int", "pain_score": "num"},
    "diary": {"patient_id": "id", "week": "int", "sleep_hours": "num"},
    "olink": {"patient_id": "id", "IL6": "num"},
    "other": {"thing": "num"},
}


def test_join_keys_prefer_the_unit():
    assert codegen.join_keys(FRAMES["weekly"], FRAMES["diary"], "patient_id") == ["patient_id", "week"]


def test_plan_data_joins_and_averages_per_key():
    plan = codegen.plan_data("weekly", ["sleep_hours", "IL6"], FRAMES, "patient_id", target="_sleep_hours_il6_data")
    assert plan.name == "_sleep_hours_il6_data"
    assert plan.lines[0] == "_sleep_hours_il6_data = weekly"
    assert 'diary.groupby(["patient_id", "week"]' in plan.lines[1]
    assert 'olink.groupby("patient_id"' in plan.lines[2]
    assert plan.notes == [
        "sleep_hours lives in diary: joined on patient_id, week first",
        "IL6 lives in olink: joined on patient_id first",
    ]


def test_plan_data_joins_polars_frames_in_polars():
    plan = codegen.plan_data("weekly", ["sleep_hours"], FRAMES, "patient_id", target="_sleep_data", library="polars")
    assert plan.lines == [
        "_sleep_data = weekly",
        '_sleep_data = _sleep_data.join(diary.group_by(["patient_id", "week"]).agg(pl.col("sleep_hours").mean()), on=["patient_id", "week"], how="left")',
    ]


def test_plan_data_without_joins():
    plan = codegen.plan_data("weekly", ["pain_score"], FRAMES, "patient_id", target="_pain_data")
    assert (plan.lines, plan.name) == ([], "weekly")


def test_plan_data_without_a_shared_key():
    assert codegen.plan_data("weekly", ["thing"], FRAMES, "patient_id", target="_thing_data") is None


def test_identifier():
    assert codegen.identifier("IL6 vs pain score") == "il6_vs_pain_score"
    assert codegen.identifier("7 days") == "_7_days"


def test_a_temporary_is_named_after_what_its_option_asks_about_and_what_it_holds():
    assert codegen.temporary("IL6_vs_pain_score", "data") == "_il6_vs_pain_score_data"
    assert codegen.temporary("MIN_DAYS", "value") == "_min_days_value"
    assert codegen.temporary("7 day mean", "rows") == "_7_day_mean_rows"


def test_missing_imports_are_added_after_the_leading_comment():
    code = "# Weekly means\nfor i in range(3):\n    whybook.progress(i / 3)\nout = pd.DataFrame()"
    assert codegen.add_missing_imports(code).split("\n")[:3] == [
        "# Weekly means",
        "import whybook",
        "import pandas as pd",
    ]


def test_polars_is_imported_as_pl():
    code = "# Means\nout = df.select(pl.col('x').mean())"
    assert codegen.add_missing_imports(code).split("\n")[:2] == ["# Means", "import polars as pl"]


def test_imports_the_cell_has_are_not_repeated():
    code = "import whybook\nimport pandas as pd\nwhybook.ribbon(pd.DataFrame(), x='a', y='b')"
    assert codegen.add_missing_imports(code) == code


def test_names_the_cell_binds_itself_need_no_import():
    code = "np = 3\nprint(np)"
    assert codegen.add_missing_imports(code) == code

