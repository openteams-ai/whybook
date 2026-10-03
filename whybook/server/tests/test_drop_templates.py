"""Template answers that must fit the data: the kinds of two columns, and a cell whose frame lacks the outcome.

On the demo, 88 of the 192 first answers that ran from a template once
failed (research/local_predictors/usability.py): a
correlation of two categories, a model of the outcome fitted on the raw
diary before its reshape, and a screen of a frame that holds the outcome.
Each test runs the code it gets, on small frames.
"""

import numpy as np
import pandas as pd

from whybook.server.questions.drops import DropRequest, drop_options

FRAMES = {
    "visits": {"rows": 60, "columns": {"patient_id": "id", "week": "num", "pain": "num", "sleep": "num", "arm": "cat", "site": "cat"}},
    "raw": {"rows": 20, "columns": {"patient_id": "id", "pain_1": "num", "pain_2": "num"}},
    "weekly": {"rows": 30, "columns": {"patient_id": "id", "week": "num", "pain": "num"}},
}
CONTEXT = {"frames": FRAMES, "outcome": "pain", "unit": "patient_id", "used": [], "asked": []}


def data():
    rng = np.random.default_rng(3)
    visits = pd.DataFrame(
        {
            "patient_id": np.repeat(np.arange(10), 6),
            "week": np.tile(np.arange(6), 10),
            "pain": rng.normal(5, 1, 60),
            "sleep": rng.normal(7, 1, 60),
            "arm": pd.Categorical(np.repeat(["A", "B"], 30)),
            "site": pd.Categorical(np.tile(["north", "south", "east"], 20)),
        }
    )
    weekly = visits.groupby(["patient_id", "week"], as_index=False)["pain"].mean()
    return {"visits": visits, "weekly": weekly, "raw": visits[["patient_id"]].drop_duplicates()}


def column(label, kind, frame="visits"):
    return {"name": f"{frame}['{label}']", "label": label, "kind": kind, "parent": frame, "rows": FRAMES[frame]["rows"]}


def frame(name):
    return {"name": name, "label": name, "kind": "dataframe", "rows": FRAMES[name]["rows"], "n_columns": len(FRAMES[name]["columns"])}


def cell(cell_id, defines):
    return {"id": cell_id, "label": f"[{cell_id[-1]}]", "source": f"{defines} = load()", "defs": [defines], "uses": ["load"]}


def options(source, target, cells=()):
    return drop_options(DropRequest.from_json({"source": source, "target": target, "cells": list(cells), "context": CONTEXT}))["options"]


def run(code):
    namespace = data()
    exec(code, namespace)  # noqa: S102  the view runs the same code in the kernel
    return namespace


def test_two_numbers_are_correlated_within_and_between_patients():
    [pair] = [o for o in options(column("sleep", "numeric"), {"item": column("pain", "numeric")}) if o["type"] == "association"]
    assert pair["text"] == "Are sleep and pain associated, within or between patients?"
    assert "whybook.within_between(" in pair["code"]
    run(pair["code"])


def test_a_number_and_a_category_compare_the_number_across_the_levels(capsys):
    [pair] = [o for o in options(column("arm", "categorical"), {"item": column("pain", "numeric")}) if o["type"] == "association"]
    assert pair["text"] == "Does pain differ between the levels of arm?"
    # A line with the result first (design iteration 1.75), and each patient once: arm stays the same within a patient.
    assert 'whybook.compare_levels(visits, "pain", "arm", unit="patient_id")' in pair["code"]
    run(pair["code"])
    assert "over the 2 levels of arm, one mean per patient.\nOne-way analysis of variance: F = " in capsys.readouterr().out


def test_two_categories_show_a_table_of_their_levels():
    [pair] = [o for o in options(column("arm", "categorical"), {"item": column("site", "categorical")}) if o["type"] == "association"]
    assert pair["text"] == "Are arm and site independent?"
    # Counts with a chi-square test (design iteration 1.85); site changes within a patient, so the rows count.
    assert 'whybook.cross_table(visits, "arm", "site", unit="patient_id")' in pair["code"]
    run(pair["code"])


def test_a_cell_whose_frame_lacks_the_outcome_is_not_asked_about_the_outcome():
    raw_cell, visits_cell = cell("c2", "raw"), cell("c3", "visits")
    texts = [o["text"] for o in options(column("sleep", "numeric"), {"cell": raw_cell}, [raw_cell, visits_cell])]
    assert not any("pain" in text for text in texts), texts
    texts = [o["text"] for o in options(column("sleep", "numeric"), {"cell": visits_cell}, [raw_cell, visits_cell])]
    assert "Is sleep associated with pain here, adjusting for site?" in texts


def test_a_frame_that_holds_the_outcome_is_screened_against_its_own_column():
    weekly_cell = cell("c4", "weekly")
    [screen] = [o for o in options(frame("visits"), {"cell": weekly_cell}, [weekly_cell]) if o["text"].startswith("Screen every column")]
    assert 'whybook.screen(visits, "pain")' in screen["code"]
    assert "visits_hits" in run(screen["code"])


# A frame dropped on a cell, used as the cell's input (critique 4, the app).
# The cell below names no column: its helper reads them, as to_long reads the
# columns of diary_raw in the demo, and "Use diary as the input to [3]" wrote
# diary_diary = to_long(diary), which raised KeyError.


def test_a_frame_without_the_columns_of_a_cells_input_gets_no_template_to_replace_it():
    reshape = {"id": "c3", "label": "[3]", "source": "long = to_long(raw)", "defs": ["long"], "uses": ["raw", "to_long"]}
    [swap] = [o for o in options(frame("weekly"), {"cell": reshape}, [reshape]) if o["text"] == "Use weekly as the input to [3]"]
    assert swap["code"] is None


def test_a_frame_with_every_column_of_a_cells_input_replaces_it_in_a_branch():
    summary = {"id": "c5", "label": "[5]", "source": "table = summarise(weekly)", "defs": ["table"], "uses": ["weekly", "summarise"]}
    [swap] = [o for o in options(frame("visits"), {"cell": summary}, [summary]) if o["text"] == "Use visits as the input to [5]"]
    assert "table_visits = summarise(visits)" in swap["code"]
