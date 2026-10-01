"""Zero data retention on OpenRouter: the analyst's choice, and the server's lock (c.Whybook.openrouter_zdr).

The view sends ``"zero_data_retention": false`` with a request when the analyst
turns the setting off. Every call of that request then goes to any provider,
unless the server pins zero data retention for every user. The model client is
faked: no request leaves the process.
"""

import json

import pytest

from whybook.server import connection, model_client, providers
from whybook.server.config import Whybook
from whybook.server.connection import Connection
from whybook.server.keystore import KeyStore

from .test_agent import body as agent_body

OPENROUTER = Connection(provider="openrouter", model="openai/gpt-6")
ARM = {"name": "diary['arm']", "label": "arm", "kind": "categorical", "parent": "diary", "rows": 40, "levels": ["A", "B"], "missing": 0, "unique": 2}
PAIN = {"name": "diary['pain']", "label": "pain", "kind": "numeric", "parent": "diary", "rows": 40, "missing": 0, "unique": 31}
QUESTIONS = {"selection": {"source": ARM, "target": PAIN}, "context": {"mode": "do"}, "model": "remote"}


@pytest.fixture
def pinned():
    """Whether the test server pins zero data retention: a test sets it with parametrize."""
    return False


@pytest.fixture
def jp_server_config(jp_server_config, pinned):
    return {**jp_server_config, "Whybook": {"openrouter_zdr": pinned}}


@pytest.fixture
def sent(monkeypatch):
    """What each call of the connected model through OpenRouter would ask of its providers, from a fake call."""
    seen = []

    async def structured_call(chosen, key, prompt, *, schema, system_prompt, config, effort, images=None):
        seen.append(model_client.model_settings(chosen, config, effort).get("openrouter_provider"))
        yield {"type": "result", "output": {"questions": []}, "model": chosen.model, "cost_usd": 0.0, "elapsed": 0.1}

    def agent_driver(chosen, key, tools):
        async def run(run, request, config):
            seen.append(model_client.model_settings(chosen, config, config.agent_effort).get("openrouter_provider"))
            return {"type": "result", "answer": "a", "cells": [], "follow_up": [], "model": chosen.model, "cost_usd": None}

        return run

    monkeypatch.setattr(model_client, "structured_call", structured_call)
    monkeypatch.setattr(model_client, "agent_driver", agent_driver)
    connection.save(OPENROUTER)
    KeyStore().set("openrouter", "sk-or-v1-test", signin="openrouter")
    return seen


async def post(jp_fetch, *path, body):
    return await jp_fetch("whybook", *path, method="POST", body=json.dumps(body))


def test_the_server_pins_nothing_by_default_and_a_request_keeps_zero_data_retention_unless_it_turns_it_off():
    config = Whybook()
    assert config.openrouter_zdr is False
    assert config.zdr is True
    assert connection.for_request(config, {}) is config
    assert connection.for_request(config, {"zero_data_retention": True}) is config
    # Only false turns it off: any other value keeps it.
    assert connection.for_request(config, {"zero_data_retention": "no"}).zdr is True
    assert connection.for_request(config, ["zero_data_retention", False]) is config
    turned = connection.for_request(config, {"zero_data_retention": False})
    assert turned.zdr is False
    # The server's config stays as it is, for the next request.
    assert config.zdr is True and config.zero_data_retention is True
    assert model_client.model_settings(OPENROUTER, config, None) == {"openrouter_provider": {"zdr": True}}
    assert model_client.model_settings(OPENROUTER, turned, None) == {}
    # The server's lock: the request's choice has no bearing.
    locked = Whybook(openrouter_zdr=True)
    assert connection.for_request(locked, {"zero_data_retention": False}).zdr is True
    assert model_client.model_settings(OPENROUTER, connection.for_request(locked, {"zero_data_retention": False}), None) == {
        "openrouter_provider": {"zdr": True}
    }


def test_a_refusal_for_want_of_such_a_provider_says_what_the_analyst_can_change():
    words = "No endpoints found matching your data policy"
    loose = model_client.reason(words, "OpenRouter: x/y", None, Whybook())
    assert loose.endswith('Choose another model, or turn off "Zero data retention" in the AI models panel.')
    locked = model_client.reason(words, "OpenRouter: x/y", None, Whybook(openrouter_zdr=True))
    assert locked.endswith("The server requires it (c.Whybook.openrouter_zdr): choose another model.")


async def test_the_status_says_whether_the_server_pins_it(jp_fetch):
    status = json.loads((await jp_fetch("whybook", "status")).body)
    assert status["openrouter_zdr"] is False


@pytest.mark.parametrize("pinned", [True])
async def test_the_status_says_that_the_server_pins_it(jp_fetch, pinned):
    status = json.loads((await jp_fetch("whybook", "status")).body)
    assert status["openrouter_zdr"] is True


async def test_with_the_server_unpinned_the_view_s_choice_reaches_the_providers_settings(jp_fetch, sent):
    await post(jp_fetch, "questions", "claude", body=QUESTIONS)
    await post(jp_fetch, "questions", "claude", body={**QUESTIONS, "zero_data_retention": False})
    await post(jp_fetch, "questions", "claude", body={**QUESTIONS, "zero_data_retention": True})
    # An agent's run reads the choice of the request that started it.
    response = await post(jp_fetch, "agent", body=agent_body(zero_data_retention=False))
    assert json.loads(response.body.decode().splitlines()[-1])["answer"] == "a"
    assert sent == [{"zdr": True}, None, {"zdr": True}, None]


@pytest.mark.parametrize("pinned", [True])
async def test_a_pinned_server_ignores_the_view_s_choice(jp_fetch, sent, pinned):
    await post(jp_fetch, "questions", "claude", body={**QUESTIONS, "zero_data_retention": False})
    await post(jp_fetch, "agent", body=agent_body(zero_data_retention=False))
    assert sent == [{"zdr": True}, {"zdr": True}]


@pytest.mark.parametrize("pinned", [False, True])
async def test_openrouter_s_models_are_listed_and_checked_with_the_choice_in_force(jp_fetch, monkeypatch, pinned):
    listed = []

    async def models(provider_id, *, key, base_url, zdr=True, fetch=None, typed=False):
        listed.append(zdr)
        return [{"id": "openai/gpt-6", "label": "GPT-6", "note": None}]

    async def key_works(key):
        return None

    monkeypatch.setattr(providers, "models", models)
    monkeypatch.setattr(providers, "check_openrouter_key", key_works)
    KeyStore().set("openrouter", "sk-or-v1-test", signin="openrouter")
    await post(jp_fetch, "connection", "models", body={"provider": "openrouter"})
    await post(jp_fetch, "connection", "models", body={"provider": "openrouter", "zero_data_retention": False})
    await post(jp_fetch, "connection", body={"provider": "openrouter", "model": "openai/gpt-6", "zero_data_retention": False})
    assert listed == [True, pinned, pinned]
