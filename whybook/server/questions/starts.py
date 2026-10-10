"""Questions that start an analysis, and questions that two frames ask together (design iteration 1.87).

A file or a table that the analyst drops on a notebook with fewer than three
code cells gets questions to start with, which need no model: what one row
holds, how many rows and how many values are missing, how often each level of
a column with few levels occurs, and the range of each number. In place of
them, a notebook that has begun gets "What could X add to this analysis?",
which needs a model.

A file or a table dropped on a cell whose frame it shares a key with gets
questions about the two: "How many visits per site?" and the other questions
that follow from the frame with one row per key and the frame with several
(``Link``). The key and its direction come from what the server can read: the
rows of the dropped data and the distinct values of the key, and the rows of
the frame in the kernel, which the request carries. With no shared key, the
generic question stays.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Sequence

from .. import codegen
from .cells import CellInfo, unit_noun
from .models import Candidate, Context, Placement

# A notebook with fewer code cells that hold code than this has just begun.
BEGUN = 3
# A column with at most this many levels, and no more than half as many as it has rows, counts its levels.
FEW_LEVELS = 12
# The rows of a file or a table that give the kinds of its columns.
SAMPLE = 1000
# The tags of a frame's columns that are no key: a measured number, a time and a flag.
NOT_KEYS = frozenset({"num", "date", "bool"})
# A frame is the one with a row per key when it has at most a fifth of the rows of the other.
FIFTH = 5
# The end of the effect of a question that answers in a preview. Its verb is
# the verb of the preview's button, Keep as a cell.
UNLESS_KEPT = "no cell unless you keep it"
# The endings of a last word that ends in s and is not a plural noun: glass,
# status, analysis, demographics, and words such as diabetes and series.
SINGULAR_ENDINGS = ("ss", "us", "is", "ics", "diabetes", "herpes", "measles", "mumps", "news", "rabies", "series", "species")

# Makes the candidate of a question: its text, type, prior, placement, code and effect.
Make = Callable[[str, str, float, Placement, str | None, str], Candidate]


def begun(cells: Sequence[CellInfo]) -> bool:
    """Whether the notebook has fewer than three code cells that hold code: an analysis that has just begun."""
    return sum(1 for cell in cells if cell.type == "code" and cell.source.strip()) < BEGUN


def cell_frames(cell: CellInfo | None, context: Context) -> list[str]:
    """The frames of the kernel that a cell loads or reads, those it makes first."""
    if cell is None:
        return []
    return [name for name in dict.fromkeys([*cell.defs, *cell.uses]) if name in context.frames]


def plural(noun: str) -> str:
    return f"{noun}s"


def rows_of(name: str) -> str:
    """What a question counts of a frame: "visits", or "rows of model_data" for a name that is not a plural noun.

    The name is a plural noun when its last word ends in s, and not as
    status, analysis or diabetes end (SINGULAR_ENDINGS). "How many
    model_data per patient?" made the analyst read model_data as its rows.
    """
    word = name.lower().rstrip("_.0123456789")
    return name if word.endswith("s") and not word.endswith(SINGULAR_ENDINGS) else f"rows of {name}"


def _names(columns: Sequence[str], limit: int = 3) -> str:
    """Column names in a sentence: ``a``, ``a and b``, ``a, b and c``, and ``a, b, c and 2 more``."""
    shown = list(columns[:limit])
    rest = len(columns) - len(shown)
    if rest:
        return f"{', '.join(shown)} and {rest} more"
    return shown[0] if len(shown) == 1 else f"{', '.join(shown[:-1])} and {shown[-1]}"


def _fill(template: str, **names: str) -> str:
    """The lines of a template, with ``$name`` replaced by each name given."""
    for key, value in names.items():
        template = template.replace(f"${key}", value)
    return template


@dataclass(frozen=True)
class Shape:
    """What a sample of rows shows about the columns of data that is not loaded."""

    numbers: tuple[str, ...] = ()
    levels: tuple[str, ...] = ()


def is_id(column: str) -> bool:
    """A column named like an id: ``id``, ``patient_id``. The kernel's tag for a column says the same."""
    lowered = column.lower()
    return lowered == "id" or lowered.endswith("_id")


def shape_of(sample: object) -> Shape:
    """The numbers and the columns with few levels in a sample of rows (a pandas frame)."""
    import pandas as pd

    frame: pd.DataFrame = sample  # type: ignore[assignment]
    numbers, levels = [], []
    for column in frame.columns:
        series = frame[column]
        if is_id(str(column)):
            continue
        distinct = series.nunique(dropna=True)
        numeric = pd.api.types.is_numeric_dtype(series) and not pd.api.types.is_bool_dtype(series)
        fractional = pd.api.types.is_float_dtype(series)
        few = 0 < distinct <= FEW_LEVELS and 2 * distinct <= len(series) and not fractional
        if few and not pd.api.types.is_datetime64_any_dtype(series):
            levels.append(str(column))
        elif numeric:
            numbers.append(str(column))
    return Shape(tuple(numbers), tuple(levels))


def unit_of(columns: Sequence[str], known: str | None) -> str | None:
    """The column that says what one row is: the notebook's unit when the data has it, else the first column named like an id."""
    if known and known in columns:
        return known
    return next((column for column in columns if is_id(column)), None)


# Questions to start with.


def start_options(
    label: str,
    name: str,
    read: Callable[[str], list[str]],
    unit: str | None,
    shape: Shape | None,
    make: Make,
    place: Placement,
) -> list[Candidate]:
    """The questions to start with, for data that is not loaded: each reads it into a name of its own and shows its answer in a preview.

    ``read(variable)`` gives the lines that read the data into ``variable``.
    ``shape`` is None where no sample of the rows could be read: then the
    questions about numbers and levels are left out.
    """

    def question(text: str, what: str, prior: float, effect: str, body: str, imports: bool = False, shown: bool = True) -> Candidate:
        """A question: the data is read into a name of its own, the body prints or makes ``$answer``, and the data goes.

        The answer is the last line, which a preview shows; its name starts
        with an underscore, which keeps it out of the variable listing.
        """
        data, answer = codegen.temporary(name, what), codegen.temporary(name, what, "answer")
        lines = [codegen.comment(text), *(["import whybook", ""] if imports else []), *read(data), ""]
        lines += [*_fill(body, data=data, answer=answer).split("\n"), f"del {data}", *([answer] if shown else [])]
        return make(text, "descriptive", prior, place, "\n".join(lines), f"{effect} · {UNLESS_KEPT}")

    options = []
    text = f"What does one row of {label} hold?"
    if unit is not None:
        # The unit's id is repeated in a long file: the rows of each unit say what a row is.
        body = f"$answer = whybook.rows_per_unit($data, {codegen.literal(unit)})"
        options.append(question(text, "one_row", 0.68, f"Rows per {unit_noun(unit)}, from the column {unit}", body, imports=True))
    else:
        body = (
            'print(format(len($data), ","), "rows and", $data.shape[1], "columns. The first three rows, one column each:")\n'
            "$answer = $data.head(3).T"
        )
        options.append(question(text, "one_row", 0.68, "No column is named like an id: the first rows, one column each", body))
    text = f"How many rows has {label}, and how many values are missing?"
    body = (
        '$answer = $data.isna().sum().rename("values missing").to_frame()\n'
        'print(format(len($data), ","), "rows and", $data.shape[1], "columns;", format(int($answer["values missing"].sum()), ","), "values missing.")'
    )
    options.append(question(text, "missing", 0.64, "The rows, and the values missing in each column", body))
    if shape is not None and shape.levels:
        text = f"How many rows has each level of {_names(shape.levels)}?"
        # A table, as the missing values are one: a row for each of the 12 most
        # common levels of each column. pandas shows a table of more than 60
        # rows as its first and last five, and NHEFS has 96 such rows, so the
        # table shows every row (design iteration 1.101).
        body = (
            "$answer = pd.concat(\n"
            f"    {{column: $data[column].value_counts(dropna=False).head(12) for column in {codegen.literals(shape.levels)}}},\n"
            '    names=["column", "level"],\n'
            ').rename("rows").to_frame()\n'
            'with pd.option_context("display.max_rows", len($answer)):\n'
            "    display($answer)"
        )
        options.append(question(text, "levels", 0.6, "The rows of each level of the columns with few levels", body, shown=False))
    if shape is not None and shape.numbers:
        text = f"What is the range of each number in {label}?"
        body = f'$answer = $data[{codegen.literals(shape.numbers)}].agg(["min", "max"]).T'
        options.append(question(text, "range", 0.58, "The lowest and the highest value of each number", body))
    return options


# Questions of two frames that share a key.


@dataclass(frozen=True)
class Link:
    """Two frames that share a key: the one with a row per key, and the one with several."""

    key: str
    one: str
    many: str
    one_columns: tuple[str, ...]
    many_columns: tuple[str, ...]
    # Whether the dropped data is the one with several rows per key.
    dropped_many: bool


def _direction(rows_dropped: int | None, distinct: int | None, rows_frame: int | None) -> str | None:
    """Which of the dropped data and the frame has one row per key: "dropped", "frame", or None where the rows do not tell.

    Where the distinct keys of the dropped data are known, they tell. If
    each of its rows has a key of its own, it is the one with a row per key
    when the frame has more rows than it has keys. If its rows repeat the
    keys, the frame is the one with a row per key when it has no more rows
    than the data has keys, or at most a fifth of the rows of the data: it
    may hold a key that the data lacks, such as a site without visits.
    Without the distinct keys, the smaller is the one with a row per key
    when it has at most a fifth of the rows of the other, as the unit's
    frame is.
    """
    if rows_dropped is None or rows_frame is None:
        return None
    if distinct is not None:
        if distinct == rows_dropped:
            return "dropped" if rows_frame > rows_dropped else None
        if distinct < rows_dropped and (rows_frame <= distinct or FIFTH * rows_frame <= rows_dropped):
            return "frame"
        return None
    if FIFTH * rows_dropped <= rows_frame:
        return "dropped"
    if FIFTH * rows_frame <= rows_dropped:
        return "frame"
    return None


def find_link(
    name: str,
    dropped_columns: Sequence[str],
    counts: Callable[[str], tuple[int | None, int | None]],
    frame: str,
    context: Context,
) -> Link | None:
    """The key that the dropped data shares with a frame of the kernel, and which of the two has a row per key.

    A key is a column both hold that is no measured number, no time and no
    flag by the frame's tag: ``site`` in ``sites`` and in ``visits``. The
    notebook's unit comes first, then the columns named like ids.
    ``counts(key)`` gives the rows of the dropped data and its distinct
    values of the key, each None where it cannot tell.
    """
    columns = context.frames.get(frame, {})
    shared = [column for column in dropped_columns if column in columns and columns[column] not in NOT_KEYS]
    shared.sort(key=lambda column: (column != context.unit, columns[column] != "id" and not is_id(column)))
    rows_frame = context.frame_rows.get(frame)
    for key in shared:
        rows, distinct = counts(key)
        found = _direction(rows, distinct, rows_frame)
        if found is None:
            continue
        dropped_many = found == "frame"
        return Link(
            key=key,
            one=frame if dropped_many else name,
            many=name if dropped_many else frame,
            one_columns=tuple(columns) if dropped_many else tuple(dropped_columns),
            many_columns=tuple(dropped_columns) if dropped_many else tuple(columns),
            dropped_many=dropped_many,
        )
    return None


def find_frame_link(dropped: str, frame: str, context: Context) -> Link | None:
    """The same for a frame of the kernel dropped on a cell: both are loaded, and the rows tell which has a row per key."""
    columns = context.frames.get(dropped, {})
    rows = context.frame_rows.get(dropped)
    return find_link(dropped, list(columns), lambda key: (rows, None), frame, context)


def combined_options(link: Link, load: list[str], make: Make, place: Placement, joined_before: bool = False) -> list[Candidate]:
    """The questions of two frames that share a key: how many rows per key, which key is an outlier, which has none, and the join.

    ``load`` holds the lines that load the dropped data, which a cell then
    makes under its own name: empty for a frame that is in the kernel. A file
    or a table already has a join that adds its columns to the frame's rows
    (``joined_before``), so only the join in the other direction is new.
    """
    key, one, many = link.key, link.one, link.many
    noun = unit_noun(key)
    nouns = plural(noun)
    # What the questions count of the frame with several rows per key: "visits", or "rows of model_data".
    counted = rows_of(many)
    quoted = codegen.literal(key)
    head = [*load, ""] if load else []
    options = []

    def code(text: str, lines: list[str], imports: bool = False) -> str:
        return "\n".join([codegen.comment(text), *(["import whybook", ""] if imports else []), *head, *lines])

    text = f"How many {counted} per {noun}?"
    lines = [f"whybook.rows_per_unit({many}, {quoted})"]
    options.append(make(text, "descriptive", 0.8, place, code(text, lines, imports=True), f"The rows of {many} for each {noun}, and the {nouns} with the fewest"))

    # The counts take the keys of the one frame, so that a key that the other frame lacks counts 0.
    counts, answer = (codegen.temporary(many, noun, word) for word in ("counts", "outliers"))
    first, third, low, high = (codegen.temporary(many, noun, word) for word in ("q1", "q3", "low", "high"))
    text = f"Is any {noun} an outlier for the number of {counted}?"
    lines = [
        f"{counts} = {many}.groupby({quoted}).size().reindex({one}[{quoted}].drop_duplicates(), fill_value=0)",
        f"{first}, {third} = {counts}.quantile([0.25, 0.75])",
        f"{low}, {high} = {first} - 1.5 * ({third} - {first}), {third} + 1.5 * ({third} - {first})",
        f"{answer} = {counts}[({counts} < {low}) | ({counts} > {high})].rename({codegen.literal(many)}).to_frame()",
        f'print(len({answer}), "of", len({counts}), {codegen.literal(nouns)}, "are outliers for the number of {counted}. Outside", format({low}, ".1f"), "to", format({high}, ".1f"), "(1.5 times the interquartile range beyond the quartiles).")',
        f"del {counts}, {first}, {third}, {low}, {high}",
        answer,
    ]
    options.append(make(text, "quality", 0.76, place, code(text, lines), f"The {counted} for each {noun}, and those beyond 1.5 times the interquartile range"))

    text = f"Which {nouns} have no {counted}?"
    answer = codegen.temporary(one, "without", many)
    lines = [
        f"{answer} = {one}[~{one}[{quoted}].isin({many}[{quoted}])]",
        f'print(len({answer}), "of", len({one}), {codegen.literal(nouns)}, "have no {counted}.")',
        answer,
    ]
    options.append(make(text, "quality", 0.72, place, code(text, lines), f"The rows of {one} whose {key} {many} does not hold"))

    # Only the one frame's columns join: the rows of the other keep their own.
    probe = next((column for column in link.one_columns if column != key and column not in link.many_columns), None)
    if probe is not None and (link.dropped_many or not joined_before):
        text = f"Add the columns of {one} to {many}"
        joined = codegen.identifier(f"{many}_{one}")
        lines = [
            f'{joined} = {many}.merge({one}, on={quoted}, how="left", validate="many_to_one")',
            f'print(format({joined}[{codegen.literal(probe)}].notna().mean(), ".0%"), "of {many} rows found a match in {one}")',
            f"{joined}.head()",
        ]
        options.append(make(text, "descriptive", 0.74, place, code(text, lines), f"Left join on {key}, with the share of {many} rows that found a match"))
    return options
