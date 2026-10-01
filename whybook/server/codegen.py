"""Edits to cell source for the offline code templates.

Each edit replaces the text of one syntax node and keeps the rest of the cell
as the user wrote it, including comments and layout. The functions return
None when the edit does not apply, so the caller can fall back to Claude.
"""

from __future__ import annotations

import ast
import keyword
import re
from collections.abc import Collection, Iterable
from dataclasses import dataclass

KEY_PATTERN = re.compile(r"(^|_)(id|week|day|date|visit|month|time)$")


# Names in generated code. A column, a key, a group of columns, a file or a
# table comes from the data or from a notebook, and its name can hold a space,
# a quote, a backslash or a line break. Every such name goes into the code
# through literal(), and into a comment through comment(), so that no name
# ends the string or the line that it is in.


def literal(text: str) -> str:
    """``text`` as a Python string literal: ``sleep "hours"`` gives ``'sleep "hours"'``.

    The literal reads back as ``text``, whatever it holds. A text without a
    double quote gets double quotes, as the templates write their strings.
    """
    quoted = repr(str(text))
    return f'"{quoted[1:-1]}"' if quoted[0] == "'" and '"' not in text else quoted


def literals(texts: Iterable[str]) -> str:
    """A Python list of names: ``["patient_id", "week"]``."""
    return "[" + ", ".join(literal(text) for text in texts) + "]"


def term(name: str) -> str:
    """A column as a term of a model formula: its name, or ``Q("sleep hours")`` for a name that is not a Python name."""
    return name if name.isidentifier() and not keyword.iskeyword(name) else f"Q({literal(name)})"


def formula(outcome: str, terms: Iterable[str]) -> str:
    """A model formula as a Python string literal: ``'pain ~ week + Q("sleep hours")'``."""
    return literal(f"{term(outcome)} ~ {' + '.join(term(name) for name in terms)}")


def comment(text: str) -> str:
    """A comment of generated code, on one line: a line break in a name does not end it."""
    return "# " + "".join(char if char.isprintable() else " " for char in str(text))


def _reads_as(text: str, value: str) -> bool:
    """Whether the source ``text`` is string literals only, which read back as ``value``."""
    try:
        return ast.literal_eval(text) == value
    except (SyntaxError, ValueError):
        return False


def _line_starts(source: str) -> list[int]:
    starts = [0]
    for index, char in enumerate(source):
        if char == "\n":
            starts.append(index + 1)
    return starts


def _offset(source: str, starts: list[int], lineno: int, col: int) -> int:
    """Character offset of an AST position; ``col`` counts UTF-8 bytes."""
    line_start = starts[lineno - 1]
    line = source[line_start:].split("\n", 1)[0]
    return line_start + len(line.encode("utf-8")[:col].decode("utf-8", errors="ignore"))


def _span(source: str, starts: list[int], node: ast.AST) -> tuple[int, int]:
    return (
        _offset(source, starts, node.lineno, node.col_offset),
        _offset(source, starts, node.end_lineno, node.end_col_offset),
    )


def _apply(source: str, edits: list[tuple[int, int, str]]) -> str:
    for start, end, text in sorted(edits, key=lambda edit: edit[0], reverse=True):
        source = source[:start] + text + source[end:]
    return source


def _parse(source: str) -> ast.Module | None:
    try:
        return ast.parse(source)
    except SyntaxError:
        return None


# A call by the place where the cell names its function: the line, from 1, and
# the column, in UTF-8 bytes from the start of the line, as ``ast`` counts them.
Site = tuple[int, int]


def _pipes(node: ast.Call, function: str | None) -> bool:
    """Whether a call is ``obj.pipe(f, ...)``, of ``function`` when one is given."""
    callee = node.func
    if not (isinstance(callee, ast.Attribute) and callee.attr == "pipe" and node.args):
        return False
    first = node.args[0]
    if not isinstance(first, (ast.Name, ast.Attribute)):
        return False
    return function is None or getattr(first, "id", None) == function or getattr(first, "attr", None) == function


def _name_site(node: ast.expr) -> Site:
    if isinstance(node, ast.Attribute):
        return node.end_lineno or node.lineno, (node.end_col_offset or 0) - len(node.attr.encode("utf-8"))
    return node.lineno, node.col_offset


def call_site(node: ast.Call) -> Site:
    """Where a call names its function: ``merge`` in ``.merge(...)``, ``f`` in ``.pipe(f)``.

    The kernel's analysis keys each decision's calls by the same place
    (``call_site`` in kernel_code/analyze_cells.py). The place of the call
    itself cannot tell two calls of a chain apart: each starts where the
    chain starts.
    """
    if _pipes(node, None):
        return _name_site(node.args[0])
    return _name_site(node.func)


def calls_to(tree: ast.AST, function: str, at: Collection[Site] | None = None) -> list[ast.Call]:
    """Calls of ``function``: ``f(...)``, ``module.f(...)``, ``obj.f(...)`` or ``obj.pipe(f, ...)``.

    With ``at``, only the calls that name the function at one of those places.
    """
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        callee = node.func
        if isinstance(callee, ast.Name) and callee.id == function:
            found.append(node)
        elif isinstance(callee, ast.Attribute) and callee.attr == function:
            found.append(node)
        elif _pipes(node, function):
            found.append(node)
    if at is not None:
        places = set(at)
        found = [node for node in found if call_site(node) in places]
    return found


def add_keyword(source: str, function: str, param: str, value: str, at: Collection[Site] | None = None) -> str | None:
    """Pass ``param=value`` in every call of ``function``, replacing a value already passed.

    With ``at``, only in the calls that name the function at those places,
    such as the second merge of a chain alone.
    """
    tree = _parse(source)
    if tree is None:
        return None
    calls = calls_to(tree, function, at)
    if not calls:
        return None
    starts = _line_starts(source)
    edits = []
    for call in calls:
        existing = next((kw for kw in call.keywords if kw.arg == param), None)
        if existing is not None:
            start, end = _span(source, starts, existing.value)
            edits.append((start, end, value))
            continue
        _, end = _span(source, starts, call)
        closing = source.rfind(")", 0, end)
        has_arguments = bool(call.args or call.keywords)
        inner = source[source.find("(", _span(source, starts, call.func)[1]) + 1 : closing].strip()
        separator = ", " if has_arguments and inner and not inner.endswith(",") else ""
        edits.append((closing, closing, f"{separator}{param}={value}"))
    return _apply(source, edits)


def replace_string(source: str, old: str, new: str) -> str | None:
    """Replace the string literal ``old`` with the string ``new``, in the quotes that ``old`` had when they can hold it.

    ``"pain ~ week"`` becomes ``'pain ~ week + Q("sleep hours")'``: in double
    quotes, the term's own quotes would end the string.
    """
    tree = _parse(source)
    if tree is None:
        return None
    starts = _line_starts(source)
    edits = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and node.value == old and isinstance(old, str):
            start, end = _span(source, starts, node)
            quote = source[start] if source[start] in "'\"" else '"'
            text = f"{quote}{new}{quote}"
            edits.append((start, end, text if _reads_as(text, new) else literal(new)))
    return _apply(source, edits) if edits else None


_OPERATORS = {
    ast.Add: "+", ast.Sub: "-", ast.Mult: "*", ast.MatMult: "@", ast.Div: "/", ast.Mod: "%", ast.Pow: "**",
    ast.LShift: "<<", ast.RShift: ">>", ast.BitOr: "|", ast.BitXor: "^", ast.BitAnd: "&", ast.FloorDiv: "//",
}
_FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)
_COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)


def _stored(nodes: list[ast.AST]) -> set[str]:
    """The names that code assigns in its own scope: not in the functions, classes and comprehensions it holds."""
    found: set[str] = set()
    pending = list(nodes)
    while pending:
        node = pending.pop()
        if isinstance(node, _FUNCTIONS + _COMPREHENSIONS):
            continue
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            found.add(node.id)
        pending.extend(ast.iter_child_nodes(node))
    return found


class _Renamer(ast.NodeVisitor):
    """Reads a cell in the order Python runs it, and chooses the new text of each name.

    ``names`` maps what the cell assigns to its new name, from the name's first
    assignment on. ``inputs`` maps a name, where the cell reads it before it
    assigns it, to what the new code reads there instead. ``assigned`` holds
    every name that the cell assigns, for the functions, which run later.
    """

    def __init__(self, names: dict[str, str], inputs: dict[str, str], assigned: set[str], bound: set[str] | None = None) -> None:
        self.names, self.inputs, self.assigned = names, inputs, assigned
        # The names of ``names`` that the code has assigned so far.
        self.bound: set[str] = set(bound or ())
        self.changes: dict[ast.Name, str] = {}
        # x += 1 on a name not assigned yet: written as x_2 = x + (1).
        self.augmented: list[ast.AugAssign] = []
        # A loop that reads a name before it assigns it: new = old goes before the loop.
        self.aliases: list[tuple[ast.stmt, str, str]] = []
        # The names read before they were assigned, for a loop.
        self.early: set[str] = set()

    def _read(self, node: ast.Name) -> None:
        if node.id in self.bound:
            self.changes[node] = self.names[node.id]
            return
        if node.id in self.names:
            self.early.add(node.id)
        if node.id in self.inputs:
            self.changes[node] = self.inputs[node.id]

    def visit_Name(self, node: ast.Name) -> None:
        if not isinstance(node.ctx, ast.Store):
            self._read(node)
        elif node.id in self.names:
            self.changes[node] = self.names[node.id]
            self.bound.add(node.id)

    def visit_Assign(self, node: ast.Assign) -> None:
        self.visit(node.value)
        for target in node.targets:
            self.visit(target)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if node.value is not None:
            self.visit(node.value)
        self.visit(node.annotation)
        if node.value is not None or not isinstance(node.target, ast.Name):
            self.visit(node.target)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        target = node.target
        if isinstance(target, ast.Name) and target.id in self.names and target.id not in self.bound:
            self.augmented.append(node)
            self.visit(node.value)
            self.bound.add(target.id)
            return
        if isinstance(target, ast.Name):
            if target.id in self.bound:
                self.changes[target] = self.names[target.id]
        else:
            self.visit(target)
        self.visit(node.value)

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
        self.visit(node.value)
        self.visit(node.target)

    def _loop(self, node: ast.stmt, once: list[ast.AST], repeated: list[ast.AST]) -> None:
        for part in once:
            self.visit(part)
        # A name that the loop reads before it assigns it reads, from the second
        # round on, what the round before assigned: it takes its new name before the loop.
        probe = _Renamer(self.names, {}, self.assigned, self.bound)
        for part in repeated:
            probe.visit(part)
        for name in sorted(probe.early & (probe.bound - self.bound)):
            self.aliases.append((node, self.names[name], self.inputs.get(name, name)))
            self.bound.add(name)
        for part in repeated:
            self.visit(part)

    def visit_For(self, node: ast.For | ast.AsyncFor) -> None:
        self._loop(node, [node.iter], [node.target, *node.body])
        for statement in node.orelse:
            self.visit(statement)

    visit_AsyncFor = visit_For

    def visit_While(self, node: ast.While) -> None:
        self._loop(node, [], [node.test, *node.body])
        for statement in node.orelse:
            self.visit(statement)

    def _later(self, node: ast.AST) -> None:
        """A function, a lambda or a class: what it evaluates now, and a body that reads the names when it runs."""
        if isinstance(node, ast.ClassDef):
            now: list[ast.AST] = [*node.decorator_list, *node.bases, *(item.value for item in node.keywords)]
            body: list[ast.AST] = list(node.body)
            local = _stored(body)
        else:
            arguments = node.args
            now = [*arguments.defaults, *(default for default in arguments.kw_defaults if default is not None)]
            if not isinstance(node, ast.Lambda):
                now += node.decorator_list
            body = list(node.body) if isinstance(node.body, list) else [node.body]
            every = arguments.posonlyargs + arguments.args + arguments.kwonlyargs + [a for a in (arguments.vararg, arguments.kwarg) if a]
            local = _stored(body) | {argument.arg for argument in every}
        for part in now:
            self.visit(part)
        # The body runs later: a name that the cell assigns anywhere is the new one by then.
        for part in body:
            for child in ast.walk(part):
                if not isinstance(child, ast.Name) or child.id in local:
                    continue
                if child.id in self.names and child.id in self.assigned:
                    self.changes[child] = self.names[child.id]
                elif child.id in self.inputs:
                    self.changes[child] = self.inputs[child.id]

    visit_FunctionDef = visit_AsyncFunctionDef = visit_Lambda = visit_ClassDef = _later

    def _comprehension(self, node: ast.AST) -> None:
        # The first iterable is read where the comprehension is; the rest in its own scope, at once.
        self.visit(node.generators[0].iter)
        local = {name.id for generator in node.generators for name in ast.walk(generator.target) if isinstance(name, ast.Name)}
        parts: list[ast.AST] = [node.key, node.value] if isinstance(node, ast.DictComp) else [node.elt]
        for index, generator in enumerate(node.generators):
            parts += generator.ifs + ([generator.iter] if index else [])
        for part in parts:
            for child in ast.walk(part):
                if isinstance(child, ast.Name) and child.id not in local and not isinstance(child.ctx, ast.Store):
                    self._read(child)

    visit_ListComp = visit_SetComp = visit_DictComp = visit_GeneratorExp = _comprehension


def rename(source: str, names: dict[str, str], inputs: dict[str, str] | None = None) -> str | None:
    """Rename what a cell assigns, from its first assignment on, leaving attributes and keyword argument names alone.

    A read that comes before the first assignment keeps the old name, as it
    reads what the cell starts from, or takes the name that ``inputs`` gives:
    ``weekly = weekly[weekly["days"] >= 14]`` becomes ``weekly_if_7 =
    weekly[weekly["days"] >= 14]``, and a later ``weekly.head()`` becomes
    ``weekly_if_7.head()``. A loop that reads a name before it assigns it
    gets ``weekly_if_7 = weekly`` before it, so that each round reads the
    round before, as in the cell.
    """
    tree = _parse(source)
    if tree is None:
        return None
    renamer = _Renamer(names, dict(inputs or {}), _stored(list(tree.body)))
    for statement in tree.body:
        renamer.visit(statement)
    starts = _line_starts(source)
    edits = []
    for node, text in renamer.changes.items():
        start, end = _span(source, starts, node)
        edits.append((start, end, text))
    for node in renamer.augmented:
        start, _ = _span(source, starts, node)
        value_start, value_end = _span(source, starts, node.value)
        old = node.target.id
        before = renamer.inputs.get(old, old)
        edits.append((start, value_start, f"{names[old]} = {before} {_OPERATORS[type(node.op)]} ("))
        edits.append((value_end, value_end, ")"))
    for loop, new, old in renamer.aliases:
        start, _ = _span(source, starts, loop)
        indent = source[starts[loop.lineno - 1] : start]
        edits.append((start, start, f"{new} = {old}\n{indent}"))
    return _apply(source, edits)


def replace_assignment(source: str, name: str, text: str) -> str | None:
    """Replace the value of the top-level assignments ``name = ...``."""
    tree = _parse(source)
    if tree is None:
        return None
    starts = _line_starts(source)
    edits = []
    for statement in tree.body:
        if isinstance(statement, ast.Assign) and len(statement.targets) == 1:
            target = statement.targets[0]
            if isinstance(target, ast.Name) and target.id == name:
                start, end = _span(source, starts, statement.value)
                edits.append((start, end, text))
    return _apply(source, edits) if edits else None


def replace_argument(source: str, function: str, old: str, text: str, at: Collection[Site] | None = None) -> str | None:
    """Replace a positional argument of ``function`` whose source text is ``old``, in the calls at ``at`` if given."""
    tree = _parse(source)
    if tree is None:
        return None
    starts = _line_starts(source)
    edits = []
    for call in calls_to(tree, function, at):
        for argument in call.args:
            start, end = _span(source, starts, argument)
            if source[start:end] == old:
                edits.append((start, end, text))
    return _apply(source, edits) if edits else None


def replace_keyword_value(source: str, function: str, param: str, text: str, at: Collection[Site] | None = None) -> str | None:
    """Replace the source text of ``param=...`` in calls of ``function``, in the calls at ``at`` if given."""
    tree = _parse(source)
    if tree is None:
        return None
    starts = _line_starts(source)
    edits = []
    for call in calls_to(tree, function, at):
        for keyword in call.keywords:
            if keyword.arg == param:
                start, end = _span(source, starts, keyword.value)
                edits.append((start, end, text))
    return _apply(source, edits) if edits else None


@dataclass
class ModelCall:
    """The parts of a ``smf.<model>("y ~ x", data=..., ...)`` call, as source text."""

    function: str
    formula: str
    data: str | None
    keywords: dict[str, str]
    fit_target: str | None


def model_call(source: str) -> ModelCall | None:
    """The first formula model call in the cell, and the variable its fit is assigned to."""
    tree = _parse(source)
    if tree is None:
        return None
    for statement in tree.body:
        for node in ast.walk(statement):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                continue
            first = node.args[0] if node.args else None
            if not (isinstance(first, ast.Constant) and isinstance(first.value, str) and "~" in first.value):
                continue
            keywords = {kw.arg: ast.get_source_segment(source, kw.value) for kw in node.keywords if kw.arg}
            data = keywords.pop("data", None)
            if data is None and len(node.args) > 1:
                data = ast.get_source_segment(source, node.args[1])
            target = None
            if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
                target = statement.targets[0].id
            return ModelCall(node.func.attr, first.value, data, keywords, target)
    return None


def defined_names(source: str) -> list[str]:
    """Names a cell assigns at top level, in order."""
    tree = _parse(source)
    if tree is None:
        return []
    names = []
    for statement in tree.body:
        targets = []
        if isinstance(statement, ast.Assign):
            targets = statement.targets
        elif isinstance(statement, (ast.AugAssign, ast.AnnAssign)):
            targets = [statement.target]
        for target in targets:
            for node in ast.walk(target):
                if isinstance(node, ast.Name) and node.id not in names:
                    names.append(node.id)
    return names


# The kind of values that a column of each tag holds, for a join: a key of
# one kind matches no row of a key of another. A date read from a CSV file is
# text, and a date read from parquet can hold Python dates ("other"): pandas
# merges the two and matches no row. An id, and a column whose tag is not
# known, such as the header of a file, join any key.
KEY_KINDS = {
    "int": "numbers",
    "num": "numbers",
    "bool": "numbers",
    "cat": "text",
    "text": "text",
    "ord": "text",
    "date": "dates",
    "other": "Python objects",
}


def same_kind(tag: str, other: str) -> bool:
    """Whether two key columns hold values of one kind, so that a join can match their rows."""
    first, second = KEY_KINDS.get(tag), KEY_KINDS.get(other)
    return first is None or second is None or first == second


def _key_like(column: str, columns: dict[str, str], other: dict[str, str], unit: str | None) -> bool:
    return column == unit or columns[column] == "id" or other[column] == "id" or bool(KEY_PATTERN.search(column.lower()))


def join_keys(columns: dict[str, str], other: dict[str, str], unit: str | None) -> list[str]:
    """Columns two frames share that identify a unit or a time, the unit first: those that hold values of one kind in both."""
    shared = set(columns) & set(other)
    keys = [c for c in shared if _key_like(c, columns, other, unit) and same_kind(columns[c], other[c])]
    return sorted(keys, key=lambda c: (c != unit, columns.get(c) != "id", c))


def mismatched_keys(columns: dict[str, str], other: dict[str, str], unit: str | None) -> list[str]:
    """Columns two frames share that look like keys, and that hold values of two kinds: a join on them matches no row."""
    shared = set(columns) & set(other)
    return sorted(c for c in shared if _key_like(c, columns, other, unit) and not same_kind(columns[c], other[c]))


def _arbitrary(column: str, columns: dict[str, str], keys: list[str], unit: str | None) -> bool:
    """Whether the first value of ``column`` per key is one arbitrary row's: a unit's id, or a level of the units, joined on a key that is not the unit.

    A number is averaged per key and stays. pain on a weekly frame of an
    agent took patient_id from the diary as diary.groupby("week")["patient_id"].first(),
    one patient for each week, and the share between patients ran on it.
    """
    if columns[column] in ("num", "int", "bool") and column != unit:
        return False
    if unit and unit in keys:
        return False
    return column == unit or columns[column] == "id" or bool(unit and unit in columns)


@dataclass
class DataPlan:
    """Code lines that build a frame with the needed columns, and what they join."""

    lines: list[str]
    name: str
    notes: list[str]


def plan_data(
    base: str,
    needed: list[str],
    frames: dict[str, dict[str, str]],
    unit: str | None,
    *,
    target: str,
    library: str | None = None,
) -> DataPlan | None:
    """Give ``base`` the columns in ``needed``, joining them from other frames.

    The lines build the frame under the name ``target``. For a temporary
    frame, the caller makes that name with ``temporary`` from what its option
    asks about. There is no default name, because two options that use one
    name fail when they run as branches at the same time.

    A column from a frame with more rows per key, such as a daily diary joined
    to weekly rows, is averaged per key first. Returns None when a column is
    in no frame that shares a key with ``base``. The joins are pandas code, or
    polars code when ``library`` is "polars"; the frames joined are taken to
    be of the same library.

    A unit's id, or a level that belongs to the units, does not join through
    another key: its first value per week is one arbitrary patient, or one
    arbitrary arm. Such a column comes only from a join on the unit
    (design iteration 1.85).
    """
    have = dict(frames.get(base, {}))
    missing = [column for column in dict.fromkeys(needed) if column not in have]
    if not missing:
        return DataPlan([], base, [])
    lines = [f"{target} = {base}"]
    notes = []
    for column in missing:
        source = None
        keys: list[str] = []
        for name, columns in frames.items():
            if name == base or column not in columns:
                continue
            found = join_keys(have, columns, unit)
            if found and not _arbitrary(column, columns, found, unit):
                source, keys = name, found
                break
        if source is None:
            return None
        aggregate = "mean" if frames[source][column] in ("num", "int", "bool") else "first"
        keys_text = literals(keys) if len(keys) > 1 else literal(keys[0])
        if library == "polars":
            lines.append(
                f"{target} = {target}.join({source}.group_by({keys_text}).agg(pl.col({literal(column)}).{aggregate}()), on={keys_text}, how=\"left\")"
            )
        else:
            lines.append(
                f"{target} = {target}.merge({source}.groupby({keys_text}, as_index=False, observed=True)"
                f"[{literal(column)}].{aggregate}(), on={keys_text}, how=\"left\")"
            )
        notes.append(f"{column} lives in {source}: joined on {', '.join(keys)} first")
        have[column] = frames[source][column]
    return DataPlan(lines, target, notes)


def identifier(text: str) -> str:
    """A valid, readable variable name made from ``text``: "class.csv" gives ``class_``, not the keyword."""
    name = re.sub(r"\W+", "_", text).strip("_").lower() or "result"
    # \w takes characters that a name cannot hold, such as the superscript in "x²".
    name = "".join(char if ("a" + char).isidentifier() else "_" for char in name)
    name = f"_{name}" if name[0].isdigit() else name
    return f"{name}_" if keyword.iskeyword(name) else name


def temporary(*words: str) -> str:
    """The name of a value that template code makes for its own use and deletes at its end.

    The name joins what the option asks about and what the value holds:
    ``temporary("IL6_vs_pain_score", "data")`` is ``_il6_vs_pain_score_data``.
    Branches run at the same time in subshells of one kernel, which share one
    namespace. With the fixed name ``_data``, the plot branch of a drop failed
    with a NameError after the association branch deleted ``_data``, and a
    branch could fit a model on the frame of another. Two options of one
    request ask about different things, so they get different names. The
    underscore keeps the name out of the variable listing.
    """
    return "_" + identifier("_".join(words)).lstrip("_")


def indent(code: str, spaces: int = 4) -> str:
    return "\n".join((" " * spaces + line) if line.strip() else line for line in code.split("\n"))


# Modules that generated code uses under their usual names.
KNOWN_IMPORTS = {
    "whybook": "import whybook",
    "np": "import numpy as np",
    "pd": "import pandas as pd",
    "pl": "import polars as pl",
    "plt": "import matplotlib.pyplot as plt",
    "sm": "import statsmodels.api as sm",
    "smf": "import statsmodels.formula.api as smf",
    "sns": "import seaborn as sns",
}


def add_missing_imports(source: str, defined: frozenset[str] | set[str] = frozenset()) -> str:
    """Import the usual modules that a cell uses and nothing defines.

    Code written by Claude can call ``whybook.progress`` or ``pd.merge`` as if an
    earlier cell imported them; in a notebook that never did, the cell stops
    with a NameError. ``defined`` holds the names the notebook's cells define,
    imports included, so a notebook that imports pandas once keeps doing so.
    The imports go after the leading comments.
    """
    tree = _parse(source)
    if tree is None:
        return source
    bound: set[str] = set()
    used: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            bound.update((alias.asname or alias.name).split(".")[0] for alias in node.names)
        elif isinstance(node, ast.Name):
            (used if isinstance(node.ctx, ast.Load) else bound).add(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.add(node.name)
        elif isinstance(node, ast.arg):
            bound.add(node.arg)
    missing = [line for name, line in KNOWN_IMPORTS.items() if name in used and name not in bound | set(defined)]
    if not missing:
        return source
    lines = source.split("\n")
    head = 0
    while head < len(lines) and lines[head].lstrip().startswith("#"):
        head += 1
    return "\n".join(lines[:head] + missing + lines[head:])

