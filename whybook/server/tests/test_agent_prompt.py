"""The rules of the agent's prompt (design iterations 1.76 and 1.84).

Each rule names what a tester met in an agent's cells on 1 October 2026.
The first pass: raw tuples and a describe() in scientific notation (pain 27,
energy 24), prices typed as constants next to the frame that held them
(energy 18), a check for impossible values that missed the zeros (energy
7), scratch values in the analyst's variables (pain 11, energy 5), a
trajectory with no plot (pain 3), and a table shown again (energy 24). The
second pass: the reshaped diary kept under a scratch name (pain, step 5), a
pooled model for repeated measures with arm B's mean at the floor of 0
(pain, step 14), planned ends of the diary counted as dropout (pain, step
22), a describe() left unrounded (pain), the effect of the switch of
tariff from the switchers alone (energy, step 17), and the tariffs table
shown again (energy, step 28). The tests check that each rule is in the
prompt, and that it reaches the model in a run whose model is a fake,
through the Claude Agent SDK and through Pydantic AI. No model runs, so no
test shows that a model follows a rule.
"""

import json
import sys

import pytest

from whybook.server import agent
from whybook.server.config import Whybook

from .test_agent import claude_code_sdk, drive, request

# What each rule asks, in the prompt's words: the first pass.
RULES = {
    "labelled output": "values printed with a label each",
    "values from a frame": "Read values that a frame holds, such as prices, from that frame: do not type them in.",
    "both ends": "A check for impossible values looks at both ends, zeros and negatives included.",
    "trajectory": "When the question asks how a value changes over time, draw it: a line per unit and the mean.",
}
# The second pass, with the rules of the first pass that it made more precise.
RULES |= {
    "rounded, a describe() too": "Round every number shown, in a describe() too, and never show a bare tuple or scientific notation.",
    "a plain name for the result": "Give the frame or the value that answers the question a plain name that says what it holds, such as diary_long.",
    "scratch values": "Start the name of a helper that only one cell needs with an underscore",
    "no repeat": 'Never add a cell that only shows a frame of "variables" or a result that an earlier cell shows: cite that cell.',
    "mixed model": "For a measure that repeats within a unit, such as a patient's daily pain, fit a mixed model with a random effect per unit, or say in the answer why not.",
    "floor or ceiling": "Say when the values reach a floor or a ceiling, such as a mean at 0.",
    "comparison group": (
        "An effect after an event date, such as a switch of tariff, compares with units that had no event over the same calendar"
        " months; when the run cannot, offer that as a follow-up."
    ),
    "dropout": "A unit whose follow-up ends when planned has not dropped out: count only early stops.",
}


def words(text):
    return " ".join(text.split())


@pytest.mark.parametrize("rule", sorted(RULES))
def test_the_prompt_has_the_rule(rule):
    assert RULES[rule] in words(request().system_prompt())


def test_the_rules_keep_the_prompt_short():
    # Without the privacy part: 4,387 characters before these rules, 5,022 with those of
    # the first pass, and 5,083 with those of the second, which said the tools, the
    # branches and the modules in fewer words.
    assert len(request().system_prompt()) < 5100


async def test_the_rules_reach_the_model_through_the_claude_agent_sdk(monkeypatch):
    from .test_claude import ResultMessage

    sdk = claude_code_sdk(lambda SystemMessage: [ResultMessage(is_error=False, subtype="success", errors=[], total_cost_usd=0.01)])
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", sdk)
    await drive(agent.run_events(request(), Whybook(), agent.claude_driver), [])
    sent = words(sdk.options[-1].system_prompt)
    assert all(rule in sent for rule in RULES.values())


async def test_the_rules_reach_the_model_through_pydantic_ai(monkeypatch):
    pytest.importorskip("pydantic_ai")
    from pydantic_ai.messages import SystemPromptPart
    from pydantic_ai.models.function import DeltaToolCall, FunctionModel

    from whybook.server import model_client

    from .test_model_client import OLLAMA

    seen = []

    async def stream(messages, info):
        seen.extend(part.content for message in messages for part in message.parts if isinstance(part, SystemPromptPart))
        yield {1: DeltaToolCall(name="finish", json_args=json.dumps({"answer": "done", "cells": [], "follow_up": []}))}

    def reply(messages, info):
        raise AssertionError("the driver streams")

    monkeypatch.setattr(model_client, "build_model", lambda chosen, key: FunctionModel(reply, stream_function=stream, model_name="qwen3-coder"))
    driver = model_client.agent_driver(OLLAMA, None, agent.TOOLS)
    found = await drive(agent.run_events(request(), Whybook(), driver), [])
    assert found[-1]["type"] == "result"
    sent = words(" ".join(seen))
    assert all(rule in sent for rule in RULES.values())
