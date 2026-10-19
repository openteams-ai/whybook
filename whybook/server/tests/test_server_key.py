"""A key typed for a model server can be forgotten (design iteration 1.133).

A key typed with a server's URL is kept under the provider and the URL
(``connection.key_name``), such as "vllm http://127.0.0.1:8000/v1". Without
the fix, ``auth/signout`` deleted a provider's key only, so such a key stayed
on the server after Sign out, and the panel had no Forget key for it.
"""

import json

import pytest
from tornado.httpclient import HTTPClientError

from whybook.server import connection
from whybook.server.keystore import KeyStore

SERVER = "http://127.0.0.1:8000/v1"
OTHER = "http://gpu-server:8000/v1"


async def connect(jp_fetch, provider, base_url, key):
    """Save a connection with a key typed for the server, without a check: no request leaves the test."""
    body = {"provider": provider, "base_url": base_url, "model": "m", "key": key, "check": False}
    return json.loads((await jp_fetch("whybook", "connection", method="POST", body=json.dumps(body))).body)


async def sign_out(jp_fetch, body):
    return json.loads((await jp_fetch("whybook", "auth", "signout", method="POST", body=json.dumps(body))).body)


async def test_sign_out_with_a_servers_url_deletes_the_key_typed_for_it(jp_fetch):
    await connect(jp_fetch, "vllm", OTHER, "sk-other-0000000000000000")
    await connect(jp_fetch, "vllm", SERVER, "sk-typed-0000000000000000")
    assert KeyStore().get(f"vllm {SERVER}") == "sk-typed-0000000000000000"
    state = await sign_out(jp_fetch, {"provider": "vllm", "base_url": SERVER})
    assert KeyStore().get(f"vllm {SERVER}") is None
    assert state["connected_key"] is None
    # The server stays connected, and a key typed for another URL stays.
    assert state["connection"]["base_url"] == SERVER
    assert KeyStore().get(f"vllm {OTHER}") == "sk-other-0000000000000000"


async def test_sign_out_of_a_server_at_its_default_url_deletes_its_key(jp_fetch):
    default = connection.PROVIDERS["lmstudio"].base_url
    await connect(jp_fetch, "lmstudio", None, "sk-studio-0000000000000000")
    assert KeyStore().get(f"lmstudio {default}") == "sk-studio-0000000000000000"
    await sign_out(jp_fetch, {"provider": "lmstudio"})
    assert KeyStore().get(f"lmstudio {default}") is None


async def test_the_connected_models_key_names_the_url_it_was_typed_for(jp_fetch):
    # The panel learns that the key belongs to the server's URL, and never the key.
    state = await connect(jp_fetch, "openai-compatible", OTHER, "sk-typed-0000000000000000")
    assert state["connected_key"]["typed_for"] == OTHER and "sk-typed" not in json.dumps(state)
    # A provider's key belongs to no URL, and its sign out works as before.
    KeyStore().set("openrouter", "sk-or-v1-0000000000000000", signin="openrouter")
    connection.save(connection.Connection(provider="openrouter", model="z-ai/glm-5.3-flash"))
    state = json.loads((await jp_fetch("whybook", "connection")).body)
    assert state["connected_key"]["typed_for"] is None
    await sign_out(jp_fetch, {"provider": "openrouter"})
    assert KeyStore().get("openrouter") is None


@pytest.mark.parametrize(
    "body",
    [{"provider": "openai-compatible"}, {"provider": "openai-compatible", "base_url": "ftp://x"}, {"provider": "vllm", "base_url": 8000}],
)
async def test_sign_out_refuses_a_server_url_that_names_no_key(jp_fetch, body):
    with pytest.raises(HTTPClientError) as refused:
        await sign_out(jp_fetch, body)
    assert refused.value.code == 400
