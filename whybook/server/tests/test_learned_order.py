"""The learned ranker orders the types of a drop's options; the rules order the options within a type."""

import whybook.server.questions.drops as drops
from whybook.server.questions.drops import DropRequest, drop_options
from whybook.server.questions.models import Variable
from whybook.server.questions.rankers import LEARNED, kind_group

FRAME = {"name": "df", "label": "df", "kind": "dataframe", "rows": 1000, "n_columns": 3}
AGE = {"name": "df['age']", "label": "age", "kind": "numeric", "parent": "df", "rows": 1000}
PAIN = {"name": "df['pain']", "label": "pain", "kind": "numeric", "parent": "df", "rows": 1000}
CONTEXT = {"frames": {"df": {"rows": 1000, "columns": {"age": "num", "site": "cat", "pain": "num"}}}, "used": [], "asked": []}


def options(source, target, context=CONTEXT):
    result = drop_options(DropRequest.from_json({"source": source, "target": {"item": target}, "cells": [], "context": context}))
    return [(option["type"], option["text"]) for option in result["options"]]


def test_the_weights_file_has_a_weight_per_feature():
    assert len(LEARNED["weights"]) == len(LEARNED["features"]) == 25
    assert LEARNED["trained_on"]["drops"] > 6000


def test_a_drop_takes_the_kind_of_the_drops_the_ranker_learned_from():
    column, frame = Variable.from_json(AGE), Variable.from_json(FRAME)
    model = Variable.from_json({"name": "fit", "label": "fit", "kind": "model"})
    assert kind_group([column]) == "one variable"
    assert kind_group([column, Variable.from_json(PAIN)]) == "two or more"
    assert kind_group([frame]) == "frames"
    assert kind_group([model, column]) == "one variable"


def test_a_frame_dropped_onto_itself_shows_what_a_row_holds_before_its_profile(monkeypatch):
    # Public notebooks look at a frame's rows 226 times and profile it 80 times
    # (research/ranking-placement.md); the rules alone put the Profile first.
    assert options(FRAME, FRAME)[0] == ("descriptive", "What does one row of df represent?")
    monkeypatch.setattr(drops, "learned_order", lambda found, *args: found)
    assert options(FRAME, FRAME)[0] == ("quality", "Profile df: types, missingness, duplicates")


def test_the_type_that_the_notebook_asks_most_comes_first():
    asked = [{"id": f"q{i}", "text": f"q{i}", "type": "descriptive"} for i in range(6)]
    first = options(AGE, AGE, {**CONTEXT, "asked": asked, "last_type": "descriptive"})[0]
    assert first == ("descriptive", "Summarise age: distribution and missingness")
    assert options(AGE, AGE)[0][0] == "quality"


def test_a_drop_onto_a_cell_keeps_the_rules_order(monkeypatch):
    cell = {"id": "c7", "label": "[7]", "source": 'fit = smf.ols("pain ~ week", data=df).fit()', "defs": ["fit"], "uses": ["smf", "df"], "formulas": ["pain ~ week"]}
    body = {"source": AGE, "target": {"cell": cell}, "cells": [cell], "context": CONTEXT}
    learned = [option["text"] for option in drop_options(DropRequest.from_json(body))["options"]]
    monkeypatch.setattr(drops, "learned_order", lambda found, *args: found)
    rules = [option["text"] for option in drop_options(DropRequest.from_json(body))["options"]]
    assert learned == rules
