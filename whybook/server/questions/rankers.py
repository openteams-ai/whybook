"""The rules that score candidate questions, and the learned order of their types.

``score_candidate`` sets ``Candidate.probability`` and ``Candidate.reasons``
of every option offered, so that the user can question the order too. A model
chosen for "Question order" orders them again (``ranking.py``), Jev among them
through the Cloudflare AI REST API (``CLOUDFLARE_RUN_URL``, ``jev_probabilities``).
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any, Sequence

from .models import Candidate, Context, Selection

CLOUDFLARE_RUN_URL = "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run"


def _logit(p: float) -> float:
    return math.log(p / (1 - p))


def _sigmoid(x: float) -> float:
    return 1 / (1 + math.exp(-x))


# Analysts ask several questions of one kind before they switch: with the
# labels that data scientists gave to the notebooks of DASWOW, continuing adds
# 0.4 to 0.8 to the log-odds (research/question-sequences.md).
RUN_WEIGHT = 0.4


def score_candidate(candidate: Candidate, involved: list, context: Context) -> None:
    """Set the probability and the reasons of one candidate from its prior and the notebook."""
    score = _logit(min(max(candidate.prior, 0.01), 0.99))
    reasons = []
    if candidate.id in context.asked_ids:
        score -= 3
        reasons.append("already asked")
    missing = max((v.missing_fraction for v in involved), default=0.0)
    if candidate.type == "quality" and missing > 0:
        score += min(1.5, 4 * missing)
        reasons.append(f"{missing:.0%} missing")
    unused = [v.label for v in involved if not {v.name, v.label} & context.used]
    if unused and candidate.type in ("descriptive", "quality", "association"):
        score += 0.4
        reasons.append(f"{', '.join(unused)} not used in any cell yet")
    if candidate.type == "causal" and context.type_share("causal") < 0.15:
        score += 0.5
        reasons.append("few causal questions so far")
    if candidate.type == "model" and "model" not in context.asked_types:
        score += 0.3
        reasons.append("no model check yet")
    preferred = {"do": ("quality", "descriptive"), "report": ("association", "model"), "wonder": ("causal", "association")}
    if candidate.type in preferred.get(context.mode, ()):
        score += 0.2
        reasons.append(f"fits the {context.mode.capitalize()} mode")
    # Do follows the analyst's run of questions; Wonder, whose purpose is to
    # widen what gets asked, leans to a change. Report leaves the order be.
    if context.last_type and context.mode == "do" and candidate.type == context.last_type:
        score += RUN_WEIGHT
        reasons.append(f"continues from the {context.last_type} question asked last")
    elif context.last_type and context.mode == "wonder" and candidate.type != context.last_type:
        score += RUN_WEIGHT
        reasons.append(f"a change from the {context.last_type} question asked last")
    if candidate.code or candidate.action:
        score += 0.3
        reasons.append("runs offline")
    candidate.probability = round(_sigmoid(score), 3)
    # The candidate's own reason, such as the gap it fills, comes first.
    seen = set()
    merged = []
    for reason in candidate.reasons + reasons:
        if reason.lower() not in seen:
            seen.add(reason.lower())
            merged.append(reason)
    candidate.reasons = merged


# The learned ranker of research/ranking-placement.md, fitted on 6,908 drops rebuilt
# from public notebooks: the first option had the type of the analyst's question for
# 52.5% of the drops of five corpora, against 29.5% with the rules' order alone.
LEARNED = json.loads((Path(__file__).parent / "learned_ranker.json").read_text())


def kind_group(items: Sequence) -> str:
    """The kind of a drop, as the learned ranker groups drops: one variable, two or more, or frames."""
    variables = [v for v in items if v.kind not in ("dataframe", "model", "file", "table")]
    if len(variables) >= 2:
        return "two or more"
    if variables:
        return "one variable"
    # A model alone, or a model and a frame, takes the weights of two variables, as in the fit.
    return "two or more" if any(v.kind == "model" for v in items) else "frames"


def learned_order(options: list[Candidate], group: str, context: Context, cells_above: int) -> list[Candidate]:
    """The options with their types in the learned ranker's order, and the given order within a type.

    The options come in the rules' order. Each option gets a score from 25 facts that
    the view knows: its type in this kind of drop, the rules' probability, whether it
    runs offline or is a preview, whether it keeps the type asked last, how much of
    the notebook asked its type, and how many cells are above. The best score of each
    type orders the types.
    """
    types, groups, weights = LEARNED["types"], LEARNED["groups"], LEARNED["weights"]
    block = groups.index(group) if group in groups else 1
    total = len(context.asked)
    shares = {t: sum(1 for q in context.asked if q.type == t) / total if total else 0.0 for t in types}
    position = min(cells_above, 50) / 50

    def score(option: Candidate) -> float:
        if option.type not in types:
            return -math.inf
        t = types.index(option.type)
        x = [0.0] * len(weights)
        x[block * len(types) + t] = 1.0
        base = 3 * len(types)
        p = min(max(option.probability if option.probability is not None else 0.5, 1e-3), 1 - 1e-3)
        x[base] = _logit(p)
        x[base + 1] = float(bool(option.code or option.action))
        x[base + 2] = float(option.placement is not None and option.placement.kind == "preview")
        x[base + 3] = float(option.type == context.last_type)
        x[base + 4] = shares.get(option.type, 0.0)
        x[base + 5 + t] = position
        return sum(w * v for w, v in zip(weights, x))

    best: dict[str, float] = {}
    for option in options:
        best[option.type] = max(best.get(option.type, -math.inf), score(option))
    rank = {id(option): i for i, option in enumerate(options)}
    return sorted(options, key=lambda option: (-best[option.type], rank[id(option)]))


def names_in(text: str, names: Sequence[str]) -> set[str]:
    """The names of frames and columns that a question's text holds as whole words: "kwh_import", not "kwh"."""
    return {name for name in names if name and re.search(rf"(?<![\w]){re.escape(name)}(?![\w])", text)}


def merged_order(
    offered: list[Candidate],
    added: list[Candidate],
    involved: list,
    context: Context,
    *,
    learned: bool,
    cells_above: int,
) -> list[Candidate]:
    """The questions of a request with a model's questions among them, in the view's order.

    The rules score each of the model's questions as they score a template's,
    with the model's priority as its prior (``score_candidate``). All of them
    are then ordered as a drop's options are: by the rules' probability, and
    for a drop that is not onto a cell by the learned order of their types.

    One question may come first: the model's best question that names a column
    or a frame of the kernel that no offered question names, and that is not
    what was picked. That is what the templates miss, such as the outcome of
    the analysis or a column of a file that relates to the one picked. The
    check reads names in the texts, so the model's own claim is not trusted.
    The other questions stay where the order puts them, so the questions that
    run at once stay in the first screen of the list.
    """
    for candidate in added:
        score_candidate(candidate, involved, context)
    known = [name for frame, columns in context.frames.items() for name in (frame, *columns)]
    named: set[str] = set()
    for option in offered:
        named |= names_in(option.text, known)
    for item in involved:
        named |= {item.name, item.label} | ({item.parent} if item.parent else set())
    missed = {candidate.id: sorted(names_in(candidate.text, known) - named) for candidate in added}
    merged = sorted([*offered, *added], key=lambda option: option.probability or 0.0, reverse=True)
    if learned:
        merged = learned_order(merged, kind_group(involved), context, cells_above)
    first = next((candidate for candidate in merged if missed.get(candidate.id)), None)
    if first is not None:
        names = missed[first.id]
        first.reasons.insert(1, f"names {', '.join(names)}, which no template question here names")
        merged.remove(first)
        merged.insert(0, first)
    return merged


def jev_state(selection: Selection, context: Context) -> dict[str, Any]:
    """The state that Jev and Claude see: the selection and the notebook so far."""
    selected = [selection.source.to_state()]
    if not selection.univariate and selection.target is not None:
        selected.append(selection.target.to_state())
    return {
        "selected": selected,
        "analysis_so_far": list(context.cells[-20:]),
        "already_asked": [question.text for question in context.asked],
        "mode": context.mode,
    }


def jev_probabilities(response: dict[str, Any], count: int) -> list[float]:
    """Read the ``noul`` probabilities, in candidate order."""
    # The REST API wraps the model output in a "result" envelope.
    result = response.get("result", response)
    answers = result["answers"]
    return [float(answers[f"q{index}"]["noul"]) for index in range(count)]
