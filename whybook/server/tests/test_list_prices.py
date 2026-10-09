"""A model whose price genai-prices lacks, such as a model new on OpenRouter.

Its answers cost their tokens at OpenRouter's list price, which the list of
models carries, and its calls stop at the tokens that the cap pays for: before,
they had no cost (``cost_usd: null``) and so no cap. Each release of
genai-prices adds models (0.1.10 added Gemini 3.8 Flash), so the tests use
example/new-model, which no release lists. The list is faked, and a
FunctionModel stands in for the model: no request leaves the process.
"""

import json
from types import SimpleNamespace

import pytest

from whybook.server import agent, model_client, providers
from whybook.server.config import Whybook
from whybook.server.connection import Connection

from .test_agent import drive, request

pytest.importorskip("pydantic_ai")

from pydantic_ai.messages import ModelResponse, ToolCallPart  # noqa: E402
from pydantic_ai.models.function import DeltaToolCall, FunctionModel  # noqa: E402

UNPRICED = Connection(provider="openrouter", model="example/new-model")
SONNET = Connection(provider="openrouter", model="anthropic/claude-sonnet-5")
# OpenRouter's list, as https://openrouter.ai/api/v1/models gives it: prices per token, as text.
LISTED = {
    "data": [
        {"id": "example/new-model", "pricing": {"prompt": "0.00000075", "completion": "0.00000375", "input_cache_read": "0.000000075"}},
        {"id": "anthropic/claude-sonnet-5", "pricing": {"prompt": "0.000002", "completion": "0.00001"}},
        {"id": "broken/model", "pricing": {"prompt": "n/a"}},
    ]
}
SCHEMA = {"type": "object", "properties": {"code": {"type": "string"}}, "required": ["code"], "additionalProperties": False}


@pytest.fixture(autouse=True)
def openrouter_list(monkeypatch):
    """OpenRouter's list of models, read from a fake; the reads are counted."""
    reads = []

    async def get_json(url, **options):
        reads.append(url)
        return LISTED

    monkeypatch.setattr(providers, "get_json", get_json)
    monkeypatch.setattr(providers, "_prices_read", [])
    monkeypatch.setattr(providers, "_prices", {})
    return reads


def answering(model_name="example/new-model"):
    """A function model that streams one answer, as a call of the output tool."""

    async def stream(messages, info):
        yield {0: DeltaToolCall(name=info.output_tools[0].name, json_args=json.dumps({"code": "visits.pain.mean()"}))}

    def reply(messages, info):
        return ModelResponse(parts=[ToolCallPart(info.output_tools[0].name, {"code": "x"})])

    return FunctionModel(reply, stream_function=stream, model_name=model_name)


async def test_openrouter_s_list_gives_the_price_of_a_model_that_genai_prices_lacks(openrouter_list):
    assert model_client.genai_priced(SONNET) and not model_client.genai_priced(UNPRICED)
    price = await model_client.list_price(UNPRICED)
    assert price == {"prompt": 0.00000075, "completion": 0.00000375, "input_cache_read": 0.000000075}
    # A model that genai-prices knows keeps Pydantic AI's price, and another provider has none.
    assert await model_client.list_price(SONNET) is None
    assert await model_client.list_price(Connection(provider="anthropic", model="claude-sonnet-5")) is None
    # The list is read once an hour, not for each call.
    await model_client.list_price(UNPRICED)
    assert openrouter_list == [providers.OPENROUTER_MODELS]
    assert await providers.openrouter_price("broken/model") is None


def test_the_tokens_cost_the_list_price_and_the_cap_holds_as_tokens():
    price = {"prompt": 0.00000075, "completion": 0.00000375, "input_cache_read": 0.000000075}
    usage = SimpleNamespace(input_tokens=4300, output_tokens=361, cache_read_tokens=1000)
    # 3,300 tokens in at $0.75, 1,000 read from the cache at $0.075 and 361 out at $3.75 per million.
    assert model_client.cost_by_list(usage, price) == pytest.approx(0.002475 + 0.000075 + 0.00135375)
    # Each token at the dearer price: $0.50 pays for 133,333 tokens.
    assert model_client.token_cap(price, 0.5) == 133333
    assert model_client.token_cap(None, 0.5) is None
    assert model_client.token_cap({"prompt": 0.0, "completion": 0.0}, 0.5) is None


async def test_an_answer_of_such_a_model_has_a_cost(monkeypatch):
    counted = []
    real = model_client.cost_by_list

    def cost_by_list(usage, price):
        counted.append((usage.input_tokens, usage.output_tokens))
        return real(usage, price)

    monkeypatch.setattr(model_client, "cost_by_list", cost_by_list)
    monkeypatch.setattr(model_client, "build_model", lambda chosen, key: answering())
    call = model_client.structured_call(UNPRICED, "sk-or-v1-test", "prompt", schema=SCHEMA, system_prompt="s", config=Whybook(), effort="low")
    events = [event async for event in call]
    result = events[-1]
    assert result["type"] == "result" and result["model"] == "openrouter:example/new-model"
    [(tokens_in, tokens_out)] = counted[-1:]
    assert tokens_in > 0 and tokens_out > 0
    assert result["cost_usd"] == pytest.approx(round(tokens_in * 0.00000075 + tokens_out * 0.00000375, 8))


async def test_a_call_of_such_a_model_stops_at_the_tokens_its_cap_pays_for(monkeypatch):
    monkeypatch.setattr(model_client, "build_model", lambda chosen, key: answering())
    # $0.000003 pays for no more than 1 token at the dearer price.
    config = Whybook(claude_budget_usd=0.000003)
    call = model_client.structured_call(UNPRICED, "sk-or-v1-test", "prompt", schema=SCHEMA, system_prompt="s", config=config, effort="low")
    events = [event async for event in call]
    assert events[-1]["type"] == "error"
    assert events[-1]["message"].startswith("the call reached its cost cap")
    assert events[-1]["cost_usd"] > 0


async def test_an_agent_s_run_on_such_a_model_stops_at_its_cap(monkeypatch):
    async def stream(messages, info):
        yield {1: DeltaToolCall(name="run_cell", json_args=json.dumps({"title": "Mean pain", "code": "visits.pain.mean()"}))}

    def reply(messages, info):
        raise AssertionError("the driver streams")

    model = FunctionModel(reply, stream_function=stream, model_name="example/new-model")
    monkeypatch.setattr(model_client, "build_model", lambda chosen, key: model)
    driver = model_client.agent_driver(UNPRICED, "sk-or-v1-test", agent.TOOLS)
    found = await drive(agent.run_events(request(), Whybook(agent_budget_usd=0.000003), driver), [])
    final = found[-1]
    assert final["type"] == "result" and final["stopped"] is True
    assert final["capped"] == {"by": "server", "usd": 0.000003}
    assert final["cost_usd"] > 0
