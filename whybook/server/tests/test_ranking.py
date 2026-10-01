"""The order of offered questions by a model: the request, the remote model, Jev and the route."""

import json
import types

import pytest
from tornado.httpclient import HTTPClientError

from whybook.server import claude, local_models
from whybook.server.config import Whybook
from whybook.server.questions import ranking
from whybook.server.questions.models import InvalidRequest

AGE = {"name": "patients['age']", "label": "age", "kind": "numeric", "parent": "patients", "rows": 318, "missing": 0}
QUESTIONS = [
    {"id": "q1", "text": "Is age associated with pain?", "type": "association"},
    {"id": "q2", "text": "How many rows lack age?", "type": "quality"},
]


def body(model="remote", **extra):
    return {"model": model, "questions": QUESTIONS, "selection": {"source": AGE}, "context": {"mode": "do"}, **extra}


def test_a_request_needs_a_model_and_questions():
    with pytest.raises(InvalidRequest):
        ranking.request_from_json({"questions": QUESTIONS})
    with pytest.raises(InvalidRequest):
        ranking.request_from_json({"model": "remote", "questions": []})
    with pytest.raises(InvalidRequest):
        ranking.request_from_json({"model": "remote", "questions": [{"id": "q1"}]})
    request = ranking.request_from_json(body())
    state = ranking.state_of(request)
    assert [item["name"] for item in state["selected"]] == ["age"]
    assert state["mode"] == "do"
    # Questions about cells come without a selection.
    request = ranking.request_from_json({"model": "remote", "questions": QUESTIONS})
    assert "selected" not in ranking.state_of(request)
    assert "Mode: wonder" in ranking.state_text(ranking.state_of(request))


async def events(request, config, fetch=None):
    return [event async for event in ranking.rank_events(request, config, fetch)]


async def test_the_remote_model_gives_a_probability_for_each_question(monkeypatch):
    seen = {}

    async def structured_call(prompt, *, schema, system_prompt, config, effort, images=None):
        seen["prompt"] = json.loads(prompt)
        seen["system"] = system_prompt
        yield {"type": "progress", "stage": "thinking", "elapsed": 0.1}
        output = {"scores": [{"id": "q2", "probability": 0.9}, {"id": "q1", "probability": 1.4}, {"id": "q9", "probability": 0.5}]}
        yield {"type": "result", "output": output, "model": "claude-opus-5-5", "cost_usd": 0.002, "elapsed": 1.0}

    monkeypatch.setattr(claude, "structured_call", structured_call)
    found = await events(ranking.request_from_json(body()), Whybook())
    assert [event["type"] for event in found] == ["progress", "result"]
    # Out of range is held to 1; an id that was not asked about is left out.
    assert found[-1]["scores"] == {"q1": 1.0, "q2": 0.9}
    assert found[-1]["model"] == "claude-opus-5-5"
    assert [question["id"] for question in seen["prompt"]["questions"]] == ["q1", "q2"]
    assert seen["prompt"]["state"]["selected"][0]["name"] == "age"
    # The prompt that research/ranking-placement.md measured at 60.7% of 300 drops asks
    # what the analyst will ask next; the mode stays in the state that the model reads.
    assert seen["system"].startswith("You predict the question that an analyst asks next")
    assert "should ask" not in seen["system"]
    assert seen["prompt"]["state"]["mode"] == "do"


async def test_jev_asks_one_yes_or_no_question_per_question_through_typesafe():
    calls = []

    async def fetch(url, **options):
        calls.append((url, options))
        answers = {"q0": {"type": "noul", "noul": 0.3}, "q1": {"type": "noul", "noul": 0.8}}
        return types.SimpleNamespace(body=json.dumps({"model": "jev-1.13.0", "answers": answers}))

    config = Whybook(typesafe_api_key="key", typesafe_base_url="https://jev.example/")
    found = await events(ranking.request_from_json(body("jev")), config, fetch)
    url, options = calls[0]
    assert url == "https://jev.example/v1/systemone"
    sent = json.loads(options["body"])
    assert sorted(sent["questions"]) == ["q0", "q1"]
    assert sent["questions"]["q1"]["type"] == "noul"
    assert "How many rows lack age?" in sent["questions"]["q1"]["instructions"]
    assert found[-1]["scores"] == {"q1": 0.3, "q2": 0.8}
    assert found[-1]["model"] == "jev-1.13.0"
    # Jev's price is not known here: the view counts the call apart.
    assert found[-1]["cost_usd"] is None


async def test_jev_without_a_key_is_an_error_and_a_local_model_answers(monkeypatch):
    config = Whybook(typesafe_api_key="", jev_account_id="", jev_api_token="")
    found = await events(ranking.request_from_json(body("jev")), config)
    assert found[-1]["type"] == "error"
    assert "TYPESAFE_API_KEY" in found[-1]["message"]

    async def ask_rank(model_id, state, questions, threads):
        assert "Selected:" in state and questions == [question["text"] for question in QUESTIONS]
        return {"probabilities": [0.2, 0.7], "model": "Gemma 4 E2B", "file": "ggml-org/x.gguf", "elapsed": 0.4}

    monkeypatch.setattr(local_models, "ask_rank", ask_rank)
    found = await events(ranking.request_from_json(body("gemma-4-e2b")), Whybook())
    assert found[-1]["scores"] == {"q1": 0.2, "q2": 0.7}
    assert found[-1]["file"] == "ggml-org/x.gguf"
    # A model on this machine costs nothing.
    assert found[-1]["cost_usd"] == 0.0
    found = await events(ranking.request_from_json(body("gpt-7")), Whybook())
    assert found[-1]["type"] == "error"


async def test_the_route_orders_questions_and_refuses_bad_requests(jp_fetch, monkeypatch):
    async def ask_rank(model_id, state, questions, threads):
        return {"probabilities": [0.4, 0.6], "model": "Gemma 4 E2B", "file": "f", "elapsed": 0.1}

    monkeypatch.setattr(local_models, "ask_rank", ask_rank)
    response = await jp_fetch("whybook", "questions", "rank", method="POST", body=json.dumps(body("gemma-4-e2b")))
    lines = [json.loads(line) for line in response.body.decode().splitlines()]
    assert lines[-1]["scores"] == {"q1": 0.4, "q2": 0.6}
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "questions", "rank", method="POST", body=json.dumps({"model": "remote"}))
    assert error.value.code == 400
