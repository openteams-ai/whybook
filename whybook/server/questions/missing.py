"""The type of question that the analyst likely wants, when no offered question has it.

research/order-none.md: in 27% to 32% of the cases rebuilt from public
notebooks, no offered question has the type of the question that the
notebook's author asked next. The type predictor, a multinomial logistic
regression, gives each of the five types a probability from what the server
knows of a request: what was dragged onto what and the tags of those
variables, the types that the offered questions have, and the questions asked
before. The probability that the analyst wants a type that no offered
question has is one minus the probabilities of the offered types.

research/local_predictors/type_predictor.py fits the regression with the
features of this module, on the cases of research/ranking-placement.md, and
writes its weights to type_predictor.json. For a column dragged onto a cell
the predictor reads the offered types and the questions asked before only:
the research labelled each target cell from its code, and the view knows the
type of a cell only when the cell asked a question through it.
"""

from __future__ import annotations

import functools
import json
import math
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from .models import Variable

# In the order of the learned ranker (learned_ranker.json).
TYPES = ["descriptive", "quality", "association", "model", "causal"]
# What was dragged onto what. The research's "wide", a cell with more than two
# columns, counts as the pair of its first two, as a drop of two columns does.
KINDS = ["column", "frame and column", "model and column", "pair", "frame", "frames", "model", "model and frame"]
TAGS = ["num", "cat", "bool", "id", "date", "series", "dataframe", "model", "other"]

COLUMN_KINDS = ("numeric", "binary", "categorical", "datetime", "text", "id")
# The tag that the view gives a column, as the predictor groups tags: whole
# numbers count as numbers, and ordered categories as categories.
TAG_OF = {"num": "num", "int": "num", "cat": "cat", "ord": "cat", "bool": "bool", "date": "date", "id": "id"}
# A column with no tag, by its kind.
TAG_OF_KIND = {"numeric": "num", "binary": "bool", "categorical": "cat", "datetime": "date", "id": "id"}


def tag_of(variable: Variable) -> str:
    """The predictor's tag of a variable: a column's type, or series, dataframe, model or other."""
    if variable.kind == "dataframe":
        return "dataframe"
    if variable.kind == "model":
        return "model"
    if variable.kind not in COLUMN_KINDS:
        return "other"
    if variable.parent is None:
        return "series"
    if variable.tag:
        return TAG_OF.get(variable.tag, "other")
    return TAG_OF_KIND.get(variable.kind, "other")


def drop_kind(involved: Sequence[Variable]) -> tuple[str, tuple[str, str]] | None:
    """What was dragged onto what, and the tags of the two variables, as research/local_predictors/ranking_placement.py names them.

    A column and a model give "model and column" with the model's tag first,
    a column and a frame "frame and column" with the column's first, two
    columns "pair" in the order given, and one variable dragged onto itself
    its own kind twice. A file, a table, an array or a constant gives None.
    """
    variables = [v for v in involved if v.kind in COLUMN_KINDS]
    frames = [v for v in involved if v.kind == "dataframe"]
    models = [v for v in involved if v.kind == "model"]
    if len(variables) + len(frames) + len(models) != len(involved):
        return None
    if len(variables) == 1 and models:
        return "model and column", ("model", tag_of(variables[0]))
    if len(variables) == 1 and frames:
        return "frame and column", (tag_of(variables[0]), "dataframe")
    if len(variables) == 1:
        return "column", (tag_of(variables[0]),) * 2
    if len(variables) >= 2:
        return "pair", (tag_of(variables[0]), tag_of(variables[1]))
    if len(frames) == 1:
        return ("model and frame", ("model", "dataframe")) if models else ("frame", ("dataframe", "dataframe"))
    if len(frames) > 1:
        return "frames", ("dataframe", "dataframe")
    if models:
        return "model", ("model", "model")
    return None


def _one_hot(value: Any, values: Sequence[Any]) -> list[float]:
    return [float(value == v) for v in values]


def history(asked: Sequence[str], last_type: str | None, cells_above: int) -> list[float]:
    """The questions asked before: the type of the last one, the share of each type, how many, and how far down the notebook."""
    total = len(asked)
    shares = [sum(1 for t in asked if t == kind) / total if total else 0.0 for kind in TYPES]
    last = last_type if last_type in TYPES else None
    return _one_hot(last, [*TYPES, None]) + shares + [math.log1p(total), min(cells_above, 50) / 50]


def variable_features(kind: str, tags: tuple[str, str], offered: Sequence[str], asked: Sequence[str], last_type: str | None, cells_above: int) -> list[float]:
    """The features of a variable dragged onto a variable, or onto itself."""
    return (
        _one_hot(kind, KINDS)
        + _one_hot(tags[0], TAGS)
        + _one_hot(tags[1], TAGS)
        + [float(t in set(offered)) for t in TYPES]
        + history(asked, last_type, cells_above)
    )


def cell_features(offered: Sequence[str], asked: Sequence[str], last_type: str | None, cells_above: int) -> list[float]:
    """The features of a column dragged onto a cell."""
    return [float(t in set(offered)) for t in TYPES] + history(asked, last_type, cells_above)


@functools.cache
def predictor() -> dict[str, Any]:
    """The weights that research/local_predictors/type_predictor.py wrote, for the features of this module."""
    found = json.loads((Path(__file__).parent / "type_predictor.json").read_text())
    assert (found["types"], found["kinds"], found["tags"]) == (TYPES, KINDS, TAGS), "type_predictor.json has other features"
    return found


def probabilities(gesture: str, features: Sequence[float]) -> list[float]:
    """The probability of each of TYPES: a softmax over the scaled features, and 0 for a type that the fit never saw."""
    model = predictor()[gesture]
    x = [(v - m) / s for v, m, s in zip(features, model["mean"], model["scale"])]
    logits = {kind: b + sum(w * v for w, v in zip(row, x)) for kind, row, b in zip(model["classes"], model["coef"], model["intercept"])}
    top = max(logits.values())
    exp = {kind: math.exp(value - top) for kind, value in logits.items()}
    total = sum(exp.values())
    return [exp.get(kind, 0.0) / total for kind in TYPES]


def missing_type(gesture: str, features: Sequence[float], offered: Sequence[str]) -> dict[str, Any] | None:
    """The likeliest type that no offered question has, with the probability that the analyst wants a type that none has."""
    p = probabilities(gesture, features)
    absent = [t for t in TYPES if t not in set(offered)]
    if not absent:
        return None
    likely = max(absent, key=lambda t: p[TYPES.index(t)])
    none = max(0.0, 1.0 - sum(p[TYPES.index(t)] for t in set(offered) if t in TYPES))
    return {"type": likely, "probability": round(none, 4)}


def for_request(involved: Sequence[Variable], offered: Sequence[str], asked: Sequence[str], last_type: str | None, cells_above: int, onto_cell: bool) -> dict[str, Any] | None:
    """The missing type of a request, or None when the variables are of a kind that the predictor did not learn."""
    if not offered:
        return None
    if onto_cell:
        return missing_type("cell", cell_features(offered, asked, last_type, cells_above), offered)
    found = drop_kind(involved)
    if found is None:
        return None
    kind, tags = found
    return missing_type("variable", variable_features(kind, tags, offered, asked, last_type, cells_above), offered)
