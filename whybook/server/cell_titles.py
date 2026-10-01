"""Titles for the code cells that the analyst writes or edits.

A card of the bench shows a cell's title: the question that an answer came
from, a title in the notebook's metadata, or else the first line of its code,
which often reads "import pandas as pd" or "weekly = (". When the analyst
stops typing in a cell, the view asks a model for a title of a few words, and
sends the title the cell shows: the model gives it back when it still fits,
so a small edit does not rename the cell. The view keeps the answer in the
cell's metadata under a key made from the code.
"""

from __future__ import annotations

import json
import re
from typing import Any, AsyncIterator

from . import connection
from .config import Whybook
from .questions.models import InvalidRequest

MAX_CELLS = 8
MAX_CODE = 3000
MAX_TITLE = 120
# The prompts ask for at most 8 words, and architecture/code-map.md promises them.
MAX_WORDS = 8
# A plain word in lower case, which a title starts with a capital: "weekly", "p-value".
PLAIN_WORD = re.compile(r"[a-z]+(?:['’-][a-z]+)*")
# Words and marks that do not end a title, once it is cut to MAX_WORDS.
TRAILING_MARKS = ",;:(-\u2013\u2014"
DANGLING = {
    "a", "an", "the", "and", "or", "but", "by", "of", "per", "in", "on", "at", "for", "with", "without",
    "to", "from", "into", "over", "across", "between", "within", "vs", "versus", "than", "as", "after", "before",
}

PROMPT = """\
You write the titles of the code cells of a data analysis notebook, as an
analyst writes them over each cell. For each cell give "title": at most 8
words that name what the cell makes or asks, in sentence case and without a
full stop. Write a noun phrase or a question, not an instruction: "Weekly pain
per patient, by arm", not "Calculate weekly pain"; "Mixed model: does arm
change the trajectory?", not "Fit a mixed model". Name the data and the
result, not the functions. When the cell's current title still says what its
code does, give it back unchanged.
Answer once, with one JSON object whose only key is "cells": a list with one
object per cell, each with exactly the keys "id" and "title"."""

SCHEMA = {
    "type": "object",
    "properties": {
        "cells": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "string"}, "title": {"type": "string"}},
                "required": ["id", "title"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["cells"],
    "additionalProperties": False,
}


def cells_from_json(data: Any) -> list[dict[str, Any]]:
    """The cells of a request, cut to what a model reads; raises InvalidRequest."""
    if not isinstance(data, dict) or not isinstance(data.get("cells"), list) or not data["cells"]:
        raise InvalidRequest("the body needs the cells")
    cells = []
    for item in data["cells"][:MAX_CELLS]:
        if not isinstance(item, dict) or not item.get("id") or not isinstance(item.get("code"), str):
            raise InvalidRequest("every cell needs an id and its code")
        if not item["code"].strip():
            raise InvalidRequest("a cell without code has no title to write")
        cells.append(
            {
                "id": str(item["id"]),
                "code": item["code"][:MAX_CODE],
                "title": str(item.get("title") or "")[:MAX_TITLE],
            }
        )
    return cells


def prompt_of(cells: list[dict[str, Any]]) -> str:
    """The prompt for Claude: the cells as JSON."""
    return json.dumps({"cells": cells}, indent=1)


def title_of(text: Any) -> str:
    """At most MAX_WORDS words of ``text``, on one line, without a full stop.

    A title that starts with a plain word starts with a capital letter; a name
    such as "eGFR", "pH" or "weekly_pain" keeps its case. A title cut to
    MAX_WORDS does not end on a word such as "and" or "by".
    """
    words = str(text or "").split()
    if len(words) > MAX_WORDS:
        words = words[:MAX_WORDS]
        while words and words[-1].lower().strip(TRAILING_MARKS) in DANGLING | {""}:
            words.pop()
        if words:
            words[-1] = words[-1].rstrip(TRAILING_MARKS)
    title = " ".join(words).rstrip(".")
    first = title.split(" ", 1)[0]
    return title[:1].upper() + title[1:] if PLAIN_WORD.fullmatch(first) else title


def notes_from_output(output: Any, ids: list[str]) -> list[dict[str, str]]:
    """One title per requested cell, cut to the promised length; an empty title is left out."""
    wanted = set(ids)
    notes: list[dict[str, str]] = []
    for item in output.get("cells", []) if isinstance(output, dict) else []:
        key = str(item.get("id")) if isinstance(item, dict) else None
        if key in wanted:
            wanted.discard(key)
            title = title_of(item.get("title"))
            if title:
                notes.append({"id": key, "title": title})
    return notes


async def ask_claude(prompt: str, ids: list[str], config: Whybook) -> AsyncIterator[dict[str, Any]]:
    async for event in connection.structured_call(prompt, schema=SCHEMA, system_prompt=PROMPT, config=config, effort=config.describe_effort):
        if event["type"] == "result":
            event["cells"] = notes_from_output(event.pop("output"), ids)
        yield event
