"""The type and the place of a question that the analyst types, from a model.

The view's keywords and first-word rules come first (``guessType`` and
``guessPlace`` in src/model/own.ts). When the keywords do not match, the model
chosen for typed questions in the settings gives the type: a local model
(``local_models.classify``) or Jev from TypeSafe. Jev also gives the place
when no first-word rule matches.

research/local-predictors-2.md measured the local models on 120 typed
questions. With the keywords first, Gemma 4 E2B types 69% right and Qwen3.5
0.8B 49%, where the keywords alone type 45%. No local model placed a cell
better than the rules, which are right for 84%, so a local model gives only
the type. Jev has not run on these questions: there is no TypeSafe account.
"""

from __future__ import annotations

import json
import time
from typing import Any, Awaitable, Callable

from tornado.httpclient import AsyncHTTPClient

from .config import Whybook
from .questions.models import InvalidRequest

TYPE_INSTRUCTION = "Sort a question that a data analyst asked about a notebook by the kind of question it is."

TYPES = {
    "descriptive": "what the data hold or look like, one thing at a time: counts, sizes, distributions, ranges",
    "association": "how two or more variables go together or differ between groups, or change over time",
    "causal": "whether one thing changes another: the effect of a treatment or an intervention, confounding",
    "model": "how a statistical model is specified, checked or compared, or how much a result depends on a threshold or a constant",
    "quality": "whether the data can be trusted: missing, impossible, duplicated or inconsistent values, keys that do not match",
}

# One solved example per type, from the view's own questions: none of them is
# among the 120 typed questions of the measurement.
TYPE_EXAMPLES = [
    ("How many observations fall in each level of site?", "descriptive"),
    ("Does pain_score differ between the levels of treatment_arm?", "association"),
    ("Could another variable explain the link between age and pain_score?", "causal"),
    ("Should site enter a model of pain_score as a random effect?", "model"),
    ("Does diary contain duplicated rows?", "quality"),
]

PLACE_INSTRUCTION = "A data analyst asked a question about a cell of a notebook. Choose where the answer should go."

PLACES = {
    "edit": "change what the cell computes, in place",
    "new": "a new cell after it, for a new step of the analysis",
    "branch": "a variant of the cell beside it, keeping the original, to compare the two",
    "preview": "a quick look that the notebook does not need to keep",
}

# The first lines of the cell that a question is about, as the measurement sent them.
CELL_LINES = 20
MAX_QUESTION = 500


def request_from_json(body: Any) -> dict[str, Any]:
    """The question, the code of its cell, and the places the view can use."""
    if not isinstance(body, dict):
        raise InvalidRequest("the body must be an object")
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise InvalidRequest("give the question as text")
    cell = body.get("cell")
    if cell is not None and not isinstance(cell, str):
        raise InvalidRequest("give the cell as its source, or null")
    places = [place for place in body.get("places") or [] if place in PLACES]
    return {
        "text": " ".join(text.split())[:MAX_QUESTION],
        "cell": "\n".join(cell.splitlines()[:CELL_LINES]) if cell else None,
        "places": places,
    }


def jev_status(config: Whybook) -> dict[str, Any]:
    """Whether Jev can run, and why not."""
    if not config.typesafe_api_key:
        return {"available": False, "reason": "needs a TypeSafe API key on the server: TYPESAFE_API_KEY"}
    return {"available": True, "reason": None}


def jev_body(request: dict[str, Any], model: str) -> dict[str, Any]:
    """One request with a choice question for the type and, when places are offered, one for the place.

    Jev judges the state and answers the questions about it, so the question
    the analyst typed is part of the state, and the instructions say what to decide.
    """
    state: dict[str, Any] = {"question": request["text"]}
    if request["cell"]:
        state["cell"] = request["cell"]
    questions: dict[str, Any] = {"type": {"type": "choice", "instructions": TYPE_INSTRUCTION, "criteria": dict(TYPES)}}
    if len(request["places"]) > 1:
        questions["place"] = {
            "type": "choice",
            "instructions": PLACE_INSTRUCTION,
            "criteria": {place: PLACES[place] for place in request["places"]},
        }
    return {"state": state, "model": model, "questions": questions}


def jev_answers(response: dict[str, Any]) -> dict[str, Any]:
    """The choice and the probability of each option, for the type and the place."""
    answers = response.get("answers")
    if not isinstance(answers, dict):
        raise ValueError("Jev's answer has no answers")
    found: dict[str, Any] = {"type": None, "place": None}
    for name in ("type", "place"):
        answer = answers.get(name)
        if answer is None:
            continue
        if answer.get("type") != "choice" or not isinstance(answer.get("probabilities"), dict):
            raise ValueError(f"Jev's answer about the {name} is not a choice")
        found[name] = {
            "choice": str(answer["choice"]),
            "probabilities": {str(key): float(value) for key, value in answer["probabilities"].items()},
        }
    return found


Fetch = Callable[..., Awaitable[Any]]


async def ask_jev(request: dict[str, Any], config: Whybook, fetch: Fetch | None = None) -> dict[str, Any]:
    """Jev's type and place for a typed question, through the TypeSafe API."""
    start = time.monotonic()
    fetch = fetch or AsyncHTTPClient().fetch
    response = await fetch(
        config.typesafe_base_url.rstrip("/") + "/v1/systemone",
        method="POST",
        headers={
            "Authorization": f"Bearer {config.typesafe_api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        body=json.dumps(jev_body(request, config.typesafe_model)),
        request_timeout=config.jev_timeout,
    )
    decoded = json.loads(response.body)
    return {**jev_answers(decoded), "model": decoded.get("model") or config.typesafe_model, "elapsed": round(time.monotonic() - start, 2)}
