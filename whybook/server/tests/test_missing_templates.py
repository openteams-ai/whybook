"""Two templates for the types that the analysts of public notebooks asked and no template offered (design iteration 1.130).

research/order-none.md: when two variables were dragged together and no
offered question had the analyst's type, 38 of 82 times the analyst asked a
descriptive question about the columns; when a column was dragged onto a
cell, 69 of 80 times a question of a model. Each test runs the code that it
gets, on small frames.
"""

from whybook.server.questions.drops import DropRequest, drop_options

from .test_drop_templates import CONTEXT, column, options, run
from whybook.server.questions.marks import plain

MODEL_CELL = {
    "id": "c4",
    "label": "[4]",
    "source": 'import statsmodels.formula.api as smf\nfit = smf.ols("pain ~ week", data=visits).fit()',
    "defs": ["fit", "smf"],
    "uses": ["visits"],
    "formulas": ["pain ~ week"],
}
PLOT_CELL = {"id": "c6", "label": "[6]", "source": "visits.plot.scatter(x='week', y='pain')", "defs": [], "uses": ["visits"], "formulas": []}


def onto(cell, cells):
    return options(column("sleep", "numeric"), {"cell": cell}, cells)


def test_two_columns_dragged_together_offer_a_look_at_both():
    found = {plain(option["text"]): option for option in options(column("sleep", "numeric"), {"item": column("pain", "numeric")})}
    look = found["Summarise sleep and pain: distribution and missingness"]
    assert look["type"] == "descriptive"
    assert look["placement"]["kind"] == "preview"
    namespace = run(look["code"])
    assert "display" in namespace


def test_a_column_dragged_onto_a_cell_that_fits_no_model_is_added_to_the_model_of_another_cell():
    found = {plain(option["text"]): option for option in onto(PLOT_CELL, [MODEL_CELL, PLOT_CELL])}
    added = found["Add sleep to the model in [4]"]
    assert added["type"] == "model"
    assert (added["placement"]["kind"], added["placement"]["cell"]) == ("edit", "c4")
    assert 'smf.ols("pain ~ week + sleep", data=visits)' in added["code"]
    namespace = run(added["code"])
    assert "sleep" in namespace["fit"].params


def test_with_no_model_of_the_outcome_a_model_is_fitted_next_to_the_cell():
    found = {plain(option["text"]): option for option in onto(PLOT_CELL, [PLOT_CELL])}
    model = found["Fit a model of pain on sleep"]
    assert model["type"] == "model"
    assert model["placement"]["kind"] == "new"
    namespace = run(model["code"])
    assert "sleep" in namespace["pain_on_sleep"].params


def test_a_cell_that_fits_a_model_keeps_its_covariate_question():
    texts = [plain(option["text"]) for option in onto(MODEL_CELL, [MODEL_CELL, PLOT_CELL])]
    assert "Add sleep as a covariate" in texts
    assert not any(text.startswith("Add sleep to the model in") or text.startswith("Fit a model of") for text in texts)


def test_without_an_outcome_no_model_is_offered():
    no_outcome = {**CONTEXT, "outcome": None}
    body = {"source": column("sleep", "numeric"), "target": {"cell": PLOT_CELL}, "cells": [PLOT_CELL], "context": no_outcome}
    texts = [plain(option["text"]) for option in drop_options(DropRequest.from_json(body))["options"]]
    assert not any(text.startswith("Fit a model of") or text.startswith("Add sleep to the model") for text in texts)
