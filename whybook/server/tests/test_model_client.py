"""Calls through Pydantic AI, with its FunctionModel in place of a model: no request leaves the process.

The structured call checks the answer against the schema and asks again; the
agent driver sends each tool to the view, one at a time, and ends with finish.
"""

import json

import pytest

# The models extra brings Pydantic AI; without it these tests have nothing to run.
pytest.importorskip("pydantic_ai")

from pydantic_ai.exceptions import ModelHTTPError
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import DeltaThinkingPart, DeltaToolCall, FunctionModel

from whybook.server import agent, model_client
from whybook.server.config import Whybook
from whybook.server.connection import Connection

from .test_agent import drive, request

SCHEMA = {
    "type": "object",
    "properties": {"code": {"type": "string"}, "kind": {"type": "string", "enum": ["table", "plot"]}},
    "required": ["code", "kind"],
    "additionalProperties": False,
}
OLLAMA = Connection.from_json({"provider": "ollama", "model": "qwen3:8b"})


def replies(*answers, thought="I read the variables.\nA mean per arm answers it."):
    """A function model that streams a thought and then each answer in turn, as a call of the output tool."""
    remaining = list(answers)

    async def stream(messages, info):
        name = info.output_tools[0].name
        yield {0: DeltaThinkingPart(content=thought)}
        yield {1: DeltaToolCall(name=name, json_args=json.dumps(remaining.pop(0)))}

    def reply(messages, info):
        return ModelResponse(parts=[ToolCallPart(info.output_tools[0].name, remaining.pop(0))])

    return FunctionModel(reply, stream_function=stream, model_name="qwen3:8b")


async def events_of(model, monkeypatch, connection=OLLAMA, key="a-key", **options):
    monkeypatch.setattr(model_client, "build_model", lambda chosen, key: model)
    call = model_client.structured_call(connection, key, "prompt", schema=SCHEMA, system_prompt="s", config=Whybook(), effort="low", **options)
    return [event async for event in call]


async def test_an_answer_that_breaks_the_schema_is_asked_again(monkeypatch):
    events = await events_of(replies({"code": "x", "kind": "chart"}, {"code": "visits.pain.mean()", "kind": "table"}), monkeypatch)
    stages = [event.get("stage") for event in events if event["type"] == "progress"]
    assert stages[0] == "starting" and "retrying" in stages
    assert {"type": "progress", "stage": "thinking", "message": "A mean per arm answers it.", "elapsed": events[1]["elapsed"]} in events
    result = events[-1]
    assert result["type"] == "result"
    assert result["output"] == {"code": "visits.pain.mean()", "kind": "table"}
    # Recorded in the notebook as provider and model; a local model has no price.
    assert result["model"] == "ollama:qwen3:8b"
    assert result["cost_usd"] is None


async def test_three_answers_that_break_the_schema_end_in_an_error(monkeypatch):
    wrong = {"code": "x", "kind": "chart"}
    events = await events_of(replies(wrong, wrong, wrong, wrong), monkeypatch)
    assert events[-1]["type"] == "error"


async def test_a_refused_key_is_worded_plainly(monkeypatch):
    async def refused(messages, info):
        raise ModelHTTPError(401, "anthropic/claude-sonnet-5", {"error": "invalid key"})
        yield ""

    model = FunctionModel(lambda messages, info: None, stream_function=refused, model_name="x")
    chosen = Connection(provider="openrouter", model="anthropic/claude-sonnet-5")
    events = await events_of(model, monkeypatch, connection=chosen)
    assert events[-1]["type"] == "error"
    assert events[-1]["message"] == "No AI model answered: OpenRouter: anthropic/claude-sonnet-5 refused the key. Sign in again in the AI models panel."


async def test_pictures_go_before_the_prompt_as_bytes(monkeypatch):
    seen = []

    async def stream(messages, info):
        seen.append(messages[-1].parts[-1].content)
        yield {0: DeltaToolCall(name=info.output_tools[0].name, json_args=json.dumps({"code": "1", "kind": "plot"}))}

    model = FunctionModel(lambda messages, info: None, stream_function=stream, model_name="m")
    events = await events_of(model, monkeypatch, images=[{"media_type": "image/png", "data": "aGVsbG8="}])
    assert events[-1]["type"] == "result"
    [content] = seen
    assert content[0].data == b"hello" and content[0].media_type == "image/png" and content[1] == "prompt"


async def test_a_hosted_model_without_its_key_says_how_to_sign_in():
    chosen = Connection(provider="openrouter", model="anthropic/claude-sonnet-5")
    call = model_client.structured_call(chosen, None, "p", schema=SCHEMA, system_prompt="s", config=Whybook(), effort="low")
    [event] = [event async for event in call]
    assert event == {
        "type": "error",
        "message": "No AI model answered: not signed in to OpenRouter. Sign in with OpenRouter in the AI models panel.",
    }
    driver = model_client.agent_driver(Connection(provider="anthropic", model="claude-sonnet-5"), None, agent.TOOLS)
    found = await drive(agent.run_events(request(), Whybook(), driver), [])
    assert found[-1]["type"] == "error" and found[-1]["message"].endswith("no Anthropic API key is saved. Paste an Anthropic API key in the AI models panel.")


def test_each_provider_gets_its_model_class_and_settings():
    from pydantic_ai.models.anthropic import AnthropicModel
    from pydantic_ai.models.google import GoogleModel
    from pydantic_ai.models.mistral import MistralModel
    from pydantic_ai.models.ollama import OllamaModel
    from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
    from pydantic_ai.models.openrouter import OpenRouterModel

    config = Whybook()
    assert isinstance(model_client.build_model(Connection(provider="openrouter", model="a/b"), "sk-or-v1-x"), OpenRouterModel)
    assert isinstance(model_client.build_model(Connection(provider="anthropic", model="claude-sonnet-5"), "sk-ant-x"), AnthropicModel)
    assert isinstance(model_client.build_model(Connection(provider="openai", model="gpt-5.5"), "sk-x"), OpenAIResponsesModel)
    assert isinstance(model_client.build_model(Connection(provider="google", model="gemini-3-pro"), "AIza-x"), GoogleModel)
    assert isinstance(model_client.build_model(Connection(provider="mistral", model="mistral-medium-latest"), "m-x"), MistralModel)
    routed = model_client.build_model(Connection(provider="huggingface", model="Qwen/Qwen3.8-27B:ovhcloud"), "hf_x")
    assert isinstance(routed, OpenAIChatModel) and str(routed.client.base_url).rstrip("/") == "https://router.huggingface.co/v1"
    assert isinstance(model_client.build_model(OLLAMA, None), OllamaModel)
    llama = model_client.build_model(Connection.from_json({"provider": "llamacpp", "model": "q"}), None)
    assert isinstance(llama, OpenAIChatModel) and str(llama.client.base_url).rstrip("/") == "http://127.0.0.1:8080/v1"
    # Zero data retention on OpenRouter by default, and thinking only for models Pydantic AI knows by name.
    # A request that turns it off (connection.for_request) gets every provider.
    assert model_client.model_settings(Connection(provider="openrouter", model="a/b"), config, "high") == {"thinking": "high", "openrouter_provider": {"zdr": True}}
    assert model_client.model_settings(Connection(provider="openrouter", model="a/b"), Whybook(zero_data_retention=False), "max") == {"thinking": "xhigh"}
    assert model_client.model_settings(OLLAMA, config, "high") == {}
    assert model_client.model_settings(Connection(provider="anthropic", model="claude-sonnet-5"), config, "low") == {"thinking": "low"}
    assert model_client.model_settings(Connection(provider="huggingface", model="Qwen/Qwen3.8-27B:ovhcloud"), config, "high") == {}
    assert model_client.cost_limit(OLLAMA, 0.5) is None and model_client.cost_limit(Connection(provider="openrouter", model="a/b"), 0.5) == 0.5
    assert model_client.cost_limit(Connection(provider="google", model="gemini-3-pro"), 0.5) == 0.5
    assert model_client.cost_limit(Connection(provider="huggingface", model="Qwen/Qwen3.8-27B:ovhcloud"), 0.5) is None


def test_a_model_of_hugging_faces_router_gets_the_profile_of_its_family():
    from pydantic_ai.profiles.openai import OpenAIJsonSchemaTransformer
    from pydantic_ai.profiles.qwen import qwen_model_profile

    qwen = model_client.router_profile("Qwen/Qwen3.8-27B:ovhcloud")
    assert qwen["json_schema_transformer"] is qwen_model_profile("qwen3.8-27b")["json_schema_transformer"]
    assert model_client.router_profile("someone/new-model:novita")["json_schema_transformer"] is OpenAIJsonSchemaTransformer
    assert model_client.router_profile("bare-name")["json_schema_transformer"] is OpenAIJsonSchemaTransformer


def agent_model(*turns):
    """A function model for an agent: each turn is a list of text or (tool, arguments) to stream."""
    remaining = list(turns)

    async def stream(messages, info):
        for index, part in enumerate(remaining.pop(0)):
            if isinstance(part, str):
                yield part
            else:
                name, arguments = part
                yield {index + 1: DeltaToolCall(name=name, json_args=json.dumps(arguments))}

    def reply(messages, info):
        raise AssertionError("the driver streams")

    return FunctionModel(reply, stream_function=stream, model_name="qwen3-coder")


async def test_an_agent_on_another_model_runs_each_tool_in_the_view_and_finishes(monkeypatch):
    model = agent_model(
        ["I compare the arms.", ("run_cell", {"title": "Mean pain by arm", "code": "visits.groupby('arm').pain.mean()"})],
        # One branch is not enough: the tool asks again.
        [("explore", {"of": "[2]", "branches": [{"title": "median", "code": "a"}]})],
        [("explore", {"of": "[2]", "branches": [{"title": "median", "code": "a"}, {"title": "trimmed", "code": "b"}]})],
        [("finish", {"answer": "Arm B has less pain ([2]).", "cells": ["[2]"], "follow_up": ["causal: Does age explain it?"]})],
    )
    monkeypatch.setattr(model_client, "build_model", lambda chosen, key: model)
    driver = model_client.agent_driver(OLLAMA, None, agent.TOOLS)
    results = [
        {"status": "ok", "cell": "[2]", "outputs": [{"kind": "table", "rows": 2, "cols": 1, "text": "A 5.1\nB 3.2"}]},
        {"status": "ok", "branches": [{"status": "ok", "cell": "[2b]"}, {"status": "ok", "cell": "[2c]"}]},
    ]
    found = await drive(agent.run_events(request(), Whybook(), driver), results)
    tools = [event for event in found if event["type"] == "tool"]
    assert [tool["name"] for tool in tools] == ["run_cell", "explore"]
    assert len(tools[1]["input"]["branches"]) == 2
    assert {"type": "text", "text": "I compare the arms."} in found
    final = found[-1]
    assert final["type"] == "result"
    assert (final["answer"], final["cells"], final["follow_up"]) == ("Arm B has less pain ([2]).", ["[2]"], ["causal: Does age explain it?"])
    assert final["model"] == "ollama:qwen3-coder"
    assert agent.RUNS == {}


async def test_an_agent_goes_again_without_thinking_where_the_model_takes_one_or_the_finish_tool(monkeypatch):
    from pydantic_ai.exceptions import UserError

    # Claude Opus 5.5 and Haiku 4.5, among others, refuse a thinking setting with an
    # output tool such as finish: Pydantic AI says so before any request.
    calls = []
    finish = ("finish", {"answer": "Arm B has less pain.", "cells": [], "follow_up": []})

    async def stream(messages, info):
        calls.append(len(calls))
        if len(calls) == 1:
            raise UserError("'claude-opus-5-5' does not support output tools when a thinking setting is configured, because it rejects the forced tool choice they require.")
        yield {1: DeltaToolCall(name=finish[0], json_args=json.dumps(finish[1]))}

    def reply(messages, info):
        raise AssertionError("the driver streams")

    monkeypatch.setattr(model_client, "build_model", lambda chosen, key: FunctionModel(reply, stream_function=stream, model_name="claude-opus-5-5"))
    monkeypatch.setattr(model_client, "model_settings", lambda chosen, config, effort: {"thinking": "medium"})
    driver = model_client.agent_driver(Connection(provider="anthropic", model="claude-opus-5-5"), "sk-ant-x", agent.TOOLS)
    found = await drive(agent.run_events(request(), Whybook(), driver), [])
    assert found[-1]["type"] == "result" and found[-1]["answer"] == "Arm B has less pain."
    assert calls == [0, 1]


async def test_an_agent_that_passes_its_turns_stops_with_a_plain_reason(monkeypatch):
    call = ("run_cell", {"title": "again", "code": "1"})
    monkeypatch.setattr(model_client, "build_model", lambda chosen, key: agent_model(*[[call]] * 5))
    driver = model_client.agent_driver(OLLAMA, None, agent.TOOLS)
    results = [{"status": "ok", "cell": f"[{index}]"} for index in range(5)]
    found = await drive(agent.run_events(request(), Whybook(agent_max_turns=3), driver), results)
    assert found[-1]["type"] == "error"
    assert found[-1]["message"] == "the agent reached its limit of 3 turns before it finished (c.Whybook.agent_max_turns)."


def test_a_model_without_a_price_costs_nothing_known():
    class Result:
        def all_messages(self):
            return [ModelResponse(parts=[TextPart("x")], model_name="no-such-model")]

    assert model_client.cost_of(Result()) is None


def priced_responses(monkeypatch, usd="0.3"):
    """Each response of a function model costs this many US dollars, as a priced model's would."""
    from decimal import Decimal

    import pydantic_ai._agent_graph as graph

    def fill(response):
        if response.usage.cost is None:
            response.usage.cost = Decimal(usd)

    monkeypatch.setattr(graph, "fill_response_cost", fill)


async def test_an_agent_stops_at_what_is_left_under_the_notebooks_cap_where_the_price_is_known(monkeypatch):
    priced_responses(monkeypatch)
    step = ("run_cell", {"title": "Mean pain by arm", "code": "visits.groupby('arm').pain.mean()"})
    finish = ("finish", {"answer": "Arm B has less pain ([2]).", "cells": ["[2]"]})
    openrouter = Connection(provider="openrouter", model="anthropic/claude-sonnet-5")
    results = [{"status": "ok", "cell": f"[{index}]"} for index in range(2, 6)]

    monkeypatch.setattr(model_client, "build_model", lambda chosen, key: agent_model([step], [step], [finish]))
    driver = model_client.agent_driver(openrouter, "sk-or-v1-x", agent.TOOLS)
    found = await drive(agent.run_events(request(budget_usd=0.5), Whybook(), driver), list(results))
    # The second response takes the run to $0.60: the tool it asks for never runs.
    assert [event["name"] for event in found if event["type"] == "tool"] == ["run_cell"]
    final = found[-1]
    assert (final["type"], final["stopped"], final["capped"]) == ("result", True, {"by": "notebook", "usd": 0.5})
    assert final["cost_usd"] == 0.6
    assert final["model"] == "openrouter:anthropic/claude-sonnet-5"

    # With more left under the notebook's cap, the server's cap of a run holds.
    monkeypatch.setattr(model_client, "build_model", lambda chosen, key: agent_model([step], [step], [finish]))
    found = await drive(agent.run_events(request(budget_usd=5), Whybook(agent_budget_usd=0.5), driver), list(results))
    assert found[-1]["capped"] == {"by": "server", "usd": 0.5}

    # Enough room: the run finishes, and says what it cost.
    monkeypatch.setattr(model_client, "build_model", lambda chosen, key: agent_model([step], [step], [finish]))
    found = await drive(agent.run_events(request(budget_usd=1.0), Whybook(), driver), list(results))
    assert found[-1]["answer"] == "Arm B has less pain ([2])."
    assert found[-1]["cost_usd"] == pytest.approx(0.9)

    # Where no price is known, the cap cannot hold: a model on this machine runs to its end.
    monkeypatch.setattr(model_client, "build_model", lambda chosen, key: agent_model([step], [step], [finish]))
    found = await drive(agent.run_events(request(budget_usd=0.1), Whybook(), model_client.agent_driver(OLLAMA, None, agent.TOOLS)), list(results))
    assert found[-1]["answer"] == "Arm B has less pain ([2])."


async def test_a_stopped_agent_says_what_it_cost_so_far(monkeypatch):
    priced_responses(monkeypatch)
    step = ("run_cell", {"title": "slow", "code": "1"})
    monkeypatch.setattr(model_client, "build_model", lambda chosen, key: agent_model([step], [step]))
    driver = model_client.agent_driver(Connection(provider="anthropic", model="claude-sonnet-5"), "sk-ant-x", agent.TOOLS)
    found = []
    async for event in agent.run_events(request(), Whybook(), driver):
        found.append(event)
        if event["type"] == "tool":
            assert agent.stop(event["run"])
    assert found[-1]["stopped"] is True
    assert "capped" not in found[-1]
    assert found[-1]["cost_usd"] == 0.3


async def test_a_call_that_fails_after_a_priced_response_says_what_it_cost(monkeypatch):
    bad = {"code": "x", "kind": "chart"}
    # A model whose price is not known says nothing of the cost.
    events = await events_of(replies(bad, bad, bad), monkeypatch)
    assert events[-1]["type"] == "error" and "cost_usd" not in events[-1]
    # Three answers that break the schema: the call fails after three responses of $0.10 each.
    priced_responses(monkeypatch, "0.1")
    openrouter = Connection(provider="openrouter", model="a/b")
    events = await events_of(replies(bad, bad, bad), monkeypatch, connection=openrouter)
    assert events[-1]["type"] == "error"
    assert events[-1]["cost_usd"] == pytest.approx(0.3)
    # At $0.30 a response, the cap of one call, $0.50, stops it after two: $0.60.
    priced_responses(monkeypatch, "0.3")
    events = await events_of(replies(bad, bad, bad), monkeypatch, connection=openrouter)
    assert "cost cap" in events[-1]["message"]
    assert events[-1]["cost_usd"] == pytest.approx(0.6)


def test_the_schema_check_reads_numbers_and_flags():
    from whybook.server import claude
    from whybook.server.questions import claude_questions

    answer = {"questions": [{"text": "Does pain differ by arm?", "type": "association", "why": "the arms differ", "priority": "high"}]}
    assert claude.matches(answer, claude_questions.SCHEMA) == ["root.questions[0].priority is not a number"]
    answer["questions"][0]["priority"] = 0.8
    assert claude.matches(answer, claude_questions.SCHEMA) == []
    for value, kind, problem in [(True, "number", "is not a number"), (2.5, "integer", "is not a whole number"), ("yes", "boolean", "is not true or false")]:
        assert claude.matches(value, {"type": kind}) == [f"root {problem}"]
    assert claude.matches(3.0, {"type": "integer"}) == [] and claude.matches(False, {"type": "boolean"}) == []


async def test_more_questions_from_a_model_that_writes_a_word_for_the_priority_end_with_an_error(monkeypatch):
    from whybook.server import connection
    from whybook.server.questions import claude_questions
    from whybook.server.questions.models import Context, Selection

    answer = {"questions": [{"text": "Does pain differ by arm?", "type": "association", "why": "the arms differ", "priority": "high"}]}
    monkeypatch.setattr(connection, "load", lambda config=None: OLLAMA)
    monkeypatch.setattr(model_client, "build_model", lambda chosen, key: replies(*[answer] * 10))
    selection = Selection.from_json({"source": {"name": "arm", "kind": "categorical", "parent": "visits"}, "target": {"name": "pain", "kind": "numeric", "parent": "visits"}})
    # Until 29 September 2026 the stream raised ValueError after its progress events, and the view got neither a result nor an error.
    events = [event async for event in claude_questions.generate(selection, Context(), [], Whybook())]
    assert events[-1]["type"] == "error"
    assert "priority is not a number" in events[-1]["message"]
