"""The questions that a model adds to a drop or a click (design iteration 1.76).

The view keeps a question of the model only when it uses one of the items
dropped or clicked, names no column that the frames of the request lack,
and does not repeat a question offered, asked or added before it. The
model reads what agents found in the notebook, unless the data stays on
this machine. The questions come from the testers' logs of 1 October 2026
(``~/.cache/future-work/dogfood/pass1``). No test calls a model.
"""

import json

import pytest

from whybook.server import connection, local_models
from whybook.server.config import Whybook
from whybook.server.questions import claude_questions
from whybook.server.questions.models import Context, Selection

READINGS = {"home_id": "id", "date": "other", "kwh_import": "num", "kwh_peak": "num", "kwh_night": "num", "kwh_export": "num"}
HOMES = {
    "home_id": "id",
    "region": "cat",
    "floor_area_m2": "int",
    "occupants": "int",
    "built": "cat",
    "heating": "cat",
    "has_solar": "bool",
    "has_ev": "bool",
    "tariff": "cat",
    "tou_start": "cat",
}
ENERGY = {
    "readings": {"rows": 129058, "columns": READINGS},
    "homes": {"rows": 360, "columns": HOMES},
    "readings_homes": {"rows": 129058, "columns": {**READINGS, **HOMES}},
}
HOME_ID = {"name": 'readings["home_id"]', "label": "home_id", "kind": "id", "parent": "readings", "tag": "id"}

VISITS = {"visits": {"rows": 1428, "columns": {"patient_id": "id", "week": "int", "crp_mg_l": "num", "systolic_bp": "int", "analgesic_dose_mg": "int"}}}
WEEK = {"name": 'visits["week"]', "label": "week", "kind": "numeric", "parent": "visits", "tag": "int"}
CRP = {"name": 'visits["crp_mg_l"]', "label": "crp_mg_l", "kind": "numeric", "parent": "visits", "tag": "num"}

# The first answer of the pain diary's agent (pain step 10), as the notebook keeps it.
NO_ARM = {
    "question": "Does treatment arm B change how pain evolves over the first six months?",
    "answer": "The tables visits and sites of clinic.sqlite hold no treatment arm and no pain score, so the question cannot be answered from this data.",
}


def ask(*questions):
    """A model's answer: each question as (text, columns), or as its text alone, with no columns listed."""
    listed = []
    for question in questions:
        text, columns = question if isinstance(question, tuple) else (question, None)
        item = {"text": text, "type": "association", "why": "the testers' model said so", "priority": 0.6}
        if columns is not None:
            item["columns"] = columns
        listed.append(item)
    return {"questions": listed}


@pytest.fixture
def model(monkeypatch):
    """The connected model: it answers with ``model.answer``, and keeps what it read in ``model.seen``."""

    class Model:
        answer: dict = {"questions": []}
        seen: list = []

    Model.seen = []

    async def structured_call(prompt, *, schema, system_prompt, config, effort, images=None):
        Model.seen.append({"prompt": json.loads(prompt), "system": system_prompt, "schema": schema})
        yield {"type": "result", "output": json.loads(json.dumps(Model.answer)), "model": "fake-model", "cost_usd": 0.01, "elapsed": 0.3}

    monkeypatch.setattr(connection, "structured_call", structured_call)
    return Model


async def result_of(selection, context, **options):
    events = [event async for event in claude_questions.generate(Selection.from_json(selection), Context.from_json(context), [], Whybook(), **options)]
    assert events[-1]["type"] == "result"
    return events[-1]


def texts(result):
    return [question["text"] for question in result["questions"]]


async def test_a_question_that_uses_neither_item_is_left_out(model):
    # Energy step 29: home_id dropped on itself, and four of the model's five questions are about something else.
    model.answer = ask(
        "How many readings per home_id, and does that vary by region?",
        "Do homes with solar panels show different kwh_export patterns by tariff?",
        "Does has_ev interact with heating type to explain kwh_night use?",
        "Why did some homes switch to TOU while others stayed flat?",
        "Does floor_area_m2 or occupants confound the tariff effect on usage?",
    )
    result = await result_of({"source": HOME_ID, "target": HOME_ID}, {"frames": ENERGY})
    assert texts(result) == ["How many readings per home_id, and does that vary by region?"]
    assert result["left_out"][0] == {"text": "Do homes with solar panels show different kwh_export patterns by tariff?", "why": "does not use home_id"}
    assert len(result["left_out"]) == 4


async def test_a_question_uses_an_item_by_its_label_with_spaces_or_in_the_plural_or_by_the_columns_it_lists(model):
    model.answer = ask(
        "Does crp_mg_l rise in the first weeks?",
        "Is crp mg l measured at every visit?",
        ("Does inflammation peak early?", ["crp_mg_l"]),
        "Do patients on more analgesic_dose_mg differ?",
    )
    result = await result_of({"source": WEEK, "target": CRP}, {"frames": VISITS})
    assert texts(result) == ["Does crp_mg_l rise in the first weeks?", "Is crp mg l measured at every visit?", "Does inflammation peak early?"]
    assert result["left_out"] == [{"text": "Do patients on more analgesic_dose_mg differ?", "why": "uses neither week nor crp_mg_l"}]


async def test_a_frame_is_used_by_its_columns_and_a_fitted_model_by_any_question(model):
    model.answer = ask("Does kwh_peak track kwh_import?", "Is the weather of each day complete?")
    frames = {"source": {"name": "readings", "label": "readings", "kind": "dataframe"}, "target": {"name": "homes", "label": "homes", "kind": "dataframe"}}
    result = await result_of(frames, {"frames": ENERGY})
    assert texts(result) == ["Does kwh_peak track kwh_import?"]
    # A question about a model may call it "the model": none is left out.
    model.answer = ask("Are the residuals of the model normal?")
    fit = {"name": "fit", "label": "fit", "kind": "model"}
    assert texts(await result_of({"source": fit, "target": fit}, {"frames": ENERGY})) == ["Are the residuals of the model normal?"]


async def test_a_question_that_names_a_column_no_frame_holds_is_left_out(model):
    # Pain step 14: week clicked, then crp_mg_l. The kernel holds visits alone, with no site and no arm.
    model.answer = ask(
        ("Does crp_mg_l correlate with systolic_bp across visits?", ["crp_mg_l", "systolic_bp"]),
        ("Are crp_mg_l measurements missing differently by patient_id or site?", ["crp_mg_l", "patient_id", "site"]),
        ("Does treatment arm moderate how crp_mg_l changes over week?", ["treatment arm", "crp_mg_l", "week"]),
        ("Does analgesic_dose_mg mediate the effect of week on crp_mg_l?", ["visits.analgesic_dose_mg", "week", "crp_mg_l"]),
        # A name with an underscore in the text is a column too, when the model lists none.
        "Does pain_score follow crp_mg_l over week?",
        ("Does the crp_mg_l to analgesic_dose_mg ratio fall by week?", ["crp_mg_l/analgesic_dose_mg", "week"]),
    )
    result = await result_of({"source": WEEK, "target": CRP}, {"frames": VISITS})
    assert texts(result) == [
        "Does crp_mg_l correlate with systolic_bp across visits?",
        "Does analgesic_dose_mg mediate the effect of week on crp_mg_l?",
        "Does the crp_mg_l to analgesic_dose_mg ratio fall by week?",
    ]
    assert [item["why"] for item in result["left_out"]] == [
        "names site, which no frame holds",
        "names treatment arm, which no frame holds",
        "names pain_score, which no frame holds",
    ]


async def test_a_name_that_the_request_holds_elsewhere_is_not_missing(model):
    # A constant that a question of the templates names, and a model that the code of the cell dropped onto fits.
    offered = claude_questions.offered_from_json([{"id": "t:min", "text": "What if MIN_DAYS were 7?", "type": "model"}])
    model.answer = ask(
        "Does week change with MIN_DAYS in the filter?",
        ("Does fit_weekly need a random slope for week?", ["week", "fit_weekly"]),
        "Is week_index the same as week?",
    )
    cell = {"cell": "[3]", "code": "fit_weekly = smf.mixedlm('crp_mg_l ~ week', visits, groups='patient_id').fit()"}
    formulas = [{"cell": "[3]", "formula": "crp_mg_l ~ week"}]
    result = await result_of({"source": WEEK}, {"frames": VISITS}, offered=offered, cell=cell, formulas=formulas)
    assert texts(result) == ["Does week change with MIN_DAYS in the filter?", "Does fit_weekly need a random slope for week?"]
    assert result["left_out"] == [{"text": "Is week_index the same as week?", "why": "names week_index, which no frame holds"}]


async def test_without_frames_or_with_a_file_not_loaded_no_column_counts_as_missing(model):
    model.answer = ask(("Could site confound week and crp_mg_l?", ["site", "week", "crp_mg_l"]))
    assert texts(await result_of({"source": WEEK, "target": CRP}, {})) == ["Could site confound week and crp_mg_l?"]
    # A file that is not loaded yet: its columns are not in the request.
    model.answer = ask(("Does floor_area_m2 in homes.csv explain kwh_import?", ["floor_area_m2", "kwh_import"]))
    homes_file = {"name": "homes.csv", "label": "homes.csv", "kind": "file", "path": "homes.csv"}
    readings = {"name": "readings", "label": "readings", "kind": "dataframe"}
    result = await result_of({"source": homes_file, "target": readings}, {"frames": {"readings": ENERGY["readings"]}})
    assert texts(result) == ["Does floor_area_m2 in homes.csv explain kwh_import?"]


async def test_a_question_that_repeats_one_offered_asked_or_added_before_it_is_left_out(model):
    # Two of the model's questions, and one of a template, that ask the same thing in other words.
    offered = claude_questions.offered_from_json(
        [
            {"id": "t:levels", "text": "Does kwh_peak differ between the levels of tariff?", "type": "association", "runs": True},
            {"id": "t:spread", "text": "Is the spread of kwh_peak similar across the levels of tariff?", "type": "association"},
        ]
    )
    model.answer = ask(
        "Does kwh_peak differ by tariff?",
        "Did tariff change kwh_peak after tou_start?",
        "Does tariff change kwh_peak after tou_start?",
        "Do homes with has_ev show higher kwh_peak values?",
        "Does kwh_peak vary seasonally across dates within homes?",
        "Is kwh_peak seasonal, varying with date across homes?",
    )
    tariff = {"name": 'readings_homes["tariff"]', "label": "tariff", "kind": "categorical", "parent": "readings_homes"}
    peak = {"name": 'readings_homes["kwh_peak"]', "label": "kwh_peak", "kind": "numeric", "parent": "readings_homes"}
    asked = [{"id": "claude:1", "text": "Do homes with has_ev show higher kwh_peak values?", "type": "association"}]
    result = await result_of({"source": tariff, "target": peak}, {"frames": ENERGY, "asked": asked}, offered=offered)
    assert texts(result) == ["Did tariff change kwh_peak after tou_start?", "Does kwh_peak vary seasonally across dates within homes?"]
    assert [item["why"] for item in result["left_out"]] == [
        'repeats "Does kwh_peak differ between the levels of tariff?"',
        'repeats "Did tariff change kwh_peak after tou_start?"',
        'repeats "Do homes with has_ev show higher kwh_peak values?"',
        'repeats "Does kwh_peak vary seasonally across dates within homes?"',
    ]
    # The spread is another question than the mean, and stays apart from it.
    assert not claude_questions.alike("Is the spread of kwh_peak similar across the levels of tariff?", "Does kwh_peak differ by tariff?", ["kwh_peak", "tariff"])


async def test_the_model_reads_what_agents_found_unless_the_data_stays_here(model):
    model.answer = ask(("Does crp_mg_l correlate with systolic_bp across visits?", ["crp_mg_l", "systolic_bp"]))
    found = claude_questions.found_from_json([NO_ARM, {"question": "Fit a mixed model", "answer": "x" * 2000}, {"question": "no answer", "answer": None}])
    assert found == [NO_ARM, {"question": "Fit a mixed model", "answer": "x" * claude_questions.FOUND_CHARS}]
    await result_of({"source": WEEK, "target": CRP}, {"frames": VISITS}, found=found)
    assert model.seen[0]["prompt"]["found_so_far"] == found
    assert '"found_so_far" lists what agents found' in model.seen[0]["system"]
    # With the data on this machine, an answer can quote a value: it stays here.
    await result_of({"source": WEEK, "target": CRP}, {"frames": VISITS}, found=found, keep_local=True)
    assert "found_so_far" not in model.seen[1]["prompt"]
    # At most three answers, the newest first, as the view sends them.
    assert len(claude_questions.found_from_json([NO_ARM] * 5)) == claude_questions.MAX_FOUND
    assert claude_questions.found_from_json("no list") == []


async def test_the_prompt_asks_for_the_columns_of_each_question_and_the_answer_may_leave_them_out(model):
    question = claude_questions.SCHEMA["properties"]["questions"]["items"]
    assert question["properties"]["columns"] == {"type": "array", "items": {"type": "string"}}
    assert "columns" not in question["required"]
    system = " ".join(claude_questions.SYSTEM_PROMPT.split())
    assert 'each with "text", "type", "why", "priority" and "columns"' in system
    assert "uses at least one of the selected variables" in system
    assert 'Name only columns that "frames" holds' in system
    # A local model's grammar holds no columns, and its prompt does not ask for them.
    assert '"columns"' not in claude_questions.LOCAL_SYSTEM_PROMPT
    assert "found_so_far" in claude_questions.LOCAL_SYSTEM_PROMPT


async def test_the_route_passes_what_agents_found_to_the_model(jp_fetch, model, monkeypatch):
    from whybook.server import claude

    monkeypatch.setattr(claude, "readiness", lambda config: {"available": True, "cli": "claude", "credential": "ANTHROPIC_API_KEY", "reason": None, "setup": None})
    model.answer = ask(("Does treatment arm moderate how crp_mg_l changes over week?", ["treatment arm", "crp_mg_l", "week"]))
    body = {"selection": {"source": WEEK, "target": CRP}, "context": {"frames": VISITS}, "model": "remote", "found": [NO_ARM]}
    response = await jp_fetch("whybook", "questions", "claude", method="POST", body=json.dumps(body))
    events = [json.loads(line) for line in response.body.decode().splitlines()]
    assert model.seen[0]["prompt"]["found_so_far"] == [NO_ARM]
    assert events[-1]["questions"] == []
    assert events[-1]["left_out"] == [{"text": "Does treatment arm moderate how crp_mg_l changes over week?", "why": "names treatment arm, which no frame holds"}]


async def test_a_local_model_reads_the_two_newest_findings_and_its_questions_are_kept_the_same_way(monkeypatch):
    seen = {}

    async def ask_json(model_id, system, user, schema, max_tokens, threads, stage, check="fast"):
        seen["user"] = user
        output = ask("How many readings per home_id are there", "Why did some homes switch to TOU")
        yield {"type": "result", "output": output, "model": "Gemma 4 E2B", "cost_usd": 0.0, "elapsed": 2.0}

    monkeypatch.setattr(local_models, "ask_json", ask_json)
    selection = Selection.from_json({"source": HOME_ID, "target": HOME_ID})
    found = [NO_ARM, {**NO_ARM, "question": "second"}, {**NO_ARM, "question": "third"}]
    events = [event async for event in claude_questions.generate_local("gemma-4-e2b", selection, Context.from_json({"frames": ENERGY}), [], 4, found=found)]
    assert [question["text"] for question in events[-1]["questions"]] == ["How many readings per home_id are there"]
    assert [item["question"] for item in seen["user"]["found_so_far"]] == [NO_ARM["question"], "second"]
    assert all(len(item["answer"]) <= 300 for item in seen["user"]["found_so_far"])
