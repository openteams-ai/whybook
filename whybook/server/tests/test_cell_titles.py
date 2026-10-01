"""Titles of code cells: the request, Claude's answer with a fake SDK, a local model with a fake llama_cpp."""

import json
import sys

import pytest
from tornado.httpclient import HTTPClientError

from whybook.server import cell_titles, local_models
from whybook.server.config import Whybook
from whybook.server.questions.models import InvalidRequest
from whybook.server.tests.test_claude import ResultMessage, fake_sdk
from whybook.server.tests.test_local_models import GEMMA, FakeLlama, download, fake  # noqa: F401  fixtures

WEEKLY = {
    "id": "weekly",
    "code": 'weekly = diary.groupby(["patient_id", "week"], as_index=False)["pain_score"].mean()',
    "title": "weekly = diary.groupby([\"patient_id\", \"week\"], as_index=False)[\"pain_score\"].mean()",
}


@pytest.fixture
def jp_server_config(jp_server_config):
    config = dict(jp_server_config)
    config["Whybook"] = {"describe_tables": False}
    return config


def test_the_request_keeps_the_code_and_the_current_title():
    [cell] = cell_titles.cells_from_json({"cells": [{**WEEKLY, "code": "x = 1\n" * 1000}]})
    assert len(cell["code"]) == cell_titles.MAX_CODE and cell["title"].startswith("weekly")
    [bare] = cell_titles.cells_from_json({"cells": [{"id": "a", "code": "x = 1"}]})
    assert bare["title"] == ""
    for body in ({"cells": []}, {"cells": [{"id": "a"}]}, {"cells": [{"id": "a", "code": "  \n"}]}):
        with pytest.raises(InvalidRequest):
            cell_titles.cells_from_json(body)


def test_only_the_cells_asked_for_keep_a_title_of_eight_words_at_most():
    long = " ".join(["word"] * 14) + "."
    output = {"cells": [{"id": "weekly", "title": long}, {"id": "other", "title": "x"}, {"id": "empty", "title": " "}]}
    notes = cell_titles.notes_from_output(output, ["weekly", "empty"])
    assert notes == [{"id": "weekly", "title": "Word " + " ".join(["word"] * 7)}]
    assert cell_titles.title_of("weekly pain by arm.") == "Weekly pain by arm"


async def test_claude_titles_the_cells(monkeypatch):
    reply = {"cells": [{"id": "weekly", "title": "Weekly pain per patient."}]}
    sdk = fake_sdk([ResultMessage(structured_output=reply)])
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", sdk)
    cells = cell_titles.cells_from_json({"cells": [WEEKLY]})
    events = [event async for event in cell_titles.ask_claude(cell_titles.prompt_of(cells), ["weekly"], Whybook())]
    assert events[-1]["cells"] == [{"id": "weekly", "title": "Weekly pain per patient"}]
    assert "pain_score" in sdk.calls[0]["prompt"]


async def test_a_local_model_titles_each_cell(fake, monkeypatch):
    download(fake, GEMMA)
    monkeypatch.setattr(FakeLlama, "answer", json.dumps({"title": "Weekly pain per patient"}))
    cells = cell_titles.cells_from_json({"cells": [WEEKLY, {**WEEKLY, "id": "again"}]})
    events = [event async for event in local_models.ask_local_titles("gemma-4-e2b", cells, threads=2)]
    assert [event["type"] for event in events] == ["progress", "progress", "result"]
    assert events[1]["stage"] == "titling cell 2 of 2"
    assert events[-1]["cells"] == [{"id": "weekly", "title": "Weekly pain per patient"}, {"id": "again", "title": "Weekly pain per patient"}]
    messages = FakeLlama.made[0].messages[0]
    assert messages[0]["content"] == local_models.TITLE_PROMPT
    assert json.loads(messages[1]["content"])["current_title"] == WEEKLY["title"]


async def test_the_route_runs_a_local_model_and_refuses_the_remote_one_when_off(jp_fetch, fake, monkeypatch):
    download(fake, GEMMA)
    monkeypatch.setattr(FakeLlama, "answer", json.dumps({"title": "Weekly pain per patient"}))
    body = {"model": "gemma-4-e2b", "cells": [WEEKLY]}
    response = await jp_fetch("whybook", "cells", "title", method="POST", body=json.dumps(body))
    events = [json.loads(line) for line in response.body.decode().splitlines()]
    assert events[-1]["cells"] == [{"id": "weekly", "title": "Weekly pain per patient"}]
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "cells", "title", method="POST", body=json.dumps({**body, "model": "remote"}))
    assert error.value.code == 403
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "cells", "title", method="POST", body=json.dumps({"model": "gemma-4-e2b", "cells": []}))
    assert error.value.code == 400


@pytest.mark.parametrize(
    "given",
    ["eGFR by arm and visit", "pH of each soil sample", "weekly_pain per patient, by arm", "mRNA levels by treatment", "log2 fold change by arm"],
)
def test_a_title_that_starts_with_a_name_keeps_its_case(given):
    assert cell_titles.title_of(given) == given


def test_a_title_keeps_to_the_eight_words_that_the_prompt_asks_for():
    title = cell_titles.title_of("Mean weekly pain per patient by arm and site")
    assert title == "Mean weekly pain per patient by arm"
    assert cell_titles.title_of("eight words: weekly pain per patient by arm") == "Eight words: weekly pain per patient by arm"
