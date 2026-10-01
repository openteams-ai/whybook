"""Summaries of data frames: the request, Claude's answer with a fake SDK, a local model with a fake llama_cpp."""

import json
import sys

import pytest
from tornado.httpclient import HTTPClientError

from whybook.server import frame_notes, local_models
from whybook.server.config import Whybook
from whybook.server.questions.models import InvalidRequest
from whybook.server.tests.test_claude import ResultMessage, fake_sdk
from whybook.server.tests.test_local_models import GEMMA, FakeLlama, download, fake  # noqa: F401  fixtures

DIARY = {
    "id": "diary:abc",
    "name": "diary",
    "rows": 36941,
    "n_columns": 10,
    "columns": [{"name": "patient_id", "type": "id"}, {"name": "pain_score", "type": "float"}],
}


@pytest.fixture
def jp_server_config(jp_server_config):
    config = dict(jp_server_config)
    config["Whybook"] = {"describe_tables": False}
    return config


def test_the_request_keeps_the_name_the_size_and_the_first_columns():
    many = {**DIARY, "columns": [{"name": f"c{i}", "type": "int"} for i in range(80)]}
    [frame] = frame_notes.frames_from_json({"frames": [many]})
    assert frame["name"] == "diary" and frame["rows"] == 36941 and frame["columns"] == 10
    assert len(frame["first_columns"]) == frame_notes.MAX_COLUMNS
    with pytest.raises(InvalidRequest):
        frame_notes.frames_from_json({"frames": [{"id": "x"}]})
    with pytest.raises(InvalidRequest):
        frame_notes.frames_from_json({"frames": []})


def test_only_the_frames_asked_for_are_kept_and_cut_to_thirty_words():
    long = " ".join(["word"] * 40)
    notes = frame_notes.notes_from_output({"frames": [{"id": "diary:abc", "summary": long}, {"id": "other", "summary": "x"}]}, ["diary:abc"])
    assert notes == [{"id": "diary:abc", "summary": " ".join(["word"] * 30)}]


async def test_claude_summarises_the_frames(monkeypatch):
    reply = {"frames": [{"id": "diary:abc", "summary": "One row per patient and day: pain, sleep and mood."}]}
    sdk = fake_sdk([ResultMessage(structured_output=reply)])
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", sdk)
    frames = frame_notes.frames_from_json({"frames": [DIARY]})
    events = [event async for event in frame_notes.ask_claude(frame_notes.prompt_of(frames), ["diary:abc"], Whybook())]
    assert events[-1]["frames"] == [{"id": "diary:abc", "summary": "One row per patient and day: pain, sleep and mood."}]
    assert "pain_score" in sdk.calls[0]["prompt"]


async def test_a_local_model_summarises_each_frame(fake, monkeypatch):
    download(fake, GEMMA)
    monkeypatch.setattr(FakeLlama, "answer", json.dumps({"summary": "One row per patient and day with pain scores."}))
    frames = frame_notes.frames_from_json({"frames": [DIARY, {**DIARY, "id": "weekly:def", "name": "weekly"}]})
    events = [event async for event in local_models.ask_local_frames("gemma-4-e2b", frames, threads=2)]
    assert [event["type"] for event in events] == ["progress", "progress", "result"]
    assert events[1]["stage"] == "summarising frame 2 of 2"
    assert [note["id"] for note in events[-1]["frames"]] == ["diary:abc", "weekly:def"]
    assert FakeLlama.made[0].messages[0][0]["content"] == local_models.FRAME_PROMPT


async def test_the_route_runs_a_local_model_and_refuses_the_remote_one_when_off(jp_fetch, fake, monkeypatch):
    download(fake, GEMMA)
    monkeypatch.setattr(FakeLlama, "answer", json.dumps({"summary": "Weekly pain per patient."}))
    body = {"model": "gemma-4-e2b", "frames": [DIARY]}
    response = await jp_fetch("whybook", "frames", "describe", method="POST", body=json.dumps(body))
    events = [json.loads(line) for line in response.body.decode().splitlines()]
    assert events[-1]["frames"] == [{"id": "diary:abc", "summary": "Weekly pain per patient."}]
    with pytest.raises(HTTPClientError) as error:
        await jp_fetch("whybook", "frames", "describe", method="POST", body=json.dumps({**body, "model": "remote"}))
    assert error.value.code == 403
