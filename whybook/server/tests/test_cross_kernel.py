"""An agent that works in a second notebook (design iteration 1.69): the tools name their notebook, new_notebook and share_frames go to the view, the caps count both notebooks, and finish carries a comparison."""

import json

import pytest
from tornado.httpclient import HTTPClientError

from whybook.server import agent, claude, privacy
from whybook.server.config import Whybook
from whybook.server.questions.models import InvalidRequest

from .test_agent import body, drive, request

KERNELS = [
    {"name": "python3", "display_name": "Python 3 (ipykernel)", "language": "python", "sandboxed": False, "current": True},
    {"name": "xr", "display_name": "R 4.4.3 (xr)", "language": "R", "sandboxed": False},
    {"name": "r-sandboxed", "display_name": "R 4.4.3 (xr, sandboxed)", "language": "R", "sandboxed": True},
    {"name": "sas-licence-needed", "display_name": "SAS (licence needed)", "language": "sas", "sandboxed": False},
]
FILES = [
    {"name": "pain_diary_cohort.ipynb", "type": "notebook", "size": 81234},
    {"name": "prep.py", "type": "file", "size": 2210},
    {"name": "data", "type": "directory"},
]
NOTEBOOK = {
    "name": "pain_diary_cohort.ipynb",
    "kernel": "Python 3 (ipykernel)",
    "language": "python",
    "cells": [
        {"label": "[4]", "title": "Weekly pain by arm", "code": "weekly = diary.groupby(['treatment_arm', 'week']).pain_score.mean()", "outputs": ["arm week mean\nB 12 0.750694"]},
        {"label": "[5]", "title": "Mixed model", "code": "lmm_fit = smf.mixedlm('pain_score ~ treatment_arm * month', model_data, groups='patient_id').fit()", "outputs": []},
    ],
}
COMPARE = {"kernel": "xr", "display_name": "R 4.4.3 (xr)", "language": "R"}
MADE = {"status": "ok", "notebook": "pain_diary_cohort.R.ipynb", "kernel": "R 4.4.3 (xr)", "language": "R", "version": "R 4.4.3", "sandboxed": False, "parquet": False, "packages": ["jsonlite", "stats"]}


def test_the_tools_that_act_in_a_notebook_name_it_and_run_cell_takes_its_language():
    for name in ("run_cell", "explore", "write_file"):
        assert "notebook" in agent.TOOLS[name]["schema"]["properties"]
        assert "notebook" not in agent.TOOLS[name]["schema"]["required"]
    code = agent.TOOLS["run_cell"]["schema"]["properties"]["code"]["description"]
    assert "Python" not in code.split(":")[0]
    assert "in the language of its notebook's kernel" in code
    assert "notebook's kernel" in agent.TOOLS["run_cell"]["description"]
    made = agent.TOOLS["new_notebook"]["schema"]
    assert made["required"] == ["kernel", "name"]
    # A reproduction of an Untitled notebook gets a name and a title of its own.
    assert "Untitled" in made["properties"]["name"]["description"]
    assert "Untitled" in made["properties"]["title"]["description"]
    assert agent.TOOLS["share_frames"]["schema"]["required"] == ["frames", "notebook"]
    rows = agent.TOOLS["finish"]["schema"]["properties"]["comparison"]["properties"]["rows"]
    assert rows["items"]["required"] == ["estimate", "first", "second"]


async def test_a_new_notebook_goes_to_the_view_and_a_second_is_refused_without_asking_it():
    steps = [
        ("new_notebook", {"kernel": "xr", "name": "pain_diary_cohort.R.ipynb", "why": "the same analysis in R"}),
        ("new_notebook", {"kernel": "xr", "name": "other.R.ipynb"}),
        ("finish", {"answer": "done"}),
    ]
    found = await drive(agent.run_events(request(kernels=KERNELS), Whybook(), agent.scripted(steps)), [MADE])
    tools = [event for event in found if event["type"] == "tool"]
    assert [tool["name"] for tool in tools] == ["new_notebook"]
    assert tools[0]["input"]["kernel"] == "xr"
    results = found[-1]["results"]
    assert results[0] == MADE
    assert results[1]["status"] == "refused" and "at most 1 new notebook" in results[1]["error"]


async def test_a_notebook_the_view_could_not_make_leaves_the_run_its_one_notebook():
    steps = [
        ("new_notebook", {"kernel": "xr", "name": "pain_diary_cohort.ipynb"}),
        ("new_notebook", {"kernel": "xr", "name": "pain_diary_cohort.R.ipynb"}),
        ("finish", {"answer": "done"}),
    ]
    refused = {"status": "refused", "reason": "a file of this name exists: choose another name"}
    found = await drive(agent.run_events(request(kernels=KERNELS), Whybook(), agent.scripted(steps)), [refused, MADE])
    assert [event["input"]["name"] for event in found if event["type"] == "tool"] == ["pain_diary_cohort.ipynb", "pain_diary_cohort.R.ipynb"]
    assert found[-1]["results"][1] == MADE


async def test_the_cells_of_both_notebooks_count_against_one_limit():
    steps = [
        ("new_notebook", {"kernel": "xr", "name": "pain_diary_cohort.R.ipynb"}),
        ("run_cell", {"title": "Read the frames", "code": "weekly <- read.csv('from_python/weekly.csv')", "notebook": "pain_diary_cohort.R.ipynb"}),
        ("run_cell", {"title": "Mean pain", "code": "diary.pain_score.mean()"}),
        ("run_cell", {"title": "One more in R", "code": "mean(weekly$mean)", "notebook": "pain_diary_cohort.R.ipynb"}),
        ("finish", {"answer": "stopped at the limit"}),
    ]
    results = [MADE, {"status": "ok", "cell": "[1]"}, {"status": "ok", "cell": "[6]"}]
    found = await drive(agent.run_events(request(Whybook(agent_max_cells=2), kernels=KERNELS), Whybook(), agent.scripted(steps)), results)
    tools = [event for event in found if event["type"] == "tool"]
    assert [tool["name"] for tool in tools] == ["new_notebook", "run_cell", "run_cell"]
    # The notebook goes to the view as the agent named it.
    assert tools[1]["input"]["notebook"] == "pain_diary_cohort.R.ipynb"
    refused = found[-1]["results"][3]
    assert refused["status"] == "refused" and "every notebook" in refused["error"]


async def test_share_frames_goes_to_the_view_within_its_limit():
    frames = [f"frame_{index}" for index in range(agent.MAX_FRAMES)]
    steps = [
        ("share_frames", {"frames": ["weekly", "model_data"], "notebook": "pain_diary_cohort.R.ipynb"}),
        ("share_frames", {"frames": frames, "notebook": "pain_diary_cohort.R.ipynb"}),
        ("share_frames", {"frames": [], "notebook": "pain_diary_cohort.R.ipynb"}),
        ("finish", {"answer": "done"}),
    ]
    wrote = {"status": "ok", "folder": "from_python", "files": [{"frame": "weekly", "path": "from_python/weekly.csv", "format": "csv", "rows": 56, "columns": [{"name": "week", "type": "int64"}]}]}
    found = await drive(agent.run_events(request(), Whybook(), agent.scripted(steps)), [wrote])
    assert [event["input"]["frames"] for event in found if event["type"] == "tool"] == [["weekly", "model_data"]]
    results = found[-1]["results"]
    assert results[0] == wrote
    assert results[1]["status"] == "refused" and f"at most {agent.MAX_FRAMES} frames" in results[1]["error"]
    assert results[2]["status"] == "refused" and "name the frames" in results[2]["error"]


def test_the_prompt_names_the_kernels_the_folders_files_and_for_a_comparison_the_cells():
    plain = json.loads(request(kernels=KERNELS, files=FILES).prompt())
    assert plain["task"] == agent.TASK
    assert [kernel["name"] for kernel in plain["kernels"]] == ["python3", "xr", "r-sandboxed", "sas-licence-needed"]
    assert plain["kernels"][0] == {"name": "python3", "display_name": "Python 3 (ipykernel)", "language": "python", "sandboxed": False, "this_notebook": True}
    assert plain["kernels"][2]["sandboxed"] is True
    assert plain["files"] == FILES
    assert "notebook" not in plain and "compare" not in plain
    compared = json.loads(request(kernels=KERNELS, files=FILES, notebook=NOTEBOOK, compare=COMPARE).prompt())
    assert compared["task"] == agent.COMPARE_TASK
    assert compared["compare"] == COMPARE
    assert compared["notebook"]["cells"][0] == {
        "label": "[4]",
        "title": "Weekly pain by arm",
        "code": NOTEBOOK["cells"][0]["code"],
        "outputs": "arm week mean\nB 12 0.750694",
    }
    # A cell without outputs goes without them.
    assert "outputs" not in compared["notebook"]["cells"][1]
    system = " ".join(request(kernels=KERNELS).system_prompt().split())
    assert "Never install a package, in any kernel." in system
    assert "a cell's code is in the language of its notebook's kernel" in system
    assert "When it saved none, say that its side has no results." in system


def test_a_comparison_asks_for_the_analysis_one_step_a_cell():
    # The R notebooks of the demo videos held one cell that read the data, fitted the model and
    # showed the estimates: the new notebook is read as the analyst's is.
    task = json.loads(request(kernels=KERNELS, files=FILES, notebook=NOTEBOOK, compare=COMPARE).prompt())["task"]
    assert "one step a cell" in task
    assert "read the data, prepare it, fit each model, and show its estimates, each in a cell of its own" in task
    assert task.endswith("Finish with a comparison of the estimates of both notebooks.")


def test_a_request_is_refused_when_its_kernels_files_or_comparison_are_malformed():
    for bad in (
        {"kernels": "xr"},
        {"kernels": [{"display_name": "R"}]},
        {"files": {"name": "a.csv"}},
        {"compare": {"kernel": "xr"}},
        {"compare": COMPARE, "notebook": {"cells": "all"}},
        {"compare": {"display_name": "R"}, "notebook": NOTEBOOK},
    ):
        with pytest.raises(InvalidRequest):
            request(**bad)
    # Lists are cut to their limits.
    many = request(kernels=KERNELS * 10, files=FILES * 30, notebook={**NOTEBOOK, "cells": NOTEBOOK["cells"] * 30}, compare=COMPARE)
    assert len(many.kernels) == agent.MAX_KERNELS
    assert len(many.files) == agent.MAX_FILES_LISTED
    assert len(many.notebook["cells"]) == agent.MAX_NOTEBOOK_CELLS


def test_with_the_data_kept_here_the_saved_outputs_stay_and_the_new_notebook_keeps_its_names():
    kept = json.loads(request(Whybook(keep_data_local=True), notebook=NOTEBOOK, compare=COMPARE).prompt())
    cell = kept["notebook"]["cells"][0]
    assert "outputs" not in cell and cell["outputs_kept_here"] == 1
    assert cell["code"] == NOTEBOOK["cells"][0]["code"]
    # What new_notebook and share_frames give back holds names and sizes, no values.
    assert privacy.tool_result(MADE, True) == MADE
    wrote = {
        "status": "ok",
        "folder": "from_python",
        "files": [{"frame": "weekly", "path": "from_python/weekly.csv", "format": "csv", "rows": 56, "columns": [{"name": "week", "type": "int64"}], "head": "1,12,0.75"}],
    }
    assert privacy.tool_result(wrote, True)["files"] == [{"frame": "weekly", "path": "from_python/weekly.csv", "format": "csv", "rows": 56, "columns": [{"name": "week", "type": "int64"}]}]


async def test_finish_carries_the_comparison_and_drops_rows_that_do_not_name_both_sides():
    comparison = {
        "rows": [
            {"estimate": "mean pain, week 12, arm B", "first": {"cell": "[4]", "value": "0.750694"}, "second": {"cell": "[2]", "value": 0.750694}},
            {"estimate": "arm B × month", "first": {"cell": "[5]", "value": "-0.318"}, "second": {"cell": "[3]", "value": ""}, "note": "lme4 is not installed"},
            {"estimate": "no second side", "first": {"cell": "[5]", "value": "1"}},
            {"estimate": "a list", "first": {"cell": "[5]", "value": [1]}, "second": {"cell": "[3]", "value": "1"}},
            "not a row",
        ],
        "missing": ["lme4", 3],
    }
    steps = [("finish", {"answer": "The means agree.", "cells": ["[2]"], "comparison": comparison})]
    found = await drive(agent.run_events(request(), Whybook(), agent.scripted(steps)), [])
    final = found[-1]
    assert final["comparison"] == {
        "rows": [
            {"estimate": "mean pain, week 12, arm B", "first": {"cell": "[4]", "value": "0.750694"}, "second": {"cell": "[2]", "value": "0.750694"}},
            {"estimate": "arm B × month", "first": {"cell": "[5]", "value": "-0.318"}, "second": {"cell": "[3]", "value": ""}, "note": "lme4 is not installed"},
        ],
        "missing": ["lme4"],
    }
    # An answer without a comparison has none.
    found = await drive(agent.run_events(request(), Whybook(), agent.scripted([("finish", {"answer": "a"})])), [])
    assert "comparison" not in found[-1]


async def test_the_route_takes_the_kernels_and_refuses_a_comparison_without_the_cells(jp_fetch, monkeypatch):
    prompts = []

    async def recorded(run, request, config):
        prompts.append(json.loads(request.prompt()))
        return {"type": "result", "answer": "a", "cells": [], "follow_up": [], "model": "test", "cost_usd": 0.01}

    monkeypatch.setattr(agent, "claude_driver", recorded)
    monkeypatch.setattr(claude, "readiness", lambda config: {"available": True, "cli": "claude", "credential": "ANTHROPIC_API_KEY", "reason": None, "setup": None})
    await jp_fetch("whybook", "agent", method="POST", body=json.dumps(body(kernels=KERNELS, files=FILES, notebook=NOTEBOOK, compare=COMPARE)))
    assert prompts[0]["compare"] == COMPARE
    assert prompts[0]["kernels"][1]["name"] == "xr"
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "agent", method="POST", body=json.dumps(body(compare=COMPARE)))
    assert error.value.code == 400


async def test_an_agent_on_another_model_makes_a_notebook_works_there_and_finishes_with_a_comparison(monkeypatch):
    pytest.importorskip("pydantic_ai")
    from whybook.server import model_client

    from .test_model_client import OLLAMA, agent_model

    comparison = {"rows": [{"estimate": "mean pain, week 12, arm B", "first": {"cell": "[4]", "value": "0.7507"}, "second": {"cell": "[2]", "value": "0.7507"}}], "missing": ["lme4"]}
    model = agent_model(
        [("new_notebook", {"kernel": "xr", "name": "pain_diary_cohort.R.ipynb"})],
        [("share_frames", {"frames": ["weekly"], "notebook": "pain_diary_cohort.R.ipynb"})],
        [("run_cell", {"title": "Weekly means", "code": "aggregate(pain_score ~ arm + week, weekly, mean)", "notebook": "pain_diary_cohort.R.ipynb"})],
        [("finish", {"answer": "The means agree ([4]).", "comparison": comparison})],
    )
    monkeypatch.setattr(model_client, "build_model", lambda chosen, key: model)
    results = [MADE, {"status": "ok", "folder": "from_python", "files": []}, {"status": "ok", "cell": "[2]"}]
    found = await drive(agent.run_events(request(kernels=KERNELS), Whybook(), model_client.agent_driver(OLLAMA, None, agent.TOOLS)), results)
    tools = [event for event in found if event["type"] == "tool"]
    assert [tool["name"] for tool in tools] == ["new_notebook", "share_frames", "run_cell"]
    assert tools[2]["input"]["notebook"] == "pain_diary_cohort.R.ipynb"
    assert found[-1]["comparison"] == comparison


KERNEL_CODE = __import__("pathlib").Path(__file__).resolve().parents[1] / "kernel_code"
RESULT_MIME = "application/vnd.whybook.result+json"


@pytest.fixture
def shell(tmp_path, monkeypatch):
    """An IPython shell whose folder is the notebook's, with its history in memory."""
    from IPython.core.interactiveshell import InteractiveShell
    from traitlets.config import Config

    monkeypatch.chdir(tmp_path)
    config = Config()
    config.HistoryManager.hist_file = ":memory:"
    shell = InteractiveShell.instance(config=config)
    # The shell is IPython's one instance, which the demo's state of
    # conftest.py also runs in: a test that sets a name the demo has, such as
    # patients, would change the demo for the tests after it.
    before = dict(shell.user_ns)
    yield shell
    shell.user_ns.clear()
    shell.user_ns.update(before)


def program(shell, name, args):
    """Run a kernel program as the view does (PYTHON.call in src/model/languages.ts), and return its result."""
    import IPython.display

    shown = []
    original = IPython.display.display
    IPython.display.display = lambda data, raw=False, **kw: shown.append(data)
    try:
        source = (KERNEL_CODE / f"{name}.py").read_text()
        code = f"{source}\ntry:\n    _whybook_{name}(__import__('json').loads({json.dumps(json.dumps(args))}))\nfinally:\n    del _whybook_{name}\n"
        result = shell.run_cell(code, silent=True)
        assert result.success, result.error_in_exec
    finally:
        IPython.display.display = original
    assert f"_whybook_{name}" not in shell.user_ns
    return next(item[RESULT_MIME] for item in reversed(shown) if RESULT_MIME in item)


def test_write_frames_writes_each_frame_as_csv_with_its_keys_and_no_row_places(shell, tmp_path):
    shell.run_cell(
        "import pandas as pd\n"
        "diary = pd.DataFrame({'arm': ['A', 'A', 'B'], 'week': [1, 2, 1], 'pain': [5.0, 4.5, 3.25]})\n"
        "late = diary[diary.week > 1]\n"
        "by_arm = diary.groupby('arm').pain.agg(['mean', 'count'])\n"
        "wide = diary.groupby('arm').agg({'pain': ['mean', 'std']})\n"
        "pain = diary.pain\n"
        "THRESHOLD = 3",
        silent=True,
    )
    result = program(shell, "write_frames", {"frames": ["diary", "late", "by_arm", "wide", "pain", "THRESHOLD", "nope", "os.system"], "folder": "from_python", "format": "csv"})
    import pandas as pd

    files = {item["frame"]: item for item in result["files"]}
    assert result["folder"] == "from_python"
    # pandas 3 names the type of a column of text "str", and pandas 2 "object".
    text = str(pd.DataFrame({"a": ["x"]}).dtypes["a"])
    assert files["diary"] == {
        "frame": "diary",
        "path": "from_python/diary.csv",
        "format": "csv",
        "rows": 3,
        "columns": [{"name": "arm", "type": text}, {"name": "week", "type": "int64"}, {"name": "pain", "type": "float64"}],
        "existed": False,
    }
    assert list(pd.read_csv(tmp_path / "from_python/diary.csv").columns) == ["arm", "week", "pain"]
    # A filter's index is the rows' places: it stays out. A groupby's keys go into a column.
    assert list(pd.read_csv(tmp_path / "from_python/late.csv").columns) == ["arm", "week", "pain"]
    assert list(pd.read_csv(tmp_path / "from_python/by_arm.csv").columns) == ["arm", "mean", "count"]
    assert list(pd.read_csv(tmp_path / "from_python/wide.csv").columns) == ["arm", "pain_mean", "pain_std"]
    assert list(pd.read_csv(tmp_path / "from_python/pain.csv").columns) == ["pain"]
    assert [error["frame"] for error in result["errors"]] == ["THRESHOLD", "nope", "os.system"]
    assert "not a data frame" in result["errors"][0]["error"]
    # A second write says that the file was there.
    again = program(shell, "write_frames", {"frames": ["diary"], "folder": "from_python", "format": "csv"})
    assert again["files"][0]["existed"] is True


def test_write_frames_writes_parquet_when_asked_and_able(shell, tmp_path):
    pytest.importorskip("pyarrow")
    shell.run_cell("import pandas as pd\nvisits = pd.DataFrame({'arm': pd.Categorical(['A', 'B']), 'pain': [5.0, 3.0]})", silent=True)
    result = program(shell, "write_frames", {"frames": ["visits"], "folder": "from_python", "format": "parquet"})
    [written] = result["files"]
    assert (written["path"], written["format"], written["rows"]) == ("from_python/visits.parquet", "parquet", 2)
    import pandas as pd

    back = pd.read_parquet(tmp_path / "from_python/visits.parquet")
    # Parquet keeps the category.
    assert str(back["arm"].dtype) == "category"


def test_write_frames_writes_a_polars_frame(shell, tmp_path):
    pytest.importorskip("polars")
    shell.run_cell("import polars as pl\nvisits = pl.DataFrame({'arm': ['A', 'B'], 'pain': [5.0, 3.0]})\nlazy = visits.lazy()", silent=True)
    result = program(shell, "write_frames", {"frames": ["visits", "lazy"], "folder": "from_python", "format": "csv"})
    [written] = result["files"]
    assert (written["path"], written["rows"], [column["name"] for column in written["columns"]]) == ("from_python/visits.csv", 2, ["arm", "pain"])
    assert (tmp_path / "from_python/visits.csv").read_text().splitlines()[0] == "arm,pain"
    assert "lazy frame" in result["errors"][0]["error"]


def test_kernel_facts_give_the_version_the_packages_and_parquet(shell):
    import sys

    facts = program(shell, "kernel_facts", {})
    assert facts["language"] == f"Python {sys.version.split()[0]}"
    assert facts["packages"]["pandas"]
    assert facts["parquet"] is any(module in facts["packages"] for module in ("pyarrow", "fastparquet", "polars"))
