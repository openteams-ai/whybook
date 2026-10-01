"""Which cells to run, read from the source without a kernel."""

from whybook.server.dependencies import Cell, names, plan
from whybook.server.tests.demo_state import DEMO

import nbformat


def demo_cells():
    notebook = nbformat.read(DEMO / "pain_diary_cohort.ipynb", 4)
    return [Cell(c.id, c.source) for c in notebook.cells if c.cell_type == "code"]


def test_names_skips_magics_and_builtins():
    defined, needs, parsed = names("%matplotlib inline\nimport pandas as pd\nx = len(pd.DataFrame(rows))\nprint(x)")
    assert parsed
    assert defined == {"pd", "x"}
    # pd and x are made before the cell reads them; rows comes from another cell.
    assert needs == {"rows"}


def test_the_plot_of_weekly_needs_the_cells_behind_it():
    result = plan(demo_cells(), {"weekly"}, before="weekly")
    assert result["cells"] == ["imports", "load", "reshape", "weekly"]
    assert result["unresolved"] == []


def test_names_in_the_kernel_are_not_run_again():
    result = plan(demo_cells(), {"weekly"}, available={"diary", "patients"}, before="weekly")
    assert result["cells"] == ["imports", "weekly"]


def test_names_no_cell_defines_are_unresolved():
    cells = [Cell("a", "from data import *"), Cell("b", "summary = table.describe()")]
    result = plan(cells, {"summary"})
    assert result["cells"] == ["b"]
    assert result["unresolved"] == ["table"]


def test_the_inputs_of_a_cell_that_the_kernel_lacks_after_a_restart():
    # After a restart, the imports and the loading ran again: the mixed model
    # still needs weekly, which the two cells before it make.
    available = {"whybook", "pd", "smf", "MIN_DAYS", "drop_sparse", "load_diary_raw", "load_olink", "load_patients", "to_long", "diary_raw", "patients", "olink"}
    result = plan(demo_cells(), set(), available=available, before="lmm")
    assert result["inputs"] == ["weekly"]
    assert result["cells"] == ["reshape", "weekly", "lmm"]
    # With everything in the kernel, the cell needs nothing but itself. The
    # argument of its lambda belongs to the lambda.
    everything = plan(demo_cells(), set(), available=available | {"diary", "weekly"}, before="lmm")
    assert (everything["cells"], everything["inputs"], everything["unresolved"]) == (["lmm"], [], [])


def run(cells, chosen):
    """Run the chosen cells in order in a fresh namespace, as the view does after a restart."""
    namespace = {}
    for cell in cells:
        if cell.id in chosen:
            exec(cell.source, namespace)  # noqa: S102
    return namespace


def test_a_frame_filtered_in_place_needs_the_cell_that_made_it():
    cells = [
        Cell("load", "weekly = {'n': [1, 5, 7]}"),
        Cell("filter", "weekly = {'n': [n for n in weekly['n'] if n > 3]}"),
        Cell("plot", "print(weekly)"),
    ]
    chosen = plan(cells, {"weekly"})["cells"]
    assert chosen == ["load", "filter"]
    assert run(cells, chosen)["weekly"] == {"n": [5, 7]}


def test_a_name_assigned_inside_a_function_is_not_made_by_its_cell():
    cells = [
        Cell("load", "df = {'pain': [1, None, 3]}"),
        Cell("helper", "def clean(df):\n    df = {k: [v for v in vs if v is not None] for k, vs in df.items()}\n    return df"),
        Cell("use", "weekly = clean(df)"),
    ]
    chosen = plan(cells, {"weekly"})["cells"]
    assert chosen == ["load", "helper", "use"]
    assert run(cells, chosen)["weekly"] == {"pain": [1, 3]}
