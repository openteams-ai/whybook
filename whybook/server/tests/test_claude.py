"""The structured Claude call, with a fake Agent SDK: no call reaches Claude."""

import sys
import types
from dataclasses import dataclass, field

from whybook.server import claude
from whybook.server.config import Whybook
from whybook.server.solve import SCHEMA, SYSTEM_PROMPT

CELL = {"summary": "Pain by week", "code": "x = 1", "assumptions": ["modelling: means"], "follow_up": []}


class FakeSDKError(Exception):
    pass


@dataclass
class ResultMessage:
    is_error: bool = False
    structured_output: object = None
    result: str | None = None
    errors: list = field(default_factory=list)
    subtype: str = "success"
    total_cost_usd: float = 0.01


@dataclass
class ThinkingBlock:
    thinking: str
    signature: str = ""


@dataclass
class TextBlock:
    text: str


@dataclass
class AssistantMessage:
    content: list


def fake_sdk(replies):
    """An SDK whose query() answers with the next reply: a ResultMessage or an exception."""
    module = types.ModuleType("claude_agent_sdk")
    module.calls = []

    class ClaudeAgentOptions:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    async def query(prompt, options):
        module.calls.append({"prompt": prompt, "structured": options.output_format is not None})
        reply = replies[len(module.calls) - 1]
        if isinstance(reply, Exception):
            raise reply
        # A list is the messages of one call, in order.
        for message in reply if isinstance(reply, list) else [reply]:
            yield message

    module.ClaudeSDKError = FakeSDKError
    module.ClaudeAgentOptions = ClaudeAgentOptions
    module.SystemMessage = type("SystemMessage", (), {})
    module.AssistantMessage = AssistantMessage
    module.ThinkingBlock = ThinkingBlock
    module.TextBlock = TextBlock
    module.ResultMessage = ResultMessage
    module.query = query
    return module


async def events_of(monkeypatch, replies):
    sdk = fake_sdk(replies)
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", sdk)
    events = [e async for e in claude.structured_call("{}", schema=SCHEMA, system_prompt="s", config=Whybook(), effort="low")]
    return events, sdk.calls


def test_the_prompt_asks_for_one_object_with_every_key():
    assert "one JSON object" in SYSTEM_PROMPT
    for key in SCHEMA["required"]:
        assert f'"{key}"' in SYSTEM_PROMPT


def test_schema_check_reports_an_item_sent_instead_of_the_object():
    problems = claude.matches({"text": "an assumption", "kind": "data"}, SCHEMA)
    assert "root lacks 'summary'" in problems
    assert "root has an unknown key 'kind'" in problems
    assert claude.matches(CELL, SCHEMA) == []
    # The lists hold strings: an assumption is never an object to send in place of the answer.
    assert SCHEMA["properties"]["assumptions"]["items"] == {"type": "string"}


async def test_a_structured_output_failure_retries_as_plain_json(monkeypatch):
    failure = FakeSDKError("Claude Code returned an error result: Failed to provide valid structured output after 5 attempts")
    events, calls = await events_of(monkeypatch, [failure, ResultMessage(result='Here it is:\n```json\n{"summary": "Pain by week", "code": "x = 1", "assumptions": ["modelling: means"], "follow_up": []}\n```')])
    assert [c["structured"] for c in calls] == [True, False]
    assert events[-1]["type"] == "result"
    assert events[-1]["output"] == CELL


async def test_a_retry_that_breaks_the_schema_is_an_error(monkeypatch):
    failure = ResultMessage(is_error=True, errors=["Failed to provide valid structured output after 5 attempts"])
    events, _ = await events_of(monkeypatch, [failure, ResultMessage(result='{"text": "one assumption", "kind": "data"}')])
    assert events[-1]["type"] == "error"
    assert "does not match the schema" in events[-1]["message"]


async def test_other_errors_are_not_retried(monkeypatch):
    events, calls = await events_of(monkeypatch, [ResultMessage(is_error=True, errors=["budget exceeded"])])
    assert len(calls) == 1
    # A call that failed after it reached the model says what it cost.
    assert events[-1] == {"type": "error", "message": "budget exceeded", "elapsed": events[-1]["elapsed"], "cost_usd": 0.01}


async def test_a_retry_costs_what_both_attempts_cost(monkeypatch):
    # The structured attempt failed after it cost $0.03; the retry as plain JSON cost $0.01.
    failure = ResultMessage(is_error=True, errors=["Failed to provide valid structured output after 5 attempts"], total_cost_usd=0.03)
    answer = ResultMessage(result='{"summary": "Pain by week", "code": "x = 1", "assumptions": ["modelling: means"], "follow_up": []}')
    events, _ = await events_of(monkeypatch, [failure, answer])
    assert events[-1]["type"] == "result"
    assert events[-1]["cost_usd"] == 0.04
    # An exception of the SDK after a paid attempt keeps what that attempt cost.
    events, _ = await events_of(monkeypatch, [failure, FakeSDKError("the CLI went away")])
    assert (events[-1]["type"], events[-1]["cost_usd"]) == ("error", 0.03)


async def test_a_retry_stopped_by_the_cost_cap_says_so_in_short(monkeypatch):
    failure = FakeSDKError("Claude Code returned an error result: Failed to provide valid structured output after 5 attempts")
    budget = ResultMessage(is_error=True, errors=["Claude Code returned an error result: Reached maximum budget ($0.5)"])
    events, _ = await events_of(monkeypatch, [failure, budget])
    assert events[-1]["message"] == (
        "The AI model's answer did not have the form asked for, and a second try failed: "
        "the call reached its cost cap of $0.50 (c.Whybook.claude_budget_usd)."
    )



async def test_the_models_thinking_goes_to_the_view_as_it_comes(monkeypatch):
    thinking = AssistantMessage([ThinkingBlock("**Reading the frames**\n\nThe analyst wants weekly means; weekly has week and pain_score.\n")])
    answer = AssistantMessage([TextBlock("{}")])
    events, _ = await events_of(monkeypatch, [[thinking, answer, ResultMessage(structured_output=CELL)]])
    progress = [event for event in events if event["type"] == "progress"]
    assert progress[0]["stage"] == "thinking"
    assert progress[0]["message"] == "The analyst wants weekly means; weekly has week and pain_score."
    assert progress[1]["stage"] == "writing"
    assert "message" not in progress[1]
    assert events[-1]["type"] == "result"


def clean_environment(monkeypatch, home):
    """A server environment with no credential: no variables, and a home without a login."""
    monkeypatch.setenv("HOME", str(home))
    for name in (*claude.CREDENTIAL_VARIABLES, *claude.CLOUD_VARIABLES, "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(claude.sys, "platform", "linux")

    def no_process(*args, **kwargs):
        raise AssertionError("the status must not start a process")

    monkeypatch.setattr(claude.subprocess, "run", no_process)


def test_the_status_checks_the_cli_and_a_credential_without_a_call(tmp_path, monkeypatch):
    clean_environment(monkeypatch, tmp_path)
    # The SDK comes first in the status: without the claude extra, as on CI,
    # the status would name it and not the CLI.
    monkeypatch.setattr(claude, "is_installed", lambda: True)
    config = Whybook(claude_cli_path=str(tmp_path / "missing" / "claude"))
    missing = claude.readiness(config)
    assert missing["available"] is False
    assert missing["reason"] == f"the Claude Code CLI is not at {tmp_path / 'missing' / 'claude'}, where c.Whybook.claude_cli_path points"
    assert "c.Whybook.claude_cli_path" in missing["setup"]

    cli = tmp_path / "claude"
    cli.write_text("#!/bin/sh\nexit 1\n")
    cli.chmod(0o755)
    config = Whybook(claude_cli_path=str(cli))
    unset = claude.readiness(config)
    assert (unset["available"], unset["cli"]) == (False, str(cli))
    assert unset["reason"] == "the Claude Code CLI on the server has no credential: no ANTHROPIC_API_KEY and no login"
    assert unset["setup"].startswith("Set ANTHROPIC_API_KEY where the server starts")

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert claude.readiness(config) == {"available": True, "cli": str(cli), "credential": "ANTHROPIC_API_KEY", "reason": None, "setup": None}
    monkeypatch.delenv("ANTHROPIC_API_KEY")

    # The login of `claude`, in its folder or in the folder CLAUDE_CONFIG_DIR names.
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / ".credentials.json").write_text("{}")
    assert claude.readiness(config)["credential"] == "the Claude Code login"
    (tmp_path / ".claude" / ".credentials.json").unlink()
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / ".credentials.json").write_text("{}")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "config"))
    assert claude.is_available(config) is True


def test_the_status_says_when_the_sdk_is_missing(tmp_path, monkeypatch):
    clean_environment(monkeypatch, tmp_path)
    monkeypatch.setattr(claude, "is_installed", lambda: False)
    status = claude.readiness(Whybook())
    assert (status["available"], status["reason"]) == (False, "claude-agent-sdk is not installed on the server")
    assert 'pip install -e ".[claude]"' in status["setup"]


def test_on_macos_the_login_is_looked_for_in_the_keychain(tmp_path, monkeypatch):
    clean_environment(monkeypatch, tmp_path)
    monkeypatch.setattr(claude.sys, "platform", "darwin")
    commands = []

    def security(command, **kwargs):
        commands.append(command)
        return types.SimpleNamespace(returncode=returncode)

    monkeypatch.setattr(claude.subprocess, "run", security)
    returncode = 44
    assert claude.credential() is None
    returncode = 0
    assert claude.credential() == "the Claude Code login"
    # The item is found by its name, and its secret is not read: no -w.
    assert commands[-1][:2] == ["security", "find-generic-password"]
    assert "-w" not in commands[-1]


def test_known_failures_of_the_cli_are_worded_plainly():
    config = Whybook()
    assert claude.reason("Claude Code not found at: /nonexistent/claude", config).startswith(
        "No AI model answered: the Claude Code CLI is missing on the server."
    )
    assert claude.reason("Not logged in · Please run /login", config).startswith(
        "No AI model answered: the Claude Code CLI on the server has no valid login."
    )
    assert claude.reason("some other failure", config) == "some other failure"
