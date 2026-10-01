"""A remote model for each task (design iteration 1.81): a tier or a model of the connected provider, with its key.

The view names the task's choice as a request's ``model``: "remote" for the
connected model, "remote:fast" or "remote:fastest" for a tier, and
"remote:<provider>:<model>" for one model of the provider. The model client is
faked: no request leaves the process.
"""

import json

import pytest

from whybook.server import connection, model_client, tiers
from whybook.server.config import Whybook
from whybook.server.connection import Connection
from whybook.server.keystore import KeyStore

OPENROUTER = Connection(provider="openrouter", model="anthropic/claude-sonnet-5")
ARM = {"name": "diary['arm']", "label": "arm", "kind": "categorical", "parent": "diary", "rows": 40, "levels": ["A", "B"], "missing": 0, "unique": 2}
PAIN = {"name": "diary['pain']", "label": "pain", "kind": "numeric", "parent": "diary", "rows": 40, "missing": 0, "unique": 31}


def questions(model):
    return {"selection": {"source": ARM, "target": PAIN}, "context": {"mode": "do"}, "model": model}


@pytest.fixture
def called(monkeypatch):
    """The connection of each call through Pydantic AI, from a fake call, with OpenRouter connected and signed in."""
    seen = []

    async def structured_call(chosen, key, prompt, *, schema, system_prompt, config, effort, images=None):
        seen.append((chosen.provider, chosen.model, key, model_client.cost_limit(chosen, config.claude_budget_usd)))
        output = {"questions": [], "scores": [], "cells": []}
        yield {"type": "result", "output": output, "model": f"{chosen.provider}:{chosen.model}", "cost_usd": 0.0, "elapsed": 0.1}

    monkeypatch.setattr(model_client, "structured_call", structured_call)
    connection.save(OPENROUTER)
    KeyStore().set("openrouter", "sk-or-v1-test", signin="openrouter")
    return seen


async def post(jp_fetch, *path, body):
    response = await jp_fetch("whybook", *path, method="POST", body=json.dumps(body))
    return [json.loads(line) for line in response.body.decode().splitlines()]


def test_a_choice_names_the_connected_model_a_tier_or_a_model_of_the_provider():
    assert tiers.is_remote("remote") and tiers.is_remote("remote:fast") and tiers.is_remote("remote:openrouter:a/b")
    assert not tiers.is_remote("remote:") and not tiers.is_remote("gemma-4-e2b") and not tiers.is_remote(None)
    assert tiers.parse("remote") == (None, None, None)
    assert tiers.parse("remote:fastest") == ("fastest", None, None)
    # A model's id can hold a colon of its own, as Hugging Face's company does.
    assert tiers.parse("remote:huggingface:Qwen/Qwen3.8-27B:ovhcloud") == (None, "huggingface", "Qwen/Qwen3.8-27B:ovhcloud")
    for wrong in ("remote:slow", "remote:openrouter:", "rules"):
        with pytest.raises(ValueError):
            tiers.parse(wrong)
    assert tiers.model_for("remote", "openrouter") is None
    assert tiers.model_for("remote:fast", "openrouter") == "inception/mercury-2.5"
    assert tiers.model_for("remote:fastest", "openrouter") == "google/gemini-3.5-flash-lite"
    # No model of the tier for the provider: the connected model answers.
    assert tiers.model_for("remote:fast", "anthropic") is None
    assert tiers.model_for("remote:openrouter:z-ai/glm-5.3-flash", "openrouter") == "z-ai/glm-5.3-flash"
    with pytest.raises(tiers.OtherProvider):
        tiers.model_for("remote:openrouter:z-ai/glm-5.3-flash", "anthropic")
    assert [model["id"] for model in tiers.recommended("openrouter")["fast"]] == ["inception/mercury-2.5", "openai/gpt-6-luna", "z-ai/glm-5.3-flash"]
    assert tiers.recommended("ollama") == {"fast": [], "fastest": []}


def test_a_request_names_its_task_s_model_in_its_own_config():
    config = Whybook()
    assert connection.for_request(config, {"model": "remote"}) is config
    assert connection.for_request(config, {"model": "gemma-4-e2b"}) is config
    own = connection.for_request(config, {"model": "remote:fast", "zero_data_retention": False})
    assert (own.task_model, own.zdr) == ("remote:fast", False)
    assert (config.task_model, config.zdr) == ("remote", True)
    assert connection.task_connection(OPENROUTER, own) == Connection(provider="openrouter", model="inception/mercury-2.5")
    assert connection.task_connection(OPENROUTER, config) == OPENROUTER
    picked = connection.for_request(config, {"model": "remote:anthropic:claude-haiku-4-5"})
    with pytest.raises(tiers.OtherProvider, match="claude-haiku-4-5, a model of Anthropic, and the connected model is OpenRouter: anthropic/claude-sonnet-5"):
        connection.task_connection(OPENROUTER, picked)


async def test_each_route_calls_its_task_s_model_with_the_provider_s_key(jp_fetch, called):
    await post(jp_fetch, "questions", "claude", body=questions("remote:fast"))
    await post(jp_fetch, "questions", "claude", body=questions("remote"))
    await post(jp_fetch, "questions", "claude", body=questions("remote:openrouter:z-ai/glm-5.3-flash"))
    # The labels of tables and the titles of cells.
    table = {"id": "t1", "code": "diary.head()", "text": "   arm  pain\n0  A  5.1", "rows": 1, "columns": 2}
    await post(jp_fetch, "tables", "describe", body={"model": "remote:openrouter:openai/gpt-6-nano", "tables": [table]})
    cell = {"id": "c1", "code": "diary = load()", "title": "diary = load()"}
    await post(jp_fetch, "cells", "title", body={"model": "remote:fastest", "cells": [cell]})
    # The order of the questions offered.
    offered = [{"id": "q1", "text": "Is pain associated with arm?", "type": "association"}]
    await post(jp_fetch, "questions", "rank", body={"model": "remote:fast", "questions": offered, "selection": {"source": ARM, "target": PAIN}})
    fast = ("openrouter", "inception/mercury-2.5", "sk-or-v1-test", 0.5)
    sonnet = ("openrouter", "anthropic/claude-sonnet-5", "sk-or-v1-test", 0.5)
    assert called == [
        fast,
        sonnet,
        ("openrouter", "z-ai/glm-5.3-flash", "sk-or-v1-test", 0.5),
        ("openrouter", "openai/gpt-6-nano", "sk-or-v1-test", 0.5),
        # The fastest tier on OpenRouter.
        ("openrouter", "google/gemini-3.5-flash-lite", "sk-or-v1-test", 0.5),
        fast,
    ]


async def test_a_model_of_another_provider_is_refused_with_the_reason(jp_fetch, called):
    events = await post(jp_fetch, "questions", "claude", body=questions("remote:anthropic:claude-haiku-4-5"))
    assert called == []
    assert events[-1]["type"] == "error"
    assert "claude-haiku-4-5, a model of Anthropic" in events[-1]["message"]
    assert events[-1]["message"].endswith("Choose the task's model again in the AI models panel.")


async def test_the_status_lists_the_connected_provider_s_models_of_each_tier(jp_fetch, called):
    status = json.loads((await jp_fetch("whybook", "status")).body)
    assert [model["id"] for model in status["remote_tiers"]["fast"]] == ["inception/mercury-2.5", "openai/gpt-6-luna", "z-ai/glm-5.3-flash"]
    assert [model["id"] for model in status["remote_tiers"]["fastest"]] == ["google/gemini-3.5-flash-lite"]
    connection.save(Connection(provider="anthropic", model="claude-sonnet-5"))
    status = json.loads((await jp_fetch("whybook", "status")).body)
    assert status["remote_tiers"] == {"fast": [], "fastest": []}
