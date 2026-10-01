"""Labels for tables shown as tiles, with a fake Agent SDK: no call reaches Claude."""

import json
import sys

import pytest
from tornado.httpclient import HTTPClientError

from whybook.server import table_notes
from whybook.server.config import Whybook
from whybook.server.questions.models import InvalidRequest
from whybook.server.tests.test_claude import ResultMessage, fake_sdk

COEFFICIENTS = """\
                           Coef. Std.Err.        z  P>|z|
Intercept                  5.009    0.355   14.113  0.000
treatment_arm[T.B]        -0.857    0.160   -5.359  0.000
age                       -0.003    0.009   -0.281  0.779"""


@pytest.fixture
def jp_server_config(jp_server_config):
    config = dict(jp_server_config)
    config["Whybook"] = {"describe_tables": False}
    return config


def test_the_request_keeps_each_table_and_cuts_long_text():
    prompt, ids = table_notes.request_from_json(
        {
            "tables": [
                {"id": "a1", "code": "fit.summary().tables[1]", "text": COEFFICIENTS, "rows": 3, "columns": 4},
                {"id": "b2", "text": "x" * 5000, "rows": "many", "columns": True},
            ]
        }
    )
    assert ids == ["a1", "b2"]
    tables = json.loads(prompt)["tables"]
    assert tables[0] == {"id": "a1", "code": "fit.summary().tables[1]", "table": COEFFICIENTS, "rows": 3, "columns": 4}
    assert len(tables[1]["table"]) == table_notes.MAX_TEXT
    assert tables[1]["rows"] is None and tables[1]["columns"] is None


@pytest.mark.parametrize("body", [{}, {"tables": []}, {"tables": [{"text": "no id"}]}, []])
def test_a_request_without_tables_or_ids_is_refused(body):
    with pytest.raises(InvalidRequest):
        table_notes.request_from_json(body)


def test_notes_keep_the_requested_tables_and_the_promised_length():
    output = {
        "tables": [
            {"id": "a1", "description": "mixed  model\ncoefficients for pain", "headline": "3 significant terms at the 5% level"},
            {"id": "a1", "description": "a second answer", "headline": ""},
            {"id": "zz", "description": "not asked for", "headline": ""},
            {"id": "b2", "description": "diary rows", "headline": ""},
        ]
    }
    # A headline of more than four words is left out: cut, it would read "3 significant terms at".
    assert table_notes.notes_from_output(output, ["a1", "b2"]) == [
        {"id": "a1", "description": "mixed model coefficients", "headline": ""},
        {"id": "b2", "description": "diary rows", "headline": ""},
    ]


def test_a_headline_shows_whole_or_not_at_all():
    headline = "pain_score_baseline and pain_score_week_12: -0.45"
    output = {"tables": [{"id": "c1", "description": "baseline week correlation", "headline": headline}]}
    # Cut to 48 characters, it read "-0.4" for r = -0.45.
    assert table_notes.notes_from_output(output, ["c1"])[0]["headline"] == headline


async def test_claude_labels_the_tables(monkeypatch):
    reply = {"tables": [{"id": "a1", "description": "model coefficients", "headline": "2 significant"}]}
    sdk = fake_sdk([ResultMessage(structured_output=reply)])
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", sdk)
    prompt, ids = table_notes.request_from_json({"tables": [{"id": "a1", "text": COEFFICIENTS}]})
    events = [event async for event in table_notes.ask_claude(prompt, ids, Whybook())]
    assert events[-1]["type"] == "result"
    assert events[-1]["tables"] == [{"id": "a1", "description": "model coefficients", "headline": "2 significant"}]
    assert "output" not in events[-1]
    assert sdk.calls == [{"prompt": prompt, "structured": True}]
    assert "treatment_arm[T.B]" in sdk.calls[0]["prompt"]


async def test_the_server_can_turn_the_requests_off(jp_fetch):
    status = json.loads((await jp_fetch("whybook", "status")).body)
    assert status["describe_tables"] is False
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "tables", "describe", method="POST", body=json.dumps({"tables": [{"id": "a1", "text": "x"}]}))
    assert error.value.code == 403
