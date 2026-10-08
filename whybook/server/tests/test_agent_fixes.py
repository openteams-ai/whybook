"""An agent fixes a failed cell in place, and never leaves one: design iteration 1.103.

The view runs each tool and says what came out; these tests answer for it,
as the other tests of agents' runs do. No model runs.
"""

import sys

from whybook.server import agent, privacy
from whybook.server.config import Whybook

from .test_agent import claude_code_sdk, drive, request

TYPE_ERROR = "TypeError: only 0-dimensional arrays can be converted to Python scalars"
FIT = {"title": "Test the interaction by sex", "code": "fit = smf.ols('y ~ qsmk * sex', d).fit()\nfloat(fit.params)"}
FIXED = {"title": "Test the interaction by sex", "code": "fit = smf.ols('y ~ qsmk * sex', d).fit()\nfit.params.round(2)"}


def finish(answer, cells=()):
    return ("finish", {"answer": answer, "cells": list(cells)})


async def run(steps, results, config=None):
    """The events of a scripted run, with the view's results, and the tool calls that reached the view."""
    config = config or Whybook()
    found = await drive(agent.run_events(request(config), config, agent.scripted(steps)), list(results))
    return found, [event for event in found if event["type"] == "tool"]


async def test_a_fix_rewrites_the_failed_cell_and_adds_no_cell():
    steps = [("run_cell", FIT), ("run_cell", {**FIXED, "fix": "[2]"}), finish("No difference by sex ([3]).", ["[3]"])]
    results = [
        {"status": "error", "cell": "[2]", "error": TYPE_ERROR, "outputs": []},
        {"status": "ok", "cell": "[3]", "fixed": "[2]", "outputs": [{"kind": "text", "lines": 1, "text": "qsmk:sex -0.43"}]},
    ]
    # A run that may add one cell can still fix it.
    found, tools = await run(steps, results, Whybook(agent_max_cells=1))
    assert [tool["input"].get("fix") for tool in tools] == [None, "[2]"]
    assert tools[1]["input"]["code"] == FIXED["code"]
    final = found[-1]
    assert final["answer"] == "No difference by sex ([3])."
    assert final["results"][1]["fixed"] == "[2]"
    assert final["results"][2] == {"status": "ok"}


async def test_finish_is_refused_while_a_failed_cell_is_in_the_notebook():
    steps = [
        ("run_cell", FIT),
        finish("No difference by sex."),
        # A fix in a new cell, as the agents of the recorded takes did: [2] still fails.
        ("run_cell", {**FIXED, "title": "Report the effects by sex"}),
        finish("No difference by sex ([3]).", ["[3]"]),
        ("remove_cell", {"cell": "[2]", "why": "[3] does its work"}),
        finish("No difference by sex ([3]).", ["[3]"]),
    ]
    results = [
        {"status": "error", "cell": "[2]", "error": TYPE_ERROR},
        {"status": "ok", "cell": "[3]"},
        {"status": "ok", "cell": "[2]", "removed": True},
    ]
    found, tools = await run(steps, results)
    outcomes = found[-1]["results"]
    for refused in (outcomes[1], outcomes[3]):
        assert refused["status"] == "refused"
        assert refused["error"].startswith("Not finished: [2] (TypeError) failed and is still in the notebook")
        assert 'run_cell and "fix": "[2]"' in refused["error"] and "remove_cell" in refused["error"]
    assert [tool["name"] for tool in tools] == ["run_cell", "run_cell", "remove_cell"]
    assert outcomes[5] == {"status": "ok"}
    assert found[-1]["answer"] == "No difference by sex ([3])."


async def test_the_answer_cites_no_cell_when_it_failed():
    steps = [
        ("run_cell", FIT),
        ("run_cell", {**FIXED, "fix": "[2]"}),
        finish("No difference by sex ([2])."),
        finish("No difference by sex.", ["[2]"]),
        finish("No difference by sex ([3])."),
    ]
    results = [{"status": "error", "cell": "[2]", "error": TYPE_ERROR}, {"status": "ok", "cell": "[3]", "fixed": "[2]"}]
    found, _ = await run(steps, results)
    outcomes = found[-1]["results"]
    for refused in (outcomes[2], outcomes[3]):
        assert refused == {
            "status": "refused",
            "error": "Not finished: the answer cites [2], a cell when it failed, and it is [3] since its fix. Cite only cells that ran without an error.",
        }
    assert found[-1]["answer"] == "No difference by sex ([3])."
    # A cell that the agent removed is no source either, alone or in a list.
    steps = [
        ("run_cell", FIT),
        ("remove_cell", {"cell": "[2]"}),
        finish("The model did not run [1, 2]."),
        finish("The model of the interaction did not run, so no estimate by sex was produced."),
    ]
    found, _ = await run(steps, [{"status": "error", "cell": "[2]", "error": TYPE_ERROR}, {"status": "ok", "cell": "[2]", "removed": True}])
    outcomes = found[-1]["results"]
    assert outcomes[2]["error"] == "Not finished: the answer cites [2], a cell when it failed, and you removed it. Cite only cells that ran without an error."
    assert outcomes[3] == {"status": "ok"}


async def test_a_cell_takes_two_fixes_at_most_and_only_a_failed_cell_is_fixed_or_removed():
    steps = [
        ("run_cell", FIT),
        # Neither reaches the view: [1] is the analyst's, and ran.
        ("run_cell", {**FIXED, "fix": "[1]"}),
        ("remove_cell", {"cell": "[1]"}),
        ("run_cell", {**FIXED, "fix": "[2]"}),
        ("run_cell", {**FIXED, "fix": "[3]"}),
        ("run_cell", {**FIXED, "fix": "[4]"}),
        ("remove_cell", {"cell": "[4]"}),
        finish("The interaction model did not run."),
    ]
    results = [
        {"status": "error", "cell": "[2]", "error": TYPE_ERROR},
        {"status": "error", "cell": "[3]", "error": "NameError: name 'd' is not defined", "fixed": "[2]"},
        {"status": "error", "cell": "[4]", "error": "PatsyError: unrecognized token", "fixed": "[3]"},
        {"status": "ok", "cell": "[4]", "removed": True},
    ]
    found, tools = await run(steps, results)
    assert [(tool["name"], tool["input"].get("fix") or tool["input"].get("cell")) for tool in tools] == [
        ("run_cell", None),
        ("run_cell", "[2]"),
        ("run_cell", "[3]"),
        ("remove_cell", "[4]"),
    ]
    outcomes = found[-1]["results"]
    assert outcomes[1] == {"status": "refused", "error": "[1] is not a cell of yours that failed: fix takes only those, and [2] (TypeError) failed."}
    assert outcomes[2]["error"].startswith("[1] is not a cell of yours that failed: remove_cell takes only those")
    assert outcomes[5] == {"status": "refused", "error": "[4] failed after 2 fixes: remove it with remove_cell, and say in the answer what did not run."}
    assert outcomes[7] == {"status": "ok"}
    # Without a failed cell, a fix says how to add a cell.
    found, tools = await run([("run_cell", {**FIXED, "fix": "[2]"})], [])
    assert tools == []
    assert found[-1]["results"][0]["error"] == "No cell of yours has failed: fix takes only a cell of yours that failed. Leave out fix to add a cell."


async def test_a_failed_branch_is_fixed_where_it_is_and_keeps_its_label():
    steps = [
        ("explore", {"of": "[2]", "branches": [{"title": "OLS", "code": "a"}, {"title": "Robust", "code": "b"}]}),
        finish("Both agree ([2b], [2c])."),
        ("run_cell", {"title": "Robust", "code": "b2", "fix": "[2c]"}),
        finish("Both agree ([2b], [2c])."),
    ]
    results = [
        {"status": "error", "of": "[2]", "branches": [{"status": "ok", "cell": "[2b]"}, {"status": "error", "cell": "[2c]", "error": "KeyError: 'wt82'"}]},
        {"status": "ok", "cell": "[2c]", "fixed": "[2c]"},
    ]
    found, _ = await run(steps, results)
    outcomes = found[-1]["results"]
    assert outcomes[1]["error"].startswith("Not finished: [2c] (KeyError) failed")
    assert outcomes[3] == {"status": "ok"}


async def test_a_cell_of_the_notebook_that_the_run_made_goes_by_its_language():
    steps = [
        ("new_notebook", {"kernel": "xr", "name": "visits.R.ipynb"}),
        ("run_cell", {"title": "Fit in R", "code": "fit <- lm(pain ~ arm, visits)", "notebook": "visits.R.ipynb"}),
        finish("The same in R."),
        # As the refusal names it, without the notebook: the view gets both.
        ("run_cell", {"title": "Fit in R", "code": "fit <- lm(pain ~ arm, data = visits)", "fix": "R [2]"}),
        finish("The same in R (R [2])."),
        # [2] alone is a cell of the analyst's notebook.
        finish("Python [2] and R [3] agree."),
    ]
    results = [
        {"status": "ok", "notebook": "visits.R.ipynb", "kernel": "R 4.4.3 (xr)", "language": "R"},
        {"status": "error", "cell": "[2]", "error": "Error: object 'pain' not found"},
        {"status": "ok", "cell": "[3]", "fixed": "[2]"},
    ]
    found, tools = await run(steps, results)
    assert (tools[2]["input"]["fix"], tools[2]["input"]["notebook"]) == ("[2]", "visits.R.ipynb")
    outcomes = found[-1]["results"]
    assert outcomes[2]["error"].startswith("Not finished: R [2] (Error) failed")
    assert 'run_cell and "fix": "R [2]"' in outcomes[2]["error"]
    assert outcomes[4]["error"] == "Not finished: the answer cites R [2], a cell when it failed, and it is R [3] since its fix. Cite only cells that ran without an error."
    assert outcomes[5] == {"status": "ok"}


async def test_a_failed_cell_that_the_analyst_removed_no_longer_holds_the_run():
    steps = [("run_cell", FIT), finish("The cell failed."), ("run_cell", {**FIXED, "fix": "[2]"}), finish("The cell is gone.")]
    results = [
        {"status": "error", "cell": "[2]", "error": TYPE_ERROR},
        # The view no longer finds [2] among the run's cells that failed.
        {"status": "refused", "reason": "[2] is no longer in the notebook", "failed": False},
    ]
    found, _ = await run(steps, results)
    outcomes = found[-1]["results"]
    assert outcomes[1]["status"] == "refused"
    assert outcomes[3] == {"status": "ok"}


async def test_with_the_data_kept_here_the_refusal_names_the_error_and_not_its_values():
    config = Whybook(keep_data_local=True)
    steps = [("run_cell", FIT), finish("done")]
    found, _ = await run(steps, [{"status": "error", "cell": "[2]", "error": "KeyError: 'P-0042'"}], config)
    refused = found[-1]["results"][1]["error"]
    assert "[2] (KeyError)" in refused and "P-0042" not in refused
    # What became of a failed cell holds no data, and goes to the model.
    kept = privacy.tool_result({"status": "ok", "cell": "[3]", "fixed": "[2]", "removed": True, "failed": False, "error": "KeyError: 'P-0042'"}, True)
    assert kept == {"status": "ok", "cell": "[3]", "fixed": "[2]", "removed": True, "failed": False, "error": "KeyError"}


def function_model(monkeypatch, calls):
    """The connected model, through Pydantic AI, as a function that makes these calls in turn, and the texts of the retries that it read."""
    import json

    import pytest

    pytest.importorskip("pydantic_ai")
    from pydantic_ai.messages import ModelRequest, RetryPromptPart
    from pydantic_ai.models.function import DeltaToolCall, FunctionModel

    from whybook.server import model_client

    remaining = list(calls)
    retried = []

    async def stream(messages, info):
        last = messages[-1]
        retried.extend(part.content for part in (last.parts if isinstance(last, ModelRequest) else []) if isinstance(part, RetryPromptPart))
        name, arguments = remaining.pop(0)
        yield {1: DeltaToolCall(name=name, json_args=json.dumps(arguments))}

    def reply(messages, info):
        raise AssertionError("the driver streams")

    monkeypatch.setattr(model_client, "build_model", lambda chosen, key: FunctionModel(reply, stream_function=stream, model_name="qwen3-coder"))
    return retried


async def test_finish_refuses_on_a_connected_model_too(monkeypatch):
    # The agents of the recorded takes ran on OpenRouter, through Pydantic AI, where finish is the output.
    from whybook.server import model_client

    from .test_model_client import OLLAMA

    retried = function_model(
        monkeypatch,
        [("run_cell", FIT), finish("No difference by sex."), ("run_cell", {**FIXED, "fix": "[2]"}), finish("No difference by sex ([3]).", ["[3]"])],
    )
    results = [{"status": "error", "cell": "[2]", "error": TYPE_ERROR}, {"status": "ok", "cell": "[3]", "fixed": "[2]"}]
    found = await drive(agent.run_events(request(), Whybook(), model_client.agent_driver(OLLAMA, None, agent.TOOLS)), results)
    assert [event["input"].get("fix") for event in found if event["type"] == "tool"] == [None, "[2]"]
    assert len(retried) == 1 and retried[0].startswith("Not finished: [2] (TypeError) failed")
    assert found[-1]["type"] == "result" and found[-1]["answer"] == "No difference by sex ([3])."
    # A model that never fixes the cell ends the run as failed, and says why.
    function_model(monkeypatch, [("run_cell", FIT)] + [finish("No difference by sex.")] * (agent.FINISH_REFUSALS + 3))
    failing = [{"status": "error", "cell": "[2]", "error": TYPE_ERROR}]
    found = await drive(agent.run_events(request(), Whybook(), model_client.agent_driver(OLLAMA, None, agent.TOOLS)), failing)
    assert found[-1]["type"] == "error"
    assert found[-1]["message"].startswith("the agent could not finish: [2] (TypeError) failed")


async def test_the_prompt_and_the_tools_say_how_to_fix_and_remove_a_cell(monkeypatch):
    from .test_claude import ResultMessage

    prompt = " ".join(request().system_prompt().split())
    assert 'Fix that cell in place: run_cell with "fix" set to its label' in prompt
    assert f"After {agent.MAX_FIXES} fixes that fail" in prompt and "remove_cell" in prompt
    assert "Fix it with another run_cell" not in prompt
    assert "fix" in agent.TOOLS["run_cell"]["schema"]["properties"]
    assert agent.TOOLS["remove_cell"]["schema"]["required"] == ["cell"]
    assert "Cite only cells that ran without an error" in agent.TOOLS["finish"]["schema"]["properties"]["answer"]["description"]
    # The model gets remove_cell with the other tools.
    sdk = claude_code_sdk(lambda SystemMessage: [ResultMessage()])
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", sdk)
    await drive(agent.run_events(request(), Whybook(), agent.claude_driver), [])
    assert "mcp__whybook__remove_cell" in sdk.options[-1].allowed_tools
