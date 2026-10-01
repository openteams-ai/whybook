"""Questions from a model when no template fits a drop: the route of "More questions from AI", with the cell of a drop onto a cell.

The view asks at once when a drop or a click gets no question from the
templates, or only questions that need AI (src/model/rulesfirst.ts). A drop
onto a cell has no second variable: the model reads the cell instead.
"""

import json

import pytest
from tornado.httpclient import HTTPClientError

from whybook.server import claude, local_models
from whybook.server.questions import claude_questions
from whybook.server.questions.drops import DropRequest, drop_options

ITEMS = {"name": "items", "label": "items", "kind": "other"}
NAMES = {"name": "names", "label": "names", "kind": "other"}
AGE = {"name": "df['age']", "label": "age", "kind": "numeric", "parent": "df", "rows": 4, "missing": 1, "value": "41"}
CELL = {"id": "c1", "label": "[1]", "source": "df = pd.read_csv('visits.csv')\ndf.head()"}


def test_some_drops_get_no_question_from_the_templates():
    """The drops that the view then asks a model about: a dict onto a list, and a column onto a cell of a notebook without an outcome."""
    pair = drop_options(DropRequest.from_json({"source": ITEMS, "target": {"item": NAMES}, "context": {}}))
    assert pair["options"] == []
    onto = drop_options(DropRequest.from_json({"source": AGE, "target": {"cell": CELL}, "context": {"frames": {"df": {"age": "num"}}}}))
    assert onto["options"] == [] and onto["placements"] == []


@pytest.fixture
def prompts(monkeypatch):
    """The prompts that would go to the connected model, which answers with one question."""
    seen = []

    async def structured_call(prompt, *, schema, system_prompt, config, effort, images=None):
        seen.append({"prompt": json.loads(prompt), "system": system_prompt})
        output = {"questions": [{"text": "Is age recorded for every visit in df?", "type": "quality", "why": "One row lacks it", "priority": 0.7}]}
        yield {"type": "result", "output": output, "model": "fake-model", "cost_usd": 0.001, "elapsed": 0.3}

    monkeypatch.setattr(claude, "structured_call", structured_call)
    monkeypatch.setattr(claude, "readiness", lambda config: {"available": True, "cli": "claude", "credential": "ANTHROPIC_API_KEY", "reason": None, "setup": None})
    return seen


async def post(jp_fetch, body):
    response = await jp_fetch("whybook", "questions", "claude", method="POST", body=json.dumps(body))
    return [json.loads(line) for line in response.body.decode().splitlines()]


async def test_a_drop_onto_a_cell_asks_about_the_variable_in_the_cell(jp_fetch, prompts):
    events = await post(jp_fetch, {"selection": {"source": AGE}, "cell": CELL, "context": {"mode": "wonder"}, "model": "remote"})
    assert [question["text"] for question in events[-1]["questions"]] == ["Is age recorded for every visit in df?"]
    sent = prompts[0]["prompt"]
    assert sent["dropped_onto"] == {"cell": "[1]", "code": "df = pd.read_csv('visits.csv')\ndf.head()"}
    assert [item["name"] for item in sent["selected"]] == ["age"]
    assert '"dropped_onto" names a cell' in prompts[0]["system"]
    # Without the setting, the model reads the value; with the data here, the cell's code goes, and no value.
    assert sent["selected"][0]["value"] == "41"
    await post(jp_fetch, {"selection": {"source": AGE}, "cell": CELL, "context": {"mode": "wonder", "keep_data_local": True}, "model": "remote"})
    kept = prompts[1]["prompt"]
    assert kept["dropped_onto"]["code"] == CELL["source"]
    assert "value" not in kept["selected"][0] and "missing" not in kept["selected"][0]


async def test_a_drop_onto_another_variable_names_no_cell(jp_fetch, prompts):
    await post(jp_fetch, {"selection": {"source": ITEMS, "target": NAMES}, "context": {}, "model": "remote"})
    assert "dropped_onto" not in prompts[0]["prompt"]
    assert [item["name"] for item in prompts[0]["prompt"]["selected"]] == ["items", "names"]


async def test_a_cell_without_code_is_refused(jp_fetch, prompts):
    with pytest.raises(HTTPClientError) as error:
        await post(jp_fetch, {"selection": {"source": AGE}, "cell": {"id": "c1"}, "context": {}, "model": "remote"})
    assert error.value.code == 400
    assert prompts == []


async def test_a_local_model_reads_a_shorter_cell(jp_fetch, monkeypatch):
    seen = {}

    async def ask_json(model_id, system, user, schema, max_tokens, threads, stage, check="fast"):
        seen["user"] = user
        yield {"type": "result", "output": {"questions": [{"text": "How many visits lack an age", "type": "quality", "why": "missing ages", "priority": 0.5}]}, "model": "Gemma 4 E2B", "cost_usd": 0.0, "elapsed": 2.0}

    monkeypatch.setattr(local_models, "ask_json", ask_json)
    monkeypatch.setattr(local_models, "model_of", lambda model_id, spec=None: type("Model", (), {"id": model_id})())
    long = {**CELL, "source": "x = 1\n" * 400}
    events = await post(jp_fetch, {"selection": {"source": AGE}, "cell": long, "context": {}, "model": "gemma-4-e2b"})
    assert events[-1]["questions"][0]["origin"] == "local"
    assert seen["user"]["dropped_onto"]["cell"] == "[1]"
    assert len(seen["user"]["dropped_onto"]["code"]) == 600
    assert claude_questions.dropped_onto(long)["code"] == long["source"][: claude_questions.CELL_CHARS]
