"""Calls to Claude through the Claude Agent SDK.

The SDK runs the Claude Code CLI in a subprocess. A call uses the credential
that the CLI finds: ``ANTHROPIC_API_KEY`` when it is set, otherwise the stored
Claude Code login. Anthropic does not allow a product to offer claude.ai login
to its users without approval, so a released version has to ask for an API key.

Every call runs in isolation: no built-in tools, no settings, CLAUDE.md files,
MCP servers or skills from disk, and no saved session.
"""

from __future__ import annotations

import getpass
import importlib.util
import logging
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, AsyncIterator

from .config import Whybook

Event = dict[str, Any]

log = logging.getLogger(__name__)


def is_installed() -> bool:
    # Checked without importing: the SDK takes over a second to import.
    return importlib.util.find_spec("claude_agent_sdk") is not None


# Where the SDK looks for the CLI after its bundled copy and the PATH, in its order
# (claude_agent_sdk/_internal/transport/subprocess_cli.py, _find_cli, version 0.2.157).
CLI_LOCATIONS = (
    "~/.npm-global/bin/claude",
    "/usr/local/bin/claude",
    "~/.local/bin/claude",
    "~/node_modules/.bin/claude",
    "~/.yarn/bin/claude",
    "~/.claude/local/claude",
)


def cli_path(config: Whybook) -> str | None:
    """The Claude Code CLI that a call runs, found as the SDK finds it, or None."""
    if config.claude_cli_path:
        path = os.path.expanduser(config.claude_cli_path)
        return path if os.path.isfile(path) and os.access(path, os.X_OK) else None
    spec = importlib.util.find_spec("claude_agent_sdk")
    if spec is not None and spec.origin:
        bundled = os.path.join(os.path.dirname(spec.origin), "_bundled", "claude.exe" if os.name == "nt" else "claude")
        if os.path.isfile(bundled):
            return bundled
    found = shutil.which("claude")
    if found:
        return found
    for location in CLI_LOCATIONS:
        path = os.path.expanduser(location)
        if os.path.isfile(path):
            return path
    return None


# The variables with which the CLI finds a credential without a login, and the
# ones that send its calls to a cloud provider, which has credentials of its own.
CREDENTIAL_VARIABLES = ("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN")
CLOUD_VARIABLES = ("CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY")


def credential(environ: dict[str, str] | None = None) -> str | None:
    """Where the CLI finds a credential, or None when it has none, read without a call.

    A variable of the server's environment, or the login that ``claude`` keeps:
    the file ``.credentials.json`` in its folder (``CLAUDE_CONFIG_DIR``, else
    ``~/.claude``), or on macOS an item of the login keychain.
    """
    environ = os.environ if environ is None else environ
    for name in CREDENTIAL_VARIABLES:
        if environ.get(name):
            return name
    for name in CLOUD_VARIABLES:
        if environ.get(name, "").lower() not in ("", "0", "false", "no"):
            return name
    folders = [environ.get("CLAUDE_SECURESTORAGE_CONFIG_DIR"), environ.get("CLAUDE_CONFIG_DIR"), os.path.join(os.path.expanduser("~"), ".claude")]
    for folder in folders:
        if folder and os.path.isfile(os.path.join(folder, ".credentials.json")):
            return "the Claude Code login"
    if sys.platform == "darwin" and keychain_login(environ):
        return "the Claude Code login"
    return None


def keychain_login(environ: dict[str, str]) -> bool:
    """Whether the macOS keychain holds the login of ``claude``; True when that cannot be told.

    ``security`` finds the item without reading the secret. With its own folder,
    set by ``CLAUDE_CONFIG_DIR``, the CLI adds a hash to the item's name, so no
    item is looked for then.
    """
    if environ.get("CLAUDE_CONFIG_DIR") or environ.get("CLAUDE_SECURESTORAGE_CONFIG_DIR"):
        return True
    try:
        user = environ.get("USER") or getpass.getuser()
        found = subprocess.run(
            ["security", "find-generic-password", "-a", user, "-s", "Claude Code-credentials"],
            capture_output=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return True
    # 44 is the exit status for an item that is not there.
    return found.returncode != 44


# One line on how to set the remote model up, for each thing that is missing.
SETUP_SDK = "Install the claude extra of whybook, pip install -e \".[claude]\", and restart the server."
SETUP_CLI_PATH = "Point c.Whybook.claude_cli_path at the claude command, or leave it unset to use the one that comes with claude-agent-sdk, and restart the server."
SETUP_CLI = "Install claude-agent-sdk again, which brings the CLI, or install Claude Code, and restart the server."
SETUP_CREDENTIAL = "Set ANTHROPIC_API_KEY where the server starts and restart it, or run claude in a terminal to log in, then reload the page."


def readiness(config: Whybook) -> dict[str, Any]:
    """Whether the remote model can answer, checked without a call to it and without cost.

    The SDK must be installed, the CLI that it runs must be there, and the CLI
    must find a credential. ``reason`` says what is missing and ``setup`` how
    to set it up, in words for the view; both are None when nothing is.
    """
    if not is_installed():
        return {"available": False, "cli": None, "credential": None, "reason": "claude-agent-sdk is not installed on the server", "setup": SETUP_SDK}
    cli = cli_path(config)
    if cli is None:
        if config.claude_cli_path:
            where = f"the Claude Code CLI is not at {config.claude_cli_path}, where c.Whybook.claude_cli_path points"
            return {"available": False, "cli": None, "credential": None, "reason": where, "setup": SETUP_CLI_PATH}
        return {"available": False, "cli": None, "credential": None, "reason": "the Claude Code CLI is missing on the server", "setup": SETUP_CLI}
    found = credential()
    if found is None:
        reason = "the Claude Code CLI on the server has no credential: no ANTHROPIC_API_KEY and no login"
        return {"available": False, "cli": cli, "credential": None, "reason": reason, "setup": SETUP_CREDENTIAL}
    return {"available": True, "cli": cli, "credential": found, "reason": None, "setup": None}


def is_available(config: Whybook) -> bool:
    """Whether the remote model can answer: ``readiness``, without the words."""
    return readiness(config)["available"]


def _workdir() -> str:
    # The CLI keeps state per working directory. A fixed directory keeps that
    # state in one place, away from the user's own projects.
    path = os.path.join(tempfile.gettempdir(), "whybook-claude")
    os.makedirs(path, exist_ok=True)
    return path


# The CLI's own structured output sometimes fails: the model sends one item of
# a list instead of the whole object, five times over. Then one more call asks
# for the JSON as text, which is parsed and checked here against the schema.
RETRY_PROMPT = (
    "\n\nReply with the JSON object only: one object with all the required keys, "
    "no prose and no code fence."
)


def matches(value: Any, schema: dict[str, Any], path: str = "root") -> list[str]:
    """Where ``value`` breaks ``schema``: the subset of JSON Schema this package uses."""
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict):
            return [f"{path} is not an object"]
        problems = [f"{path} lacks {key!r}" for key in schema.get("required", []) if key not in value]
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            problems += [f"{path} has an unknown key {key!r}" for key in value if key not in properties]
        for key, sub in properties.items():
            if key in value:
                problems += matches(value[key], sub, f"{path}.{key}")
        return problems
    if kind == "array":
        if not isinstance(value, list):
            return [f"{path} is not a list"]
        return [problem for index, item in enumerate(value) for problem in matches(item, schema.get("items", {}), f"{path}[{index}]")]
    if kind == "string":
        if not isinstance(value, str):
            return [f"{path} is not a string"]
        if "enum" in schema and value not in schema["enum"]:
            return [f"{path} is not one of {schema['enum']}"]
    # A word where a number goes, such as a priority of "high", fails here, not later in the code that reads it.
    if kind in ("number", "integer"):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            return [f"{path} is not a number"]
        if kind == "integer" and not float(value).is_integer():
            return [f"{path} is not a whole number"]
    if kind == "boolean" and not isinstance(value, bool):
        return [f"{path} is not true or false"]
    return []


def json_from_text(text: str) -> Any:
    """The first JSON object in a reply, with or without a code fence."""
    import json

    start = text.find("{")
    if start < 0:
        raise ValueError("the reply holds no JSON object")
    value, _ = json.JSONDecoder().raw_decode(text[start:])
    return value


# How much of the model's latest thought the view shows while it waits.
THOUGHT_CHARS = 160


def last_thought(message: Any, sdk: Any) -> str | None:
    """The last line of the thinking in a message, when the model shows its thinking."""
    kind = getattr(sdk, "ThinkingBlock", None)
    texts = [block.thinking for block in getattr(message, "content", None) or [] if kind is not None and isinstance(block, kind) and block.thinking]
    lines = [line.strip().strip("*#").strip() for line in (texts[-1] if texts else "").splitlines()]
    lines = [line for line in lines if line]
    if not lines:
        return None
    line = lines[-1]
    return line if len(line) <= THOUGHT_CHARS else line[: THOUGHT_CHARS - 1].rsplit(" ", 1)[0] + "…"


def user_message(text: str, images: list[dict[str, str]] | None) -> Any:
    """The prompt as ``query`` takes it: the text alone, or a user message with pictures.

    With pictures, the prompt is the SDK's streaming input: one user message whose
    content is an image block per picture, then the text. The SDK writes the message
    as it is to the CLI, and the CLI passes the blocks on to the Messages API. Each
    picture is ``{"media_type": "image/png", "data": <base64>}``.
    """
    if not images:
        return text
    content: list[dict[str, Any]] = [
        {"type": "image", "source": {"type": "base64", "media_type": image["media_type"], "data": image["data"]}} for image in images
    ]
    content.append({"type": "text", "text": text})

    async def messages() -> AsyncIterator[dict[str, Any]]:
        yield {"type": "user", "session_id": "", "message": {"role": "user", "content": content}, "parent_tool_use_id": None}

    return messages()


async def structured_call(
    prompt: str,
    *,
    schema: dict[str, Any],
    system_prompt: str,
    config: Whybook,
    effort: str,
    images: list[dict[str, str]] | None = None,
) -> AsyncIterator[Event]:
    """Ask Claude for JSON that matches ``schema``, with pictures before the prompt if given.

    Yields ``progress`` events and ends with one ``result`` or ``error`` event.
    Every event is a JSON-serialisable dict with a ``type`` key.
    """
    try:
        import claude_agent_sdk as sdk
    except ImportError:  # the "claude" extra is not installed
        log.warning("claude-agent-sdk is not installed: pip install -e '.[claude]'")
        yield {"type": "error", "message": "No AI model is set up on the server."}
        return

    start = time.monotonic()
    # What every attempt cost, the plain JSON retry included: the view keeps it (src/model/cost.ts).
    state: dict[str, Any] = {"model": None, "cost": None}

    def elapsed() -> float:
        return round(time.monotonic() - start, 1)

    def spent(message: Any) -> None:
        if isinstance(message.total_cost_usd, (int, float)):
            state["cost"] = round((state["cost"] or 0.0) + message.total_cost_usd, 8)

    def with_cost(event: Event) -> Event:
        return {**event, "cost_usd": state["cost"]} if state["cost"] is not None else event

    def options(structured: bool) -> Any:
        return sdk.ClaudeAgentOptions(
            system_prompt=system_prompt,
            tools=[],
            setting_sources=[],
            strict_mcp_config=True,
            skills=[],
            permission_mode="dontAsk",
            max_turns=4,
            max_budget_usd=config.claude_budget_usd,
            model=config.claude_model,
            cli_path=config.claude_cli_path,
            effort=effort,
            cwd=_workdir(),
            output_format={"type": "json_schema", "schema": schema} if structured else None,
            extra_args={"no-session-persistence": None},
        )

    async def run(text: str, structured: bool) -> AsyncIterator[Event]:
        try:
            async for message in sdk.query(prompt=user_message(text, images), options=options(structured)):
                if isinstance(message, sdk.SystemMessage):
                    if message.subtype == "init":
                        state["model"] = message.data.get("model")
                        yield {"type": "progress", "stage": "starting", "elapsed": elapsed()}
                    elif message.subtype == "thinking_tokens":
                        yield {"type": "progress", "stage": "thinking", "elapsed": elapsed()}
                elif isinstance(message, sdk.AssistantMessage):
                    event = {"type": "progress", "stage": "writing", "elapsed": elapsed()}
                    thought = last_thought(message, sdk)
                    if thought is not None:
                        event["message"] = thought
                        if all(isinstance(block, sdk.ThinkingBlock) for block in message.content):
                            event["stage"] = "thinking"
                    yield event
                elif isinstance(message, sdk.ResultMessage):
                    spent(message)
                    output = message.structured_output
                    reason = "; ".join(message.errors or []) or message.subtype
                    if not structured and not message.is_error:
                        try:
                            output = json_from_text(message.result or "")
                        except ValueError as error:
                            output, reason = None, f"the reply is not JSON: {error}"
                        else:
                            problems = matches(output, schema)
                            if problems:
                                output, reason = None, "the reply does not match the schema: " + "; ".join(problems[:4])
                    if message.is_error or output is None:
                        yield with_cost({"type": "error", "message": reason, "elapsed": elapsed()})
                    else:
                        yield {
                            "type": "result",
                            "output": output,
                            "model": state["model"],
                            "cost_usd": state["cost"],
                            "elapsed": elapsed(),
                        }
        except sdk.ClaudeSDKError as error:
            yield with_cost({"type": "error", "message": str(error), "elapsed": elapsed()})

    failure = None
    async for event in run(prompt, structured=True):
        if event["type"] == "error" and "structured output" in event["message"].lower():
            failure = event
            break
        if event["type"] == "error":
            log.warning("the call to Claude failed: %s", event["message"])
            event["message"] = reason(event["message"], config)
        yield event
    if failure is None:
        return
    yield {"type": "progress", "stage": "retrying", "elapsed": elapsed()}
    async for event in run(prompt + RETRY_PROMPT, structured=False):
        if event["type"] == "error":
            log.warning("Claude's structured output failed: %s; then, asked for plain JSON: %s", failure["message"], event["message"])
            event["message"] = f"The AI model's answer did not have the form asked for, and a second try failed: {reason(event['message'], config)}"
        yield event


def reason(message: str, config: Whybook) -> str:
    """Why a call failed, in words the analyst can act on. The server log keeps the message as it came."""
    lowered = message.lower()
    if "maximum budget" in lowered:
        return f"the call reached its cost cap of ${config.claude_budget_usd:.2f} (c.Whybook.claude_budget_usd)."
    # The SDK's message names the CLI and its path; the CLI's own messages for
    # a missing or refused login say "Not logged in · Please run /login" and
    # "Invalid API key · Fix external API key" (Claude Code 2.x).
    if "claude code not found" in lowered:
        return f"No AI model answered: the Claude Code CLI is missing on the server. {SETUP_CLI_PATH if config.claude_cli_path else SETUP_CLI}"
    if "not logged in" in lowered or "/login" in lowered or "invalid api key" in lowered or "invalid auth token" in lowered:
        return f"No AI model answered: the Claude Code CLI on the server has no valid login. {SETUP_CREDENTIAL}"
    if "credit balance is too low" in lowered:
        return "No AI model answered: the account of the API key has no credit left."
    return message
