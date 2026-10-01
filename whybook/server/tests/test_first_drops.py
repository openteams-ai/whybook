"""The first drops of a new notebook (design iterations 1.64 and 1.65).

A drop or a click asks the model of More questions next to the templates:
the model reads the questions that the templates offer, the frames with
their columns and the formulas of the notebook, adds what the templates
miss, and names the likely outcomes and units of the analysis. The answer
gives the order of the whole list (``rankers.merged_order``). The templates
then take the outcome and the unit from the view's lists, and say which
they took (``Candidate.uses``). No test calls a model.
"""

import json

import numpy as np
import pandas as pd
import pytest

from whybook.server import claude, local_models
from whybook.server.questions import claude_questions
from whybook.server.questions.cells import CellInfo, next_steps
from whybook.server.questions.drops import DropRequest, drop_options
from whybook.server.questions.models import Candidate, Context, Placement, Variable

FRAMES = {
    "homes": {"rows": 360, "columns": {"home_id": "id", "region": "cat", "floor_area_m2": "int", "heating": "cat"}},
    "meter_readings": {"rows": 129058, "columns": {"home_id": "id", "date": "other", "kwh_import": "num", "kwh_peak": "num"}},
    "weather": {"rows": 1460, "columns": {"date": "cat", "region": "cat", "mean_temp_c": "num", "rain_mm": "num"}},
}
READINGS = {"name": "meter_readings", "label": "meter_readings", "kind": "dataframe", "rows": 129058, "n_columns": 4}
HOMES = {"name": "homes", "label": "homes", "kind": "dataframe", "rows": 360, "n_columns": 4}
# The questions of the drop of meter_readings onto homes, as the view sends them.
OFFERED = [
    {"id": "q:line", "text": "How do meter_readings and homes line up?", "type": "quality", "probability": 0.875, "runs": True, "placement": {"kind": "new"}},
    {"id": "q:join", "text": "Join meter_readings and homes", "type": "quality", "probability": 0.818, "runs": True, "placement": {"kind": "new"}},
    {"id": "q:units", "text": "Do meter_readings and homes describe the same units?", "type": "quality", "probability": 0.69, "runs": False, "placement": {"kind": "new"}},
]
WARMER = "Does kwh_import fall as mean_temp_c rises, by region?"
ANSWER = {
    "questions": [
        {"text": WARMER, "type": "association", "why": "Cold days need more heating", "priority": 0.8},
        # A question that the templates offer already.
        {"text": "How do meter_readings and homes line up?", "type": "quality", "why": "a repeat", "priority": 0.9},
        {"text": "Are some homes missing days of readings?", "type": "quality", "why": "Gaps bias a mean", "priority": 0.5},
    ],
    "outcomes": [
        {"column": "kwh_import", "frame": "meter_readings", "why": "the energy each home uses"},
        {"column": "made_up", "frame": "homes", "why": "no frame holds it"},
    ],
    "units": [{"column": "home_id", "frame": "homes", "why": "each home is read daily"}],
}
CONTEXT = {"frames": FRAMES, "mode": "wonder", "used": [], "asked": []}


@pytest.fixture
def prompts(monkeypatch):
    """What would go to the connected model, which answers with ANSWER."""
    seen = []

    async def structured_call(prompt, *, schema, system_prompt, config, effort, images=None):
        seen.append({"prompt": json.loads(prompt), "system": system_prompt, "schema": schema})
        yield {"type": "result", "output": json.loads(json.dumps(ANSWER)), "model": "fake-model", "cost_usd": 0.01, "elapsed": 0.3}

    monkeypatch.setattr(claude, "structured_call", structured_call)
    monkeypatch.setattr(claude, "readiness", lambda config: {"available": True, "cli": "claude", "credential": "ANTHROPIC_API_KEY", "reason": None, "setup": None})
    return seen


async def post(jp_fetch, body):
    response = await jp_fetch("whybook", "questions", "claude", method="POST", body=json.dumps(body))
    return [json.loads(line) for line in response.body.decode().splitlines()]


def ask(**extra):
    return {"selection": {"source": READINGS, "target": HOMES}, "context": CONTEXT, "model": "remote", **extra}


async def test_the_model_reads_the_questions_offered_the_frames_and_the_formulas(jp_fetch, prompts):
    formulas = [{"cell": "[4]", "formula": "kwh_import ~ mean_temp_c"}]
    await post(jp_fetch, ask(offered=OFFERED, formulas=formulas, cells_above=3))
    sent = prompts[0]["prompt"]
    assert sent["already_suggested"] == [
        {"text": "How do meter_readings and homes line up?", "runs": True},
        {"text": "Join meter_readings and homes", "runs": True},
        {"text": "Do meter_readings and homes describe the same units?", "runs": False},
    ]
    assert sent["frames"]["weather"] == {"rows": 1460, "columns": FRAMES["weather"]["columns"]}
    assert sent["formulas"] == formulas
    # The call asks for the outcomes and the units too, and names every key of its answer.
    assert set(prompts[0]["schema"]["properties"]) == {"questions", "outcomes", "units"}
    assert 'keys are "questions", "outcomes" and "units"' in prompts[0]["system"]
    assert "add what they miss" in prompts[0]["system"]


async def test_the_answer_leaves_out_a_repeat_and_names_only_columns_of_the_frames(jp_fetch, prompts):
    events = await post(jp_fetch, ask(offered=OFFERED))
    result = events[-1]
    assert [question["text"] for question in result["questions"]] == [WARMER, "Are some homes missing days of readings?"]
    assert result["outcomes"] == [{"column": "kwh_import", "frame": "meter_readings", "why": "the energy each home uses"}]
    assert result["units"] == [{"column": "home_id", "frame": "homes", "why": "each home is read daily"}]


async def test_the_question_that_names_what_the_templates_miss_comes_first(jp_fetch, prompts):
    events = await post(jp_fetch, ask(offered=OFFERED, cells_above=3))
    result = events[-1]
    ids = {question["text"]: question["id"] for question in result["questions"]}
    order = result["order"]
    assert sorted(order) == sorted([item["id"] for item in OFFERED] + list(ids.values()))
    # WARMER names kwh_import, mean_temp_c and region, which no template question names.
    assert order[0] == ids[WARMER]
    first = next(question for question in result["questions"] if question["text"] == WARMER)
    assert "names kwh_import, mean_temp_c, region, which no template question here names" in first["reasons"]
    # The rules scored the model's questions: the model's priority is only their prior.
    assert first["probability"] != 0.8
    # The templates keep their order among themselves.
    offered = [item for item in order if item.startswith("q:")]
    assert offered == ["q:line", "q:join", "q:units"]


async def test_without_the_questions_offered_the_answer_gives_no_order(jp_fetch, prompts):
    events = await post(jp_fetch, ask())
    assert "order" not in events[-1]
    # The catalogue's questions of the selection stand in, as texts.
    assert all(isinstance(text, str) for text in prompts[0]["prompt"]["already_suggested"])


async def test_with_the_data_here_the_frames_go_as_names_and_kinds_and_the_questions_offered_stay(jp_fetch, prompts):
    await post(jp_fetch, ask(offered=OFFERED, context={**CONTEXT, "keep_data_local": True}))
    sent = prompts[0]["prompt"]
    assert "already_suggested" not in sent
    assert sent["frames"]["homes"]["columns"] == FRAMES["homes"]["columns"]


async def test_a_local_model_writes_questions_alone_and_the_answer_orders_them(jp_fetch, monkeypatch):
    seen = {}

    async def ask_json(model_id, system, user, schema, max_tokens, threads, stage, check="fast"):
        seen["system"], seen["user"] = system, user
        yield {"type": "result", "output": {"questions": [{"text": "Which homes have the most readings", "type": "quality", "why": "coverage", "priority": 0.5}]}, "model": "Gemma 4 E2B", "cost_usd": 0.0, "elapsed": 2.0}

    monkeypatch.setattr(local_models, "ask_json", ask_json)
    monkeypatch.setattr(local_models, "model_of", lambda model_id, spec=None: type("Model", (), {"id": model_id})())
    events = await post(jp_fetch, ask(offered=OFFERED, model="gemma-4-e2b"))
    result = events[-1]
    assert "outcomes" not in seen["system"] and '"units"' not in seen["system"]
    assert seen["user"]["already_suggested"] == [item["text"] for item in OFFERED]
    assert result["outcomes"] == [] and result["units"] == []
    assert len(result["order"]) == 4


def test_a_drop_onto_a_cell_keeps_the_rules_order_with_the_first_question_that_fills_a_gap():
    from whybook.server.questions.rankers import merged_order

    context = Context.from_json(CONTEXT)
    offered = claude_questions.offered_from_json(OFFERED)
    added = [
        Candidate(id="m:a", text="Is heating split evenly across regions?", type="descriptive", origin="claude", variables=(), prior=0.9, probability=0.9, reasons=["x"]),
        Candidate(id="m:b", text="Does kwh_peak track kwh_import?", type="association", origin="claude", variables=(), prior=0.3, probability=0.3, reasons=["y"]),
    ]
    involved = [Variable.from_json(READINGS)]
    merged = merged_order(offered, added, involved, context, learned=False, cells_above=2)
    ids = [candidate.id for candidate in merged]
    # m:b names kwh_peak and kwh_import, which the templates do not name; m:a names heating.
    assert ids[0] == "m:a"
    assert ids.index("q:line") < ids.index("q:join") < ids.index("q:units")


def test_the_outcome_is_the_first_that_the_frame_of_the_cell_holds():
    """A notebook of two analyses: the column dropped onto the cell of the second gets its outcome."""
    frames = {"visits": {"rows": 60, "columns": {"patient_id": "id", "pain": "num", "sleep": "num"}}, **FRAMES}
    cell = {"id": "c2", "label": "[2]", "source": "visits = load()", "defs": ["visits"], "uses": ["load"]}
    sleep = {"name": "visits['sleep']", "label": "sleep", "kind": "numeric", "parent": "visits", "rows": 60}
    context = {"frames": frames, "outcome": "kwh_import", "outcomes": ["kwh_import", "pain"], "units": ["patient_id"], "used": [], "asked": []}
    options = drop_options(DropRequest.from_json({"source": sleep, "target": {"cell": cell}, "context": context}))["options"]
    association = next(option for option in options if option["type"] == "association")
    assert association["text"] == "Is sleep associated with pain here?"
    assert association["uses"] == {"outcome": "pain"}
    # A question that takes nothing from the notebook says so by having no uses.
    assert all("uses" not in option for option in options if "pain" not in option["text"])


def test_two_columns_of_a_frame_without_the_unit_are_not_within_or_between_units():
    """Weather by region and day holds no homes: the unit of the readings does not apply."""
    rain = {"name": "weather['rain_mm']", "label": "rain_mm", "kind": "numeric", "parent": "weather", "rows": 1460}
    temp = {"name": "weather['mean_temp_c']", "label": "mean_temp_c", "kind": "numeric", "parent": "weather", "rows": 1460}
    context = {**CONTEXT, "unit": "home_id", "units": ["home_id"]}
    options = drop_options(DropRequest.from_json({"source": rain, "target": {"item": temp}, "context": context}))["options"]
    [pair] = [option for option in options if option["type"] == "association"]
    assert pair["text"] == "Are rain_mm and mean_temp_c associated?"
    assert "home_id" not in pair["code"] and "uses" not in pair
    weather = pd.DataFrame({"rain_mm": np.arange(6.0), "mean_temp_c": np.arange(6.0) ** 2})
    exec(pair["code"], {"weather": weather})  # noqa: S102  the view runs the same code in the kernel


def test_two_columns_of_a_frame_with_the_unit_are_within_or_between_units_and_say_they_use_it():
    peak = {"name": "meter_readings['kwh_peak']", "label": "kwh_peak", "kind": "numeric", "parent": "meter_readings", "rows": 129058}
    total = {"name": "meter_readings['kwh_import']", "label": "kwh_import", "kind": "numeric", "parent": "meter_readings", "rows": 129058}
    context = {**CONTEXT, "unit": "home_id", "units": ["home_id"]}
    options = drop_options(DropRequest.from_json({"source": peak, "target": {"item": total}, "context": context}))["options"]
    [pair] = [option for option in options if option["type"] == "association"]
    assert pair["text"] == "Are kwh_peak and kwh_import associated, within or between homes?"
    assert pair["uses"] == {"unit": "home_id"}


def test_worth_asking_next_says_which_questions_take_the_outcome():
    cells = [CellInfo(id="c1", label="[1]", source="homes = load()", defs=("homes",))]
    context = Context.from_json({**CONTEXT, "outcome": "kwh_import", "outcomes": ["kwh_import"], "unit": "home_id", "units": ["home_id"]})
    steps = next_steps(cells, context, {}, set())
    about = [step for step in steps if step.text == "How does floor_area_m2 relate to kwh_import?"]
    assert about and about[0].uses == {"outcome": "kwh_import"}
    assert about[0].to_json()["uses"] == {"outcome": "kwh_import"}


def test_the_questions_offered_are_read_as_the_view_sends_them():
    offered = claude_questions.offered_from_json(OFFERED)
    assert [(item.id, item.type, item.probability, bool(item.code)) for item in offered] == [
        ("q:line", "quality", 0.875, True),
        ("q:join", "quality", 0.818, True),
        ("q:units", "quality", 0.69, False),
    ]
    assert offered[0].placement == Placement("new")
    with pytest.raises(claude_questions.InvalidRequest):
        claude_questions.offered_from_json([{"text": "no id"}])
    with pytest.raises(claude_questions.InvalidRequest):
        claude_questions.offered_from_json([OFFERED[0]] * 31)


def test_a_key_that_holds_two_kinds_of_values_joins_no_rows_and_the_note_says_why():
    """The dates of weather.csv are text, and those of the parquet file Python dates: a merge on date matched no row."""
    weather = {"name": "weather", "label": "weather", "kind": "dataframe", "rows": 1460, "n_columns": 4}
    result = drop_options(DropRequest.from_json({"source": weather, "target": {"item": READINGS}, "context": CONTEXT}))
    texts = [option["text"] for option in result["options"]]
    assert "How do weather and meter_readings line up?" in texts
    assert "Join weather and meter_readings" not in texts
    assert result["note"] == "date holds text in weather and Python objects in meter_readings: a join on it matches no row until both hold the same kind."
    temp = {"name": "weather['mean_temp_c']", "label": "mean_temp_c", "kind": "numeric", "parent": "weather", "rows": 1460}
    screen = drop_options(DropRequest.from_json({"source": temp, "target": {"item": READINGS}, "context": CONTEXT}))
    [option] = screen["options"]
    assert option["code"] is None
    assert screen["note"] == "date holds Python objects in meter_readings and text in weather: a join on it matches no row until both hold the same kind."


def test_keys_of_one_kind_still_join():
    from whybook.server import codegen

    assert codegen.join_keys({"patient_id": "id", "week": "int"}, {"patient_id": "id", "week": "num"}, "patient_id") == ["patient_id", "week"]
    assert codegen.join_keys({"date": "cat"}, {"date": "other"}, None) == []
    assert codegen.mismatched_keys({"date": "cat"}, {"date": "other"}, None) == ["date"]
    # The header of a file has no tags: its keys join any column.
    assert codegen.join_keys({"date": ""}, {"date": "other"}, None) == ["date"]
