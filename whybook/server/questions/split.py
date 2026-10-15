"""The questions of the branches of a user question that lists alternatives (design iteration 1.126).

When the words of a user question list two or more names of the notebook,
such as "sleep_hours, mood or analgesic_use", the question box offers to
explore in parallel. The model of More questions then writes the question of
each branch, which the box shows under itself and asks again as the analyst
types on; the question stays as typed. A rule finds the list, and no rule
splits the words.

The request is ``{"text", "cell", "model"}``: the question, the source of the
cell that it is about, and the model of More questions. The answer is
``{"branches", "model", "cost_usd", "elapsed"}``.
"""

from __future__ import annotations

import json
import time
from typing import Any

from .. import claude, connection, local_models
from ..agent import MAX_BRANCHES
from ..config import Whybook
from .models import InvalidRequest

MAX_TEXT = 500
CELL_LINES = 20
# The tokens that a local model may write for each branch: a question of up to 40 words.
TOKENS_PER_BRANCH = 60

SYSTEM_PROMPT = (
    "A data analyst typed a question about a cell of a notebook. When the question asks the same thing of several "
    "alternatives, such as several variables, values or methods, write one question for each alternative: the question "
    "that a branch of the cell answers, which stands alone and keeps the words of the analyst. When the question names "
    "no alternatives, return it as the one question."
)

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"branches": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": MAX_BRANCHES}},
    "required": ["branches"],
    "additionalProperties": False,
}

# A local model gets a grammar that holds each question to words and a length.
LOCAL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "branches": {
            "type": "array",
            "minItems": 1,
            "maxItems": MAX_BRANCHES,
            "items": {"type": "string", "pattern": rf"^{local_models.WORD}( {local_models.WORD}){{2,39}}$"},
        }
    },
    "required": ["branches"],
}


def request_from_json(body: Any) -> dict[str, Any]:
    """The question, the first lines of its cell, and the model of More questions."""
    if not isinstance(body, dict):
        raise InvalidRequest("the body must be an object")
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise InvalidRequest("give the question as text")
    cell = body.get("cell")
    if cell is not None and not isinstance(cell, str):
        raise InvalidRequest("give the cell as its source, or null")
    model = body.get("model") or "remote"
    if not isinstance(model, str):
        raise InvalidRequest("give the model as its choice")
    return {
        "text": " ".join(text.split())[:MAX_TEXT],
        "cell": "\n".join(cell.splitlines()[:CELL_LINES]) if cell else None,
        "model": model,
    }


def prompt_of(request: dict[str, Any]) -> str:
    return json.dumps({"question": request["text"], **({"cell": request["cell"]} if request["cell"] else {})}, ensure_ascii=False)


def branches_of(output: Any) -> list[str]:
    """The questions of the answer, each on one line, at most MAX_BRANCHES; the error of an answer of another form."""
    problems = claude.matches(output, SCHEMA)
    if problems:
        raise ValueError(f"the answer did not come in the form asked for: {'; '.join(problems[:3])}")
    found = []
    for branch in output["branches"]:
        text = " ".join(str(branch).split())
        if text and text not in found:
            found.append(text)
    return found[:MAX_BRANCHES]


async def split(request: dict[str, Any], config: Whybook) -> dict[str, Any]:
    """The remote model's questions of the branches, through the connected model or the task's tier."""
    start = time.monotonic()
    last = None
    async for event in connection.structured_call(
        prompt_of(request), schema=SCHEMA, system_prompt=SYSTEM_PROMPT, config=config, effort=config.question_effort
    ):
        if event["type"] in ("result", "error"):
            last = event
    if not last or last["type"] != "result":
        raise ValueError((last or {}).get("message", "no AI model answered"))
    return {
        "branches": branches_of(last.get("output")),
        "model": last.get("model") or "the remote model",
        "cost_usd": last.get("cost_usd"),
        "elapsed": round(time.monotonic() - start, 2),
    }


async def split_local(request: dict[str, Any], threads: int, check: str = "fast") -> dict[str, Any]:
    """A local model's questions of the branches."""
    start = time.monotonic()
    last = None
    async for event in local_models.ask_json(
        request["model"], SYSTEM_PROMPT, json.loads(prompt_of(request)), LOCAL_SCHEMA, TOKENS_PER_BRANCH * MAX_BRANCHES, threads, "writing the branches", check
    ):
        if event["type"] in ("result", "error"):
            last = event
    if not last or last["type"] != "result":
        raise ValueError((last or {}).get("message", "the local model did not answer"))
    model = local_models.model_of(request["model"])
    return {
        "branches": branches_of(last.get("output")),
        "model": model.label if model else request["model"],
        "cost_usd": 0.0,
        "elapsed": round(time.monotonic() - start, 2),
    }
