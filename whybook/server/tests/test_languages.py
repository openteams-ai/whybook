"""Questions in a kernel of another language than Python, such as R.

The templates write Python. In a kernel of another language their questions
go without code, and a model writes the cell in the kernel's language: the
prompts take the language's conventions from languages.py, and a language
without an entry gets one made from its name.
"""

import json

import pytest

from whybook.server import agent, languages, solve
from whybook.server.config import Whybook
from whybook.server.questions.cells import CellInfo, Decision, decision_options
from whybook.server.questions.models import Context, InvalidRequest, Variable

from .test_routes import AGE, CELL, CONTEXT, post

R = Context(language="r")
# An R cell with a constant that the rules know: a count of weeks.
WEEKLY = CellInfo("c2", "[2]", "MIN_WEEK <- 4\nweekly <- subset(diary, week >= MIN_WEEK)")
MIN_WEEK = Decision("MIN_WEEK", "4", "literal")


def test_the_entry_of_a_language_and_one_made_from_a_name():
    assert languages.language("python").templates
    assert languages.language("R") is languages.R
    assert languages.language(None) is languages.PYTHON
    julia = languages.language("julia")
    assert (julia.name, julia.load, julia.templates) == ("Julia", "", False)
    assert Context().templates and not R.templates


def test_the_cell_is_written_in_the_kernels_language():
    python, r, julia = (solve.system_prompt(name) for name in ("python", "r", "julia"))
    assert python == solve.SYSTEM_PROMPT
    assert python.startswith("You write one Python cell") and "with import" in python and "whybook.ribbon" in python
    assert r.startswith("You write one R cell")
    assert "with library()" in r and "with rm()" in r and "data.frame" in r
    # Python's helpers and conventions stay out of the prompt of another language.
    for prompt in (r, julia):
        assert "whybook" not in prompt and "import" not in prompt and "polars" not in prompt
    assert julia.startswith("You write one Julia cell")


def test_the_request_names_the_language_and_a_branch_reports_progress_in_python_alone():
    question = {"text": "What if MIN_WEEK were 2?", "type": "model"}
    cell = {"label": "[2]", "source": WEEKLY.source}

    def body(**extra):
        return json.loads(solve.SolveRequest.from_json({"question": question, "placement": "branch", "cell": cell, **extra}).prompt())

    assert body()["language"] == "python"
    assert "whybook.progress" in body()["task"]
    assert body(language="R")["language"] == "r"
    assert "whybook.progress" not in body(language="r")["task"]


def test_no_python_import_is_added_to_code_of_another_language():
    output = {"summary": "s", "code": "weekly <- aggregate(pain ~ week, diary, mean)\nweekly", "assumptions": [], "follow_up": []}
    assert solve.complete_cell(output, frozenset(), "r")["code"] == output["code"]


def test_a_dropped_file_has_no_python_loader_in_another_language(tmp_path):
    (tmp_path / "visits.csv").write_text("week,pain\n1,3\n")
    item = Variable(name="visits.csv", label="visits.csv", kind="file", path="visits.csv")
    assert solve.describe_source(item, str(tmp_path))["load"].startswith("import pandas as pd")
    described = solve.describe_source(item, str(tmp_path), "r")
    assert "load" not in described and described["columns"] == [{"name": "week"}, {"name": "pain"}]


def test_the_agent_works_in_the_kernels_language():
    def prompt(language):
        request = agent.AgentRequest.from_json({"question": {"text": "q", "type": "model"}, "placement": "new", "language": language}, Whybook())
        return request.system_prompt()

    python, r = prompt("python"), prompt("r")
    assert "The Python kernel holds" in python and "importlib.reload" in python
    assert "The R kernel holds" in r and "with library()" in r and "source() it again" in r
    assert "importlib" not in r


def test_a_chip_of_an_r_cell_offers_its_what_ifs_for_a_model_to_write():
    # In Python the view writes each what-if as a branch; R code has no such template.
    assert decision_options(WEEKLY, MIN_WEEK, Context())["options"] == []
    result = decision_options(WEEKLY, MIN_WEEK, R)
    assert [option["text"] for option in result["options"]] == ["What if MIN_WEEK were 2?", "What if MIN_WEEK were 8?"]
    assert all(option["code"] is None and option["placement"]["kind"] == "branch" for option in result["options"])


def test_a_value_typed_for_an_r_chip_is_not_read_as_python():
    with pytest.raises(InvalidRequest):
        decision_options(WEEKLY, MIN_WEEK, Context(), value="1:3")
    (typed,) = decision_options(WEEKLY, MIN_WEEK, R, value="1:3")["options"]
    assert typed["text"] == "What if MIN_WEEK were 1:3?" and typed["code"] is None


async def test_the_questions_of_a_drop_go_without_the_templates_code_in_r(jp_fetch):
    python = await post(jp_fetch, "drop", body={"source": AGE, "target": {"cell": CELL}, "cells": [CELL], "context": CONTEXT})
    assert any(option["code"] for option in python["options"])
    r = await post(jp_fetch, "drop", body={"source": AGE, "target": {"cell": CELL}, "cells": [CELL], "context": {**CONTEXT, "language": "r"}})
    # The same questions, each for a model to write in R.
    assert [option["text"] for option in r["options"]] == [option["text"] for option in python["options"]]
    assert all(option["code"] is None for option in r["options"])
