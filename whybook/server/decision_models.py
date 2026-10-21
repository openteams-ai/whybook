"""Decision models: classifiers that choose one of the options they are given.

Whybook asks one for the type and the place of a question that the analyst
types (``sorting.py``), and for the order of the questions it offers
(``questions/ranking.py``): one request, with the probability of each option.
They answer through OpenRouter's decision endpoint, with the OpenRouter key of
the AI models panel. With zero data retention on, the default, OpenRouter
sends the request only to an endpoint that keeps nothing, and a model with no
such endpoint is not offered. A model that its maker also serves through an
API of its own, such as Jev through TypeSafe's, goes there when the server
holds that API's key and there is no OpenRouter key. With
``c.Whybook.way_to_use_models = "all-local"`` a decision model runs only
through that API, and only when its URL is on this machine or in its network
(``network.py``): OpenRouter is outside.

research/choice-classifiers.md measured each model on Whybook's tasks.
"""

from __future__ import annotations

import dataclasses
import json
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from tornado.httpclient import AsyncHTTPClient

from . import network
from .config import Whybook

ENDPOINT = "https://openrouter.ai/api/v1/systemone"
# The prefix of a decision model's id in the settings (src/model/models.ts).
PREFIX = "decision:"


@dataclass(frozen=True)
class DecisionModel:
    id: str
    label: str
    # The model's id on OpenRouter.
    openrouter: str
    # OpenRouter lists an endpoint of the model with zero data retention
    # (https://openrouter.ai/api/v1/endpoints/zdr, read on 21 October 2026).
    zdr: bool
    # The model on its maker's own API, TypeSafe's for now: config.typesafe_*.
    typesafe: bool = False


MODELS = {
    model.id: model
    for model in (
        DecisionModel("jev", "Jev 1.13 by TypeSafe", "typesafe/jev-1.13", True, typesafe=True),
        DecisionModel("solar-decide", "Solar Decide by Upstage", "upstage/solar-decide", True),
        DecisionModel("clef", "Clef by Cloudflare", "cloudflare/clef", True),
        DecisionModel("clef-flash", "Clef Flash by Cloudflare", "cloudflare/clef-flash", True),
        # OpenRouter no longer serves V1 and V1.1, which research/choice-classifiers.md
        # and local-predictors-2.md measured; research/model-candidates.md measured
        # V1.2. The id keeps the analyst's choice.
        DecisionModel("pplx-decider", "Decider V1.2 27B by Perplexity", "perplexity/pplx-decider-v1.2", True),
        DecisionModel("luna-decisions", "GPT-6 Luna Decisions by OpenAI", "openai/gpt-6-luna-decisions", False),
        DecisionModel("mercury-decide", "Mercury Decide by Inception", "inception/mercury-decide", True),
        DecisionModel("d1", "D1 by Liquid AI", "liquid/d1", True),
        DecisionModel("kev", "Kev 4B", "jaredpalmer/kev-4b", True),
        DecisionModel("tev1", "Tev1 4B by Together AI", "togethercomputer/tev1-4b-experimental", True),
    )
}

Fetch = Callable[..., Awaitable[Any]]


def model_of(choice: str | None) -> DecisionModel | None:
    """The decision model of a choice of the settings, such as "decision:jev"; a saved choice of "jev" names Jev too."""
    if not isinstance(choice, str):
        return None
    return MODELS.get(choice[len(PREFIX) :] if choice.startswith(PREFIX) else choice if choice == "jev" else "")


def openrouter_key() -> str | None:
    """The OpenRouter key of the AI models panel, if the analyst signed in with OpenRouter."""
    from .keystore import KeyStore

    return KeyStore().get("openrouter")


# Why a decision model cannot run when the server allows only models on this machine or in its network.
OUTSIDE = 'runs outside this machine and its network, and the server allows only models there (c.Whybook.way_to_use_models = "all-local")'


def reason_of(model: DecisionModel, config: Whybook, key: str | None) -> str | None:
    """Why the model cannot run, or None."""
    if config.network_only:
        if model.typesafe and config.typesafe_api_key and network.on_network(config.typesafe_base_url):
            return None
        return OUTSIDE
    if key:
        if config.zdr and not model.zdr:
            return "OpenRouter lists no endpoint of it with zero data retention, which the AI models panel asks for"
        return None
    if model.typesafe and config.typesafe_api_key:
        return None
    return "needs an OpenRouter key: sign in with OpenRouter in the AI models panel"


def status(config: Whybook) -> dict[str, dict[str, Any]]:
    """Each decision model by id, with its label, and whether it can run and why not."""
    key = openrouter_key()
    found = {}
    for model in MODELS.values():
        reason = reason_of(model, config, key)
        found[model.id] = {"label": model.label, "available": reason is None, "reason": reason}
    return found


async def check_request(model: DecisionModel, body: dict[str, Any], config: Whybook, to: str) -> None:
    """The privacy guard on a request before it leaves this machine: a ValueError when the guard holds it back.

    Nobody waits on a decision model, so the guard asks no question, and the
    request goes only as it is: a mask can break its JSON. The callers then
    keep what the rules give, the keywords' type or the rules' order.
    """
    from . import guard

    settings = guard.settings_of(config)
    if not settings.checks_prompts:
        return
    text = json.dumps(body)
    held = await guard.check_prompt(
        text, dataclasses.replace(settings, background=True), lambda event: None, to=to, what=f"a request to {model.label}", threads=config.local_threads
    )
    if not held.go or held.text != text:
        raise ValueError(f"{model.label} got no request: the review guard held it back ({held.reason})")


async def ask(model: DecisionModel, body: dict[str, Any], config: Whybook, fetch: Fetch | None = None) -> dict[str, Any]:
    """A model's answers to a request of a state and its questions, with the model that answered, the cost and the seconds."""
    key = openrouter_key()
    reason = reason_of(model, config, key)
    if reason:
        raise ValueError(f"{model.label} {reason}")
    if key and not config.network_only:
        url, token, payload = ENDPOINT, key, {**body, "model": model.openrouter}
        if config.zdr:
            payload["provider"] = {"zdr": True}
    else:
        url = config.typesafe_base_url.rstrip("/") + "/v1/systemone"
        token, payload = config.typesafe_api_key, {**body, "model": config.typesafe_model}
    if not config.network_only:
        await check_request(model, body, config, "OpenRouter" if url == ENDPOINT else "TypeSafe")
    start = time.monotonic()
    response = await (fetch or AsyncHTTPClient().fetch)(
        url,
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"},
        body=json.dumps(payload),
        request_timeout=config.decision_timeout,
    )
    decoded = json.loads(response.body)
    answers = decoded.get("answers")
    if not isinstance(answers, dict):
        raise ValueError(f"{model.label} gave no answers")
    usage = decoded.get("usage") or {}
    return {
        "answers": answers,
        "model": decoded.get("model") or payload["model"],
        "cost_usd": usage.get("cost"),
        "elapsed": round(time.monotonic() - start, 2),
    }
