"""Options for a data file dropped from the file browser, run on the demo state."""

import pytest

from whybook.server.questions.files import FileDrop, file_options

pytestmark = pytest.mark.demo


def drop(demo, tmp_path, name, text, cell=None):
    (tmp_path / name).write_text(text)
    body = {
        "source": {"kind": "file", "path": name, "kernel_path": str(tmp_path / name), "label": name},
        "target": {"cell": demo.cell(cell)} if cell else {},
        "cells": demo.cells_json(),
        "context": demo.context(),
    }
    return file_options(FileDrop.from_json(body), str(tmp_path))


def test_a_csv_file_loads_and_profiles(demo, tmp_path):
    result = drop(demo, tmp_path, "visits.csv", "patient_id,visit,nurse_score\nP001,1,3\nP002,1,5\n")
    texts = [option["text"] for option in result["options"]]
    assert texts[:2] == ["Load visits.csv as visits", "Profile visits.csv before loading it"]
    for option in result["options"]:
        if option["code"]:
            demo.run(option["code"])
    assert list(demo.shell.user_ns["visits"].columns) == ["patient_id", "visit", "nurse_score"]


def test_dropped_on_a_cell_it_joins_on_the_shared_key(demo, tmp_path):
    result = drop(demo, tmp_path, "nurses.csv", "patient_id,nurse_score\nP001,3\n", cell="lmm")
    join = next(o for o in result["options"] if o["text"].startswith("Join nurses.csv"))
    assert join["text"] == "Join nurses.csv to model_data on patient_id"
    demo.run(join["code"])
    assert "nurse_score" in demo.shell.user_ns["model_data_nurses"].columns


def test_a_parquet_file_dropped_on_a_cell_joins_on_the_shared_key(demo, tmp_path):
    pytest.importorskip("pyarrow")
    import pandas as pd

    pd.DataFrame({"patient_id": ["P001", "P002"], "nurse_score": [3, 5]}).to_parquet(tmp_path / "nurses.parquet")
    body = {
        "source": {"kind": "file", "path": "nurses.parquet", "kernel_path": str(tmp_path / "nurses.parquet"), "label": "nurses.parquet"},
        "target": {"cell": demo.cell("lmm")},
        "cells": demo.cells_json(),
        "context": demo.context(),
    }
    result = file_options(FileDrop.from_json(body), str(tmp_path))
    join = next(o for o in result["options"] if o["text"].startswith("Join nurses.parquet"))
    assert join["text"] == "Join nurses.parquet to model_data on patient_id"
    demo.run(join["code"])
    assert "nurse_score" in demo.shell.user_ns["model_data_nurses"].columns


def test_other_files_get_a_note_and_no_options(demo, tmp_path):
    result = drop(demo, tmp_path, "notes.md", "# notes\n")
    assert result["options"] == []
    assert "not a data file" in result["note"]
