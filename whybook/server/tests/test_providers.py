"""The servers found on this machine, the models each provider lists, and saving a connection through the routes.

A fake fetch answers for the servers and for the lists of OpenRouter,
Hugging Face and the model companies, in the form of their APIs: no request
leaves the process.
"""

import json

import pytest
from tornado.httpclient import HTTPClientError

from whybook.server import connection, providers
from whybook.server.keystore import KeyStore


class Response:
    def __init__(self, body):
        self.code = 200
        self.body = json.dumps(body).encode()


OPENROUTER_LIST = {
    "data": [
        {"id": "anthropic/claude-sonnet-5", "name": "Anthropic: Claude Sonnet 5", "pricing": {"prompt": "0.000003", "completion": "0.000015"}, "supported_parameters": ["tools", "structured_outputs"]},
        {"id": "openai/gpt-oss-120b:free", "name": "OpenAI: gpt-oss-120b (free)", "pricing": {"prompt": "0", "completion": "0"}, "supported_parameters": ["tools"]},
        {"id": "some/text-only", "name": "Text only", "pricing": {"prompt": "0", "completion": "0"}, "supported_parameters": ["temperature"]},
    ]
}


def answering(routes):
    """A fetch that answers by URL, and refuses a connection to any other address."""

    async def fetch(url, **options):
        if url in routes:
            answer = routes[url]
            if isinstance(answer, Exception):
                raise answer
            return Response(answer)
        raise ConnectionRefusedError(url)

    return fetch


async def test_the_servers_that_answer_on_this_machine_are_found_with_their_models():
    fetch = answering(
        {
            "http://127.0.0.1:11434/api/tags": {"models": [{"name": "qwen3:8b", "size": 5.2e9}, {"name": "gpt-oss:20b", "size": 13.8e9}]},
            "http://127.0.0.1:8080/v1/models": {"data": [{"id": "qwen3-coder-30b-a3b"}]},
        }
    )
    found = await providers.discover(fetch)
    assert [(server["provider"], [model["id"] for model in server["models"]]) for server in found] == [
        ("ollama", ["qwen3:8b", "gpt-oss:20b"]),
        ("llamacpp", ["qwen3-coder-30b-a3b"]),
    ]
    assert found[0]["models"][0]["note"] == "5.2 GB"


async def test_openrouter_lists_the_models_that_take_tools_with_their_prices():
    listed = await providers.models("openrouter", key=None, base_url=None, zdr=False, fetch=answering({providers.OPENROUTER_MODELS: OPENROUTER_LIST}))
    assert [(model["id"], model["note"]) for model in listed] == [
        ("anthropic/claude-sonnet-5", "$3 in, $15 out per million tokens"),
        ("openai/gpt-oss-120b:free", "free"),
    ]


async def test_with_zero_data_retention_only_models_with_such_a_provider_are_listed():
    zdr = {
        "data": [
            {"model_id": "anthropic/claude-sonnet-5", "provider_name": "Amazon Bedrock", "supported_parameters": ["tools", "response_format"]},
            # A provider that keeps no data but takes no tools cannot run Whybook's calls.
            {"model_id": "openai/gpt-oss-120b:free", "provider_name": "Some", "supported_parameters": ["temperature"]},
        ]
    }
    fetch = answering({providers.OPENROUTER_MODELS: OPENROUTER_LIST, providers.OPENROUTER_ZDR: zdr})
    listed = await providers.models("openrouter", key=None, base_url=None, fetch=fetch)
    assert [model["id"] for model in listed] == ["anthropic/claude-sonnet-5"]


async def test_a_server_that_does_not_answer_or_refuses_the_key_is_worded_plainly():
    with pytest.raises(providers.NotChecked, match=r"^LM Studio: nothing answered at http://localhost:1234/v1: is the server running\?$"):
        await providers.models("lmstudio", key=None, base_url=None, fetch=answering({}))
    refused = answering({"http://gpu.lab/v1/models": HTTPClientError(401)})
    with pytest.raises(providers.KeyRefused, match=r"^The server at http://gpu.lab/v1 refused the saved key \(HTTP 401\)$"):
        await providers.models("openai-compatible", key="wrong", base_url="http://gpu.lab/v1", fetch=refused)


HUGGINGFACE_LIST = {
    "object": "list",
    "data": [
        {
            "id": "Qwen/Qwen3.8-27B",
            "owned_by": "Qwen",
            "providers": [
                {"provider": "ovhcloud", "status": "live", "pricing": {"input": 0.47, "output": 3.19}, "supports_tools": True},
                {"provider": "featherless-ai", "status": "live"},  # no tools
                {"provider": "novita", "status": "staging", "supports_tools": True},
                {"provider": "newcomer", "status": "live", "supports_tools": True},
            ],
        },
        {"id": "some/embedder", "providers": [{"provider": "together", "status": "live", "supports_tools": False}]},
    ],
}


async def test_hugging_face_lists_each_model_once_for_each_company_that_serves_it_with_tools():
    listed = await providers.models("huggingface", key=None, base_url=None, fetch=answering({providers.HUGGINGFACE_MODELS: HUGGINGFACE_LIST}))
    assert listed == [
        {"id": "Qwen/Qwen3.8-27B:newcomer", "label": "Qwen/Qwen3.8-27B on newcomer", "note": None},
        {"id": "Qwen/Qwen3.8-27B:ovhcloud", "label": "Qwen/Qwen3.8-27B on OVHcloud", "note": "$0.47 in, $3.19 out per million tokens"},
    ]


async def test_each_company_lists_its_models_with_the_key():
    routes = {
        providers.ANTHROPIC_MODELS: {"data": [{"type": "model", "id": "claude-opus-5", "display_name": "Claude Opus 5"}, {"type": "model", "id": "claude-sonnet-5", "display_name": "Claude Sonnet 5"}], "has_more": False},
        providers.OPENAI_MODELS: {
            "data": [
                {"id": "gpt-5.4", "created": 100},
                {"id": "gpt-5.5", "created": 200},
                {"id": "gpt-realtime", "created": 300},
                {"id": "text-embedding-3-large", "created": 50},
                {"id": "gpt-4o-mini-transcribe", "created": 60},
            ]
        },
        providers.GOOGLE_MODELS: {
            "models": [
                {"name": "models/gemini-3-pro", "displayName": "Gemini 3 Pro", "supportedGenerationMethods": ["generateContent", "countTokens"]},
                {"name": "models/gemini-embedding-001", "displayName": "Gemini Embedding", "supportedGenerationMethods": ["embedContent"]},
                {"name": "models/gemini-3-flash-preview-tts", "displayName": "TTS", "supportedGenerationMethods": ["generateContent"]},
            ]
        },
        providers.MISTRAL_MODELS: {
            "object": "list",
            "data": [
                {"id": "mistral-medium-latest", "capabilities": {"completion_chat": True, "function_calling": True}},
                {"id": "mistral-medium-2508", "capabilities": {"completion_chat": True, "function_calling": True}},
                {"id": "codestral-embed", "capabilities": {"completion_chat": False, "function_calling": False}},
                {"id": "mistral-medium-latest", "capabilities": {"completion_chat": True, "function_calling": True}},
            ],
        },
    }
    fetch = answering(routes)
    ids = {provider_id: [model["id"] for model in await providers.models(provider_id, key="k", base_url=None, fetch=fetch)] for provider_id in ("anthropic", "openai", "google", "mistral")}
    assert ids == {
        "anthropic": ["claude-opus-5", "claude-sonnet-5"],
        "openai": ["gpt-5.5", "gpt-5.4"],
        "google": ["gemini-3-pro"],
        "mistral": ["mistral-medium-2508", "mistral-medium-latest"],
    }
    assert (await providers.models("google", key="k", base_url=None, fetch=fetch))[0]["label"] == "Gemini 3 Pro"
    with pytest.raises(providers.ProviderError, match="paste its API key first"):
        await providers.models("anthropic", key=None, base_url=None, fetch=fetch)


async def test_a_refused_key_is_worded_plainly_and_google_refuses_with_http_400():
    fetch = answering({providers.GOOGLE_MODELS: HTTPClientError(400), providers.OPENAI_MODELS: HTTPClientError(401), providers.MISTRAL_MODELS: HTTPClientError(500)})
    with pytest.raises(providers.KeyRefused, match=r"^Google Gemini refused the saved key \(HTTP 400\)$"):
        await providers.models("google", key="wrong", base_url=None, fetch=fetch)
    with pytest.raises(providers.KeyRefused, match=r"^OpenAI refused this key \(HTTP 401\)$"):
        await providers.check_key("openai", "wrong", fetch)
    # The company's own error: the key is not checked.
    with pytest.raises(providers.NotChecked, match="^Mistral AI answered HTTP 500$"):
        await providers.check_key("mistral", "k", fetch)
    await providers.check_key("huggingface", "hf_x", answering({providers.HUGGINGFACE_WHOAMI: {"name": "analyst"}}))


async def test_an_openrouter_key_is_checked_at_no_cost():
    fetch = answering({providers.OPENROUTER_KEY: {"data": {"label": "sk-or-v1-abc...", "limit": 5, "limit_remaining": 4.2, "usage": 0.8, "is_free_tier": False}}})
    assert await providers.check_openrouter_key("sk-or-v1-abc", fetch) == {"label": "sk-or-v1-abc...", "limit": 5, "limit_remaining": 4.2, "usage": 0.8, "is_free_tier": False}


async def test_the_route_saves_a_connection_that_the_server_lists(jp_fetch, monkeypatch):
    async def listed(provider, *, key, base_url, **options):
        return [{"id": "qwen3:8b", "label": "qwen3:8b", "note": None}]

    monkeypatch.setattr(providers, "models", listed)
    state = json.loads(
        (await jp_fetch("whybook", "connection", method="POST", body=json.dumps({"provider": "ollama", "model": "qwen3:8b"}))).body
    )
    assert state["connection"] == {"provider": "ollama", "model": "qwen3:8b", "base_url": None, "local": True}
    assert state["readiness"]["available"] is True
    status = json.loads((await jp_fetch("whybook", "status")).body)
    assert (status["claude_available"], status["claude"]["provider"], status["claude"]["local"]) == (True, "ollama", True)
    assert status["remote_model"] == "Ollama: qwen3:8b"
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "connection", method="POST", body=json.dumps({"provider": "ollama", "model": "llama3"}))
    assert error.value.code == 409
    assert "does not list 'llama3'" in json.loads(error.value.response.body)["message"]
    assert connection.load().model == "qwen3:8b"


async def test_the_route_keeps_a_typed_key_for_a_server_and_refuses_one_for_a_sign_in(jp_fetch, monkeypatch):
    seen = []

    async def listed(provider, *, key, base_url, **options):
        seen.append((provider, key, base_url))
        return []

    async def needs_its_key(provider, url, fetch=None):
        # The server refuses a request without the key.
        seen.append((provider, None, url))
        return False

    monkeypatch.setattr(providers, "models", listed)
    monkeypatch.setattr(providers, "lists_without_key", needs_its_key)
    body = {"provider": "openai-compatible", "model": "m", "base_url": "https://llm.lab.example/v1", "key": "lab-key", "local": False}
    await jp_fetch("whybook", "connection", method="POST", body=json.dumps(body))
    assert seen == [("openai-compatible", "lab-key", "https://llm.lab.example/v1"), ("openai-compatible", None, "https://llm.lab.example/v1")]
    # The key is kept with the URL it was typed for.
    assert KeyStore().get("openai-compatible") is None
    assert connection.key_for(connection.Connection.from_json(body)) == "lab-key"
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "connection", method="POST", body=json.dumps({"provider": "openrouter", "model": "a/b", "key": "sk"}))
    assert error.value.code == 400
    # A company's model without its key is refused before any request.
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "connection", method="POST", body=json.dumps({"provider": "anthropic", "model": "claude-sonnet-5"}))
    assert error.value.code == 409 and json.loads(error.value.response.body)["message"] == "Anthropic: paste its API key first"
    assert [call[0] for call in seen] == ["openai-compatible", "openai-compatible"]


async def test_the_models_route_lists_a_providers_models(jp_fetch, monkeypatch):
    async def listed(provider, *, key, base_url, **options):
        if provider == "vllm":
            raise providers.NotChecked("vLLM: nothing answered at http://localhost:8000/v1: is the server running?")
        return [{"id": "anthropic/claude-sonnet-5", "label": "Claude Sonnet 5", "note": None}]

    monkeypatch.setattr(providers, "models", listed)
    payload = json.loads((await list_models(jp_fetch, "openrouter")).body)
    assert payload["models"][0]["id"] == "anthropic/claude-sonnet-5"
    with pytest.raises(HTTPClientError) as error:
        await list_models(jp_fetch, "vllm")
    assert error.value.code == 409
    # The words name the server, and say that no key was checked.
    assert json.loads(error.value.response.body) == {
        "message": "vLLM: nothing answered at http://localhost:8000/v1: is the server running?",
        "check": "unchecked",
        "saved": None,
    }


async def list_models(jp_fetch, provider, base_url=None):
    """POST /whybook/connection/models, as the panel lists a provider's models."""
    return await jp_fetch("whybook", "connection", "models", method="POST", body=json.dumps({"provider": provider, "base_url": base_url}))


def sent_to(monkeypatch, keyed=()):
    """The URL and the Authorization header of each request that lists a server's models.

    A URL of ``keyed`` refuses a request without a key, as a server started with its key does.
    """
    sent = []

    async def get_json(url, *, timeout, headers=None, fetch=None):
        sent.append((url, (headers or {}).get("Authorization")))
        if url in keyed and not (headers or {}).get("Authorization"):
            raise HTTPClientError(401)
        return {"data": [{"id": "m"}]}

    monkeypatch.setattr(providers, "get_json", get_json)
    return sent


@pytest.mark.parametrize("provider", ["openai-compatible", "lmstudio", "llamacpp", "vllm"])
async def test_a_typed_key_goes_only_to_the_url_it_was_typed_for(jp_fetch, monkeypatch, provider):
    gateway = "https://gateway.example.com/v1"
    sent = sent_to(monkeypatch, keyed=(f"{gateway}/models",))
    body = {"provider": provider, "model": "m", "base_url": gateway, "key": "sk-company-gateway"}
    await jp_fetch("whybook", "connection", method="POST", body=json.dumps(body))
    # The check lists the models with the key, then once without it, which the gateway refuses: it needs its key.
    assert sent == [(f"{gateway}/models", "Bearer sk-company-gateway"), (f"{gateway}/models", None)]
    del sent[1]
    # The panel lists the models of the server it was typed for with the key, and of any other without it.
    await list_models(jp_fetch, provider, gateway + "/")
    await list_models(jp_fetch, provider, "https://attacker.example.net/v1")
    assert sent[1:] == [(f"{gateway}/models", "Bearer sk-company-gateway"), ("https://attacker.example.net/v1/models", None)]
    # Nor does a new server that the analyst connects without a key get it.
    await jp_fetch("whybook", "connection", method="POST", body=json.dumps({"provider": provider, "model": "m", "base_url": "http://192.168.1.20:8000/v1"}))
    assert sent[-1] == ("http://192.168.1.20:8000/v1/models", None)


async def test_a_page_of_another_site_cannot_list_models_with_a_get(jp_fetch, monkeypatch):
    sent = sent_to(monkeypatch)
    # Jupyter checks the XSRF token of a POST, not of a GET, which a page of any site can make the browser send.
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "connection", "models", params={"provider": "vllm", "base_url": "https://attacker.example.net/v1"})
    assert error.value.code == 405
    with pytest.raises(HTTPClientError) as error:
        await list_models(jp_fetch, "anthropic", "https://attacker.example.net/v1")
    assert error.value.code == 400
    assert sent == []


async def test_an_agent_run_goes_to_the_connected_model(jp_fetch, monkeypatch):
    from whybook.server import agent, model_client

    from .test_agent import body

    connection.save(connection.Connection.from_json({"provider": "ollama", "model": "qwen3:8b"}))
    chosen = []

    def driver_for(conn, key, tools):
        chosen.append((conn.provider, conn.model, key, sorted(tools)))
        return agent.scripted([("finish", {"answer": "Arm B ([2])."})], model="ollama:qwen3:8b")

    monkeypatch.setattr(model_client, "agent_driver", driver_for)
    response = await jp_fetch("whybook", "agent", method="POST", body=json.dumps(body()))
    lines = [json.loads(line) for line in response.body.decode().splitlines()]
    assert lines[-1]["answer"] == "Arm B ([2])." and lines[-1]["model"] == "ollama:qwen3:8b"
    assert chosen == [("ollama", "qwen3:8b", None, ["explore", "finish", "new_notebook", "run_cell", "share_frames", "write_file"])]
