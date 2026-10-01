"""Sign-in from the AI models panel: OpenRouter with PKCE, Hugging Face with a device code, pasted keys, and the routes.

A fake fetch answers for openrouter.ai, huggingface.co and the model
companies: no request leaves the process, and no account is needed.
"""

import asyncio
import json
import logging
import os
import time
import types
from urllib.parse import parse_qs, urlparse

import pytest
from tornado.httpclient import HTTPClientError
from tornado.simple_httpclient import HTTPTimeoutError

from whybook.server import providers, signin
from whybook.server.keystore import KeyStore


class Response:
    def __init__(self, code, body):
        self.code = code
        self.body = json.dumps(body).encode()


def fake_fetch(answers, sent):
    """A fetch that records each request and answers in turn."""

    async def fetch(url, **options):
        sent.append((url, options))
        return answers.pop(0)

    return fetch


def test_the_challenge_is_the_s256_of_the_verifier():
    # The example of RFC 7636, appendix B.
    assert signin.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"


@pytest.mark.parametrize(
    "callback, mode",
    [
        ("http://localhost:8888/whybook/auth/openrouter/callback", "callback"),
        ("http://127.0.0.1:9000/lab/whybook/auth/openrouter/callback", "callback"),
        ("https://hub.example.org/user/alice/whybook/auth/openrouter/callback", "callback"),
        # OpenRouter takes no other http callback: the analyst pastes the code.
        ("http://hub.example.org/user/alice/whybook/auth/openrouter/callback", "code"),
        (None, "code"),
    ],
)
def test_the_sign_in_comes_back_to_the_server_where_openrouter_allows(callback, mode):
    started = signin.openrouter_start(callback)
    assert started["mode"] == mode
    query = parse_qs(urlparse(started["url"]).query)
    flow = signin.OPENROUTER_FLOWS[started["state"]]
    assert query["code_challenge"] == [signin.challenge(flow.verifier)]
    assert query["code_challenge_method"] == ["S256"]
    if mode == "callback":
        assert query["callback_url"] == [f"{callback}/{started['state']}"]
    else:
        assert "callback_url" not in query
    # The verifier never leaves the server.
    assert flow.verifier not in started["url"]


async def test_the_code_is_exchanged_once_for_a_key_that_the_store_keeps():
    started = signin.openrouter_start(None)
    sent = []
    fetch = fake_fetch([Response(200, {"key": "sk-or-v1-abc", "user_id": "user_1"})], sent)
    assert await signin.openrouter_exchange(started["state"], " the-code ", fetch=fetch) == {"ok": True}
    [(url, options)] = sent
    assert url == signin.OPENROUTER_EXCHANGE and options["method"] == "POST"
    body = json.loads(options["body"])
    assert body["code"] == "the-code" and body["code_challenge_method"] == "S256" and body["code_verifier"]
    assert KeyStore().get("openrouter") == "sk-or-v1-abc"
    assert KeyStore().meta("openrouter")["user_id"] == "user_1"
    with pytest.raises(signin.SignInError, match="expired or was used"):
        await signin.openrouter_exchange(started["state"], "the-code", fetch=fetch)


async def test_a_refused_code_keeps_no_key():
    started = signin.openrouter_start(None)
    fetch = fake_fetch([Response(403, {"error": {"message": "Invalid code"}})], [])
    with pytest.raises(signin.SignInError, match=r"HTTP 403: Invalid code"):
        await signin.openrouter_exchange(started["state"], "bad", fetch=fetch)
    assert KeyStore().get("openrouter") is None


async def test_hugging_face_needs_the_client_id_of_whybooks_own_app():
    with pytest.raises(signin.SignInError, match="c.Whybook.huggingface_client_id"):
        await signin.huggingface_start("")


async def test_the_hugging_face_device_code_is_polled_until_the_token_comes():
    approve = "https://huggingface.co/oauth/device?user_code=WDJB-MJHT"
    answers = [
        Response(200, {"device_code": "dev-1", "user_code": "WDJB-MJHT", "verification_uri": "https://huggingface.co/oauth/device", "verification_uri_complete": approve, "expires_in": 900, "interval": 5}),
        Response(400, {"error": "authorization_pending"}),
        Response(502, {}),  # a gateway's answer: pending, as huggingface_hub takes it
        Response(400, {"error": "slow_down"}),
        Response(200, {"access_token": "hf_oauth_token", "refresh_token": "hf_refresh", "expires_in": 28800, "scope": "openid inference-api"}),
    ]
    sent: list = []
    fetch = fake_fetch(answers, sent)
    started = await signin.huggingface_start("whybook-app", fetch=fetch)
    assert (started["user_code"], started["verification_uri_complete"], started["interval"]) == ("WDJB-MJHT", approve, 5)
    assert "dev-1" not in json.dumps(started)  # the device code stays on the server
    assert await signin.huggingface_poll(started["flow"], "whybook-app", fetch=fetch) == {"status": "pending", "interval": 5}
    assert await signin.huggingface_poll(started["flow"], "whybook-app", fetch=fetch) == {"status": "pending", "interval": 5}
    assert await signin.huggingface_poll(started["flow"], "whybook-app", fetch=fetch) == {"status": "pending", "interval": 10}
    assert await signin.huggingface_poll(started["flow"], "whybook-app", fetch=fetch) == {"status": "done"}
    keys = KeyStore()
    assert keys.get("huggingface") == "hf_oauth_token" and keys.get("huggingface", "refresh_token") == "hf_refresh"
    meta = keys.meta("huggingface")
    assert meta["signin"] == "huggingface" and "refresh_token" not in meta and meta["expires_at"] > time.time() + 28000
    assert sent[0][0] == "https://huggingface.co/oauth/device" and parse_qs(sent[0][1]["body"]) == {"client_id": ["whybook-app"]}
    token_request = parse_qs(sent[-1][1]["body"])
    assert sent[-1][0] == "https://huggingface.co/oauth/token"
    assert token_request == {"grant_type": ["urn:ietf:params:oauth:grant-type:device_code"], "device_code": ["dev-1"], "client_id": ["whybook-app"]}
    assert await signin.huggingface_poll(started["flow"], "whybook-app", fetch=fetch) == {"status": "expired"}


async def test_a_denied_hugging_face_sign_in_keeps_no_token():
    answers = [
        Response(200, {"device_code": "dev-2", "user_code": "ABCD-EFGH", "expires_in": 900, "interval": 5}),
        Response(400, {"error": "access_denied"}),
    ]
    fetch = fake_fetch(answers, [])
    started = await signin.huggingface_start("whybook-app", fetch=fetch)
    assert started["verification_uri"] == "https://huggingface.co/oauth/device" and started["verification_uri_complete"] is None
    assert await signin.huggingface_poll(started["flow"], "whybook-app", fetch=fetch) == {"status": "denied"}
    assert KeyStore().get("huggingface") is None


async def test_the_hugging_face_token_is_renewed_before_it_expires():
    keys = KeyStore()
    keys.set("huggingface", "hf_old", signin="huggingface", expires_at=time.time() + 30, refresh_token="hf_refresh")
    sent: list = []
    fetch = fake_fetch([Response(200, {"access_token": "hf_new", "refresh_token": "hf_refresh_2", "expires_in": 28800})], sent)
    assert await signin.huggingface_token("whybook-app", keys, fetch=fetch) == "hf_new"
    assert parse_qs(sent[0][1]["body"]) == {"grant_type": ["refresh_token"], "refresh_token": ["hf_refresh"], "client_id": ["whybook-app"]}
    assert keys.get("huggingface", "refresh_token") == "hf_refresh_2"
    # A token with hours left goes as it is, and so does a pasted token, which has no expiry here.
    assert await signin.huggingface_token("whybook-app", keys, fetch=fake_fetch([], [])) == "hf_new"
    keys.set("huggingface", "hf_pasted", signin="typed")
    assert await signin.huggingface_token("", keys, fetch=fake_fetch([], [])) == "hf_pasted"


async def test_a_refused_renewal_forgets_the_token_and_asks_for_a_sign_in():
    keys = KeyStore()
    keys.set("huggingface", "hf_old", signin="huggingface", expires_at=time.time() - 5, refresh_token="hf_refresh")
    with pytest.raises(signin.SignInError, match="has expired. Sign in again"):
        await signin.huggingface_token("whybook-app", keys, fetch=fake_fetch([Response(400, {"error": "invalid_grant"})], []))
    assert keys.get("huggingface") is None
    # Without the app's client id, an expired token cannot be renewed either.
    keys.set("huggingface", "hf_old", signin="huggingface", expires_at=time.time() - 5, refresh_token="hf_refresh")
    with pytest.raises(signin.SignInError, match="has expired"):
        await signin.huggingface_token("", keys)


class FakeClient:
    """In place of tornado's AsyncHTTPClient for the routes: answers in turn."""

    answers: list = []
    sent: list = []

    async def fetch(self, url, **options):
        FakeClient.sent.append((url, options))
        answer = FakeClient.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


@pytest.fixture
def fake_http(monkeypatch):
    FakeClient.answers, FakeClient.sent = [], []
    monkeypatch.setattr(signin, "AsyncHTTPClient", FakeClient)
    return FakeClient


async def test_the_routes_sign_in_with_openrouter_by_callback_and_by_code(jp_fetch, fake_http):
    started = json.loads(
        (await jp_fetch("whybook", "auth", "openrouter", method="POST", body=json.dumps({"callback_base": "http://localhost:8888/whybook/auth/openrouter/callback"}))).body
    )
    assert started["mode"] == "callback"
    fake_http.answers = [Response(200, {"key": "sk-or-v1-one", "user_id": "u"})]
    page = await jp_fetch("whybook", "auth", "openrouter", "callback", started["state"], params={"code": "c1"})
    assert b"Signed in to OpenRouter" in page.body and page.headers["Content-Type"].startswith("text/html")
    state = json.loads((await jp_fetch("whybook", "connection")).body)
    [openrouter] = [provider for provider in state["providers"] if provider["id"] == "openrouter"]
    assert openrouter["signed_in"] is True and "sk-or-v1-one" not in json.dumps(state)
    # The same state again fails, and says so in the page.
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "auth", "openrouter", "callback", started["state"], params={"code": "c1"})
    assert error.value.code == 409
    # A pasted code, for a server that OpenRouter cannot send the browser back to.
    started = json.loads((await jp_fetch("whybook", "auth", "openrouter", method="POST", body=json.dumps({"callback_base": None}))).body)
    assert started["mode"] == "code"
    fake_http.answers = [Response(200, {"key": "sk-or-v1-two", "user_id": "u"})]
    await jp_fetch("whybook", "auth", "openrouter", "code", method="POST", body=json.dumps({"state": started["state"], "code": "c2"}))
    assert KeyStore().get("openrouter") == "sk-or-v1-two"
    state = json.loads((await jp_fetch("whybook", "auth", "signout", method="POST", body=json.dumps({"provider": "openrouter"}))).body)
    assert KeyStore().get("openrouter") is None
    assert [provider["signed_in"] for provider in state["providers"] if provider["id"] == "openrouter"] == [False]


async def test_the_hugging_face_route_says_how_to_set_up_the_app(jp_fetch, monkeypatch):
    monkeypatch.delenv("WHYBOOK_HUGGINGFACE_CLIENT_ID", raising=False)
    state = json.loads((await jp_fetch("whybook", "connection")).body)
    assert state["huggingface_signin"] is False
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "auth", "huggingface", method="POST", body="{}")
    assert error.value.code == 409
    assert "c.Whybook.huggingface_client_id" in json.loads(error.value.response.body)["message"]


@pytest.fixture
def fake_providers(monkeypatch):
    FakeClient.answers, FakeClient.sent = [], []
    monkeypatch.setattr(providers, "AsyncHTTPClient", FakeClient)
    return FakeClient


async def test_a_pasted_key_is_checked_at_no_cost_then_kept(jp_fetch, fake_providers):
    fake_providers.answers = [Response(200, {"data": [{"id": "claude-sonnet-5", "display_name": "Claude Sonnet 5"}]})]
    state = json.loads((await jp_fetch("whybook", "auth", "key", method="POST", body=json.dumps({"provider": "anthropic", "key": " sk-ant-1 "}))).body)
    [anthropic] = [provider for provider in state["providers"] if provider["id"] == "anthropic"]
    assert anthropic["signed_in"] is True and anthropic["key_from"] == "typed" and "sk-ant-1" not in json.dumps(state)
    assert KeyStore().get("anthropic") == "sk-ant-1"
    url, options = fake_providers.sent[0]
    assert url == "https://api.anthropic.com/v1/models?limit=1000" and options["headers"]["x-api-key"] == "sk-ant-1"
    # A key that the company refuses is not kept.
    fake_providers.answers = [HTTPClientError(401)]
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "auth", "key", method="POST", body=json.dumps({"provider": "mistral", "key": "wrong"}))
    assert error.value.code == 409
    assert json.loads(error.value.response.body) == {"message": "Mistral AI refused this key (HTTP 401)", "check": "refused", "saved": None}
    assert KeyStore().get("mistral") is None
    # A Hugging Face token is checked with whoami.
    fake_providers.answers = [Response(200, {"name": "analyst"})]
    await jp_fetch("whybook", "auth", "key", method="POST", body=json.dumps({"provider": "huggingface", "key": "hf_pasted"}))
    assert fake_providers.sent[-1][0] == "https://huggingface.co/api/whoami-v2" and KeyStore().get("huggingface") == "hf_pasted"
    for body in ({"provider": "openrouter", "key": "k"}, {"provider": "anthropic", "key": " "}):
        with pytest.raises(HTTPClientError) as error:
            await jp_fetch("whybook", "auth", "key", method="POST", body=json.dumps(body))
        assert error.value.code == 400


# A key pasted from wrapped text: tornado refuses a header line with a line break,
# and puts the whole line, the key with it, in its error.
BROKEN = "sk-ant-api03-SECRETPART1\nSECRETPART2"


async def test_a_key_with_a_line_break_is_refused_without_repeating_it(jp_fetch, fake_providers, caplog):
    caplog.set_level(logging.DEBUG)
    for path, body in [
        (("auth", "key"), {"provider": "anthropic", "key": BROKEN}),
        (("connection",), {"provider": "vllm", "model": "qwen3-8b", "key": BROKEN}),
        (("connection",), {"provider": "vllm", "model": "qwen3-8b", "key": "vllm key"}),
    ]:
        with pytest.raises(HTTPClientError) as error:
            await jp_fetch("whybook", *path, method="POST", body=json.dumps(body))
        message = json.loads(error.value.response.body)["message"]
        assert error.value.code == 400 and message == "The key has a line break, a space or another character that keys do not have. Copy it again."
    assert fake_providers.sent == []
    assert not [record.getMessage() for record in caplog.records if "SECRETPART" in record.getMessage()]
    # No key was kept, the typed one of a server included.
    assert not os.path.exists(KeyStore().path)


async def test_a_key_that_no_request_can_carry_does_not_come_back_in_the_message(monkeypatch, caplog):
    async def accept(reader, writer):
        await asyncio.sleep(0.5)
        writer.close()

    server = await asyncio.start_server(accept, "127.0.0.1", 0)
    monkeypatch.setattr(providers, "ANTHROPIC_MODELS", f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}/v1/models")
    caplog.set_level(logging.DEBUG)
    try:
        # check_key on its own: the route refuses such a key first.
        for key in (BROKEN, "sk-ant-api03-SECRETPART1…"):
            with pytest.raises(providers.ProviderError) as error:
                await providers.check_key("anthropic", key)
            assert "SECRETPART" not in str(error.value), str(error.value)
            assert error.value.__suppress_context__ or error.value.__cause__ is None
    finally:
        server.close()
    assert not [record.getMessage() for record in caplog.records if "SECRETPART" in record.getMessage()]


async def timed_out(*args, **kwargs):
    """tornado's answer to a request that passes its request_timeout, also with raise_error=False: not an OSError."""
    raise HTTPTimeoutError("Timeout during request")


async def test_a_sign_in_that_times_out_says_so_in_the_panel(jp_fetch, monkeypatch):
    with pytest.raises(signin.SignInError, match="Hugging Face did not answer in time"):
        await signin.huggingface_start("whybook-app", fetch=timed_out)
    flow = signin.DeviceFlow(id="f1", device_code="d", interval=5, deadline=time.monotonic() + 600)
    monkeypatch.setitem(signin.DEVICE_FLOWS, "f1", flow)
    with pytest.raises(signin.SignInError, match="Hugging Face did not answer in time"):
        await signin.huggingface_poll("f1", "whybook-app", fetch=timed_out)
    started = signin.openrouter_start(None)
    with pytest.raises(signin.SignInError, match="OpenRouter did not answer in time"):
        await signin.openrouter_exchange(started["state"], "the-code", fetch=timed_out)
    # The routes answer 409 with the words, where they answered 500.
    monkeypatch.setattr(signin, "AsyncHTTPClient", lambda: types.SimpleNamespace(fetch=timed_out))
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "auth", "huggingface", "poll", method="POST", body=json.dumps({"flow": "f1"}))
    assert error.value.code == 409
    assert json.loads(error.value.response.body)["message"] == "Hugging Face did not answer in time: try again."


async def test_a_renewal_that_times_out_ends_the_call_with_an_error_event(monkeypatch):
    from whybook.server import connection
    from whybook.server.config import Whybook

    KeyStore().set("huggingface", "hf_old", signin="huggingface", expires_at=time.time() + 60, refresh_token="r1")
    connection.save(connection.Connection.from_json({"provider": "huggingface", "model": "Qwen/Qwen3-8B:ovhcloud"}))
    monkeypatch.setattr(signin, "AsyncHTTPClient", lambda: types.SimpleNamespace(fetch=timed_out))
    events = [event async for event in connection.structured_call("p", schema={"type": "object"}, system_prompt="s", config=Whybook(huggingface_client_id="whybook-app"), effort="low")]
    assert events == [{"type": "error", "message": "No AI model answered: Hugging Face did not answer in time: try again."}]
