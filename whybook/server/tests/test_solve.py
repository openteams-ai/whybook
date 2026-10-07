import json
import sqlite3
from contextlib import closing

import pytest

from whybook.server import claude
from whybook.server.config import Whybook
from whybook.server.questions.models import InvalidRequest
from whybook.server.solve import SYSTEM_PROMPT, SolveRequest, complete_cell, solve, syntax_error

ADD = {"text": "What could visits add to this analysis?", "type": "descriptive"}


def test_claude_cell_gets_the_imports_the_notebook_lacks():
    output = {"summary": "s", "code": "whybook.progress(0.5)\npd.DataFrame()", "assumptions": [], "follow_up": []}
    assert complete_cell(output)["code"].startswith("import whybook\nimport pandas as pd\n")
    # The notebook imports pandas in an earlier cell, and never imports whybook.
    assert complete_cell(output, frozenset({"pd"}))["code"] == "import whybook\nwhybook.progress(0.5)\npd.DataFrame()"


def test_what_the_analyst_pointed_at_goes_to_the_model():
    question = {"text": "Why is pain higher here?", "type": "causal"}
    about = "the rows of weekly where 6 <= week <= 9, picked in the plot \"pain_score by week\""
    body = json.loads(SolveRequest.from_json({"question": question, "placement": "new", "about": about}).prompt())
    assert body["about"] == about
    assert "about" not in json.loads(SolveRequest.from_json({"question": question, "placement": "new"}).prompt())


def test_the_model_gets_a_short_list_of_variables_the_question_names_first():
    olink = {
        "name": "olink",
        "label": "olink",
        "kind": "dataframe",
        "rows": 318,
        "n_columns": 4813,
        "fingerprint": "abc",
        "columns": [{"label": f"P{i:04d}", "tag": "num", "kind": "numeric", "dtype": "float64", "unique": 300, "missing": 0, "min": -3, "max": 3} for i in range(100)],
        "groups": [{"label": "Inflammation", "columns": [f"P{i:04d}" for i in range(1104)]}],
    }
    others = [{"name": f"frame_{i}", "label": f"frame_{i}", "kind": "dataframe", "rows": 10, "columns": []} for i in range(40)]
    request = SolveRequest.from_json(
        {"question": {"text": "Which proteins of olink track pain?", "type": "association"}, "placement": "new", "variables": [*others, olink]}
    )
    assert len(request.variables) == 25
    first = request.variables[0]
    assert first["name"] == "olink"
    # A group is its size, not its 1,104 column names; a column is what code needs.
    assert first["groups"] == [{"label": "Inflammation", "columns": 1104}]
    assert len(first["columns"]) == 30
    assert first["columns"][0] == {"label": "P0000", "tag": "num", "min": -3, "max": 3}
    assert "fingerprint" not in first and "label" not in first
    assert len(request.prompt()) < 12000


def test_prefixed_assumptions_and_follow_ups_become_the_objects_the_view_keeps():
    cell = complete_cell(
        {
            "summary": "s",
            "code": "x = 1",
            "assumptions": ["default: REML, the default of mixedlm", "Missing weeks are dropped"],
            "follow_up": ["association: Does sleep relate to pain?", {"text": "An older answer", "type": "model"}],
        }
    )
    assert cell["assumptions"] == [
        {"text": "REML, the default of mixedlm", "kind": "default"},
        {"text": "Missing weeks are dropped", "kind": "modelling"},
    ]
    assert cell["follow_up"] == [
        {"text": "Does sleep relate to pain?", "type": "association"},
        {"text": "An older answer", "type": "model"},
    ]


def test_a_dragged_table_goes_to_the_model_with_its_columns_and_the_code_that_loads_it(tmp_path):
    # "What could visits add to this analysis?" has no template: the model writes the cell,
    # in a kernel that runs in the notebook's folder, where visits is not loaded yet.
    (tmp_path / "study").mkdir()
    with closing(sqlite3.connect(tmp_path / "study" / "clinic.sqlite")) as db:
        db.execute("CREATE TABLE visits (patient_id TEXT, crp REAL)")
        db.executemany("INSERT INTO visits VALUES (?, ?)", [("P1", 1.0), ("P2", 2.5)])
        db.commit()
    table = {"kind": "table", "name": "visits", "label": "visits", "path": "study/clinic.sqlite", "kernel_path": "clinic.sqlite", "table": "visits"}
    request = SolveRequest.from_json({"question": ADD, "placement": "new", "selection": {"source": table, "target": None}})
    selected = json.loads(request.with_sources(str(tmp_path)).prompt())["selected"][0]
    assert selected["kind"] == "table"
    assert selected["table"] == "visits"
    assert selected["path"] == "clinic.sqlite"
    assert selected["rows"] == 2
    assert selected["columns"] == [{"name": "patient_id", "type": "TEXT"}, {"name": "crp", "type": "REAL"}]
    assert 'sqlite3.connect("file:clinic.sqlite?mode=ro", uri=True)' in selected["load"]
    assert """pd.read_sql_query('SELECT * FROM "visits"', _db)""" in selected["load"]


def test_a_dragged_file_goes_to_the_model_with_its_header_and_the_code_that_reads_it(tmp_path):
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "visits.csv").write_text("patient_id,crp\nP1,1.0\n")
    source = {"kind": "file", "name": "data/visits.csv", "label": "visits.csv", "path": "data/visits.csv", "kernel_path": "../data/visits.csv"}
    request = SolveRequest.from_json({"question": ADD, "placement": "new", "selection": {"source": source, "target": None}})
    selected = json.loads(request.with_sources(str(tmp_path)).prompt())["selected"][0]
    assert selected["kind"] == "file"
    assert selected["path"] == "../data/visits.csv"
    assert selected["columns"] == [{"name": "patient_id"}, {"name": "crp"}]
    assert selected["load"] == 'import pandas as pd\n\n_frame = pd.read_csv("../data/visits.csv")'


def test_a_branch_is_told_to_keep_its_names_apart_from_the_notebook_and_other_branches():
    # The branches of a parallel exploration run at the same time and share one namespace.
    question = {"text": "Add IL6 as a covariate", "type": "model"}
    cell = {"label": "[5]", "source": 'lmm_fit = smf.mixedlm("pain ~ month", data=model_data, groups="patient_id").fit()'}
    branch = json.loads(SolveRequest.from_json({"question": question, "placement": "branch", "cell": cell}).prompt())["task"]
    assert "unique to this branch" in branch
    assert "intermediate values included" in branch
    assert "Never assign or delete a name that the notebook or another branch defines." in branch
    new = json.loads(SolveRequest.from_json({"question": question, "placement": "new", "cell": cell}).prompt())["task"]
    assert "another branch" not in new


def test_the_summary_says_what_the_cell_computes_and_never_what_the_output_will_show():
    # The model writes the summary before the cell runs. Asked for what the output shows, 15 of
    # 34 summaries on the pain diary claimed a curve that the data do not show, such as "Lowess
    # curve bends compared to the straight OLS line" (research/model_access/demo-model.md).
    prompt = " ".join(SYSTEM_PROMPT.split())
    assert 'summary says what the cell computes, in at most 12 words, such as "Tests whether a quadratic term improves the fit"' in prompt
    assert "You write it before the cell runs: never say what the output will show." in prompt
    assert "summary says what the output shows" not in prompt
    # A summary for a report names what the cell estimates, and states no finding.
    assert "summary then names the estimate and the uncertainty that the cell reports, in at most 25 words, without their values." in prompt
    assert "states the finding" not in prompt


def test_the_cell_follows_the_analysts_mode():
    question = {"text": "Does pain fall faster in arm B?", "type": "model"}
    body = json.loads(SolveRequest.from_json({"question": question, "placement": "new", "mode": "report"}).prompt())
    assert body["mode"] == "report"
    # The rules of every mode sit in the system prompt, which stays the same between requests.
    for rule in ("- do: ", "- report: ", "- wonder: "):
        assert rule in SYSTEM_PROMPT
    assert "mode" not in json.loads(SolveRequest.from_json({"question": question, "placement": "new"}).prompt())
    with pytest.raises(InvalidRequest):
        SolveRequest.from_json({"question": question, "placement": "new", "mode": "explain"})


def branch_request():
    question = {"text": "Estimate it by standardisation (g-formula)", "type": "causal"}
    return SolveRequest.from_json({"question": question, "placement": "branch", "cell": {"label": "[7]", "source": "fit = smf.ols('y ~ x', data=d).fit()"}})


def replying(monkeypatch, outputs):
    """The model answers each call with the next output, at $0.01 a call; the prompts it got."""
    prompts = []

    async def by_claude(prompt, **options):
        prompts.append(json.loads(prompt))
        yield {"type": "result", "output": outputs[len(prompts) - 1], "model": "claude", "cost_usd": 0.01}

    monkeypatch.setattr(claude, "structured_call", by_claude)
    return prompts


async def test_code_that_does_not_parse_goes_back_to_the_model_once_with_its_error(monkeypatch):
    # Told to give every name of a branch a suffix, GPT-6 Luna wrote an import with two aliases.
    broken = "import pandas as pd as pd_gformula\nest_gformula = pd_gformula.Series([1.0]).mean()\nest_gformula"
    fixed = "import pandas as pd_gformula\nest_gformula = pd_gformula.Series([1.0]).mean()\nest_gformula"
    prompts = replying(monkeypatch, [{"summary": "s", "code": broken}, {"summary": "s", "code": fixed}])
    found = [event async for event in solve(branch_request(), Whybook())]
    assert len(prompts) == 2
    assert "previous_attempt" not in prompts[0]
    assert prompts[1]["previous_attempt"] == {"code": broken, "error": "SyntaxError: invalid syntax (line 1)"}
    # The analyst gets the second answer, with what both calls cost.
    assert [event["type"] for event in found] == ["result"]
    assert found[0]["cell"]["code"] == fixed
    assert found[0]["cost_usd"] == pytest.approx(0.02)


async def test_code_that_parses_takes_one_call(monkeypatch):
    prompts = replying(monkeypatch, [{"summary": "s", "code": "%matplotlib inline\nx_gformula = 1\nx_gformula"}])
    found = [event async for event in solve(branch_request(), Whybook())]
    assert len(prompts) == 1
    assert found[-1]["cost_usd"] == 0.01


async def test_code_that_still_does_not_parse_reaches_the_analyst_after_two_calls(monkeypatch):
    broken = {"summary": "s", "code": "x = (1,"}
    prompts = replying(monkeypatch, [broken, broken, broken])
    found = [event async for event in solve(branch_request(), Whybook())]
    assert len(prompts) == 2
    assert found[-1]["cell"]["code"] == "x = (1,"
    assert found[-1]["cost_usd"] == pytest.approx(0.02)


def test_ipython_lines_and_cell_magics_are_no_syntax_error():
    assert syntax_error("%matplotlib inline\nimport pandas as pd\n!ls data\npd.DataFrame()") is None
    assert syntax_error("%%bash\nls -la") is None
    assert syntax_error("print(1)\nx = (1,") == "SyntaxError: '(' was never closed (line 2)"


async def test_code_of_another_language_is_not_checked_as_python(monkeypatch):
    # R that is no Python: `y ~ x` has no left operand in Python.
    r_code = "fit <- lm(wt82_71 ~ qsmk, data = nhefs)\nsummary(fit)"
    prompts = replying(monkeypatch, [{"summary": "s", "code": r_code}])
    request = SolveRequest.from_json({"question": {"text": "Fit it in R", "type": "model"}, "placement": "new", "language": "r"})
    found = [event async for event in solve(request, Whybook())]
    assert len(prompts) == 1
    assert found[-1]["cell"]["code"] == r_code
