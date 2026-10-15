"""The questions of the branches of a user question that lists alternatives (design iteration 1.126)."""

import json

import pytest
from tornado.httpclient import HTTPClientError

from whybook.server.questions import split
from whybook.server.questions.models import InvalidRequest
from whybook.server.tests.test_sorting import fake_llama  # noqa: F401  fixture


def test_a_request_keeps_the_question_its_cell_and_the_model():
    request = split.request_from_json({"text": "  Adjust for  sleep_hours or mood ", "cell": "\n".join(f"line {i}" for i in range(30)), "model": "remote:fast"})
    assert request["text"] == "Adjust for sleep_hours or mood"
    assert request["cell"].splitlines() == [f"line {i}" for i in range(20)]
    assert request["model"] == "remote:fast"
    assert split.request_from_json({"text": "q"})["model"] == "remote"
    for body in (None, {"text": ""}, {"text": "q", "cell": 3}, {"text": "q", "model": 3}):
        with pytest.raises(InvalidRequest):
            split.request_from_json(body)


def test_the_branches_of_an_answer_are_one_line_each_once_and_at_most_the_guard():
    output = {"branches": [" What about  sleep_hours? ", "What about mood?", "What about mood?", *[f"q{i}" for i in range(30)]]}
    found = split.branches_of(output)
    assert found[:2] == ["What about sleep_hours?", "What about mood?"]
    assert len(found) == split.MAX_BRANCHES
    with pytest.raises(ValueError):
        split.branches_of({"questions": []})


async def test_the_route_asks_a_local_model_or_the_remote_model_of_more_questions(jp_fetch, monkeypatch):
    calls = []

    async def local(request, threads, check="fast"):
        calls.append(("local", request))
        return {"branches": ["What about sleep_hours?", "What about mood?"], "model": "Gemma 4 E2B", "cost_usd": 0.0, "elapsed": 1.0}

    async def remote(request, config):
        calls.append(("remote", request))
        return {"branches": ["What about sleep_hours?"], "model": "GPT-6 Luna", "cost_usd": 0.0001, "elapsed": 0.8}

    monkeypatch.setattr(split, "split_local", local)
    monkeypatch.setattr(split, "split", remote)
    body = {"text": "What about sleep_hours or mood?", "cell": "fit = ols()", "model": "gemma-4-e2b"}
    found = json.loads((await jp_fetch("whybook", "questions", "split", method="POST", body=json.dumps(body))).body)
    assert found["branches"] == ["What about sleep_hours?", "What about mood?"]
    assert calls[-1] == ("local", {"text": "What about sleep_hours or mood?", "cell": "fit = ols()", "model": "gemma-4-e2b"})
    found = json.loads((await jp_fetch("whybook", "questions", "split", method="POST", body=json.dumps({**body, "model": "remote:fast"}))).body)
    assert found["model"] == "GPT-6 Luna"
    assert calls[-1][0] == "remote"
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "questions", "split", method="POST", body=json.dumps({**body, "model": "gpt-7"}))
    assert error.value.code == 400


async def test_the_route_says_when_the_model_could_not_split_the_question(jp_fetch, monkeypatch):
    async def failing(request, config):
        raise ValueError("the answer did not come in the form asked for")

    monkeypatch.setattr(split, "split", failing)
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "questions", "split", method="POST", body=json.dumps({"text": "q", "model": "remote"}))
    assert error.value.code == 502


async def test_a_local_model_writes_the_branches_with_its_grammar(fake_llama):
    from whybook.server import local_models

    answer = {"branches": ["What is the impact of adjusting for sleep_hours?", "What is the impact of adjusting for mood?"]}
    local_models._llm(local_models.MODELS["gemma-4-e2b"], 4).answer = json.dumps(answer)
    request = split.request_from_json({"text": "What is the impact of adjusting for sleep_hours or mood?", "model": "gemma-4-e2b"})
    found = await split.split_local(request, 4)
    assert found["branches"] == answer["branches"]
    assert (found["model"], found["cost_usd"]) == ("Gemma 4 E2B", 0.0)
