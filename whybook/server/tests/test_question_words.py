"""The words of the server's questions (critique 5, the app, A11, A15 and A16).

- A question about a value that Whybook wrote names who chose the value only
  where the notebook records it, as Cell details does (A11).
- A question that answers in a preview ends with "no cell unless you keep
  it", the verb of the preview's button Keep as a cell, and a plot's output
  shows under the new cell (A15).
- A question that counts the rows of a frame reads "rows of model_data" where
  the frame's name is not a plural noun, and "visits" where it is (A16).
"""

import contextlib
import io
import sqlite3

import pandas as pd
import pytest

from whybook import plots
from whybook.server.questions import starts
from whybook.server.questions.cells import CellInfo, single_cell_questions
from whybook.server.questions.drops import DropRequest, drop_options
from whybook.server.questions.files import FileDrop, file_options
from whybook.server.questions.models import Context
from whybook.server.questions.tables import TableDrop, table_options

VISITS = pd.DataFrame(
    {
        "patient_id": [f"P{index % 12:03d}" for index in range(42)],
        "site": ["A"] * 20 + ["B"] * 10 + ["C"] * 10 + ["D"] * 2,
        "week": [index % 8 for index in range(42)],
        "crp_mg_l": [1.5 + index / 10 for index in range(42)],
    }
)


@pytest.fixture(autouse=True)
def no_plots(monkeypatch):
    monkeypatch.setattr(plots, "show", lambda bundle, **kwargs: None)


# A11: who chose a value of code that Whybook wrote.


def agents(cell):
    """The cell as the view sends it when the cell records written_by "agent": its literals go as "agent" (attributed in src/model/decisions.ts)."""
    return {**cell, "decisions": [{**decision, "provenance": "agent"} if decision["provenance"] == "literal" else decision for decision in cell["decisions"]]}


@pytest.mark.demo
def test_the_values_of_the_demos_model_cell_name_no_writer_since_the_notebook_records_none(demo):
    """[5] records only written_by "agent": Cell details reads that the notebook does not record which wrote it."""
    cell = CellInfo.from_json(agents(demo.cell("lmm", "[5]")))
    asked = {question.text: question.effect for question in single_cell_questions(cell, Context.from_json(demo.context())) if "the right choice" in question.text}
    assert asked == {
        "Is how = 'left' the right choice in [5]?": "Nobody checked it",
        "Is re_formula = '~month' the right choice in [5]?": "Nobody checked it",
        "Is missing = 'drop' the right choice in [5]?": "Nobody checked it",
    }


def test_a_value_of_a_models_code_names_the_model_as_cell_details_does():
    """The view sends the model that the cell records, in the words of Cell details (codeModel in src/model/writtenby.ts)."""
    source = 'share = pd.crosstab(frame["tariff"], frame["home_id"], normalize="index")'
    decision = {"name": "normalize", "value": "'index'", "provenance": "agent", "param": "normalize", "function": "crosstab"}
    cell = {"id": "c3", "label": "[3]", "source": source, "decisions": [decision]}
    by_model = CellInfo.from_json({**cell, "writer": "the remote AI model, fake/model"})
    assert [question.effect for question in single_cell_questions(by_model, Context())] == ["Chosen by the remote AI model, fake/model; nobody checked it"]
    assert [question.effect for question in single_cell_questions(CellInfo.from_json(cell), Context())] == ["Nobody checked it"]
    # A writer that is not text is left out.
    assert CellInfo.from_json({**cell, "writer": {"model": "fake/model"}}).writer is None


# A15: one verb for keeping the answer of a preview.


def start_options(folder, kind):
    """The questions of visits, a file or a table, dropped on a notebook with one empty cell."""
    VISITS.to_csv(folder / "visits.csv", index=False)
    with sqlite3.connect(folder / "clinic.sqlite") as database:
        VISITS.to_sql("visits", database, index=False)
    context = {"frames": {}, "used": [], "asked": []}
    cells = [{"id": "c1", "label": "[1]", "source": "", "defs": [], "uses": []}]
    if kind == "file":
        source = {"kind": "file", "path": "visits.csv", "kernel_path": str(folder / "visits.csv"), "label": "visits.csv"}
        return file_options(FileDrop.from_json({"source": source, "target": {}, "cells": cells, "context": context}), str(folder))["options"]
    source = {"kind": "table", "path": "clinic.sqlite", "kernel_path": str(folder / "clinic.sqlite"), "table": "visits"}
    return table_options(TableDrop.from_json({"source": source, "target": {}, "cells": cells, "context": context}), str(folder))["options"]


@pytest.mark.parametrize("kind", ["file", "table"])
def test_the_questions_of_data_dropped_on_an_empty_notebook_keep_their_answer_as_the_preview_does(tmp_path, kind):
    """Five questions ended with "kept only if you pin it", and the preview that each opens has the button Keep as a cell."""
    options = start_options(tmp_path, kind)
    previews = [option for option in options if option["placement"]["kind"] == "preview"]
    assert [option["effect"].rsplit(" · ", 1)[1] for option in previews] == ["no cell unless you keep it"] * 5
    assert not [option["effect"] for option in options if "pin" in option["effect"]]


def test_a_frame_dropped_on_itself_keeps_its_profile_as_a_column_dropped_on_itself_does():
    context = {"frames": {"visits": {"rows": 42, "columns": {"patient_id": "id", "site": "cat", "week": "int", "crp_mg_l": "num"}}}, "used": [], "asked": []}
    frame = {"name": "visits", "label": "visits", "kind": "dataframe", "rows": 42, "n_columns": 4}
    column = {"name": "visits['crp_mg_l']", "label": "crp_mg_l", "kind": "numeric", "parent": "visits", "rows": 42}
    effects = {}
    for item in (frame, column):
        for option in drop_options(DropRequest.from_json({"source": item, "target": {"item": item}, "cells": [], "context": context}))["options"]:
            effects[option["text"]] = option["effect"]
    assert effects["Profile visits: types, missingness, duplicates"] == "Quick look · no cell unless you keep it"
    assert effects["Summarise crp_mg_l: distribution and missingness"] == "Quick look · no cell unless you keep it"


@pytest.mark.demo
def test_a_plot_shows_its_output_under_the_new_cell(demo):
    """age onto the mixed model [5]: "pinned" meant shown."""
    request = {"source": demo.column("model_data", "age"), "target": {"cell": demo.cell("lmm", "[5]")}, "cells": demo.cells_json(), "context": demo.context()}
    plot = next(option for option in drop_options(DropRequest.from_json(request))["options"] if option["text"] == "Plot age against pain_score")
    assert plot["effect"] == "Output shown under the new cell"


# A16: the rows of a frame whose name is not a plural noun.


@pytest.mark.parametrize(
    ("name", "counted"),
    [
        ("model_data", "rows of model_data"),
        ("diary", "rows of diary"),
        ("visits", "visits"),
        ("measurements", "measurements"),
        ("status", "rows of status"),
        ("analysis", "rows of analysis"),
        # The last word decides, in snake case and in camel case.
        ("lab_visits", "lab_visits"),
        ("patientVisits", "patientVisits"),
        ("visits_clean", "rows of visits_clean"),
        # Words that end in s and name no rows to count.
        ("glass", "rows of glass"),
        ("demographics", "rows of demographics"),
        ("diabetes", "rows of diabetes"),
        ("time_series", "rows of time_series"),
        ("df", "rows of df"),
    ],
)
def test_a_frame_is_counted_by_its_name_only_where_its_last_word_is_a_plural(name, counted):
    assert starts.rows_of(name) == counted


@pytest.mark.demo
def test_patients_with_the_mixed_model_count_the_rows_of_model_data(demo, capsys):
    """Click mode: patients, Pick, then "Ask about patients with [5]". "How many model_data per patient?" made the analyst read model_data as its rows."""
    request = {"source": demo.variable("patients"), "target": {"cell": demo.cell("lmm", "[5]")}, "cells": demo.cells_json(), "context": demo.context()}
    options = drop_options(DropRequest.from_json(request))["options"]
    effects = {option["text"]: option["effect"] for option in options}
    assert effects["How many rows of model_data per patient?"] == "The rows of model_data for each patient, and the patients with the fewest"
    assert effects["Is any patient an outlier for the number of rows of model_data?"] == "The rows of model_data for each patient, and those beyond 1.5 times the interquartile range"
    assert "Which patients have no rows of model_data?" in effects
    # The answers say the same.
    for text in ("Is any patient an outlier for the number of rows of model_data?", "Which patients have no rows of model_data?"):
        demo.run(next(option["code"] for option in options if option["text"] == text))
    printed = capsys.readouterr().out
    assert " patients are outliers for the number of rows of model_data. Outside " in printed
    assert " patients have no rows of model_data." in printed


def test_a_frame_named_for_its_rows_keeps_the_short_form():
    """visits with the cell that loads sites, both in the kernel: "How many visits per site?"."""
    sites = pd.DataFrame({"site": list("ABCDE"), "region": ["north", "south", "east", "west", "far"]})
    context = {
        "frames": {
            "sites": {"rows": 5, "columns": {"site": "cat", "region": "cat"}},
            "visits": {"rows": 42, "columns": {"patient_id": "id", "site": "cat", "week": "int", "crp_mg_l": "num"}},
        },
        "used": [],
        "asked": [],
    }
    cell = {"id": "c1", "label": "[1]", "source": "sites = pd.read_csv('sites.csv')", "defs": ["sites"], "uses": ["pd"]}
    visits = {"name": "visits", "label": "visits", "kind": "dataframe", "rows": 42, "n_columns": 4}
    options = drop_options(DropRequest.from_json({"source": visits, "target": {"cell": cell}, "cells": [cell], "context": context}))["options"]
    texts = [option["text"] for option in options]
    assert texts[:4] == ["How many visits per site?", "Is any site an outlier for the number of visits?", "Add the columns of sites to visits", "Which sites have no visits?"]
    outliers = next(option for option in options if option["text"] == "Is any site an outlier for the number of visits?")
    assert outliers["effect"] == "The visits for each site, and those beyond 1.5 times the interquartile range"
    printed = io.StringIO()
    with contextlib.redirect_stdout(printed):
        exec(outliers["code"], {"sites": sites, "visits": VISITS.copy()})  # noqa: S102  the view runs the same code in the kernel
    assert printed.getvalue().startswith("0 of 5 sites are outliers for the number of visits. Outside ")
