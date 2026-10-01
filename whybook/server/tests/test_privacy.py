"""The data kept on this machine: what the remote model and Jev read, route by route (fake models)."""

import json

import pytest
from tornado.httpclient import HTTPClientError

from whybook.server import claude, privacy
from whybook.server.config import Whybook
from whybook.server.questions import templates
from whybook.server.questions.cells import CellInfo
from whybook.server.questions.models import Selection
from whybook.server.solve import SolveRequest

# A frame and a column as the kernel lists them, with the values a listing carries.
DIARY = {
    "name": "diary",
    "label": "diary",
    "kind": "dataframe",
    "type": "pandas.core.frame.DataFrame",
    "rows": 36941,
    "n_columns": 3,
    "defined_in": {"file": "prep.py", "line": 12, "module": "prep"},
    "columns": [
        {"label": "treatment_arm", "tag": "cat", "levels": ["A", "B"], "missing": 0},
        {"label": "pain_score", "tag": "num", "min": 0.4, "max": 9.1, "missing": 812},
    ],
    "selection": {"of": "weekly", "where": "6 <= week <= 9"},
    "error": "KeyError('P-0042')",
}
FIT = {
    "name": "lmm_fit",
    "label": "lmm_fit",
    "kind": "model",
    "formula": "pain_score ~ treatment_arm * month",
    "nobs": 3180,
    "converged": True,
    "terms": [{"term": "treatment_arm[T.B]", "coef": -0.857, "lo": -1.17, "hi": -0.54, "p": 0.0}],
}
MIN_DAYS = {"name": "MIN_DAYS", "label": "MIN_DAYS", "kind": "constant", "type": "builtins.int", "value": "14"}
ARM = {"name": "diary['treatment_arm']", "label": "treatment_arm", "kind": "categorical", "parent": "diary", "rows": 36941, "levels": ["A", "B"], "missing": 0, "unique": 2}
PAIN = {"name": "diary['pain_score']", "label": "pain_score", "kind": "numeric", "parent": "diary", "rows": 36941, "missing": 812, "unique": 91}

# What must not reach a prompt: levels, a range, counts, a value, estimates, a range picked, an error.
VALUES = ['"A"', '"B"', "9.1", "812", '"14"', "-0.857", "6 <= week", "P-0042", '"unique"']


def assert_no_values(text):
    for value in VALUES:
        assert value not in text, value


def test_a_variable_keeps_its_names_kinds_and_sizes():
    assert privacy.local_variable(DIARY) == {
        "name": "diary",
        "label": "diary",
        "kind": "dataframe",
        "type": "pandas.core.frame.DataFrame",
        "rows": 36941,
        "n_columns": 3,
        "defined_in": {"file": "prep.py", "line": 12, "module": "prep"},
        "columns": [{"label": "treatment_arm", "tag": "cat"}, {"label": "pain_score", "tag": "num"}],
        "selection": {"of": "weekly"},
    }
    assert privacy.local_variable(FIT) == {
        "name": "lmm_fit",
        "label": "lmm_fit",
        "kind": "model",
        "formula": "pain_score ~ treatment_arm * month",
        "nobs": 3180,
        "terms": ["treatment_arm[T.B]"],
    }
    assert privacy.local_variable(MIN_DAYS) == {"name": "MIN_DAYS", "label": "MIN_DAYS", "kind": "constant", "type": "builtins.int"}
    # The server's option keeps the data here whatever the view sends.
    assert privacy.keep_local(Whybook(keep_data_local=True), {}) is True
    assert privacy.keep_local(Whybook(), {"context": {"keep_data_local": True}}) is True
    assert privacy.keep_local(Whybook(), {"keep_data_local": False}) is False


def solve_body(**extra):
    return {
        "question": {"text": "Does pain differ by arm?", "type": "association"},
        "selection": {"source": ARM, "target": PAIN},
        "variables": [DIARY, FIT, MIN_DAYS],
        "packages": {"pandas": "3.0"},
        "cells": ["[1] Load the diary"],
        "about": "the rows of weekly where 6 <= week <= 9, picked in the plot",
        **extra,
    }


def test_a_cell_is_asked_for_without_values():
    loose = SolveRequest.from_json(solve_body()).prompt()
    assert '"levels"' in loose and "9.1" in loose and '"14"' in loose
    kept = privacy.local_request(SolveRequest.from_json(solve_body())).prompt()
    assert_no_values(kept)
    prompt = json.loads(kept)
    assert [item["name"] for item in prompt["selected"]] == ["treatment_arm", "pain_score"]
    assert prompt["variables"][0]["columns"] == [{"label": "treatment_arm", "tag": "cat"}, {"label": "pain_score", "tag": "num"}]


@pytest.fixture
def prompts(monkeypatch):
    """The prompts that would go to Claude, answered by a fake model."""
    seen = []

    async def structured_call(prompt, *, schema, system_prompt, config, effort, images=None):
        seen.append(prompt)
        output = {"questions": [], "scores": []} if "questions" in schema["properties"] or "scores" in schema["properties"] else {}
        yield {"type": "result", "output": output, "model": "fake", "cost_usd": 0.0, "elapsed": 0.1}

    monkeypatch.setattr(claude, "structured_call", structured_call)
    monkeypatch.setattr(claude, "readiness", lambda config: {"available": True, "cli": "claude", "credential": "ANTHROPIC_API_KEY", "reason": None, "setup": None})
    return seen


async def post(jp_fetch, *path, body):
    return await jp_fetch("whybook", *path, method="POST", body=json.dumps(body))


async def test_more_questions_and_their_order_read_no_values(jp_fetch, prompts):
    selection = {"source": ARM, "target": PAIN}
    context = {"keep_data_local": True, "mode": "do"}
    await post(jp_fetch, "questions", "claude", body={"selection": selection, "context": context, "model": "remote"})
    questions = [{"id": "q1", "text": "Is pain associated with arm?", "type": "association"}, {"id": "q2", "text": "How many rows lack pain?", "type": "quality"}]
    await post(jp_fetch, "questions", "rank", body={"model": "remote", "questions": questions, "selection": selection, "context": context})
    assert len(prompts) == 2
    for prompt in prompts:
        assert_no_values(prompt)
    more = json.loads(prompts[0])
    assert [item["name"] for item in more["selected"]] == ["treatment_arm", "pain_score"]
    # A template's text can hold a constant's value: the questions offered stay here.
    assert "already_suggested" not in more
    # Without the setting, the model reads the levels, as before.
    await post(jp_fetch, "questions", "claude", body={"selection": selection, "context": {"mode": "do"}, "model": "remote"})
    assert '"levels"' in prompts[-1] and "already_suggested" in prompts[-1]


async def test_tables_and_pictures_are_refused(jp_fetch, prompts):
    table = {"id": "t1", "code": "diary.head()", "text": "   arm  pain\n0  A  5.1", "rows": 1, "columns": 2}
    with pytest.raises(HTTPClientError) as error:
        await post(jp_fetch, "tables", "describe", body={"model": "remote", "tables": [table], "keep_data_local": True})
    assert error.value.code == 409
    picture = {"mime": "image/png", "data": "aGk=", "width": 2, "height": 2, "point": {"x": 1, "y": 1, "fx": 0.5, "fy": 0.5}}
    with pytest.raises(HTTPClientError) as error:
        await post(jp_fetch, "solve", body=solve_body(image=picture, keep_data_local=True))
    assert error.value.code == 409
    assert prompts == []


TOKEN = "hf_" + "Q" * 34


def test_a_token_in_a_variable_goes_to_no_model():
    # As a view kept it before 29 September 2026, when the kernel listed a token with its value.
    token = {"name": "HF_TOKEN", "label": "HF_TOKEN", "kind": "constant", "type": "builtins.str", "value": repr(TOKEN)}
    gateway = {"name": "gateway", "label": "gateway", "kind": "constant", "type": "builtins.str", "value": repr("sk-company-gateway-2f9K1mQ7")}
    # As the kernel lists a secret now.
    hub = {"name": "hub", "label": "hub", "kind": "constant", "type": "builtins.str", "secret": True, "length": 40}
    days = {"name": "MIN_DAYS", "label": "MIN_DAYS", "kind": "constant", "type": "builtins.int", "value": "14"}
    body = {
        "question": {"text": "How does bmi relate to pain?", "type": "association"},
        "variables": [token, gateway, hub, days],
        "selection": {"source": token, "target": gateway},
    }
    for prompt in (SolveRequest.from_json(body).prompt(), privacy.local_request(SolveRequest.from_json(body)).prompt()):
        assert TOKEN not in prompt and "sk-company" not in prompt
        variables = {variable["name"]: variable for variable in json.loads(prompt)["variables"]}
        assert variables["HF_TOKEN"]["secret"] is True and "value" not in variables["HF_TOKEN"]
        assert variables["hub"]["secret"] is True
    assert json.loads(SolveRequest.from_json(body).prompt())["variables"][-1]["value"] == "14"


def test_a_token_picked_in_contents_brings_no_question_about_its_value():
    token = {"name": "HF_TOKEN", "label": "HF_TOKEN", "kind": "constant", "type": "builtins.str", "value": repr(TOKEN)}
    selection = Selection.from_json({"source": token, "target": token})
    assert selection.source.value is None and "value" not in selection.source.to_state()
    assert templates.generate(selection) == []
    days = Selection.from_json({"source": {"name": "MIN_DAYS", "kind": "constant", "value": "14"}, "target": {"name": "MIN_DAYS", "kind": "constant", "value": "14"}})
    assert [candidate.text for candidate in templates.generate(days)] == ["Why is MIN_DAYS set to 14, and do the results depend on it?"]


def test_a_token_in_a_call_is_no_decision_to_ask_about():
    login = {"name": "token", "value": repr(TOKEN), "provenance": "literal", "param": "token", "function": "login"}
    retries = {"name": "retries", "value": "5", "provenance": "literal", "param": "retries", "function": "login"}
    cell = CellInfo.from_json({"id": "c1", "label": "[1]", "source": f"login(token={TOKEN!r}, retries=5)", "decisions": [login, retries]})
    assert [decision.name for decision in cell.decisions] == ["retries"]
