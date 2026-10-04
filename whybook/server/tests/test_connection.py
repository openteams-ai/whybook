"""The connected model: the key store, the saved choice, readiness without a call, and where each call goes.

Every test has its own WHYBOOK_DATA_DIR (conftest.py), so no test reads the
user's keys or connection.
"""

import os
import stat

import pytest

from whybook.server import claude, connection, model_client, privacy
from whybook.server.config import Whybook
from whybook.server.connection import Connection
from whybook.server.keystore import KeyStore, data_dir


def test_keys_stay_in_a_file_that_only_the_user_reads(whybook_data):
    keys = KeyStore()
    assert keys.path == os.path.join(str(whybook_data), "keys.json") == os.path.join(data_dir(), "keys.json")
    keys.set("openrouter", "sk-or-v1-secret", signin="openrouter", user_id="u1")
    assert keys.get("openrouter") == "sk-or-v1-secret"
    assert keys.has("openrouter") and not keys.has("anthropic")
    meta = keys.meta("openrouter")
    assert meta["signin"] == "openrouter" and meta["user_id"] == "u1" and "key" not in meta and meta["saved"]
    assert stat.S_IMODE(os.stat(keys.path).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(os.path.dirname(keys.path)).st_mode) == 0o700
    assert "sk-or-v1-secret" not in os.environ.values()
    assert keys.delete("openrouter") and not keys.delete("openrouter")
    assert keys.get("openrouter") is None


def test_a_broken_key_file_holds_no_key(whybook_data):
    whybook_data.mkdir(parents=True)
    (whybook_data / "keys.json").write_text("{not json")
    assert KeyStore().get("openrouter") is None
    with pytest.raises(ValueError):
        KeyStore().set("openrouter", "")


def test_no_model_is_connected_until_one_is_saved_or_the_server_offers_the_claude_code_login():
    assert connection.load() == Connection() and Connection().provider == "none"
    assert connection.load(Whybook(claude_code_login=False)).provider == "none"
    assert connection.load(Whybook(claude_code_login=True)).provider == "claude-code"
    assert Connection().label() == "No model connected"
    chosen = Connection.from_json({"provider": "ollama", "model": "qwen3:8b"})
    assert chosen.local and chosen.url == "http://127.0.0.1:11434/v1"
    connection.save(chosen)
    assert connection.load() == chosen
    assert chosen.label() == "Ollama: qwen3:8b"
    assert Connection(provider="claude-code").label(Whybook(claude_model="opus")) == "Claude: opus"
    server = Connection.from_json({"provider": "openai-compatible", "model": "m", "base_url": "http://gpu.lab:8000/v1/", "local": True})
    assert server.url == "http://gpu.lab:8000/v1" and server.local and server.label() == "Server at http://gpu.lab:8000/v1: m"


@pytest.mark.parametrize(
    "data, message",
    [
        ({"provider": "chatgpt"}, "unknown provider"),
        ({"provider": "openai-compatible", "model": "m"}, "needs its URL"),
        ({"provider": "openrouter", "model": "m", "base_url": "http://x"}, "takes no URL"),
        ({"provider": "ollama", "model": "m", "base_url": "ftp://x"}, "starts with http"),
        ({"provider": "ollama", "model": ""}, "at most 200 characters"),
    ],
)
def test_a_bad_connection_is_refused(data, message):
    with pytest.raises(ValueError, match=message):
        Connection.from_json(data)


def test_readiness_says_what_is_missing_without_a_call(monkeypatch):
    config = Whybook()
    connection.save(Connection(provider="openrouter", model=None))
    ready = connection.readiness(config)
    assert ready["available"] is False and ready["reason"] == "not signed in to OpenRouter"
    assert ready["setup"] == "Sign in with OpenRouter in the AI models panel."
    KeyStore().set("openrouter", "sk-or-v1-x")
    assert connection.readiness(config)["reason"] == "no model of OpenRouter is chosen"
    connection.save(Connection(provider="openrouter", model="anthropic/claude-sonnet-5"))
    ready = connection.readiness(config)
    assert ready["available"] is True
    assert (ready["provider"], ready["label"], ready["local"]) == ("openrouter", "OpenRouter: anthropic/claude-sonnet-5", False)
    # OpenRouter's prices are known, so that a cost cap holds its answers.
    assert ready["priced"] is True
    # A server on this machine needs no key, and has no price.
    connection.save(Connection.from_json({"provider": "llamacpp", "model": "qwen3-coder"}))
    assert connection.readiness(config)["available"] is True and connection.readiness(config)["local"] is True
    assert connection.readiness(config)["priced"] is False
    monkeypatch.setattr(model_client, "is_installed", lambda provider=None: False)
    ready = connection.readiness(config)
    assert ready["reason"] == "pydantic-ai-slim is not installed on the server" and "whybook[models]" in ready["setup"]


def test_readiness_asks_for_a_pasted_key_and_the_companys_sdk(monkeypatch):
    config = Whybook()
    connection.save(Connection(provider="anthropic", model="claude-sonnet-5"))
    ready = connection.readiness(config)
    assert (ready["reason"], ready["setup"]) == ("no Anthropic API key is saved", "Paste an Anthropic API key in the AI models panel.")
    KeyStore().set("anthropic", "sk-ant-x", signin="typed")
    ready = connection.readiness(config)
    assert ready["available"] is True and ready["label"] == "Anthropic: claude-sonnet-5" and ready["local"] is False
    # pydantic-ai-slim without the anthropic extra.
    monkeypatch.setattr(model_client, "is_installed", lambda provider=None: provider in (None, "openrouter"))
    ready = connection.readiness(config)
    assert ready["reason"] == "the anthropic package, which Anthropic needs, is not installed on the server"
    connection.save(Connection(provider="huggingface", model="Qwen/Qwen3.8-27B:ovhcloud"))
    monkeypatch.setattr(model_client, "is_installed", lambda provider=None: True)
    assert connection.readiness(config)["reason"] == "not signed in to Hugging Face"
    # The price of a model on Hugging Face's router depends on the company that serves it.
    assert connection.readiness(config)["priced"] is False
    assert Connection(provider="google", model="gemini-3-pro").label() == "Google Gemini: gemini-3-pro"


def test_without_the_flag_there_is_no_model_and_the_claude_code_login_is_refused(monkeypatch):
    # The default of a server: c.Whybook.claude_code_login is off.
    monkeypatch.delenv("WHYBOOK_CLAUDE_CODE_LOGIN")
    config = Whybook()
    assert config.claude_code_login is False
    ready = connection.readiness(config)
    assert (ready["available"], ready["provider"], ready["label"]) == (False, "none", "No model connected")
    assert (ready["reason"], ready["setup"]) == ("no model is connected", "Connect one in the AI models panel.")
    # A saved Claude Code login stays saved, and is refused while the server does not offer it.
    connection.save(Connection(provider="claude-code"))
    ready = connection.readiness(config)
    assert ready["reason"] == "the Claude Code login is for development only, under Anthropic's terms"
    assert ready["setup"] == "Start the server with --Whybook.claude_code_login=True, or connect another model in the AI models panel."
    monkeypatch.setenv("WHYBOOK_CLAUDE_CODE_LOGIN", "1")
    assert Whybook().claude_code_login is True


async def test_a_call_and_an_agent_run_without_a_model_say_how_to_connect_one():
    from whybook.server import agent

    from .test_agent import drive, request

    config = Whybook(claude_code_login=False)
    options = {"schema": {"type": "object"}, "system_prompt": "s", "config": config, "effort": "low"}
    [event] = [event async for event in connection.structured_call("p", **options)]
    assert event == {"type": "error", "message": "No AI model answered: no model is connected. Connect one in the AI models panel."}
    found = await drive(agent.run_events(request(), config, connection.agent_driver(config)), [])
    assert found[-1]["type"] == "error" and found[-1]["message"].endswith("Connect one in the AI models panel.")


def test_the_claude_code_login_keeps_its_own_readiness(monkeypatch):
    monkeypatch.setattr(claude, "readiness", lambda config: {"available": True, "cli": "claude", "credential": "ANTHROPIC_API_KEY", "reason": None, "setup": None})
    ready = connection.readiness(Whybook(claude_model="opus"))
    assert ready["available"] and ready["provider"] == "claude-code" and ready["model"] == "opus" and ready["cli"] == "claude"
    # The CLI knows the prices of its models.
    assert ready["priced"] is True


async def test_each_call_goes_to_the_connected_model(monkeypatch):
    seen = []

    async def by_claude(prompt, **options):
        seen.append(("claude", prompt))
        yield {"type": "result", "output": {}, "model": "claude", "cost_usd": 0.0}

    async def by_pydantic(chosen, key, prompt, **options):
        seen.append((chosen.provider, key, prompt))
        yield {"type": "result", "output": {}, "model": chosen.model, "cost_usd": None}

    monkeypatch.setattr(claude, "structured_call", by_claude)
    monkeypatch.setattr(model_client, "structured_call", by_pydantic)
    options = {"schema": {"type": "object"}, "system_prompt": "s", "config": Whybook(), "effort": "low"}
    [event] = [event async for event in connection.structured_call("first", **options)]
    assert event["model"] == "claude"
    connection.save(Connection(provider="mistral", model="mistral-medium-latest"))
    KeyStore().set("mistral", "mistral-key")
    [event] = [event async for event in connection.structured_call("second", **options)]
    assert seen == [("claude", "first"), ("mistral", "mistral-key", "second")]


async def test_a_result_names_the_provider_that_answered(monkeypatch):
    """The notebook records who wrote a cell: the provider as well as the model, on each route."""
    from whybook.server import agent

    from .test_agent import drive, request

    async def by_claude(prompt, **options):
        yield {"type": "progress", "stage": "writing"}
        yield {"type": "result", "output": {}, "model": "claude-opus-5-5", "cost_usd": 0.01}

    async def by_pydantic(chosen, key, prompt, **options):
        yield {"type": "result", "output": {}, "model": chosen.model, "cost_usd": None}

    async def claude_run(run, request, config):
        return {"type": "result", "answer": "a", "cells": [], "follow_up": [], "model": "claude-opus-5-5", "cost_usd": 0.05}

    def pydantic_run(chosen, key, tools):
        async def run(run, request, config):
            return {"type": "result", "answer": "a", "cells": [], "follow_up": [], "model": chosen.model, "cost_usd": None}

        return run

    monkeypatch.setattr(claude, "structured_call", by_claude)
    monkeypatch.setattr(model_client, "structured_call", by_pydantic)
    monkeypatch.setattr(agent, "claude_driver", claude_run)
    monkeypatch.setattr(model_client, "agent_driver", pydantic_run)
    config = Whybook(claude_code_login=True)
    options = {"schema": {"type": "object"}, "system_prompt": "s", "config": config, "effort": "low"}
    progress, result = [event async for event in connection.structured_call("p", **options)]
    assert "provider" not in progress
    assert (result["provider"], result["model"], result["cost_usd"]) == ("claude-code", "claude-opus-5-5", 0.01)
    found = await drive(agent.run_events(request(), config, connection.agent_driver(config)), [])
    assert (found[-1]["provider"], found[-1]["model"], found[-1]["cost_usd"]) == ("claude-code", "claude-opus-5-5", 0.05)
    connection.save(Connection(provider="mistral", model="mistral-medium-latest"))
    KeyStore().set("mistral", "mistral-key")
    [result] = [event async for event in connection.structured_call("p", **options)]
    assert (result["provider"], result["model"]) == ("mistral", "mistral-medium-latest")
    found = await drive(agent.run_events(request(), config, connection.agent_driver(config)), [])
    assert (found[-1]["provider"], found[-1]["model"], found[-1]["cost_usd"]) == ("mistral", "mistral-medium-latest", None)


async def test_an_expired_hugging_face_sign_in_is_renewed_or_says_to_sign_in_again(monkeypatch):
    import time

    from whybook.server import signin

    seen = []

    async def by_pydantic(chosen, key, prompt, **options):
        seen.append(key)
        yield {"type": "result", "output": {}, "model": chosen.model, "cost_usd": None}

    async def renew(url, **options):
        class Answer:
            code, body = 200, b'{"access_token": "hf_new", "expires_in": 28800}'

        return Answer()

    monkeypatch.setattr(model_client, "structured_call", by_pydantic)
    config = Whybook(huggingface_client_id="whybook-app")
    options = {"schema": {"type": "object"}, "system_prompt": "s", "config": config, "effort": "low"}
    connection.save(Connection(provider="huggingface", model="Qwen/Qwen3.8-27B:ovhcloud"))
    KeyStore().set("huggingface", "hf_old", signin="huggingface", expires_at=time.time() - 1, refresh_token="hf_refresh")
    monkeypatch.setattr(signin.AsyncHTTPClient, "fetch", lambda self, url, **options: renew(url, **options))
    [event] = [event async for event in connection.structured_call("p", **options)]
    assert event["type"] == "result" and seen == ["hf_new"]
    KeyStore().set("huggingface", "hf_old", signin="huggingface", expires_at=time.time() - 1)
    [event] = [event async for event in connection.structured_call("p", **options)]
    assert event == {"type": "error", "message": "No AI model answered: the Hugging Face sign-in has expired. Sign in again in the AI models panel."}
    assert connection.readiness(config)["reason"] == "not signed in to Hugging Face"


def test_a_model_on_this_machine_may_read_the_data_that_stays_here():
    config, body = Whybook(), {"keep_data_local": True}
    assert privacy.keep_local_for_remote(config, body) is True
    connection.save(Connection.from_json({"provider": "ollama", "model": "qwen3:8b"}))
    assert privacy.keep_local_for_remote(config, body) is False
    assert privacy.keep_local(config, body) is True  # Jev and the other services still get no values
    connection.save(Connection.from_json({"provider": "openai-compatible", "model": "m", "base_url": "https://api.example.org/v1"}))
    assert privacy.keep_local_for_remote(config, body) is True


def test_errors_of_other_models_are_worded_plainly():
    config = Whybook()
    connection.save(Connection.from_json({"provider": "ollama", "model": "qwen3:8b"}))
    assert connection.reason("Connection error.", config).startswith("No AI model answered: nothing answered at http://127.0.0.1:11434/v1 for Ollama: qwen3:8b.")
    connection.save(Connection(provider="openrouter", model="x/y"))
    assert "refused the key" in connection.reason("status_code: 401, model_name: x/y, body: {}", config)
    assert "zero data retention" in connection.reason("No endpoints found matching your data policy", config)
    assert "cost cap" in connection.reason("Exceeded the `cost_limit` of 0.5", config)
    connection.save(Connection(provider="google", model="gemini-3-pro"))
    assert connection.reason("status_code: 400, body: API key not valid", config).endswith("Google Gemini: gemini-3-pro refused the key. Paste a new key in the AI models panel.")
    assert "HTTP 429" in connection.reason("status_code: 429, body: RESOURCE_EXHAUSTED", config)
