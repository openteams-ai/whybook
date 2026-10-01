"""The rows behind rows picked in a table: kernel code run on the demo's kernel state."""

import numpy as np
import pandas as pd
import pytest

pytestmark = pytest.mark.demo


def rows_of(demo, frame, mask_code):
    """The rows that the code the snippet wrote picks."""
    return np.asarray(eval(mask_code, {**demo.shell.user_ns, "pd": pd}), dtype=bool)


def test_rows_of_a_frame_by_its_index(demo):
    patients = demo.shell.user_ns["patients"]
    result = demo.kernel("table_rows", {"frame": "patients", "keys": [], "labels": [["0"], ["1"]]})
    assert (result["rows"], result["total_rows"]) == (2, len(patients))
    assert result["mask"] == "patients.index.isin([0, 1])"
    assert result["where"] == "index in 0 and 1"
    assert result["seen"]


def test_rows_of_groups_by_a_key(demo):
    weekly = demo.shell.user_ns["weekly"]
    result = demo.kernel(
        "table_rows",
        {"frame": "weekly", "keys": ["treatment_arm"], "labels": [["A"]], "unit": "patient_id"},
    )
    arm = weekly["treatment_arm"] == "A"
    assert result["rows"] == int(arm.sum())
    assert result["units"] == weekly.loc[arm, "patient_id"].nunique()
    assert result["mask"] == "weekly['treatment_arm'] == 'A'"
    assert result["where"] == "treatment_arm = A"
    # The key itself does not count as a difference: every row here is arm A.
    assert all(entry["column"] != "treatment_arm" for entry in result["differences"])


def test_labels_read_back_as_the_values_of_their_level(demo):
    ns = demo.shell.user_ns
    ns["_tables_float"] = pd.DataFrame({"x": [1, 2, 3]}, index=[0.5, 1.25, 1 / 3])
    ns["_tables_dates"] = pd.DataFrame({"x": [1, 2]}, index=pd.to_datetime(["2024-01-01", "2024-01-02"]))
    ns["_tables_flags"] = pd.DataFrame({"flag": [True, False, True], "x": [1.0, 2.0, 3.0]})
    ns["_tables_two"] = pd.DataFrame(
        {"arm": ["A", "A", "B", "B"], "week": [1, 2, 1, 2], "pain": [3.0, 4.0, 5.0, 6.0]}
    ).set_index(["arm", "week"])
    try:
        # pandas writes 1/3 as 0.333333 and a date at midnight without its time.
        floats = demo.kernel("table_rows", {"frame": "_tables_float", "labels": [["0.333333"], ["0.500000"]]})
        assert floats["rows"] == 2
        assert rows_of(demo, "_tables_float", floats["mask"]).tolist() == [True, False, True]
        dates = demo.kernel("table_rows", {"frame": "_tables_dates", "labels": [["2024-01-02"]]})
        assert dates["rows"] == 1
        assert dates["mask"] == "_tables_dates.index == pd.Timestamp('2024-01-02 00:00:00')"
        flags = demo.kernel("table_rows", {"frame": "_tables_flags", "keys": ["flag"], "labels": [["True"]]})
        assert (flags["rows"], flags["mask"]) == (2, "_tables_flags['flag'] == True")
        # The outer label of a group picks every row under it; an inner label, one row.
        outer = demo.kernel("table_rows", {"frame": "_tables_two", "labels": [["B"]]})
        assert rows_of(demo, "_tables_two", outer["mask"]).tolist() == [False, False, True, True]
        inner = demo.kernel("table_rows", {"frame": "_tables_two", "labels": [["A", "2"], ["B", "1"]]})
        assert rows_of(demo, "_tables_two", inner["mask"]).tolist() == [False, True, True, False]
        assert inner["where"] == "2 labels of arm and week"
    finally:
        for name in ("_tables_float", "_tables_dates", "_tables_flags", "_tables_two"):
            ns.pop(name, None)


def test_what_sets_the_rows_apart(demo):
    ns = demo.shell.user_ns
    ns["_tables_apart"] = pd.DataFrame(
        {
            "pain": [9.0, 8.5, 2.0, 2.5, 3.0, 2.0],
            "age": [40, 41, 40, 42, 41, 40],
            "arm": ["B", "B", "A", "A", "A", "B"],
        }
    )
    try:
        result = demo.kernel("table_rows", {"frame": "_tables_apart", "labels": [["0"], ["1"]]})
        assert [entry["column"] for entry in result["differences"]] == ["pain", "arm"]
        assert result["seen"] == "Compared with the other 4 rows: mean pain 8.75 against 2.38; arm B in 100% against 25%."
        everything = demo.kernel("table_rows", {"frame": "_tables_apart", "labels": [[str(i)] for i in range(6)]})
        assert everything["seen"] == "These are all the rows of _tables_apart."
        nothing = demo.kernel("table_rows", {"frame": "_tables_apart", "labels": [["99"]]})
        assert (nothing["rows"], nothing["seen"]) == (0, "No row of _tables_apart has index = 99.")
    finally:
        ns.pop("_tables_apart", None)


def test_a_frame_not_in_the_kernel(demo):
    result = demo.kernel("table_rows", {"frame": "not_there", "labels": [["0"]]})
    assert result == {"error": "no variable named not_there", "missing": True}


# polars writes no row labels: a row is its place in the frame, or a group is
# found by the values of its keys, as the table writes them.

polars = pytest.importorskip("polars")


def polars_rows(demo, name, mask_code):
    """The rows that the polars mask picks."""
    return demo.shell.user_ns[name].select(eval(mask_code, {"pl": polars}).alias("m")).to_series().to_list()


def test_polars_rows_by_their_places(demo):
    ns = demo.shell.user_ns
    ns["_tables_pl"] = polars.DataFrame(
        {"arm": ["A", "B", "B", "A", "A"], "age": [34, 51, 45, 62, 29], "pain": [3.1, 7.2, 6.9, 3.3, 2.8]}
    )
    try:
        result = demo.kernel("table_rows", {"frame": "_tables_pl", "keys": [], "labels": [["1"], ["2"]], "positions": True})
        assert (result["rows"], result["total_rows"], result["positions"], result["library"]) == (2, 5, True, "polars")
        assert result["where"] == "rows 1 and 2"
        assert result["mask"] == "pl.int_range(pl.len()).is_in([1, 2])"
        assert polars_rows(demo, "_tables_pl", result["mask"]) == [False, True, True, False, False]
        # The same sentence as the pandas frame with these values.
        assert result["seen"] == "Compared with the other 3 rows: mean pain 7.05 against 3.07; arm B in 100% against 0%."
        beyond = demo.kernel("table_rows", {"frame": "_tables_pl", "keys": [], "labels": [["9"]], "positions": True})
        assert (beyond["rows"], beyond["seen"]) == (0, "_tables_pl has no row 9.")
    finally:
        ns.pop("_tables_pl", None)


def test_polars_groups_by_the_values_of_their_keys(demo):
    from datetime import date, datetime

    ns = demo.shell.user_ns
    ns["_tables_pl"] = polars.DataFrame(
        {
            "patient_id": ["p1", "p1", "p2", "p2", "p3", "p3"],
            "arm": ["A", "A", "B", "B", None, None],
            "week": [1, 2, 1, 2, 1, 2],
            "flag": [True, False, True, None, False, True],
            "x": [1 / 3, 0.5, 12.0000001, 12.04, 0.25, float("nan")],
            "day": [date(2024, 1, d) for d in (1, 2, 1, 2, 1, 2)],
            "when": [datetime(2024, 1, d, 10, 30) for d in (1, 2, 1, 2, 1, 2)],
            "note": ["a" * 35 + "1", "a" * 35 + "1", "a" * 35 + "2", "b" * 40, "short", "short"],
        }
    ).with_columns(
        polars.col("when").dt.replace_time_zone("Europe/Warsaw").alias("zoned"),
        polars.col("arm").cast(polars.Categorical).alias("level"),
    )

    def rows(keys, labels, **extra):
        result = demo.kernel("table_rows", {"frame": "_tables_pl", "keys": keys, "labels": labels, **extra})
        assert "error" not in result, result
        assert result["positions"] is False
        # The mask is polars code that picks the same rows.
        assert polars_rows(demo, "_tables_pl", result["mask"]).count(True) == result["rows"]
        return result

    try:
        # Strings come in double quotes, as polars writes them.
        one = rows(["arm"], [['"A"']], unit="patient_id")
        assert (one["rows"], one["mask"], one["where"], one["units"]) == (2, "pl.col('arm') == 'A'", "arm = A", 1)
        assert rows(["arm"], [['"A"'], ['"B"']])["mask"] == "pl.col('arm').is_in(['A', 'B'])"
        assert rows(["arm"], [["null"]])["mask"] == "pl.col('arm').is_null()"
        two = rows(["arm", "week"], [['"A"', "2"], ['"B"', "1"]])
        assert two["mask"] == "((pl.col('arm') == 'A') & (pl.col('week') == 2)) | ((pl.col('arm') == 'B') & (pl.col('week') == 1))"
        assert two["where"] == "2 labels of arm and week"
        assert rows(["flag"], [["true"]])["mask"] == "pl.col('flag') == True"
        assert rows(["x"], [["0.333333"]])["mask"] == "pl.col('x') == 0.3333333333333333"
        assert rows(["x"], [["NaN"]])["mask"] == "pl.col('x').is_nan()"
        assert rows(["day"], [["2024-01-02"]])["mask"] == "pl.col('day') == pl.date(2024, 1, 2)"
        assert rows(["when"], [["2024-01-02 10:30:00"]])["mask"] == "pl.col('when') == pl.datetime(2024, 1, 2, 10, 30)"
        zoned = rows(["zoned"], [["2024-01-02 10:30:00 CET"]])
        assert zoned["mask"] == "pl.col('zoned') == pl.datetime(2024, 1, 2, 10, 30, time_zone='Europe/Warsaw')"
        assert rows(["level"], [['"B"']])["rows"] == 2
        # A string polars cuts after 30 characters, when one value starts so.
        cut = rows(["note"], [['"' + "b" * 30 + "…"]])
        assert (cut["rows"], cut["where"]) == (1, "note = " + "b" * 30 + "…")
    finally:
        ns.pop("_tables_pl", None)


def test_polars_labels_that_fit_two_values_find_no_rows(demo):
    ns = demo.shell.user_ns
    ns["_tables_pl"] = polars.DataFrame({"x": [12.0000001, 12.04, 1.0], "note": ["a" * 35 + "1", "a" * 35 + "2", "b"]})
    try:
        # polars writes 12.0000001 as 12.0, and cuts both notes to the same 30 characters.
        rounded = demo.kernel("table_rows", {"frame": "_tables_pl", "keys": ["x"], "labels": [["12.0"]]})
        assert rounded == {"error": "more than one value of x in _tables_pl reads as 12.0: the table shows it cut or rounded"}
        cut = demo.kernel("table_rows", {"frame": "_tables_pl", "keys": ["note"], "labels": [['"' + "a" * 30 + "…"]]})
        assert cut["error"].startswith("more than one value of note in _tables_pl reads as aaaa")
    finally:
        ns.pop("_tables_pl", None)


def test_polars_lazy_frame_is_not_read(demo):
    ns = demo.shell.user_ns
    ns["_tables_lazy"] = polars.DataFrame({"x": [1, 2]}).lazy()
    try:
        result = demo.kernel("table_rows", {"frame": "_tables_lazy", "keys": [], "labels": [["0"]], "positions": True})
        assert result == {"error": "_tables_lazy is not a data frame"}
    finally:
        ns.pop("_tables_lazy", None)


def test_polars_row_code_runs(demo):
    """The code of the questions about polars rows, as the view writes it, runs on the frame."""
    ns = demo.shell.user_ns
    ns["_tables_pl"] = polars.DataFrame(
        {
            "patient_id": ["p1", "p1", "p2", "p2", "p3", "p3"],
            "arm": ["A", "A", "B", "B", "A", "B"],
            "pain": [3.0, 3.5, 7.0, None, 2.5, 6.5],
            "age": [40, 40, 51, 51, 29, 29],
        }
    )
    try:
        result = demo.kernel("table_rows", {"frame": "_tables_pl", "keys": ["arm"], "labels": [['"B"']]})
        mask = result["mask"]
        # tableask.ts writes these, around the mask: what sets the rows apart,
        # the share missing, a t-test on rows and on the means of each unit,
        # and the rows kept as a variable.
        cells = [
            "\n".join(
                [
                    "import polars as pl",
                    "import polars.selectors as cs",
                    f"_rows = {mask}",
                    '_columns = _tables_pl.select(cs.numeric() - cs.by_name("arm", require_all=False)).columns',
                    "_apart = (",
                    "    pl.concat(",
                    "        [",
                    "            _tables_pl.filter(_rows).select(_columns).mean(),",
                    "            _tables_pl.filter(~_rows).select(_columns).mean(),",
                    "            _tables_pl.select(_columns).std(),",
                    "        ],",
                    '        how="vertical_relaxed",',
                    "    )",
                    '    .transpose(include_header=True, header_name="column", column_names=["these rows", "other rows", "sd"])',
                    '    .with_columns(((pl.col("these rows") - pl.col("other rows")) / pl.col("sd")).fill_nan(None).alias("difference in SD"))',
                    '    .drop("sd")',
                    '    .sort(pl.col("difference in SD").abs(), descending=True, nulls_last=True)',
                    "    .with_columns(cs.numeric().round(3))",
                    ")",
                ]
            ),
            "\n".join(
                [
                    f"_rows = {mask}",
                    "_missing = (",
                    "    pl.concat(",
                    "        [",
                    "            _tables_pl.filter(_rows).select(pl.all().is_null().mean()),",
                    "            _tables_pl.filter(~_rows).select(pl.all().is_null().mean()),",
                    "        ]",
                    "    )",
                    '    .transpose(include_header=True, header_name="column", column_names=["these rows", "other rows"])',
                    "    .with_columns(cs.numeric().round(3))",
                    '    .filter(pl.max_horizontal("these rows", "other rows") > 0)',
                    '    .sort("these rows", descending=True)',
                    ")",
                ]
            ),
            "\n".join(
                [
                    "from scipy import stats",
                    f"_rows = {mask}",
                    '_means = _tables_pl.group_by("patient_id", _rows.alias("_picked")).agg(pl.col("pain").mean())',
                    '_a = _means.filter(pl.col("_picked"))["pain"].drop_nulls()',
                    '_b = _means.filter(~pl.col("_picked"))["pain"].drop_nulls()',
                    "_test = stats.ttest_ind(_a.to_numpy(), _b.to_numpy(), equal_var=False)",
                    '_result = pl.DataFrame({"group": ["these rows", "other rows"], "patients": [_a.len(), _b.len()], "mean pain": [_a.mean(), _b.mean()]}).with_columns(pl.col("mean pain").round(3))',
                ]
            ),
            f"_kept = _tables_pl.filter({mask})",
        ]
        for code in cells:
            demo.run(code)
        apart = ns["_apart"]
        assert apart.columns == ["column", "these rows", "other rows", "difference in SD"]
        assert apart["column"].to_list() == ["pain", "age"]
        assert ns["_missing"].rows() == [("pain", 0.333, 0.0)]
        assert ns["_kept"].height == 3
    finally:
        for name in ("_tables_pl", "_rows", "_columns", "_apart", "_missing", "_means", "_a", "_b", "_test", "_result", "_kept"):
            ns.pop(name, None)


def test_polars_rows_by_place_must_still_hold_what_the_table_shows(demo):
    ns = demo.shell.user_ns
    ns["_tables_pl"] = polars.DataFrame({"arm": ["A", "B", "B"], "pain": [3.1, 7.2, 6.9], "when": ["x", "y", "z"]})
    try:
        shown = {"arm": '"B"', "pain": "7.2", "when": '"y"'}
        same = demo.kernel("table_rows", {"frame": "_tables_pl", "keys": [], "labels": [["1"]], "positions": True, "cells": [shown]})
        assert same["rows"] == 1
        # A later cell sorted the frame: row 1 is another row now.
        ns["_tables_pl"] = ns["_tables_pl"].sort("pain")
        moved = demo.kernel("table_rows", {"frame": "_tables_pl", "keys": [], "labels": [["1"]], "positions": True, "cells": [shown]})
        assert moved == {
            "error": "_tables_pl changed after the table was shown: its row 1 does not hold what the table shows. Run the cell again to ask about these rows."
        }
    finally:
        ns.pop("_tables_pl", None)
