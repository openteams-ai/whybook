"""Summaries of the data frames that the Contents panel shows.

The Contents panel lists a frame's columns, then a summary of one sentence
that a model writes: what one row is and what the frame holds. The view keeps
it in the notebook's metadata under a key made from the columns, so a frame is
summarised once, and again when its columns change. Other small model tasks
can read the summary in place of the frame.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

from . import connection
from .config import Whybook
from .questions.models import InvalidRequest

MAX_FRAMES = 8
MAX_COLUMNS = 60
MAX_WORDS = 30

PROMPT = """\
You summarise the data frames of a data analysis notebook for an analyst who
has many of them. For each frame give "summary": one sentence of at most 25
words that says what one row is and what the frame holds, such as "One row per
patient and day: pain score, sleep hours, mood and analgesic use." Use only
what the name, the size and the columns show.
Answer once, with one JSON object whose only key is "frames": a list with one
object per frame, each with exactly the keys "id" and "summary"."""

SCHEMA = {
    "type": "object",
    "properties": {
        "frames": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "string"}, "summary": {"type": "string"}},
                "required": ["id", "summary"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["frames"],
    "additionalProperties": False,
}


def _count(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def frames_from_json(data: Any) -> list[dict[str, Any]]:
    """The frames of a request, cut to what a model reads; raises InvalidRequest."""
    if not isinstance(data, dict) or not isinstance(data.get("frames"), list) or not data["frames"]:
        raise InvalidRequest("the body needs the frames")
    frames = []
    for item in data["frames"][:MAX_FRAMES]:
        if not isinstance(item, dict) or not item.get("id") or not item.get("name"):
            raise InvalidRequest("every frame needs an id and a name")
        columns = [
            {"name": str(column.get("name", ""))[:80], "type": str(column.get("type", ""))[:40]}
            for column in (item.get("columns") or [])[:MAX_COLUMNS]
            if isinstance(column, dict)
        ]
        frames.append(
            {
                "id": str(item["id"]),
                "name": str(item["name"])[:80],
                "rows": _count(item.get("rows")),
                "columns": _count(item.get("n_columns")) or len(columns),
                "first_columns": columns,
            }
        )
    return frames


def prompt_of(frames: list[dict[str, Any]]) -> str:
    """The prompt for Claude: the frames as JSON."""
    return json.dumps({"frames": frames}, indent=1)


def summary_of(text: Any) -> str:
    """At most MAX_WORDS words of ``text``, on one line."""
    return " ".join(str(text or "").split()[:MAX_WORDS])


def notes_from_output(output: Any, ids: list[str]) -> list[dict[str, str]]:
    """One summary per requested frame, cut to the promised length."""
    wanted = set(ids)
    notes: list[dict[str, str]] = []
    for item in output.get("frames", []) if isinstance(output, dict) else []:
        key = str(item.get("id")) if isinstance(item, dict) else None
        if key in wanted:
            wanted.discard(key)
            notes.append({"id": key, "summary": summary_of(item.get("summary"))})
    return notes


async def ask_claude(prompt: str, ids: list[str], config: Whybook) -> AsyncIterator[dict[str, Any]]:
    async for event in connection.structured_call(prompt, schema=SCHEMA, system_prompt=PROMPT, config=config, effort=config.describe_effort):
        if event["type"] == "result":
            event["frames"] = notes_from_output(event.pop("output"), ids)
        yield event
