""""Who is in these rows?" counts the categories that a frame stores as whole numbers (design iteration 1.99).

While the demo video of 7 October 2026 was recorded, a range picked on the
histogram of NHEFS's wt82_71, the 65 people who gained 15.6 to 48.5 kg,
answered with "65 of 1,629 rows." and an empty table: ``whybook.who_is_in``
left out every column of numbers, and NHEFS stores qsmk, sex and race as 0
or 1 and education as 1 to 5. Among those 65, 63% had quit, against 26% of
all, which is the answer that the question is for.
"""

import numpy as np
import pandas as pd
import pytest

from whybook import explore


def nhefs_like(rows: int = 600) -> pd.DataFrame:
    """A frame coded as NHEFS codes it: categories as whole numbers, an age in years, weights in kg; quitters gain 4 kg more."""
    rng = np.random.default_rng(7)
    qsmk = (rng.random(rows) < 0.26).astype("int64")
    return pd.DataFrame(
        {
            "seqn": np.arange(233, 233 + rows),
            "qsmk": qsmk,
            "sex": (rng.random(rows) < 0.5).astype("int64"),
            "race": (rng.random(rows) < 0.13).astype("int64"),
            "education": rng.integers(1, 6, rows),
            "age": rng.integers(25, 75, rows),
            "wt71": rng.normal(70, 15, rows).round(2),
            "wt82_71": (rng.normal(2, 7, rows) + 4 * qsmk).round(2),
        }
    )


def shares(frame: pd.DataFrame, inside: pd.Series, column: str) -> dict[str, tuple[float, float]]:
    here = frame.loc[inside, column].value_counts(normalize=True)
    whole = frame[column].value_counts(normalize=True)
    return {str(level): (float(here.get(level, 0.0)), float(whole[level])) for level in whole.index}


def test_a_range_of_nhefs_lists_the_categories_stored_as_whole_numbers_the_one_that_differs_most_first(capsys):
    frame = nhefs_like()
    picked = frame["wt82_71"].between(10, 50)
    table = explore.who_is_in(frame, picked)
    assert capsys.readouterr().out == f"{int(picked.sum())} of 600 rows.\n"
    columns = list(dict.fromkeys(column for column, _ in table.index))
    # Categories as whole numbers get rows; an id, an age of 50 values and the weights do not.
    assert sorted(columns) == ["education", "qsmk", "race", "sex"]
    gaps = {column: max(abs(here - whole) for here, whole in shares(frame, picked, column).values()) for column in columns}
    assert columns == sorted(columns, key=lambda column: -gaps[column])
    assert columns[0] == "qsmk"
    expected = shares(frame, picked, "qsmk")
    assert table.loc[("qsmk", "1")].to_dict() == {"here": explore._share(expected["1"][0]), "all": explore._share(expected["1"][1]), "of": "rows"}
    assert [level for column, level in table.index if column == "education"] == ["1", "2", "3", "4", "5"]


def test_the_column_that_a_mask_names_picks_the_rows_and_gets_none():
    frame = pd.DataFrame({"week": np.repeat(np.arange(1, 7), 4), "arm": np.tile(["A", "B", "B", "B"], 6)})
    table = explore.who_is_in(frame, frame["week"].between(4, 6))
    assert [column for column, _ in table.index] == ["arm", "arm"]
    # A mask that names no column, as a list, leaves every column in.
    table = explore.who_is_in(frame, list(frame["week"].between(4, 6)))
    assert [column for column, _ in table.index] == ["week"] * 6 + ["arm", "arm"]


def test_the_columns_that_differ_most_show_and_the_line_says_how_many_were_left_out(capsys):
    rng = np.random.default_rng(3)
    frame = pd.DataFrame({f"item{i:02d}": rng.integers(0, 2, 300) for i in range(12)})
    frame["score"] = rng.normal(0, 1, 300) + frame["item03"] * 2
    table = explore.who_is_in(frame, frame["score"] > 1)
    assert capsys.readouterr().out == f"{int((frame['score'] > 1).sum())} of 300 rows. The 10 columns, of 12, whose shares here differ most from all rows.\n"
    assert len(table) == 20
    assert table.index[0][0] == "item03"
    assert len(explore.who_is_in(frame, frame["score"] > 1, columns=None)) == 24


def test_whole_numbers_read_as_decimals_for_a_missing_value_show_as_whole_numbers_and_a_measure_stays_out():
    frame = pd.DataFrame(
        {
            "hightax82": [0.0, 1.0, np.nan, 0.0, 1.0, 0.0, 0.0, 1.0],
            "price": [1.5, 2.25, 1.5, 2.25, 1.75, 1.5, 2.25, 1.75],
            "visits": [0, 1, 2, 3, 4, 5, 6, 7],
            "group": list("aabbaabb"),
        }
    )
    table = explore.who_is_in(frame, pd.Series([True, True, False, False, True, False, False, False]))
    assert [level for column, level in table.index if column == "hightax82"] == ["0", "1"]
    columns = {column for column, _ in table.index}
    # Decimals are a measure; whole numbers with more than ``most`` values are too.
    assert "price" not in columns and "visits" in columns
    assert "visits" not in {column for column, _ in explore.who_is_in(frame, frame["group"] == "a", most=7).index}


# The pain diary demo's existing case of design iteration 1.85, pain step 28:
# weeks 20 to 28 picked on the trajectory of pain, whose frame has no
# category stored as whole numbers. The table is the same as before.


@pytest.mark.demo
def test_the_demo_s_range_of_late_weeks_lists_what_it_did_before(demo, capsys):
    weekly = demo.shell.user_ns["weekly"]
    table = explore.who_is_in(weekly, weekly["week"].between(20, 28), unit="patient_id")
    assert capsys.readouterr().out == "837 of 5,837 rows, 164 of 291 patients.\n"
    assert table.reset_index().values.tolist() == [
        ["treatment_arm", "A", "46%", "51%", "patients"],
        ["treatment_arm", "B", "54%", "49%", "patients"],
    ]


@pytest.mark.demo
def test_the_demo_s_patients_keep_their_levels_and_a_count_of_births_gets_rows(demo):
    patients = demo.shell.user_ns["patients"]
    table = explore.who_is_in(patients, patients["age"] > 50, unit="patient_id")
    rows = {(column, level): (here, whole) for (column, level), (here, whole, _) in zip(table.index, table.values.tolist())}
    # The levels of before, with their numbers.
    assert {key: value for key, value in rows.items() if key[0] != "parity"} == {
        ("treatment_arm", "A"): ("57%", "50%"),
        ("treatment_arm", "B"): ("43%", "50%"),
        ("site", "east"): ("29%", "24%"),
        ("site", "north"): ("29%", "32%"),
        ("site", "south"): ("29%", "27%"),
        ("site", "west"): ("14%", "16%"),
        ("stage", "I"): ("29%", "33%"),
        ("stage", "II"): ("29%", "29%"),
        ("stage", "III"): ("29%", "24%"),
        ("stage", "IV"): ("14%", "14%"),
    }
    # The number of births, 0 to 4, is a count stored as whole numbers: it gets rows, and its shares differ most.
    assert [level for column, level in table.index if column == "parity"] == ["0", "1", "2", "3", "4"]
    assert table.index[0] == ("parity", "0")
