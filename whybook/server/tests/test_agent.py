"""Answers by an agent: tool calls that the view runs, the cell limit, Stop, the data kept here, and the routes."""

import asyncio
import json
import sys
import types

import pytest
from tornado.httpclient import HTTPClientError

from whybook.server import agent, claude, privacy
from whybook.server.config import Whybook
from whybook.server.questions.models import InvalidRequest

VISITS = {
    "name": "visits",
    "kind": "dataframe",
    "type": "pandas.core.frame.DataFrame",
    "rows": 20,
    "columns": [
        {"label": "arm", "tag": "categorical", "levels": ["A", "B"], "missing": 0},
        {"label": "pain", "tag": "numeric", "min": 0.4, "max": 9.1, "missing": 2},
    ],
}
THRESHOLD = {"name": "THRESHOLD", "kind": "constant", "type": "int", "value": "7"}


def body(**extra):
    return {
        "question": {"text": "Does pain differ by arm?", "type": "association"},
        "variables": [VISITS, THRESHOLD],
        "packages": {"pandas": "3.0"},
        "cells": ["[1] Load the visits"],
        "cell": {"label": "[1]", "source": "visits = load()"},
        **extra,
    }


def request(config=None, **extra):
    return agent.AgentRequest.from_json(body(**extra), config or Whybook())


async def drive(events, results):
    """The view's part: answer each tool call with the next result, and collect the events."""
    found = []
    async for event in events:
        found.append(event)
        if event["type"] == "tool":
            assert agent.submit(event["run"], event["call"], results.pop(0))
    return found


async def test_a_run_sends_each_tool_to_the_view_and_returns_what_it_did():
    steps = [
        ("run_cell", {"title": "Mean pain by arm", "code": "visits.groupby('arm').pain.mean()", "why": "compare the arms"}),
        ("explore", {"of": "[2]", "branches": [{"title": "median", "code": "a"}, {"title": "trimmed", "code": "b"}]}),
        ("finish", {"answer": "Arm B has less pain ([2]).", "cells": ["[2]"]}),
    ]
    results = [
        {"status": "ok", "cell": "[2]", "outputs": [{"kind": "table", "rows": 2, "cols": 1, "text": "A 5.1\nB 3.2"}]},
        {"status": "ok", "branches": [{"status": "ok", "cell": "[2b]"}, {"status": "ok", "cell": "[2c]"}]},
    ]
    found = await drive(agent.run_events(request(), Whybook(), agent.scripted(steps)), results)
    assert [event["type"] for event in found] == ["started", "progress", "tool", "progress", "tool", "progress", "result"]
    tools = [event for event in found if event["type"] == "tool"]
    assert [tool["name"] for tool in tools] == ["run_cell", "explore"]
    assert tools[0]["input"]["title"] == "Mean pain by arm"
    final = found[-1]
    assert final["answer"] == "Arm B has less pain ([2])."
    assert final["cells"] == ["[2]"]
    # With the data free to leave, the model reads the outputs as the view gave them.
    assert final["results"][0]["outputs"][0]["text"] == "A 5.1\nB 3.2"
    assert final["results"][2] == {"status": "ok"}
    assert agent.RUNS == {}


async def test_the_data_kept_here_leaves_kinds_sizes_and_local_descriptions_only():
    steps = [("run_cell", {"title": "Pain by arm", "code": "x"}), ("finish", {"answer": "done"})]
    results = [
        {
            "status": "error",
            "cell": "[2]",
            "error": "KeyError: 'P-0042'",
            "defines": [{"name": "by_arm", "kind": "dataframe", "rows": 2, "columns": [{"label": "pain", "levels": ["x"], "min": 1}]}],
            "outputs": [
                {"kind": "table", "rows": 2, "cols": 1, "columns": ["pain"], "text": "A 5.1", "description": "mean pain by arm", "headline": "B lowest"},
                {"kind": "plot", "plot": {"kind": "scatter", "x": "week", "y": "pain", "limits": [0, 9]}, "text": "a"},
            ],
        }
    ]
    config = Whybook(keep_data_local=True)
    found = await drive(agent.run_events(request(config), config, agent.scripted(steps)), results)
    assert found[0]["keep_local"] is True
    result = found[-1]["results"][0]
    assert result["error"] == "KeyError"
    assert result["defines"] == [{"name": "by_arm", "kind": "dataframe", "rows": 2, "columns": [{"label": "pain"}]}]
    assert result["outputs"] == [
        {"kind": "table", "rows": 2, "cols": 1, "columns": ["pain"], "description": "mean pain by arm", "headline": "B lowest"},
        {"kind": "plot", "plot": {"kind": "scatter", "x": "week", "y": "pain"}},
    ]


def test_the_prompt_keeps_no_values_when_the_data_stays_here():
    loose = request()
    assert '"levels"' in loose.prompt() and '"value": "7"' in loose.prompt()
    assert "The data stays on the analyst's machine" not in loose.system_prompt()
    # The view's setting, or the server's, keeps the data here.
    for kept in (request(keep_data_local=True), request(context={"keep_data_local": True}), request(Whybook(keep_data_local=True))):
        prompt = json.loads(kept.prompt())
        assert prompt["variables"][0]["columns"] == [{"label": "arm", "tag": "categorical"}, {"label": "pain", "tag": "numeric"}]
        assert "value" not in prompt["variables"][1]
        assert "The data stays on the analyst's machine" in kept.system_prompt()
    # Rows picked in a plot are named without their values.
    about = json.loads(request(keep_data_local=True, about="rows with pain from 7.5 to 9.1").prompt())["about"]
    assert "7.5" not in about
    with pytest.raises(InvalidRequest, match="picture"):
        request(keep_data_local=True, image={"mime": "image/png", "data": "aGk=", "width": 2, "height": 2, "point": {"x": 1, "y": 1, "fx": 0.5, "fy": 0.5}})
    assert privacy.keep_local(Whybook(), {"keep_data_local": "yes"}) is False


async def test_a_run_refuses_cells_past_its_limit_without_asking_the_view():
    steps = [
        ("run_cell", {"title": "one", "code": "1"}),
        ("explore", {"of": "[2]", "branches": [{"title": "a", "code": "a"}, {"title": "b", "code": "b"}]}),
        ("finish", {"answer": "stopped at the limit"}),
    ]
    found = await drive(agent.run_events(request(Whybook(agent_max_cells=2)), Whybook(), agent.scripted(steps)), [{"status": "ok", "cell": "[2]"}])
    assert [event["name"] for event in found if event["type"] == "tool"] == ["run_cell"]
    assert found[-1]["results"][1]["status"] == "refused"


async def test_stop_ends_the_run_while_a_tool_waits_for_the_view():
    events = agent.run_events(request(), Whybook(), agent.scripted([("run_cell", {"title": "slow", "code": "1"})]))
    found = []
    async for event in events:
        found.append(event)
        if event["type"] == "tool":
            assert agent.stop(event["run"])
            assert not agent.stop("no such run")
    assert found[-1]["type"] == "result"
    assert found[-1]["stopped"] is True
    assert agent.RUNS == {}


def test_a_run_is_capped_at_what_is_left_under_the_notebooks_cap_or_at_the_servers_cap():
    config = Whybook()
    assert config.agent_budget_usd == 2.0 and config.claude_budget_usd == 0.5
    # Without a cap on the notebook, the server's cap of a run holds.
    assert request().cap(config) == (2.0, "server")
    assert request(budget_usd=0.58).cap(config) == (0.58, "notebook")
    assert request(budget_usd=0).cap(config) == (0.0, "notebook")
    # Whichever is lower.
    assert request(budget_usd=5).cap(config) == (2.0, "server")
    assert request(budget_usd=0.5).cap(Whybook(agent_budget_usd=0.3)) == (0.3, "server")
    for bad in (-1, "lots", True, float("nan"), float("inf")):
        with pytest.raises(InvalidRequest, match="budget_usd"):
            request(budget_usd=bad)


async def test_a_run_that_reaches_its_cap_stops_with_what_it_cost_and_keeps_its_cells():
    async def capped(run, request, config):
        await run.call("run_cell", {"title": "Mean pain by arm", "code": "visits.groupby('arm').pain.mean()"})
        cap, by = request.cap(config)
        raise agent.CapReached(cap, by, 0.61, "openrouter:anthropic/claude-sonnet-5")

    found = await drive(agent.run_events(request(budget_usd=0.58), Whybook(), capped), [{"status": "ok", "cell": "[2]"}])
    assert [event["type"] for event in found] == ["started", "tool", "result"]
    final = found[-1]
    assert final["stopped"] is True
    assert final["capped"] == {"by": "notebook", "usd": 0.58}
    assert (final["cost_usd"], final["model"]) == (0.61, "openrouter:anthropic/claude-sonnet-5")
    assert agent.RUNS == {}


async def test_stop_and_a_failure_say_what_the_run_cost_so_far():
    async def metered(run, request, config):
        run.meter = lambda: 0.3
        await run.call("run_cell", {"title": "slow", "code": "1"})
        raise RuntimeError("the model went away")

    found = []
    async for event in agent.run_events(request(), Whybook(), metered):
        found.append(event)
        if event["type"] == "tool":
            assert agent.stop(event["run"])
    assert found[-1]["stopped"] is True and found[-1]["cost_usd"] == 0.3
    failed = await drive(agent.run_events(request(), Whybook(), metered), [{"status": "ok"}])
    assert failed[-1]["type"] == "error"
    assert (failed[-1]["message"], failed[-1]["cost_usd"]) == ("the model went away", 0.3)
    # A driver without a reading says nothing of the cost.
    found = await drive(agent.run_events(request(), Whybook(), agent.scripted([("finish", {"answer": "a"})])), [])
    assert found[-1]["cost_usd"] == 0.0


def claude_code_sdk(messages):
    """An Agent SDK whose client answers a run with these messages, and keeps the options it was given: no call reaches Claude."""
    from .test_claude import AssistantMessage, ResultMessage, TextBlock

    module = types.ModuleType("claude_agent_sdk")
    module.options = []

    class ClaudeAgentOptions:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)
            module.options.append(self)

    class SystemMessage:
        def __init__(self, subtype, data):
            self.subtype, self.data = subtype, data

    class ClaudeSDKClient:
        def __init__(self, options):
            self.options = options

        async def __aenter__(self):
            return self

        async def __aexit__(self, *error):
            return False

        async def query(self, prompt):
            self.prompt = prompt

        async def receive_response(self):
            for message in messages(SystemMessage):
                yield message

    module.ClaudeAgentOptions = ClaudeAgentOptions
    module.ClaudeSDKClient = ClaudeSDKClient
    module.SystemMessage = SystemMessage
    module.AssistantMessage = AssistantMessage
    module.TextBlock = TextBlock
    module.ResultMessage = ResultMessage
    module.tool = lambda name, description, schema: (lambda handler: handler)
    module.create_sdk_mcp_server = lambda name, version, tools: {"tools": tools}
    return module


async def test_a_run_with_the_claude_code_login_gets_the_lower_cap_and_stops_there(monkeypatch):
    from .test_claude import ResultMessage

    def reached(SystemMessage):
        return [
            SystemMessage("init", {"model": "claude-opus-5-5"}),
            ResultMessage(is_error=True, subtype="error_max_budget_usd", errors=["Reached maximum budget ($0.58)"], total_cost_usd=0.61),
        ]

    sdk = claude_code_sdk(reached)
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", sdk)
    found = await drive(agent.run_events(request(budget_usd=0.58), Whybook(), agent.claude_driver), [])
    assert sdk.options[-1].max_budget_usd == 0.58
    assert found[-1]["type"] == "result" and found[-1]["stopped"] is True
    assert found[-1]["capped"] == {"by": "notebook", "usd": 0.58}
    assert (found[-1]["cost_usd"], found[-1]["model"]) == (0.61, "claude-opus-5-5")
    # Without a cap on the notebook, the run has the server's cap, and says so when it stops there.
    found = await drive(agent.run_events(request(), Whybook(), agent.claude_driver), [])
    assert sdk.options[-1].max_budget_usd == 2.0
    assert found[-1]["capped"] == {"by": "server", "usd": 2.0}

    # Another failure keeps its words, with what the run cost.
    def failed(SystemMessage):
        return [ResultMessage(is_error=True, subtype="error_during_execution", errors=["the API is overloaded"], total_cost_usd=0.02)]

    monkeypatch.setitem(sys.modules, "claude_agent_sdk", claude_code_sdk(failed))
    found = await drive(agent.run_events(request(), Whybook(), agent.claude_driver), [])
    assert (found[-1]["type"], found[-1]["message"], found[-1]["cost_usd"]) == ("error", "the API is overloaded", 0.02)


async def test_the_route_passes_the_notebooks_budget_to_the_run_and_refuses_a_bad_one(jp_fetch, monkeypatch):
    caps = []

    async def recorded(run, request, config):
        caps.append(request.cap(config))
        return {"type": "result", "answer": "a", "cells": [], "follow_up": [], "model": "test", "cost_usd": 0.01}

    monkeypatch.setattr(agent, "claude_driver", recorded)
    monkeypatch.setattr(claude, "readiness", lambda config: {"available": True, "cli": "claude", "credential": "ANTHROPIC_API_KEY", "reason": None, "setup": None})
    response = await jp_fetch("whybook", "agent", method="POST", body=json.dumps(body(budget_usd=0.25)))
    assert json.loads(response.body.decode().splitlines()[-1])["answer"] == "a"
    assert caps == [(0.25, "notebook")]
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "agent", method="POST", body=json.dumps(body(budget_usd=-2)))
    assert error.value.code == 400


async def test_the_routes_run_an_agent_take_results_and_refuse_unknown_calls(jp_fetch, monkeypatch):
    steps = [("run_cell", {"title": "Mean pain", "code": "visits.pain.mean()"}), ("finish", {"answer": "5.1 ([2])", "cells": ["[2]"]})]
    monkeypatch.setattr(agent, "claude_driver", agent.scripted(steps, model="test"))
    monkeypatch.setattr(claude, "readiness", lambda config: {"available": True, "cli": "claude", "credential": "ANTHROPIC_API_KEY", "reason": None, "setup": None})
    started = asyncio.ensure_future(jp_fetch("whybook", "agent", method="POST", body=json.dumps(body())))
    for _ in range(200):
        waiting = [(run.id, call) for run in agent.RUNS.values() for call in run.calls]
        if waiting:
            break
        await asyncio.sleep(0.02)
    [(run_id, call_id)] = waiting
    result = {"status": "ok", "cell": "[2]", "outputs": [{"kind": "text", "lines": 1, "text": "5.1"}]}
    response = await jp_fetch("whybook", "agent", "result", method="POST", body=json.dumps({"run": run_id, "call": call_id, "result": result}))
    assert json.loads(response.body) == {"ok": True}
    lines = [json.loads(line) for line in (await started).body.decode().splitlines()]
    assert [line["type"] for line in lines] == ["started", "progress", "tool", "progress", "result"]
    assert lines[-1]["answer"] == "5.1 ([2])"
    assert lines[-1]["model"] == "test"
    for path, payload in ((("agent", "result"), {"run": run_id, "call": call_id, "result": {}}), (("agent", "stop"), {"run": run_id})):
        with pytest.raises(HTTPClientError) as error:
            await jp_fetch("whybook", *path, method="POST", body=json.dumps(payload))
        assert error.value.code == 404
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "agent", method="POST", body=json.dumps({"question": {}}))
    assert error.value.code == 400


async def test_the_stream_pings_while_the_view_runs_a_tool(monkeypatch):
    # A write to a view that closed raises, which stops the run: the pings find it.
    monkeypatch.setattr(agent, "PING_SECONDS", 0.02)
    events = agent.run_events(request(), Whybook(), agent.scripted([("run_cell", {"title": "slow", "code": "1"})]))
    found = []
    async for event in events:
        found.append(event["type"])
        if event["type"] == "tool":
            asyncio.get_running_loop().call_later(0.15, agent.submit, event["run"], event["call"], {"status": "ok"})
    assert found[:3] == ["started", "progress", "tool"]
    assert "ping" in found[3:-1]
    assert found[-1] == "result"


async def test_a_run_writes_files_through_the_view_within_its_limits():
    small = {"path": "helpers.py", "content": "TOP = 3\n", "why": "functions that several cells call"}
    steps = [
        ("write_file", small),
        ("write_file", {**small, "path": "big.py", "content": "x" * (agent.MAX_FILE_CHARS + 1)}),
        ("write_file", {**small, "path": "b.py"}),
        ("write_file", {**small, "path": "c.py"}),
        ("write_file", {**small, "path": "d.py"}),
        ("finish", {"answer": "done"}),
    ]
    results = [{"status": "ok", "path": path, "lines": 1} for path in ("helpers.py", "b.py", "c.py")]
    found = await drive(agent.run_events(request(), Whybook(), agent.scripted(steps)), results)
    # The file that is too large, and a fourth file, never reach the view.
    tools = [event for event in found if event["type"] == "tool"]
    assert [tool["input"]["path"] for tool in tools] == ["helpers.py", "b.py", "c.py"]
    outcomes = found[-1]["results"]
    assert outcomes[0] == {"status": "ok", "path": "helpers.py", "lines": 1}
    assert outcomes[1]["status"] == "refused" and "characters" in outcomes[1]["error"]
    assert outcomes[4]["status"] == "refused" and "files" in outcomes[4]["error"]


async def test_a_file_does_not_count_as_a_cell():
    steps = [
        ("write_file", {"path": "helpers.py", "content": "TOP = 3\n"}),
        ("run_cell", {"title": "Use the helpers", "code": "import helpers"}),
        ("finish", {"answer": "done"}),
    ]
    results = [{"status": "ok", "path": "helpers.py", "lines": 1}, {"status": "ok", "cell": "[2]"}]
    found = await drive(agent.run_events(request(Whybook(agent_max_cells=1)), Whybook(), agent.scripted(steps)), results)
    assert [event["name"] for event in found if event["type"] == "tool"] == ["write_file", "run_cell"]


def test_a_file_result_keeps_its_path_when_the_data_stays_here():
    result = {"status": "refused", "path": "helpers.py", "lines": 3, "reason": "the file exists, and the agent did not write it"}
    assert privacy.tool_result(result, True) == result


def test_the_branches_of_explore_are_told_to_keep_their_names_apart():
    # The branches run at the same time in subshells of one kernel, which share one namespace.
    prompt = " ".join(request().system_prompt().split())
    assert "unique to that branch" in prompt
    assert "Never assign or delete a name that another branch or the notebook defines." in prompt
    code = agent.TOOLS["explore"]["schema"]["properties"]["branches"]["items"]["properties"]["code"]["description"]
    assert "unique to this branch" in code
    assert "never assigns or deletes a name that the notebook or another branch defines" in code
    # An import under its usual name binds the same module again: a branch may write it.
    assert "except that it imports a module under its usual name" in code


def test_the_prompt_says_when_to_write_a_module():
    prompt = request().system_prompt()
    assert "write_file" in prompt
    assert "importlib.reload" in prompt


async def test_the_route_refuses_a_run_without_the_remote_model_and_says_how_to_set_it_up(jp_fetch, monkeypatch):
    missing = {"available": False, "cli": None, "credential": None, "reason": "the Claude Code CLI is missing on the server", "setup": "Install it."}
    monkeypatch.setattr(claude, "readiness", lambda config: missing)
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "agent", method="POST", body=json.dumps(body()))
    assert error.value.code == 409
    assert json.loads(error.value.response.body)["message"] == "No AI model answers on this server: the Claude Code CLI is missing on the server. Install it."


async def test_a_failure_of_the_cli_during_a_run_is_worded_plainly(jp_fetch, monkeypatch):
    async def failing(run, request, config):
        raise RuntimeError("Claude Code not found at: /nonexistent/claude")

    monkeypatch.setattr(agent, "claude_driver", failing)
    monkeypatch.setattr(claude, "readiness", lambda config: {"available": True, "cli": "claude", "credential": "ANTHROPIC_API_KEY", "reason": None, "setup": None})
    response = await jp_fetch("whybook", "agent", method="POST", body=json.dumps(body()))
    lines = [json.loads(line) for line in response.body.decode().splitlines()]
    assert lines[-1]["type"] == "error"
    assert lines[-1]["message"].startswith("No AI model answered: the Claude Code CLI is missing on the server.")
