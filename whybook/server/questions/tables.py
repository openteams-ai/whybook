"""Options for a table dragged from the Databases panel onto the view.

As with a file, a table starts an analysis: load it, profile it, or join it to
a frame that a cell uses. The generated code opens the database read-only, and
names the database by its path from the notebook's folder, so the notebook
holds no credentials: a SQLite file has none.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote as url_quote

from .. import codegen, databases
from . import starts
from .cells import CellInfo, question_id
from .models import Candidate, Context, InvalidRequest, Placement
from .rankers import score_candidate

# Above this many rows, loading a sample comes first.
LARGE = 200_000
SAMPLE = 10_000


@dataclass(frozen=True)
class TableDrop:
    # The database file in the server's contents, and the same file relative
    # to the notebook's folder, which is the kernel's working directory.
    path: str
    kernel_path: str
    table: str
    target_cell: CellInfo | None
    cells: tuple[CellInfo, ...]
    context: Context

    @classmethod
    def from_json(cls, data: Any) -> TableDrop:
        if not isinstance(data, dict) or not isinstance(data.get("source"), dict):
            raise InvalidRequest("the body needs a source")
        source = data["source"]
        if not isinstance(source.get("path"), str) or not isinstance(source.get("table"), str):
            raise InvalidRequest("a table needs its database path and its name")
        target = data.get("target") or {}
        return cls(
            path=source["path"],
            kernel_path=str(source.get("kernel_path") or source["path"]),
            table=source["table"],
            target_cell=CellInfo.from_json(target["cell"]) if target.get("cell") else None,
            cells=tuple(CellInfo.from_json(c) for c in data.get("cells") or ()),
            context=Context.from_json(data.get("context")),
        )


def _option(text: str, kind: str, prior: float, placement: Placement, code: str | None, effect: str, drop: TableDrop) -> Candidate:
    return Candidate(
        id=question_id(text, drop.path, drop.table),
        text=text,
        type=kind,
        origin="template",
        variables=(f"{drop.path}:{drop.table}",),
        prior=prior,
        effect=effect,
        placement=placement,
        code=code,
    )


def reader(drop: TableDrop, sql: str) -> list[str]:
    """Lines that open the database read-only and run ``sql`` into ``_frame``."""
    return read_lines(drop.kernel_path, sql)


def read_lines(kernel_path: str, sql: str) -> list[str]:
    """Lines that open the database at ``kernel_path`` read-only and run ``sql`` into ``_frame``."""
    uri = f"file:{url_quote(kernel_path)}?mode=ro"
    return [
        "import sqlite3",
        "from contextlib import closing",
        "",
        "import pandas as pd",
        "",
        f"with closing(sqlite3.connect({codegen.literal(uri)}, uri=True)) as _db:",
        f"    _frame = pd.read_sql_query({codegen.literal(sql)}, _db)",
    ]


def sample_rows(root: str | None, path: str, table: str) -> Any:
    """The first rows of a table as a pandas frame, or None: they show which columns hold numbers or few levels."""
    if not root:
        return None
    try:
        import pandas as pd

        db = databases.connect(databases.resolve(root, path))
        try:
            return pd.read_sql_query(f"SELECT * FROM {databases.quote(table)} LIMIT {starts.SAMPLE}", db)
        finally:
            db.close()
    except Exception:
        return None


def table_options(drop: TableDrop, root: str | None) -> dict[str, Any]:
    cell, context = drop.target_cell, drop.context
    database = drop.path.rsplit("/", 1)[-1]
    title = f"{drop.table} ({database}) onto {cell.label}" if cell else f"{drop.table} ({database}) into the notebook"
    note = None
    options: list[Candidate] = []
    try:
        described = databases.describe(root, drop.path) if root else None
    except (databases.OutsideRoot, ValueError, sqlite3.Error) as error:
        return {"title": title, "note": f"Cannot read {database}: {error}", "mode": "auto", "options": [], "placements": [], "preselected": []}
    table = next((t for t in (described or {}).get("tables", []) if t["name"] == drop.table), None)
    columns = [c["name"] for c in table["columns"]] if table else []
    rows = table["rows"] if table else None
    taken = set(context.frames) | {name for c in drop.cells for name in c.defs}
    name = codegen.identifier(drop.table)
    if name in taken:
        name = f"{name}_table"
    last = drop.cells[-1] if drop.cells else None
    if cell is not None:
        home = Placement("new", cell.id, f"new cell after {cell.label}", "Next to the cell it was dropped on", None)
    elif last is not None:
        home = Placement("new", last.id, "a new cell at the end", "Where the analysis continues", None)
    else:
        home = Placement("new", None, "the first cell", "The notebook has no cells yet", None)
    preview = Placement("preview", None, "a preview in the sidebar", "Nothing is written to the notebook unless you keep it", None)
    everything = f"SELECT * FROM {databases.quote(drop.table)}"
    large = rows is not None and rows > LARGE
    load = reader(drop, everything) + [f"{name} = _frame", "del _frame", f"{name}.head()"]
    size = f"{rows:,} rows" if rows is not None else "all its rows"
    options.append(_option(f"Load {drop.table} as {name}", "descriptive", 0.55 if large else 0.7, home, "\n".join(load), f"A data frame with {size}", drop))
    if large:
        sample = reader(drop, f"{everything} LIMIT {SAMPLE}") + [f"{name}_sample = _frame", "del _frame", f"{name}_sample.head()"]
        options.append(_option(f"Load the first {SAMPLE:,} rows of {drop.table}", "descriptive", 0.72, home, "\n".join(sample), f"{rows:,} rows in all: a sample first", drop))
    profile = reader(drop, f"{everything} LIMIT 100000") + ["", "import whybook", "", "whybook.profile(_frame)"]
    options.append(_option(f"Profile {drop.table} before loading it", "quality", 0.6, preview, "\n".join(profile), f"Types, missing values and duplicates · {starts.UNLESS_KEPT}", drop))
    # The frames that the cell loads or reads (design iteration 1.87): a cell that loads
    # sites shares its key with the visits dropped on it, though it reads no frame.
    frames = starts.cell_frames(cell, context)
    link, linked, joined_frame = None, None, None
    for frame in frames if columns else []:
        link = starts.find_link(name, columns, lambda key: (rows, databases.distinct(root, drop.path, drop.table, [key]) if root else None), frame, context)
        if link is not None:
            linked = frame
            break
    if cell is not None and columns:
        table_columns = {c: "" for c in columns}
        for frame in frames:
            # The first key is the unit when the table has it: time columns
            # of two sources rarely line up, so the join is per unit.
            key = codegen.join_keys(table_columns, context.frames[frame], context.unit)[:1]
            values = [c for c in columns if c not in key and c not in context.frames[frame]]
            if not key or not values:
                continue
            joined = codegen.identifier(f"{frame}_{name}")
            per_key = databases.distinct(root, drop.path, drop.table, key) if root else None
            repeated = per_key is not None and rows is not None and per_key < rows
            lines = reader(drop, everything)
            if repeated:
                # Several rows per key: a plain join would repeat the frame's rows.
                lines.append(f"_frame = _frame.groupby({codegen.literals(key)}, as_index=False)[{codegen.literals(values)}].mean(numeric_only=True)")
            else:
                lines.append(f"_frame = _frame[{codegen.literals(key + values)}]")
            lines.append(f"{joined} = {frame}.merge(_frame, on={codegen.literals(key)}, how=\"left\")")
            if not repeated:
                # A column only the table has: after the join it is empty where no row matched.
                share = f'format({joined}[{codegen.literal(values[0])}].notna().mean(), ".0%")'
                lines.append(f"print({share}, {codegen.literal(f'of {frame} rows found a match in {drop.table}')})")
            lines += ["del _frame", f"{joined}.head()"]
            text = f"Join the per-{key[0]} means of {drop.table} to {frame}" if repeated else f"Join {drop.table} to {frame} on {key[0]}"
            effect = f"{rows / per_key:.1f} rows per {key[0]} in {drop.table}, averaged first" if repeated else "Left join on the shared key"
            options.append(
                _option(text, "descriptive", 0.68, Placement("new", cell.id, f"new cell after {cell.label}", "The cell uses the frame it joins to", None), "\n".join(lines), effect, drop)
            )
            joined_frame = frame
            break
    if table is None:
        note = f"{drop.table} is not in {database} any more."

    def make(text: str, kind: str, prior: float, placement: Placement, code: str | None, effect: str) -> Candidate:
        return _option(text, kind, prior, placement, code, effect, drop)

    if link is not None and cell is not None:
        here = Placement("new", cell.id, f"new cell after {cell.label}", "The cell holds the frame it is compared with", None)
        load = reader(drop, everything) + [f"{name} = _frame", "del _frame"]
        options += starts.combined_options(link, load, make, here, joined_before=joined_frame == linked)
    elif table is not None and starts.begun(drop.cells):
        # No analysis yet: what is in the table, which needs no model (design iteration 1.87).
        sample = sample_rows(root, drop.path, drop.table)
        shape = starts.shape_of(sample) if sample is not None else None
        options += starts.start_options(
            drop.table, name, lambda variable: reader(drop, everything) + [f"{variable} = _frame", "del _frame"], starts.unit_of(columns, context.unit), shape, make, preview
        )
    else:
        options.append(_option(f"What could {drop.table} add to this analysis?", "descriptive", 0.45, home, None, "AI reads the table's columns and the notebook", drop))
    for option in options:
        score_candidate(option, [], context)
    options.sort(key=lambda option: option.probability or 0.0, reverse=True)
    return {"title": title, "note": note, "mode": "auto", "options": [option.to_json() for option in options], "placements": [], "preselected": []}
