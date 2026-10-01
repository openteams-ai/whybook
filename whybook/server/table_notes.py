"""Labels for the tables that the bench shows as tiles.

A table without room to show shrinks to a tile. Claude gives the tile a
description of one to three words and, when one result stands out, a headline
such as "3 significant". The view keeps both in the cell's metadata, under a
hash of the output, so each table is described once.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator

from . import connection, table_facts
from .config import Whybook
from .questions.models import InvalidRequest

MAX_TABLES = 8
MAX_TEXT = 3000
MAX_CODE = 1500

PROMPT = """\
You label tables in a data analysis notebook. Each table shows as a small
tile, and your labels are all that the reader sees of it. For each table give:
"description": what the table holds, in one to three lower-case words, such as
"daily diary rows", "weekly means" or "model coefficients";
"headline": the one result a reader should see first, in at most four words,
such as "3 significant", "no missing values" or "peak in week 12". Leave it
empty when the table is raw data or no result stands out. Read the numbers
before you write it: the headline must be true of the table shown.
Answer once, with one JSON object whose only key is "tables": a list with one
object per table, each with exactly the keys "id", "description" and
"headline"."""

SCHEMA = {
    "type": "object",
    "properties": {
        "tables": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "description": {"type": "string"},
                    "headline": {"type": "string"},
                },
                "required": ["id", "description", "headline"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["tables"],
    "additionalProperties": False,
}


def _count(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def tables_from_json(data: Any) -> list[dict[str, Any]]:
    """The tables of a request, cut to what a model reads; raises InvalidRequest."""
    if not isinstance(data, dict) or not isinstance(data.get("tables"), list) or not data["tables"]:
        raise InvalidRequest("the body needs the tables")
    tables = []
    for item in data["tables"][:MAX_TABLES]:
        if not isinstance(item, dict) or not item.get("id"):
            raise InvalidRequest("every table needs an id")
        tables.append(
            {
                "id": str(item["id"]),
                "code": str(item.get("code", ""))[:MAX_CODE],
                "table": str(item.get("text", ""))[:MAX_TEXT],
                "rows": _count(item.get("rows")),
                "columns": _count(item.get("columns")),
            }
        )
    return tables


def prompt_of(tables: list[dict[str, Any]]) -> str:
    """The prompt for Claude: the tables as JSON."""
    return json.dumps({"tables": tables}, indent=1)


def request_from_json(data: Any) -> tuple[str, list[str]]:
    """The prompt for Claude and the ids of its tables; raises InvalidRequest."""
    tables = tables_from_json(data)
    return prompt_of(tables), [table["id"] for table in tables]


def words(text: Any, limit: int) -> str:
    """The first ``limit`` words of ``text``, on one line: a description. A headline is never cut (table_facts.headline)."""
    return " ".join(str(text or "").split()[:limit])[:48]


def notes_from_output(output: Any, ids: list[str]) -> list[dict[str, str]]:
    """One note per requested table: a description cut to three words, and a headline that shows whole or not at all."""
    wanted = set(ids)
    notes: list[dict[str, str]] = []
    for item in output.get("tables", []) if isinstance(output, dict) else []:
        key = str(item.get("id")) if isinstance(item, dict) else None
        if key in wanted:
            wanted.discard(key)
            notes.append({"id": key, "description": words(item.get("description"), 3), "headline": table_facts.headline(item.get("headline"))})
    return notes


async def ask_claude(prompt: str, ids: list[str], config: Whybook) -> AsyncIterator[dict[str, Any]]:
    async for event in connection.structured_call(prompt, schema=SCHEMA, system_prompt=PROMPT, config=config, effort=config.describe_effort):
        if event["type"] == "result":
            event["tables"] = notes_from_output(event.pop("output"), ids)
        yield event
