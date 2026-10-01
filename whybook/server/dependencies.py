"""Which cells to run so that some names exist in the kernel.

Reads the cells' source with ``ast``, without the kernel: after a restart, or
with no kernel at all, the view still knows that the plot of ``weekly`` needs
the cell that defines ``weekly``, and the cells that one uses.
"""

from __future__ import annotations

import ast
import builtins
import json
import re
from dataclasses import dataclass
from typing import Any, AsyncIterator

from . import connection
from .config import Whybook
from .questions.models import InvalidRequest

BUILTINS = set(dir(builtins)) | {"display", "get_ipython", "In", "Out"}
# IPython lines that are not Python: magics and shell escapes.
MAGIC = re.compile(r"^\s*[%!]")


@dataclass(frozen=True)
class Cell:
    id: str
    source: str


# A function, a lambda, a class body and a comprehension have names of their own.
SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef, ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)


def _imported(node: ast.Import | ast.ImportFrom) -> list[str]:
    return [(alias.asname or alias.name).split(".")[0] for alias in node.names if alias.name != "*"]


def _arguments(arguments: ast.arguments) -> list[str]:
    every = arguments.posonlyargs + arguments.args + arguments.kwonlyargs + [a for a in (arguments.vararg, arguments.kwarg) if a]
    return [argument.arg for argument in every]


def _evaluated_first(scope: ast.AST) -> list[ast.AST]:
    """What the scope around a function, a lambda, a class or a comprehension evaluates when it makes it."""
    if isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
        arguments = scope.args
        parts: list[ast.AST] = [*arguments.defaults, *(d for d in arguments.kw_defaults if d is not None)]
        if not isinstance(scope, ast.Lambda):
            parts += scope.decorator_list
            parts += [a.annotation for a in (*arguments.posonlyargs, *arguments.args, *arguments.kwonlyargs, arguments.vararg, arguments.kwarg) if a and a.annotation]
            parts += [scope.returns] if scope.returns else []
        return parts
    if isinstance(scope, ast.ClassDef):
        return [*scope.decorator_list, *scope.bases, *(item.value for item in scope.keywords)]
    # A comprehension evaluates its first iterable in the scope around it.
    return [scope.generators[0].iter]


def _free(scope: ast.AST) -> tuple[set[str], set[str]]:
    """The names that a scope reads from the cell, and the names that it declares global and assigns.

    A name that a function assigns anywhere is local to all of it, and so is
    an argument; a comprehension's own names are its targets.
    """
    local: set[str] = set()
    read: set[str] = set()
    declared: set[str] = set()
    assigned: set[str] = set()
    if isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
        local.update(_arguments(scope.args))
        pending: list[ast.AST] = list(scope.body) if isinstance(scope.body, list) else [scope.body]
    elif isinstance(scope, ast.ClassDef):
        pending = list(scope.body)
    else:
        pending = []
        for index, generator in enumerate(scope.generators):
            pending += [generator.target, *generator.ifs] + ([generator.iter] if index else [])
        pending += [scope.key, scope.value] if isinstance(scope, ast.DictComp) else [scope.elt]
    while pending:
        node = pending.pop()
        if isinstance(node, (ast.Global, ast.Nonlocal)):
            declared.update(node.names)
        elif isinstance(node, SCOPES):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                local.add(node.name)
            pending += _evaluated_first(node)
            inner, inner_globals = _free(node)
            read |= inner
            assigned |= inner_globals
            continue
        elif isinstance(node, ast.Name):
            if isinstance(node.ctx, ast.Load):
                read.add(node.id)
            else:
                local.add(node.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            local.update(_imported(node))
        elif isinstance(node, ast.ExceptHandler) and node.name:
            local.add(node.name)
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
            local.add(node.name)
        elif isinstance(node, ast.MatchMapping) and node.rest:
            local.add(node.rest)
        pending.extend(ast.iter_child_nodes(node))
    assigned |= local & declared
    return read - (local - declared), assigned


class _Reader(ast.NodeVisitor):
    """Reads a cell's statements in the order Python runs them.

    ``needs`` are the names the cell reads before it binds them, and
    ``defined`` the names it binds at cell level. A function's body runs when
    something calls it: the names it reads from the cell are needs, unless
    the cell binds them somewhere (``later``).
    """

    def __init__(self) -> None:
        self.defined: set[str] = set()
        self.needs: set[str] = set()
        self.later: set[str] = set()

    def read(self, name: str) -> None:
        if name not in self.defined:
            self.needs.add(name)

    def bind(self, name: str) -> None:
        self.defined.add(name)

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Store):
            self.bind(node.id)
        else:
            self.read(node.id)

    def visit_Assign(self, node: ast.Assign) -> None:
        self.visit(node.value)
        for target in node.targets:
            self.visit(target)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        # x += 1 reads x first.
        if isinstance(node.target, ast.Name):
            self.read(node.target.id)
        else:
            self.visit(node.target)
        self.visit(node.value)
        if isinstance(node.target, ast.Name):
            self.bind(node.target.id)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if node.value is not None:
            self.visit(node.value)
        self.visit(node.annotation)
        if not isinstance(node.target, ast.Name):
            self.visit(node.target)
        elif node.value is not None:
            self.bind(node.target.id)

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
        self.visit(node.value)
        self.visit(node.target)

    def visit_For(self, node: ast.For | ast.AsyncFor) -> None:
        self.visit(node.iter)
        self.visit(node.target)
        for statement in node.body + node.orelse:
            self.visit(statement)

    visit_AsyncFor = visit_For

    def visit_Import(self, node: ast.Import | ast.ImportFrom) -> None:
        for name in _imported(node):
            self.bind(name)

    visit_ImportFrom = visit_Import

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        if node.type is not None:
            self.visit(node.type)
        if node.name:
            self.bind(node.name)
        for statement in node.body:
            self.visit(statement)

    def visit_MatchAs(self, node: ast.MatchAs) -> None:
        if node.pattern is not None:
            self.visit(node.pattern)
        if node.name:
            self.bind(node.name)

    def visit_MatchStar(self, node: ast.MatchStar) -> None:
        if node.name:
            self.bind(node.name)

    def visit_MatchMapping(self, node: ast.MatchMapping) -> None:
        for part in (*node.keys, *node.patterns):
            self.visit(part)
        if node.rest:
            self.bind(node.rest)

    def _scope(self, node: ast.AST) -> None:
        for part in _evaluated_first(node):
            self.visit(part)
        free, assigned = _free(node)
        if isinstance(node, COMPREHENSIONS):
            # A comprehension runs at once, where it is written.
            for name in sorted(free):
                self.read(name)
        else:
            self.later |= free
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            self.bind(node.name)
        # A function that declares a name global and assigns it makes it for the cell.
        self.defined |= assigned

    visit_FunctionDef = visit_AsyncFunctionDef = visit_Lambda = visit_ClassDef = _scope
    visit_ListComp = visit_SetComp = visit_DictComp = visit_GeneratorExp = _scope

    def visit_Global(self, node: ast.Global) -> None:
        pass

    visit_Nonlocal = visit_Global


def names(source: str) -> tuple[set[str], set[str], bool]:
    """The names a cell defines, the names it reads before it defines them, and whether it parsed.

    ``weekly = weekly[weekly["days"] >= 14]`` both needs ``weekly`` and
    defines it. A name that a function assigns belongs to the function, and
    a name that a function reads is needed unless the cell defines it.
    """
    text = "\n".join("" if MAGIC.match(line) else line for line in source.split("\n"))
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return set(), set(), False
    reader = _Reader()
    for statement in tree.body:
        reader.visit(statement)
    needs = reader.needs | (reader.later - reader.defined)
    return reader.defined, needs - BUILTINS, True


def plan(cells: list[Cell], wanted: set[str], available: set[str] = frozenset(), before: str | None = None) -> dict[str, Any]:
    """The cells to run, in notebook order, so that ``wanted`` exist.

    Walks back from the end (or from the cell ``before``, included): a cell
    that defines a needed name is run, and what it uses becomes needed in
    turn. Names in ``available`` are in the kernel already. Names that no
    earlier cell defines are returned as ``unresolved``, and the names that
    the cell ``before`` uses and the kernel lacks as ``inputs``.
    """
    order = [cell.id for cell in cells]
    stop = order.index(before) + 1 if before in order else len(cells)
    needed = set(wanted) - available
    chosen: list[str] = []
    unparsed: list[str] = []
    inputs: set[str] = set()
    for cell in reversed(cells[:stop]):
        defined, needs, parsed = names(cell.source)
        if not parsed:
            unparsed.append(cell.id)
        if cell.id == before:
            inputs = needs - available
        if cell.id == before or defined & needed:
            chosen.append(cell.id)
            # A cell that makes a name from itself, as in weekly = weekly[...],
            # still needs the cell before it that made the name first.
            needed -= defined
            needed |= needs - available
    return {
        "cells": [cell_id for cell_id in order if cell_id in chosen],
        "unresolved": sorted(needed),
        "unparsed": [cell_id for cell_id in order if cell_id in unparsed],
        "inputs": sorted(inputs - needed),
    }


def plan_from_json(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict) or not isinstance(data.get("cells"), list):
        raise InvalidRequest("the body needs the cells")
    cells = [Cell(str(c.get("id")), str(c.get("source", ""))) for c in data["cells"] if isinstance(c, dict)]
    wanted = {str(name) for name in data.get("names") or []}
    available = {str(name) for name in data.get("available") or []}
    before = data.get("before")
    return plan(cells, wanted, available, str(before) if before else None)


CLAUDE_PROMPT = """\
You read the cells of a Jupyter notebook and decide which cells must run so
that some names exist in the kernel. A static reading of the code could not
find where the names in "unresolved" come from: they may be defined by
magics, %run, star imports, exec, or a file the notebook reads. Answer with
the ids of the cells to run, in notebook order, taken only from the ids
given, and one sentence saying where each unresolved name comes from. If a
name comes from outside the notebook, say so and leave its cells out. Answer
once, with one JSON object with the keys "cells" and "reason"."""

CLAUDE_SCHEMA = {
    "type": "object",
    "properties": {
        "cells": {"type": "array", "items": {"type": "string"}},
        "reason": {"type": "string"},
    },
    "required": ["cells", "reason"],
    "additionalProperties": False,
}


def claude_request(data: Any) -> tuple[str, list[str]]:
    """The prompt for Claude and the notebook's cell ids, in order; raises InvalidRequest."""
    if not isinstance(data, dict) or not isinstance(data.get("cells"), list):
        raise InvalidRequest("the body needs the cells")
    cells = [
        {"id": str(c.get("id")), "label": str(c.get("label", "")), "source": str(c.get("source", ""))[:4000]}
        for c in data["cells"][:60]
        if isinstance(c, dict)
    ]
    prompt = json.dumps({"cells": cells, "names": data.get("names") or [], "unresolved": data.get("unresolved") or []}, indent=1)
    return prompt, [cell["id"] for cell in cells]


async def ask_claude(prompt: str, order: list[str], config: Whybook) -> AsyncIterator[dict[str, Any]]:
    """Hand the names that ``plan`` could not trace to Claude."""
    async for event in connection.structured_call(prompt, schema=CLAUDE_SCHEMA, system_prompt=CLAUDE_PROMPT, config=config, effort=config.question_effort):
        if event["type"] == "result":
            output = event.pop("output")
            # Only cells of this notebook, in its order.
            chosen = {str(i) for i in output.get("cells", [])}
            event["plan"] = {"cells": [i for i in order if i in chosen], "reason": str(output.get("reason", ""))}
        yield event
