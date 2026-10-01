"""A fixed catalogue of question templates.

A template applies to one variable, or to a pair of variables of given kinds.
``generate`` fills in the labels. The demo ships with this catalogue so that it
works with no model at all. A ranker then orders the questions, and Claude can
add more.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable

from .models import Candidate, Context, Selection, Variable

# The variable kinds that each template kind matches.
KIND_GROUPS: dict[str, frozenset[str]] = {
    "numeric": frozenset({"numeric"}),
    "binary": frozenset({"binary"}),
    "categorical": frozenset({"categorical", "binary"}),
    "datetime": frozenset({"datetime"}),
    "text": frozenset({"text"}),
    "dataframe": frozenset({"dataframe"}),
    "constant": frozenset({"constant"}),
    "column": frozenset({"numeric", "binary", "categorical", "datetime", "text"}),
}

Predicate = Callable[[Variable, "Variable | None"], bool]


@dataclass(frozen=True)
class Template:
    id: str
    text: str
    type: str
    kinds: tuple[str, ...]
    prior: float
    requires: Predicate | None = None

    @property
    def univariate(self) -> bool:
        return len(self.kinds) == 1

    @property
    def symmetric(self) -> bool:
        return len(self.kinds) == 2 and self.kinds[0] == self.kinds[1]


def _has_missing(a: Variable, b: Variable | None) -> bool:
    return bool(a.missing) or bool(b is not None and b.missing)


def _many_levels(a: Variable, b: Variable | None) -> bool:
    return (a.unique or 0) > 5


def _groups_repeats(a: Variable, b: Variable | None) -> bool:
    # Between 3 levels and one level per two rows: each level repeats.
    return a.unique is not None and a.rows is not None and 3 <= a.unique <= a.rows / 2


def _enough_levels_for_random_effect(a: Variable, b: Variable | None) -> bool:
    return (a.unique or 0) >= 5


def _different_tables(a: Variable, b: Variable | None) -> bool:
    return b is not None and a.parent is not None and b.parent is not None and a.parent != b.parent


def _column_of(a: Variable, b: Variable | None) -> bool:
    return b is not None and a.parent == b.name


def _has_value(a: Variable, b: Variable | None) -> bool:
    # A key or a token comes without its value, and is no modelling choice.
    return a.value is not None


TEMPLATES: tuple[Template, ...] = (
    # One variable.
    Template("distribution", "What does the distribution of {a} look like?", "descriptive", ("numeric",), 0.70),
    Template("outliers", "Does {a} have outliers or impossible values?", "quality", ("numeric",), 0.55),
    Template("missing_values", "Why are some values of {a} missing?", "quality", ("column",), 0.50, _has_missing),
    # One question for the shape of a number: "Transform x: log, standardise or
    # bin", "Is x close enough to normal?" and "Should x be transformed?" took
    # three of the ten places of a drop (design iteration 1.75).
    Template("transform", "Is {a} close enough to normal for the planned model, or should it be transformed?", "model", ("numeric",), 0.35),
    Template("level_counts", "How many observations fall in each level of {a}?", "descriptive", ("categorical",), 0.70),
    Template("rare_levels", "Are some levels of {a} too rare to analyse on their own?", "quality", ("categorical",), 0.45, _many_levels),
    Template("grouping_unit", "Does {a} group repeated observations of the same unit?", "model", ("categorical",), 0.40, _groups_repeats),
    Template("balance", "Are the two groups of {a} balanced?", "descriptive", ("binary",), 0.50),
    Template("time_coverage", "What period does {a} cover, and are there gaps?", "descriptive", ("datetime",), 0.65),
    Template("text_consistency", "Are the values of {a} written consistently?", "quality", ("text",), 0.50),
    Template("unit_of_observation", "What does one row of {a} represent?", "descriptive", ("dataframe",), 0.75),
    Template("frame_missing", "Which columns of {a} have missing values?", "quality", ("dataframe",), 0.60),
    Template("duplicates", "Does {a} contain duplicated rows?", "quality", ("dataframe",), 0.45),
    Template("row_key", "Which columns identify a row of {a}?", "descriptive", ("dataframe",), 0.40),
    Template("constant_choice", "Why is {a} set to {value}, and do the results depend on it?", "model", ("constant",), 0.60, _has_value),
    # Two variables.
    Template("association", "Is {a} associated with {b}?", "association", ("numeric", "numeric"), 0.75),
    Template("linearity", "Is the relation between {a} and {b} linear?", "model", ("numeric", "numeric"), 0.45),
    Template("influential_points", "Is the relation between {a} and {b} driven by a few points?", "model", ("numeric", "numeric"), 0.35),
    Template("confounding", "Could another variable explain the link between {a} and {b}?", "causal", ("column", "column"), 0.45),
    Template("direction", "Does {a} influence {b}, or the other way round?", "causal", ("column", "column"), 0.35),
    Template("cross_table", "Can {a} and {b} be compared when they come from different tables?", "quality", ("column", "column"), 0.50, _different_tables),
    Template("group_difference", "Does {b} differ between the levels of {a}?", "association", ("categorical", "numeric"), 0.75),
    Template("equal_spread", "Is the spread of {b} similar across the levels of {a}?", "model", ("categorical", "numeric"), 0.40),
    Template("random_effect", "Should {a} enter a model of {b} as a random effect?", "model", ("categorical", "numeric"), 0.35, _enough_levels_for_random_effect),
    Template("independence", "Are {a} and {b} independent?", "association", ("categorical", "categorical"), 0.65),
    Template("nesting", "Is {a} nested within {b}, or are they crossed?", "model", ("categorical", "categorical"), 0.45),
    Template("empty_cells", "Are all combinations of {a} and {b} observed?", "quality", ("categorical", "categorical"), 0.40),
    Template("trend", "How does {b} change over {a}?", "association", ("datetime", "numeric"), 0.75),
    Template("seasonality", "Does {b} follow a seasonal pattern over {a}?", "association", ("datetime", "numeric"), 0.40),
    Template("join_keys", "How do {a} and {b} join, and which rows do not match?", "quality", ("dataframe", "dataframe"), 0.70),
    Template("same_units", "Do {a} and {b} describe the same units?", "quality", ("dataframe", "dataframe"), 0.50),
    Template("related_columns", "Which other columns of {b} are related to {a}?", "association", ("column", "dataframe"), 0.60, _column_of),
    Template("predict_from_frame", "Can the other columns of {b} predict {a}?", "association", ("column", "dataframe"), 0.40, _column_of),
)


# A number named as a time: week, visit, study_day, week_num. A name that ends
# in a time, such as reaction_time or built_year, measures something else.
TIME_NAME = re.compile(
    r"^(?:(?:study|trial|visit|follow_?up)_)?"
    r"(?:week|day|month|year|hour|minute|visit|wave|timepoint|time_point|period|quarter|session|time|t)"
    r"(?:_(?:num|number|no|nr|index|idx))?$"
)


def is_unit(variable: Variable, context: Context | None = None) -> bool:
    """Whether a column names a unit, such as patient_id: tagged as an id, or the unit of the analysis."""
    if variable.kind == "id":
        return True
    return context is not None and variable.parent is not None and bool(context.unit) and variable.label == context.unit


def is_time(variable: Variable) -> bool:
    """Whether a column places each row in time: dates, or numbers named as a time, such as week or visit."""
    if variable.kind == "datetime":
        return True
    return variable.kind == "numeric" and bool(TIME_NAME.match(variable.label.lower()))


# What a unit's id or a time index is not (design iteration 1.75): nothing
# causes the id of a patient or the week of a visit, their values are no
# levels to compare, and neither is a measure to transform.
LEVEL_TEMPLATES = frozenset({"level_counts", "rare_levels", "grouping_unit", "group_difference", "equal_spread", "independence", "empty_cells"})
SHAPE_TEMPLATES = frozenset({"transform", "outliers", "distribution"})


def fits(template: Template, a: Variable, b: Variable | None, context: Context | None = None) -> bool:
    """Whether a template asks a question that the kinds of its variables allow, beyond their kinds."""
    special = [v for v in (a, b) if v is not None and (is_unit(v, context) or is_time(v))]
    if not special:
        return True
    if template.type == "causal":
        return False
    if template.id in LEVEL_TEMPLATES:
        # The variable whose levels the question compares: the first, a category.
        return a not in special and (template.id not in ("independence", "empty_cells") or b not in special)
    if template.id in SHAPE_TEMPLATES:
        # A time index can hold impossible values, such as week 99; no id has a distribution to look at.
        return template.id != "transform" and not is_unit(a, context)
    return True


def _matches(template_kind: str, variable: Variable) -> bool:
    return variable.kind in KIND_GROUPS[template_kind]


def _order(template: Template, a: Variable, b: Variable) -> tuple[Variable, Variable] | None:
    """Put the pair in the order of the template's kinds, or return None."""
    first, second = template.kinds
    if _matches(first, a) and _matches(second, b):
        return a, b
    if _matches(first, b) and _matches(second, a):
        return b, a
    return None


def _candidate(template: Template, a: Variable, b: Variable | None) -> Candidate:
    text = template.text.format(a=a.label, b=b.label if b else "", value=a.value)
    if b is None:
        variables: tuple[str, ...] = (a.name,)
    elif template.symmetric:
        # The same question whichever variable was clicked first.
        variables = tuple(sorted((a.name, b.name)))
    else:
        variables = (a.name, b.name)
    return Candidate(
        id=f"{template.id}:{'|'.join(variables)}",
        text=text,
        type=template.type,
        origin="template",
        template=template.id,
        variables=variables,
        prior=template.prior,
    )


def generate(selection: Selection, context: Context | None = None) -> list[Candidate]:
    """All the template questions that apply to the selection.

    ``context`` names the unit of the analysis, a column that the
    questions treat as an id even when it is not tagged as one.
    """
    a = selection.source
    candidates = []
    for template in TEMPLATES:
        if selection.univariate:
            if template.univariate and _matches(template.kinds[0], a) and fits(template, a, None, context):
                if template.requires is None or template.requires(a, None):
                    candidates.append(_candidate(template, a, None))
            continue
        if template.univariate:
            continue
        assert selection.target is not None
        pair = _order(template, a, selection.target)
        if pair is None or not fits(template, *pair, context):
            continue
        if template.requires is None or template.requires(*pair):
            candidates.append(_candidate(template, *pair))
    return candidates
