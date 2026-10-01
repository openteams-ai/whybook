"""Questions to start with, and frames that meet (design iteration 1.87).

The owner, on 1 October 2026: the first file dropped on an empty notebook got
"What could sites add to this analysis?", which needs a model, and a table
dropped on the cell that loads another frame got "What could visits add to
this analysis?" where "How many visits per site?" would do. Each test builds
the drop as the view sends it, and runs the code that the questions offer.
"""

import contextlib
import io
import sqlite3

import pandas as pd
import pytest

from whybook import plots
from whybook.server.questions.drops import DropRequest, drop_options
from whybook.server.questions.files import FileDrop, file_options
from whybook.server.questions.tables import TableDrop, table_options

# Five sites; the visits come from four of them, and site E has none.
SITES = pd.DataFrame({"site": list("ABCDE"), "region": ["north", "south", "east", "west", "far"], "clinicians": [12, 8, 20, 15, 3]})
VISITS = pd.DataFrame(
    {
        "patient_id": [f"P{index % 12:03d}" for index in range(42)],
        "site": ["A"] * 20 + ["B"] * 10 + ["C"] * 10 + ["D"] * 2,
        "week": [index % 8 for index in range(42)],
        "crp_mg_l": [1.5 + index / 10 for index in range(42)],
    }
)
SITES_CELL = {"id": "c1", "label": "[1]", "source": "sites = pd.read_csv('sites.csv')", "defs": ["sites"], "uses": ["pd"]}
SITES_CONTEXT = {"frames": {"sites": {"rows": 5, "columns": {"site": "cat", "region": "cat", "clinicians": "int"}}}, "used": [], "asked": []}
EMPTY_CONTEXT = {"frames": {}, "used": [], "asked": []}
GENERIC = "What could visits{} add to this analysis?"


def code_cell(index, source="x = 1"):
    return {"id": f"c{index}", "label": f"[{index}]", "source": source, "defs": [], "uses": []}


@pytest.fixture
def folder(tmp_path):
    """A folder with the two files and a database with the two tables."""
    SITES.to_csv(tmp_path / "sites.csv", index=False)
    VISITS.to_csv(tmp_path / "visits.csv", index=False)
    with sqlite3.connect(tmp_path / "clinic.sqlite") as database:
        SITES.to_sql("sites", database, index=False)
        VISITS.to_sql("visits", database, index=False)
    return tmp_path


def file_options_of(folder, name, cells, context, target=None):
    source = {"kind": "file", "path": name, "kernel_path": str(folder / name), "label": name}
    body = {"source": source, "target": {"cell": target} if target else {}, "cells": cells, "context": context}
    return file_options(FileDrop.from_json(body), str(folder))["options"]


def table_options_of(folder, table, cells, context, target=None):
    source = {"kind": "table", "path": "clinic.sqlite", "kernel_path": str(folder / "clinic.sqlite"), "table": table}
    body = {"source": source, "target": {"cell": target} if target else {}, "cells": cells, "context": context}
    return table_options(TableDrop.from_json(body), str(folder))["options"]


def texts(options):
    return [option["text"] for option in options]


def option_of(options, start):
    return next(option for option in options if option["text"].startswith(start))


@pytest.fixture(autouse=True)
def no_plots(monkeypatch):
    monkeypatch.setattr(plots, "show", lambda bundle, **kwargs: None)


def run(code, **frames):
    """Run the code of a question as a cell runs it: what it printed, and the name that its last line shows."""
    namespace = dict(frames)
    printed = io.StringIO()
    with contextlib.redirect_stdout(printed):
        exec(code, namespace)  # noqa: S102  the view runs the same code in the kernel
    last = code.strip().splitlines()[-1]
    return printed.getvalue(), namespace, namespace.get(last)


def public(namespace, *given):
    """The names that a run left that the analyst can see: no underscore, no module, no frame it was given."""
    return sorted(name for name in namespace if not name.startswith("_") and name not in given and name not in ("whybook", "pd", "sqlite3", "closing"))


# Part 1: fewer than three code cells.

START = [
    "What does one row of {label} hold?",
    "How many rows has {label}, and how many values are missing?",
    "How many rows has each level of site and week?",
    "What is the range of each number in {label}?",
]


@pytest.mark.parametrize("kind", ["file", "table"])
def test_the_first_drop_on_an_empty_notebook_gets_questions_to_start_with_and_none_that_needs_a_model(folder, kind):
    # One empty cell, as a new notebook has: it holds no code.
    cells = [code_cell(1, "")]
    if kind == "file":
        options, label = file_options_of(folder, "visits.csv", cells, EMPTY_CONTEXT), "visits.csv"
    else:
        options, label = table_options_of(folder, "visits", cells, EMPTY_CONTEXT), "visits"
    found = texts(options)
    assert not [text for text in found if text.startswith("What could")], found
    for text in START:
        assert text.format(label=label) in found
    for text in START:
        option = next(option for option in options if option["text"] == text.format(label=label))
        # Each runs without a model, and shows its answer in a preview that nothing keeps.
        assert option["code"] and option["placement"]["kind"] == "preview"
        assert "needs AI" not in option["reasons"]


@pytest.mark.parametrize("kind", ["file", "table"])
def test_the_questions_to_start_with_run_and_leave_no_name_behind(folder, kind):
    label = "visits.csv" if kind == "file" else "visits"
    options = file_options_of(folder, "visits.csv", [], EMPTY_CONTEXT) if kind == "file" else table_options_of(folder, "visits", [], EMPTY_CONTEXT)
    # What one row holds: the unit comes from the id rules, patient_id, and its rows are counted.
    printed, namespace, _ = run(option_of(options, "What does one row of")["code"])
    assert "12 patients in 42 rows." in printed
    assert public(namespace) == []
    # Rows and missing values: none are missing.
    printed, namespace, answer = run(option_of(options, "How many rows has visits")["code"])
    assert "42 rows and 4 columns; 0 values missing." in printed
    assert list(answer["values missing"]) == [0, 0, 0, 0]
    assert public(namespace) == []
    # The levels of the columns with few levels: site and week, not the 12 patients' ids or the readings.
    printed, namespace, _ = run(option_of(options, "How many rows has each level")["code"])
    assert printed.splitlines()[0].startswith("site: A 20, ") and printed.splitlines()[0].endswith(", D 2")
    assert printed.splitlines()[1].startswith("week: ")
    assert public(namespace) == []
    # The range of each number: the readings are the one number, as the ids and the levels are not.
    options_range = option_of(options, "What is the range of each number")
    printed, namespace, answer = run(options_range["code"])
    assert list(answer.index) == ["crp_mg_l"]
    assert (answer.loc["crp_mg_l", "min"], answer.loc["crp_mg_l", "max"]) == (1.5, pytest.approx(5.6))
    assert public(namespace) == []
    assert label in options_range["text"]


def test_a_column_named_like_an_id_gives_the_unit_and_without_one_the_first_rows_show_what_a_row_holds(folder):
    options = file_options_of(folder, "sites.csv", [], EMPTY_CONTEXT)
    one_row = option_of(options, "What does one row of sites.csv hold?")
    assert "No column is named like an id" in one_row["effect"]
    printed, _, answer = run(one_row["code"])
    assert "5 rows and 3 columns." in printed
    assert list(answer.columns) == [0, 1, 2] and list(answer.index) == ["site", "region", "clinicians"]
    # The notebook's own unit is the unit of the file when the file has it.
    known = file_options_of(folder, "visits.csv", [], {**EMPTY_CONTEXT, "unit": "week"})
    printed, _, _ = run(option_of(known, "What does one row of")["code"])
    assert "8 weeks in 42 rows." in printed


@pytest.mark.parametrize("kind", ["file", "table"])
def test_three_cells_that_hold_code_keep_the_question_that_needs_a_model(folder, kind):
    cells = [code_cell(index) for index in (1, 2, 3)]
    options = file_options_of(folder, "visits.csv", cells, EMPTY_CONTEXT) if kind == "file" else table_options_of(folder, "visits", cells, EMPTY_CONTEXT)
    found = texts(options)
    generic = [text for text in found if text.startswith("What could")]
    assert generic == [GENERIC.format(".csv" if kind == "file" else "")]
    assert option_of(options, "What could")["code"] is None
    assert not [text for text in found if text.startswith("What does one row")]
    # Cells without code do not count: two with code and two empty ones is still a start.
    started = [code_cell(1), code_cell(2), code_cell(3, "  \n"), code_cell(4, "")]
    options = file_options_of(folder, "visits.csv", started, EMPTY_CONTEXT) if kind == "file" else table_options_of(folder, "visits", started, EMPTY_CONTEXT)
    assert not [text for text in texts(options) if text.startswith("What could")]


# Part 2: a frame or a table dropped on the cell that loads another frame.

TOGETHER = ["How many visits per site?", "Is any site an outlier for the number of visits?", "Which sites have no visits?", "Add the columns of sites to visits"]


@pytest.mark.parametrize("kind", ["file", "table"])
def test_visits_dropped_on_the_cell_that_loads_sites_asks_about_the_two_and_not_what_visits_could_add(folder, kind):
    cells = [SITES_CELL]
    if kind == "file":
        options = file_options_of(folder, "visits.csv", cells, SITES_CONTEXT, target=SITES_CELL)
    else:
        options = table_options_of(folder, "visits", cells, SITES_CONTEXT, target=SITES_CELL)
    found = texts(options)
    for text in TOGETHER:
        assert text in found
    assert not [text for text in found if text.startswith("What could")], found
    # They come first, and each runs without a model in a new cell after the one that loads sites.
    assert found[:4] == ["How many visits per site?", "Is any site an outlier for the number of visits?", "Add the columns of sites to visits", "Which sites have no visits?"]
    for text in TOGETHER:
        option = option_of(options, text)
        assert option["code"] and option["placement"]["kind"] == "new" and option["placement"]["cell"] == "c1"
    # The questions to start with are not offered beside them: the analyst has a frame to compare with.
    assert not [text for text in found if text.startswith("What does one row")]


@pytest.mark.parametrize("kind", ["file", "table"])
def test_the_questions_of_two_frames_run_and_answer(folder, kind):
    options = (
        file_options_of(folder, "visits.csv", [SITES_CELL], SITES_CONTEXT, target=SITES_CELL)
        if kind == "file"
        else table_options_of(folder, "visits", [SITES_CELL], SITES_CONTEXT, target=SITES_CELL)
    )
    printed, namespace, _ = run(option_of(options, "How many visits per site")["code"], sites=SITES.copy())
    assert printed.splitlines()[0] == "4 sites in 42 rows."
    # The cell loads visits under its own name, as Load does.
    assert list(namespace["visits"].columns) == list(VISITS.columns)
    # Site E has no visits: 0 for it, and no site is far from the others.
    printed, _, answer = run(option_of(options, "Is any site an outlier")["code"], sites=SITES.copy())
    assert printed.startswith("0 of 5 sites are outliers for the number of visits. Outside -10.0 to 22.0 ")
    assert len(answer) == 0
    # Which sites have none: the row of E.
    printed, _, answer = run(option_of(options, "Which sites have no")["code"], sites=SITES.copy())
    assert printed.strip() == "1 of 5 sites have no visits."
    assert list(answer["site"]) == ["E"]
    # The columns of sites join to every visit, and the share that found a site says so.
    printed, namespace, _ = run(option_of(options, "Add the columns of sites")["code"], sites=SITES.copy())
    assert printed.strip() == "100% of visits rows found a match in sites"
    assert len(namespace["visits_sites"]) == 42
    assert list(namespace["visits_sites"]["region"][:1]) == ["north"]
    # A visit to a site that the frame does not hold finds no match.
    printed, _, _ = run(option_of(options, "Add the columns of sites")["code"], sites=SITES[SITES["site"] != "D"])
    assert printed.strip() == "95% of visits rows found a match in sites"


def test_a_site_with_far_more_visits_than_the_others_is_an_outlier_named_with_its_count(folder):
    visits = pd.DataFrame({"site": ["A"] * 5 + ["B"] * 6 + ["C"] * 5 + ["D"] * 7 + ["E"] * 60, "week": range(83)})
    visits.to_csv(folder / "visits.csv", index=False)
    options = file_options_of(folder, "visits.csv", [SITES_CELL], SITES_CONTEXT, target=SITES_CELL)
    printed, _, answer = run(option_of(options, "Is any site an outlier")["code"], sites=SITES.copy())
    assert printed.startswith("1 of 5 sites are outliers for the number of visits. Outside 2.0 to 10.0 ")
    assert (list(answer.index), list(answer["visits"])) == (["E"], [60])


@pytest.mark.parametrize("kind", ["file", "table"])
def test_the_frame_with_a_row_per_key_may_be_the_one_dropped(folder, kind):
    """sites dropped on the cell that loads visits: visits is the frame with several rows per key."""
    cell = {"id": "c1", "label": "[1]", "source": "visits = pd.read_csv('visits.csv')", "defs": ["visits"], "uses": ["pd"]}
    context = {"frames": {"visits": {"rows": 42, "columns": {"patient_id": "id", "site": "cat", "week": "int", "crp_mg_l": "num"}}}, "used": [], "asked": []}
    options = (
        file_options_of(folder, "sites.csv", [cell], context, target=cell)
        if kind == "file"
        else table_options_of(folder, "sites", [cell], context, target=cell)
    )
    found = texts(options)
    for text in TOGETHER:
        assert text in found
    printed, _, answer = run(option_of(options, "Which sites have no")["code"], visits=VISITS.copy())
    assert printed.strip() == "1 of 5 sites have no visits."
    assert list(answer["site"]) == ["E"]
    printed, namespace, _ = run(option_of(options, "Add the columns of sites")["code"], visits=VISITS.copy())
    assert printed.strip() == "100% of visits rows found a match in sites"
    assert len(namespace["visits_sites"]) == 42


@pytest.mark.parametrize("kind", ["file", "table"])
def test_with_no_shared_key_the_generic_question_stays_and_a_notebook_that_began_gets_questions_to_start_with(folder, kind):
    weather = pd.DataFrame({"date": ["2026-01-01", "2026-01-02"], "temp_c": [3.0, 4.5]})
    weather.to_csv(folder / "weather.csv", index=False)
    with sqlite3.connect(folder / "clinic.sqlite") as database:
        weather.to_sql("weather", database, index=False)
    name = "weather.csv" if kind == "file" else "weather"
    many = [SITES_CELL, code_cell(2), code_cell(3)]
    options = (
        file_options_of(folder, name, many, SITES_CONTEXT, target=SITES_CELL)
        if kind == "file"
        else table_options_of(folder, name, many, SITES_CONTEXT, target=SITES_CELL)
    )
    assert [text for text in texts(options) if text.startswith("What could")] == [f"What could {name} add to this analysis?"]
    assert not [text for text in texts(options) if "per" in text]
    # One cell and no key: what is in the data comes first, with no model.
    options = (
        file_options_of(folder, name, [SITES_CELL], SITES_CONTEXT, target=SITES_CELL)
        if kind == "file"
        else table_options_of(folder, name, [SITES_CELL], SITES_CONTEXT, target=SITES_CELL)
    )
    assert not [text for text in texts(options) if text.startswith("What could")]
    assert f"What does one row of {name} hold?" in texts(options)


def test_two_frames_that_both_repeat_the_key_ask_nothing_together(folder):
    """The rows do not say which frame has a row per key: the generic question stays."""
    context = {"frames": {"sites": {"rows": 40, "columns": {"site": "cat", "region": "cat"}}}, "used": [], "asked": []}
    cell = {**SITES_CELL}
    many = [cell, code_cell(2), code_cell(3)]
    options = file_options_of(folder, "visits.csv", many, context, target=cell)
    assert [text for text in texts(options) if "per site" in text] == []
    assert GENERIC.format(".csv") in texts(options)


def test_a_measured_number_or_a_time_is_no_key(folder):
    """crp_mg_l is a number in both frames: it joins nothing, whatever its rows."""
    context = {"frames": {"readings": {"rows": 5, "columns": {"crp_mg_l": "num", "when": "date"}}}, "used": [], "asked": []}
    cell = {"id": "c1", "label": "[1]", "source": "readings = 1", "defs": ["readings"], "uses": []}
    options = file_options_of(folder, "visits.csv", [cell, code_cell(2), code_cell(3)], context, target=cell)
    assert [text for text in texts(options) if " per " in text] == []


def test_a_frame_in_the_kernel_dropped_on_the_cell_that_loads_another_asks_about_the_two():
    """Both frames are loaded: the rows say which has a row per key, sites with 5 beside 42 visits."""
    visits_item = {"name": "visits", "label": "visits", "kind": "dataframe", "rows": 42, "n_columns": 4}
    context = {
        "frames": {
            "sites": {"rows": 5, "columns": {"site": "cat", "region": "cat", "clinicians": "int"}},
            "visits": {"rows": 42, "columns": {"patient_id": "id", "site": "cat", "week": "int", "crp_mg_l": "num"}},
        },
        "used": [],
        "asked": [],
    }
    request = {"source": visits_item, "target": {"cell": SITES_CELL}, "cells": [SITES_CELL], "context": context}
    options = drop_options(DropRequest.from_json(request))["options"]
    found = texts(options)
    for text in TOGETHER:
        assert text in found
    printed, _, answer = run(option_of(options, "Which sites have no")["code"], sites=SITES.copy(), visits=VISITS.copy())
    assert printed.strip() == "1 of 5 sites have no visits."
    printed, namespace, _ = run(option_of(options, "Add the columns of sites")["code"], sites=SITES.copy(), visits=VISITS.copy())
    assert printed.strip() == "100% of visits rows found a match in sites"
    # The frames are loaded already: no code reads a file or a table.
    assert "read_csv" not in option_of(options, "How many visits per site")["code"]


def test_the_join_of_a_table_that_was_there_before_says_how_many_rows_found_a_match(folder):
    """The join of a table to the frame that a cell uses printed no share."""
    cell = {"id": "c1", "label": "[1]", "source": "x = sites.copy()", "defs": ["x"], "uses": ["sites"]}
    context = {"frames": {"sites": {"rows": 400, "columns": {"site_id": "id", "region": "cat"}}}, "used": [], "asked": []}
    with sqlite3.connect(folder / "clinic.sqlite") as database:
        SITES.rename(columns={"site": "site_id"}).to_sql("site_list", database, index=False)
    options = table_options_of(folder, "site_list", [cell, code_cell(2), code_cell(3)], context, target=cell)
    join = option_of(options, "Join site_list to sites on site_id")
    frame = pd.DataFrame({"site_id": list("ABCD"), "region": ["n", "s", "e", "w"]})
    printed, _, _ = run(join["code"], sites=frame)
    assert printed.strip() == "100% of sites rows found a match in site_list"
    # Rows of the frame that the table lacks find none.
    printed, _, _ = run(join["code"], sites=pd.DataFrame({"site_id": list("ABXY"), "region": ["n", "s", "e", "w"]}))
    assert printed.strip() == "50% of sites rows found a match in site_list"
