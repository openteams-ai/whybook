"""A model's order of the questions that a request offers.

The view's rules score the questions of every request at once
(``rankers.score_candidate``). With a model chosen for "Question order" in
the settings, the view then sends the questions it offers here, and sorts
them by the model's probability that the analyst asks each one next when the
answer comes. The model is the remote one, a local model in the Jupyter
server (``local_models.rank_questions``), or Jev from TypeSafe, with one
yes-or-no question for each candidate (``jev_body``).

What each sees: the questions, the names, kinds and sizes of the variables
selected, the titles of the last 20 cells, the questions already asked, and
the mode. No data leaves the machine with a local model.
"""

from __future__ import annotations

import json
import time
from typing import Any, AsyncIterator, Awaitable, Callable

from tornado.httpclient import AsyncHTTPClient

from .. import connection, local_models, privacy, tiers
from ..config import Whybook
from .models import Context, InvalidRequest, Selection
from .rankers import CLOUDFLARE_RUN_URL, jev_probabilities

MAX_QUESTIONS = 30
MAX_TEXT = 300

# The prediction prompt of research/ranking-placement.md, "Language models as
# rankers". On 300 drops rebuilt from public notebooks, a remote model asked what
# the analyst will ask next put the analyst's type first for 60.7% of them, the
# learned ranker of the default order 57.0%, and the earlier prompt, which
# asked what the analyst should ask and weighed the mode, 44.0%. The mode stays
# in the state that the model reads.
SYSTEM_PROMPT = """\
You predict the question that an analyst asks next in a data analysis notebook.
The view offers questions about the variables that the analyst selected. For
each question, give the probability that the analyst's next question is this
one, judging from the notebook so far and the questions already asked. Answer
with one JSON object."""

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
        questions.append({"id": str(item["id"]), "text": str(item["text"])[:MAX_TEXT], "type": str(item.get("type") or "")})
    if not questions:
        raise InvalidRequest("the body needs the questions")
    selection = Selection.from_json(body["selection"]) if body.get("selection") else None
    return {"model": model, "questions": questions, "selection": selection, "context": Context.from_json(body.get("context"))}


def state_of(request: dict[str, Any]) -> dict[str, Any]:
    """What the models read of the notebook, as Jev's state; with the data on this machine, the selection as names, kinds and sizes."""
    context: Context = request["context"]
    state: dict[str, Any] = {
        "analysis_so_far": list(context.cells[-20:]),
        "already_asked": [question.text for question in context.asked],
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


def jev_body(request: dict[str, Any], model: str) -> dict[str, Any]:
    """One yes-or-no question per candidate, with the state that Jev reads."""
    questions = {
        f"q{index}": {
            "type": "noul",
            "instructions": (
                "Should the analyst ask this question next about `selected`,"
                " given `analysis_so_far`, `already_asked` and their `mode`?"
                f" Question: {question['text']}"
            ),
            "criteria": {
                "true": "Useful now: the analysis depends on the answer, and it is not answered yet",
                "false": "Not useful now: already answered, does not apply to these variables, or minor",
            },
        }
        for index, question in enumerate(request["questions"])
    }
    return {"state": state_of(request), "model": model, "questions": questions}


async def ask_jev(request: dict[str, Any], config: Whybook, fetch: Fetch | None = None) -> dict[str, Any]:
    """Jev's probabilities, through the TypeSafe API, or else through Cloudflare's."""
    fetch = fetch or AsyncHTTPClient().fetch
    if config.typesafe_api_key:
        body = jev_body(request, config.typesafe_model)
        url = config.typesafe_base_url.rstrip("/") + "/v1/systemone"
        token = config.typesafe_api_key
        model = config.typesafe_model
    elif config.jev_configured:
        body = {"model": config.jev_model, "input": {key: value for key, value in jev_body(request, config.jev_model).items() if key != "model"}}
        url = CLOUDFLARE_RUN_URL.format(account_id=config.jev_account_id)
        token = config.jev_api_token
        model = config.jev_model
    else:
        raise InvalidRequest("Jev needs a TypeSafe API key on the server: TYPESAFE_API_KEY")
    response = await fetch(
        url,
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"},
        body=json.dumps(body),
        request_timeout=config.jev_timeout,
    )
    decoded = json.loads(response.body)
    probabilities = jev_probabilities(decoded, len(request["questions"]))
    return {"probabilities": probabilities, "model": decoded.get("model") or model}


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
        # A local model costs nothing; Jev's price is not known here.
        scores = {question_id: round(p, 4) for question_id, p in zip(ids, probabilities) if p is not None}
        return {"type": "result", "scores": scores, "model": label, "cost_usd": cost, **extra, "elapsed": round(time.monotonic() - start, 2)}

    # The connected model, or another model of its provider (tiers.py), which the request's config names.
    if tiers.is_remote(model):
        prompt = json.dumps({"state": state_of(request), "questions": request["questions"]}, indent=1)
        async for event in connection.structured_call(prompt, schema=SCHEMA, system_prompt=SYSTEM_PROMPT, config=config, effort=config.question_effort):
            if event["type"] == "result":
                yield {**result(scores_from_output(event.get("output"), ids), event.get("model")), "cost_usd": event.get("cost_usd")}
            else:
                yield event
        return
    yield {"type": "progress", "stage": "starting", "message": f"ordering {len(ids)} questions", "elapsed": 0.0}
    try:
        if model == "jev":
            answer = await ask_jev(request, config, fetch)
            yield result(answer["probabilities"], answer["model"], None)
        elif local_models.model_of(model) is not None:
            texts = [question["text"] for question in request["questions"]]
            answer = await local_models.ask_rank(model, state_text(state_of(request)), texts, config.local_threads)
            yield result(answer["probabilities"], answer["model"], file=answer["file"])
        else:
            yield {"type": "error", "message": f"no model named {model!r} orders questions"}
    except Exception as error:  # noqa: BLE001  the model's failure goes to the view, which keeps the rules' order
        yield {"type": "error", "message": str(error), "elapsed": round(time.monotonic() - start, 2)}
