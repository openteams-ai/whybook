"""What the view says when a provider refuses a call with HTTP 429 or 403: the provider's own words.

The words come from the error that Pydantic AI raises, as the server log
holds it; the messages below are copied from the log of the model spike of
1 October 2026, or written in each company's documented format. A FunctionModel
stands in for the model: no request leaves the process.
"""

import pytest

from whybook.server import connection, model_client
from whybook.server.config import Whybook
from whybook.server.connection import Connection
from whybook.server.keystore import KeyStore

LUNA = "OpenRouter: openai/gpt-6-luna"
# As the server log of the model spike holds it.
UPSTREAM_429 = (
    "status_code: 429, model_name: mistralai/mistral-small-2603, body: {'message': 'Provider returned error', 'code': 429, "
    "'metadata': {'raw': 'mistralai/mistral-small-2603 is temporarily rate-limited upstream. Please retry shortly, or add "
    "your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations', 'provider_name': 'Mistral', "
    "'is_byok': False, 'limit_source': 'upstream_provider_shared_pool'}}"
)
STREAMED_429 = (
    "openai/gpt-6-luna is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your "
    "rate limits: https://openrouter.ai/settings/integrations"
)
# OpenRouter's moderation, which answers 403 for a flagged prompt.
MODERATION_403 = (
    "status_code: 403, model_name: openai/gpt-6-luna, body: {'message': 'openai/gpt-6-luna requires moderation on Azure. "
    "Your input was flagged for \"violence\".', 'code': 403, 'metadata': {'reasons': ['violence'], 'provider_name': 'Azure'}}"
)
# Anthropic's own API.
ANTHROPIC_429 = (
    "status_code: 429, model_name: claude-sonnet-5, body: {'type': 'error', 'error': {'type': 'rate_limit_error', "
    "'message': 'Number of request tokens has exceeded your per-minute rate limit'}}"
)


def test_a_refusal_shows_the_provider_s_words():
    said = model_client.reason(UPSTREAM_429, "OpenRouter: mistralai/mistral-small-2603", None, Whybook())
    assert said == (
        "No AI model answered: OpenRouter: mistralai/mistral-small-2603 refused the request (HTTP 429): Mistral: "
        "mistralai/mistral-small-2603 is temporarily rate-limited upstream. Please retry shortly, or add your own key to "
        "accumulate your rate limits: https://openrouter.ai/settings/integrations."
    )
    assert "spending limit" not in said
    # In a stream, the refusal comes as the words alone.
    assert model_client.reason(STREAMED_429, LUNA, None, Whybook()) == f"No AI model answered: {LUNA} refused the request: {STREAMED_429}."
    assert model_client.reason(ANTHROPIC_429, "Anthropic: claude-sonnet-5", None, Whybook()).endswith(
        "refused the request (HTTP 429): Number of request tokens has exceeded your per-minute rate limit."
    )
    # Without words, what the code means.
    bare = model_client.reason("status_code: 429, model_name: m, body: {}", LUNA, None, Whybook())
    assert bare.endswith("(HTTP 429: a rate limit, or the account's spending limit). Wait, or check the account's limits.")


def test_a_refusal_with_http_403_shows_its_words_and_leaves_the_key_alone():
    said = model_client.reason(MODERATION_403, LUNA, None, Whybook())
    assert said == (
        f'No AI model answered: {LUNA} refused the request (HTTP 403): Azure: openai/gpt-6-luna requires moderation on '
        'Azure. Your input was flagged for "violence".'
    )
    assert not model_client.key_refused(MODERATION_403)
    # A refused key still says so, with its 401.
    assert model_client.key_refused("status_code: 401, model_name: x, body: {'error': 'invalid key'}")


def test_the_words_hold_no_key_and_stay_short():
    leaky = "status_code: 403, model_name: m, body: {'message': 'The key sk-or-v1-0123456789abcdef0123 has no access. " + "More. " * 120 + "'}"
    words = model_client.provider_words(leaky)
    assert "sk-or-v1" not in words and "[a key]" in words
    assert len(words) <= model_client.WORDS_CHARS and words.endswith("…")


async def test_a_call_that_a_provider_refuses_ends_with_its_words(monkeypatch):
    pytest.importorskip("pydantic_ai")
    from pydantic_ai.exceptions import ModelHTTPError
    from pydantic_ai.models.function import FunctionModel

    body = {"message": "Provider returned error", "code": 403, "metadata": {"raw": "Your input was flagged.", "provider_name": "Azure"}}

    async def refused(messages, info):
        raise ModelHTTPError(403, "openai/gpt-6-luna", body)
        yield ""

    model = FunctionModel(lambda messages, info: None, stream_function=refused, model_name="openai/gpt-6-luna")
    monkeypatch.setattr(model_client, "build_model", lambda chosen, key: model)
    connection.save(Connection(provider="openrouter", model="openai/gpt-6-luna"))
    KeyStore().set("openrouter", "sk-or-v1-test", signin="openrouter")
    options = {"schema": {"type": "object"}, "system_prompt": "s", "config": Whybook(), "effort": "low"}
    events = [event async for event in connection.structured_call("p", **options)]
    assert events[-1]["type"] == "error"
    assert events[-1]["message"] == f"No AI model answered: {LUNA} refused the request (HTTP 403): Azure: Your input was flagged."
    # The key is not marked as wrong.
    assert KeyStore().meta("openrouter").get("refused") is None
