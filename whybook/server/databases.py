"""SQLite databases under the Jupyter server's root, for the Databases panel.

The panel lists the SQLite files found under the root and the tables in each;
a table dragged onto the view becomes a data frame in the kernel. Every
connection here is read-only, and every path stays inside the root, as the
contents API's paths do. The functions block, so the handlers run them in a
thread: a large database must not stall the server.
"""

from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path
from typing import Any

SUFFIXES = (".sqlite", ".sqlite3", ".db", ".db3")
SKIP = {"node_modules", "site-packages", "__pycache__", "venv", "env"}
MAGIC = b"SQLite format 3\x00"


class OutsideRoot(ValueError):
    """A path that leaves the server's root."""


def resolve(root: str, path: str) -> str:
    """The absolute path of ``path`` under ``root``; raises OutsideRoot."""
    base = os.path.realpath(root)
    full = os.path.realpath(os.path.join(base, path))
    if not full.startswith(base + os.sep):
        raise OutsideRoot(path)
    return full


def is_sqlite(full: str) -> bool:
    try:
        with open(full, "rb") as file:
            return file.read(16) == MAGIC
    except OSError:
        return False


def discover(root: str, depth: int = 3, limit: int = 50, budget: float = 1.5) -> dict[str, Any]:
    """SQLite files at most ``depth`` folders below the root, the first ``limit``.

    Hidden folders and package folders are skipped, and the walk stops after
    ``budget`` seconds, so a large root answers quickly with what it found.
    """
    base = os.path.realpath(root)
    deadline = time.monotonic() + budget
    found: list[dict[str, Any]] = []
    complete = True
    for folder, dirs, files in os.walk(base):
        relative = os.path.relpath(folder, base)
        level = 0 if relative == "." else relative.count(os.sep) + 1
        dirs[:] = sorted(d for d in dirs if d not in SKIP and not d.startswith(".")) if level < depth else []
        for name in sorted(files):
            if not name.lower().endswith(SUFFIXES):
                continue
            full = os.path.join(folder, name)
            if is_sqlite(full):
                found.append({"path": os.path.relpath(full, base).replace(os.sep, "/"), "name": name, "size": os.path.getsize(full)})
        if len(found) >= limit or time.monotonic() > deadline:
            complete = False
            break
    return {"databases": found[:limit], "complete": complete, "depth": depth}


def quote(name: str) -> str:
    """A SQL identifier in double quotes."""
    return '"' + name.replace('"', '""') + '"'


def connect(full: str) -> sqlite3.Connection:
    """A read-only connection: nothing here writes to the user's database."""
    return sqlite3.connect(Path(full).as_uri() + "?mode=ro", uri=True, timeout=1)


def _limited(db: sqlite3.Connection, sql: str, budget: float) -> Any:
    """The first value of a query, or None when it takes longer than ``budget`` seconds."""
    deadline = time.monotonic() + budget
    db.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 10000)
    try:
        return db.execute(sql).fetchone()[0]
    except sqlite3.OperationalError:
        return None
    finally:
        db.set_progress_handler(None, 0)


def describe(root: str, path: str, budget: float = 0.3) -> dict[str, Any]:
    """The tables and views of a database, with their columns and row counts.

    A count that takes longer than ``budget`` seconds is left out (None).
    """
    full = resolve(root, path)
    if not is_sqlite(full):
        raise ValueError(f"{path} is not a SQLite database")
    db = connect(full)
    try:
        tables = []
        names = db.execute("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
        for name, kind in names:
            columns = [{"name": row[1], "type": row[2] or ""} for row in db.execute(f"PRAGMA table_info({quote(name)})")]
            tables.append({"name": name, "kind": kind, "columns": columns, "rows": _limited(db, f"SELECT count(*) FROM {quote(name)}", budget)})
        return {"path": path, "name": os.path.basename(full), "tables": tables}
    finally:
        db.close()


def distinct(root: str, path: str, table: str, columns: list[str], budget: float = 0.3) -> int | None:
    """How many distinct combinations of ``columns`` the table has, or None."""
    db = connect(resolve(root, path))
    try:
        keys = ", ".join(quote(c) for c in columns)
        return _limited(db, f"SELECT count(*) FROM (SELECT DISTINCT {keys} FROM {quote(table)})", budget)
    finally:
        db.close()
