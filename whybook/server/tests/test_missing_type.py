"""The type that the analyst likely wants when no offered question has it (design iteration 1.130).

research/order-none.md: in 27% to 32% of the cases rebuilt from public
notebooks, no offered question has the type of the author's next question.
The type predictor gives that chance, and the likeliest missing type, from
what the server knows of a request. The view greys the template questions
lightly at 0.7 or more, and asks the model of More questions for a question
of the missing type, which then goes first. No test calls a model.
"""

import json

import pytest

from whybook.server import connection
from whybook.server.config import Whybook
from whybook.server.questions import claude_questions, missing
from whybook.server.questions.drops import DropRequest, drop_options
from whybook.server.questions.models import Candidate, Context, InvalidRequest, Selection, Variable
from whybook.server.questions.rankers import merged_order

FRAME = {"name": "df", "label": "df", "kind": "dataframe", "rows": 1000, "n_columns": 3}
AGE = {"name": "df['age']", "label": "age", "kind": "numeric", "parent": "df", "rows": 1000, "tag": "num"}
PAIN = {"name": "df['pain']", "label": "pain", "kind": "numeric", "parent": "df", "rows": 1000, "tag": "num"}
CONTEXT = {"frames": {"df": {"rows": 1000, "columns": {"age": "num", "site": "cat", "pain": "num"}}}, "used": [], "asked": []}


def asked(*types):
    return [{"id": f"q{i}", "text": f"Question {i}", "type": kind} for i, kind in enumerate(types)]


def drop(source, target, context=CONTEXT):
    return drop_options(DropRequest.from_json({"source": source, "target": {"item": target}, "cells": [], "context": context}))


def variable(data):
    return Variable.from_json(data)


def test_the_weights_file_has_a_weight_for_each_feature_of_the_module():
    found = missing.predictor()
    variable_features = missing.variable_features("pair", ("num", "num"), ["association"], [], None, 0)
    cell_features = missing.cell_features(["association"], [], None, 0)
    for gesture, features in (("variable", variable_features), ("cell", cell_features)):
        model = found[gesture]
        assert len(model["mean"]) == len(model["scale"]) == len(features)
        assert all(len(row) == len(features) for row in model["coef"])
        assert len(model["coef"]) == len(model["intercept"]) == len(model["classes"])
    assert found["variable"]["cases"] > 6000


def test_what_was_dragged_onto_what_takes_the_names_of_the_research():
    column, other = variable(AGE), variable(PAIN)
    frame = variable(FRAME)
    fit = variable({"name": "fit", "label": "fit", "kind": "model"})
    assert missing.drop_kind([column]) == ("column", ("num", "num"))
    assert missing.drop_kind([column, other]) == ("pair", ("num", "num"))
    # The model's tag comes first and the frame's last, whichever was dragged.
    assert missing.drop_kind([column, fit]) == missing.drop_kind([fit, column]) == ("model and column", ("model", "num"))
    assert missing.drop_kind([frame, column]) == ("frame and column", ("num", "dataframe"))
    assert missing.drop_kind([frame]) == ("frame", ("dataframe", "dataframe"))
    assert missing.drop_kind([frame, variable({**FRAME, "name": "visits", "label": "visits"})])[0] == "frames"
    assert missing.drop_kind([fit, frame]) == ("model and frame", ("model", "dataframe"))
    # A file is not in the kernel yet: the predictor learned no such case.
    assert missing.drop_kind([variable({"name": "data.csv", "label": "data.csv", "kind": "file", "path": "data.csv"})]) is None


def test_a_column_takes_its_tag_as_the_research_grouped_tags():
    def tag(data):
        return missing.tag_of(variable(data))

    assert tag({**AGE, "tag": "int"}) == "num"
    assert tag({**AGE, "kind": "categorical", "tag": "ord"}) == "cat"
    assert tag({**AGE, "kind": "text", "tag": "text"}) == "other"
    # With no tag, the kind says it; with no frame, it is a series.
    assert tag({**AGE, "kind": "binary", "tag": None}) == "bool"
    assert tag({"name": "s", "label": "s", "kind": "numeric"}) == "series"


def test_the_probabilities_of_the_five_types_sum_to_one():
    for gesture, features in (
        ("variable", missing.variable_features("frame", ("dataframe", "dataframe"), ["descriptive"], ["model", "model"], "model", 12)),
        ("cell", missing.cell_features(["association", "descriptive"], ["model"], "model", 30)),
    ):
        assert sum(missing.probabilities(gesture, features)) == pytest.approx(1.0)


def test_a_frame_dragged_onto_itself_after_model_questions_misses_a_model_question():
    result = drop(FRAME, FRAME, {**CONTEXT, "asked": asked("model", "model", "model", "model"), "last_type": "model"})
    assert "model" not in {option["type"] for option in result["options"]}
    assert result["missing"]["type"] == "model"
    assert result["missing"]["probability"] >= 0.7


def test_two_columns_after_association_questions_are_not_marked():
    result = drop(AGE, PAIN, {**CONTEXT, "asked": asked("association", "association", "association"), "last_type": "association"})
    assert result["missing"]["probability"] < 0.7


def test_a_list_that_offers_every_type_has_no_missing_type():
    assert missing.missing_type("cell", missing.cell_features(missing.TYPES, [], None, 3), missing.TYPES) is None


def candidate(identifier, text, kind, probability, origin="claude"):
    return Candidate(id=identifier, text=text, type=kind, origin=origin, variables=(AGE["name"], PAIN["name"]), prior=probability, probability=probability)


def test_the_models_question_of_the_missing_type_comes_first():
    offered = [candidate("t1", "Are age and pain associated?", "association", 0.8, "template")]
    added = [
        candidate("m1", "Does site explain pain?", "association", 0.9),
        candidate("m2", "How are age and pain distributed?", "descriptive", 0.5),
    ]
    involved = [variable(AGE), variable(PAIN)]
    context = Context.from_json(CONTEXT)
    plain = merged_order(list(offered), list(added), involved, context, learned=True, cells_above=4)
    # Without a missing type, the model's question that names site, which no template names, comes first.
    assert plain[0].id == "m1"
    added = [candidate("m1", "Does site explain pain?", "association", 0.9), candidate("m2", "How are age and pain distributed?", "descriptive", 0.5)]
    marked = merged_order(list(offered), added, involved, context, learned=True, cells_above=4, missing="descriptive")
    assert marked[0].id == "m2"
    assert "is of the type descriptive, which no template question here has" in marked[0].reasons


@pytest.fixture
def model(monkeypatch):
    """The connected model: it answers with no questions, and keeps the system prompt that it read."""
    seen = []

    async def structured_call(prompt, *, schema, system_prompt, config, effort, images=None):
        seen.append(system_prompt)
        yield {"type": "result", "output": {"questions": [], "outcomes": [], "units": []}, "model": "fake-model", "cost_usd": 0.0, "elapsed": 0.1}

    monkeypatch.setattr(connection, "structured_call", structured_call)
    return seen


async def test_the_model_of_more_questions_is_asked_for_a_question_of_the_missing_type(model):
    selection, context = Selection.from_json({"source": AGE, "target": PAIN}), Context.from_json(CONTEXT)
    offered = claude_questions.offered_from_json([{"id": "t1", "text": "Are age and pain associated?", "type": "association"}])
    [event async for event in claude_questions.generate(selection, context, [], Whybook(), offered=offered)]
    [event async for event in claude_questions.generate(selection, context, [], Whybook(), offered=offered, missing="descriptive")]
    assert model[0] == claude_questions.SYSTEM_PROMPT
    assert model[1] == claude_questions.SYSTEM_PROMPT + '\nPropose at least one question of type "descriptive", a type that no question in "already_suggested" has.'


def test_a_missing_type_must_be_a_type():
    assert claude_questions.missing_from_json(None) is None
    assert claude_questions.missing_from_json("model") == "model"
    with pytest.raises(InvalidRequest):
        claude_questions.missing_from_json("anything")
    assert json.loads(json.dumps(missing.TYPES)) == ["descriptive", "quality", "association", "model", "causal"]
