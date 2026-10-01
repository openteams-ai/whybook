"""The demo after six more hours of analysis, as make_later.py wrote it."""

import sys
from pathlib import Path

import nbformat

DEMO = Path(__file__).resolve().parents[3] / "examples" / "pain_diary"
sys.path.insert(0, str(DEMO.parents[1] / "scripts" / "examples" / "pain_diary"))

from make_later import fingerprint  # noqa: E402

NOTEBOOK = nbformat.read(DEMO / "pain_diary_cohort_6h.ipynb", 4)
CODE = [cell for cell in NOTEBOOK.cells if cell.cell_type == "code"]


def html(output) -> str:
    value = output.get("data", {}).get("text/html", "")
    return "".join(value) if isinstance(value, list) else value


def test_every_cell_ran_without_an_error():
    assert all(cell.execution_count for cell in CODE)
    assert [cell.id for cell in CODE for output in cell.outputs if output.output_type == "error"] == []


def test_it_has_branches_large_tables_and_cells_with_several_outputs():
    branches = {cell.id: cell.metadata["whybook"]["branch"]["letter"] for cell in CODE if "branch" in cell.metadata["whybook"]}
    assert branches == {"ordinal": "b", "min_days_sweep": "c", "without_east": "d"}
    assert sum(len(cell.outputs) >= 2 for cell in CODE) >= 8
    screen = next(cell for cell in CODE if cell.id == "screen")
    assert "4812 rows × 7 columns" in html(screen.outputs[-1])


def test_it_keeps_what_the_view_reads_from_the_kernel():
    kept = {variable["name"]: variable for variable in NOTEBOOK.metadata["whybook"]["variables"]}
    assert {"diary", "weekly", "olink", "protein_screen", "effects"} <= set(kept)
    # A wide frame keeps its first 100 columns, and its size.
    assert kept["olink"]["n_columns"] == 4813
    assert len(kept["olink"]["columns"]) == 100
    assert kept["protein_screen"]["cell"] == "screen"
    # The view uses the kept analysis only for the source it was made from.
    assert all(cell.metadata["whybook"]["analysis"]["source"] == fingerprint(cell.source) for cell in CODE)


def test_table_labels_belong_to_the_outputs_and_state_their_numbers():
    labelled = 0
    for cell in CODE:
        outputs = {fingerprint(html(output)) for output in cell.outputs if "<table" in html(output)}
        tables = cell.metadata["whybook"].get("tables", {})
        assert set(tables) <= outputs
        labelled += len(tables)
    assert labelled >= 15
    hits = next(cell for cell in CODE if cell.id == "hits_by_panel")
    rows = "".join(hits.outputs[0]["data"]["text/plain"]).splitlines()[2:]
    assert sum(int(row.split()[2]) for row in rows) == 1
    screen = next(cell for cell in CODE if cell.id == "screen")
    # nbformat writes the keys sorted, so the order is that of the hashes.
    assert {note["headline"] for note in screen.metadata["whybook"]["tables"].values()} == {"NGF strongest", "1 pass FDR"}
    summary = next(cell for cell in NOTEBOOK.cells if cell.id == "summary")
    assert "only NGF tracks how fast pain changes" in summary.source


def test_the_hash_is_the_one_the_view_computes():
    # src/__tests__/tables.spec.ts checks the same values in TypeScript.
    assert fingerprint("4,812 rows × 7 columns") == "ff4cf3fa"
    assert fingerprint("naïve 📈 plot") == "0d3911b4"
