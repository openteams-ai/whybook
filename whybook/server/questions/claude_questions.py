"""Ask a model for questions that the templates do not cover: Claude, or a local model.

The view asks it about a drop or a click alongside the templates, and the
button "More questions from AI" asks it again. The model reads what was
picked, the frames of the kernel with their columns, the formulas of the
notebook, the questions that the templates offer and what agents found in
the notebook, and adds what they miss. The same call names the likely
outcomes and units of the analysis (design iteration 1.64), which the view
keeps as inferred.

Where the frames show it, the model also reads when each column is set
(``timing``, design iteration 1.84): the time columns, the columns with one
value per unit, and those measured on the rows after the start. Without it,
the model asked whether a column measured during follow-up confounds the
week, or the treatment arm.

A question of the model goes to the view only when it uses one of the items
picked, names no column that the frames of the request lack, and does not
repeat a question offered, asked or added before it (``kept``, design
iteration 1.76).
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, AsyncIterator, Sequence

from .. import claude, connection, local_models, privacy
from ..config import Whybook
from .models import TYPES, Candidate, Context, InvalidRequest, Placement, Selection, Variable
from .rankers import jev_state, merged_order
from .templates import TIME_NAME

SYSTEM_PROMPT = """\
You help a data analyst decide what to ask next about their data. You never answer the questions.

Propose up to 5 questions about the selected variables that nobody has asked yet.
Each question has at most 12 words, uses at least one of the selected variables, and names
the variables by their labels. Name only columns that "frames" holds, and say in words what
to derive from them, such as the share of the day's use in the peak.
Prefer questions that use what the data hold: the outcome that the analysis explains, the unit
that the rows repeat over, how the frames relate through the columns they share, and what a
column means. Prefer questions that expose a hidden modelling assumption, a data quality problem,
or a causal structure that the analyst may have missed.
"already_suggested" lists the questions that the view offers already, from its templates; it
answers at once those marked "runs". Do not repeat or rephrase them, or the questions in
already_asked: add what they miss.
"frames" lists the data frames in the kernel, with their rows and the kind of each column.
"formulas" lists the model formulas of the notebook's cells.
"found_so_far" lists what agents found in this notebook, newest first, with the question each
answered. Do not ask what they settled, or about a column that they found missing.
When "dropped_onto" names a cell, the analyst dropped the variable onto that cell: propose
questions about the variable in the analysis that the cell's code does.
Lean the questions toward the analyst's mode, in "mode":
- do: they are carrying out an analysis. Propose its next steps, phrased as actions.
- report: they are building a report. Propose questions whose answers belong in it: effects
  with their uncertainty, comparisons, and checks of a model.
- wonder: they want to know what else is there. Propose questions that open directions the
  notebook has not taken: causes, interactions, and variables not used yet.
priority is a number from 0 to 1: how much the answer could change the analysis.
why is one sentence of at most 20 words.

Also name the likely outcomes of the analysis, the columns that it explains, and its units, the
columns whose values name what the rows repeat over, such as a patient or a home. Take them from
the formulas, the code and the columns of "frames", best first, at most 3 of each. Name each by
its column and the frame that holds it, with why in at most 12 words. Name only columns of
"frames", and leave a list empty when nothing points to one.

"timing", when present, says when the columns of "frames" are set: "time" places each row in
time, "per_unit" holds one value per unit, usually set at the start, such as an arm or an age,
and "repeated" is measured on the rows after the start. Nothing causes a time column, so
nothing confounds a relation with it. A repeated column can lie on the path from a column set
at the start, but cannot cause it or confound its effect, and a column set at the start does
not lie on the path from another one.

Answer once, with one JSON object whose only keys are "questions", "outcomes" and "units":
"questions" is a list of objects, each with "text", "type", "why", "priority" and "columns",
the columns that the question uses, by their labels, with any it needs that no frame holds;
"outcomes" and "units" are lists of objects, each with "column", "frame" and "why". Never send
one question on its own."""

# The columns of a question are asked for, and not required: an answer
# without them is kept by its words alone (``kept``).
QUESTION = {
    "type": "object",
    "properties": {
        "text": {"type": "string"},
        "type": {"type": "string", "enum": list(TYPES)},
        "why": {"type": "string"},
        "priority": {"type": "number"},
        "columns": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["text", "type", "why", "priority"],
    "additionalProperties": False,
}

# A local model writes the questions alone, under a grammar of their schema:
# the same instructions, without the outcomes and the units.
LOCAL_SYSTEM_PROMPT = SYSTEM_PROMPT.split("\n\nAlso name the likely outcomes")[0] + (
    '\n\nAnswer once, with one JSON object whose only key is "questions": a list of objects, each\n'
    'with "text", "type", "why" and "priority". Never send one question on its own.'
)

# An outcome or a unit that the model names: a column of a frame, and why.
INFERRED = {
    "type": "object",
    "properties": {"column": {"type": "string"}, "frame": {"type": "string"}, "why": {"type": "string"}},
    "required": ["column", "frame", "why"],
    "additionalProperties": False,
}

# The outcomes and the units are asked for, and not required: an answer
# without them still gives its questions, where a required key would make a
# model that leaves them out answer again, and fail after three answers.
SCHEMA = {
    "type": "object",
    "properties": {
        "questions": {"type": "array", "items": QUESTION},
        "outcomes": {"type": "array", "items": INFERRED},
        "units": {"type": "array", "items": INFERRED},
    },
    "required": ["questions"],
    "additionalProperties": False,
}

# How much of the kernel's frames a model reads: their names, rows, and the
# name and kind of each column, as "Keep data on this machine" allows.
MAX_FRAMES = 12
MAX_COLUMNS = 40
MAX_OFFERED = 30
MAX_FORMULAS = 12
# At most this many outcomes and units from one answer.
MAX_INFERRED = 3
# What agents found in the notebook, as a model reads it: the newest answers,
# each cut. A local model, whose context is 4,096 tokens, reads fewer.
MAX_FOUND = 3
FOUND_CHARS = 600
LOCAL_FOUND = 2
LOCAL_FOUND_CHARS = 300


# How much of a cell's code a model reads about a drop onto the cell.
CELL_CHARS = 2000


def dropped_onto(data: Any) -> dict[str, str] | None:
    """The cell a variable was dropped onto, as a model reads it: its label and its code; None for a drop onto another variable."""
    if data is None:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("source"), str):
        raise InvalidRequest("the cell needs a source")
    return {"cell": str(data.get("label") or ""), "code": data["source"][:CELL_CHARS]}


def _candidate(item: dict, variables: tuple[str, ...], origin: str = "claude") -> Candidate:
    digest = hashlib.sha1(item["text"].encode()).hexdigest()[:10]
    priority = min(max(float(item["priority"]), 0.0), 1.0)
    return Candidate(
        id=f"{origin}:{digest}",
        text=item["text"],
        type=item["type"],
        origin=origin,
        variables=variables,
        prior=priority,
        probability=priority,
        reasons=[item["why"]],
    )


def offered_from_json(data: Any) -> list[Candidate] | None:
    """The questions that the request offers already, as the view sends them: None when it sends none.

    Each has its id, its text, its type, the rules' probability, whether a
    template answers it (``runs``) and the kind of its place. They go to the
    model as texts, so that it adds what they miss, and they take their place
    in the merged order (``rankers.merged_order``).
    """
    if data is None:
        return None
    if not isinstance(data, list) or len(data) > MAX_OFFERED:
        raise InvalidRequest(f"offered is a list of at most {MAX_OFFERED} questions")
    offered = []
    for item in data:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("text"), str):
            raise InvalidRequest("an offered question needs an id and a text")
        probability = item.get("probability")
        if isinstance(probability, bool) or not isinstance(probability, (int, float)):
            probability = None
        kind = (item.get("placement") or {}).get("kind") if isinstance(item.get("placement"), dict) else None
        offered.append(
            Candidate(
                id=item["id"],
                text=item["text"][:300],
                type=item.get("type") if item.get("type") in TYPES else "descriptive",
                origin=str(item.get("origin") or "template"),
                variables=(),
                prior=probability if probability is not None else 0.5,
                probability=probability,
                # A marker for the order: the view keeps the code itself.
                code="runs" if item.get("runs") is True else None,
                placement=Placement(kind) if isinstance(kind, str) else None,
            )
        )
    return offered


def formulas_from_json(data: Any) -> list[dict[str, str]]:
    """The model formulas of the notebook's cells, as the kernel's analysis found them: [{"cell": "[5]", "formula": "y ~ x"}]."""
    if not isinstance(data, list):
        return []
    formulas = []
    for item in data[:MAX_FORMULAS]:
        if isinstance(item, dict) and isinstance(item.get("formula"), str):
            formulas.append({"cell": str(item.get("cell") or ""), "formula": item["formula"][:300]})
    return formulas


def found_from_json(data: Any) -> list[dict[str, str]]:
    """What agents found in the notebook, newest first, as the view sends it: [{"question", "answer"}].

    A run without an answer is left out. At most MAX_FOUND, each answer cut
    to FOUND_CHARS and each question to 300 characters.
    """
    if not isinstance(data, list):
        return []
    found = []
    for item in data:
        if isinstance(item, dict) and isinstance(item.get("answer"), str) and item["answer"].strip():
            found.append({"question": str(item.get("question") or "")[:300], "answer": item["answer"].strip()[:FOUND_CHARS]})
            if len(found) == MAX_FOUND:
                break
    return found


def frames_state(context: Context) -> dict[str, Any]:
    """The frames of the kernel as a model reads them: rows, and the name and kind of each column.

    Names, kinds and sizes are what a remote model may read with "Keep data on
    this machine" on (``privacy.VARIABLE_FIELDS``).
    """
    frames = {}
    for name, columns in list(context.frames.items())[:MAX_FRAMES]:
        entry: dict[str, Any] = {"rows": context.frame_rows.get(name), "columns": dict(list(columns.items())[:MAX_COLUMNS])}
        if len(columns) > MAX_COLUMNS:
            entry["more_columns"] = len(columns) - MAX_COLUMNS
        frames[name] = entry
    return frames


# How many columns of each group of "timing" a model reads.
MAX_TIMED = 20


def _timed(column: str, tag: str) -> bool:
    """Whether a column places a row in time: a date, or a number named as a time, such as week (``templates.TIME_NAME``)."""
    return tag == "date" or (tag in ("int", "num") and bool(TIME_NAME.match(column.lower())))


def timing(context: Context) -> dict[str, list[str]]:
    """The columns of the frames by when they are set, where the frames show it: "time", "per_unit" and "repeated".

    The frame of the units is the smallest frame that holds a unit column,
    when a larger frame holds it too, as patients beside the diary: its other
    columns hold one value per unit, and the columns of the larger frames that
    it lacks are measured on their rows. A time column is a date or a number
    named as a time in a larger frame; a date in the frame of the units, such
    as the day a home switched tariff, is one value per unit. Without the
    frame of the units, only the numbers named as a time count, since a date
    there may be one value per unit. Groups without a column are left out.
    """
    frames, rows = context.frames, context.frame_rows
    units = [unit for unit in dict.fromkeys((context.unit, *context.units)) if unit]
    for unit in units:
        holders = [name for name, columns in frames.items() if unit in columns and isinstance(rows.get(name), int)]
        if len(holders) < 2:
            continue
        smallest = min(holders, key=lambda name: rows[name])
        larger = [name for name in holders if rows[name] > rows[smallest]]
        if not larger:
            continue
        per_unit = [column for column in frames[smallest] if column != unit]
        time: list[str] = []
        repeated: list[str] = []
        for name in larger:
            for column, tag in frames[name].items():
                if column == unit or column in frames[smallest] or column in time or column in repeated:
                    continue
                (time if _timed(column, tag) else repeated).append(column)
        groups = {"time": time, "per_unit": per_unit, "repeated": repeated}
        break
    else:
        time = [column for columns in frames.values() for column, tag in columns.items() if tag in ("int", "num") and _timed(column, tag)]
        groups = {"time": list(dict.fromkeys(time))}
    return {key: value[:MAX_TIMED] for key, value in groups.items() if value}


def inferred_columns(items: Any, context: Context) -> list[dict[str, str]]:
    """The outcomes or the units that a model named, each a column of a frame of the kernel.

    A column that no frame holds is left out, so a name that the model made up
    goes no further; so is a second mention of a column. At most MAX_INFERRED.
    """
    kept: list[dict[str, str]] = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("column"), str):
            continue
        column, frame = item["column"], item.get("frame")
        if not (isinstance(frame, str) and column in context.frames.get(frame, {})):
            frame = next((name for name, columns in context.frames.items() if column in columns), None)
        if frame is None or any(entry["column"] == column for entry in kept):
            continue
        kept.append({"column": column, "frame": frame, "why": str(item.get("why") or "")[:160]})
        if len(kept) == MAX_INFERRED:
            break
    return kept


# Words that carry no meaning of their own when two questions are compared,
# with "level", which a template's "the levels of" adds.
FILLER = frozenset(
    "a an the of to in on at by for with from and or but is are was were be been being does do did has have had "
    "should could would can may might will this that these those it its there their than then as into about "
    "how what when where which who whom whether why any some each every other others more most less much many "
    "not no per across within between among over level levels".split()
)
# Two questions ask the same thing when this share of their words, past the
# names of the items picked and the words of FILLER, is shared.
ALIKE = 0.6
# A name with an underscore, which the analyst's data has, and English has not.
IDENTIFIER = re.compile(r"(?<![\w.])[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+(?!\w)")
# A name in code.
NAME = re.compile(r"[A-Za-z_]\w*")


def _key(name: str) -> str:
    """A name as two names compare: in lower case, with a space and an underscore alike."""
    return re.sub(r"[\s_]+", "_", name.strip().lower())


def _mentions(text: str, name: str) -> bool:
    """Whether a question's text names ``name`` in whole words, with spaces for its underscores, or in the plural: "home ids" names home_id."""
    parts = [re.escape(part) for part in re.split(r"[\s_]+", name.strip()) if part]
    if not parts:
        return False
    return re.search(r"(?<!\w)" + r"[\s_]+".join(parts) + r"(?:e?s)?(?!\w)", text, re.IGNORECASE) is not None


def _items(selection: Selection) -> list[Variable]:
    """What was dropped or clicked: one item for a drop onto itself or onto a cell, else two."""
    if selection.target is None or selection.univariate:
        return [selection.source]
    return [selection.source, selection.target]


def _item_names(item: Variable, context: Context) -> list[str]:
    """The names by which a question uses an item: its label, the columns of a frame, the name of a file without its extension, and its table."""
    names = [item.label]
    if item.kind == "dataframe":
        names += list(context.frames.get(item.label) or context.frames.get(item.name) or {})
    elif item.kind in ("file", "table"):
        names.append(re.sub(r"\.[A-Za-z0-9]+$", "", item.label.rsplit("/", 1)[-1]))
        if item.table:
            names.append(item.table)
    return [name for name in names if name]


def _uses(question: dict, items: list[Variable], context: Context) -> bool:
    """Whether a question uses one of the items: it names one, or lists one among its columns.

    A question about a fitted model may call it "the model", so any question
    uses a model.
    """
    if any(item.kind == "model" for item in items):
        return True
    listed = {_key(name) for name in question.get("columns") or [] if isinstance(name, str)}
    for item in items:
        names = _item_names(item, context)
        if listed & {_key(name) for name in names} or any(_mentions(question["text"], name) for name in names):
            return True
    return False


def _known(
    selection: Selection,
    context: Context,
    cell: dict[str, str] | None,
    formulas: Sequence[dict[str, str]],
    shown: Sequence[Candidate],
) -> set[str] | None:
    """The names that a question may name, as keys.

    They are the frames, their columns, the items, the names in the code that
    the model read, and the names with an underscore in the titles of the
    cells and in the questions of the templates. None when the request lists
    no frame, or a file or a table that is not loaded: its columns are not in
    the request, so no name counts as missing.
    """
    items = [item for item in (selection.source, selection.target) if item is not None]
    if not context.frames or any(item.kind in ("file", "table") for item in items):
        return None
    names = {name for frame, columns in context.frames.items() for name in (frame, *columns)}
    for item in items:
        names |= {item.name, item.label, item.parent or "", *_item_names(item, context)}
    code = " ".join([*(formula["formula"] for formula in formulas), cell["code"] if cell else ""])
    titles = " ".join([*context.cells, *(candidate.text for candidate in shown)])
    names |= set(NAME.findall(code)) | set(IDENTIFIER.findall(titles))
    return {_key(name) for name in names if name}


def _missing(question: dict, known: set[str] | None, frames: Sequence[str]) -> list[str]:
    """The columns that a question names and no frame holds: those it lists, and the names with an underscore in its text.

    A listed name can say its frame, as visits.week, or derive one column
    from others, as kwh_peak/kwh_import: each of its names counts.
    """
    if known is None:
        return []
    qualifiers = {_key(frame) for frame in frames}
    named = [name.strip() for name in question.get("columns") or [] if isinstance(name, str) and name.strip()]
    named += IDENTIFIER.findall(question["text"])
    missing = []
    for name in named:
        key = _key(name)
        if key in known:
            continue
        parts = [part for part in re.findall(r"[a-z0-9_]+", key) if not part.isdigit() and part not in qualifiers]
        if any(part not in known for part in parts) and name not in missing:
            missing.append(name)
    return missing


def _stem(word: str) -> str:
    """A word without the ending of its plural or its tense, as two questions compare: "varies" is "vary", "modelling" is "model"."""
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"
    for ending in ("ly", "ing", "ed", "s"):
        if word.endswith(ending) and len(word) - len(ending) >= 4:
            word = word[: -len(ending)]
            break
    return word[:-1] if len(word) > 4 and word[-1] == word[-2] else word


def _content(text: str, names: frozenset[str]) -> frozenset[str]:
    """The words of a question that say what it asks: without the names of the items picked, and without the words of FILLER."""
    words = re.findall(r"[a-z0-9]+(?:_[a-z0-9]+)*", text.lower())
    return frozenset(_stem(word) for word in words if word not in FILLER and word not in names and _stem(word) not in names)


def _same(first: frozenset[str], second: frozenset[str]) -> bool:
    if not first and not second:
        return True
    return len(first & second) / len(first | second) >= ALIKE


def alike(first: str, second: str, names: Sequence[str]) -> bool:
    """Whether two questions about the items of ``names`` ask the same thing in other words."""
    keys = frozenset(_key(name) for name in names)
    return first.strip().lower() == second.strip().lower() or _same(_content(first, keys), _content(second, keys))


def kept(
    questions: list[dict],
    selection: Selection,
    context: Context,
    shown: Sequence[Candidate],
    cell: dict[str, str] | None = None,
    formulas: Sequence[dict[str, str]] = (),
) -> tuple[list[dict], list[dict[str, str]]]:
    """The model's questions that the view offers, and those left out, each with why.

    A question is left out when it repeats a question offered, asked or kept
    before it, in the same or in other words; when it uses none of the items
    picked; or when it names a column that the frames of the request lack.
    """
    items = _items(selection)
    names = frozenset(_key(item.label) for item in items)
    known = _known(selection, context, cell, formulas, shown)
    earlier = [(text, _content(text, names)) for text in [*(c.text for c in shown), *(q.text for q in context.asked)]]
    labels = [item.label for item in items]
    unused = f"does not use {labels[0]}" if len(labels) == 1 else f"uses neither {labels[0]} nor {labels[1]}"
    offered: list[dict] = []
    left_out: list[dict[str, str]] = []
    for question in questions:
        text = question["text"].strip()
        words = _content(text, names)
        repeat = next((before for before, seen in earlier if before.strip().lower() == text.lower() or _same(words, seen)), None)
        if repeat is not None:
            why = f'repeats "{repeat}"'
        elif not _uses(question, items, context):
            why = unused
        else:
            missing = _missing(question, known, list(context.frames))
            if not missing:
                offered.append(question)
                earlier.append((text, words))
                continue
            why = f"names {', '.join(missing)}, which no frame holds"
        left_out.append({"text": text, "why": why})
    return offered, left_out


def _order(
    questions: list[Candidate],
    offered: list[Candidate] | None,
    selection: Selection,
    context: Context,
    cell: dict[str, str] | None,
    cells_above: int,
) -> list[str] | None:
    """The ids of the offered questions and the model's, in the view's order, or None when the view sent no questions."""
    if offered is None:
        return None
    involved = [v for v in (selection.source, selection.target) if v is not None and not (selection.univariate and v is selection.target)]
    # A drop onto a cell keeps the rules' order, as its options do (drops.drop_options).
    merged = merged_order(offered, questions, involved, context, learned=cell is None, cells_above=cells_above)
    return [candidate.id for candidate in merged]


async def generate(
    selection: Selection,
    context: Context,
    suggested: list[Candidate],
    config: Whybook,
    keep_local: bool = False,
    cell: dict[str, str] | None = None,
    offered: list[Candidate] | None = None,
    formulas: list[dict[str, str]] | None = None,
    cells_above: int = 0,
    found: list[dict[str, str]] | None = None,
) -> AsyncIterator[claude.Event]:
    """Stream progress events, then a result event with the new questions, the outcomes and the units.

    ``offered`` holds the questions that the request offers already (the view
    sends them with the questions of a drop): the model reads their texts and
    adds what they miss, and the result gives the order of all of them
    (``order``). Without them, the catalogue's questions of the selection
    stand in (``suggested``). The result lists the questions left out, with
    why (``kept``), in ``left_out``.

    With the data on this machine, the selection goes as names, kinds and sizes,
    and the questions already offered stay here, since a template's text can
    hold a constant's value; so does what agents found (``found``), since an
    answer can quote one. The frames go as names, kinds and sizes either way.
    ``cell`` is the cell of a drop onto a cell (``dropped_onto``): its code
    goes as the notebook's cells do.
    """
    shown = offered if offered is not None else suggested
    state = jev_state(selection, context)
    if cell is not None:
        state["dropped_onto"] = cell
    state["frames"] = frames_state(context)
    timed = timing(context)
    if timed:
        state["timing"] = timed
    state["formulas"] = formulas or []
    if keep_local:
        state = privacy.local_state(state)
    else:
        state["already_suggested"] = [
            {"text": c.text, "runs": bool(c.code)} if offered is not None else c.text for c in shown
        ]
        if found:
            state["found_so_far"] = found
    prompt = json.dumps(state, indent=1)
    variables = tuple(v.name for v in (selection.source, selection.target) if v is not None)
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
            offers, left_out = kept(output.get("questions") or [], selection, context, shown, cell, formulas or [])
            questions = [_candidate(item, variables) for item in offers]
            order = _order(questions, offered, selection, context, cell, cells_above)
            event["questions"] = [question.to_json() for question in questions]
            event["left_out"] = left_out
            event["outcomes"] = inferred_columns(output.get("outcomes"), context)
            event["units"] = inferred_columns(output.get("units"), context)
            if order is not None:
                event["order"] = order
        yield event


def _misfit(problems: list[str]) -> dict:
    """The error for an answer that another path let through and that the questions cannot be read from."""
    return {"type": "error", "message": f"The AI model's questions did not come in the form asked for: {'; '.join(problems[:3])}."}


# A local model gets the same instructions, a grammar that holds each answer to
# the schema and to a length, and a shorter history: its context is 4,096 tokens.
WORD = local_models.WORD
LOCAL_SCHEMA = {
    "type": "object",
    "properties": {
        "questions": {
            "type": "array",
            "minItems": 1,
            "maxItems": 5,
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "pattern": rf"^{WORD}( {WORD}){{2,15}}$"},
                    "type": {"type": "string", "enum": list(TYPES)},
                    "why": {"type": "string", "pattern": rf"^{WORD}( {WORD}){{0,19}}$"},
                    "priority": {"type": "number"},
                },
                "required": ["text", "type", "why", "priority"],
            },
        }
    },
    "required": ["questions"],
}


def local_state(
    selection: Selection,
    context: Context,
    suggested: list[Candidate],
    cell: dict[str, str] | None = None,
    found: list[dict[str, str]] | None = None,
) -> dict:
    """What a local model reads: the selection, the cell it was dropped onto, the last 8 cells, 15 questions asked and the 2 newest findings of agents."""
    state = jev_state(selection, context)
    if cell is not None:
        state["dropped_onto"] = {**cell, "code": cell["code"][:600]}
    state["analysis_so_far"] = [str(cell)[:300] for cell in state["analysis_so_far"][-8:]]
    state["already_asked"] = state["already_asked"][-15:]
    state["already_suggested"] = [c.text for c in suggested]
    if found:
        state["found_so_far"] = [{**item, "answer": item["answer"][:LOCAL_FOUND_CHARS]} for item in found[:LOCAL_FOUND]]
    return state


async def generate_local(
    model_id: str,
    selection: Selection,
    context: Context,
    suggested: list[Candidate],
    threads: int,
    check: str = "fast",
    cell: dict[str, str] | None = None,
    offered: list[Candidate] | None = None,
    cells_above: int = 0,
    found: list[dict[str, str]] | None = None,
) -> AsyncIterator[dict]:
    """Stream progress events, then a result event with a local model's questions.

    A local model names no outcome or unit: its context is short, and its
    grammar holds the questions alone, without their columns. Its questions
    are kept as the connected model's are (``kept``), by their words.
    """
    shown = offered if offered is not None else suggested
    variables = tuple(v.name for v in (selection.source, selection.target) if v is not None)
    state = local_state(selection, context, shown, cell, found)
    async for event in local_models.ask_json(
        model_id, LOCAL_SYSTEM_PROMPT, state, LOCAL_SCHEMA, 400, threads, "writing questions", check
    ):
        if event["type"] == "result":
            output = event.pop("output")
            problems = claude.matches(output, LOCAL_SCHEMA)
            if problems:
                yield _misfit(problems)
                return
            offers, left_out = kept(output.get("questions") or [], selection, context, shown, cell)
            questions = [_candidate(item, variables, "local") for item in offers]
            order = _order(questions, offered, selection, context, cell, cells_above)
            event["questions"] = [question.to_json() for question in questions]
            event["left_out"] = left_out
            event["outcomes"], event["units"] = [], []
            if order is not None:
                event["order"] = order
        yield event
