"""What a reviewer would ask about a whole notebook: one call to the model of More questions.

The Check-up section of the Exploration panel asks it when the analyst
presses Ask on "What would a reviewer ask?", never by itself (design
iteration 1.67). The model reads the code of the code cells, their titles,
the kinds of their outputs and what the outputs print, with what the view's
rules found already, and asks at most five questions, each about one cell.
The view lists the questions under the reviewer's card, each with the cell
it is about, such as "About [5]", and a click asks it as the view's other
questions are asked.

With the data kept on this machine, a model elsewhere reads the code, the
titles and the kinds of the outputs, and no text of an output: the text
holds values, as a printed table does. A model on this machine reads it all.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, AsyncIterator

from .. import claude, connection, local_models
from ..config import Whybook
from .claude_questions import frames_state
from .models import TYPES, Context, InvalidRequest

SYSTEM_PROMPT = """\
You review a data analysis in a Jupyter notebook, as a careful reviewer of a paper would. You
never answer the questions.

Ask at most 5 questions that a reviewer would ask about this analysis: about the design, the
data, the models, the checks that were not run, and the claims that the outputs support. Each
question is about one cell, which "cell" names by its label, such as "[5]", and can be answered
with the notebook's data. Each question has at most 20 words, and names the variables and the
columns as the code names them.
"cells" lists the code cells in order: their label, title and code, the kinds of their outputs,
and what the outputs print, when the notebook lets you read it.
"findings" lists what the view's rules found already: do not repeat them, ask what they miss.
"frames" lists the data frames in the kernel, with their rows and the kind of each column.
"outcome" and "unit" name the column that the analysis explains and what the rows repeat over,
when the view knows them.
type is one of "descriptive", "association", "causal", "model" and "quality".
why is one sentence of at most 20 words.

Answer once, with one JSON object whose only key is "questions": a list of objects, each with
"text", "type", "cell" and "why". Never send one question on its own."""

QUESTION = {
    "type": "object",
    "properties": {
        "text": {"type": "string"},
        "type": {"type": "string", "enum": list(TYPES)},
        "cell": {"type": "string"},
        "why": {"type": "string"},
    },
    "required": ["text", "type", "cell", "why"],
    "additionalProperties": False,
}

SCHEMA = {
    "type": "object",
    "properties": {"questions": {"type": "array", "items": QUESTION}},
    "required": ["questions"],
    "additionalProperties": False,
}

# How much of the notebook the model reads.
MAX_CELLS = 40
CODE_CHARS = 1500
TEXT_CHARS = 600
MAX_FINDINGS = 20
FINDING_CHARS = 300
MAX_QUESTIONS = 5
# A local model's context is 4,096 tokens: it reads the last cells, shorter.
LOCAL_CELLS = 12
LOCAL_CODE_CHARS = 400
LOCAL_TEXT_CHARS = 200
# The kinds of outputs that the view names (OutputKind in src/model/notebook.ts).
OUTPUT_KINDS = frozenset({"plot", "chart", "widget", "image", "table", "log", "text", "error", "progress"})


@dataclass(frozen=True)
class ReviewCell:
    """A code cell as the reviewer reads it."""

    id: str
    label: str
    title: str
    code: str
    outputs: tuple[str, ...]
    text: str


@dataclass(frozen=True)
class ReviewRequest:
    model: str
    cells: tuple[ReviewCell, ...]
    findings: tuple[str, ...]
    context: Context

    @property
    def labels(self) -> frozenset[str]:
        return frozenset(cell.label for cell in self.cells)


def request_from_json(body: Any) -> ReviewRequest:
    """The request as the view sends it: the code cells, what the rules found, and the notebook's context."""
    if not isinstance(body, dict):
        raise InvalidRequest("the body must be an object")
    cells = body.get("cells")
    if not isinstance(cells, list) or not cells:
        raise InvalidRequest("the review needs the notebook's code cells")
    read: list[ReviewCell] = []
    for item in cells[-MAX_CELLS:]:
        if not isinstance(item, dict) or not isinstance(item.get("code"), str) or not isinstance(item.get("label"), str):
            raise InvalidRequest("each cell needs a label and its code")
        outputs = item.get("outputs") if isinstance(item.get("outputs"), list) else []
        read.append(
            ReviewCell(
                id=str(item.get("id") or ""),
                label=item["label"][:12],
                title=str(item.get("title") or "")[:160],
                code=item["code"][:CODE_CHARS],
                outputs=tuple(str(kind) for kind in outputs if str(kind) in OUTPUT_KINDS),
                text=str(item.get("text") or "")[:TEXT_CHARS],
            )
        )
    findings = body.get("findings") if isinstance(body.get("findings"), list) else []
    return ReviewRequest(
        model=str(body.get("model") or "remote"),
        cells=tuple(read),
        findings=tuple(str(finding)[:FINDING_CHARS] for finding in findings[:MAX_FINDINGS]),
        context=Context.from_json(body.get("context")),
    )


def state_of(request: ReviewRequest, keep_local: bool) -> dict[str, Any]:
    """What the model reads. With the data kept here, no output's text goes."""
    context = request.context
    cells = []
    for cell in request.cells:
        entry: dict[str, Any] = {"label": cell.label, "title": cell.title, "code": cell.code, "outputs": list(cell.outputs)}
        if cell.text and not keep_local:
            entry["prints"] = cell.text
        cells.append(entry)
    state: dict[str, Any] = {
        "cells": cells,
        "findings": list(request.findings),
        "frames": frames_state(context),
        "mode": context.mode,
        "already_asked": [question.text for question in context.asked][-20:],
    }
    if context.outcome:
        state["outcome"] = context.outcome
    if context.unit:
        state["unit"] = context.unit
    return state


def _questions(output: dict, request: ReviewRequest, origin: str) -> list[dict[str, Any]]:
    """The model's questions, at most five, each with the label of a cell that the request holds, or null."""
    asked = {question.text.strip().lower() for question in request.context.asked}
    labels = request.labels
    questions = []
    for item in output.get("questions") or []:
        text = str(item.get("text") or "").strip()
        if not text or text.lower() in asked:
            continue
        label = item.get("cell") if item.get("cell") in labels else None
        digest = hashlib.sha1(text.encode()).hexdigest()[:10]
        questions.append(
            {
                "id": f"review:{digest}",
                "text": text,
                "type": item.get("type") if item.get("type") in TYPES else "model",
                "cell": label,
                "why": str(item.get("why") or "")[:200],
                "origin": origin,
            }
        )
        if len(questions) == MAX_QUESTIONS:
            break
    return questions


def _misfit(problems: list[str]) -> dict:
    return {"type": "error", "message": f"The AI model's questions did not come in the form asked for: {'; '.join(problems[:3])}."}


async def generate(request: ReviewRequest, config: Whybook, keep_local: bool = False) -> AsyncIterator[claude.Event]:
    """Stream progress events, then a result event with the reviewer's questions."""
    prompt = json.dumps(state_of(request, keep_local), indent=1)
    async for event in connection.structured_call(
        prompt,
        schema=SCHEMA,
        system_prompt=SYSTEM_PROMPT,
        config=config,
        effort=config.question_effort,
    ):
        if event["type"] == "result":
            output = event.pop("output")
            problems = claude.matches(output, SCHEMA)
            if problems:
                yield _misfit(problems)
                return
            event["questions"] = _questions(output, request, "claude")
        yield event


# A local model gets a grammar that holds each question to the schema and to
# a length, and reads fewer cells, shorter.
WORD = local_models.WORD
LOCAL_SYSTEM_PROMPT = SYSTEM_PROMPT


def local_schema(labels: frozenset[str]) -> dict[str, Any]:
    """The grammar of a local model's answer: the cell is one of the labels sent."""
    return {
        "type": "object",
        "properties": {
            "questions": {
                "type": "array",
                "minItems": 1,
                "maxItems": MAX_QUESTIONS,
                "items": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string", "pattern": rf"^{WORD}( {WORD}){{2,19}}$"},
                        "type": {"type": "string", "enum": list(TYPES)},
                        "cell": {"type": "string", "enum": sorted(labels)},
                        "why": {"type": "string", "pattern": rf"^{WORD}( {WORD}){{0,19}}$"},
                    },
                    "required": ["text", "type", "cell", "why"],
                },
            }
        },
        "required": ["questions"],
    }


def local_state(request: ReviewRequest) -> dict[str, Any]:
    """What a local model reads: the last cells, with shorter code and text."""
    state = state_of(request, keep_local=False)
    cells = state["cells"][-LOCAL_CELLS:]
    state["cells"] = [
        {**cell, "code": cell["code"][:LOCAL_CODE_CHARS], **({"prints": cell["prints"][:LOCAL_TEXT_CHARS]} if "prints" in cell else {})}
        for cell in cells
    ]
    state["already_asked"] = state["already_asked"][-8:]
    return state


async def generate_local(request: ReviewRequest, threads: int, check: str = "fast") -> AsyncIterator[dict]:
    """Stream progress events, then a result event with a local model's questions."""
    async for event in local_models.ask_json(
        request.model, LOCAL_SYSTEM_PROMPT, local_state(request), local_schema(request.labels), 500, threads, "reading the notebook", check
    ):
        if event["type"] == "result":
            output = event.pop("output")
            problems = claude.matches(output, local_schema(request.labels))
            if problems:
                yield _misfit(problems)
                return
            event["questions"] = _questions(output, request, "local")
        yield event
