"""A model's order of the questions that a request offers.

The view's rules score the questions of every request at once
(``rankers.score_candidate``). With a model chosen for "Question order" in
the settings, the view then sends the questions it offers here, and sorts
them by the model's probability that the analyst asks each one next when the
answer comes. The model is the remote one, a local model in the Jupyter
server (``local_models.rank_questions``), or a decision model
(``decision_models.py``), with one choice over the questions (``choice_body``).

What each sees: the questions, the names, kinds and sizes of the variables
selected, the titles of the last 20 cells, the questions already asked, and
the mode. No data leaves the machine with a local model.
"""

from __future__ import annotations

import json
import time
from typing import Any, AsyncIterator, Awaitable, Callable

from tornado.httpclient import AsyncHTTPClient

from .. import connection, decision_models, local_models, privacy, tiers
from ..config import Whybook
from ..decision_models import DecisionModel
from .marks import plain
from .models import Context, InvalidRequest, Selection

MAX_QUESTIONS = 30
MAX_TEXT = 300

# The prediction prompt of research/ranking-placement.md, "Language models as
# rankers": what the analyst asks next, the default. On 300 drops rebuilt from
# public notebooks, agents of Claude Opus 5.5 that read the requests 100 at a
# time put the analyst's type first for 60.7% of them with this prompt, and for
# 44.0% with SHOULD_PROMPT. One request at a time through OpenRouter, as this
# route asks, Claude Opus 5.5 gives 48.2%, and GPT-6 Astra, Grok 4.7 and
# MiMo-V2.6-Pro 45.3% to 47.3%, where the learned ranker of the default order
# gives 57.0% ("Frontier models of other providers" there). The mode stays in
# the state that the model reads.
SYSTEM_PROMPT = """\
You predict the question that an analyst asks next in a data analysis notebook.
The view offers questions about the variables that the analyst selected. For
each question, give the probability that the analyst's next question is this
one, judging from the notebook so far and the questions already asked. Answer
with one JSON object."""

# What the analyst should ask, weighing the mode, as the setting rankingPrompt
# "should" asks. The test of the order scores a ranker against the question
# that a notebook's author asked next, and this prompt asks for what nobody
# asked yet in Wonder mode, so it scores lower there by design: 29.3% of 99
# drops for Claude Opus 5.5 one request at a time, against 55.6% with
# SYSTEM_PROMPT on the same drops ("The prompt: what the analyst asks next, or
# should ask" there).
SHOULD_PROMPT = """\
You order the questions that a data analysis view offers an analyst. For
each question, give the probability that the analyst should ask it next:
high when the analysis depends on the answer and nothing answers it yet,
low when it is already answered, does not apply to the selected variables,
or is minor. Use the mode: Do continues the current line of work, Report
favours results that belong in a report, Wonder favours what nobody asked
yet. Answer with one JSON object."""
PROMPTS = {"next": SYSTEM_PROMPT, "should": SHOULD_PROMPT}

SCHEMA = {
    "type": "object",
    "properties": {
        "scores": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "string"}, "probability": {"type": "number", "minimum": 0, "maximum": 1}},
                "required": ["id", "probability"],
            },
        }
    },
    "required": ["scores"],
}


def request_from_json(body: Any) -> dict[str, Any]:
    """The model, the questions and what they are about; raises InvalidRequest."""
    if not isinstance(body, dict):
        raise InvalidRequest("the body must be an object")
    model = body.get("model")
    if not isinstance(model, str) or not model:
        raise InvalidRequest("the body needs the model")
    questions = []
    for item in (body.get("questions") or [])[:MAX_QUESTIONS]:
        if not isinstance(item, dict) or not item.get("id") or not item.get("text"):
            raise InvalidRequest("every question needs an id and a text")
        # Without the marks of names and values: the models were measured on texts that had none.
        questions.append({"id": str(item["id"]), "text": plain(str(item["text"]))[:MAX_TEXT], "type": str(item.get("type") or "")})
    if not questions:
        raise InvalidRequest("the body needs the questions")
    selection = Selection.from_json(body["selection"]) if body.get("selection") else None
    prompt = body.get("prompt", "next")
    if prompt not in PROMPTS:
        raise InvalidRequest(f"the prompt is one of {', '.join(PROMPTS)}")
    return {"model": model, "questions": questions, "selection": selection, "context": Context.from_json(body.get("context")), "prompt": prompt}


def state_of(request: dict[str, Any]) -> dict[str, Any]:
    """What the models read of the notebook; with the data on this machine, the selection as names, kinds and sizes."""
    context: Context = request["context"]
    state: dict[str, Any] = {
        "analysis_so_far": [plain(title) for title in context.cells[-20:]],
        "already_asked": [plain(question.text) for question in context.asked],
        "mode": context.mode,
    }
    selection: Selection | None = request["selection"]
    if selection is not None:
        selected = [selection.source.to_state()]
        if not selection.univariate and selection.target is not None:
            selected.append(selection.target.to_state())
        state = {"selected": selected, **state}
    return privacy.local_state(state) if request.get("keep_local") else state


def state_text(state: dict[str, Any]) -> str:
    """The state as a local model reads it: short lines, not JSON."""
    lines = []
    for item in state.get("selected", []):
        lines.append(f"Selected: {json.dumps(item)}")
    cells = state["analysis_so_far"]
    lines.append("Cells so far: " + ("; ".join(cells[-10:]) if cells else "none"))
    asked = state["already_asked"]
    lines.append("Asked already: " + ("; ".join(asked[-10:]) if asked else "nothing"))
    lines.append(f"Mode: {state['mode']}")
    return "\n".join(lines)


Fetch = Callable[..., Awaitable[Any]]


# The instruction to a decision model, as research/choice-classifiers.md measured
# it ("one choice over the questions"). A yes or no for each question puts the
# analyst's type first less often for most models.
NEXT_INSTRUCTION = "Which of these questions does the analyst ask next about `selected`, judging from `analysis_so_far` and `already_asked`?"


def choice_body(request: dict[str, Any]) -> dict[str, Any]:
    """One choice over the offered questions, with the state that the models read."""
    criteria = {f"q{index}": question["text"] for index, question in enumerate(request["questions"])}
    return {"state": state_of(request), "questions": {"next": {"type": "choice", "instructions": NEXT_INSTRUCTION, "criteria": criteria}}}


async def ask_decision(model: DecisionModel, request: dict[str, Any], config: Whybook, fetch: Fetch | None = None) -> dict[str, Any]:
    """A decision model's probability of each question, with the model that answered and the cost."""
    answer = await decision_models.ask(model, choice_body(request), config, fetch)
    found = (answer["answers"].get("next") or {}).get("probabilities") or {}
    probabilities = [found.get(f"q{index}") for index in range(len(request["questions"]))]
    return {**answer, "probabilities": [None if p is None else float(p) for p in probabilities]}


def scores_from_output(output: Any, ids: list[str]) -> list[float | None]:
    """The remote model's probability for each question, in the order of ``ids``."""
    found: dict[str, float] = {}
    for item in (output or {}).get("scores") or []:
        try:
            found[str(item["id"])] = min(1.0, max(0.0, float(item["probability"])))
        except (KeyError, TypeError, ValueError):
            continue
    return [found.get(question_id) for question_id in ids]


async def rank_events(request: dict[str, Any], config: Whybook, fetch: Fetch | None = None) -> AsyncIterator[dict[str, Any]]:
    """Progress, then one result with the probability of each question, or one error."""
    start = time.monotonic()
    model = request["model"]
    ids = [question["id"] for question in request["questions"]]

    def result(probabilities: list[float | None], label: str | None, cost: float | None = 0.0, **extra: Any) -> dict[str, Any]:
        # A local model costs nothing.
        scores = {question_id: round(p, 4) for question_id, p in zip(ids, probabilities) if p is not None}
        return {"type": "result", "scores": scores, "model": label, "cost_usd": cost, **extra, "elapsed": round(time.monotonic() - start, 2)}

    # The connected model, or another model of its provider (tiers.py), which the request's config names.
    if tiers.is_remote(model):
        prompt = json.dumps({"state": state_of(request), "questions": request["questions"]}, indent=1)
        system = PROMPTS[request.get("prompt", "next")]
        async for event in connection.structured_call(prompt, schema=SCHEMA, system_prompt=system, config=config, effort=config.question_effort):
            if event["type"] == "result":
                yield {**result(scores_from_output(event.get("output"), ids), event.get("model")), "cost_usd": event.get("cost_usd")}
            else:
                yield event
        return
    yield {"type": "progress", "stage": "starting", "message": f"ordering {len(ids)} questions", "elapsed": 0.0}
    try:
        decision = decision_models.model_of(model)
        if decision is not None:
            answer = await ask_decision(decision, request, config, fetch)
            yield result(answer["probabilities"], answer["model"], answer["cost_usd"])
        elif local_models.model_of(model) is not None:
            texts = [question["text"] for question in request["questions"]]
            answer = await local_models.ask_rank(model, state_text(state_of(request)), texts, config.local_threads)
            yield result(answer["probabilities"], answer["model"], file=answer["file"])
        else:
            yield {"type": "error", "message": f"no model named {model!r} orders questions"}
    except Exception as error:  # noqa: BLE001  the model's failure goes to the view, which keeps the rules' order
        yield {"type": "error", "message": str(error), "elapsed": round(time.monotonic() - start, 2)}
