"""A key is checked before it is saved (design iteration 1.57).

A key typed with a server's URL, as a key pasted for a company, is saved only
once the provider lists its models with it; a refused key never replaces the
saved one. A check that gets no answer, or a refusal the analyst overrides,
can save the key marked as not checked, and the next answer that uses it
clears the mark or says that the key is wrong. A fake HTTP client stands in
for the providers and the servers: no request leaves the process.
"""

import json
import logging
import os

import pytest
from tornado.httpclient import HTTPClientError
from tornado.simple_httpclient import HTTPTimeoutError

from whybook.server import connection, model_client, providers
from whybook.server.config import Whybook
from whybook.server.connection import Connection
from whybook.server.keystore import KeyStore
from whybook.server.routes import connection_state

GPU = "http://gpu-server:8000/v1"
VLLM = "http://localhost:8000/v1"
SERVER_MODELS = {"data": [{"id": "llama-3.3-70b"}, {"id": "qwen3-32b"}, {"id": "qwen3-coder-30b"}]}
MISTRAL_MODELS = {"object": "list", "data": [{"id": "mistral-medium-latest", "capabilities": {"completion_chat": True, "function_calling": True}}]}


class Response:
    def __init__(self, body):
        self.code = 200
        self.body = json.dumps(body).encode()


class Provider:
    """In place of tornado's AsyncHTTPClient: each URL lists its models for the keys it takes, and answers HTTP 401 to the others.

    A URL it does not serve refuses the connection; one in ``slow`` times out
    as tornado does, and one in ``failing`` answers with that HTTP error. It
    keeps the URL and the key of each request.
    """

    def __init__(self):
        self.lists = {}
        self.slow = set()
        self.failing = {}
        self.sent = []

    def serve(self, url, body, *keys, anyone=False):
        """Answer ``url`` with ``body`` for these keys (None for a request without one), or for any key."""
        self.lists[url] = (None if anyone else set(keys), body)

    async def fetch(self, url, **options):
        headers = options.get("headers") or {}
        key = headers.get("Authorization", "").removeprefix("Bearer ") or headers.get("x-api-key") or headers.get("x-goog-api-key") or None
        self.sent.append((url, key))
        if url in self.slow:
            raise HTTPTimeoutError("Timeout during request")
        if url in self.failing:
            raise HTTPClientError(self.failing[url])
        if url not in self.lists:
            raise ConnectionRefusedError(111, "Connection refused")
        keys, body = self.lists[url]
        if keys is not None and key not in keys:
            raise HTTPClientError(401)
        return Response(body)


@pytest.fixture
def provider(monkeypatch):
    fake = Provider()
    monkeypatch.setattr(providers, "AsyncHTTPClient", lambda: fake)
    return fake


async def post(jp_fetch, *path, **body):
    """POST a body to a route of Whybook: the status and the JSON answer."""
    try:
        response = await jp_fetch("whybook", *path, method="POST", body=json.dumps(body))
    except HTTPClientError as error:
        return error.code, json.loads(error.response.body)
    return response.code, json.loads(response.body)


def entry(state, provider_id):
    [found] = [item for item in state["providers"] if item["id"] == provider_id]
    return found


async def test_a_typed_key_that_the_server_refuses_leaves_the_saved_key_in_use(jp_fetch, provider):
    provider.serve(f"{GPU}/models", SERVER_MODELS, "good-key")
    code, state = await post(jp_fetch, "connection", provider="openai-compatible", model="qwen3-32b", base_url=GPU, key="good-key")
    assert code == 200 and state["connection"]["model"] == "qwen3-32b"
    saved = KeyStore().meta(f"openai-compatible {GPU}")["saved"]
    code, answer = await post(jp_fetch, "connection", provider="openai-compatible", model="llama-3.3-70b", base_url=GPU, key="a-typo")
    assert code == 409
    assert answer == {"message": f"The server at {GPU} refused this key (HTTP 401)", "check": "refused", "saved": saved}
    # Nothing changed: the key that worked, and the model that uses it.
    assert KeyStore().get(f"openai-compatible {GPU}") == "good-key"
    assert connection.load().model == "qwen3-32b"


async def test_the_models_of_a_new_server_are_listed_with_the_typed_key_and_nothing_is_saved(jp_fetch, provider):
    provider.serve(f"{GPU}/models", SERVER_MODELS, "good-key")
    code, answer = await post(jp_fetch, "connection", "models", provider="openai-compatible", base_url=GPU, key="good-key")
    assert code == 200
    assert [model["id"] for model in answer["models"]] == ["llama-3.3-70b", "qwen3-32b", "qwen3-coder-30b"]
    assert (answer["key_check"], answer["saved"]) == ("accepted", None)
    # With the key, then once without it: this server refuses a request without a key, so it needs one.
    assert provider.sent == [(f"{GPU}/models", "good-key"), (f"{GPU}/models", None)]
    assert not os.path.exists(KeyStore().path) and not os.path.exists(connection.connection_path())
    code, answer = await post(jp_fetch, "connection", "models", provider="openai-compatible", base_url=GPU, key="a-typo")
    assert (code, answer) == (409, {"message": f"The server at {GPU} refused this key (HTTP 401)", "check": "refused", "saved": None})
    # Use this model then saves the key with that URL, and the connection, together.
    code, state = await post(jp_fetch, "connection", provider="openai-compatible", model="qwen3-32b", base_url=GPU, key="good-key", local=True)
    assert code == 200 and state["connection"] == {"provider": "openai-compatible", "model": "qwen3-32b", "base_url": GPU, "local": True}
    assert KeyStore().get(f"openai-compatible {GPU}") == "good-key"
    assert state["connected_key"] == {"saved": KeyStore().meta(f"openai-compatible {GPU}")["saved"], "checked": True, "refused": None}
    # A company's key is pasted for its row, not typed with a URL.
    code, answer = await post(jp_fetch, "connection", "models", provider="mistral", key="k")
    assert code == 400


async def test_a_server_that_asks_for_no_key_does_not_get_one_saved(jp_fetch, provider):
    # vLLM started without --api-key lists its models whatever key comes with the request.
    provider.serve(f"{VLLM}/models", SERVER_MODELS, anyone=True)
    code, answer = await post(jp_fetch, "connection", "models", provider="vllm", base_url=VLLM, key="some-key")
    assert code == 200 and answer["key_check"] == "not needed"
    code, state = await post(jp_fetch, "connection", provider="vllm", model="qwen3-32b", base_url=VLLM, key="some-key")
    assert code == 200 and state["connection"]["provider"] == "vllm"
    assert KeyStore().get(f"vllm {VLLM}") is None and state["connected_key"] is None


async def test_a_refused_pasted_key_names_the_http_code_and_keeps_the_saved_key(jp_fetch, provider):
    provider.serve(providers.MISTRAL_MODELS, MISTRAL_MODELS, "good-key")
    code, state = await post(jp_fetch, "auth", "key", provider="mistral", key="good-key")
    assert code == 200 and entry(state, "mistral")["checked"] is True
    saved = KeyStore().meta("mistral")["saved"]
    assert entry(state, "mistral")["saved"] == saved
    code, answer = await post(jp_fetch, "auth", "key", provider="mistral", key="a-typo")
    assert (code, answer) == (409, {"message": "Mistral AI refused this key (HTTP 401)", "check": "refused", "saved": saved})
    assert KeyStore().get("mistral") == "good-key"


async def test_a_check_that_gets_no_answer_saves_nothing_and_says_so(jp_fetch, provider):
    provider.slow.add(providers.MISTRAL_MODELS)
    code, answer = await post(jp_fetch, "auth", "key", provider="mistral", key="mistral-key")
    assert (code, answer) == (409, {"message": "api.mistral.ai did not answer in 15 s", "check": "unchecked", "saved": None})
    # A provider that the server cannot reach, and one that answers with an error of its own.
    provider.slow.clear()
    code, answer = await post(jp_fetch, "auth", "key", provider="mistral", key="mistral-key")
    assert (code, answer["message"], answer["check"]) == (409, "api.mistral.ai could not be reached: Connection refused", "unchecked")
    provider.failing[providers.MISTRAL_MODELS] = 503
    code, answer = await post(jp_fetch, "auth", "key", provider="mistral", key="mistral-key")
    assert (code, answer["message"], answer["check"]) == (409, "Mistral AI answered HTTP 503", "unchecked")
    assert KeyStore().get("mistral") is None
    # A server that does not answer the check of a typed key.
    code, answer = await post(jp_fetch, "connection", "models", provider="openai-compatible", base_url=GPU, key="gpu-key")
    assert (code, answer["check"]) == (409, "unchecked")
    assert answer["message"] == f"An OpenAI-compatible server: nothing answered at {GPU}: is the server running?"


async def test_save_anyway_keeps_the_key_marked_as_not_checked(jp_fetch, provider):
    code, state = await post(jp_fetch, "auth", "key", provider="mistral", key="new-key", check=False)
    assert code == 200 and provider.sent == []
    assert (entry(state, "mistral")["signed_in"], entry(state, "mistral")["checked"], entry(state, "mistral")["refused"]) == (True, False, None)
    assert KeyStore().get("mistral") == "new-key"
    # A key typed with a server's URL goes with the connection: both saved, and no request sent.
    code, state = await post(jp_fetch, "connection", provider="openai-compatible", model="qwen3-32b", base_url=GPU, key="gpu-key", check=False)
    assert code == 200 and provider.sent == []
    assert state["connection"]["model"] == "qwen3-32b"
    assert state["connected_key"] == {"saved": KeyStore().meta(f"openai-compatible {GPU}")["saved"], "checked": False, "refused": None}
    # Without a typed key there is no key to save anyway: the model is checked as before.
    code, answer = await post(jp_fetch, "connection", provider="mistral", model="mistral-medium-latest", check=False)
    assert code == 409 and answer["check"] == "unchecked" and provider.sent == [(providers.MISTRAL_MODELS, "new-key")]


async def test_a_listing_with_the_saved_key_checks_it(jp_fetch, provider):
    KeyStore().set("mistral", "new-key", signin="typed", checked=False)
    code, answer = await post(jp_fetch, "connection", "models", provider="mistral")
    assert code == 409 and answer["message"] == "api.mistral.ai could not be reached: Connection refused"
    assert KeyStore().meta("mistral")["checked"] is False
    provider.serve(providers.MISTRAL_MODELS, MISTRAL_MODELS, "other-key")
    code, answer = await post(jp_fetch, "connection", "models", provider="mistral")
    assert (code, answer["message"], answer["check"]) == (409, "Mistral AI refused the saved key (HTTP 401)", "refused")
    refused = KeyStore().meta("mistral")["refused"]
    assert refused is not None
    provider.serve(providers.MISTRAL_MODELS, MISTRAL_MODELS, "new-key")
    code, answer = await post(jp_fetch, "connection", "models", provider="mistral")
    assert code == 200 and [model["id"] for model in answer["models"]] == ["mistral-medium-latest"]
    meta = KeyStore().meta("mistral")
    assert "checked" not in meta and "refused" not in meta


async def test_an_answer_with_the_key_clears_the_mark_and_a_refusal_says_the_key_is_wrong(monkeypatch):
    config = Whybook()
    KeyStore().set("mistral", "new-key", signin="typed", checked=False)
    connection.save(Connection.from_json({"provider": "mistral", "model": "mistral-medium-latest"}))
    outcomes = []

    async def call(chosen, key, prompt, **options):
        assert key == "new-key"
        yield outcomes.pop(0)

    monkeypatch.setattr(model_client, "structured_call", call)
    monkeypatch.setattr(model_client, "is_installed", lambda provider=None: True)

    async def answer():
        return [event async for event in connection.structured_call("p", schema={}, system_prompt="s", config=config, effort="low")]

    outcomes.append({"type": "error", "message": "No AI model answered: Mistral AI: mistral-medium-latest refused the key. Paste a new key in the AI models panel.", "key_refused": True})
    [event] = await answer()
    # The flag goes no further than the server.
    assert event == {"type": "error", "message": "No AI model answered: Mistral AI: mistral-medium-latest refused the key. Paste a new key in the AI models panel."}
    state = connection_state(config)
    assert entry(state, "mistral")["refused"] is not None and state["connected_key"]["refused"] == entry(state, "mistral")["refused"]
    outcomes.append({"type": "result", "output": {}, "model": "mistral-medium-latest"})
    await answer()
    state = connection_state(config)
    assert (entry(state, "mistral")["checked"], entry(state, "mistral")["refused"]) == (True, None)

    # An agent's run: a refusal marks the key, and a run that ends clears the mark.
    runs = []

    def driver(chosen, key, tools):
        async def drive(run, request, config):
            if runs.pop(0) == "refused":
                raise model_client.KeyRefusedError("No AI model answered: Mistral AI refused the key.")
            return {"type": "result", "answer": "Yes."}

        return drive

    monkeypatch.setattr(model_client, "agent_driver", driver)
    runs.append("refused")
    with pytest.raises(model_client.KeyRefusedError):
        await connection.agent_driver(config)(None, None, config)
    assert KeyStore().meta("mistral")["refused"] is not None
    runs.append("done")
    assert (await connection.agent_driver(config)(None, None, config))["answer"] == "Yes."
    assert "refused" not in KeyStore().meta("mistral")


async def test_a_mark_stays_when_the_key_changed_during_the_call(monkeypatch):
    KeyStore().set("mistral", "old-key", signin="typed")
    connection.save(Connection.from_json({"provider": "mistral", "model": "mistral-medium-latest"}))

    async def call(chosen, key, prompt, **options):
        # The analyst saves a new key without a check while the old one answers.
        KeyStore().set("mistral", "new-key", signin="typed", checked=False)
        yield {"type": "result", "output": {}, "model": "mistral-medium-latest"}

    monkeypatch.setattr(model_client, "structured_call", call)
    monkeypatch.setattr(model_client, "is_installed", lambda provider=None: True)
    [event async for event in connection.structured_call("p", schema={}, system_prompt="s", config=Whybook(), effort="low")]
    assert KeyStore().meta("mistral")["checked"] is False


def test_a_refused_call_is_flagged_for_the_server():
    assert model_client.key_refused("status_code: 401, model_name: x, body: {'error': 'invalid key'}")
    assert model_client.key_refused("Error code: 400 - API key not valid. Please pass a valid API key.")
    assert not model_client.key_refused("status_code: 429, body: rate limit")


SECRET = "sk-gpu-SECRETPART-42"


async def test_no_answer_and_no_log_line_holds_the_key(jp_fetch, provider, caplog):
    caplog.set_level(logging.DEBUG)
    provider.serve(f"{GPU}/models", SERVER_MODELS, "good-key")
    provider.slow.add(providers.MISTRAL_MODELS)
    answers = [
        await post(jp_fetch, "connection", "models", provider="openai-compatible", base_url=GPU, key=SECRET),
        await post(jp_fetch, "connection", provider="openai-compatible", model="qwen3-32b", base_url=GPU, key=SECRET),
        await post(jp_fetch, "auth", "key", provider="mistral", key=SECRET),
        await post(jp_fetch, "connection", "models", provider="openai-compatible", base_url="http://other:1/v1", key=SECRET),
    ]
    assert [(code, answer["check"]) for code, answer in answers] == [(409, "refused"), (409, "refused"), (409, "unchecked"), (409, "unchecked")]
    code, state = await post(jp_fetch, "connection", provider="openai-compatible", model="qwen3-32b", base_url=GPU, key=SECRET, check=False)
    assert code == 200 and KeyStore().get(f"openai-compatible {GPU}") == SECRET
    assert "SECRETPART" not in json.dumps([answers, state])
    assert not [record.getMessage() for record in caplog.records if "SECRETPART" in record.getMessage()]


async def test_the_words_of_a_check_name_who_answered_and_how(provider):
    provider.failing[providers.GOOGLE_MODELS] = 400
    with pytest.raises(providers.KeyRefused, match=r"^Google Gemini refused this key \(HTTP 400\)$"):
        await providers.check_key("google", "wrong")
    provider.failing[providers.HUGGINGFACE_WHOAMI] = 401
    with pytest.raises(providers.KeyRefused, match=r"^Hugging Face refused this key \(HTTP 401\)$"):
        await providers.check_key("huggingface", "hf_wrong")
    provider.slow.add(providers.HUGGINGFACE_WHOAMI)
    with pytest.raises(providers.NotChecked, match="^huggingface.co did not answer in 15 s$"):
        await providers.check_key("huggingface", "hf_x")
    provider.failing[providers.ANTHROPIC_MODELS] = 404
    with pytest.raises(providers.ProviderError, match="^Anthropic answered HTTP 404$") as error:
        await providers.check_key("anthropic", "sk-ant-x")
    assert error.value.check is None
    provider.serve(f"{VLLM}/models", SERVER_MODELS, "vllm-key")
    with pytest.raises(providers.KeyRefused, match=r"^vLLM refused this key \(HTTP 401\)$"):
        await providers.models("vllm", key="wrong", base_url=VLLM, typed=True)
