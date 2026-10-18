"""The demo notebooks in examples/pain_diary, as make_notebook.py --execute and make_later.py write them.

Both keep the outputs of a run, which GitHub and Binder show before anything
runs. Both run from their own folder, where they import prep.
"""

from pathlib import Path

import nbformat
import pytest

DEMO = Path(__file__).resolve().parents[3] / "examples" / "pain_diary"
NOTEBOOKS = ["pain_diary_cohort.ipynb", "pain_diary_cohort_6h.ipynb"]


@pytest.mark.parametrize("name", NOTEBOOKS)
def test_the_demo_keeps_a_run_without_an_error(name):
    code = [cell for cell in nbformat.read(DEMO / name, 4).cells if cell.cell_type == "code"]
    assert [cell.id for cell in code if not cell.execution_count] == []
    assert [cell.id for cell in code for output in cell.outputs if output.output_type == "error"] == []


@pytest.mark.demo
@pytest.mark.parametrize("name", NOTEBOOKS)
def test_the_demo_runs_from_its_folder(name, tmp_path, monkeypatch):
    """Run all, as the README asks: a kernel in examples/pain_diary runs every cell. Each notebook takes 10 to 20 s."""
    for module in ("nbclient", "ipykernel", "numpy", "pandas", "scipy", "statsmodels"):
        pytest.importorskip(module)
    from nbclient import NotebookClient

    # IPython's history in a folder of the test's own: the history file in the
    # home folder is shared with the user's kernels.
    monkeypatch.setenv("IPYTHONDIR", str(tmp_path / "ipython"))
    notebook = nbformat.read(DEMO / name, 4)
    # execute() raises CellExecutionError at the first cell that fails.
    NotebookClient(notebook, timeout=600, kernel_name="python3", resources={"metadata": {"path": str(DEMO)}}).execute()
    assert all(cell.execution_count for cell in notebook.cells if cell.cell_type == "code")
