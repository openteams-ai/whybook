"""A model of the connected provider for each task that needs speed more than depth (design iteration 1.81).

Code and answers need the most capable model: the connected one. More
questions need a fast one, and labels and titles the fastest. A task's
choice in the view's settings (``models`` in schema/plugin.json) is:

- ``remote``: the connected model;
- a tier, ``remote:fast`` or ``remote:fastest``: the first model that
  RECOMMENDED lists for the connected provider in that tier, or the connected
  model when it lists none;
- one model of the connected provider, ``remote:<provider>:<model>``, such as
  ``remote:openrouter:z-ai/glm-5.3-flash``, with the provider's key.

The provider in a model's choice keeps the choice from going to another
provider after the analyst connects one: the call is refused, with the
reason. A request names its task's choice as ``model``, and the calls of the
request read it from the request's config (``connection.for_request``).
"""

from __future__ import annotations

from typing import Any

TIERS = ("fast", "fastest")
PREFIX = "remote:"

# The models of each tier, by provider, the first being the tier's default:
# research/model_access/demo-model.md timed them on Whybook's own routes on
# 1 October 2026, GPT-6 Luna and GLM 5.3 Flash with zero data retention on,
# Mercury 2.5 and Gemini 3.5 Flash-Lite with it off and on. The notes are
# what the panel says of each.
RECOMMENDED: dict[str, dict[str, list[dict[str, str]]]] = {
    "openrouter": {
        "fast": [
            {
                "id": "inception/mercury-2.5",
                "label": "Mercury 2.5",
                "note": "questions in about 4 s in the demo, at $0.04 in and $0.15 out per million tokens; one provider, which turned 2 of 7 calls away for a moment",
            },
            {
                "id": "openai/gpt-6-luna",
                "label": "GPT-6 Luna",
                "note": "questions in about 7 s in the demo, at $0.10 in and $0.50 out per million tokens; one provider keeps no data, and it often turns calls away for a moment",
            },
            {
                "id": "z-ai/glm-5.3-flash",
                "label": "GLM 5.3 Flash",
                "note": "questions in about 12 s in the demo, at $0.15 in and $0.50 out per million tokens; 26 providers keep no data",
            },
        ],
        "fastest": [
            {
                "id": "google/gemini-3.5-flash-lite",
                "label": "Gemini 3.5 Flash-Lite",
                "note": "labels in about 2 s and titles in about 1 s in the demo, at $0.30 in and $2.50 out per million tokens; 5 providers",
            },
        ],
    },
}


class OtherProvider(ValueError):
    """A task's model belongs to a provider other than the connected one."""


def is_remote(choice: Any) -> bool:
    """Whether a task's choice is the connected provider: its model, a tier, or one of its models."""
    return choice == "remote" or (isinstance(choice, str) and choice.startswith(PREFIX) and len(choice) > len(PREFIX))


def parse(choice: Any) -> tuple[str | None, str | None, str | None]:
    """The tier, or the provider and the model, that a remote choice names: ``(None, None, None)`` for the connected model.

    Raises ValueError for a choice that is not remote, or that names neither.
    """
    if choice == "remote":
        return None, None, None
    if not is_remote(choice):
        raise ValueError(f"{choice!r} is not a choice of the remote model")
    rest = choice[len(PREFIX) :]
    if rest in TIERS:
        return rest, None, None
    provider, _, model = rest.partition(":")
    if not provider or not model.strip() or len(model) > 200:
        raise ValueError(f"{choice!r} names no tier and no model: remote:fast, remote:fastest or remote:<provider>:<model>")
    return None, provider, model.strip()


def recommended(provider: str) -> dict[str, list[dict[str, str]]]:
    """The models of each tier for a provider, for the view's choices: empty lists for a provider that has none."""
    known = RECOMMENDED.get(provider, {})
    return {tier: [dict(model) for model in known.get(tier, [])] for tier in TIERS}


def model_for(choice: Any, provider: str) -> str | None:
    """The model of the connected provider that a task's choice names, or None for the connected model.

    A tier takes its first recommended model; a provider that has none answers
    with the connected model. Raises OtherProvider for a model of another
    provider, and ValueError for a choice that names nothing.
    """
    if not choice or choice == "remote":
        return None
    tier, owner, model = parse(choice)
    if tier is not None:
        models = recommended(provider)[tier]
        return models[0]["id"] if models else None
    if owner != provider:
        raise OtherProvider(f"the task's model, {model}, is a model of {owner}, and the connected model is not")
    return model
