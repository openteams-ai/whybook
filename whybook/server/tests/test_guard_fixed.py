"""A review guard that the server fixes (c.Whybook.review_guard) also fixes the notebook's mark of synthetic data and "Allow for this session" (design iteration 1.132).

Without the fix, a notebook whose metadata holds ``{"whybook": {"guard":
{"synthetic": true}}}`` sent identifiers and personal details unmasked under
a guard fixed to reject, and so did a prompt after "Allow for this session".
"""

import asyncio
import json

import pytest
from tornado.httpclient import HTTPClientError

from whybook.server import claude, connection, guard
from whybook.server.config import Whybook

QUESTION = "Why did patient P042, aged 67, with diabetes stop the opioid on 2025-03-14?"
SYNTHETIC = {"synthetic": True, "unit": "patient_id", "columns": [{"name": "patient_id"}, {"name": "age"}]}
OPTIONS = {"schema": {"type": "object"}, "system_prompt": "s", "effort": "low"}


@pytest.fixture
def jp_server_config(jp_server_config):
    return {**jp_server_config, "Whybook": {"review_guard": "reject"}}


@pytest.fixture
def sent(monkeypatch):
    """The prompts that would go to the connected model, the Claude Code login of the tests."""
    prompts = []

    async def by_claude(prompt, **options):
        prompts.append(prompt)
        yield {"type": "result", "output": {}, "model": "claude", "cost_usd": 0.0}

    monkeypatch.setattr(claude, "structured_call", by_claude)
    return prompts


def flags_of(text):
    return [{"kind": flag.kind, "text": flag.text} for flag in guard.check_text(text, guard.Dataset()).flags]


def test_a_guard_that_the_server_fixes_reads_the_data_of_every_notebook_as_real():
    body = {"guard": {"mode": "none", "privacy": False, "session": "s", "dataset": SYNTHETIC}}
    for fixed in ("ask", "reject"):
        settings = guard.Settings.from_body(body, fixed)
        assert settings.dataset.kind == "real" and settings.enforced
        # The rest of what the notebook tells of its data still counts.
        assert settings.dataset.unit == "patient_id" and settings.dataset.names == frozenset({"patient_id", "age"})
    chosen = guard.Settings.from_body(body)
    assert chosen.dataset.kind == "synthetic" and not chosen.enforced
    assert guard.Settings.from_body({}, "reject").enforced
    assert guard.settings_of(Whybook(review_guard="ask")).enforced


async def test_a_notebook_marked_synthetic_sends_its_identifiers_masked_under_a_fixed_guard(sent):
    body = {"guard": {"mode": "none", "privacy": False, "session": "fixed-synthetic", "dataset": SYNTHETIC}}
    config = connection.for_request(Whybook(review_guard="reject"), body)
    found = [event async for event in connection.structured_call(QUESTION, config=config, **OPTIONS)]
    assert [event["type"] for event in found] == ["guard_held", "result"]
    assert "P042" not in sent[-1] and "[identifier]" in sent[-1]
    # On a server that does not fix the guard, the mark counts: the notebook's data goes as it is.
    config = connection.for_request(Whybook(), {"guard": {"mode": "reject", "session": "chosen-synthetic", "dataset": SYNTHETIC}})
    found = [event async for event in connection.structured_call(QUESTION, config=config, **OPTIONS)]
    assert [event["type"] for event in found] == ["result"] and sent[-1] == QUESTION


async def test_what_allow_for_this_session_kept_lets_nothing_go_under_a_fixed_guard():
    flags = flags_of(QUESTION)
    for fixed, background in (("reject", False), ("ask", True)):
        session = f"fixed-allow-{fixed}"
        assert guard.remember_flags(session, "privacy", flags, None)
        events = []
        settings = guard.Settings.from_body({"guard": {"session": session, "background": background}}, fixed)
        outcome = await guard.check_prompt(QUESTION, settings, events.append, to="x")
        assert outcome.by == "mode" and "P042" not in outcome.text
        assert [event["type"] for event in events] == ["guard_held"]
    # Where the analyst chooses the mode, "Allow for this session" lets the same flags go.
    assert guard.remember_flags("chosen-allow", "privacy", flags, None)
    outcome = await guard.check_prompt(QUESTION, guard.Settings(mode="reject", session="chosen-allow"), [].append, to="x")
    assert outcome.by == "memory" and outcome.text == QUESTION


async def test_an_answer_in_the_dialog_still_counts_for_the_session_under_a_guard_fixed_to_ask():
    settings = guard.Settings.from_body({"guard": {"session": "fixed-dialog"}}, "ask")
    events = []
    queue: asyncio.Queue = asyncio.Queue()

    def emit(event):
        events.append(event)
        queue.put_nowait(event)

    task = asyncio.ensure_future(guard.check_prompt(QUESTION, settings, emit, to="x"))
    event = await asyncio.wait_for(queue.get(), 5)
    assert event["type"] == "guard"
    assert guard.answer(event["id"], "send", "a synthetic record of the tutorial")
    assert (await task).by == "analyst"
    again = await guard.check_prompt(QUESTION, settings, events.append, to="x")
    assert again.by == "memory" and again.text == QUESTION


async def test_the_session_route_refuses_allow_for_this_session_under_a_fixed_guard(jp_fetch):
    body = {"session": "fixed-route", "allow": {"guard": "privacy", "flags": flags_of(QUESTION)}}
    with pytest.raises(HTTPClientError) as refused:
        await jp_fetch("whybook", "guard", "session", method="POST", body=json.dumps(body))
    assert refused.value.code == 403
    assert "c.Whybook.review_guard" in json.loads(refused.value.response.body)["message"]
    # Nothing was kept, and the rest of the route works as before.
    kept = json.loads((await jp_fetch("whybook", "guard", "session", method="POST", body=json.dumps({"session": "fixed-route"}))).body)
    assert kept["answers"] == []
    assert (await jp_fetch("whybook", "guard", "session", method="POST", body=json.dumps({"session": "fixed-route", "forget": "all"}))).code == 200
