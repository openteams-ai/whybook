"""When the columns of the frames are set, as the model of questions reads it (design iteration 1.84).

The pain tester of the second pass met these causal slips
among the model's questions: "Does analgesic_use confound the week-pain
relationship?" (step 9), with nothing that causes the week, and "Does
analgesic_use differ by treatment_arm, confounding pain comparisons?" (step
26), with a use recorded after the arm was assigned. The request names the
time columns, the columns with one value per unit and the columns measured
on the rows after the start, where the frames show them (``timing``), and the
prompt says what each allows. The frames are those of the testers' examples.
No model runs.
"""

import json

import pytest

from whybook.server import connection
from whybook.server.config import Whybook
from whybook.server.questions import claude_questions
from whybook.server.questions.models import Context, Selection

DIARY_RAW = {"patient_id": "id", "week": "int", "analgesic_use": "cat", "notes": "text", "cycle_start": "int", "pain_1": "num", "sleep_1": "num"}
PATIENTS = {"patient_id": "id", "treatment_arm": "cat", "site": "cat", "age": "int", "bmi": "num", "parity": "int", "stage": "ord"}
DIARY = {"patient_id": "id", "week": "int", "analgesic_use": "cat", "notes": "text", "cycle_start": "int", "day": "int", "pain": "num", "sleep": "num", "diary_day": "int"}
PAIN = {
    "diary_raw": {"rows": 5880, "columns": DIARY_RAW},
    "patients": {"rows": 318, "columns": PATIENTS},
    "diary": {"rows": 36941, "columns": DIARY},
    "diary_patients": {"rows": 36941, "columns": {**DIARY, **PATIENTS}},
}
READINGS = {"home_id": "id", "date": "date", "kwh_import": "num", "kwh_peak": "num", "kwh_night": "num", "kwh_export": "num"}
HOMES = {"home_id": "id", "region": "cat", "heating": "cat", "tariff": "cat", "tou_start": "date", "has_ev": "bool", "has_solar": "bool", "floor_area_m2": "int", "occupants": "int"}
ENERGY = {
    "readings": {"rows": 129058, "columns": READINGS},
    "homes": {"rows": 360, "columns": HOMES},
    "readings_homes": {"rows": 129058, "columns": {**READINGS, **HOMES}},
    "half_hourly": {"rows": 241920, "columns": {"home_id": "id", "timestamp": "date", "kwh": "num"}},
    "tariffs": {"rows": 5, "columns": {"tariff": "cat", "period": "cat", "eur_per_kwh": "num", "standing_eur_per_day": "num"}},
}
WEEK = {"name": 'diary_patients["week"]', "label": "week", "kind": "numeric", "parent": "diary_patients", "tag": "int"}
PAIN_COLUMN = {"name": 'diary_patients["pain"]', "label": "pain", "kind": "numeric", "parent": "diary_patients", "tag": "num"}


def test_the_pain_diary_has_its_time_its_baseline_and_what_follows():
    timed = claude_questions.timing(Context.from_json({"unit": "patient_id", "frames": PAIN}))
    assert timed == {
        "time": ["week", "day"],
        "per_unit": ["treatment_arm", "site", "age", "bmi", "parity", "stage"],
        "repeated": ["analgesic_use", "notes", "cycle_start", "pain_1", "sleep_1", "pain", "sleep", "diary_day"],
    }


def test_a_date_in_the_frame_of_the_units_is_one_value_per_unit():
    # The day a home switched tariff is no time of a row: nothing would cause it otherwise.
    timed = claude_questions.timing(Context.from_json({"units": ["home_id"], "frames": ENERGY}))
    assert timed == {
        "time": ["date", "timestamp"],
        "per_unit": ["region", "heating", "tariff", "tou_start", "has_ev", "has_solar", "floor_area_m2", "occupants"],
        "repeated": ["kwh_import", "kwh_peak", "kwh_night", "kwh_export", "kwh"],
    }


def test_without_a_frame_of_the_units_only_a_number_named_as_a_time_counts():
    # One frame with the unit: which columns are baseline is not known, and a date may be one per unit.
    diary = Context.from_json({"unit": "patient_id", "frames": {"diary": PAIN["diary"], "homes": {"rows": 360, "columns": HOMES}}})
    assert claude_questions.timing(diary) == {"time": ["week", "day"]}
    # The frame of the units is the smaller one: of the same size, it is not.
    same = Context.from_json({"unit": "patient_id", "frames": {"a": {"rows": 318, "columns": PATIENTS}, "b": {"rows": 318, "columns": PATIENTS}}})
    assert claude_questions.timing(same) == {}
    assert claude_questions.timing(Context()) == {}


@pytest.fixture
def seen(monkeypatch):
    """What the connected model read: it answers with no question."""
    calls = []

    async def structured_call(prompt, *, schema, system_prompt, config, effort, images=None):
        calls.append({"prompt": json.loads(prompt), "system": system_prompt})
        yield {"type": "result", "output": {"questions": []}, "model": "fake-model", "cost_usd": 0.0, "elapsed": 0.1}

    monkeypatch.setattr(connection, "structured_call", structured_call)
    return calls


@pytest.mark.parametrize("keep_local", [False, True])
async def test_the_model_reads_the_timing_with_what_it_allows(seen, keep_local):
    # Pain step 9: week dropped onto pain. The timing holds names alone, as "frames" does.
    selection = Selection.from_json({"source": WEEK, "target": PAIN_COLUMN})
    context = Context.from_json({"unit": "patient_id", "frames": PAIN})
    events = [event async for event in claude_questions.generate(selection, context, [], Whybook(), keep_local=keep_local)]
    assert events[-1]["type"] == "result"
    assert seen[0]["prompt"]["timing"] == claude_questions.timing(context)
    system = " ".join(seen[0]["system"].split())
    assert '"timing", when present, says when the columns of "frames" are set' in system
    assert "Nothing causes a time column, so nothing confounds a relation with it." in system
    assert "A repeated column can lie on the path from a column set at the start, but cannot cause it or confound its effect" in system
    assert "a column set at the start does not lie on the path from another one." in system
    # The prompt ends with the one JSON object, as every prompt for structured output does.
    assert system.endswith("Never send one question on its own.")


async def test_a_request_without_timing_leaves_it_out_and_a_local_model_never_reads_of_it(seen):
    selection = Selection.from_json({"source": PAIN_COLUMN, "target": PAIN_COLUMN})
    context = Context.from_json({"frames": {"visits": {"rows": 20, "columns": {"patient_id": "id", "visit_date": "date", "pain": "num"}}}})
    [event async for event in claude_questions.generate(selection, context, [], Whybook())]
    assert "timing" not in seen[0]["prompt"]
    # A local model reads no frames, and its context is short.
    assert "timing" not in claude_questions.LOCAL_SYSTEM_PROMPT
