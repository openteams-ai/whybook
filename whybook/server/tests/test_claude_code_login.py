"""A server without --Whybook.claude_code_login: the Claude Code login is neither listed nor saved.

The tests of the other modules offer it (conftest.py); this module turns it off, as a server does by default.
"""

import json

import pytest
from tornado.httpclient import HTTPClientError


@pytest.fixture
def jp_server_config(jp_server_config):
    return {**jp_server_config, "Whybook": {"claude_code_login": False}}


async def test_the_routes_neither_list_nor_save_the_claude_code_login(jp_fetch):
    state = json.loads((await jp_fetch("whybook", "connection")).body)
    assert [provider["id"] for provider in state["providers"]] == ["openrouter", "huggingface", "anthropic", "openai", "google", "mistral", "ollama", "lmstudio", "llamacpp", "vllm", "openai-compatible"]
    assert state["connection"]["provider"] == "none"
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "connection", method="POST", body=json.dumps({"provider": "claude-code", "model": None}))
    assert error.value.code == 400
    assert "--Whybook.claude_code_login=True" in json.loads(error.value.response.body)["message"]
    status = json.loads((await jp_fetch("whybook", "status")).body)
    assert (status["claude_available"], status["remote_model"]) == (False, None)
    assert status["claude"]["reason"] == "no model is connected"
