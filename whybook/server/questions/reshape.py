"""A frame that holds one measure in numbered columns, reshaped to one row per number.

The pain diary comes as one row per patient and week, with the pain, the
sleep and the mood of each day in pain_1 to pain_7, sleep_1 to sleep_7 and
mood_1 to mood_7. Until design iteration 1.85 only a model could reshape it,
and the questions read pain_2 and pain_1 as two measures. The reshape is
``pd.wide_to_long`` on the stubs, with a running number of the day when a
week column numbers the rows, and without the days that hold no value.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

from .. import codegen
from .templates import TIME_NAME

# A measure and its number: pain_1, sleep_7.
STUB = re.compile(r"^(?P<stub>.*[A-Za-z].*?)_(?P<number>\d+)$")


def stub_groups(columns: Iterable[str]) -> dict[str, list[str]]:
    """The columns that hold one measure under consecutive numbers, by measure: {"pain": ["pain_1", ..., "pain_7"]}.

    Two numbers or more, from 0 or 1 with no gap: pain_1 to pain_7, not
    q3_7 alone.
    """
    found: dict[str, dict[int, str]] = {}
    for column in columns:
        match = STUB.match(str(column))
        if match:
            found.setdefault(match["stub"], {})[int(match["number"])] = str(column)
    groups = {}
    for stub, numbered in found.items():
        numbers = sorted(numbered)
        if len(numbers) >= 2 and numbers[0] in (0, 1) and numbers == list(range(numbers[0], numbers[0] + len(numbers))):
            groups[stub] = [numbered[number] for number in numbers]
    return groups


def stub_of(column: str, groups: dict[str, list[str]]) -> str | None:
    """The measure of a numbered column: "pain" for pain_2."""
    return next((stub for stub, members in groups.items() if column in members), None)


@dataclass(frozen=True)
class Reshape:
    """How a frame goes to one row per number of its stubs."""

    stubs: tuple[str, ...]
    # The columns that name a row of the wide frame: the unit, and a time such as the week.
    keys: tuple[str, ...]
    # The column of the numbers, and how many there are: day, 7.
    step: str
    per: int
    first: int
    # The running number of the step over the time: day_number = (week - first week) * 7 + day.
    time: str | None
    running: str | None


def words(items: list[str], joint: str = "and") -> str:
    return items[0] if len(items) == 1 else f"{', '.join(items[:-1])} {joint} {items[-1]}"


def plan(columns: Iterable[str], unit: str | None, tags: dict[str, str] | None = None) -> Reshape | None:
    """The reshape of a frame with these columns, or None when no stubs share their numbers or no column names a row.

    The keys are the unit, or a column tagged or named as an id, and a
    column named as a time, such as week. Seven numbers over a week are
    days, and twelve over a year are months: those get a running number.
    """
    names = [str(column) for column in columns]
    groups = stub_groups(names)
    if not groups:
        return None
    # The measures that share the numbers of the first: pain, sleep and mood, each 1 to 7.
    first = next(iter(groups.values()))
    numbers = [STUB.match(column)["number"] for column in first]  # type: ignore[index]
    stubs = tuple(stub for stub, members in groups.items() if [STUB.match(column)["number"] for column in members] == numbers)  # type: ignore[index]
    wide = {column for stub in stubs for column in groups[stub]}
    rest = [column for column in names if column not in wide]
    tags = tags or {}
    ids = [column for column in rest if column == unit] or [
        column for column in rest if tags.get(column) == "id" or column.lower() == "id" or column.lower().endswith("_id")
    ]
    times = [column for column in rest if TIME_NAME.match(column.lower()) and tags.get(column, "int") in ("int", "num")]
    keys = tuple(ids[:1] + times[:1])
    if not keys:
        return None
    per, start = len(numbers), int(numbers[0])
    time = times[0] if times else None
    step, running = "number", None
    if time and per == 7 and re.search(r"week", time.lower()):
        step, running = "day", "day_number"
    elif time and per == 12 and re.search(r"year", time.lower()):
        step, running = "month", "month_number"
    if step in rest or running in rest:
        step, running = f"{step}_in_row", None
    return Reshape(stubs, keys, step, per, start, time, running)


def name_for(frame: str, taken: Iterable[str]) -> str:
    """The name of the long frame: diary for diary_raw, visits_long for visits, and a number after a name that is taken."""
    taken = set(taken)
    stem = re.sub(r"_(raw|wide)$", "", frame)
    name = codegen.identifier(stem if stem != frame else f"{frame}_long")
    candidate, count = name, 2
    while candidate in taken:
        candidate, count = f"{name}_{count}", count + 1
    return candidate


def text(frame: str, reshape: Reshape) -> str:
    return f"Reshape {frame} to one row per {reshape.step}: {words(list(reshape.stubs))}"


def effect(reshape: Reshape) -> str:
    columns = len(reshape.stubs) * reshape.per
    running = f", with a running {reshape.running}" if reshape.running else ""
    return f"One frame from {columns} columns{running}, without the {reshape.step}s that hold no value"


def lines(source: str, name: str, reshape: Reshape) -> list[str]:
    """The lines that make ``name`` from the frame ``source``: the reshape, the running number, and the steps with no value left out."""
    stubs = codegen.literals(reshape.stubs)
    keys = codegen.literals(reshape.keys) if len(reshape.keys) > 1 else codegen.literal(reshape.keys[0])
    step, logged = codegen.literal(reshape.step), codegen.temporary(name, "logged")
    out = [f"{name} = pd.wide_to_long({source}, stubnames={stubs}, i={keys}, j={step}, sep=\"_\").reset_index()"]
    if reshape.running and reshape.time:
        time = codegen.literal(reshape.time)
        out.append(f"{name}[{codegen.literal(reshape.running)}] = ({name}[{time}] - {name}[{time}].min()) * {reshape.per} + {name}[{step}] - {reshape.first - 1}")
    order = [reshape.keys[0], reshape.running] if reshape.running else [*reshape.keys, reshape.step]
    out += [
        f"{logged} = {name}[{stubs}].notna().any(axis=1)",
        # The words stay out of the f-string, where a brace in a name would run.
        f"print(f\"{{len({name}):,}} {reshape.step}s,\", f\"{{(~{logged}).sum():,}}\", {codegen.literal(f'without any value of {words(list(reshape.stubs), "or")}, left out.')})",
        f"{name} = {name}[{logged}].sort_values({codegen.literals(order)}).reset_index(drop=True)",
        f"del {logged}",
        f"{name}.head()",
    ]
    return out
