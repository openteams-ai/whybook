"""SQLite files for the Databases panel, and the options for a dropped table."""

import sqlite3
from contextlib import closing

import pytest

from whybook.server import databases
from whybook.server.questions.tables import TableDrop, table_options


def make_db(path, tables):
    with closing(sqlite3.connect(path)) as db:
        for name, (columns, rows) in tables.items():
            db.execute(f"CREATE TABLE {databases.quote(name)} ({', '.join(columns)})")
            db.executemany(f"INSERT INTO {databases.quote(name)} VALUES ({', '.join('?' * len(columns))})", rows)
        db.commit()


def test_discover_finds_sqlite_files_and_skips_the_rest(tmp_path):
    (tmp_path / "data" / "deep").mkdir(parents=True)
    make_db(tmp_path / "data" / "clinic.sqlite", {"visits": (["patient_id"], [("P1",)])})
    (tmp_path / "data" / "fake.db").write_text("not a database")
    (tmp_path / ".hidden").mkdir()
    make_db(tmp_path / ".hidden" / "secret.db", {"t": (["a"], [(1,)])})
    found = databases.discover(str(tmp_path))
    assert [d["path"] for d in found["databases"]] == ["data/clinic.sqlite"]
    assert found["complete"]


def test_describe_lists_tables_columns_and_rows(tmp_path):
    make_db(tmp_path / "c.db", {"visits": (["patient_id TEXT", "crp REAL"], [("P1", 1.0), ("P1", 2.0), ("P2", 3.0)]), 'odd "name"': (["x"], [])})
    described = databases.describe(str(tmp_path), "c.db")
    tables = {t["name"]: t for t in described["tables"]}
    assert tables["visits"]["rows"] == 3
    assert [c["name"] for c in tables["visits"]["columns"]] == ["patient_id", "crp"]
    assert tables['odd "name"']["rows"] == 0
    assert databases.distinct(str(tmp_path), "c.db", "visits", ["patient_id"]) == 2


def test_paths_stay_inside_the_root(tmp_path):
    (tmp_path / "root").mkdir()
    make_db(tmp_path / "outside.db", {"t": (["a"], [(1,)])})
    with pytest.raises(databases.OutsideRoot):
        databases.describe(str(tmp_path / "root"), "../outside.db")


def test_connections_are_read_only(tmp_path):
    make_db(tmp_path / "c.db", {"t": (["a"], [(1,)])})
    with closing(databases.connect(str(tmp_path / "c.db"))) as db, pytest.raises(sqlite3.OperationalError):
        db.execute("INSERT INTO t VALUES (2)")


@pytest.mark.demo
def test_a_table_loads_and_joins_per_patient(demo, tmp_path):
    rows = [("P001", 1, 2.0), ("P001", 5, 4.0), ("P002", 2, 3.0)]
    make_db(tmp_path / "clinic.sqlite", {"visits": (["patient_id TEXT", "week INTEGER", "crp REAL"], rows)})
    body = {
        "source": {"kind": "table", "path": "clinic.sqlite", "kernel_path": str(tmp_path / "clinic.sqlite"), "table": "visits"},
        "target": {"cell": demo.cell("lmm")},
        "cells": demo.cells_json(),
        "context": demo.context(),
    }
    result = table_options(TableDrop.from_json(body), str(tmp_path))
    texts = [option["text"] for option in result["options"]]
    assert "Load visits as visits" in texts
    join = next(o for o in result["options"] if o["text"].startswith("Join"))
    # Two visits for P001: the join averages them first, and leaves week out.
    assert join["text"] == "Join the per-patient_id means of visits to model_data"
    for option in result["options"]:
        if option["code"]:
            demo.run(option["code"])
    joined = demo.shell.user_ns["model_data_visits"]
    assert len(joined) == len(demo.shell.user_ns["model_data"])
    assert joined.loc[joined["patient_id"] == "P001", "crp"].iloc[0] == 3.0
    assert "week_y" not in joined.columns
